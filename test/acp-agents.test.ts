import { describe, expect, it } from "vitest";
import {
  parseCustomAgents,
  stringifyCustomAgents,
  withBoatAgents,
  withoutBoatAgents,
} from "../src/acp-agents.js";

describe("Boat ACP agents", () => {
  it("adds Kimi Code and Mistral Vibe next to existing agents", () => {
    const existing = [{ id: "auggie", displayName: "Auggie", command: "/usr/local/bin/auggie" }];
    const { agents, changed } = withBoatAgents(existing);
    expect(changed).toBe(true);
    expect(agents.map((agent) => agent.id)).toEqual(["auggie", "kimi", "mistral-vibe"]);
    expect(agents[1]).toEqual({ id: "kimi", displayName: "Kimi Code", command: "kimi", args: ["acp"] });
    expect(agents[2]).toMatchObject({ command: "vibe-acp", args: [] });
  });

  it("is stable and keeps keys a user added", () => {
    const first = withBoatAgents([]).agents;
    first[0] = { ...first[0], env: { KIMI_DEBUG: "1" } };
    const again = withBoatAgents(first);
    expect(again.changed).toBe(false);
    expect(again.agents[0]).toMatchObject({ id: "kimi", env: { KIMI_DEBUG: "1" } });
  });

  it("removes only its own agents", () => {
    const { agents } = withBoatAgents([{ id: "droid", command: "droid" }]);
    expect(withoutBoatAgents(agents)).toEqual({ agents: [{ id: "droid", command: "droid" }], changed: true });
    expect(withoutBoatAgents([{ id: "droid" }]).changed).toBe(false);
  });

  it("round-trips the setting and refuses a non-array", () => {
    expect(parseCustomAgents("")).toEqual([]);
    const text = stringifyCustomAgents(withBoatAgents([]).agents);
    expect(parseCustomAgents(text).map((agent) => agent.id)).toEqual(["kimi", "mistral-vibe"]);
    expect(stringifyCustomAgents([])).toBe("");
    expect(() => parseCustomAgents("{}")).toThrow(/JSON array/u);
  });
});
