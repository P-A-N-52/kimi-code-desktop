import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { notifyGlobalConfigApplied } from "@/lib/config-update-toast";
import {
	findConfigModel,
	modelForcesThinking,
	modelHasThinkingCapability,
} from "@/lib/model-capabilities";
import { PRE_SESSION_SLASH_COMMANDS } from "@/lib/pre-session-slash-commands";
import {
	classifySlashDispatch,
	formatDesktopHelpReport,
} from "@/lib/slash-command-catalog";
import { listWorkDirDirectory } from "@/lib/work-dir-files";
import {
	CommandResultPanel,
	type CommandResultPanelState,
} from "@/modules/composer/command-result-panel";
import { Composer } from "@/modules/composer/composer";
import type { FileMentionEntry } from "@/modules/composer/file-mentions";
import { WorkDirPicker } from "@/modules/sessions/work-dir-picker";

const DRAFT_SESSION_PREFIX = "__new-session__:";

export function NewSessionView({
	workDir,
	onWorkDirChange,
	fetchWorkDirs,
	onSendFirstMessage,
	onManageConfig,
}: {
	workDir: string;
	onWorkDirChange: (dir: string) => void;
	fetchWorkDirs: () => Promise<string[]>;
	onSendFirstMessage: (workDir: string, text: string) => Promise<void>;
	onManageConfig?: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [recentDirs, setRecentDirs] = useState<string[]>([]);
	const [creating, setCreating] = useState(false);
	const [commandResult, setCommandResult] = useState<CommandResultPanelState | null>(null);
	const { config, update, isUpdating } = useGlobalConfig();

	const mentionSessionKey = workDir.trim()
		? `${DRAFT_SESSION_PREFIX}${workDir.trim()}`
		: `${DRAFT_SESSION_PREFIX}pending`;

	const listDirectory = useCallback(
		async (_sessionId: string, path?: string): Promise<FileMentionEntry[]> =>
			listWorkDirDirectory(workDir, path),
		[workDir],
	);

	useEffect(() => {
		fetchWorkDirs()
			.then(setRecentDirs)
			.catch(() => {});
	}, [fetchWorkDirs]);

	const selectedModel = config?.defaultModel || "";
	const models = config?.models ?? [];
	const selectedConfigModel = useMemo(
		() => findConfigModel(models, selectedModel),
		[models, selectedModel],
	);

	const handleSelectModel = useCallback(
		async (name: string) => {
			if (!name || name === selectedModel) return;
			try {
				const resp = await update({ defaultModel: name });
				notifyGlobalConfigApplied(resp, `已切换到 ${name}`);
			} catch (error) {
				toast.error("切换模型失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[selectedModel, update],
	);

	const handleToggleThinking = useCallback(
		async (enabled: boolean) => {
			if (modelForcesThinking(selectedConfigModel)) return;
			if (!modelHasThinkingCapability(selectedConfigModel)) return;
			try {
				const resp = await update({ defaultThinking: enabled });
				notifyGlobalConfigApplied(
					resp,
					enabled ? "思考模式已开启" : "思考模式已关闭",
				);
			} catch (error) {
				toast.error("更新思考模式失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[selectedConfigModel, update],
	);

	const handleSelectThinkingEffort = useCallback(
		async (effort: string) => {
			if (!selectedConfigModel?.supportEfforts?.includes(effort)) return;
			try {
				const resp = await update({ thinkingEffort: effort });
				notifyGlobalConfigApplied(resp, `思考档位已切换为 ${effort}`);
			} catch (error) {
				toast.error("更新思考档位失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[selectedConfigModel, update],
	);

	const send = useCallback(
		async (textOverride?: string) => {
			const text = (textOverride ?? draft).trim();
			if (!text || creating) return;

			const dir = workDir.trim();
			if (!dir) {
				toast.error("请先选择工作目录");
				return;
			}

			const slashDecision = classifySlashDispatch(text, PRE_SESSION_SLASH_COMMANDS);
			if (slashDecision.kind === "local") {
				if (slashDecision.name === "help") {
					if (textOverride === undefined) setDraft("");
					setCommandResult({
						command: "help",
						content: formatDesktopHelpReport(PRE_SESSION_SLASH_COMMANDS),
						loading: false,
					});
					return;
				}
				toast.message("请先发送消息创建会话", {
					description:
						slashDecision.name === "swarm"
							? "Swarm 模式可在进入会话后通过状态栏切换"
							: `/${slashDecision.name} 需要在会话中使用`,
				});
				return;
			}
			if (slashDecision.kind === "blocked") {
				toast.message(slashDecision.message);
				return;
			}

			setCreating(true);
			if (textOverride === undefined) setDraft("");
			try {
				await onSendFirstMessage(dir, text);
			} catch {
				if (textOverride === undefined) setDraft(text);
			} finally {
				setCreating(false);
			}
		},
		[creating, draft, onSendFirstMessage, workDir],
	);

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col px-4 pt-10 sm:px-6">
				<div className="mx-auto w-full max-w-[44rem]">
					<p className="text-center font-sans text-[12px] text-muted">
						给 Kimi 布置一个任务
					</p>
				</div>
			</div>
			<div className="shrink-0 px-4 pb-6 sm:px-6">
				<div className="mx-auto max-w-[44rem]">
					{commandResult && (
						<CommandResultPanel
							result={commandResult}
							onClose={() => setCommandResult(null)}
						/>
					)}
					<div className="mb-2 flex justify-start">
						<WorkDirPicker
							workDir={workDir}
							onWorkDirChange={onWorkDirChange}
							recentDirs={recentDirs}
							disabled={creating}
						/>
					</div>
					<Composer
						sessionId={mentionSessionKey}
						draft={draft}
						onDraftChange={setDraft}
						onSend={(text) => void send(text)}
						onCancel={() => {}}
						busy={creating}
						canCancel={false}
						sendDisabled={creating}
						planMode={false}
						slashCommands={PRE_SESSION_SLASH_COMMANDS}
						queue={[]}
						onRemoveQueued={() => {}}
						onClearQueue={() => {}}
						onUploadFile={async () => {
							toast.message("请先发送消息创建会话");
							throw new Error("No session");
						}}
						onOpenContext={() => {
							toast.message("请先发送消息创建会话");
						}}
						listDirectory={workDir.trim() ? listDirectory : undefined}
						models={models}
						selectedModel={selectedModel || "默认模型"}
						thinkingEnabled={Boolean(config?.defaultThinking)}
						thinkingEffort={config?.thinkingEffort ?? ""}
						modelControlsDisabled={!config}
						modelUpdating={isUpdating}
						onSelectModel={(name) => void handleSelectModel(name)}
						onToggleThinking={(enabled) => void handleToggleThinking(enabled)}
						onSelectThinkingEffort={(effort) => void handleSelectThinkingEffort(effort)}
						onManageConfig={onManageConfig}
					/>
				</div>
			</div>
		</div>
	);
}
