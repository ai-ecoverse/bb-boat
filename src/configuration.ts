export const SETTING_DESCRIPTORS = {
  apiKey: {
    type: "string",
    secret: true,
    label: "Boat API key",
    description:
      "A boat_… key from `boat api-key create <name>` or the Boat dashboard.",
  },
  org: {
    type: "string",
    label: "Organization",
    description:
      "Boat organization id or name new sandboxes bill to. Leave blank for your personal account.",
    default: "",
  },
  from: {
    type: "string",
    label: "Named snapshot",
    description:
      "Start new sandboxes from this named snapshot (`boat snapshot <id> <name>`). Leave blank for a fresh Boat sandbox.",
    default: "",
  },
  environment: {
    type: "string",
    label: "Boat environment",
    description:
      "Boat environment for new sandboxes (repos, variables, secret files). Leave blank for your default environment.",
    default: "",
  },
  type: {
    type: "select",
    label: "Sandbox size",
    description: "small (2 vCPU, 4 GB), default (4 vCPU, 8 GB), large (8 vCPU, 16 GB) or xlarge (16 vCPU, 32 GB).",
    options: ["small", "default", "large", "xlarge"] as string[],
    default: "default",
  },
  autoStopHours: {
    type: "number",
    label: "Boat auto-stop (hours)",
    description:
      "Boat stops a sandbox this long after create or resume unless bb extends it. The plugin extends busy sandboxes and suspends idle ones before the deadline. 0 turns Boat's auto-stop off (paid plans only).",
    default: 2,
  },
  idleMinutes: {
    type: "number",
    label: "Suspend after idle (minutes)",
    description:
      "Stop and snapshot an idle sandbox after this long. 0 disables idle suspension.",
    default: 15,
  },
  prepareScript: {
    type: "string",
    label: "Prepare script",
    experimental_multiline: true,
    description:
      "Shell script run as the sandbox user on each new sandbox before bb installs its daemon, for example to adjust agent configuration.",
    default: "",
  },
} as const;

export const SANDBOX_TYPES = ["small", "default", "large", "xlarge"] as const;
export type SandboxType = (typeof SANDBOX_TYPES)[number];

export interface ResolvedSettings {
  apiKey: string;
  org: string | null;
  from: string | null;
  environment: string | null;
  type: SandboxType;
  ttlSeconds: number | null;
  idleMs: number | null;
  prepareScript: string | null;
}

export type SettingsResolution =
  | { ok: true; settings: ResolvedSettings }
  | { ok: false; message: string };

export interface RawSettings {
  apiKey: string | undefined;
  org: string;
  from: string;
  environment: string;
  type: string;
  autoStopHours: number;
  idleMinutes: number;
  prepareScript: string;
}

const MAX_AUTO_STOP_HOURS = 30 * 24;
const MAX_IDLE_MINUTES = 24 * 60;

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveSettings(raw: RawSettings): SettingsResolution {
  const apiKey = (raw.apiKey ?? "").trim();
  if (apiKey.length === 0) {
    return { ok: false, message: "Set apiKey in the plugin's settings." };
  }
  const type = raw.type.trim();
  if (!(SANDBOX_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      message: `type must be one of ${SANDBOX_TYPES.join(", ")}, not "${type}".`,
    };
  }
  if (
    !Number.isFinite(raw.autoStopHours) ||
    raw.autoStopHours < 0 ||
    raw.autoStopHours > MAX_AUTO_STOP_HOURS
  ) {
    return {
      ok: false,
      message: `autoStopHours must be between 0 and ${MAX_AUTO_STOP_HOURS}, not ${raw.autoStopHours}.`,
    };
  }
  if (
    !Number.isInteger(raw.idleMinutes) ||
    raw.idleMinutes < 0 ||
    raw.idleMinutes > MAX_IDLE_MINUTES
  ) {
    return {
      ok: false,
      message: `idleMinutes must be a whole number between 0 and ${MAX_IDLE_MINUTES}, not ${raw.idleMinutes}.`,
    };
  }
  return {
    ok: true,
    settings: {
      apiKey,
      org: blankToNull(raw.org),
      from: blankToNull(raw.from),
      environment: blankToNull(raw.environment),
      type: type as SandboxType,
      ttlSeconds:
        raw.autoStopHours === 0 ? null : Math.round(raw.autoStopHours * 3600),
      idleMs: raw.idleMinutes === 0 ? null : raw.idleMinutes * 60_000,
      prepareScript: blankToNull(raw.prepareScript),
    },
  };
}
