import { apiClient } from "@/lib/apiClient";
import { getAuthHeader } from "@/lib/auth";
import {
  getConfigToml as tauriGetConfigToml,
  getMcpConfig as tauriGetMcpConfig,
  isTauri,
  type TextConfigFile,
  updateConfigToml as tauriUpdateConfigToml,
  updateMcpConfig as tauriUpdateMcpConfig,
  type UpdateTextConfigResponse,
} from "@/lib/tauri-api";
import { getApiBaseUrl } from "@/hooks/utils";

const DEFAULT_MCP_JSON = "{\n  \"mcpServers\": {}\n}\n";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? String((data as Record<string, unknown>).detail)
        : "Request failed";
    throw new Error(detail);
  }
  return data as T;
}

export async function getConfigTomlFile(): Promise<TextConfigFile> {
  if (isTauri()) {
    return tauriGetConfigToml();
  }
  return apiClient.config.getConfigTomlApiConfigTomlGet();
}

export async function updateConfigTomlFile(
  content: string,
): Promise<UpdateTextConfigResponse> {
  if (isTauri()) {
    const resp = await tauriUpdateConfigToml(content);
    if (!resp.success) {
      throw new Error(resp.error || "Failed to save config.toml");
    }
    window.dispatchEvent(new Event("kimi:config-update"));
    return resp;
  }
  const resp = await apiClient.config.updateConfigTomlApiConfigTomlPut({
    updateConfigTomlRequest: { content },
  });
  if (!resp.success) {
    throw new Error(resp.error || "Failed to save config.toml");
  }
  window.dispatchEvent(new Event("kimi:config-update"));
  return resp;
}

export async function getMcpConfigFile(): Promise<TextConfigFile> {
  if (isTauri()) {
    return tauriGetMcpConfig();
  }
  const response = await fetch(`${getApiBaseUrl()}/api/config/mcp`, {
    headers: getAuthHeader(),
  });
  if (response.status === 404) {
    return {
      content: DEFAULT_MCP_JSON,
      path: "~/.kimi-code/mcp.json",
    };
  }
  return parseJsonResponse<TextConfigFile>(response);
}

export async function updateMcpConfigFile(
  content: string,
): Promise<UpdateTextConfigResponse> {
  if (isTauri()) {
    const resp = await tauriUpdateMcpConfig(content);
    if (!resp.success) {
      throw new Error(resp.error || "Failed to save mcp.json");
    }
    window.dispatchEvent(new Event("kimi:config-update"));
    return resp;
  }
  const response = await fetch(`${getApiBaseUrl()}/api/config/mcp`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeader(),
    },
    body: JSON.stringify({ content }),
  });
  const resp = await parseJsonResponse<UpdateTextConfigResponse>(response);
  if (!resp.success) {
    throw new Error(resp.error || "Failed to save mcp.json");
  }
  window.dispatchEvent(new Event("kimi:config-update"));
  return resp;
}
