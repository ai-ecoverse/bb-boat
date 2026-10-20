import { describe, expect, it } from "vitest";
import { BoatClient } from "../src/boat-client.js";
import {
  allocationName,
  createBoatSandboxBackend,
  idempotencyKey,
} from "../src/backend.js";
import { resolveSettings, type RawSettings } from "../src/configuration.js";
import { createBoatExecutor, shellQuote } from "../src/executor.js";
import type { BoatMachineResource } from "../src/resource.js";
import { FakeBoat } from "./fake-boat.js";

const RAW: RawSettings = {
  apiKey: "boat_test",
  org: "",
  from: "",
  environment: "",
  type: "default",
  autoStopHours: 2,
  idleMinutes: 15,
  prepareScript: "",
};

function deps() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

function context<T extends object>(extra: T) {
  const logs: string[] = [];
  const steps: string[] = [];
  const checkpoints: unknown[] = [];
  return {
    logs,
    steps,
    checkpoints,
    value: {
      ...extra,
      signal: new AbortController().signal,
      report: {
        step: (text: string) => steps.push(text),
        log: (text: string) => logs.push(text),
      },
      checkpoint: async (resource: unknown) => {
        checkpoints.push(resource);
      },
    },
  };
}

function backendFor(boat: FakeBoat, raw: Partial<RawSettings> = {}) {
  return createBoatSandboxBackend({
    fetch: boat.fetch,
    currentSettings: async () => resolveSettings({ ...RAW, ...raw }),
    ...deps(),
  });
}

describe("configuration", () => {
  it("requires an API key", () => {
    expect(resolveSettings({ ...RAW, apiKey: undefined })).toEqual({
      ok: false,
      message: "Set apiKey in the plugin's settings.",
    });
  });

  it("maps 0 auto-stop hours to no auto-stop and blanks to null", () => {
    const resolved = resolveSettings({ ...RAW, autoStopHours: 0, idleMinutes: 0, from: "  " });
    expect(resolved).toMatchObject({
      ok: true,
      settings: { ttlSeconds: null, idleMs: null, from: null },
    });
  });

  it("rejects unknown sandbox sizes", () => {
    expect(resolveSettings({ ...RAW, type: "huge" }).ok).toBe(false);
  });
});

describe("executor", () => {
  it("quotes arguments for the shell", () => {
    expect(shellQuote("plain-arg")).toBe("plain-arg");
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });

  it("streams output by offset and returns the exit code", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_1" });
    boat.run = () => ({ stdout: "hello\n", stderr: "warn\n", exitCode: 3, pollsUntilDone: 2 });
    const chunks: string[] = [];
    const executor = createBoatExecutor(new BoatClient("k", boat.fetch), "bx_1", deps());
    const result = await executor.exec({
      command: ["echo", "hello world"],
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      stdin: "",
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result).toEqual({ exitCode: 3 });
    expect(chunks.join("")).toBe("hello\nwarn\n");
    const [process] = boat.processes.values();
    expect(process!.script).toBe("(echo 'hello world') < /dev/null");
  });

  it("passes stdin through a private file", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_1" });
    const executor = createBoatExecutor(new BoatClient("k", boat.fetch), "bx_1", deps());
    await executor.exec({
      command: ["sh", "-s"],
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      stdin: "secret bundle",
      onOutput: () => {},
    });
    const [[path, content]] = [...boat.files.entries()];
    expect(path).toMatch(/^\/tmp\/bb-boat-stdin-/u);
    expect(content).toBe("secret bundle");
    const [process] = boat.processes.values();
    expect(process!.script).toContain(`chmod 600 ${path}; (sh -s) < ${path}; rc=$?; rm -f ${path}`);
    expect(process!.script).not.toContain("secret bundle");
  });

  it("retries a start Boat refused but never an ambiguous failure", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_1" });
    boat.failures.push({ match: "POST /sandboxes/bx_1/commands", status: 409, code: "sandbox_starting", message: "starting" });
    const executor = createBoatExecutor(new BoatClient("k", boat.fetch), "bx_1", deps());
    const request = {
      command: ["true"],
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      stdin: "",
      onOutput: () => {},
    };
    await expect(executor.exec(request)).resolves.toEqual({ exitCode: 0 });

    boat.failures.push({ match: "POST /sandboxes/bx_1/commands", status: 502, code: "sandbox_direct_failed", message: "connection reset" });
    await expect(executor.exec(request)).rejects.toThrow(/sandbox_direct_failed/u);
    expect(boat.processes.size).toBe(1);
  });

  it("stops a command at its timeout", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_1" });
    boat.run = () => ({ stdout: "", stderr: "", exitCode: 0, pollsUntilDone: 1_000 });
    const executor = createBoatExecutor(new BoatClient("k", boat.fetch), "bx_1", deps());
    await expect(
      executor.exec({
        command: ["sleep", "999"],
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        stdin: "",
        onOutput: () => {},
      }),
    ).rejects.toThrow(/timed out/u);
    expect(boat.requests.some((r) => r.method === "DELETE" && r.path.startsWith("/sandboxes/bx_1/commands/"))).toBe(true);
  });
});

describe("backend lifecycle", () => {
  it("creates an idempotent, named sandbox and checkpoints it before waiting", async () => {
    const boat = new FakeBoat();
    boat.startPolls = 2;
    const backend = backendFor(boat);
    const ctx = context({ key: "machine-key", attempt: 1, inputs: {} });
    const created = await backend.create(ctx.value);
    expect(created.resource).toEqual({ key: "machine-key", sandboxId: "bx_1", accountId: "acct_1" });
    expect(ctx.checkpoints).toEqual([created.resource]);
    const post = boat.requests.find((r) => r.method === "POST" && r.path === "/sandboxes")!;
    expect(post.headers["Idempotency-Key"]).toBe(idempotencyKey("machine-key"));
    expect(post.body).toEqual({ ttlSeconds: 7200, type: "default" });
    expect(boat.sandboxes.get("bx_1")!.name).toBe(allocationName("machine-key"));
    expect(boat.processes.size).toBe(0);

    const again = await backend.create(ctx.value);
    expect(again.resource.sandboxId).toBe("bx_1");
    expect(boat.sandboxes.size).toBe(1);
  });

  it("scrubs copied bb state and runs the prepare script for snapshot creates", async () => {
    const boat = new FakeBoat();
    const backend = backendFor(boat, { from: "bb-pi-bedrock", prepareScript: "echo prepared" });
    const ctx = context({ key: "k2", attempt: 1, inputs: { type: "small" as const } });
    await backend.create(ctx.value);
    const post = boat.requests.find((r) => r.method === "POST" && r.path === "/sandboxes")!;
    expect(post.body).toMatchObject({ from: "bb-pi-bedrock", type: "small" });
    const scripts = [...boat.processes.values()].map((p) => p.script);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain(".bb-machines");
    expect(scripts[1]).toContain("echo prepared");
  });

  it("fails create when the prepare script fails", async () => {
    const boat = new FakeBoat();
    boat.run = () => ({ stdout: "", stderr: "nope", exitCode: 7, pollsUntilDone: 0 });
    const backend = backendFor(boat, { prepareScript: "false" });
    const ctx = context({ key: "k3", attempt: 1, inputs: {} });
    await expect(backend.create(ctx.value)).rejects.toThrow("The prepare script exited with 7.");
  });

  it("suspends by stopping and resumes the same sandbox", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_9", name: allocationName("k") });
    const backend = backendFor(boat);
    const resource: BoatMachineResource = { key: "k", sandboxId: "bx_9", accountId: "acct_1" };
    const suspendCtx = context({ hostId: "host_1", resource });
    await expect(backend.suspend(suspendCtx.value)).resolves.toEqual(resource);
    expect(boat.sandboxes.get("bx_9")!.state).toBe("archived");

    await backend.suspend(suspendCtx.value);
    expect(boat.requests.filter((r) => r.path === "/sandboxes/bx_9/stop")).toHaveLength(1);

    const resumed = await backend.resume(context({ hostId: "host_1", resource }).value);
    expect(resumed.resource).toEqual(resource);
    expect(boat.sandboxes.get("bx_9")!.state).toBe("ready");
    const resume = boat.requests.find((r) => r.path === "/sandboxes/bx_9/resume")!;
    expect(resume.body).toEqual({ ttlSeconds: 7200 });
  });

  it("resuming a live sandbox only refreshes its auto-stop", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_9", ttlSeconds: 60 });
    const backend = backendFor(boat);
    const resource: BoatMachineResource = { key: "k", sandboxId: "bx_9", accountId: "acct_1" };
    await backend.resume(context({ hostId: "host_1", resource }).value);
    expect(boat.requests.some((r) => r.path.endsWith("/resume"))).toBe(false);
    expect(boat.sandboxes.get("bx_9")!.ttlSeconds).toBe(7200);
  });

  it("refuses lifecycle operations with another account's key", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_9" });
    boat.accountId = "acct_other";
    const backend = backendFor(boat);
    const resource: BoatMachineResource = { key: "k", sandboxId: "bx_9", accountId: "acct_1" };
    await expect(backend.suspend(context({ hostId: "h", resource }).value)).rejects.toThrow(
      /original Boat API key/u,
    );
    expect(boat.requests.some((r) => r.path.endsWith("/stop"))).toBe(false);
  });

  it("removes with the confirmation header and treats a missing sandbox as removed", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_9" });
    const backend = backendFor(boat);
    const resource: BoatMachineResource = { key: "k", sandboxId: "bx_9", accountId: "acct_1" };
    const { value } = context({ hostId: "h", resource });
    await backend.remove(value);
    const deleteRequest = boat.requests.find((r) => r.method === "DELETE")!;
    expect(deleteRequest.headers["X-Ascii-Confirm-Delete"]).toBe("bx_9");
    await expect(backend.remove(value)).resolves.toBeUndefined();
  });

  it("cleans up uncertain allocations by name only", async () => {
    const boat = new FakeBoat();
    boat.addSandbox({ id: "bx_mine", name: allocationName("lost-key") });
    boat.addSandbox({ id: "bx_other", name: "something else" });
    const backend = backendFor(boat);
    await backend.reconcileCleanup(context({ key: "lost-key" }).value);
    expect([...boat.sandboxes.keys()]).toEqual(["bx_other"]);
  });
});
