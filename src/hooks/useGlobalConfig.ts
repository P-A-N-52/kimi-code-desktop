import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/apiClient";
import type {
  GlobalConfig,
  UpdateGlobalConfigRequest,
  UpdateGlobalConfigResponse,
} from "@/lib/api/models";
import {
  isTauri,
  getGlobalConfig as tauriGetGlobalConfig,
  updateGlobalConfig as tauriUpdateGlobalConfig,
} from "@/lib/tauri-api";

type UpdateGlobalConfigArgs = {
  defaultModel?: string;
  defaultThinking?: boolean;
  restartRunningSessions?: boolean;
  forceRestartBusySessions?: boolean;
};

let _cachedConfig: GlobalConfig | null = null;
let _configPromise: Promise<GlobalConfig> | null = null;

async function fetchGlobalConfig(): Promise<GlobalConfig> {
  if (_cachedConfig) return _cachedConfig;
  if (_configPromise) return _configPromise;
  _configPromise = (async () => {
    const cfg = isTauri()
      ? await tauriGetGlobalConfig()
      : await apiClient.config.getGlobalConfigApiConfigGet();
    _cachedConfig = cfg;
    return cfg;
  })();
  try {
    return await _configPromise;
  } finally {
    _configPromise = null;
  }
}

function invalidateGlobalConfigCache(): void {
  _cachedConfig = null;
}

export type UseGlobalConfigReturn = {
  config: GlobalConfig | null;
  isLoading: boolean;
  isUpdating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (args: UpdateGlobalConfigArgs) => Promise<UpdateGlobalConfigResponse>;
};

export function useGlobalConfig(): UseGlobalConfigReturn {
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInitializedRef = useRef(false);

  const loadConfig = useCallback(async (forceRefresh = false) => {
    setIsLoading(true);
    setError(null);
    try {
      if (forceRefresh) {
        invalidateGlobalConfigCache();
      }
      const nextConfig = await fetchGlobalConfig();
      setConfig(nextConfig);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load global config";
      setError(message);
      console.error("[useGlobalConfig] Failed to load global config:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await loadConfig(true);
  }, [loadConfig]);

  const update = useCallback(
    async (
      args: UpdateGlobalConfigArgs,
    ): Promise<UpdateGlobalConfigResponse> => {
      setIsUpdating(true);
      setError(null);
      try {
        let resp: UpdateGlobalConfigResponse;
        if (isTauri()) {
          resp = await tauriUpdateGlobalConfig({
            defaultModel: args.defaultModel,
            defaultThinking: args.defaultThinking,
            restartRunningSessions: args.restartRunningSessions,
            forceRestartBusySessions: args.forceRestartBusySessions,
          });
        } else {
          const body: UpdateGlobalConfigRequest = {
            defaultModel: args.defaultModel ?? undefined,
            defaultThinking: args.defaultThinking ?? undefined,
            restartRunningSessions: args.restartRunningSessions ?? undefined,
            forceRestartBusySessions: args.forceRestartBusySessions ?? undefined,
          };
          resp = await apiClient.config.updateGlobalConfigApiConfigPatch({
            updateGlobalConfigRequest: body,
          });
        }
        _cachedConfig = resp.config;
        setConfig(resp.config);
        return resp;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to update global config";
        setError(message);
        console.error("[useGlobalConfig] Failed to update global config:", err);
        throw err;
      } finally {
        setIsUpdating(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (isInitializedRef.current) {
      return;
    }
    isInitializedRef.current = true;
    loadConfig();
  }, [loadConfig]);

  // Re-fetch config when another tab/session changes it (broadcast via custom event)
  useEffect(() => {
    const handler = () => {
      loadConfig(true);
    };
    window.addEventListener("kimi:config-update", handler);
    return () => window.removeEventListener("kimi:config-update", handler);
  }, [loadConfig]);

  return {
    config,
    isLoading,
    isUpdating,
    error,
    refresh,
    update,
  };
}
