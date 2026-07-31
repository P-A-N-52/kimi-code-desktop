import { toast } from "sonner";

type ConfigApplySideEffects = {
	skippedBusySessionIds?: string[] | null;
};

/** Toast success + ACP restart / busy-skip side effects for global config writes. */
export function notifyGlobalConfigApplied(
	resp: ConfigApplySideEffects,
	successMessage: string,
): void {
	toast.success(successMessage, {
		description: "已写入全局默认；空闲会话将重启以应用。",
	});
	notifyBusySessionsSkipped(resp);
}

/** Toast after a raw config.toml / mcp.json save that also restarts idle sessions. */
export function notifyTextConfigSaved(
	resp: ConfigApplySideEffects,
	successMessage: string,
): void {
	toast.success(successMessage, {
		description: "已写入配置文件；空闲会话将重启以应用。",
	});
	notifyBusySessionsSkipped(resp);
}

function notifyBusySessionsSkipped(resp: ConfigApplySideEffects): void {
	if (resp.skippedBusySessionIds?.length) {
		toast.message("部分忙碌会话已跳过重启", {
			description: "新配置将在这些会话空闲后生效。",
		});
	}
}

/** Secondary model writes global [secondary_model]; not a session model switch. */
export function notifySecondaryModelApplied(
	resp: ConfigApplySideEffects,
	successMessage: string,
): void {
	toast.success(successMessage, {
		description:
			"已写入全局 [secondary_model]；新派生的子代理将使用此模型。主会话 model 不变；空闲会话重连后生效，忙碌会话需稍后重连。",
	});
	notifyBusySessionsSkipped(resp);
}
