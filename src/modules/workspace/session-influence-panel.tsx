import type { ReactNode } from "react";
import { AlertTriangle, Info, Puzzle, RefreshCw, Sparkles, Users } from "lucide-react";
import { useSessionInfluence } from "@/hooks/useSessionInfluence";
import type { SlashCommandDef } from "@/lib/slash-command-catalog";
import {
	agentScopeLabel,
	formatRiskFlags,
	sessionStatusLabel,
	type DiscoveredAgent,
	type DiscoveredPlugin,
	type DiscoveredInfluenceSkill,
} from "@/lib/session-influence";
import { cn } from "@/lib/utils";

type SessionInfluencePanelProps = {
	workDir?: string | null;
	runtimeSlashCommands?: readonly SlashCommandDef[];
};

export function SessionInfluencePanel({
	workDir,
	runtimeSlashCommands = [],
}: SessionInfluencePanelProps) {
	const { snapshot, isLoading, error, refresh, hasRuntimeCommandUpdate } = useSessionInfluence({
		workDir,
		runtimeSlashCommands,
	});

	return (
		<div className="space-y-3 border-b border-line p-3">
			<div className="flex items-start gap-2 rounded-r1 bg-secondary px-2.5 py-2 text-[10.5px] leading-relaxed text-muted">
				<Info size={13} className="mt-0.5 shrink-0 text-faint" />
				<p>{snapshot.reloadNotice}</p>
			</div>

			<div className="flex items-center justify-between gap-2">
				<p className="font-mono text-[10px] uppercase tracking-wide text-faint">会话影响因素</p>
				<button
					type="button"
					onClick={() => void refresh()}
					className="rounded-r1 p-1 text-muted hover:bg-hover hover:text-foreground"
					aria-label="刷新影响因素"
				>
					<RefreshCw size={12} className={cn(isLoading && "animate-spin")} />
				</button>
			</div>

			{error ? (
				<p className="rounded-r1 bg-danger-bg px-2 py-1.5 text-[10.5px] text-danger">{error}</p>
			) : null}

			{snapshot.hasSystemMd ? (
				<div className="flex items-start gap-2 rounded-r1 border border-warning/30 bg-warning-bg px-2.5 py-2 text-[10.5px] text-warning">
					<AlertTriangle size={13} className="mt-0.5 shrink-0" />
					<p>
						检测到 <code className="font-mono">$KIMI_CODE_HOME/SYSTEM.md</code>
						：可能永久覆盖主 Agent 系统提示词（正文默认不展示）。
					</p>
				</div>
			) : null}

			<InfluenceSection
				title="Plugins"
				icon={<Puzzle size={12} />}
				empty="未发现已安装 plugin 元数据"
				count={snapshot.plugins.length}
			>
				{snapshot.plugins.map((plugin) => (
					<PluginRow key={plugin.id} plugin={plugin} />
				))}
			</InfluenceSection>

			<InfluenceSection
				title="Agents"
				icon={<Users size={12} />}
				empty="未发现自定义 Agent 文件（内置 Agent 仍可能生效）"
				count={snapshot.agents.length}
			>
				{snapshot.agents.map((agent) => (
					<AgentRow key={`${agent.sourceLabel}:${agent.name}`} agent={agent} />
				))}
			</InfluenceSection>

			<InfluenceSection
				title="Skills"
				icon={<Sparkles size={12} />}
				empty="未发现磁盘 Skill"
				count={snapshot.skills.length}
			>
				{snapshot.skills.slice(0, 12).map((skill) => (
					<SkillRow
						key={`${skill.source}:${skill.name}`}
						skill={skill}
						hasRuntimeCommandUpdate={hasRuntimeCommandUpdate}
					/>
				))}
				{snapshot.skills.length > 12 ? (
					<p className="px-2 py-1 font-mono text-[9.5px] text-faint">
						另有 {snapshot.skills.length - 12} 个 Skill 未展开
					</p>
				) : null}
			</InfluenceSection>
		</div>
	);
}

function InfluenceSection({
	title,
	icon,
	empty,
	count,
	children,
}: {
	title: string;
	icon: ReactNode;
	empty: string;
	count: number;
	children: ReactNode;
}) {
	return (
		<section className="overflow-hidden rounded-r2 border border-line bg-elevated">
			<div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
				<span className="text-faint">{icon}</span>
				<span className="text-[11px] text-foreground">{title}</span>
				<span className="ml-auto font-mono text-[9.5px] text-faint">{count}</span>
			</div>
			<div className="divide-y divide-line">
				{count === 0 ? (
					<p className="px-2.5 py-3 text-center font-mono text-[10px] text-faint">{empty}</p>
				) : (
					children
				)}
			</div>
		</section>
	);
}

function StatusBadges({
	installedOnDisk,
	enabledInConfig,
	sessionStatus,
}: {
	installedOnDisk?: boolean;
	enabledInConfig?: boolean;
	sessionStatus: string;
}) {
	return (
		<div className="mt-1 flex flex-wrap gap-1">
			{installedOnDisk ? <Badge tone="muted">磁盘</Badge> : null}
			{enabledInConfig ? <Badge tone="ok">配置启用</Badge> : null}
			<Badge tone={sessionStatus === "loaded_in_current_session" ? "ok" : "neutral"}>
				{sessionStatusLabel(sessionStatus as "unknown")}
			</Badge>
		</div>
	);
}

function PluginRow({ plugin }: { plugin: DiscoveredPlugin }) {
	return (
		<div className="px-2.5 py-2">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="truncate text-[11px] text-foreground">
						{plugin.displayName ?? plugin.id}
					</p>
					<p className="font-mono text-[9.5px] text-faint">{plugin.id}</p>
				</div>
				{plugin.version ? (
					<span className="shrink-0 font-mono text-[9px] text-faint">v{plugin.version}</span>
				) : null}
			</div>
			{plugin.shortDescription ? (
				<p className="mt-1 line-clamp-2 text-[10px] text-muted">{plugin.shortDescription}</p>
			) : null}
			<StatusBadges
				installedOnDisk={plugin.installedOnDisk}
				enabledInConfig={plugin.enabledInConfig}
				sessionStatus={plugin.sessionStatus}
			/>
			<div className="mt-1 flex flex-wrap gap-1 font-mono text-[9px] text-faint">
				{plugin.skillCount > 0 ? <span>{plugin.skillCount} skills</span> : null}
				{plugin.commandCount > 0 ? <span>{plugin.commandCount} commands</span> : null}
				{plugin.mcpServerCount > 0 ? <span>{plugin.mcpServerCount} MCP</span> : null}
				{plugin.hasSystemPrompt ? <span>system prompt</span> : null}
			</div>
		</div>
	);
}

function AgentRow({ agent }: { agent: DiscoveredAgent }) {
	const risks = formatRiskFlags(agent.riskFlags);
	const isHighRisk =
		(agent.sourceScope === "project" && agent.overrideBuiltin) || risks.length > 0;

	return (
		<div className="px-2.5 py-2">
			<div className="flex items-start justify-between gap-2">
				<p className="truncate font-mono text-[11px] text-foreground">{agent.name}</p>
				<span className="shrink-0 text-[9.5px] text-faint">
					{agentScopeLabel(agent.sourceScope)}
				</span>
			</div>
			{agent.description ? (
				<p className="mt-1 line-clamp-2 text-[10px] text-muted">{agent.description}</p>
			) : null}
			<p className="mt-1 font-mono text-[9px] text-faint">{agent.sourceLabel}</p>
			<StatusBadges sessionStatus={agent.sessionStatus} />
			{agent.shadowedSources.length > 0 ? (
				<p className="mt-1 text-[9.5px] text-faint">
					同名低优先级来源：{agent.shadowedSources.join(" · ")}
				</p>
			) : null}
			{isHighRisk ? (
				<div className="mt-1.5 flex items-start gap-1.5 text-[9.5px] text-warning">
					<AlertTriangle size={11} className="mt-0.5 shrink-0" />
					<span>
						{risks.length > 0
							? risks.join(" · ")
							: "项目级 Agent 可能覆盖内置行为（正文默认不展示）"}
					</span>
				</div>
			) : null}
		</div>
	);
}

function SkillRow({
	skill,
	hasRuntimeCommandUpdate,
}: {
	skill: DiscoveredInfluenceSkill;
	hasRuntimeCommandUpdate: boolean;
}) {
	const runtimeLoaded =
		hasRuntimeCommandUpdate && skill.runtimeAdvertised === true;
	return (
		<div className="px-2.5 py-2">
			<p className="truncate font-mono text-[11px] text-foreground">{skill.name}</p>
			{skill.description ? (
				<p className="mt-0.5 line-clamp-2 text-[10px] text-muted">{skill.description}</p>
			) : null}
			<div className="mt-1 flex flex-wrap gap-1">
				<Badge tone="muted">磁盘 · {skill.source}</Badge>
				<Badge tone={runtimeLoaded ? "ok" : "neutral"}>
					{runtimeLoaded ? "当前会话已加载" : "unknown"}
				</Badge>
			</div>
		</div>
	);
}

function Badge({
	children,
	tone,
}: {
	children: ReactNode;
	tone: "muted" | "ok" | "neutral";
}) {
	return (
		<span
			className={cn(
				"rounded-r1 px-1.5 py-0.5 font-mono text-[9px]",
				tone === "ok" && "bg-success-bg text-success",
				tone === "muted" && "bg-secondary text-faint",
				tone === "neutral" && "bg-secondary text-muted",
			)}
		>
			{children}
		</span>
	);
}
