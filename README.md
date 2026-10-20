# bb-boat

Run [bb](https://getbb.app) threads on [Boat](https://boat.dev) sandboxes.

Pick **Boat Sandbox** as the environment of a new thread and bb starts a fresh
Boat VM, installs its daemon, clones your project and runs the agent there. The
sandbox suspends when idle, resumes with the same identity when you come back,
and is deleted when you archive the thread.

> **Status: experimental.** Tested on bb 0.46 with the Boat free trial:
> machine create, threads in Boat Sandbox environments, suspend and resume with
> the same identity, idle suspend, and removal on archive. Claude Code on
> Bedrock and pi were checked with the daemon's environment; Kimi Code and
> Mistral Vibe were checked over ACP on a sandbox.

## What you get

- **A machine provider, `boat-sandbox`.** `bb machine create --provider
  boat-sandbox` creates a standalone machine you can suspend, resume and remove.
- **A Boat Sandbox environment** in the New thread picker. Each thread gets its
  own sandbox with a fresh project checkout; archiving the thread deletes it.
- **Your Boat credentials for every agent.** Sign-ins, API keys and Bedrock
  credentials from Boat's *Agents & Proxying* page reach the agents bb starts.
- **Two more agents.** Kimi Code (`acp-kimi`) and Mistral Vibe
  (`acp-mistral-vibe`), which Boat preinstalls, become bb providers.
- **Auto-stop handling.** Busy sandboxes get their Boat deadline extended, idle
  ones are suspended through bb, and bb notices when Boat stopped one itself.

No Tailscale or public address is needed: sandboxes connect back through the
server-access route bb already uses for remote machines, such as bb Connect.

## Requirements

- bb 0.46 or later, with a server-access route remote machines can reach
  (Settings → Machines → *Machine access*, for example bb Connect).
- A Boat account. The free trial works within its limits: 2 sandboxes at once,
  25 compute hours, auto-stop of at most 2 hours, `small` and `default` sizes.
- A project with a Git remote, for the Boat Sandbox environment.

## Setup

1. **Install the plugin** on your bb server:

   ```sh
   bb plugin install git:github.com/ai-ecoverse/bb-boat
   ```

2. **Create a Boat API key** with the `ci` preset. It can create, resume, stop
   and delete the sandboxes it created, and nothing of your account beyond that.
   The `full-sandbox` preset cannot create sandboxes.

   ```sh
   boat api-key create bb --preset ci
   ```

3. **Enter the key** as `apiKey` in Settings → Plugins → Boat Sandbox. It is
   stored as a plugin secret and never sent to the frontend.

4. **Give the agents credentials** on Boat's
   [Agents & Proxying](https://boat.dev/dashboard?tab=agents) page: a Claude or
   ChatGPT sign-in, API keys (Anthropic, OpenAI, Moonshot, Mistral, ...), or
   `claude-bedrock` / `codex-bedrock` for Amazon Bedrock. See
   [Agent credentials](#agent-credentials).

## Usage

**One sandbox per thread.** Start a new thread, choose **Boat Sandbox** as the
environment and any provider as the agent. The first message waits about
20 seconds for the sandbox, the daemon and the clone.

**A standalone machine.** Create it from a terminal on the bb server, then pick
it as the machine of any thread:

```sh
bb machine create --provider boat-sandbox --json
bb machine create --provider boat-sandbox --inputs '{"type":"small","from":"my-template"}' --json
bb machine suspend <host-id>
bb machine resume <host-id>
bb machine remove <host-id> --yes
```

Settings → Machines → *Add a machine* only offers manual enrollment in bb 0.46;
plugin providers are available from the New thread picker and the CLI.

## Agents

Boat sandboxes come with these agents preinstalled:

| Agent | bb provider | Notes |
| --- | --- | --- |
| Claude Code | `claude-code` | built into bb |
| Codex | `codex` | built into bb |
| pi | `pi` | built into bb |
| OpenCode | `acp-opencode` | detected by bb when installed |
| Cursor Agent | `acp-cursor` | built into bb's ACP providers |
| Kimi Code | `acp-kimi` | registered by this plugin, runs `kimi acp` |
| Mistral Vibe | `acp-mistral-vibe` | registered by this plugin, runs `vibe-acp` |

The plugin adds Kimi Code and Mistral Vibe as custom agents of bb's ACP
providers plugin. The entries use bare command names, so bb resolves them on
the machine a thread runs on and the bb server does not need either CLI.
Boat installs Vibe on its first run, so the first Vibe session on a new
sandbox takes about a minute longer. Turn the `registerAgents` setting off to
remove both entries; fields you add to them yourself (`env`, `modelCli`, ...)
are kept while they are registered.

## Agent credentials

Boat writes the credentials of your credential profile to
`/run/ascii-secrets/env.sh` on each sandbox, and only login shells read that
file. bb's daemon runs as a systemd user service, so on each new sandbox the
plugin installs a drop-in for `bb-host-daemon-*` units that turns the file into
an `EnvironmentFile` before every daemon start. Agents bb starts then see the
same credentials as `boat ssh`, and rotated credentials apply after the next
resume.

For Amazon Bedrock, add `claude-bedrock` on the Agents & Proxying page: it sets
`CLAUDE_CODE_USE_BEDROCK`, `AWS_BEARER_TOKEN_BEDROCK` and `AWS_REGION`, which
Claude Code and pi both use. On Bedrock, pick a `us.` or `global.` model id.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiKey` | | Boat API key (secret), `ci` preset. |
| `org` | blank | Boat organization new sandboxes bill to. Blank: your personal account. |
| `from` | blank | Named snapshot new sandboxes start from. Blank: a fresh Boat sandbox. |
| `environment` | blank | Boat environment (repos, variables, secret files). Blank: your default. |
| `type` | `default` | `small`, `default`, `large` or `xlarge`. |
| `autoStopHours` | 2 | Boat auto-stop on create and resume. 0 turns it off (paid plans only). |
| `idleMinutes` | 15 | Suspend a machine after this long without thread or terminal activity. 0 disables it. |
| `prepareScript` | blank | Shell script run as the sandbox user on each new sandbox, before bb installs its daemon. |
| `registerAgents` | on | Register Kimi Code and Mistral Vibe as ACP agents. |

The machine inputs `type` and `from` override the settings for one machine.

## Lifecycle

| bb | Boat |
| --- | --- |
| create | `POST /sandboxes` with an `Idempotency-Key` derived from bb's allocation key, then the name `bb-<hash>` |
| suspend | `POST /sandboxes/{id}/stop` and wait for `archived`; Boat keeps the disk |
| resume | `POST /sandboxes/{id}/resume` and wait for `ready`; the same sandbox and bb identity come back |
| remove | `DELETE /sandboxes/{id}` with `X-Ascii-Confirm-Delete` |
| reconcile cleanup | delete the sandboxes named `bb-<hash>` for the allocation key |

A background check runs every minute. It suspends idle machines, extends the
Boat deadline of busy ones 15 minutes before it, and suspends through bb any
sandbox Boat stopped on its own, so bb's machine record stays accurate. Stopped
sandboxes cost nothing; Boat deletes their disks after 14 days.

Archiving a thread that runs in a Boat Sandbox environment removes its machine,
which deletes the sandbox and its disk.

## Templates and prepare scripts

`from` names a Boat snapshot with your tools, agent configuration or caches in
place. A snapshot of an enrolled machine would carry that machine's bb
identity, so before bootstrap the plugin removes `~/.bb-machines` and any
`bb-host-daemon-*` units copied from it.

`prepareScript` runs on every new sandbox. For example, pi on Amazon Bedrock
rejects the tool schema of Boat's preinstalled `computer` MCP server; this
removes it from pi's configuration:

```sh
python3 - <<'EOF'
import json, os
p = os.path.expanduser("~/.pi/agent/mcp.json")
if os.path.exists(p):
    d = json.load(open(p))
    d.get("mcpServers", {}).pop("computer", None)
    json.dump(d, open(p, "w"), indent=2)
EOF
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Boat API 403 api_key_action_forbidden: … sandbox.create` | The key lacks create. Use a `ci` key. |
| `Not logged in · Please run /login` in a thread | No credentials for that agent on Boat. Add a sign-in, key or `claude-bedrock` on Agents & Proxying, then start a new thread. |
| `machine_host_management_forbidden` | You ran `bb machine create` from inside a thread on another machine. Run it on the bb server or use the New thread picker. |
| Boat Sandbox missing from Settings → Machines | Expected in bb 0.46; use the New thread picker or the CLI. |
| Bedrock rejects a tool schema (`anyOf at the top level`) | Boat's `computer` MCP server; remove it with the prepare script above. |
| A first Mistral Vibe session is slow | Boat installs Vibe on first use; later sessions start normally. |

`bb plugin logs boat-sandbox` shows every create, suspend, resume and remove
with its sandbox id. `boat info <sandbox-id>` shows the Boat side.

## How it works

The plugin follows the sandbox-backend pattern of bb's bundled
[Modal Sandbox plugin](https://github.com/get-bb/bb/tree/main/plugins/environment-modal-sandbox):
bb core owns daemon bootstrap, enrollment, project checkout and cancellation;
the plugin allocates, stops, resumes and deletes Boat compute and gives core a
way to run commands.

Commands run through Boat's detached command API and are read incrementally by
byte offset, so output streams into bb's progress log and long installs are not
cut off at Boat's 600-second limit for synchronous commands. Boat commands have
no stdin; stdin goes through a mode-600 file in `/tmp` that the command deletes,
so the enrollment bundle never appears in a command line or Boat's history.

| File | Role |
| --- | --- |
| `server.ts` | Plugin entry: settings, idle and auto-stop check, ACP agent registration |
| `src/backend.ts` | create, suspend, resume, remove and cleanup |
| `src/boat-client.ts` | Boat REST client; drops addresses and URLs at parse time |
| `src/executor.ts` | bb's command executor on Boat's detached command API |
| `src/acp-agents.ts` | Kimi Code and Mistral Vibe entries for the ACP providers plugin |
| `src/register.ts`, `src/sandbox-backend.ts` | Backend interface and registration, from bb's Modal plugin |

## Known limits

- A create that fails after Boat accepted the sandbox but before the plugin
  named it leaves an unnamed sandbox that reconcile cleanup cannot find. A retry
  of the same create reuses it for 24 hours through the idempotency key.
- Lifecycle calls refuse an API key from another Boat account than the one
  that created the machine.

## Development

```sh
npm install
npm test
npm run typecheck
bb plugin build .
```

Tests run against an in-memory fake of the Boat API; they make no network
calls. `dist/` is committed because a git install runs it: rebuild and commit
it with every source change.

## License

MIT. `src/sandbox-backend.ts` and `src/register.ts` are adapted from bb's Modal
sandbox plugin (MIT, Copyright (c) 2026 Michael Yong).
