import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCustomSubagentsEnabled } from "@/hooks/useCustomSubagents";
import { useTheme } from "@/hooks/use-theme";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import {
  notifyGlobalConfigApplied,
  notifySecondaryModelApplied,
  notifyTextConfigSaved,
} from "@/lib/config-update-toast";
import { openExternalHttpUrl, openKimiCodeWebsite } from "@/lib/kimi-code-link";
import {
  checkAllUpdates,
  checkCliUpdate,
  checkDesktopUpdate,
  CLI_DOWNLOAD_FALLBACK,
  DESKTOP_DOWNLOAD_FALLBACK,
  type ComponentUpdateResult,
} from "@/lib/check-updates";
import {
  findConfigModel,
  modelForcesThinking,
  modelHasThinkingCapability,
  modelThinkingEfforts,
} from "@/lib/model-capabilities";
import {
  secondaryModelEffectHint,
  shouldShowSecondaryModelSettings,
} from "@/lib/secondary-model";
import {
  getConfigTomlFile,
  getMcpConfigFile,
  updateConfigTomlFile,
  updateMcpConfigFile,
} from "@/lib/settings-api";
import type { UpdateTextConfigResponse } from "@/lib/tauri-api";
import { getAppVersion, getKimiCliVersion } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { desktopVersion, resolveKimiCliVersion } from "@/lib/version";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { Switch } from "@/ui/switch";
import { UsagePanel } from "./usage-panel";
import { KimiLoginPanel } from "./kimi-login-panel";
import { ProvidersPanel } from "@/modules/providers/providers-panel";

export type SettingsTab = "general" | "config" | "mcp" | "usage" | "about";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "通用" },
  { id: "config", label: "Providers" },
  { id: "mcp", label: "MCP" },
  { id: "usage", label: "用量" },
  { id: "about", label: "关于" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
        {title}
      </div>
      {children}
    </div>
  );
}

function VersionRow({
  label,
  version,
  update,
  checking,
  onCheck,
  onOpenDownload,
}: {
  label: string;
  version: string;
  update: ComponentUpdateResult | null;
  checking: boolean;
  onCheck: () => void;
  onOpenDownload: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-r1 border border-line/70 bg-surface/40 px-2.5 py-2">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="text-foreground">{version}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
        <button
          type="button"
          disabled={checking}
          className="text-bright underline-offset-2 hover:underline disabled:opacity-50"
          onClick={onCheck}
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
        {update && (
          <>
            <span
              className={cn(
                update.status === "update-available" && "text-bright",
                update.status === "up-to-date" && "text-faint",
                (update.status === "error" || update.status === "unknown") &&
                  "text-danger",
              )}
            >
              {update.status === "up-to-date" && update.latest
                ? `已是最新（${update.latest}）`
                : update.message}
            </span>
            <button
              type="button"
              className="text-muted underline-offset-2 hover:text-bright hover:underline"
              onClick={onOpenDownload}
            >
              打开发布页
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TextConfigEditor({
  enabled,
  label,
  description,
  language,
  load,
  save,
  onDirtyChange,
}: {
  enabled: boolean;
  label: string;
  description: string;
  language: "toml" | "json";
  load: () => Promise<{ content: string; path: string }>;
  save: (content: string) => Promise<UpdateTextConfigResponse>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onDirtyChange(content !== savedContent);
  }, [content, onDirtyChange, savedContent]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load()
      .then((file) => {
        if (cancelled) return;
        setContent(file.content);
        setSavedContent(file.content);
        setPath(file.path);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, load]);

  const handleSave = async () => {
    setError(null);
    if (language === "json") {
      try {
        JSON.parse(content);
      } catch (err) {
        setError(`JSON 格式错误：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setSaving(true);
    try {
      const resp = await save(content);
      if (!resp.success) {
        throw new Error(resp.error || `保存 ${label} 失败`);
      }
      setSavedContent(content);
      notifyTextConfigSaved(resp, `${label} 已保存`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="mb-3 shrink-0">
        <p className="text-[12.5px] text-foreground">{description}</p>
        <p className="mt-1 truncate font-mono text-[10px] text-faint">{path || "读取中…"}</p>
      </div>
      {loading ? (
        <p className="py-12 text-center font-mono text-[11px] text-faint">加载中…</p>
      ) : (
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
          disabled={saving}
          className="min-h-0 w-full flex-1 resize-none rounded-r2 border border-line bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-line-strong disabled:opacity-60"
        />
      )}
      {error && (
        <p className="mt-2 shrink-0 whitespace-pre-wrap font-mono text-[10.5px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex shrink-0 items-center">
        <span className="font-mono text-[10px] text-faint">
          {content === savedContent ? "没有未保存的更改" : "有未保存的更改"}
        </span>
        <Button
          className="ml-auto"
          disabled={loading || saving || content === savedContent}
          onClick={() => void handleSave()}
        >
          {saving ? "保存中…" : `保存 ${label}`}
        </Button>
      </div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When opening (e.g. from model picker), jump to this tab. */
  initialTab?: SettingsTab;
}) {
  const { theme, setThemeWithTransition } = useTheme();
  const {
    enabled: customSubagentsEnabled,
    setEnabled: setCustomSubagentsEnabled,
  } = useCustomSubagentsEnabled();
  const { config, isLoading, isUpdating, error, update } = useGlobalConfig({ enabled: open });
  const [tab, setTab] = useState<SettingsTab>("general");
  const [dirtyTabs, setDirtyTabs] = useState<Record<"config" | "mcp", boolean>>({
    config: false,
    mcp: false,
  });
  const [cliVersion, setCliVersion] = useState("—");
  const [appVersion, setAppVersion] = useState(desktopVersion);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [checkingDesktop, setCheckingDesktop] = useState(false);
  const [checkingCli, setCheckingCli] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<ComponentUpdateResult | null>(null);
  const [cliUpdate, setCliUpdate] = useState<ComponentUpdateResult | null>(null);
  const selectedModel = useMemo(
    () => findConfigModel(config?.models, config?.defaultModel),
    [config?.defaultModel, config?.models],
  );
  const supportsThinking = modelHasThinkingCapability(selectedModel);
  const forcesThinking = modelForcesThinking(selectedModel);
  const supportedEfforts = modelThinkingEfforts(selectedModel);
  const showSecondaryModelSettings = shouldShowSecondaryModelSettings(config);
  const selectedSecondaryModel = useMemo(
    () => findConfigModel(config?.models, config?.secondaryModel ?? undefined),
    [config?.models, config?.secondaryModel],
  );
  const secondarySupportedEfforts = modelThinkingEfforts(selectedSecondaryModel);
  const currentEditorDirty = (tab === "config" || tab === "mcp") && dirtyTabs[tab];

  const confirmDiscardCurrentEditor = () =>
    !currentEditorDirty || window.confirm("当前文件有未保存的更改，确定放弃吗？");

  const changeTab = (nextTab: SettingsTab) => {
    if (nextTab === tab || !confirmDiscardCurrentEditor()) return;
    if (tab === "config" || tab === "mcp") {
      setDirtyTabs((current) => ({ ...current, [tab]: false }));
    }
    setTab(nextTab);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !confirmDiscardCurrentEditor()) return;
    if (!nextOpen) setDirtyTabs({ config: false, mcp: false });
    onOpenChange(nextOpen);
  };

  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    // Live-detect both versions: the running binary (not just the build-time
    // constant) and the currently resolvable Kimi Code CLI.
    getAppVersion()
      .then((version) => {
        const trimmed = version.trim();
        if (trimmed) setAppVersion(trimmed);
      })
      .catch(() => {
        // Keep the build-time fallback.
      });
    resolveKimiCliVersion()
      .then(setCliVersion)
      .catch(() => setCliVersion("dev"));
    setDesktopUpdate(null);
    setCliUpdate(null);
  }, [open]);

  const refreshLocalVersions = async (): Promise<{
    desktop: string;
    cli: string;
  }> => {
    let nextApp = appVersion;
    let nextCli = cliVersion;
    try {
      const live = (await getAppVersion()).trim();
      if (live) {
        nextApp = live;
        setAppVersion(live);
      }
    } catch {
      // Keep displayed fallback.
    }
    try {
      const liveCli = (await getKimiCliVersion()).trim();
      if (liveCli) {
        nextCli = liveCli;
        setCliVersion(liveCli);
      }
    } catch {
      try {
        nextCli = await resolveKimiCliVersion();
        setCliVersion(nextCli);
      } catch {
        // Keep displayed fallback.
      }
    }
    return { desktop: nextApp, cli: nextCli };
  };

  const handleCheckDesktopUpdate = async () => {
    setCheckingDesktop(true);
    try {
      const { desktop } = await refreshLocalVersions();
      const result = await checkDesktopUpdate(desktop);
      setDesktopUpdate(result);
      if (result.status === "up-to-date") {
        toast.success(`桌面版已是最新（${result.latest ?? desktop}）`);
      } else if (result.status === "update-available") {
        toast.message("桌面版有更新", { description: result.message });
      } else {
        toast.error("桌面版检查失败", { description: result.message });
      }
    } catch (error) {
      toast.error("桌面版检查失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCheckingDesktop(false);
    }
  };

  const handleCheckCliUpdate = async () => {
    setCheckingCli(true);
    try {
      const { cli } = await refreshLocalVersions();
      const result = await checkCliUpdate(cli);
      setCliUpdate(result);
      if (result.status === "up-to-date") {
        toast.success(`CLI 已是最新（${result.latest ?? cli}）`);
      } else if (result.status === "update-available") {
        toast.message("CLI 有更新", { description: result.message });
      } else {
        toast.error("CLI 检查失败", { description: result.message });
      }
    } catch (error) {
      toast.error("CLI 检查失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCheckingCli(false);
    }
  };

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    setCheckingDesktop(true);
    setCheckingCli(true);
    try {
      const { desktop, cli } = await refreshLocalVersions();
      const result = await checkAllUpdates({
        desktopVersion: desktop,
        cliVersion: cli,
      });
      setDesktopUpdate(result.desktop);
      setCliUpdate(result.cli);

      const bothCurrent =
        result.desktop.status === "up-to-date" && result.cli.status === "up-to-date";
      const anyNew =
        result.desktop.status === "update-available" ||
        result.cli.status === "update-available";
      if (bothCurrent) {
        toast.success("桌面版与 CLI 均为最新");
      } else if (anyNew) {
        toast.message("发现可用更新", {
          description: [result.desktop, result.cli]
            .filter((item) => item.status === "update-available")
            .map((item) => `${item.label}: ${item.message}`)
            .join(" · "),
        });
      }
    } catch (error) {
      toast.error("检查更新失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCheckingUpdates(false);
      setCheckingDesktop(false);
      setCheckingCli(false);
    }
  };
  const applyDefaultModel = async (name: string) => {
    try {
      const resp = await update({ defaultModel: name });
      notifyGlobalConfigApplied(resp, `默认模型已设为 ${name}`);
    } catch (err) {
      toast.error("更新默认模型失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const applyDefaultThinking = async (enabled: boolean) => {
    if (forcesThinking) return;
    try {
      const resp = await update({ defaultThinking: enabled });
      notifyGlobalConfigApplied(
        resp,
        enabled ? "默认 Thinking 已开启" : "默认 Thinking 已关闭",
      );
    } catch (err) {
      toast.error("更新 Thinking 失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const applyThinkingEffort = async (effort: string) => {
    if (!supportedEfforts.includes(effort)) return;
    try {
      const resp = await update({ thinkingEffort: effort });
      notifyGlobalConfigApplied(resp, `思考档位已切换为 ${effort}`);
    } catch (err) {
      toast.error("更新思考档位失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const applySecondaryModel = async (name: string) => {
    try {
      const resp = await update({ secondaryModel: name });
      notifySecondaryModelApplied(resp, `Secondary model 已设为 ${name}`);
    } catch (err) {
      toast.error("更新 Secondary model 失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const clearSecondaryModel = async () => {
    try {
      const resp = await update({ secondaryModel: "" });
      notifySecondaryModelApplied(resp, "Secondary model 已清除");
    } catch (err) {
      toast.error("清除 Secondary model 失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const applySecondaryDefaultEffort = async (effort: string) => {
    if (!secondarySupportedEfforts.includes(effort)) return;
    try {
      const resp = await update({ secondaryDefaultEffort: effort });
      notifySecondaryModelApplied(resp, `Secondary 思考档位已切换为 ${effort}`);
    } catch (err) {
      toast.error("更新 Secondary 思考档位失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(720px,85vh)] max-w-[820px] flex-col overflow-hidden">
        <DialogTitle>设置</DialogTitle>
        <DialogDescription className="sr-only">
          管理应用外观、Kimi Code 配置、MCP Server、用量统计和版本信息。
        </DialogDescription>
        <div className="mt-3 flex min-h-0 flex-1 gap-5">
          <nav className="w-32 shrink-0 space-y-1 border-r border-line pr-3">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => changeTab(item.id)}
                className={cn(
                  "w-full rounded-r1 px-2.5 py-2 text-left text-[12px] transition-colors",
                  tab === item.id
                    ? "bg-active text-bright"
                    : "text-muted hover:bg-hover hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col pr-1",
              tab === "config" || tab === "mcp"
                ? "overflow-hidden"
                : "overflow-y-auto",
            )}
          >
            {tab === "general" && (
              <>
                <Section title="外观">
                  <div className="flex gap-2">
                    {(["dark", "light"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={(event) => void setThemeWithTransition(value, event)}
                        className={cn(
                          "rounded-r2 border px-3 py-1.5 text-[12.5px] transition-colors",
                          theme === value
                            ? "border-line-strong bg-active text-foreground"
                            : "border-line text-muted hover:bg-hover hover:text-foreground",
                        )}
                      >
                        {value === "dark" ? "深色" : "浅色"}
                      </button>
                    ))}
                  </div>
                </Section>
                <Section title="实验功能">
                  <div className="flex items-start justify-between gap-3 rounded-r1 border border-line/70 bg-surface/40 p-3">
                    <span className="min-w-0">
                      <span className="block text-[12.5px] text-muted">自定义 Agent 发现</span>
                      <span className="mt-1 block text-[10.5px] leading-relaxed text-faint">
                        仅在此桌面应用本地保存。开启后扫描自定义 Agent；关闭时仍保留 Plugins、Skills
                        和运行中代理任务。
                      </span>
                    </span>
                    <Switch
                      aria-label="自定义 Agent 发现"
                      checked={customSubagentsEnabled}
                      onCheckedChange={setCustomSubagentsEnabled}
                    />
                  </div>
                </Section>
                <Section title="Kimi Code 登录（可选）">
                  <KimiLoginPanel
                    onSuccess={() => {
                      toast.success("登录成功，凭据已写入");
                    }}
                    onLogout={() => {
                      toast.success("已退出登录，凭据已清除");
                    }}
                  />
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
                          disabled={isUpdating}
                          onChange={(event) => void applyDefaultModel(event.target.value)}
                          className="h-8 rounded-r1 border border-line bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-line-strong disabled:opacity-60"
                        >
                          {config.models.map((model) => (
                            <option key={model.name} value={model.name}>
                              {model.name}（{model.provider}）
                            </option>
                          ))}
                        </select>
                        <span className="text-[10.5px] text-faint">
                          新会话的全局默认。当前已连接会话的实际 model/thinking
                          以聊天区模型菜单为准；在 Config 中添加或编辑模型定义。
                        </span>
                      </label>
                      <div className="flex items-center justify-between">
                        <span className="text-[12.5px] text-muted">默认开启 Plan 模式</span>
                        <Switch
                          checked={config.defaultPlanMode}
                          disabled={isUpdating}
                          onCheckedChange={(value) => void update({ defaultPlanMode: value })}
                        />
                      </div>
                      {supportsThinking && (
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <span className="block text-[12.5px] text-muted">
                              默认开启 Thinking
                            </span>
                            <span className="block text-[10.5px] text-faint">
                              {forcesThinking
                                ? "由模型 capabilities（always_thinking）强制启用"
                                : "仅当前默认模型声明 thinking 能力时可用"}
                            </span>
                          </div>
                          <Switch
                            checked={forcesThinking || config.defaultThinking}
                            disabled={forcesThinking || isUpdating}
                            onCheckedChange={(value) => {
                              void applyDefaultThinking(value);
                            }}
                          />
                        </div>
                      )}
                      {supportedEfforts.length > 0 && (
                        <label className="flex items-center justify-between gap-3">
                          <span className="text-[12.5px] text-muted">思考档位</span>
                          <select
                            aria-label="思考档位"
                            value={
                              supportedEfforts.includes(config.thinkingEffort)
                                ? config.thinkingEffort
                                : selectedModel?.defaultEffort ?? supportedEfforts[0]
                            }
                            disabled={isUpdating}
                            onChange={(event) => void applyThinkingEffort(event.target.value)}
                            className="h-8 rounded-r1 border border-line bg-background px-2 font-mono text-[12px] uppercase text-foreground outline-none focus:border-line-strong disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {supportedEfforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {showSecondaryModelSettings ? (
                        <div className="rounded-r1 border border-line/70 bg-surface/40 p-3">
                          <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-faint">
                            Secondary model（实验）
                          </div>
                          <div className="flex flex-col gap-3">
                            <label className="flex flex-col gap-1.5">
                              <span className="text-[12.5px] text-muted">子代理默认模型</span>
                              <select
                                aria-label="Secondary model"
                                value={config.secondaryModel ?? ""}
                                disabled={isUpdating}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  if (!value) {
                                    void clearSecondaryModel();
                                    return;
                                  }
                                  void applySecondaryModel(value);
                                }}
                                className="h-8 rounded-r1 border border-line bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-line-strong disabled:opacity-60"
                              >
                                <option value="">（未配置）</option>
                                {config.models.map((model) => (
                                  <option key={model.name} value={model.name}>
                                    {model.name}（{model.provider}）
                                  </option>
                                ))}
                              </select>
                              <span className="text-[10.5px] text-faint">
                                对应官方 `/secondary_model` 与 `[secondary_model].model`；不是聊天区的会话 model 切换。
                              </span>
                              <span className="text-[10.5px] text-faint">
                                {secondaryModelEffectHint()}
                              </span>
                            </label>
                            {config.secondaryModelEnvOverride ? (
                              <p className="font-mono text-[10.5px] text-warn">
                                当前由环境变量 KIMI_SECONDARY_MODEL 覆盖 config.toml 显示值。
                              </p>
                            ) : null}
                            {!config.secondaryModelValid && config.secondaryModel ? (
                              <p className="font-mono text-[10.5px] text-warn">
                                当前 secondary model 未在 `[models]` 中解析，保存合法 alias 后新子代理才会绑定。
                              </p>
                            ) : null}
                            {secondarySupportedEfforts.length > 0 && config.secondaryModel ? (
                              <label className="flex items-center justify-between gap-3">
                                <span className="text-[12.5px] text-muted">Secondary 思考档位</span>
                                <select
                                  aria-label="Secondary 思考档位"
                                  value={
                                    secondarySupportedEfforts.includes(
                                      config.secondaryDefaultEffort ?? "",
                                    )
                                      ? (config.secondaryDefaultEffort ?? "")
                                      : selectedSecondaryModel?.defaultEffort ??
                                        secondarySupportedEfforts[0]
                                  }
                                  disabled={isUpdating}
                                  onChange={(event) =>
                                    void applySecondaryDefaultEffort(event.target.value)
                                  }
                                  className="h-8 rounded-r1 border border-line bg-background px-2 font-mono text-[12px] uppercase text-foreground outline-none focus:border-line-strong disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {secondarySupportedEfforts.map((effort) => (
                                    <option key={effort} value={effort}>
                                      {effort}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : null}
                            {config.secondaryDefaultEffortEnvOverride ? (
                              <p className="font-mono text-[10.5px] text-warn">
                                当前由环境变量 KIMI_SECONDARY_EFFORT 覆盖 config.toml 显示值。
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      {isUpdating && <p className="font-mono text-[10.5px] text-faint">保存中…</p>}
                      {error && <p className="font-mono text-[10.5px] text-danger">{error}</p>}
                    </div>
                  ) : (
                    <p className="font-mono text-[11px] text-faint">无法读取配置</p>
                  )}
                </Section>
              </>
            )}
            {tab === "config" && (
              <ProvidersPanel
                enabled={open && tab === "config"}
                advancedEditor={
                  <TextConfigEditor
                    enabled={open && tab === "config"}
                    label="config.toml"
                    language="toml"
                    description="高级：直接编辑完整 config.toml。保存前仅做 TOML 结构校验；保存后空闲会话会重启以应用。"
                    load={getConfigTomlFile}
                    save={updateConfigTomlFile}
                    onDirtyChange={(dirty) =>
                      setDirtyTabs((current) =>
                        current.config === dirty ? current : { ...current, config: dirty },
                      )
                    }
                  />
                }
              />
            )}
            {tab === "mcp" && (
              <TextConfigEditor
                enabled={open && tab === "mcp"}
                label="mcp.json"
                language="json"
                description="管理 MCP Server 配置。保存前会在本地检查 JSON 格式。"
                load={getMcpConfigFile}
                save={updateMcpConfigFile}
                onDirtyChange={(dirty) =>
                  setDirtyTabs((current) =>
                    current.mcp === dirty ? current : { ...current, mcp: dirty },
                  )
                }
              />
            )}
            {tab === "usage" && <UsagePanel enabled={open && tab === "usage"} />}
            {tab === "about" && (
              <Section title="版本">
                <div className="flex flex-col gap-2 font-mono text-[11.5px] text-muted">
                  <VersionRow
                    label="桌面版"
                    version={appVersion}
                    update={desktopUpdate}
                    checking={checkingDesktop || checkingUpdates}
                    onCheck={() => void handleCheckDesktopUpdate()}
                    onOpenDownload={() => {
                      openExternalHttpUrl(
                        desktopUpdate?.downloadUrl || DESKTOP_DOWNLOAD_FALLBACK,
                      );
                    }}
                  />
                  <VersionRow
                    label="Kimi Code CLI"
                    version={cliVersion}
                    update={cliUpdate}
                    checking={checkingCli || checkingUpdates}
                    onCheck={() => void handleCheckCliUpdate()}
                    onOpenDownload={() => {
                      openExternalHttpUrl(
                        cliUpdate?.downloadUrl || CLI_DOWNLOAD_FALLBACK,
                      );
                    }}
                  />
                </div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    disabled={checkingUpdates || checkingDesktop || checkingCli}
                    onClick={() => void handleCheckUpdates()}
                  >
                    {checkingUpdates ? "检查中…" : "全部检查"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void openKimiCodeWebsite()}
                  >
                    访问 Kimi Code 官网
                  </Button>
                </div>
              </Section>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
