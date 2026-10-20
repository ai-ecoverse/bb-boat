// Boat sandboxes ship ACP-capable agents that bb has no built-in provider for.
// They are registered as custom agents of bb's ACP providers plugin, with bare
// command names: bb resolves the command on the machine a thread runs on, so
// the agents work on Boat sandboxes whether or not the server has them.

export const ACP_PLUGIN_ID = "provider-acp";

export type JsonObject = Record<string, unknown>;
export type CustomAgent = JsonObject & { id?: unknown };

interface BoatAgent {
  id: string;
  displayName: string;
  command: string;
  args: string[];
}

/** Verified on Boat sandboxes: initialize, session/new and a prompt over ACP. */
export const BOAT_ACP_AGENTS: readonly BoatAgent[] = [
  // Kimi Code 2.2: `kimi acp`; uses MOONSHOT_API_KEY or a Kimi sign-in.
  { id: "kimi", displayName: "Kimi Code", command: "kimi", args: ["acp"] },
  // Mistral Vibe 2.26: `vibe-acp`; uses MISTRAL_API_KEY. Boat installs it on first run.
  { id: "mistral-vibe", displayName: "Mistral Vibe", command: "vibe-acp", args: [] },
];

const OWN_IDS: ReadonlySet<string> = new Set(BOAT_ACP_AGENTS.map((agent) => agent.id));

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCustomAgents(value: unknown): CustomAgent[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") throw new Error(`${ACP_PLUGIN_ID} customAgents must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(`${ACP_PLUGIN_ID} customAgents must be a JSON array; refusing to overwrite it`);
  }
  return parsed.filter(isObject) as CustomAgent[];
}

export function stringifyCustomAgents(agents: CustomAgent[]): string {
  return agents.length === 0 ? "" : `${JSON.stringify(agents, null, 2)}\n`;
}

/**
 * Adds or refreshes the Boat agents. Keys a user added to an entry (env, cwd,
 * modelCli, ...) survive; id, displayName, command and args are rewritten.
 */
export function withBoatAgents(agents: CustomAgent[]): { agents: CustomAgent[]; changed: boolean } {
  const next = [...agents];
  for (const agent of BOAT_ACP_AGENTS) {
    const index = next.findIndex((entry) => entry.id === agent.id);
    const existing = index >= 0 ? next[index] : undefined;
    const managed: CustomAgent = {
      ...(existing ?? {}),
      id: agent.id,
      displayName: agent.displayName,
      command: agent.command,
      args: [...agent.args],
    };
    if (index >= 0) next[index] = managed;
    else next.push(managed);
  }
  return { agents: next, changed: JSON.stringify(next) !== JSON.stringify(agents) };
}

export function withoutBoatAgents(agents: CustomAgent[]): { agents: CustomAgent[]; changed: boolean } {
  const next = agents.filter((entry) => typeof entry.id !== "string" || !OWN_IDS.has(entry.id));
  return { agents: next, changed: next.length !== agents.length };
}
