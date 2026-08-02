import type { SlashCommandDef } from "./slash-command-catalog";

/** Disk/config evidence only — never implies the current session loaded it. */
export type InfluenceDiscovery = "installed_on_disk" | "enabled_in_config";

/** Session runtime attribution from ACP updates or stable runtime signals. */
export type InfluenceSessionStatus =
	| "loaded_in_current_session"
	| "pending_reload"
	| "unknown";

export type DiscoveredPlugin = {
	id: string;
	displayName: string | null;
	version: string | null;
	shortDescription: string | null;
	installedOnDisk: boolean;
	enabledInConfig: boolean;
	sessionStatus: InfluenceSessionStatus;
	hasSystemPrompt: boolean;
	hasAgents: boolean;
	skillCount: number;
	commandCount: number;
	mcpServerCount: number;
};

export type AgentSourceScope =
	| "explicit"
	| "project"
	| "extra"
	| "user"
	| "plugin"
	| "builtin"
	| "unknown";

export type DiscoveredAgent = {
	name: string;
	description: string;
	sourceScope: AgentSourceScope;
	sourceLabel: string;
	overrideBuiltin: boolean;
	riskFlags: string[];
	shadowedSources: string[];
	sessionStatus: InfluenceSessionStatus;
	discovery: InfluenceDiscovery;
};

export type DiscoveredInfluenceSkill = {
	name: string;
	description: string;
	source: string;
	discovery: InfluenceDiscovery;
	runtimeAdvertised?: boolean;
};

export type SessionInfluenceSnapshot = {
	plugins: DiscoveredPlugin[];
	agents: DiscoveredAgent[];
	skills: DiscoveredInfluenceSkill[];
	hasSystemMd: boolean;
	reloadNotice: string;
};

const AGENT_SCOPE_PRIORITY: Record<AgentSourceScope, number> = {
	explicit: 0,
	project: 1,
	extra: 2,
	user: 3,
	plugin: 4,
	builtin: 5,
	unknown: 6,
};

export function normalizeSessionInfluenceSnapshot(
	raw: Record<string, unknown> | null | undefined,
): SessionInfluenceSnapshot {
	if (!raw) {
		return emptySessionInfluenceSnapshot();
	}
	return {
		plugins: normalizePlugins(raw.plugins),
		agents: normalizeAgents(raw.agents),
		skills: normalizeSkills(raw.skills),
		hasSystemMd: raw.hasSystemMd === true,
		reloadNotice:
			typeof raw.reloadNotice === "string" && raw.reloadNotice.length > 0
				? raw.reloadNotice
				: DEFAULT_RELOAD_NOTICE,
	};
}

export function emptySessionInfluenceSnapshot(): SessionInfluenceSnapshot {
	return {
		plugins: [],
		agents: [],
		skills: [],
		hasSystemMd: false,
		reloadNotice: DEFAULT_RELOAD_NOTICE,
	};
}

const DEFAULT_RELOAD_NOTICE =
	"插件或 Agent 配置变更通常需要 CLI 中执行 /reload 或开启新会话后才会在当前会话稳定生效；本页磁盘扫描不代表当前会话已加载。";

function normalizePlugins(value: unknown): DiscoveredPlugin[] {
	if (!Array.isArray(value)) return [];
	const plugins: DiscoveredPlugin[] = [];
	for (const entry of value) {
		const record = (entry ?? {}) as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id.trim() : "";
		if (!id) continue;
		plugins.push({
			id,
			displayName: optionalString(record.displayName),
			version: optionalString(record.version),
			shortDescription: optionalString(record.shortDescription),
			installedOnDisk: record.installedOnDisk === true,
			enabledInConfig: record.enabledInConfig === true,
			sessionStatus: "unknown",
			hasSystemPrompt: record.hasSystemPrompt === true,
			hasAgents: record.hasAgents === true,
			skillCount: nonNegativeInt(record.skillCount),
			commandCount: nonNegativeInt(record.commandCount),
			mcpServerCount: nonNegativeInt(record.mcpServerCount),
		});
	}
	return plugins;
}

function normalizeAgents(value: unknown): DiscoveredAgent[] {
	if (!Array.isArray(value)) return [];
	const agents: DiscoveredAgent[] = [];
	for (const entry of value) {
		const record = (entry ?? {}) as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (!name) continue;
		agents.push({
			name,
			description: typeof record.description === "string" ? record.description : "",
			sourceScope: normalizeAgentScope(record.sourceScope),
			sourceLabel: typeof record.sourceLabel === "string" ? record.sourceLabel : "unknown",
			overrideBuiltin: record.overrideBuiltin === true,
			riskFlags: normalizeStringArray(record.riskFlags),
			shadowedSources: normalizeStringArray(record.shadowedSources),
			sessionStatus: "unknown",
			discovery: "installed_on_disk",
		});
	}
	return agents;
}

function normalizeSkills(value: unknown): DiscoveredInfluenceSkill[] {
	if (!Array.isArray(value)) return [];
	const skills: DiscoveredInfluenceSkill[] = [];
	for (const entry of value) {
		const record = (entry ?? {}) as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (!name) continue;
		skills.push({
			name,
			description: typeof record.description === "string" ? record.description : "",
			source: typeof record.source === "string" ? record.source : "unknown",
			discovery: "installed_on_disk",
		});
	}
	return skills;
}

function normalizeAgentScope(value: unknown): AgentSourceScope {
	if (typeof value !== "string") return "unknown";
	switch (value) {
		case "explicit":
		case "project":
		case "extra":
		case "user":
		case "plugin":
		case "builtin":
			return value;
		default:
			return "unknown";
	}
}

/** Merge disk snapshot with runtime slash-command evidence (live or replay). */
export function applyRuntimeInfluenceSignals(
	snapshot: SessionInfluenceSnapshot,
	runtimeSlashCommands: readonly SlashCommandDef[],
	hasRuntimeCommandUpdate: boolean,
): SessionInfluenceSnapshot {
	const pluginIds = collectRuntimePluginIds(runtimeSlashCommands);
	const runtimeSkillNames = collectRuntimeSkillNames(runtimeSlashCommands);

	return {
		...snapshot,
		plugins: snapshot.plugins.map((plugin) => ({
			...plugin,
			sessionStatus: resolvePluginSessionStatus(
				plugin,
				pluginIds,
				hasRuntimeCommandUpdate,
			),
		})),
		skills: snapshot.skills.map((skill) => ({
			...skill,
			runtimeAdvertised: runtimeSkillNames.has(skill.name.toLowerCase()),
		})),
		agents: snapshot.agents.map((agent) => ({
			...agent,
			sessionStatus: "unknown" as const,
		})),
	};
}

function resolvePluginSessionStatus(
	plugin: DiscoveredPlugin,
	runtimePluginIds: Set<string>,
	hasRuntimeCommandUpdate: boolean,
): InfluenceSessionStatus {
	if (!plugin.enabledInConfig) {
		return "unknown";
	}
	if (!hasRuntimeCommandUpdate) {
		return "unknown";
	}
	if (runtimePluginIds.has(plugin.id.toLowerCase())) {
		return "loaded_in_current_session";
	}
	return "unknown";
}

export function collectRuntimePluginIds(
	commands: readonly SlashCommandDef[],
): Set<string> {
	const ids = new Set<string>();
	for (const command of commands) {
		const source = command.source ?? "";
		if (source.startsWith("runtime:plugin:")) {
			const id = source.slice("runtime:plugin:".length).trim().toLowerCase();
			if (id) ids.add(id);
		}
		const name = command.name.trim();
		if (name.includes(":")) {
			const [prefix] = name.split(":");
			if (prefix && prefix !== "skill") {
				ids.add(prefix.toLowerCase());
			}
		}
	}
	return ids;
}

function collectRuntimeSkillNames(commands: readonly SlashCommandDef[]): Set<string> {
	const names = new Set<string>();
	for (const command of commands) {
		if (command.source === "runtime:skill" || command.name.startsWith("skill:")) {
			const skillName = command.name.replace(/^skill:/, "").trim().toLowerCase();
			if (skillName) names.add(skillName);
		}
	}
	return names;
}

export function agentScopeLabel(scope: AgentSourceScope): string {
	switch (scope) {
		case "explicit":
			return "显式 agent file";
		case "project":
			return "项目";
		case "extra":
			return "extra_agent_dirs";
		case "user":
			return "用户";
		case "plugin":
			return "Plugin";
		case "builtin":
			return "内置";
		default:
			return "unknown";
	}
}

export function agentScopePriority(scope: AgentSourceScope): number {
	return AGENT_SCOPE_PRIORITY[scope] ?? AGENT_SCOPE_PRIORITY.unknown;
}

export function formatRiskFlags(flags: readonly string[]): string[] {
	const labels: string[] = [];
	if (flags.includes("override")) {
		labels.push("override: true（可替换系统提示词）");
	}
	if (flags.includes("tool_restrictions")) {
		labels.push("自定义工具限制");
	}
	return labels;
}

export function sessionStatusLabel(status: InfluenceSessionStatus): string {
	switch (status) {
		case "loaded_in_current_session":
			return "当前会话已加载";
		case "pending_reload":
			return "待 reload / 新会话";
		default:
			return "unknown";
	}
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: 0;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}
