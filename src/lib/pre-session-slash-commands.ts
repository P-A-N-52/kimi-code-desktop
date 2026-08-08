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
		description: "Create or continue a long-running goal (forwarded to the runtime)",
		aliases: [],
		inputHint: "goal description",
	},
	{
		name: "write-goal",
		description: "Write a goal file for a long-running objective",
		aliases: [],
		inputHint: "goal description",
	},
	{
		name: "mcp-config",
		description: "Configure MCP servers and handle MCP OAuth login",
		aliases: [],
	},
	{
		name: "update-config",
		description: "Review and update Kimi Code configuration",
		aliases: [],
	},
	{
		name: "import-from-cc-codex",
		description: "Import Claude Code / Codex instructions, skills, and MCP settings",
		aliases: [],
	},
	{
		name: "check-kimi-code-docs",
		description: "Answer Kimi Code product questions from the official docs",
		aliases: [],
		inputHint: "question",
	},
	{
		name: "sub-skill",
		description: "Reorganize the skill inventory into sub-skill bundles",
		aliases: [],
	},
	{
		name: "sub-skill.review",
		description: "Recommend candidate skill groups (read-only)",
		aliases: [],
	},
	{
		name: "sub-skill.consolidate",
		description: "Apply an approved sub-skill grouping (with backups)",
		aliases: [],
	},
	{
		name: "custom-theme",
		description: "Create or edit a kimi-code custom color theme",
		aliases: [],
	},
	{
		name: "help",
		description: "Show available desktop / runtime commands",
		aliases: ["h", "?"],
	},
];
