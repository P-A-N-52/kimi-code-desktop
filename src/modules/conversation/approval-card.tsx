import { TriangleAlert } from "lucide-react";
import type { LiveMessage } from "@/hooks/types";
import type { ApprovalResponseDecision } from "@/hooks/wireTypes";
import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import { findDiffDisplay } from "./diff-display";
import { DiffView } from "./diff-view";

type Approval = NonNullable<NonNullable<LiveMessage["toolCall"]>["approval"]>;
type ToolCall = NonNullable<LiveMessage["toolCall"]>;

export function ApprovalCard({
	approval,
	display,
	onRespond,
}: {
	approval: Approval;
	display?: ToolCall["display"];
	onRespond: (requestId: string, decision: ApprovalResponseDecision) => void;
}) {
	const resolved = approval.resolved || approval.submitted;
	const diff = findDiffDisplay(display);
	const command =
		approval.action === "Bash" || approval.description.startsWith("$")
			? approval.description
			: null;

	return (
		<div className="my-3 overflow-hidden rounded-r2 border border-warn/30 bg-warn-bg">
			<div className="flex items-center gap-2 px-3 py-2.5">
				<TriangleAlert size={13} strokeWidth={1.5} className="shrink-0 text-warn" />
				<span className="text-[13px] font-medium text-foreground">
					Kimi 请求执行操作
				</span>
				<span className="ml-auto rounded border border-warn/35 px-1.5 py-px font-mono text-[10px] tracking-[0.08em] text-warn">
					APPROVAL
				</span>
			</div>
			<div className="px-3 pb-2.5 text-[12.5px] text-muted">
				{approval.description || approval.action}
			</div>
			{diff && (
				<div className="mx-3 mb-2.5 overflow-hidden rounded-r1 border border-line">
					<DiffView data={diff} maxLines={8} />
				</div>
			)}
			{!diff && command && (
				<div className="mx-3 mb-2.5 rounded-r1 border border-line bg-black/20 px-2.5 py-2 font-mono text-[11.5px] text-muted dark:bg-black/20">
					{command}
				</div>
			)}
			<div className="flex items-center gap-2 px-3 pb-3">
				{resolved ? (
					<span className="font-mono text-[11px] text-muted">
						{approval.approved === false ? "已拒绝" : "已批准"}
					</span>
				) : (
					<>
						<Button
							variant="primary"
							onClick={() => onRespond(approval.id, "approve")}
						>
							允许<Kbd>⏎</Kbd>
						</Button>
						<Button
							variant="ghost"
							onClick={() => onRespond(approval.id, "reject")}
						>
							拒绝<Kbd>Esc</Kbd>
						</Button>
						<Button
							variant="ghost"
							onClick={() => onRespond(approval.id, "approve_for_session")}
						>
							本会话不再询问
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
