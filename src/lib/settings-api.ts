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
    return tauriUpdateConfigToml(content);
  }
  return apiClient.config.updateConfigTomlApiConfigTomlPut({
    updateConfigTomlRequest: { content },
  });
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
    return tauriUpdateMcpConfig(content);
  }
  const response = await fetch(`${getApiBaseUrl()}/api/config/mcp`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeader(),
    },
    body: JSON.stringify({ content }),
  });
  return parseJsonResponse<UpdateTextConfigResponse>(response);
}
