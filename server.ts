import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { FetchLike } from "./src/boat-client.js";
import { createBoatSandboxBackend } from "./src/backend.js";
import { resolveSettings, SETTING_DESCRIPTORS } from "./src/configuration.js";
import { errorMessage } from "./src/error-message.js";
import { registerSandboxBackend } from "./src/register.js";

/** Act this long before Boat's auto-stop: more than core's drain plus a snapshot. */
const AUTO_STOP_MARGIN_MS = 15 * 60_000;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

export interface BoatSandboxDeps {
  fetch: FetchLike;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

export function createBoatSandboxPlugin(
  deps: BoatSandboxDeps,
): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);
    async function currentSettings() {
      return resolveSettings(await settings.get());
    }

    const backend = createBoatSandboxBackend({
      fetch: deps.fetch,
      currentSettings,
      now: deps.now,
      sleep: deps.sleep,
    });
    bb.onDispose(() => backend.close());

    const idleKey = (hostId: string) => `idle/${hostId}`;
    async function bumpIdle(hostId: string): Promise<void> {
      await bb.storage.kv.set(idleKey(hostId), deps.now());
    }
    async function bumpOwnedMachine(hostId: string): Promise<void> {
      const host = await bb.sdk.hosts.get({ hostId });
      if (
        host.machineProviderId === backend.definition.id &&
        host.lifecycle.phase === "active"
      ) {
        await bumpIdle(hostId);
      }
    }
    async function lastActivity(hostId: string): Promise<number | null> {
      const stored = await bb.storage.kv.get<unknown>(idleKey(hostId));
      return stored === undefined ? null : z.number().finite().parse(stored);
    }
    async function busy(hostId: string): Promise<boolean> {
      for (const status of ["starting", "active"] as const) {
        const { total } = await bb.sdk.threads.count({ hostId, status });
        if (total > 0) return true;
      }
      return false;
    }
    async function suspend(hostId: string, reason: string): Promise<void> {
      try {
        await bb.sdk.hosts.experimental_suspend({ hostId });
        bb.log.info(`Suspending ${hostId}: ${reason}`);
      } catch (error) {
        if (hasErrorCode(error, "machine_busy")) return;
        const current = await bb.sdk.hosts.get({ hostId }).catch(() => null);
        const phase = current?.lifecycle.phase;
        if (phase === "suspending" || phase === "suspended" || phase === "resuming")
          return;
        bb.log.warn(`Suspend of ${hostId} failed: ${errorMessage(error)}`);
      }
    }

    bb.events.on("experimental_thread.events", async ({ thread }) => {
      if (thread.status !== "starting" && thread.status !== "active") return;
      if (thread.environmentId === null) return;
      const environment = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      await bumpOwnedMachine(environment.hostId);
    });
    bb.events.on("experimental_terminal.input", async ({ terminal }) => {
      await bumpOwnedMachine(terminal.hostId);
    });

    // Boat stops a sandbox at its auto-stop deadline without telling bb. Extend
    // busy sandboxes before that, suspend idle ones through core, and hand
    // sandboxes Boat already stopped to core so its record matches.
    bb.background.schedule("boat-lifecycle", "* * * * *", async () => {
      const resolved = await currentSettings();
      if (!resolved.ok) return;
      const { idleMs, ttlSeconds } = resolved.settings;
      const client = await backend.client();
      for (const host of await bb.sdk.hosts.list()) {
        if (
          host.machineProviderId !== backend.definition.id ||
          host.lifecycle.phase !== "active"
        )
          continue;
        try {
          const stored = await bb.experimental_machines.getResource(host.id);
          if (stored === null) continue;
          const resource = backend.parseResource(stored);
          const isBusy = await busy(host.id);
          if (isBusy) await bumpIdle(host.id);
          const last = await lastActivity(host.id);
          if (last === null) {
            await bumpIdle(host.id);
            continue;
          }
          const sandbox = await client.getSandbox(resource.sandboxId);
          if (sandbox === null) continue;
          if (sandbox.state === "archived" || sandbox.state === "archiving") {
            await suspend(host.id, "Boat stopped the sandbox");
            continue;
          }
          if (idleMs !== null && !isBusy && deps.now() >= last + idleMs) {
            await suspend(host.id, "idle");
            continue;
          }
          const deadline =
            sandbox.archiveAfter == null ? null : Date.parse(sandbox.archiveAfter);
          if (
            deadline === null ||
            Number.isNaN(deadline) ||
            ttlSeconds === null ||
            deadline - deps.now() > AUTO_STOP_MARGIN_MS
          )
            continue;
          if (isBusy || idleMs === null || deps.now() < last + idleMs) {
            await client.update(resource.sandboxId, { ttlSeconds });
            bb.log.info(`Extended Boat auto-stop of ${resource.sandboxId}`);
          } else {
            await suspend(host.id, "Boat auto-stop is near");
          }
        } catch (error) {
          bb.log.warn(`Boat lifecycle check of ${host.id} failed: ${errorMessage(error)}`);
        }
      }
    });

    registerSandboxBackend(bb, backend, {
      now: deps.now,
      onConnected: bumpIdle,
    });

    const loaded = await currentSettings();
    if (!loaded.ok) bb.status.needsConfiguration(loaded.message);
  };
}

export default createBoatSandboxPlugin({
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
});
