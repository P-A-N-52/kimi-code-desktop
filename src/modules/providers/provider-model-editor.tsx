import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { notifyTextConfigSaved } from "@/lib/config-update-toast";
import { getConfigTomlFile, updateConfigTomlFile } from "@/lib/settings-api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { useConfirm } from "@/ui/confirm-dialog";
import {
	addModel,
	addProvider,
	getProviderModelTomlCompatibilityError,
	isBuiltInKimiProvider,
	MODEL_CAPABILITY_OPTIONS,
	MODEL_PROTOCOL_OPTIONS,
	PROVIDER_TYPE_OPTIONS,
	readProviderModelConfig,
	removeModel,
	removeProvider,
	renameModel,
	renameProvider,
	setDefaultModel,
	setModelCapabilities,
	setModelMaxContextSize,
	setModelOptionalStringValue,
	setModelProtocol,
	setModelStringValue,
	setModelSupportEfforts,
	setProviderRawValue,
	setProviderStringValue,
	type TomlMutationResult,
	validateProviderModelToml,
} from "./provider-model-toml";

type ProviderModelEditorProps = {
	enabled: boolean;
	onDirtyChange: (dirty: boolean) => void;
};

function Field({
	label,
	description,
	children,
}: {
	label: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<span className="text-[11.5px] text-muted">{label}</span>
			{children}
			{description ? <span className="text-[10px] leading-relaxed text-faint">{description}</span> : null}
		</div>
	);
}

function EmptyState({ children }: { children: ReactNode }) {
	return <p className="py-5 text-center font-mono text-[10.5px] text-faint">{children}</p>;
}

function inputClassName(extra = ""): string {
	return cn(
		"h-8 w-full rounded-r1 border border-line bg-background px-2 font-mono text-[11.5px] text-foreground outline-none placeholder:text-faint focus:border-line-strong disabled:cursor-not-allowed disabled:opacity-60",
		extra,
	);
}

function parseEfforts(value: string): string[] {
	return [...new Set(value.split(",").map((effort) => effort.trim()).filter(Boolean))];
}

export function ProviderModelEditor({ enabled, onDirtyChange }: ProviderModelEditorProps) {
	const [content, setContent] = useState("");
	const contentRef = useRef("");
	const [savedContent, setSavedContent] = useState("");
	const [configPath, setConfigPath] = useState("");
	const [selectedProviderName, setSelectedProviderName] = useState("");
	const [selectedModelName, setSelectedModelName] = useState("");
	const [providerNameDraft, setProviderNameDraft] = useState("");
	const [modelNameDraft, setModelNameDraft] = useState("");
	const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [loadAttempt, setLoadAttempt] = useState(0);
		const loadAttemptRef = useRef(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirm = useConfirm();
	const onDirtyChangeRef = useRef(onDirtyChange);

	useEffect(() => {
		onDirtyChangeRef.current = onDirtyChange;
	}, [onDirtyChange]);

	useEffect(() => {
		onDirtyChangeRef.current(loadState === "ready" && content !== savedContent);
	}, [content, loadState, savedContent]);

	useEffect(
		() => () => {
			onDirtyChangeRef.current(false);
		},
		[],
	);

	useEffect(() => {
		if (!enabled) {
			setLoadState("idle");
			return;
		}
		let cancelled = false;
			const requestAttempt = loadAttempt;
		setLoadState("loading");
		setError(null);
		void getConfigTomlFile()
			.then((file) => {
				if (cancelled || requestAttempt !== loadAttemptRef.current) {
					return;
				}
				const compatibilityError = getProviderModelTomlCompatibilityError(file.content);
				if (compatibilityError) {
					contentRef.current = "";
					setContent("");
					setSavedContent("");
					setConfigPath(file.path);
					setSelectedProviderName("");
					setSelectedModelName("");
					setError(compatibilityError);
					setLoadState("error");
					return;
				}
				const config = readProviderModelConfig(file.content);
				contentRef.current = file.content;
				setContent(file.content);
				setSavedContent(file.content);
				setConfigPath(file.path);
				setSelectedProviderName(config.providers[0]?.name ?? "");
				setSelectedModelName(
					config.models.find((model) => model.name === config.defaultModel)?.name ??
						config.models[0]?.name ??
						"",
				);
				setLoadState("ready");
			})
			.catch((loadError: unknown) => {
				if (!cancelled && requestAttempt === loadAttemptRef.current) {
					contentRef.current = "";
					setContent("");
					setSavedContent("");
					setConfigPath("");
					setSelectedProviderName("");
					setSelectedModelName("");
					setError(`读取 config.toml 失败：${loadError instanceof Error ? loadError.message : String(loadError)}`);
					setLoadState("error");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, loadAttempt]);

	const config = useMemo(() => readProviderModelConfig(content), [content]);
	const selectedProvider = useMemo(
		() => config.providers.find((provider) => provider.name === selectedProviderName) ?? null,
		[config.providers, selectedProviderName],
	);
	const selectedProviderModels = useMemo(
		() => config.models.filter((model) => model.provider === selectedProviderName),
		[config.models, selectedProviderName],
	);
	const selectedModel = useMemo(
		() => config.models.find((model) => model.name === selectedModelName) ?? null,
		[config.models, selectedModelName],
	);
	const defaultModelName = config.models.some((model) => model.name === config.defaultModel)
		? config.defaultModel
		: "";
	const isReady = loadState === "ready";
	const canEdit = isReady && !saving;
	const selectedProviderIsBuiltIn = selectedProvider ? isBuiltInKimiProvider(selectedProvider) : false;

	useEffect(() => {
		if (config.providers.length === 0) {
			setSelectedProviderName("");
			return;
		}
		if (!config.providers.some((provider) => provider.name === selectedProviderName)) {
			setSelectedProviderName(config.providers[0].name);
		}
	}, [config.providers, selectedProviderName]);

	useEffect(() => {
		setProviderNameDraft(selectedProviderName);
	}, [selectedProviderName]);

	useEffect(() => {
		if (selectedProviderModels.length === 0) {
			setSelectedModelName("");
			return;
		}
		if (!selectedProviderModels.some((model) => model.name === selectedModelName)) {
			setSelectedModelName(
				selectedProviderModels.find((model) => model.name === config.defaultModel)?.name ??
					selectedProviderModels[0].name,
			);
		}
	}, [config.defaultModel, selectedModelName, selectedProviderModels]);

	useEffect(() => {
		setModelNameDraft(selectedModelName);
	}, [selectedModelName]);

	const applyMutation = (result: TomlMutationResult) => {
		if (!canEdit) {
			return false;
		}
		if (result.error) {
			setError(result.error);
			return false;
		}
		setError(null);
		contentRef.current = result.content;
		setContent(result.content);
		if (result.providerName) {
			setSelectedProviderName(result.providerName);
		}
		if (result.modelName) {
			setSelectedModelName(result.modelName);
		} else if (result.fallbackModelName) {
			setSelectedModelName(result.fallbackModelName);
		}
		return true;
	};

	const updateContent = (updater: (previous: string) => TomlMutationResult) =>
		canEdit && applyMutation(updater(contentRef.current));

	const retryLoad = () => {
		if (enabled && loadState !== "loading") {
			const nextAttempt = loadAttemptRef.current + 1;
				loadAttemptRef.current = nextAttempt;
				setLoadAttempt(nextAttempt);
		}
	};

	const commitProviderName = () => {
		if (!canEdit || !selectedProvider || selectedProviderIsBuiltIn) {
			return;
		}
		const result = renameProvider(content, selectedProvider.name, providerNameDraft);
		if (!applyMutation(result)) {
			setProviderNameDraft(selectedProvider.name);
		}
	};

	const commitModelName = () => {
		if (!canEdit || !selectedModel) {
			return;
		}
		const result = renameModel(content, selectedModel.name, modelNameDraft);
		if (!applyMutation(result)) {
			setModelNameDraft(selectedModel.name);
		}
	};

	const handleAddProvider = () => {
		if (canEdit) {
			applyMutation(addProvider(content));
		}
	};

	const handleAddModel = () => {
		if (canEdit) {
			applyMutation(addModel(content, selectedProviderName));
		}
	};

	const handleRemoveProvider = async () => {
		if (!canEdit || !selectedProvider || selectedProviderIsBuiltIn) {
			return;
		}
		const modelCount = config.models.filter((model) => model.provider === selectedProvider.name).length;
		const message =
			modelCount > 0
				? `删除 Provider “${selectedProvider.name}”会同时删除 ${modelCount} 个模型。确定继续吗？`
				: `确定删除 Provider “${selectedProvider.name}”吗？`;
		if (
			!(await confirm({
				message,
				title: "删除 Provider",
				confirmLabel: "删除",
				danger: true,
			}))
		) {
			return;
		}
		applyMutation(removeProvider(contentRef.current, selectedProvider.name));
	};

	const handleRemoveModel = async () => {
		if (!canEdit || !selectedModel) {
			return;
		}
		if (
			!(await confirm({
				message: `确定删除模型 “${selectedModel.name}”吗？`,
				title: "删除模型",
				confirmLabel: "删除",
				danger: true,
			}))
		) {
			return;
		}
		applyMutation(removeModel(contentRef.current, selectedModel.name));
	};

	const handleSave = async () => {
		if (!isReady || saving) {
			return;
		}
		const validationError = validateProviderModelToml(content);
		if (validationError) {
			setError(validationError);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const response = await updateConfigTomlFile(content);
			if (!response.success) {
				throw new Error(response.error || "保存模型配置失败");
			}
			setSavedContent(content);
			notifyTextConfigSaved(response, "模型配置已保存");
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : "保存模型配置失败");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col">
			<div className="mb-3 shrink-0">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h2 className="text-[13px] font-medium text-foreground">编辑模型配置</h2>
						<p className="mt-1 text-[10.5px] leading-relaxed text-faint">
							结构化修改只会写入本地草稿；点保存后才更新 config.toml。
						</p>
					</div>
					<Button variant="ghost" disabled={!canEdit} onClick={handleAddProvider}>
						添加 Provider
					</Button>
				</div>
				<p className="mt-1 truncate font-mono text-[10px] text-faint">{configPath || (loadState === "error" ? "读取失败" : "读取中…")}</p>
			</div>

			{loadState === "idle" || loadState === "loading" ? (
				<EmptyState>加载 config.toml 中…</EmptyState>
				) : loadState === "error" ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3">
						<EmptyState>当前无法安全编辑结构化配置；请转用高级 config.toml 编辑器或重试读取。</EmptyState>
						<Button variant="ghost" onClick={retryLoad}>
							重试读取
						</Button>
					</div>
			) : (
				<fieldset disabled={!canEdit} className="min-h-0 flex-1 overflow-y-auto border-0 p-0 pr-1">
					<div className="grid gap-3 xl:grid-cols-[178px_minmax(0,1fr)]">
						<section className="rounded-r2 border border-line/70 bg-surface/40 p-2.5">
							<div className="mb-2 flex items-center justify-between gap-2">
								<p className="font-mono text-[10px] uppercase tracking-[0.09em] text-faint">
									Providers
								</p>
								<span className="font-mono text-[10px] text-faint">{config.providers.length}</span>
							</div>
							<div className="space-y-1">
								{config.providers.length === 0 ? (
									<EmptyState>尚未添加 Provider</EmptyState>
								) : (
									config.providers.map((provider) => {
										const modelCount = config.models.filter(
											(model) => model.provider === provider.name,
										).length;
										return (
											<button
												key={provider.name}
												type="button"
												onClick={() => setSelectedProviderName(provider.name)}
												className={cn(
													"w-full rounded-r1 border px-2 py-1.5 text-left transition-colors",
													provider.name === selectedProviderName
														? "border-line-strong bg-active text-foreground"
														: "border-line/50 text-muted hover:bg-hover hover:text-foreground",
												)}
											>
												<span className="flex items-center justify-between gap-2">
													<span className="min-w-0 truncate font-mono text-[11px]">{provider.name}</span>
													<span className="font-mono text-[10px] text-faint">{modelCount}</span>
												</span>
												<span className="mt-0.5 block truncate font-mono text-[10px] text-faint">
													{provider.type || "未设置类型"}
												</span>
											</button>
										);
									})
								)}
							</div>
						</section>

						<div className="min-w-0 space-y-3">
							<section className="rounded-r2 border border-line/70 bg-surface/40 p-3">
								<div className="mb-3 flex flex-wrap items-start justify-between gap-2">
									<div>
										<p className="font-mono text-[10px] uppercase tracking-[0.09em] text-faint">
											Provider
										</p>
										<p className="mt-1 text-[11px] text-muted">
											{selectedProvider ? selectedProvider.name : "选择或添加一个 Provider"}
										</p>
									</div>
									{selectedProvider ? (
										<Button
											variant="danger"
											disabled={selectedProviderIsBuiltIn}
											onClick={() => void handleRemoveProvider()}
										>
											删除 Provider
										</Button>
									) : null}
								</div>

								{selectedProvider ? (
									<div className="grid gap-3 md:grid-cols-2">
										<Field label="Provider 名称">
											<input
												aria-label="Provider 名称"
													disabled={selectedProviderIsBuiltIn}
												value={providerNameDraft}
												onChange={(event) => setProviderNameDraft(event.currentTarget.value)}
												onBlur={commitProviderName}
												onKeyDown={(event) => {
													if (event.key === "Enter") {
														event.currentTarget.blur();
													}
												}}
												spellCheck={false}
												className={inputClassName()}
											/>
										</Field>

											<Field label="Provider 类型">
											<input
												aria-label="Provider 类型"
													disabled={selectedProviderIsBuiltIn}
												list="provider-type-options"
												value={selectedProvider.type}
												onChange={(event) =>
													updateContent((previous) =>
														setProviderStringValue(
															previous,
															selectedProvider.name,
															"type",
															event.currentTarget.value,
														),
													)
												}
												spellCheck={false}
												className={inputClassName()}
											/>
											<datalist id="provider-type-options">
												{PROVIDER_TYPE_OPTIONS.map((providerType) => (
													<option key={providerType} value={providerType} />
												))}
											</datalist>
										</Field>
										<Field label="Base URL">
											<input
												aria-label="Base URL"
												value={selectedProvider.baseUrl}
												onChange={(event) =>
													updateContent((previous) =>
														setProviderStringValue(
															previous,
															selectedProvider.name,
															"base_url",
															event.currentTarget.value,
														),
													)
												}
												spellCheck={false}
												className={inputClassName()}
												placeholder="https://api.example.com/v1"
											/>
										</Field>
										<Field label="API key" description="密码形式显示；不会出现在摘要、提示或日志中。">
											<input
												aria-label="API key"
												type="password"
												autoComplete="off"
												value={selectedProvider.apiKey}
												onChange={(event) =>
													updateContent((previous) =>
														setProviderStringValue(
															previous,
															selectedProvider.name,
															"api_key",
															event.currentTarget.value,
														),
													)
												}
												spellCheck={false}
												className={inputClassName()}
											/>
										</Field>
										<Field label="环境变量（TOML）" description={'例如 { API_KEY = "…" }；清空可移除此项。'}>
											<textarea
												aria-label="环境变量（TOML）"
												value={selectedProvider.envRaw}
												onChange={(event) =>
													updateContent((previous) =>
														setProviderRawValue(
															previous,
															selectedProvider.name,
															"env",
															event.currentTarget.value,
														),
													)
												}
												spellCheck={false}
												className={inputClassName("h-16 resize-y py-2")}
											/>
										</Field>
										<Field label="自定义 Headers（TOML）" description={'例如 { "X-Title" = "Kimi Code" }；清空可移除此项。'}>
											<textarea
												aria-label="自定义 Headers（TOML）"
												value={selectedProvider.customHeadersRaw}
												onChange={(event) =>
													updateContent((previous) =>
														setProviderRawValue(
															previous,
															selectedProvider.name,
															"custom_headers",
															event.currentTarget.value,
														),
													)
												}
												spellCheck={false}
												className={inputClassName("h-16 resize-y py-2")}
											/>
										</Field>
										{selectedProviderIsBuiltIn ? (
												<p className="md:col-span-2 font-mono text-[10px] text-faint">
													这是 Kimi Code 内置 Provider；名称、类型和删除操作受到保护，但仍可覆盖连接配置。
												</p>
											) : null}
											{selectedProvider.hasNestedSettings ? (
											<p className="md:col-span-2 font-mono text-[10px] text-faint">
												已检测到嵌套 Provider 设置；编辑本页字段时会保留它们。
											</p>
										) : null}
									</div>
								) : (
									<EmptyState>选择或添加一个 Provider 后编辑其连接配置。</EmptyState>
								)}
							</section>

							<section className="rounded-r2 border border-line/70 bg-surface/40 p-3">
								<div className="mb-3 flex flex-wrap items-start justify-between gap-2">
									<div>
										<p className="font-mono text-[10px] uppercase tracking-[0.09em] text-faint">
											Models
										</p>
										<p className="mt-1 text-[11px] text-muted">
											{selectedProviderName
												? `绑定到 ${selectedProviderName}`
												: "选择 Provider 后管理模型"}
										</p>
									</div>
									<Button variant="ghost" onClick={handleAddModel}>
										添加模型
									</Button>
								</div>

								<div className="grid gap-3 lg:grid-cols-[170px_minmax(0,1fr)]">
									<div className="space-y-1 rounded-r1 border border-line/60 bg-background/40 p-2">
										{selectedProviderModels.length === 0 ? (
											<EmptyState>此 Provider 暂无模型</EmptyState>
										) : (
											selectedProviderModels.map((model) => (
												<button
													key={model.name}
													type="button"
													onClick={() => setSelectedModelName(model.name)}
													className={cn(
														"w-full rounded-r1 border px-2 py-1.5 text-left transition-colors",
														model.name === selectedModelName
															? "border-line-strong bg-active text-foreground"
															: "border-line/50 text-muted hover:bg-hover hover:text-foreground",
													)}
												>
													<span className="flex items-center gap-1.5">
														{model.name === defaultModelName ? (
															<span className="shrink-0 font-mono text-[10px] text-bright">默认</span>
														) : null}
														<span className="min-w-0 truncate font-mono text-[10.5px]">{model.name}</span>
													</span>
													<span className="mt-0.5 block truncate font-mono text-[10px] text-faint">
														{model.upstreamModel || "未设置上游模型"}
													</span>
												</button>
											))
										)}
									</div>

									{selectedModel ? (
										<div className="min-w-0 space-y-3">
											<div className="flex flex-wrap items-center justify-between gap-2">
												<p className="font-mono text-[10.5px] text-faint">{selectedModel.name}</p>
												<Button
													variant="danger"
													disabled={config.models.length <= 1}
													onClick={() => void handleRemoveModel()}
												>
													删除模型
												</Button>
											</div>
											<div className="grid gap-3 md:grid-cols-2">
												<Field label="模型别名">
													<input
														aria-label="模型别名"
														value={modelNameDraft}
														onChange={(event) => setModelNameDraft(event.currentTarget.value)}
														onBlur={commitModelName}
														onKeyDown={(event) => {
															if (event.key === "Enter") {
																event.currentTarget.blur();
															}
														}}
														spellCheck={false}
														className={inputClassName()}
													/>
												</Field>
												<Field label="显示名称">
													<input
														aria-label="显示名称"
														value={selectedModel.displayName}
														onChange={(event) =>
															updateContent((previous) =>
																setModelOptionalStringValue(
																	previous,
																	selectedModel.name,
																	"display_name",
																	event.currentTarget.value,
																),
															)
														}
														spellCheck={false}
														className={inputClassName()}
													/>
												</Field>
											<Field label="Provider">
													<select
														aria-label="模型 Provider"
														value={selectedModel.provider}
														onChange={(event) => {
															const providerName = event.currentTarget.value;
															updateContent((previous) =>
																setModelStringValue(
																	previous,
																	selectedModel.name,
																	"provider",
																	providerName,
																),
															);
															setSelectedProviderName(providerName);
														}}
														className={inputClassName()}
													>
														{config.providers.map((provider) => (
															<option key={provider.name} value={provider.name}>
																{provider.name}
															</option>
														))}
													</select>
												</Field>
												<Field label="上游模型">
													<input
														aria-label="上游模型"
														value={selectedModel.upstreamModel}
														onChange={(event) =>
															updateContent((previous) =>
																setModelStringValue(
																	previous,
																	selectedModel.name,
																	"model",
																	event.currentTarget.value,
																),
															)
														}
														spellCheck={false}
														className={inputClassName()}
														placeholder="kimi-for-coding"
													/>
												</Field>
												<Field
													label="线路协议"
													description="留空表示自动推断；无法推断线路协议时需显式设置。"
												>
													<select
														aria-label="线路协议"
														value={selectedModel.protocol}
														onChange={(event) =>
															updateContent((previous) =>
																setModelProtocol(
																	previous,
																	selectedModel.name,
																	event.currentTarget.value,
																),
															)
														}
														className={inputClassName()}
													>
														<option value="">（自动推断）</option>
														{MODEL_PROTOCOL_OPTIONS.map((protocol) => (
															<option key={protocol} value={protocol}>
																{protocol}
															</option>
														))}
													</select>
												</Field>
												<Field label="最大上下文长度">
													<input
														aria-label="最大上下文长度"
														type="number"
														min="0"
														value={selectedModel.maxContextSize}
														onChange={(event) =>
															updateContent((previous) =>
																setModelMaxContextSize(
																	previous,
																	selectedModel.name,
																	event.currentTarget.value,
																),
															)
														}
														className={inputClassName()}
														placeholder="262144"
													/>
												</Field>
												<Field
																label="支持的思考档位"
																description="以逗号分隔，例如 low, high, max。"
															>
																<input
																	aria-label="支持的思考档位"
																	value={selectedModel.supportEfforts.join(", ")}
																	onChange={(event) =>
																		updateContent((previous) =>
																			setModelSupportEfforts(
																				previous,
																				selectedModel.name,
																				parseEfforts(event.currentTarget.value),
																			),
																		)
																	}
																	spellCheck={false}
																	className={inputClassName()}
																	placeholder="low, high, max"
																/>
															</Field>
															<Field
																label="默认思考档位"
																description="未设置时，由当前模型或 Kimi Code 选择默认档位。"
															>
																<select
																	aria-label="默认思考档位"
																	value={selectedModel.defaultEffort}
																	disabled={
																		selectedModel.supportEfforts.length === 0 && !selectedModel.defaultEffort
																	}
																	onChange={(event) =>
																		updateContent((previous) =>
																			setModelOptionalStringValue(
																				previous,
																				selectedModel.name,
																				"default_effort",
																				event.currentTarget.value,
																			),
																		)
																	}
																	className={inputClassName()}
																>
																	<option value="">（未设置）</option>
																	{selectedModel.defaultEffort &&
																	!selectedModel.supportEfforts.includes(selectedModel.defaultEffort) ? (
																		<option value={selectedModel.defaultEffort}>
																			{selectedModel.defaultEffort}（当前值，未列入支持项）
																		</option>
																	) : null}
																	{selectedModel.supportEfforts.map((effort) => (
																		<option key={effort} value={effort}>
																			{effort}
																		</option>
																	))}
																</select>
															</Field>
															<Field label="Capabilities">
													<div className="grid grid-cols-2 gap-1.5">
														{MODEL_CAPABILITY_OPTIONS.map((capability) => {
															const checked = selectedModel.capabilities.includes(capability);
															return (
																<label
																	key={capability}
																	className="flex min-h-7 items-center gap-1.5 rounded-r1 border border-line/70 bg-background/50 px-2 font-mono text-[10px] text-muted"
																>
																	<input
																		type="checkbox"
																		aria-label={capability}
																		checked={checked}
																		onChange={(event) => {
																			const nextCapabilities = event.currentTarget.checked
																				? [...new Set([...selectedModel.capabilities, capability])]
																				: selectedModel.capabilities.filter((item) => item !== capability);
																			updateContent((previous) =>
																					setModelCapabilities(
																						previous,
																						selectedModel.name,
																						nextCapabilities,
																					),
																				);
																			}}
																	/>
																	{capability}
																</label>
															);
														})}
													</div>
												</Field>
											</div>
										</div>
									) : (
										<EmptyState>选择或添加模型后编辑其定义。</EmptyState>
									)}
								</div>
							</section>

							<section className="rounded-r2 border border-line/70 bg-surface/40 p-3">
								<Field
									label="默认模型"
									description="删除当前默认模型时会自动切换到另一个已配置模型。"
								>
									<select
										aria-label="默认模型"
										value={defaultModelName}
										disabled={config.models.length === 0}
										onChange={(event) =>
											updateContent((previous) => setDefaultModel(previous, event.currentTarget.value))
										}
										className={inputClassName()}
									>
										{config.models.length === 0 ? <option value="">（尚无模型）</option> : null}
										{config.models.map((model) => (
											<option key={model.name} value={model.name}>
												{model.name}（{model.provider || "未绑定 Provider"}）
											</option>
										))}
									</select>
								</Field>
							</section>
						</div>
					</div>
				</fieldset>
			)}

			{error ? <p className="mt-2 shrink-0 whitespace-pre-wrap font-mono text-[10.5px] text-danger">{error}</p> : null}
			<div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 border-t border-line pt-3">
				<span className="font-mono text-[10px] text-faint">
					{content === savedContent ? "没有未保存的更改" : "有未保存的更改"}
				</span>
				<Button
					className="ml-auto"
					disabled={!isReady || saving || content === savedContent}
					onClick={() => void handleSave()}
				>
					{saving ? "保存中…" : "保存模型配置"}
				</Button>
			</div>
		</div>
	);
}
