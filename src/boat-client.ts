// Minimal client for the Boat REST API (https://docs.boat.dev/api/v1).
//
// Responses are parsed at this boundary. The sandbox schema keeps only the
// non-secret fields this plugin needs: url, ip, sshEndpoint, desktopUrl and
// subdomain are dropped here so nothing downstream can log or persist them.
import { z } from "zod";

export const BOAT_API_BASE = "https://boat.dev/api/v1";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export const sandboxStateSchema = z.string();

export const sandboxSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  state: sandboxStateSchema,
  error: z.string().nullable().optional(),
  health: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  archiveAfter: z.string().nullable().optional(),
  ttlSeconds: z.number().nullable().optional(),
  snapshotAvailable: z.boolean().nullable().optional(),
  lastSnapshotStatus: z.string().nullable().optional(),
  hydrated: z.boolean().nullable().optional(),
  environment: z.string().nullable().optional(),
});
export type Sandbox = z.infer<typeof sandboxSchema>;

/** States in which commands and files work. */
export const LIVE_STATES: ReadonlySet<string> = new Set([
  "ready",
  "idle",
  "running",
]);
/** States on the way to a live sandbox. */
export const STARTING_STATES: ReadonlySet<string> = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
]);

const stopSchema = z.object({
  id: z.string(),
  status: z.string(),
  error: z.string().nullable().optional(),
});
export type StopOperation = z.infer<typeof stopSchema>;

const deletionSchema = z.object({
  id: z.string(),
  status: z.string(),
});

const commandStartedSchema = z.object({ processId: z.number().int() });

const commandStatusSchema = z.object({
  status: z.string(),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  stdoutNextOffset: z.number().int().optional(),
  stderrNextOffset: z.number().int().optional(),
  more: z.boolean().optional(),
});
export type CommandStatus = z.infer<typeof commandStatusSchema>;

const meSchema = z.object({
  user: z.object({ id: z.string().min(1), login: z.string().optional() }),
});

export class BoatApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  constructor(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    retryAfterSeconds: number | null,
  ) {
    super(`Boat API ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface CreateSandboxRequest {
  from?: string;
  type?: string;
  ttlSeconds: number | null;
  environment?: string;
  org?: string;
}

export class BoatClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
    private readonly base: string = BOAT_API_BASE,
  ) {}

  private async request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetchImpl(this.base + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new BoatApiError(
        response.status,
        "invalid_json",
        "non-JSON response",
        response.status >= 500,
        null,
      );
    }
    if (response.status >= 400 || json.ok === false) {
      const error =
        typeof json.error === "object" && json.error !== null
          ? (json.error as Record<string, unknown>)
          : {};
      const details =
        typeof error.details === "object" && error.details !== null
          ? (error.details as Record<string, unknown>)
          : {};
      const code =
        typeof json.code === "string"
          ? json.code
          : typeof error.code === "string"
            ? error.code
            : "http_error";
      const message =
        typeof json.message === "string" ? json.message : `HTTP ${response.status}`;
      const retryAfter =
        typeof json.retryAfterSeconds === "number"
          ? json.retryAfterSeconds
          : typeof json.retryAfter === "number"
            ? json.retryAfter
            : null;
      throw new BoatApiError(
        response.status,
        code,
        message,
        details.retryable === true,
        retryAfter,
      );
    }
    return json;
  }

  async me(signal?: AbortSignal): Promise<{ id: string; login?: string }> {
    return meSchema.parse(await this.request("GET", "/me", { signal })).user;
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<Sandbox | null> {
    try {
      const json = await this.request("GET", `/sandboxes/${encodeURIComponent(id)}`, {
        signal,
      });
      return sandboxSchema.parse(json.sandbox);
    } catch (error) {
      if (error instanceof BoatApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listSandboxes(signal?: AbortSignal): Promise<Sandbox[]> {
    const sandboxes: Sandbox[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor !== null) query.set("cursor", cursor);
      const json = await this.request("GET", `/sandboxes?${query}`, { signal });
      for (const entry of z.array(z.unknown()).parse(json.sandboxes ?? [])) {
        sandboxes.push(sandboxSchema.parse(entry));
      }
      const info = z
        .object({ hasMore: z.boolean(), nextCursor: z.string().nullable() })
        .partial()
        .parse(json.pageInfo ?? {});
      if (info.hasMore !== true || !info.nextCursor) break;
      cursor = info.nextCursor;
    }
    return sandboxes;
  }

  /** The same idempotency key and body return the same sandbox for 24 hours. */
  async createSandbox(
    request: CreateSandboxRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Sandbox> {
    const body: Record<string, unknown> = { ttlSeconds: request.ttlSeconds };
    if (request.from !== undefined) body.from = request.from;
    if (request.type !== undefined) body.type = request.type;
    if (request.environment !== undefined) body.environment = request.environment;
    if (request.org !== undefined) body.org = request.org;
    const json = await this.request("POST", "/sandboxes", {
      body,
      headers: { "Idempotency-Key": idempotencyKey },
      signal,
    });
    return sandboxSchema.parse(json.sandbox);
  }

  async update(
    id: string,
    patch: { name?: string; ttlSeconds?: number | null },
    signal?: AbortSignal,
  ): Promise<Sandbox> {
    const json = await this.request("PATCH", `/sandboxes/${encodeURIComponent(id)}`, {
      body: patch,
      signal,
    });
    return sandboxSchema.parse(json.sandbox);
  }

  /** Starts a stop. Returns the stop operation id. */
  async stop(id: string, signal?: AbortSignal): Promise<string> {
    const json = await this.request("POST", `/sandboxes/${encodeURIComponent(id)}/stop`, {
      body: {},
      signal,
    });
    return z.object({ id: z.string() }).parse(json).id;
  }

  async getStop(id: string, stopId: string, signal?: AbortSignal): Promise<StopOperation> {
    const json = await this.request(
      "GET",
      `/sandboxes/${encodeURIComponent(id)}/stops/${encodeURIComponent(stopId)}`,
      { signal },
    );
    return stopSchema.parse(json.stop);
  }

  async resume(id: string, ttlSeconds: number | null, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, {
      body: { ttlSeconds },
      signal,
    });
  }

  /** Deletes a sandbox and its snapshots. Returns the deletion operation id, or null when already gone. */
  async deleteSandbox(id: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const json = await this.request("DELETE", `/sandboxes/${encodeURIComponent(id)}`, {
        headers: { "X-Ascii-Confirm-Delete": id },
        signal,
      });
      return deletionSchema.parse(json.operation).id;
    } catch (error) {
      if (error instanceof BoatApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getDeletion(operationId: string, signal?: AbortSignal): Promise<string> {
    const json = await this.request(
      "GET",
      `/deletion-operations/${encodeURIComponent(operationId)}`,
      { signal },
    );
    return deletionSchema.parse(json.operation).status;
  }

  async startCommand(id: string, command: string, signal?: AbortSignal): Promise<number> {
    const json = await this.request(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/commands`,
      { body: { command, detached: true }, signal },
    );
    return commandStartedSchema.parse(json).processId;
  }

  async commandStatus(
    id: string,
    processId: number,
    offsets: { stdout: number; stderr: number },
    signal?: AbortSignal,
  ): Promise<CommandStatus> {
    const query = new URLSearchParams({
      stdoutOffset: String(offsets.stdout),
      stderrOffset: String(offsets.stderr),
    });
    const json = await this.request(
      "GET",
      `/sandboxes/${encodeURIComponent(id)}/commands/${processId}?${query}`,
      { signal },
    );
    return commandStatusSchema.parse(json);
  }

  async stopCommand(id: string, processId: number, signal?: AbortSignal): Promise<void> {
    await this.request(
      "DELETE",
      `/sandboxes/${encodeURIComponent(id)}/commands/${processId}`,
      { signal },
    );
  }

  /** Paths must be under /home/user or /tmp. */
  async writeFile(
    id: string,
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("PUT", `/sandboxes/${encodeURIComponent(id)}/files`, {
      body: {
        path,
        content: Buffer.from(content, "utf8").toString("base64"),
        encoding: "base64",
      },
      signal,
    });
  }
}
