---
name: boat-sandboxes
description: Create, inspect, suspend, resume or remove bb machines on Boat (boat.dev) sandboxes with the boat-sandbox machine provider, and pick agents that run there.
---

# Boat sandboxes

The `boat-sandbox` machine provider runs bb machines on Boat sandboxes. It needs
the plugin's `apiKey` setting (a Boat key with the `ci` preset); `bb machine
providers` shows `setup-required` until it is set. Never put the key in a
command line or a message.

## Create

```sh
bb machine create --provider boat-sandbox --json
bb machine create --provider boat-sandbox --inputs '{"type":"small"}' --json
bb machine create --provider boat-sandbox --inputs '{"from":"<named-snapshot>"}' --json
```

Run these on the bb server. A thread on another machine gets
`machine_host_management_forbidden`. `type` is `small`, `default`, `large` or
`xlarge` (the trial allows small and default). `from` names a Boat named
snapshot. New threads can instead pick the **Boat Sandbox** environment, which
creates one sandbox per thread; archiving the thread deletes it.

## Agents

Boat sandboxes ship Claude Code (`claude-code`), Codex (`codex`), pi (`pi`),
OpenCode (`acp-opencode`), Cursor Agent (`acp-cursor`), Kimi Code (`acp-kimi`)
and Mistral Vibe (`acp-mistral-vibe`). They use the credentials from Boat's
Agents & Proxying page. "Not logged in" means that agent has no credentials on
Boat. On Bedrock, use `us.` or `global.` model ids.

## Inspect and control

```sh
bb machine list --json
bb machine show <host-id>
bb machine suspend <host-id>    # Boat stop: keeps the disk, stops billing
bb machine resume <host-id>     # Boat resume: same sandbox, same host id
bb machine remove <host-id> --yes
bb plugin logs boat-sandbox     # create/suspend/resume/remove with sandbox ids
```

Boat-side details: `boat info <sandbox-id>`; the sandbox id is in the machine
name (`Boat bx_…`).

## Behavior to expect

- Idle machines are suspended after `idleMinutes` (default 15).
- Boat auto-stops a sandbox at its deadline (`autoStopHours`, default 2). The
  plugin extends busy sandboxes 15 minutes before it and suspends idle ones.
- A sandbox Boat stopped by itself shows up in bb as suspended within a minute.
- Running processes end on suspend; the bb daemon and other enabled systemd
  user services start again on resume.
