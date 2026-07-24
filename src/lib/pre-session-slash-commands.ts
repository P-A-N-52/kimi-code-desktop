import type { SlashCommandDef } from "./slash-command-catalog";

/** Slash commands available in the new-session composer before ACP connects. */
export const PRE_SESSION_SLASH_COMMANDS: SlashCommandDef[] = [
	{
		name: "compact",
		description: "Compact the conversation context",
		aliases: [],
		inputHint: "instructions",
	},
	{
		name: "mcp",
		description: "List MCP servers for this session",
		aliases: [],
	},
	{
		name: "tasks",
		description: "List background tasks (read-only in desktop)",
		aliases: [],
	},
	{
		name: "task",
		description: "Manage a background task",
		aliases: [],
		inputHint: "task id",
	},
	{
		name: "goal",
		description: "Create or continue a long-running goal (forwarded to ACP)",
		aliases: [],
		inputHint: "goal description",
	},
	{
		name: "help",
		description: "Show available desktop / ACP commands",
		aliases: ["h", "?"],
	},
];
