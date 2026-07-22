import { Check, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigModel } from "@/lib/api/models";
import {
	findConfigModel,
	modelForcesThinking,
	modelHasThinkingCapability,
} from "@/lib/model-capabilities";
import { cn } from "@/lib/utils";
import { Switch } from "@/ui/switch";

export function ModelPicker({
	models,
	selectedModel,
	thinkingEnabled,
	disabled = false,
	updating = false,
	onSelectModel,
	onToggleThinking,
	onManageConfig,
}: {
	models: ConfigModel[];
	selectedModel: string;
	thinkingEnabled: boolean;
	disabled?: boolean;
	updating?: boolean;
	onSelectModel: (name: string) => void;
	onToggleThinking: (enabled: boolean) => void;
	/** Secondary path: open Settings → Config to edit models / capabilities. */
	onManageConfig?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const selected = useMemo(
		() => findConfigModel(models, selectedModel),
		[models, selectedModel],
	);
	const supportsThinking = modelHasThinkingCapability(selected);
	const forcesThinking = modelForcesThinking(selected);
	const label = selectedModel || "选择模型";

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const thinkingChecked = forcesThinking || thinkingEnabled;

	return (
		<div ref={rootRef} className="relative ml-auto">
			<button
				type="button"
				aria-label={`当前模型 ${label}`}
				aria-expanded={open}
				aria-haspopup="listbox"
				disabled={disabled}
				onClick={() => setOpen((value) => !value)}
				className="flex h-7 max-w-44 items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
			>
				<span className="truncate">{label}</span>
				<ChevronDown size={10} strokeWidth={1.5} className="shrink-0" />
			</button>
			{open && (
				<div className="absolute bottom-[calc(100%+8px)] right-0 z-50 w-[280px] rounded-r3 border border-line-strong bg-elevated p-1 shadow-pop">
					<div className="px-2.5 pb-1 pt-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
						选择模型
					</div>
					<div
						role="listbox"
						aria-label="模型列表"
						className="max-h-56 overflow-y-auto"
					>
						{models.length === 0 ? (
							<p className="px-2.5 py-3 text-center text-[11px] text-faint">
								暂无可用模型
							</p>
						) : (
							models.map((model) => {
								const active = model.name === selectedModel;
								return (
									<button
										key={model.name}
										type="button"
										role="option"
										aria-selected={active}
										disabled={updating}
										onClick={() => {
											if (!active) onSelectModel(model.name);
											setOpen(false);
										}}
										className={cn(
											"flex w-full items-start gap-2 rounded-r2 px-2.5 py-2 text-left transition-colors",
											active ? "bg-active" : "hover:bg-hover",
											updating && "opacity-60",
										)}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-[12.5px] font-medium text-foreground">
												{model.name}
											</span>
											<span className="block truncate font-mono text-[10.5px] text-muted">
												{model.provider}
												{model.model && model.model !== model.name
													? ` · ${model.model}`
													: ""}
											</span>
										</span>
										{active && (
											<Check
												size={13}
												strokeWidth={2}
												className="mt-0.5 shrink-0 text-bright"
											/>
										)}
									</button>
								);
							})
						)}
					</div>
					{supportsThinking && (
						<div className="mt-1 border-t border-line px-2.5 py-2.5">
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<p className="text-[12.5px] font-medium text-foreground">
										Thinking
									</p>
									<p className="text-[10.5px] text-muted">
										{forcesThinking
											? "由模型强制启用"
											: "为此模型开启思考过程"}
									</p>
								</div>
								<Switch
									checked={thinkingChecked}
									disabled={forcesThinking || updating || disabled}
									aria-label={
										forcesThinking
											? "思考模式由模型强制启用"
											: "切换思考模式"
									}
									onCheckedChange={(value) => {
										if (!forcesThinking) onToggleThinking(value);
									}}
								/>
							</div>
						</div>
					)}
					{onManageConfig && (
						<div
							className={cn(
								"border-t border-line px-1 py-1",
								!supportsThinking && "mt-1",
							)}
						>
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									onManageConfig();
								}}
								className="w-full rounded-r2 px-2.5 py-2 text-left text-[11px] text-muted transition-colors hover:bg-hover hover:text-foreground"
							>
								在设置中管理配置…
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
