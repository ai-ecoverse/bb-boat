# bb-boat

Run [bb](https://getbb.app) threads on [Boat](https://boat.dev) sandboxes.

The plugin registers a **Boat Sandbox** machine provider and a matching
environment in the New thread picker. Each choice creates a Boat sandbox, and bb
core installs its daemon there, enrolls the machine, clones the project and runs
its `.bb-env-setup.sh`. The sandbox connects back through the server-access
route bb already uses for remote machines, such as bb Connect. Tailscale is not
required.

It follows the sandbox-backend pattern of bb's bundled
[Modal Sandbox plugin](https://github.com/get-bb/bb/tree/main/plugins/environment-modal-sandbox):
bb core owns bootstrap, enrollment and cancellation, and this plugin only
allocates, stops, resumes and deletes Boat compute.

> **Status: experimental.**

## Install

```sh
bb plugin install git:github.com/ai-ecoverse/bb-boat
```

Create a Boat API key and enter it as `apiKey` in Settings → Plugins → Boat
Sandbox. The key is a plugin secret and is never sent to the frontend. The
`ci` preset grants what the plugin needs: create, resume, stop and delete of
the sandboxes this key created. `full-sandbox` cannot create sandboxes.

```sh
boat api-key create bb --preset ci
```

Then pick **Boat Sandbox** as the environment of a new thread, or:

```sh
bb machine create --provider boat-sandbox --json
bb machine create --provider boat-sandbox --inputs '{"type":"small","from":"my-template"}'
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiKey` | | Boat API key (secret). |
| `org` | blank | Boat organization new sandboxes bill to. Blank: personal account. |
| `from` | blank | Named snapshot new sandboxes start from. Blank: a fresh Boat sandbox. |
| `environment` | blank | Boat environment (repos, variables, secret files). Blank: your default. |
| `type` | `default` | `small`, `default`, `large` or `xlarge`. |
| `autoStopHours` | 2 | Boat auto-stop set on create and resume. 0 turns it off (paid plans). |
| `idleMinutes` | 15 | Suspend an idle machine after this long. 0 disables it. |
| `prepareScript` | blank | Shell script run on each new sandbox before bb installs its daemon. |

Machine inputs `type` and `from` override the settings for one machine.

## Lifecycle

| bb | Boat |
| --- | --- |
| create | `POST /sandboxes` with an `Idempotency-Key` derived from bb's allocation key, then a name `bb-<hash>` for cleanup |
| suspend | `POST /sandboxes/{id}/stop`, wait for `archived` |
| resume | `POST /sandboxes/{id}/resume`, wait for `ready`; the same sandbox and host identity come back |
| remove | `DELETE /sandboxes/{id}` with `X-Ascii-Confirm-Delete` |
| reconcile cleanup | delete sandboxes named `bb-<hash>` for the key |

Boat stops sandboxes at their auto-stop deadline without telling bb. A
background sweep runs every minute: it suspends idle machines, extends the
deadline of busy ones 15 minutes before it, and hands sandboxes Boat already
stopped to core so the machine record matches. The free trial caps auto-stop at
2 hours, so leave `autoStopHours` at 2 there.

bb's bootstrap commands run through Boat's detached command API, read
incrementally by offset, so long installs are not cut off at Boat's 600-second
limit for synchronous commands. Boat commands have no stdin; stdin goes through
a mode-600 file in `/tmp` that the command deletes.

## Templates

`from` can name a snapshot with your tools, agent logins or configuration
already in place. A sandbox started from a snapshot of an enrolled machine
would otherwise carry that machine's bb identity, so before bootstrap the
plugin removes `~/.bb-machines` and any `bb-host-daemon-*` user units copied
from the snapshot.

Use `prepareScript` for per-sandbox fixes. For example, pi on Amazon Bedrock
rejects the tool schema of Boat's preinstalled `computer` MCP server; this
removes it:

```sh
python3 - <<'EOF'
import json, os
p = os.path.expanduser("~/.pi/agent/mcp.json")
d = json.load(open(p))
d.get("mcpServers", {}).pop("computer", None)
json.dump(d, open(p, "w"), indent=2)
EOF
```

## Known limits

- A create that crashes between Boat accepting the sandbox and the plugin
  naming it leaves an unnamed sandbox that reconcile cleanup cannot find.
  Retrying the same create reuses it for 24 hours through the idempotency key.
- Lifecycle calls refuse an API key from another Boat account than the one
  that created the machine.
- The project must have a Git remote, as for every bb sandbox environment.

## Development

```sh
npm install
npm test
npm run typecheck
bb plugin build .
```

`dist/` is committed; a git install runs it. Rebuild before tagging.

## License

MIT. `src/sandbox-backend.ts` and `src/register.ts` are adapted from bb's Modal
sandbox plugin (MIT, Copyright (c) 2026 Michael Yong).
