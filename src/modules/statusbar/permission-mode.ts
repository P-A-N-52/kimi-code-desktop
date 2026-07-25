import type { PermissionMode } from "@/hooks/wireTypes";

export type { PermissionMode } from "@/hooks/wireTypes";

/** Draft modes chosen on the new-session screen before ACP connects. */
export type SessionModeDraft = {
	permissionMode: PermissionMode;
	planMode: boolean;
	swarmMode: boolean;
};

export function parsePermissionMode(value: string | null | undefined): PermissionMode {
	if (value === "yolo" || value === "auto" || value === "manual") return value;
	if (value === "ask") return "manual";
	return "manual";
}

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
