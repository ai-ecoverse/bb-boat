---
name: boat-sandboxes
description: Create, inspect, suspend, resume or remove bb machines on Boat (boat.dev) sandboxes with the boat-sandbox machine provider.
---

# Boat sandboxes

The `boat-sandbox` machine provider runs bb machines on Boat sandboxes. It needs
the plugin's `apiKey` setting; `bb machine providers` shows `setup-required`
until it is set. Never put the key in a command line or a message.

## Create

```sh
bb machine create --provider boat-sandbox --json
bb machine create --provider boat-sandbox --inputs '{"type":"small"}' --json
bb machine create --provider boat-sandbox --inputs '{"from":"<named-snapshot>"}' --json
```

`type` is `small`, `default`, `large` or `xlarge` (the trial allows only small
and default). `from` names a Boat named snapshot; it overrides the plugin's
`from` setting. Creation waits for the daemon to connect; `--no-wait` returns
the host id at once.

New threads can also pick the **Boat Sandbox** environment, which creates one
sandbox per thread with a fresh project checkout.

## Inspect and control

```sh
bb machine list --json
bb machine show <host-id>
bb machine suspend <host-id>    # Boat stop: saves the disk, stops billing
bb machine resume <host-id>     # Boat resume: same sandbox, same host id
bb machine remove <host-id> --yes
```

Boat-side details: `boat info <sandbox-id>`; the sandbox id is in the machine
name (`Boat bx_…`).

## Behavior to expect

- Idle machines are suspended after `idleMinutes` (default 15).
- Boat auto-stops a sandbox at its deadline (`autoStopHours`, default 2). The
  plugin extends busy sandboxes 15 minutes before it and suspends idle ones.
- A sandbox Boat stopped by itself shows up in bb as suspended within a minute.
- Running processes end on suspend; enabled systemd user services, including
  the bb daemon, start again on resume.
