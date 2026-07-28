import { Check, Download, RefreshCw, TriangleAlert } from "lucide-react";
import type { RuntimeReadiness } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

export function ReadinessOverlay({
	checking,
	readiness,
	error,
	onRetry,
	onContinue,
	onOpenDownload,
}: {
	checking: boolean;
	readiness: RuntimeReadiness | null;
	error: string | null;
	onRetry: () => void;
	onContinue: () => void;
	onOpenDownload: () => void;
}) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
			<div className="flex w-full max-w-md flex-col items-center gap-4 px-6">
				<div className="flex size-11 items-center justify-center rounded-r2 bg-bright font-mono text-[18px] font-semibold text-background">
					K
				</div>
				<h1 className="text-[15px] font-semibold">准备 Kimi Code 运行时</h1>

				{checking ? (
					<div className="flex items-center gap-2 font-mono text-[12px] text-muted">
						<span className="size-3 animate-spin rounded-full border border-muted border-t-transparent" />
						正在检查运行环境…
					</div>
				) : error ? (
					<>
						<p className="text-center font-mono text-[12px] text-danger">{error}</p>
						<div className="flex gap-2">
							<Button variant="primary" onClick={onRetry}>
								<RefreshCw size={12} strokeWidth={1.5} />
								重试
							</Button>
							<Button variant="ghost" onClick={onContinue}>
								仍要继续
							</Button>
						</div>
					</>
				) : readiness ? (
					<>
						<div className="flex w-full flex-col gap-1.5">
							{readiness.checks.map((check) => (
								<div
									key={check.id}
									className="flex items-center gap-2.5 rounded-r2 border border-line bg-elevated px-3 py-2"
								>
									<span
										className={cn(
											"flex size-[18px] shrink-0 items-center justify-center rounded-full",
											check.status === "ok" && "text-success",
											check.status === "warning" && "text-warn",
											check.status === "error" && "text-danger",
										)}
									>
										{check.status === "ok" ? (
											<Check size={11} strokeWidth={2} />
										) : (
											<TriangleAlert size={11} strokeWidth={1.5} />
										)}
									</span>
									<span className="text-[12.5px] text-foreground">{check.label}</span>
									<span className="ml-auto truncate font-mono text-[10.5px] text-faint">
										{check.detail}
									</span>
								</div>
							))}
						</div>
						{readiness.issues.length > 0 && (
							<p className="text-center text-[12px] text-danger">
								{readiness.issues[0]}
							</p>
						)}
						<div className="flex gap-2">
							{!readiness.externalCli.available && (
								<Button variant="primary" onClick={onOpenDownload}>
									<Download size={12} strokeWidth={1.5} />
									前往下载
								</Button>
							)}
							<Button variant="ghost" onClick={onRetry}>
								<RefreshCw size={12} strokeWidth={1.5} />
								重试
							</Button>
							<Button variant="ghost" onClick={onContinue}>
								仍要继续
							</Button>
						</div>
					</>
				) : null}
			</div>
		</div>
	);
}
