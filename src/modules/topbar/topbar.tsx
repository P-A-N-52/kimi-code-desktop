import { ChevronDown, PanelRight, Share2 } from "lucide-react";
import { IconButton } from "@/ui/icon-button";

export function Topbar({
	title,
	shortId,
	panelOpen,
	onTogglePanel,
}: {
	title: string;
	shortId?: string;
	panelOpen: boolean;
	onTogglePanel: () => void;
}) {
	return (
		<>
			<button
				type="button"
				className="flex items-center gap-1.5 rounded-r1 px-2.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-hover"
			>
				{title || "Kimi Code"}
				{shortId && (
					<span className="font-mono text-[10.5px] text-faint">#{shortId}</span>
				)}
				<ChevronDown size={12} strokeWidth={1.5} className="text-faint" />
			</button>
			<div className="absolute right-2.5 flex gap-0.5">
				<IconButton label="分享">
					<Share2 size={15} strokeWidth={1.5} />
				</IconButton>
				<IconButton label="工作区面板" active={panelOpen} onClick={onTogglePanel}>
					<PanelRight size={15} strokeWidth={1.5} />
				</IconButton>
			</div>
		</>
	);
}
