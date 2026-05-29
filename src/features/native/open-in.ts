import { isTauri, openInEditor, openInExplorer as openInExplorerTauri } from "@/lib/tauri-api";
import { getAuthHeader } from "@/lib/auth";
import { getApiBaseUrl } from "@/hooks/utils";

async function callOpenInApi(app: string, path: string): Promise<void> {
  const basePath = getApiBaseUrl();
  const response = await fetch(`${basePath}/api/open-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeader() },
    body: JSON.stringify({ app, path }),
  });

  if (!response.ok) {
    let detail = "Failed to open application.";
    try {
      const data = await response.json();
      if (data?.detail) {
        detail = String(data.detail);
      }
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
}

/**
 * Open a path in VS Code.
 */
export async function openInVSCode(path: string): Promise<void> {
  if (isTauri()) {
    await openInEditor(path, "vscode");
    return;
  }
  await callOpenInApi("vscode", path);
}

/**
 * Open a path in Cursor.
 */
export async function openInCursor(path: string): Promise<void> {
  if (isTauri()) {
    await openInEditor(path, "cursor");
    return;
  }
  await callOpenInApi("cursor", path);
}

/**
 * Open a directory in the system's file explorer.
 * Uses the native Tauri command for cross-platform support.
 */
export async function openInExplorer(path: string): Promise<void> {
  if (isTauri()) {
    await openInExplorerTauri(path);
    return;
  }
  await callOpenInApi("explorer", path);
}
