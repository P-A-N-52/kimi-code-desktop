import { type ReactNode, useEffect, useState } from "react";
import {
	acpAuthStatusLabel,
	formatCapabilities,
	providerCredentialLabel,
	type ProviderSummary,
} from "@/lib/provider-overview";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { useConfirm } from "@/ui/confirm-dialog";
import { useProvidersOverview } from "./use-providers-overview";

function StatusBadge({
	label,
	tone,
}: {
	label: string;
	tone: "neutral" | "ok" | "warn" | "danger";
}) {
	return (
		<span
			className={cn(
				"inline-flex rounded-r1 px-1.5 py-0.5 font-mono text-[10px]",
				tone === "ok" && "bg-success/15 text-success",
				tone === "warn" && "bg-warn/15 text-warn",
				tone === "danger" && "bg-danger/15 text-danger",
				tone === "neutral" && "bg-surface text-muted",
			)}
		>
			{label}
		</span>
	);
}

function ProviderCard({ provider }: { provider: ProviderSummary }) {
	const credentialTone =
		provider.credentialStatus === "configured" ? "ok" : "warn";

	return (
		<section className="rounded-r2 border border-line/70 bg-surface/40 p-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h3 className="truncate font-mono text-[12.5px] text-foreground">
						{provider.name}
					</h3>
					<p className="mt-0.5 font-mono text-[10.5px] text-faint">
						{provider.providerType || "（未知类型）"}
						{provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
					</p>
				</div>
				<StatusBadge
					label={providerCredentialLabel(provider.credentialStatus)}
					tone={credentialTone}
				/>
			</div>
			<p className="mt-2 text-[10.5px] text-muted">{provider.credentialHint}</p>
			{provider.issues.length > 0 ? (
				<ul className="mt-2 space-y-1 font-mono text-[10.5px] text-warn">
					{provider.issues.map((issue) => (
						<li key={issue}>{issue}</li>
					))}
				</ul>
			) : null}
			{provider.models.length > 0 ? (
				<div className="mt-3 space-y-2">
					<p className="font-mono text-[10px] uppercase tracking-[0.09em] text-faint">
						模型绑定
					</p>
					{provider.models.map((model) => (
						<div
							key={model.alias}
							className="rounded-r1 border border-line/60 bg-background/60 px-2.5 py-2"
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-mono text-[11.5px] text-foreground">
									{model.alias}
								</span>
								{model.isDefault ? (
									<StatusBadge label="默认模型" tone="neutral" />
								) : null}
							</div>
							<p className="mt-1 font-mono text-[10.5px] text-muted">
								上游：{model.upstreamModel || "（未设置）"}
							</p>
							<p className="mt-1 font-mono text-[10.5px] text-faint">
								capabilities：{formatCapabilities(model.capabilities)}
							</p>
							{model.supportEfforts?.length ? (
								<p className="mt-1 font-mono text-[10.5px] text-faint">
									efforts：{model.supportEfforts.join(" · ")}
								</p>
							) : null}
							{model.issues.length > 0 ? (
								<ul className="mt-1 space-y-0.5 font-mono text-[10.5px] text-warn">
									{model.issues.map((issue) => (
										<li key={issue}>{issue}</li>
									))}
								</ul>
							) : null}
						</div>
					))}
				</div>
			) : (
				<p className="mt-3 font-mono text-[10.5px] text-faint">暂无模型绑定</p>
			)}
		</section>
	);
}

export function ProvidersPanel({
	enabled,
	advancedEditor,
	advancedEditorDirty = false,
	onAdvancedEditorDiscard,
	structuredEditor,
	structuredEditorDirty = false,
	onStructuredEditorDiscard,
}: {
	enabled: boolean;
	advancedEditor: ReactNode;
	advancedEditorDirty?: boolean;
	onAdvancedEditorDiscard?: () => void;
	structuredEditor?: ReactNode;
	structuredEditorDirty?: boolean;
	onStructuredEditorDiscard?: () => void;
}) {
	const { overview, isLoading, error, refresh } = useProvidersOverview({ enabled });
	const confirm = useConfirm();
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [structuredOpen, setStructuredOpen] = useState(false);

	useEffect(() => {
		if (!enabled) {
			setAdvancedOpen(false);
			setStructuredOpen(false);
		}
	}, [enabled]);

	const openStructuredEditor = async () => {
		if (!structuredEditor) {
			return;
		}
		if (
			advancedOpen &&
			advancedEditorDirty &&
			!(await confirm("高级 config.toml 编辑器有未保存的更改，确定放弃并进入结构化编辑吗？"))
		) {
			return;
		}
		if (advancedOpen && advancedEditorDirty) {
			onAdvancedEditorDiscard?.();
		}
		setAdvancedOpen(false);
		setStructuredOpen(true);
	};

	const closeAdvancedEditor = async () => {
			if (
				advancedEditorDirty &&
				!(await confirm("高级 config.toml 编辑器有未保存的更改，确定放弃并返回摘要吗？"))
			) {
				return;
			}
			if (advancedEditorDirty) {
				onAdvancedEditorDiscard?.();
			}
			setAdvancedOpen(false);
		};

		const closeStructuredEditor = async () => {
		if (
			structuredEditorDirty &&
			!(await confirm("结构化模型配置有未保存的更改，确定放弃并返回摘要吗？"))
		) {
			return;
		}
		if (structuredEditorDirty) {
			onStructuredEditorDiscard?.();
		}
		setStructuredOpen(false);
	};

	if (structuredOpen && structuredEditor) {
		return (
			<div className="flex h-full min-h-0 flex-1 flex-col">
				<div className="mb-3 flex shrink-0 items-center justify-between gap-3 border-b border-line pb-3">
					<div>
						<p className="text-[12.5px] text-foreground">结构化 Provider / 模型配置</p>
						<p className="mt-1 text-[10.5px] text-faint">
							保存成功后将刷新 Provider 摘要和其他全局配置消费者。
						</p>
					</div>
					<Button variant="ghost" onClick={() => void closeStructuredEditor()}>
						返回摘要
					</Button>
				</div>
				{structuredEditor}
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col">
			<div className="mb-3 shrink-0 space-y-2">
				<p className="text-[12.5px] text-foreground">
					查看 Provider、模型绑定与 capabilities 摘要。此处只做本地结构校验，不会向第三方
					Provider 发送连接测试。
				</p>
				<p className="text-[10.5px] text-faint">
					「Provider 已配置」只表示 config.toml / 登录状态里存在凭据来源；不等于当前会话一定可用。实际
					model/thinking 以聊天区模型菜单为准。
				</p>
				{overview ? (
					<div className="rounded-r1 border border-line/70 bg-elevated/50 px-2.5 py-2">
						<div className="flex flex-wrap items-center gap-2">
							<StatusBadge
								label={
									overview.structureValid ? "结构校验通过" : "结构校验有问题"
								}
								tone={overview.structureValid ? "ok" : "warn"}
							/>
							<StatusBadge
								label={acpAuthStatusLabel(overview.acpAuth.status)}
								tone={overview.acpAuth.status === "failed" ? "danger" : "neutral"}
							/>
							{overview.kimiAccountCredentialsPresent ? (
								<StatusBadge label="Kimi 账号已登录" tone="ok" />
							) : null}
						</div>
						{overview.acpAuth.status === "failed" &&
						overview.acpAuth.lastFailureMessage ? (
							<p className="mt-2 font-mono text-[10.5px] text-danger">
								{overview.acpAuth.lastFailureMessage}
							</p>
						) : null}
						{overview.defaultModel ? (
							<p className="mt-2 font-mono text-[10.5px] text-muted">
								默认模型：{overview.defaultModel}
							</p>
						) : null}
						<p className="mt-1 truncate font-mono text-[10px] text-faint">
							{overview.configPath}
						</p>
					</div>
				) : null}
				{error ? (
					<p className="font-mono text-[10.5px] text-danger">{error}</p>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="ghost" disabled={isLoading} onClick={() => void refresh()}>
						{isLoading ? "刷新中…" : "刷新摘要"}
					</Button>
					{structuredEditor ? (
						<Button variant="primary" onClick={() => void openStructuredEditor()}>
							编辑模型配置
						</Button>
					) : null}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto pr-1">
				{isLoading && !overview ? (
					<p className="py-8 text-center font-mono text-[11px] text-faint">加载中…</p>
				) : overview && overview.providers.length === 0 ? (
					<p className="py-8 text-center font-mono text-[11px] text-faint">
						尚未配置 Provider。可在下方结构化编辑器或高级编辑器中添加。
					</p>
				) : (
					<div className="space-y-3 pb-3">
						{overview?.structureIssues.length ? (
							<div className="rounded-r1 border border-warn/40 bg-warn/10 px-2.5 py-2">
								<p className="font-mono text-[10px] uppercase tracking-[0.09em] text-warn">
									结构问题
								</p>
								<ul className="mt-1 space-y-1 font-mono text-[10.5px] text-warn">
									{overview.structureIssues.map((issue) => (
										<li key={issue}>{issue}</li>
									))}
								</ul>
							</div>
						) : null}
						{overview?.providers.map((provider) => (
							<ProviderCard key={provider.name} provider={provider} />
						))}
					</div>
				)}
			</div>

			<div className="mt-3 shrink-0 border-t border-line pt-3">
				<button
					type="button"
					className="font-mono text-[10.5px] text-muted underline-offset-2 hover:text-foreground hover:underline"
					onClick={() => {
							if (advancedOpen) {
								void closeAdvancedEditor();
								return;
							}
							setAdvancedOpen(true);
						}}
				>
					{advancedOpen ? "收起高级 config.toml 编辑器" : "展开高级 config.toml 编辑器（排障）"}
				</button>
				{advancedOpen ? (
					<div className="mt-3 flex min-h-[240px] flex-1 flex-col">{advancedEditor}</div>
				) : null}
			</div>
		</div>
	);
}
