import type { FetchLike } from "../src/boat-client.js";

export interface FakeSandbox {
  id: string;
  name: string;
  state: string;
  error: string | null;
  archiveAfter: string | null;
  ttlSeconds: number | null;
}

export interface FakeProcess {
  script: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  pollsUntilDone: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** In-memory Boat API with just enough behavior for the plugin's calls. */
export class FakeBoat {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly processes = new Map<number, FakeProcess>();
  readonly files = new Map<string, string>();
  readonly requests: RecordedRequest[] = [];
  readonly idempotency = new Map<string, string>();
  accountId = "acct_1";
  /** Errors returned for the next matching calls, keyed by "METHOD path-prefix". */
  readonly failures: Array<{ match: string; status: number; code: string; message: string }> = [];
  /** States a sandbox passes through on create/resume before it is live. */
  startPolls = 1;
  run: (script: string) => Omit<FakeProcess, "script"> = () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    pollsUntilDone: 0,
  });
  private nextId = 1;
  private nextProcess = 1;
  private pendingStarts = new Map<string, number>();

  addSandbox(partial: Partial<FakeSandbox> & { id: string }): FakeSandbox {
    const sandbox: FakeSandbox = {
      name: "",
      state: "ready",
      error: null,
      archiveAfter: null,
      ttlSeconds: 7200,
      ...partial,
    };
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v1/u, "") + parsed.search;
    const body = init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
    this.requests.push({ method: init.method, path, headers: init.headers, body });
    const failure = this.failures.findIndex((f) => `${init.method} ${path}`.startsWith(f.match));
    if (failure !== -1) {
      const [f] = this.failures.splice(failure, 1);
      return respond(f!.status, {
        ok: false,
        code: f!.code,
        message: f!.message,
        error: { code: f!.code, message: f!.message, details: {} },
      });
    }
    return this.route(init.method, parsed, body);
  };

  private route(
    method: string,
    url: URL,
    body: Record<string, unknown> | undefined,
  ): { status: number; text(): Promise<string> } {
    const segments = url.pathname.replace(/^\/api\/v1\//u, "").split("/");
    if (method === "GET" && segments[0] === "me") {
      return respond(200, { ok: true, user: { id: this.accountId, login: "lars" } });
    }
    if (segments[0] === "deletion-operations") {
      return respond(200, { ok: true, operation: { id: segments[1], status: "completed" } });
    }
    if (segments[0] !== "sandboxes") return respond(404, { ok: false, code: "not_found", message: "Not Found" });
    if (segments.length === 1) {
      if (method === "GET") {
        return respond(200, {
          ok: true,
          sandboxes: [...this.sandboxes.values()],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      const key = String(this.requests.at(-1)!.headers["Idempotency-Key"]);
      const existing = this.idempotency.get(key);
      if (existing !== undefined) return respond(202, { ok: true, sandbox: this.sandboxes.get(existing) });
      const sandbox = this.addSandbox({
        id: `bx_${this.nextId++}`,
        state: "provisioning",
        ttlSeconds: (body?.ttlSeconds as number | null) ?? null,
      });
      this.pendingStarts.set(sandbox.id, this.startPolls);
      this.idempotency.set(key, sandbox.id);
      return respond(202, { ok: true, sandbox });
    }
    const sandbox = this.sandboxes.get(segments[1]!);
    if (sandbox === undefined) return respond(404, { ok: false, code: "not_found", message: "Not Found" });
    const action = segments[2];
    if (action === undefined) {
      if (method === "GET") {
        const pending = this.pendingStarts.get(sandbox.id);
        if (pending !== undefined) {
          if (pending <= 0) {
            sandbox.state = "ready";
            this.pendingStarts.delete(sandbox.id);
          } else {
            this.pendingStarts.set(sandbox.id, pending - 1);
          }
        }
        if (sandbox.state === "archiving") sandbox.state = "archived";
        return respond(200, { ok: true, sandbox });
      }
      if (method === "PATCH") {
        if (typeof body?.name === "string") sandbox.name = body.name;
        if (body && "ttlSeconds" in body) sandbox.ttlSeconds = body.ttlSeconds as number | null;
        return respond(200, { ok: true, sandbox });
      }
      if (method === "DELETE") {
        this.sandboxes.delete(sandbox.id);
        return respond(202, { ok: true, operation: { id: `del_${sandbox.id}`, status: "pending" } });
      }
    }
    if (action === "stop") {
      sandbox.state = "archiving";
      return respond(202, { ok: true, id: `stop_${sandbox.id}`, status: "pending" });
    }
    if (action === "resume") {
      sandbox.state = "provisioning";
      this.pendingStarts.set(sandbox.id, this.startPolls);
      return respond(202, { ok: true, id: `resume_${sandbox.id}`, status: "pending" });
    }
    if (action === "files" && method === "PUT") {
      this.files.set(String(body!.path), Buffer.from(String(body!.content), "base64").toString("utf8"));
      return respond(200, { ok: true, success: true });
    }
    if (action === "commands") {
      if (method === "POST") {
        const script = String(body!.command);
        const processId = this.nextProcess++;
        this.processes.set(processId, { script, ...this.run(script) });
        return respond(200, { ok: true, processId, pid: 100 + processId, command: script });
      }
      const process = this.processes.get(Number(segments[3]));
      if (process === undefined) return respond(404, { ok: false, code: "not_found", message: "Not Found" });
      if (method === "DELETE") return respond(200, { ok: true });
      const stdoutOffset = Number(url.searchParams.get("stdoutOffset") ?? 0);
      const stderrOffset = Number(url.searchParams.get("stderrOffset") ?? 0);
      const running = process.pollsUntilDone > 0;
      if (running) process.pollsUntilDone -= 1;
      return respond(200, {
        ok: true,
        status: running ? "running" : "exited",
        running,
        exitCode: running ? null : process.exitCode,
        stdout: process.stdout.slice(stdoutOffset),
        stderr: process.stderr.slice(stderrOffset),
        stdoutNextOffset: process.stdout.length,
        stderrNextOffset: process.stderr.length,
      });
    }
    return respond(404, { ok: false, code: "not_found", message: "Not Found" });
  }
}

function respond(status: number, json: unknown) {
  return { status, text: async () => JSON.stringify(json) };
}
