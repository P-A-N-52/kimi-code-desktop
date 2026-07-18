import { useEffect, useState } from "react";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { useTheme } from "@/hooks/use-theme";
import { openKimiCodeWebsite } from "@/lib/kimi-code-link";
import { desktopVersion, resolveKimiCliVersion } from "@/lib/version";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Switch } from "@/ui/switch";

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="mb-5">
			<div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
				{title}
			</div>
			{children}
		</div>
	);
}

export function SettingsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { theme, setTheme } = useTheme();
	const { config, isLoading, isUpdating, error, update } = useGlobalConfig({
		enabled: open,
	});
	const [cliVersion, setCliVersion] = useState("…");

	useEffect(() => {
		if (open) {
			resolveKimiCliVersion().then(setCliVersion).catch(() => setCliVersion("dev"));
		}
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[560px]">
				<DialogTitle>设置</DialogTitle>
				<div className="mt-4">
					<Section title="外观">
						<div className="flex gap-2">
							{(["dark", "light"] as const).map((t) => (
								<button
									key={t}
									type="button"
									onClick={() => setTheme(t)}
									className={cn(
										"rounded-r2 border px-3 py-1.5 text-[12.5px] transition-colors",
										theme === t
											? "border-line-strong bg-active text-foreground"
											: "border-line text-muted hover:bg-hover hover:text-foreground",
									)}
								>
									{t === "dark" ? "深色" : "浅色"}
								</button>
							))}
						</div>
					</Section>

					<Section title="全局配置">
						{isLoading ? (
							<p className="font-mono text-[11px] text-faint">加载中…</p>
						) : config ? (
							<div className="flex flex-col gap-3">
								<label className="flex flex-col gap-1.5">
									<span className="text-[12.5px] text-muted">默认模型</span>
									<select
										value={config.defaultModel}
										onChange={(e) =>
											void update({ defaultModel: e.target.value })
										}
										className="h-8 rounded-r1 border border-line bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-line-strong"
									>
										{config.models.map((m) => (
											<option key={m.name} value={m.name}>
												{m.name}（{m.provider}）
											</option>
										))}
									</select>
								</label>
								<label className="flex items-center justify-between">
									<span className="text-[12.5px] text-muted">
										默认开启 Plan 模式
									</span>
									<Switch
										checked={config.defaultPlanMode}
										onCheckedChange={(v) =>
											void update({ defaultPlanMode: v })
										}
									/>
								</label>
								<label className="flex items-center justify-between">
									<span className="text-[12.5px] text-muted">
										默认开启 Thinking
									</span>
									<Switch
										checked={config.defaultThinking}
										onCheckedChange={(v) =>
											void update({ defaultThinking: v })
										}
									/>
								</label>
								{isUpdating && (
									<p className="font-mono text-[10.5px] text-faint">保存中…</p>
								)}
								{error && (
									<p className="font-mono text-[10.5px] text-danger">{error}</p>
								)}
							</div>
						) : (
							<p className="font-mono text-[11px] text-faint">无法读取配置</p>
						)}
					</Section>

					<Section title="关于">
						<div className="flex flex-col gap-1 font-mono text-[11.5px] text-muted">
							<div className="flex justify-between">
								<span>桌面版</span>
								<span className="tabular-nums">{desktopVersion}</span>
							</div>
							<div className="flex justify-between">
								<span>Kimi Code CLI</span>
								<span className="tabular-nums">{cliVersion}</span>
							</div>
						</div>
						<Button
							variant="ghost"
							className="mt-2.5"
							onClick={() => void openKimiCodeWebsite()}
						>
							访问 Kimi Code 官网
						</Button>
					</Section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
