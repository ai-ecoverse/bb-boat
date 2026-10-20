import { createHash } from "node:crypto";
import { z } from "zod";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import {
  BoatApiError,
  BoatClient,
  LIVE_STATES,
  STARTING_STATES,
  type FetchLike,
  type Sandbox,
} from "./boat-client.js";
import {
  SANDBOX_TYPES,
  type ResolvedSettings,
  type SettingsResolution,
} from "./configuration.js";
import { createBoatExecutor } from "./executor.js";
import { PROVIDER_ID } from "./provider-id.js";
import { readBoatMachineResource, type BoatMachineResource } from "./resource.js";
import type {
  SandboxBackend,
  SandboxOperationContext,
} from "./sandbox-backend.js";

export const boatMachineInputsSchema = z
  .object({
    type: z.enum(SANDBOX_TYPES).optional(),
    from: z.string().trim().min(1).optional(),
  })
  .strict();
export type BoatMachineInputs = z.infer<typeof boatMachineInputsSchema>;

export interface BoatMachineInspection {
  summary: string;
  values: {
    state: string;
    archiveAfter: string | null;
    error: string | null;
  };
}

export interface BoatSandboxBackend
  extends SandboxBackend<BoatMachineInputs, BoatMachineResource> {
  connectionStatus(): Promise<{ available: boolean; message: string }>;
  client(): Promise<BoatClient>;
  inspect(resource: BoatMachineResource): Promise<BoatMachineInspection>;
}

export interface BoatSandboxBackendDeps {
  fetch: FetchLike;
  currentSettings: () => Promise<SettingsResolution>;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

const LIVE_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 20 * 60_000;
const DELETE_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 2_000;
const PREPARE_TIMEOUT_MS = 15 * 60_000;

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Boat create takes no name, so the plugin names the sandbox right after create and cleanup finds it by name. */
export function allocationName(key: string): string {
  return `bb-${digest(key).slice(0, 16)}`;
}

export function idempotencyKey(key: string): string {
  return `bb-boat-${digest(key)}`;
}

/**
 * A sandbox started from a named snapshot can carry another machine's bb
 * enrollment. Remove it before bootstrap so the new machine never connects
 * with a copied identity.
 */
export const IDENTITY_SCRUB_SCRIPT = [
  "set -u",
  'for unit in $(systemctl --user list-unit-files --no-legend "bb-host-daemon-*" 2>/dev/null | cut -d" " -f1); do',
  '  systemctl --user disable --now "$unit" >/dev/null 2>&1 || true',
  '  rm -f "$HOME/.config/systemd/user/$unit"',
  "done",
  "systemctl --user daemon-reload >/dev/null 2>&1 || true",
  'pkill -u "$(id -u)" -f bb-host-daemon >/dev/null 2>&1 || true',
  'rm -rf "$HOME/.bb-machines"',
].join("\n");

async function runScript(
  executor: MachineExecutor,
  script: string,
  context: SandboxOperationContext,
  timeoutMs: number,
): Promise<number> {
  const { exitCode } = await executor.exec({
    command: ["bash", "-lc", script],
    timeoutMs,
    signal: context.signal,
    stdin: "",
    onOutput: (chunk) => context.report.log(chunk),
  });
  return exitCode;
}

export function createBoatSandboxBackend(
  deps: BoatSandboxBackendDeps,
): BoatSandboxBackend {
  let cached: { apiKey: string; client: BoatClient } | null = null;

  async function requireSettings(): Promise<ResolvedSettings> {
    const resolved = await deps.currentSettings();
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.settings;
  }

  function clientFor(settings: ResolvedSettings): BoatClient {
    if (cached?.apiKey === settings.apiKey) return cached.client;
    const client = new BoatClient(settings.apiKey, deps.fetch);
    cached = { apiKey: settings.apiKey, client };
    return client;
  }

  async function pinnedClient(resource: BoatMachineResource): Promise<BoatClient> {
    const client = clientFor(await requireSettings());
    if ((await client.me()).id !== resource.accountId) {
      throw new Error(
        "Restore the machine's original Boat API key before lifecycle operations.",
      );
    }
    return client;
  }

  function executorFor(client: BoatClient, sandboxId: string): MachineExecutor {
    return createBoatExecutor(client, sandboxId, deps);
  }

  async function waitFor(
    client: BoatClient,
    sandboxId: string,
    context: SandboxOperationContext,
    done: (sandbox: Sandbox) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<Sandbox> {
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      context.signal.throwIfAborted();
      const sandbox = await client.getSandbox(sandboxId, context.signal);
      if (sandbox === null) throw new Error(`Boat sandbox ${sandboxId} is gone.`);
      if (done(sandbox)) return sandbox;
      if (sandbox.state === "error" || sandbox.state === "cancelled") {
        throw new Error(
          `Boat sandbox ${sandboxId} is in state ${sandbox.state}${sandbox.error ? `: ${sandbox.error}` : ""}.`,
        );
      }
      if (deps.now() > deadline) {
        throw new Error(
          `Boat sandbox ${sandboxId} did not become ${what} in time (state ${sandbox.state}).`,
        );
      }
      await deps.sleep(POLL_MS);
    }
  }

  async function waitLive(
    client: BoatClient,
    sandboxId: string,
    context: SandboxOperationContext,
  ): Promise<Sandbox> {
    const sandbox = await waitFor(
      client,
      sandboxId,
      context,
      (candidate) =>
        LIVE_STATES.has(candidate.state) ||
        (!STARTING_STATES.has(candidate.state) && candidate.state !== "archived"),
      LIVE_TIMEOUT_MS,
      "ready",
    );
    if (!LIVE_STATES.has(sandbox.state)) {
      throw new Error(
        `Boat sandbox ${sandboxId} stopped starting in state ${sandbox.state}.`,
      );
    }
    if (sandbox.error?.startsWith("Restore incomplete")) {
      throw new Error(
        `Boat could not restore all files of sandbox ${sandboxId}: ${sandbox.error}`,
      );
    }
    return sandbox;
  }

  async function waitStopped(
    client: BoatClient,
    sandboxId: string,
    context: SandboxOperationContext,
  ): Promise<void> {
    await waitFor(
      client,
      sandboxId,
      context,
      (sandbox) => sandbox.state === "archived",
      STOP_TIMEOUT_MS,
      "stopped",
    );
  }

  return {
    definition: {
      id: PROVIDER_ID,
      displayName: "Boat Sandbox",
      description: "Create a sandbox in your Boat account.",
      environmentDescription: "Create a project checkout in a new Boat sandbox.",
      runtimeName: "Boat",
      icon: "./assets/boat-logo.svg",
      ephemeral: true,
      inputs: boatMachineInputsSchema,
    },
    parseInputs(value) {
      return boatMachineInputsSchema.parse(value ?? {});
    },
    parseResource: readBoatMachineResource,
    allocationKey(resource) {
      return resource.key;
    },
    async availability() {
      const resolved = await deps.currentSettings();
      return resolved.ok
        ? { status: "available" }
        : { status: "setup-required", message: resolved.message };
    },
    async validate() {
      return { action: "accept" };
    },
    async create(context) {
      const settings = await requireSettings();
      const client = clientFor(settings);
      const account = await client.me(context.signal);
      const from = context.inputs.from ?? settings.from;
      context.report.step(
        from === null ? "Creating the Boat sandbox…" : `Creating the Boat sandbox from ${from}…`,
      );
      const created = await client.createSandbox(
        {
          ...(from === null ? {} : { from }),
          type: context.inputs.type ?? settings.type,
          ttlSeconds: settings.ttlSeconds,
          ...(settings.environment === null ? {} : { environment: settings.environment }),
          ...(settings.org === null ? {} : { org: settings.org }),
        },
        idempotencyKey(context.key),
        context.signal,
      );
      const resource: BoatMachineResource = {
        key: context.key,
        sandboxId: created.id,
        accountId: account.id,
      };
      await context.checkpoint(resource);
      await client.update(created.id, { name: allocationName(context.key) }, context.signal);
      context.report.log(`Boat sandbox ${created.id}\n`);
      context.report.step("Waiting for the sandbox to start…");
      await waitLive(client, created.id, context);
      const executor = executorFor(client, created.id);
      if (from !== null) {
        context.report.step("Removing copied bb state…");
        if ((await runScript(executor, IDENTITY_SCRUB_SCRIPT, context, 120_000)) !== 0) {
          throw new Error("Could not remove bb state copied from the snapshot.");
        }
      }
      if (settings.prepareScript !== null) {
        context.report.step("Running the prepare script…");
        const exitCode = await runScript(
          executor,
          settings.prepareScript,
          context,
          PREPARE_TIMEOUT_MS,
        );
        if (exitCode !== 0) throw new Error(`The prepare script exited with ${exitCode}.`);
      }
      context.signal.throwIfAborted();
      return { resource, executor };
    },
    async reconcileCleanup(context) {
      const client = clientFor(await requireSettings());
      const name = allocationName(context.key);
      for (const sandbox of await client.listSandboxes(context.signal)) {
        context.signal.throwIfAborted();
        if (sandbox.name !== name) continue;
        context.report.log(`Deleting orphaned Boat sandbox ${sandbox.id}\n`);
        await client.deleteSandbox(sandbox.id, context.signal);
      }
    },
    async suspend(context) {
      const client = await pinnedClient(context.resource);
      const { sandboxId } = context.resource;
      const sandbox = await client.getSandbox(sandboxId, context.signal);
      if (sandbox === null) {
        throw new Error(`Boat sandbox ${sandboxId} is gone; there is nothing to save.`);
      }
      if (sandbox.state !== "archived" && sandbox.state !== "archiving") {
        context.report.step("Stopping the sandbox and saving its disk…");
        try {
          await client.stop(sandboxId, context.signal);
        } catch (error) {
          if (!(error instanceof BoatApiError && error.code === "sandbox_stopping")) throw error;
        }
      }
      await waitStopped(client, sandboxId, context);
      context.report.log(`Stopped Boat sandbox ${sandboxId}\n`);
      return context.resource;
    },
    async resume(context) {
      const client = await pinnedClient(context.resource);
      const settings = await requireSettings();
      const { sandboxId } = context.resource;
      let sandbox = await client.getSandbox(sandboxId, context.signal);
      if (sandbox === null) throw new Error(`Boat sandbox ${sandboxId} is gone.`);
      if (sandbox.state === "archiving") {
        await waitStopped(client, sandboxId, context);
        sandbox = { ...sandbox, state: "archived" };
      }
      if (sandbox.state === "archived" || sandbox.state === "error") {
        context.report.step("Resuming the sandbox…");
        try {
          await client.resume(sandboxId, settings.ttlSeconds, context.signal);
        } catch (error) {
          if (!(error instanceof BoatApiError && error.code === "sandbox_resuming")) throw error;
        }
      } else if (LIVE_STATES.has(sandbox.state) && settings.ttlSeconds !== null) {
        await client.update(sandboxId, { ttlSeconds: settings.ttlSeconds }, context.signal);
      }
      await waitLive(client, sandboxId, context);
      return { resource: context.resource, executor: executorFor(client, sandboxId) };
    },
    async remove(context) {
      const client = await pinnedClient(context.resource);
      const { sandboxId } = context.resource;
      const operationId = await client.deleteSandbox(sandboxId, context.signal);
      if (operationId === null) return;
      const deadline = deps.now() + DELETE_TIMEOUT_MS;
      for (;;) {
        context.signal.throwIfAborted();
        if ((await client.getSandbox(sandboxId, context.signal)) === null) return;
        if ((await client.getDeletion(operationId, context.signal)) === "completed") return;
        if (deps.now() > deadline) {
          throw new Error(`Boat is still deleting sandbox ${sandboxId}; retry removal.`);
        }
        await deps.sleep(POLL_MS);
      }
    },
    displayName({ resource }) {
      return `Boat ${resource.sandboxId}`;
    },
    close() {
      cached = null;
    },
    async connectionStatus() {
      const resolved = await deps.currentSettings();
      if (!resolved.ok) return { available: false, message: resolved.message };
      try {
        const account = await clientFor(resolved.settings).me();
        return {
          available: true,
          message: `Connected to Boat as ${account.login ?? account.id}`,
        };
      } catch (error) {
        return {
          available: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async client() {
      return clientFor(await requireSettings());
    },
    async inspect(resource) {
      const client = await pinnedClient(resource);
      const sandbox = await client.getSandbox(resource.sandboxId);
      if (sandbox === null) {
        return {
          summary: `Boat sandbox ${resource.sandboxId} is gone.`,
          values: { state: "missing", archiveAfter: null, error: null },
        };
      }
      return {
        summary: `Boat sandbox ${sandbox.id} is ${sandbox.state}.`,
        values: {
          state: sandbox.state,
          archiveAfter: sandbox.archiveAfter ?? null,
          error: sandbox.error ?? null,
        },
      };
    },
  };
}
