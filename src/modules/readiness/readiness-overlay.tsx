import { Check, Download, RefreshCw, Settings, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { RuntimeReadiness } from "@/lib/tauri-api";
import { isRuntimeConfigIncomplete } from "@/lib/runtime-readiness";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

const SLOW_CHECK_HINT_MS = 8_000;

export function ReadinessOverlay({
	checking,
	readiness,
	error,
	onRetry,
	onContinue,
	onOpenDownload,
	onOpenSettings,
}: {
	checking: boolean;
	readiness: RuntimeReadiness | null;
	error: string | null;
	onRetry: () => void;
	onContinue: () => void;
	onOpenDownload: () => void;
	onOpenSettings: () => void;
}) {
	const [showSlowHint, setShowSlowHint] = useState(false);
	const configIncomplete = isRuntimeConfigIncomplete(readiness);

	useEffect(() => {
		if (!checking) {
			setShowSlowHint(false);
			return;
		}
		const timer = window.setTimeout(() => setShowSlowHint(true), SLOW_CHECK_HINT_MS);
		return () => window.clearTimeout(timer);
	}, [checking]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
			<div className="flex w-full max-w-md flex-col items-center gap-4 px-6">
				<div className="flex size-11 items-center justify-center rounded-r2 bg-bright font-mono text-[18px] font-semibold text-background">
					K
				</div>
				<h1 className="text-[15px] font-semibold">准备 Kimi Code 运行时</h1>

				{checking ? (
					<div className="flex flex-col items-center gap-2">
						<div className="flex items-center gap-2 font-mono text-[12px] text-muted">
							<span className="size-3 animate-spin rounded-full border border-muted border-t-transparent" />
							正在检查运行环境…
						</div>
						{showSlowHint && (
							<>
								<p className="max-w-sm text-center text-[12px] text-muted">
									检查时间较长。若正在使用 VPN，可能额外增加延迟；也可以先继续，稍后再重试。
								</p>
								<Button variant="ghost" onClick={onContinue}>
									仍要继续
								</Button>
							</>
						)}
					</div>
				) : error ? (
					<>
						<p className="text-center font-mono text-[12px] text-danger">{error}</p>
						<p className="max-w-sm text-center text-[11px] text-muted">
							若使用 VPN 或网络不稳定，请确认连通后再重试。
						</p>
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
						{configIncomplete ? (
							<>
								<div className="flex flex-col gap-1.5 text-center">
									<p className="text-[12px] font-medium text-danger">需要完成 Kimi Code 配置</p>
									<p className="text-[11px] text-muted">
										{readiness.config.error
											? "配置文件无法读取或解析。请在设置的 Providers 中修正配置后重试。"
											: !readiness.config.exists
												? "尚未找到配置文件。请在设置的 Providers 中添加 Provider、模型和凭据来源。"
												: "配置尚未完成。请在设置的 Providers 中完成 Provider、模型和凭据来源。"}
									</p>
									{readiness.config.error && (
										<p className="font-mono text-[10.5px] text-danger">
											{readiness.config.error}
										</p>
									)}
								</div>
								<div className="flex gap-2">
									<Button variant="primary" onClick={onOpenSettings}>
										<Settings size={12} strokeWidth={1.5} />
										打开配置设置
									</Button>
									{!readiness.externalCli.available && (
										<Button variant="ghost" onClick={onOpenDownload}>
											<Download size={12} strokeWidth={1.5} />
											前往下载
										</Button>
									)}
									<Button variant="ghost" onClick={onRetry}>
										<RefreshCw size={12} strokeWidth={1.5} />
										重试
									</Button>
								</div>
							</>
						) : (
							<>
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
						)}
					</>
				) : null}
			</div>
		</div>
	);
}
