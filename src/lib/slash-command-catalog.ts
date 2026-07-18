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

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isDeniedDesktopSlashCommand(name: string): boolean {
  const normalized = normalizeCommandName(name);
  if (DESKTOP_SLASH_DENYLIST.has(normalized)) {
    return true;
  }
  // Bare aliases that map to denied commands
  if (normalized === "h" || normalized === "?") {
    return false;
  }
  return false;
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
      description: command.description ?? "",
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
