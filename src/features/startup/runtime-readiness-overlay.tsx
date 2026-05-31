import {
	AlertTriangle,
	CheckCircle2,
	ExternalLink,
	LoaderCircle,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getRuntimeReadinessKind } from "@/lib/runtime-readiness";
import type { RuntimeReadiness, RuntimeReadinessCheck } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";

type RuntimeReadinessOverlayProps = {
	checking: boolean;
	readiness: RuntimeReadiness | null;
	error: string | null;
	onRetry: () => void;
	onContinue: () => void;
	onOpenDownload: () => void;
};

export function RuntimeReadinessOverlay({
	checking,
	readiness,
	error,
	onRetry,
	onContinue,
	onOpenDownload,
}: RuntimeReadinessOverlayProps) {
	const kind = readiness ? getRuntimeReadinessKind(readiness) : "blocked";
	const blocking = kind === "blocked" || Boolean(error);
	const title = checking
		? "Checking Kimi Code Desktop runtime"
		: blocking
			? "Setup needed before Kimi Code Desktop can be used"
			: "Kimi Code Desktop needs attention";
	const body = checking
		? "Verifying the installed sidecar, bundled CLI runtime, config, credentials, and external login helper."
		: blocking
			? "The app can open, but chat and session features are likely unavailable until the items below are fixed."
			: "The app can continue. Review the warning below so the installed package does not fail later without context.";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background px-4 py-6">
			<div className="grid w-full max-w-2xl gap-5 rounded-lg border bg-background p-5 shadow-lg">
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border",
							checking
								? "text-info"
								: blocking
									? "text-destructive"
									: "text-warning",
						)}
					>
						{checking ? (
							<LoaderCircle className="size-5 animate-spin" />
						) : blocking ? (
							<AlertTriangle className="size-5" />
						) : (
							<AlertTriangle className="size-5" />
						)}
					</div>
					<div className="min-w-0 space-y-1">
						<h1 className="text-lg font-semibold leading-tight">{title}</h1>
						<p className="max-w-xl text-sm leading-6 text-muted-foreground">
							{body}
						</p>
					</div>
				</div>

				<div className="max-h-[46vh] overflow-auto rounded-md border">
					{checking ? (
						<div className="flex min-h-32 items-center justify-center px-4 text-sm text-muted-foreground">
							Checking installed runtime...
						</div>
					) : (
						<div className="divide-y">
							{error ? (
								<ReadinessRow
									check={{
										id: "readiness",
										label: "Startup readiness check",
										status: "error",
										detail: error,
									}}
								/>
							) : null}
							{readiness?.checks.map((check) => (
								<ReadinessRow key={check.id} check={check} />
							))}
						</div>
					)}
				</div>

				{readiness?.config.path ? (
					<p className="truncate rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
						{readiness.config.path}
					</p>
				) : null}

				<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<Button
						type="button"
						variant="outline"
						onClick={onRetry}
						disabled={checking}
					>
						<RefreshCw className={cn("size-4", checking && "animate-spin")} />
						Retry
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={onOpenDownload}
						disabled={checking}
					>
						<ExternalLink className="size-4" />
						Open legacy kimi-cli
					</Button>
					{!checking && (
						<Button type="button" onClick={onContinue}>
							{blocking ? "Open Anyway" : "Continue"}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

function ReadinessRow({ check }: { check: RuntimeReadinessCheck }) {
	return (
		<div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 px-4 py-3">
			<div
				className={cn(
					"mt-0.5",
					check.status === "ok"
						? "text-success"
						: check.status === "warning"
							? "text-warning"
							: "text-destructive",
				)}
			>
				{check.status === "ok" ? (
					<CheckCircle2 className="size-4" />
				) : check.status === "warning" ? (
					<AlertTriangle className="size-4" />
				) : (
					<XCircle className="size-4" />
				)}
			</div>
			<div className="min-w-0">
				<div className="text-sm font-medium">{check.label}</div>
				<div className="break-words text-xs leading-5 text-muted-foreground">
					{check.detail}
				</div>
			</div>
		</div>
	);
}
