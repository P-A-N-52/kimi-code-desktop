import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTheme } from "@/hooks/use-theme";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import { openKimiCodeWebsite } from "@/lib/kimi-code-link";
import {
  getConfigTomlFile,
  getMcpConfigFile,
  updateConfigTomlFile,
  updateMcpConfigFile,
} from "@/lib/settings-api";
import { cn } from "@/lib/utils";
import { desktopVersion, resolveKimiCliVersion } from "@/lib/version";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { Switch } from "@/ui/switch";

type SettingsTab = "general" | "config" | "mcp" | "about";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "通用" },
  { id: "config", label: "Config" },
  { id: "mcp", label: "MCP" },
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

function TextConfigEditor({
  enabled,
  label,
  description,
  language,
  load,
  save,
}: {
  enabled: boolean;
  label: string;
  description: string;
  language: "toml" | "json";
  load: () => Promise<{ content: string; path: string }>;
  save: (content: string) => Promise<unknown>;
}) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await save(content);
      setSavedContent(content);
      toast.success(`${label} 已保存`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3">
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
          className="min-h-72 flex-1 resize-none rounded-r2 border border-line bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-line-strong"
        />
      )}
      {error && (
        <p className="mt-2 whitespace-pre-wrap font-mono text-[10.5px] text-danger">{error}</p>
      )}
      <div className="mt-3 flex items-center">
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { theme, setTheme } = useTheme();
  const { config, isLoading, isUpdating, error, update } = useGlobalConfig({ enabled: open });
  const [tab, setTab] = useState<SettingsTab>("general");
  const [cliVersion, setCliVersion] = useState("—");

  useEffect(() => {
    if (open)
      resolveKimiCliVersion()
        .then(setCliVersion)
        .catch(() => setCliVersion("dev"));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(720px,85vh)] max-w-[760px] flex-col overflow-hidden">
        <DialogTitle>设置</DialogTitle>
        <DialogDescription className="sr-only">
          管理应用外观、Kimi Code 配置、MCP Server 和版本信息。
        </DialogDescription>
        <div className="mt-3 flex min-h-0 flex-1 gap-5">
          <nav className="w-32 shrink-0 space-y-1 border-r border-line pr-3">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pr-1">
            {tab === "general" && (
              <>
                <Section title="外观">
                  <div className="flex gap-2">
                    {(["dark", "light"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setTheme(value)}
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
                <Section title="全局配置">
                  {isLoading ? (
                    <p className="font-mono text-[11px] text-faint">加载中…</p>
                  ) : config ? (
                    <div className="flex flex-col gap-3">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[12.5px] text-muted">默认模型</span>
                        <select
                          value={config.defaultModel}
                          onChange={(event) => void update({ defaultModel: event.target.value })}
                          className="h-8 rounded-r1 border border-line bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-line-strong"
                        >
                          {config.models.map((model) => (
                            <option key={model.name} value={model.name}>
                              {model.name}（{model.provider}）
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="flex items-center justify-between">
                        <span className="text-[12.5px] text-muted">默认开启 Plan 模式</span>
                        <Switch
                          checked={config.defaultPlanMode}
                          onCheckedChange={(value) => void update({ defaultPlanMode: value })}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[12.5px] text-muted">默认开启 Thinking</span>
                        <Switch
                          checked={config.defaultThinking}
                          onCheckedChange={(value) => void update({ defaultThinking: value })}
                        />
                      </div>
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
              <TextConfigEditor
                enabled={open && tab === "config"}
                label="config.toml"
                language="toml"
                description="直接编辑 Kimi Code CLI 的完整 TOML 配置。保存后后续会话会读取新配置。"
                load={getConfigTomlFile}
                save={updateConfigTomlFile}
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
              />
            )}
            {tab === "about" && (
              <Section title="版本">
                <div className="flex flex-col gap-1 font-mono text-[11.5px] text-muted">
                  <div className="flex justify-between">
                    <span>桌面版</span>
                    <span>{desktopVersion}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Kimi Code CLI</span>
                    <span>{cliVersion}</span>
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
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
