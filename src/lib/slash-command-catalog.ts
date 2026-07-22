export type SlashCommandDef = {
  name: string;
  description: string;
  aliases: string[];
  inputHint?: string | null;
};

/**
 * Desktop already exposes these via UI, or they are TUI/login-only.
 * Skills and other ACP-advertised commands stay available.
 */
const DESKTOP_SLASH_DENYLIST = new Set([
  // Existing desktop UI
  "swarm",
  "plan",
  "model",
  "new",
  "clear",
  "sessions",
  "resume",
  "fork",
  "title",
  "rename",
  "settings",
  "config",
  // Auth / provider flows
  "login",
  "logout",
  "provider",
  // Pure TUI / process exit
  "theme",
  "custom-theme",
  "editor",
  "reload-tui",
  "exit",
  "quit",
  "q",
  // Strong TUI panels — defer until desktop UI exists
  "plugins",
  "experiments",
  "experimental",
  "permission",
  // TUI-only / not wired over ACP — block hand-typed Unknown ACP noise
  "yolo",
  "yes",
  "auto",
  "effort",
  "undo",
  "goal",
  "btw",
  "feedback",
  "version",
  "web",
  "vis",
  "export-md",
  "export",
  "export-debug-zip",
  "copy",
  "init",
  "add-dir",
  "reload",
  "changelog",
  "release-notes",
  "afk",
  "setup",
  "debug",
  "hooks",
  "import",
  "reset",
  "upgrade",
]);

/** Always safe to forward to ACP even before available_commands_update. */
const ACP_FORWARDABLE_SLASH_COMMANDS = new Set([
  "compact",
  "mcp",
  "tasks",
  "task",
]);

/** Local desktop handlers (not forwarded to ACP as raw prompts). */
const LOCALLY_HANDLED_SLASH_COMMANDS = new Set([
  "swarm",
  "usage",
  "status",
  "help",
  "h",
  "?",
]);

/** Commands that commonly take trailing args even when ACP omits input.hint. */
const ARG_FRIENDLY_COMMANDS = new Set([
  "compact",
  "undo",
  "add-dir",
  "export-md",
  "export",
  "goal",
  "btw",
  "mcp-config",
  "update-config",
  "import-from-cc-codex",
  "sub-skill",
]);

const DESKTOP_DESCRIPTION_OVERRIDES: Record<string, string> = {
  usage: "Show plan quotas (5h / 7d) and session token usage",
  status: "Show session status and plan quotas (5h / 7d)",
  help: "Show available desktop / ACP commands",
  compact: "Compact the conversation context",
  mcp: "List MCP servers for this session",
  tasks: "List background tasks (read-only in desktop)",
};

const DENIED_COMMAND_HINTS: Record<string, string> = {
  swarm: "Use the Swarm toggle in the status bar.",
  plan: "Use the Plan toggle in the status bar.",
  model: "Use the model chip next to the composer send button.",
  new: "Use New chat in the sidebar.",
  clear: "Use New chat in the sidebar.",
  sessions: "Use the sessions sidebar.",
  resume: "Use the sessions sidebar.",
  fork: "Use Fork session in the sidebar.",
  title: "Rename the session from the sidebar.",
  rename: "Rename the session from the sidebar.",
  settings: "Open Settings from the app menu.",
  config: "Open Settings from the app menu.",
  login: "Sign in from Settings (device code), then reconnect.",
  logout: "Sign out from Settings, then reconnect.",
  provider: "Manage providers with `kimi` CLI / Settings.",
  yolo: "Use the permission mode control (YOLO) in the status bar.",
  yes: "Use the permission mode control (YOLO) in the status bar.",
  auto: "Use the permission mode control (Auto) in the status bar.",
  permission: "Use the permission mode control in the status bar.",
  plugins: "Manage plugins in the Kimi Code CLI TUI.",
  experiments: "Open experiments in the Kimi Code CLI TUI.",
  experimental: "Open experiments in the Kimi Code CLI TUI.",
  theme: "Theme is controlled by the desktop app appearance.",
  editor: "External editor is a TUI-only setting.",
  exit: "Close the desktop window to quit.",
  quit: "Close the desktop window to quit.",
  q: "Close the desktop window to quit.",
};

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isDeniedDesktopSlashCommand(name: string): boolean {
  const normalized = normalizeCommandName(name);
  return DESKTOP_SLASH_DENYLIST.has(normalized);
}

export function isLocallyHandledSlashCommand(name: string): boolean {
  return LOCALLY_HANDLED_SLASH_COMMANDS.has(normalizeCommandName(name));
}

export function desktopSlashCommandHint(name: string): string | null {
  const normalized = normalizeCommandName(name);
  return DENIED_COMMAND_HINTS[normalized] ?? null;
}

export function parseSlashCommandInput(
  text: string,
): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1).trim();
  if (!body) return null;
  const spaceIdx = body.search(/\s/);
  const rawName = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();
  if (!rawName || rawName.includes("/")) return null;
  return { name: normalizeCommandName(rawName), args };
}

export type SlashDispatchDecision =
  | { kind: "passthrough" }
  | { kind: "local"; name: "usage" | "status" | "help" | "swarm"; args: string }
  | { kind: "blocked"; message: string };

/**
 * Decide whether a composer send should be handled locally, blocked, or
 * forwarded to ACP. Advertised ACP/skill commands always pass through unless
 * they are locally handled (`usage`/`status`/`help`/`swarm`).
 */
export function classifySlashDispatch(
  text: string,
  advertisedCommands: readonly SlashCommandDef[],
): SlashDispatchDecision {
  const parsed = parseSlashCommandInput(text);
  if (!parsed) return { kind: "passthrough" };

  const { name, args } = parsed;

  if (name === "usage" || name === "status" || name === "help" || name === "h" || name === "?") {
    const localName = name === "h" || name === "?" ? "help" : name;
    return { kind: "local", name: localName, args };
  }
  if (name === "swarm") {
    return { kind: "local", name: "swarm", args };
  }

  if (isDeniedDesktopSlashCommand(name)) {
    const hint = desktopSlashCommandHint(name);
    return {
      kind: "blocked",
      message: hint
        ? `/${name} is not available in desktop. ${hint}`
        : `/${name} is not available in desktop. Use the app UI or Kimi Code CLI TUI instead.`,
    };
  }

  if (ACP_FORWARDABLE_SLASH_COMMANDS.has(name)) {
    return { kind: "passthrough" };
  }

  const advertised = new Set(
    advertisedCommands.flatMap((command) => {
      const names = [normalizeCommandName(command.name)];
      for (const alias of command.aliases ?? []) {
        names.push(normalizeCommandName(alias));
      }
      return names;
    }),
  );

  if (advertised.has(name) || name.startsWith("skill:") || name.includes(".")) {
    return { kind: "passthrough" };
  }

  return {
    kind: "blocked",
    message: `/${name} is not available in desktop. Type /help to see supported commands.`,
  };
}

export function filterDesktopSlashCommands(
  commands: SlashCommandDef[],
): SlashCommandDef[] {
  const seen = new Set<string>();
  const filtered: SlashCommandDef[] = [];

  for (const command of commands) {
    const name = command.name?.trim();
    if (!name) {
      continue;
    }
    const key = normalizeCommandName(name);
    if (seen.has(key) || isDeniedDesktopSlashCommand(name)) {
      continue;
    }
    seen.add(key);
    filtered.push({
      name,
      description:
        DESKTOP_DESCRIPTION_OVERRIDES[key] ?? command.description ?? "",
      aliases: Array.isArray(command.aliases)
        ? command.aliases.filter(
            (alias) =>
              typeof alias === "string" &&
              alias.length > 0 &&
              !isDeniedDesktopSlashCommand(alias),
          )
        : [],
      inputHint: command.inputHint ?? null,
    });
  }

  return filtered;
}

export function formatDesktopHelpReport(
  commands: readonly SlashCommandDef[],
): string {
  const lines = [
    "Desktop slash commands:",
    "- /usage — Show plan quotas (5h / 7d) and session token usage",
    "- /status — Show session status and plan quotas (5h / 7d)",
    "- /help — Show this help",
    "- /swarm [on|off] — Toggle swarm mode (status bar)",
  ];
  const extras = commands.filter((command) => {
    const key = normalizeCommandName(command.name);
    return !["usage", "status", "help", "swarm"].includes(key);
  });
  if (extras.length > 0) {
    lines.push("", "From Kimi Code ACP:");
    for (const command of extras) {
      const hint = command.inputHint ? ` ${command.inputHint}` : "";
      lines.push(`- /${command.name}${hint} — ${command.description}`);
    }
  }
  lines.push(
    "",
    "Session / mode controls that live in the UI (not as slash commands): New chat, Plan, permission mode, Settings.",
  );
  return lines.join("\n");
}

/**
 * Immediate send for toggles / info commands; insert+edit when args are useful.
 */
export function shouldExecuteSlashCommandImmediately(
  command: SlashCommandDef,
): boolean {
  const name = normalizeCommandName(command.name);
  if (command.inputHint && command.inputHint.trim().length > 0) {
    return false;
  }
  if (ARG_FRIENDLY_COMMANDS.has(name)) {
    return false;
  }
  if (name.startsWith("skill:") || name.includes(".")) {
    return false;
  }
  return true;
}
