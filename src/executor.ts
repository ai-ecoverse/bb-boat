import { randomUUID } from "node:crypto";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { BoatApiError, type BoatClient } from "./boat-client.js";

export interface ExecutorDeps {
  sleep: (delayMs: number) => Promise<void>;
  now: () => number;
}

const START_ATTEMPTS = 20;
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 2_000;

export function shellQuote(argument: string): string {
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/u.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * A start Boat refused before running anything. Any other failure may mean the
 * command ran, so it is never replayed.
 */
function startRefused(error: unknown): boolean {
  if (!(error instanceof BoatApiError)) return false;
  if (error.code === "sandbox_starting" || error.code === "idempotency_in_progress")
    return true;
  if (error.code === "sandbox_direct_failed" || error.code === "box_direct_failed")
    return /\b(?:sandbox|box)_restoring\b/u.test(error.message);
  return error.status === 429 || error.status === 503;
}

/**
 * Runs bb's bootstrap commands through Boat's detached command API: Boat's
 * synchronous commands stop at 600 s and return output only at the end, while
 * detached commands have no limit and can be read incrementally by offset.
 * Boat has no stdin, so stdin goes through a private file.
 */
export function createBoatExecutor(
  client: BoatClient,
  sandboxId: string,
  deps: ExecutorDeps,
): MachineExecutor {
  return {
    async exec({ command, timeoutMs, signal, stdin, onOutput }) {
      const argv = command.map(shellQuote).join(" ");
      let script: string;
      if (stdin.length > 0) {
        const path = `/tmp/bb-boat-stdin-${randomUUID()}`;
        await client.writeFile(sandboxId, path, stdin, signal);
        const file = shellQuote(path);
        script = `chmod 600 ${file}; (${argv}) < ${file}; rc=$?; rm -f ${file}; exit $rc`;
      } else {
        script = `(${argv}) < /dev/null`;
      }

      let processId: number | null = null;
      for (let attempt = 1; processId === null; attempt += 1) {
        signal.throwIfAborted();
        try {
          processId = await client.startCommand(sandboxId, script, signal);
        } catch (error) {
          if (!startRefused(error) || attempt >= START_ATTEMPTS) throw error;
          const wait =
            error instanceof BoatApiError && error.retryAfterSeconds !== null
              ? error.retryAfterSeconds * 1_000
              : 1_500;
          await deps.sleep(wait);
        }
      }

      const deadline = deps.now() + timeoutMs;
      const offsets = { stdout: 0, stderr: 0 };
      let delay = POLL_MIN_MS;
      for (;;) {
        if (signal.aborted || deps.now() > deadline) {
          await client.stopCommand(sandboxId, processId).catch(() => {});
          signal.throwIfAborted();
          throw new Error(
            `Boat command timed out after ${Math.round(timeoutMs / 1000)} s: ${command[0] ?? ""}`,
          );
        }
        const status = await client.commandStatus(sandboxId, processId, offsets, signal);
        const output = status.stdout + status.stderr;
        if (output.length > 0) {
          onOutput(output);
          delay = POLL_MIN_MS;
        } else {
          delay = Math.min(POLL_MAX_MS, delay * 2);
        }
        offsets.stdout = status.stdoutNextOffset ?? offsets.stdout + status.stdout.length;
        offsets.stderr = status.stderrNextOffset ?? offsets.stderr + status.stderr.length;
        if (!status.running && status.more !== true) {
          if (status.exitCode !== null) return { exitCode: status.exitCode };
          if (status.status === "lost")
            throw new Error("Boat lost track of the command; its outcome is unknown.");
          return { exitCode: 128 };
        }
        await deps.sleep(delay);
      }
    },
  };
}
