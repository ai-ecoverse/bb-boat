import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDENTITY_SCRUB_SCRIPT } from "../src/backend.js";

// The scrub runs `pkill -f` against the daemon name. Everything the executor
// puts in argv (bash -lc <script>, plus any wrapper shell) carries the script
// text, so the text must never match the name or pkill kills its own shell.
const DAEMON_PATTERN = /bb-host-daemon/;

/** True when this user already runs a real bb daemon that pkill would hit. */
function realDaemonRunning(): boolean {
  if (process.platform !== "linux") return false;
  const uid = String(process.getuid?.() ?? "");
  const { status } = spawnSync("pgrep", ["-u", uid, "-f", "bb-host-daemon"], { stdio: "ignore" });
  return status === 0;
}

describe("IDENTITY_SCRUB_SCRIPT", () => {
  it("never contains a command line pkill -f would match", () => {
    expect(IDENTITY_SCRUB_SCRIPT).not.toMatch(DAEMON_PATTERN);
  });

  // macOS pkill differs, and on a machine with a real bb daemon the scrub
  // would stop it, so only run where it is safe: Linux CI.
  it.skipIf(process.platform !== "linux" || realDaemonRunning())(
    "survives its own pkill, stops the daemon and removes copied state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "bb-boat-scrub-"));
      const home = join(root, "home");
      const bin = join(root, "bin");
      const calls = join(root, "systemctl.log");
      mkdirSync(join(home, ".bb-machines", "m1"), { recursive: true });
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(home, ".config", "systemd", "user", "bb-host-daemon-m1.service"), "");
      mkdirSync(bin);
      // Stub systemctl: record calls and report one copied daemon unit.
      writeFileSync(
        join(bin, "systemctl"),
        [
          "#!/bin/sh",
          `echo "$*" >> '${calls}'`,
          'case "$*" in *list-unit-files*) echo "bb-host-daemon-m1.service enabled enabled" ;; esac',
          "exit 0",
        ].join("\n"),
      );
      chmodSync(join(bin, "systemctl"), 0o755);

      // Decoy daemon: our own child whose command line names the daemon.
      const decoy = spawn("sleep", ["60"], { argv0: "bb-host-daemon-test", stdio: "ignore" });
      const decoyExit = new Promise<NodeJS.Signals | null>((resolve) =>
        decoy.on("exit", (_code, signal) => resolve(signal)),
      );
      try {
        await new Promise((resolve) => decoy.on("spawn", resolve));
        const result = spawnSync("bash", ["-lc", IDENTITY_SCRUB_SCRIPT], {
          env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        expect(await decoyExit).toBe("SIGTERM");
        expect(existsSync(join(home, ".bb-machines"))).toBe(false);
        expect(existsSync(join(home, ".config", "systemd", "user", "bb-host-daemon-m1.service"))).toBe(false);
        const log = readFileSync(calls, "utf8");
        expect(log).toContain("list-unit-files --no-legend bb-host-daemon-*");
        expect(log).toContain("disable --now bb-host-daemon-m1.service");
      } finally {
        if (decoy.exitCode === null && decoy.signalCode === null) decoy.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
