import { Database, Globe2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { notifyTextConfigSaved } from "@/lib/config-update-toast";
import {
  getProviderCatalogEntry,
  importProviderFromCatalog,
  importProviderRegistry,
  listProviderCatalog,
} from "@/lib/settings-api";
import type { ProviderCatalogEntry, ProviderCatalogSummary } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";

type AddMode = "choice" | "catalog" | "registry";

function inputClassName(extra = ""): string {
  return cn(
    "h-8 w-full rounded-r1 border border-line bg-background px-2 font-mono text-[11.5px] text-foreground outline-none placeholder:text-faint focus:border-line-strong disabled:cursor-not-allowed disabled:opacity-60",
    extra,
  );
}

function ChoiceCard({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-28 w-full items-start gap-3 rounded-r2 border border-line bg-surface/50 p-3 text-left transition-colors hover:border-line-strong hover:bg-hover"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-r1 border border-line bg-background text-muted group-hover:text-foreground">
        {icon}
      </span>
      <span>
        <span className="block text-[12.5px] font-medium text-foreground">{title}</span>
        <span className="mt-1 block text-[10.5px] leading-relaxed text-muted">{description}</span>
      </span>
    </button>
  );
}

export function ProviderAddDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<AddMode>("choice");
  const [providers, setProviders] = useState<ProviderCatalogSummary[] | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [entry, setEntry] = useState<ProviderCatalogEntry | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [registryUrl, setRegistryUrl] = useState("");
  const [registryToken, setRegistryToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerEntryRequestRef = useRef(0);

  useEffect(() => {
    if (!open) {
      providerEntryRequestRef.current += 1;
      setMode("choice");
      setProviders(null);
      setProviderQuery("");
      setSelectedProviderId("");
      setEntry(null);
      setApiKey("");
      setDefaultModel("");
      setBaseUrl("");
      setRegistryUrl("");
      setRegistryToken("");
      setLoading(false);
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "catalog" || providers !== null) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listProviderCatalog()
      .then((items) => {
        if (!cancelled) {
          setProviders(items);
        }
      })
      .catch((catalogError) => {
        if (!cancelled) {
          setError(catalogError instanceof Error ? catalogError.message : String(catalogError));
          setProviders([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, open, providers]);

  const filteredProviders = useMemo(() => {
    const query = providerQuery.trim().toLocaleLowerCase();
    if (!query) {
      return providers ?? [];
    }
    return (providers ?? []).filter(
      (provider) =>
        provider.id.toLocaleLowerCase().includes(query) ||
        provider.name.toLocaleLowerCase().includes(query),
    );
  }, [providerQuery, providers]);

  const selectProvider = async (providerId: string) => {
    const requestId = ++providerEntryRequestRef.current;
    setSelectedProviderId(providerId);
    setEntry(null);
    setApiKey("");
    setDefaultModel("");
    setBaseUrl("");
    setError(null);
    setLoading(true);
    try {
      const nextEntry = await getProviderCatalogEntry(providerId);
      if (providerEntryRequestRef.current !== requestId) {
        return;
      }
      setEntry(nextEntry);
      setDefaultModel(nextEntry.models[0]?.id ?? "");
    } catch (catalogError) {
      if (providerEntryRequestRef.current !== requestId) {
        return;
      }
      setError(catalogError instanceof Error ? catalogError.message : String(catalogError));
    } finally {
      if (providerEntryRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  };

  const importCatalog = async () => {
    if (!selectedProviderId || !apiKey.trim() || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await importProviderFromCatalog({
        providerId: selectedProviderId,
        apiKey,
        defaultModel: defaultModel || undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
      notifyTextConfigSaved(response, `Provider ${selectedProviderId} 已导入`);
      onImported();
      onOpenChange(false);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setSubmitting(false);
    }
  };

  const importRegistry = async () => {
    if (!registryUrl.trim() || !registryToken.trim() || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await importProviderRegistry({
        registryUrl: registryUrl.trim(),
        apiKey: registryToken,
      });
      notifyTextConfigSaved(response, "自定义 Provider Registry 已导入");
      onImported();
      onOpenChange(false);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) {
          if (!next) {
            providerEntryRequestRef.current += 1;
          }
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>添加 Provider</DialogTitle>
        <DialogDescription>
          {mode === "choice"
            ? "选择与 Kimi Code CLI /provider 相同的添加方式。"
            : mode === "catalog"
              ? "从 models.dev 目录选择平台；网络不可用时 Kimi Code 会使用内置快照。"
              : "输入兼容 Kimi Code 的 api.json Registry 地址与访问令牌。"}
        </DialogDescription>

        {mode === "choice" ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <ChoiceCard
              title="已知平台"
              description="从 models.dev 选择 OpenAI、Anthropic、Google 等平台，自动导入模型与能力信息。"
              icon={<Globe2 size={16} strokeWidth={1.5} />}
              onClick={() => setMode("catalog")}
            />
            <ChoiceCard
              title="自定义 Registry"
              description="通过 api.json 一次导入 Registry 中的 Provider 和模型，并保留后续同步来源。"
              icon={<Database size={16} strokeWidth={1.5} />}
              onClick={() => setMode("registry")}
            />
          </div>
        ) : null}

        {mode === "catalog" ? (
          <div className="mt-4 grid min-h-80 gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
            <div className="min-h-0 rounded-r2 border border-line bg-surface/40 p-2">
              <input
                aria-label="搜索平台"
                value={providerQuery}
                onChange={(event) => setProviderQuery(event.currentTarget.value)}
                placeholder="搜索平台"
                className={inputClassName()}
              />
              <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                {providers === null ? (
                  <p className="py-6 text-center text-[10.5px] text-faint">正在读取目录…</p>
                ) : filteredProviders.length === 0 ? (
                  <p className="py-6 text-center text-[10.5px] text-faint">没有匹配的平台</p>
                ) : (
                  filteredProviders.map((provider) => (
                    <button
                      type="button"
                      key={provider.id}
                      onClick={() => void selectProvider(provider.id)}
                      className={cn(
                        "w-full rounded-r1 border px-2 py-1.5 text-left",
                        provider.id === selectedProviderId
                          ? "border-line-strong bg-active"
                          : "border-transparent hover:bg-hover",
                      )}
                    >
                      <span className="block truncate text-[11.5px] text-foreground">
                        {provider.name}
                      </span>
                      <span className="block truncate font-mono text-[9.5px] text-faint">
                        {provider.id} · {provider.modelCount} models
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-r2 border border-line bg-surface/40 p-3">
              {entry ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-[12.5px] text-foreground">{entry.name}</p>
                    <p className="font-mono text-[10px] text-faint">{entry.providerId}</p>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[10.5px] text-muted">API Key</span>
                    <input
                      aria-label="平台 API Key"
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.currentTarget.value)}
                      className={inputClassName()}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[10.5px] text-muted">默认模型</span>
                    <select
                      aria-label="目录默认模型"
                      value={defaultModel}
                      onChange={(event) => setDefaultModel(event.currentTarget.value)}
                      className={inputClassName()}
                    >
                      <option value="">暂不设置</option>
                      {entry.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}（{model.maxContextTokens || "?"}）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[10.5px] text-muted">Base URL（可选）</span>
                    <input
                      aria-label="目录 Base URL"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.currentTarget.value)}
                      placeholder="目录没有 endpoint 时填写"
                      className={inputClassName()}
                    />
                  </label>
                  <Button
                    disabled={!apiKey.trim() || submitting}
                    onClick={() => void importCatalog()}
                  >
                    {submitting ? "导入中…" : "导入平台"}
                  </Button>
                </div>
              ) : (
                <p className="flex h-full min-h-60 items-center justify-center text-[10.5px] text-faint">
                  {loading ? "正在读取平台模型…" : "从左侧选择一个平台"}
                </p>
              )}
            </div>
          </div>
        ) : null}

        {mode === "registry" ? (
          <div className="mt-4 space-y-3 rounded-r2 border border-line bg-surface/40 p-3">
            <label className="block space-y-1">
              <span className="text-[10.5px] text-muted">Registry URL</span>
              <input
                aria-label="Registry URL"
                value={registryUrl}
                onChange={(event) => setRegistryUrl(event.currentTarget.value)}
                placeholder="https://registry.example.com/api.json"
                className={inputClassName()}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10.5px] text-muted">Bearer Token</span>
              <input
                aria-label="Registry Token"
                type="password"
                autoComplete="off"
                value={registryToken}
                onChange={(event) => setRegistryToken(event.currentTarget.value)}
                className={inputClassName()}
              />
            </label>
            <p className="text-[10px] leading-relaxed text-faint">
              Kimi Code 会保存 Registry 来源元数据，并在后续启动时同步同一来源的 Provider 与模型。
            </p>
            <Button
              disabled={!registryUrl.trim() || !registryToken.trim() || submitting}
              onClick={() => void importRegistry()}
            >
              {submitting ? "导入中…" : "导入 Registry"}
            </Button>
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 whitespace-pre-wrap font-mono text-[10.5px] text-danger">{error}</p>
        ) : null}
        {mode !== "choice" ? (
          <div className="mt-4 border-t border-line pt-3">
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                providerEntryRequestRef.current += 1;
                setMode("choice");
                setError(null);
              }}
            >
              返回添加方式
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
