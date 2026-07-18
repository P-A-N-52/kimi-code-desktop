import { Check, ChevronDown, ClipboardList, Flame, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TokenUsage } from "@/hooks/wireTypes";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/ui/status-pill";
import { ContextRing } from "./context-ring";
import { type PermissionMode, usePermissionMode } from "./permission-mode";

const MODES: {
	key: PermissionMode;
	label: string;
	desc: string;
	icon: typeof ShieldCheck;
}[] = [
	{ key: "ask", label: "批准", desc: "每个操作执行前逐一确认", icon: ShieldCheck },
	{ key: "auto", label: "自动", desc: "安全操作自动批准，危险操作仍询问", icon: Zap },
	{ key: "yolo", label: "全放", desc: "全部自动批准，不再询问，风险自负", icon: Flame },
];

export function usePermissionModeState(sessionId: string | null) {
	return usePermissionMode(sessionId);
}

export function StatusStrip({
	sessionId,
	permissionMode,
	onPermissionModeChange,
	planMode,
	swarmMode,
	onPlanModeChange,
	onSwarmModeChange,
	contextUsage,
	tokenUsage,
}: {
	sessionId: string | null;
	permissionMode: PermissionMode;
	onPermissionModeChange: (mode: PermissionMode) => void;
	planMode: boolean;
	swarmMode: boolean;
	onPlanModeChange: (enabled: boolean) => void;
	onSwarmModeChange: (enabled: boolean) => void;
	contextUsage: number;
	tokenUsage: TokenUsage | null;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const current = MODES.find((m) => m.key === permissionMode) ?? MODES[0];

	useEffect(() => {
		if (!menuOpen) return;
		const close = (e: MouseEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [menuOpen]);

	return (
		<div className="relative mt-2 flex items-center gap-1 px-0.5">
			<div ref={menuRef} className="relative">
				<StatusPill
					tone={permissionMode === "auto" ? "amber" : permissionMode === "yolo" ? "red" : "neutral"}
					onClick={() => setMenuOpen((v) => !v)}
				>
					<current.icon size={12} strokeWidth={1.5} />
					{current.label}
					<ChevronDown size={9} strokeWidth={1.5} />
				</StatusPill>
				{menuOpen && (
					<div className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[268px] rounded-r3 border border-line-strong bg-elevated p-1 shadow-pop">
						{MODES.map((m) => (
							<button
								key={m.key}
								type="button"
								onClick={() => {
									onPermissionModeChange(m.key);
									setMenuOpen(false);
								}}
								className={cn(
									"flex w-full items-center gap-2.5 rounded-r2 px-2.5 py-2 text-left transition-colors",
									m.key === permissionMode ? "bg-active" : "hover:bg-hover",
								)}
							>
								<m.icon
									size={13}
									strokeWidth={1.5}
									className={cn(
										"shrink-0",
										m.key === "auto" && "text-warn",
										m.key === "yolo" && "text-danger",
										m.key === "ask" && "text-muted",
									)}
								/>
								<span className="min-w-0">
									<span className="block text-[12.5px] font-medium text-foreground">
										{m.label}
									</span>
									<span className="block text-[11px] text-muted">{m.desc}</span>
								</span>
								{m.key === permissionMode && (
									<Check size={13} strokeWidth={2} className="ml-auto shrink-0 text-bright" />
								)}
							</button>
						))}
					</div>
				)}
			</div>
			<StatusPill on={swarmMode} onClick={() => onSwarmModeChange(!swarmMode)}>
				<Boxes size={12} strokeWidth={1.5} />
				swarm
			</StatusPill>
			<StatusPill on={planMode} onClick={() => onPlanModeChange(!planMode)}>
				<ClipboardList size={12} strokeWidth={1.5} />
				plan
			</StatusPill>
			<div className="flex-1" />
			<ContextRing usage={contextUsage} tokenUsage={tokenUsage} />
			<span className="hidden font-mono text-[10.5px] text-faint sm:inline">
				Enter 发送 · ⇧⏎ 换行
			</span>
		</div>
	);
}

function Boxes(props: { size?: number; strokeWidth?: number; className?: string }) {
	return (
		<svg
			width={props.size ?? 12}
			height={props.size ?? 12}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={props.strokeWidth ?? 1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={props.className}
		>
			<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z" />
			<path d="m7 16.5-4.74-2.85" />
			<path d="m7 16.5 5-3" />
			<path d="M7 16.5v5.17" />
			<path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z" />
			<path d="m17 16.5-5-3" />
			<path d="m17 16.5 4.74-2.85" />
			<path d="M17 16.5v5.17" />
			<path d="M7.97 4.42A2 2 0 0 0 7 6.13v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L17 11.5v-5.5l-5-3-4.03 1.42Z" />
			<path d="m12 8-4.74-2.85" />
			<path d="m12 8 5-3" />
			<path d="M12 8v5.17" />
		</svg>
	);
}
