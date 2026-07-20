import type { PermissionMode } from "@/hooks/wireTypes";

export type { PermissionMode } from "@/hooks/wireTypes";

/**
 * Client-side auto-approve for approval cards that still reach the UI.
 * Source of truth for the active mode is Kimi Code itself:
 * - session history: `permission.set_mode` in wire.jsonl
 * - defaults: `default_permission_mode` in config.toml
 * Desktop only mirrors that mode via ACP `session/set_mode`.
 *
 * Policy (matches Kimi Code CLI):
 * - manual: never auto-approve
 * - yolo: auto-approve regular tool calls (file/command/etc.)
 * - auto: fully unattended — approve everything
 */
export function shouldAutoApprove(
	mode: PermissionMode,
	_toolTitle?: string,
	_toolKind?: string | null,
): boolean {
	return mode === "yolo" || mode === "auto";
}
