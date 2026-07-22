import { toast } from "sonner";
import type { UpdateGlobalConfigResponse } from "@/lib/api/models";

/** Toast success + ACP restart / busy-skip side effects for global config writes. */
export function notifyGlobalConfigApplied(
	resp: UpdateGlobalConfigResponse,
	successMessage: string,
): void {
	toast.success(successMessage, {
		description: "已写入全局默认；空闲会话将重启以应用。",
	});
	if (resp.skippedBusySessionIds?.length) {
		toast.message("部分忙碌会话已跳过重启", {
			description: "新配置将在这些会话空闲后生效。",
		});
	}
}
