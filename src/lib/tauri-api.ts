import { invoke, isTauri as _isTauri } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  GitDiffStats,
  GlobalConfig,
  Session,
  SessionStatus,
  UpdateGlobalConfigResponse,
  UploadSessionFileResponse,
} from "./api/models";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { stripThinkMarkup } from "@/lib/utils";

export type TextConfigFile = {
  content: string;
  path: string;
};

export type UpdateTextConfigResponse = {
  success: boolean;
  error?: string | null;
};

export type WireEventPayload = {
  session_id: string;
  message: string;
};

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return (
    _isTauri() ||
    (globalThis as unknown as Record<string, unknown>).isTauri === true ||
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== "undefined" ||
    typeof (window as unknown as Record<string, unknown>).__TAURI__ !== "undefined"
  );
}

export async function showWindow(): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("show_window");
}

export async function hideWindow(): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("hide_window");
}

export async function getAppVersion(): Promise<string> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<string>("get_app_version");
}

export async function getKimiCliVersion(): Promise<string> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<string>("get_kimi_cli_version");
}

export async function openKimiLogin(): Promise<{ success: boolean; program: string }> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("open_kimi_login");
  return {
    success: Boolean(raw.success),
    program: String(raw.program ?? ""),
  };
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("open_external", { url });
}

export async function openInExplorer(path: string): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("open_in_explorer", { path });
}

export async function openInEditor(path: string, editor?: string): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("open_in_editor", { path, editor: editor ?? "vscode" });
}

export async function wireConnect(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("wire_connect", { sessionId });
}

export async function wireDisconnect(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("wire_disconnect", { sessionId });
}

export async function wireSend(sessionId: string, message: unknown): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const serialized = typeof message === "string" ? message : JSON.stringify(message);
  return invoke<void>("wire_send", { sessionId, message: serialized });
}

export async function wireStatus(sessionId: string): Promise<SessionStatus | null> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown> | null>("wire_status", { sessionId });
  return raw ? normalizeSessionStatus(raw) : null;
}

export function onWireMessage(
  sessionId: string,
  callback: (message: string) => void,
): () => void {
  return listenEvent("wire:message", (payload) => {
    const eventPayload = payload as WireEventPayload | undefined;
    if (eventPayload?.session_id === sessionId && typeof eventPayload.message === "string") {
      callback(eventPayload.message);
    }
  });
}

export async function listSessions(args?: {
  limit?: number;
  offset?: number;
  q?: string;
  archived?: boolean;
}): Promise<Session[]> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<unknown[]>("list_sessions", args ?? {});
  return raw.map((item) => normalizeSession(item as Record<string, unknown>));
}

export async function getSession(sessionId: string): Promise<Session | null> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown> | null>("get_session", { sessionId });
  return raw ? normalizeSession(raw) : null;
}

export async function replaySessionHistory(sessionId: string): Promise<string[]> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<unknown[]>("replay_session_history", { sessionId });
  return raw.map(String);
}

export async function createSession(workDir?: string, createDir?: boolean): Promise<Session> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("create_session", {
    workDir,
    createDir,
  });
  return normalizeSession(raw);
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return invoke<void>("delete_session", { sessionId });
}

export async function updateSession(args: {
  sessionId: string;
  title?: string;
  archived?: boolean;
}): Promise<Session> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("update_session", args);
  return normalizeSession(raw);
}

export async function forkSession(sessionId: string, turnIndex: number): Promise<Session> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("fork_session", { sessionId, turnIndex });
  return normalizeSession(raw);
}

export async function generateTitle(sessionId: string): Promise<{ title: string }> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("generate_title", { sessionId });
  return { title: String(raw.title ?? "") };
}

export async function uploadSessionFile(sessionId: string, file: File): Promise<UploadSessionFileResponse> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const buffer = await file.arrayBuffer();
  const data = Array.from(new Uint8Array(buffer));
  const raw = await invoke<Record<string, unknown>>("upload_session_file", {
    sessionId,
    filename: file.name,
    data,
  });
  return {
    path: String(raw.path ?? ""),
    filename: String(raw.filename ?? ""),
    size: Number(raw.size ?? 0),
  };
}

export async function listSessionDirectory(sessionId: string, path?: string): Promise<SessionFileEntry[]> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<unknown[]>("list_session_directory", { sessionId, path: path ?? "." });
  return raw.map((item) => {
    const entry = item as Record<string, unknown>;
    return {
      name: String(entry.name ?? ""),
      type: entry.type === "directory" ? "directory" : "file",
      size: typeof entry.size === "number" ? entry.size : undefined,
    };
  });
}

export async function getSessionFile(sessionId: string, path: string): Promise<Blob> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("get_session_file", { sessionId, path });
  return filePayloadToBlob(raw);
}

export async function getSessionUploadFile(sessionId: string, filename: string): Promise<Blob> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("get_session_upload_file", { sessionId, filename });
  return filePayloadToBlob(raw);
}

export async function listWorkDirs(): Promise<string[]> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<unknown[]>("list_work_dirs");
  return raw.map(String);
}

export async function getStartupDir(): Promise<string> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  return String(await invoke<unknown>("get_startup_dir"));
}

export async function getGlobalConfig(): Promise<GlobalConfig> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("get_global_config");
  return normalizeGlobalConfig(raw);
}

export async function getConfigToml(): Promise<TextConfigFile> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("get_config_toml");
  return normalizeTextConfigFile(raw);
}

export async function updateConfigToml(content: string): Promise<UpdateTextConfigResponse> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("update_config_toml", { content });
  return normalizeUpdateTextConfigResponse(raw);
}

export async function getMcpConfig(): Promise<TextConfigFile> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("get_mcp_config");
  return normalizeTextConfigFile(raw);
}

export async function updateMcpConfig(content: string): Promise<UpdateTextConfigResponse> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("update_mcp_config", { content });
  return normalizeUpdateTextConfigResponse(raw);
}

export async function updateGlobalConfig(args: {
  defaultModel?: string;
  defaultThinking?: boolean;
  restartRunningSessions?: boolean;
  forceRestartBusySessions?: boolean;
}): Promise<UpdateGlobalConfigResponse> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const raw = await invoke<Record<string, unknown>>("update_global_config", {
    defaultModel: args.defaultModel,
    defaultThinking: args.defaultThinking,
    restartRunningSessions: args.restartRunningSessions,
    forceRestartBusySessions: args.forceRestartBusySessions,
  });
  return {
    config: normalizeGlobalConfig(raw.config as Record<string, unknown>),
    restartedSessionIds: (raw.restarted_session_ids as string[] | null | undefined) ?? undefined,
    skippedBusySessionIds: (raw.skipped_busy_session_ids as string[] | null | undefined) ?? undefined,
  };
}

export async function getGitDiffStats(sessionId: string): Promise<GitDiffStats> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const data = await invoke<Record<string, unknown>>("get_git_diff_stats", { sessionId });
  return {
    isGitRepo: Boolean(data.is_git_repo),
    hasChanges: Boolean(data.has_changes),
    totalAdditions: Number(data.total_additions ?? 0),
    totalDeletions: Number(data.total_deletions ?? 0),
    files: ((data.files as Array<Record<string, unknown>> | undefined) ?? []).map((file) => ({
      path: String(file.path ?? ""),
      additions: Number(file.additions ?? 0),
      deletions: Number(file.deletions ?? 0),
      status: file.status as "added" | "modified" | "deleted" | "renamed",
    })),
    error: typeof data.error === "string" ? data.error : undefined,
  };
}

export async function sendNotification(title: string, body: string): Promise<void> {
  if (!isTauri()) {
    return Promise.reject("Not in Tauri");
  }

  if (!("Notification" in window)) {
    return Promise.reject("Notifications not supported");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return Promise.reject("Notification permission denied");
  }

  new Notification(title, { body });
}

export function onNotificationClick(
  callback: (event: { session_id: string; request_id: string }) => void,
): () => void {
  let unlisten: UnlistenFn | undefined;
  let cleanedUp = false;

  const setup = async () => {
    if (!isTauri()) return;
    unlisten = await listen("notification:approval", (event: Event<unknown>) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload.session_id === "string" && typeof payload.request_id === "string") {
        callback({
          session_id: payload.session_id,
          request_id: payload.request_id,
        });
      }
    });
    if (cleanedUp && unlisten) {
      unlisten();
    }
  };

  setup();

  return () => {
    cleanedUp = true;
    if (unlisten) {
      unlisten();
    }
  };
}

export function listenEvent(
  event: string,
  callback: (payload: unknown) => void,
): () => void {
  let unlisten: UnlistenFn | undefined;
  let cleanedUp = false;

  const setup = async () => {
    if (!isTauri()) return;
    unlisten = await listen(event, (evt: Event<unknown>) => {
      callback(evt.payload);
    });
    if (cleanedUp && unlisten) {
      unlisten();
    }
  };

  setup();

  return () => {
    cleanedUp = true;
    if (unlisten) {
      unlisten();
    }
  };
}

function normalizeSession(raw: Record<string, unknown>): Session {
  return {
    sessionId: String(raw.session_id ?? raw.sessionId ?? ""),
    title: stripThinkMarkup(String(raw.title ?? "Untitled")).trim() || "Untitled",
    lastUpdated: new Date(String(raw.last_updated ?? raw.lastUpdated ?? Date.now())),
    isRunning: Boolean(raw.is_running ?? raw.isRunning),
    status: raw.status ? normalizeSessionStatus(raw.status as Record<string, unknown>) : undefined,
    workDir: typeof raw.work_dir === "string" ? raw.work_dir : typeof raw.workDir === "string" ? raw.workDir : undefined,
    sessionDir: typeof raw.session_dir === "string" ? raw.session_dir : typeof raw.sessionDir === "string" ? raw.sessionDir : undefined,
    archived: Boolean(raw.archived),
  };
}

function normalizeSessionStatus(raw: Record<string, unknown>): SessionStatus {
  return {
    sessionId: String(raw.session_id ?? raw.sessionId ?? ""),
    state: raw.state as SessionStatus["state"],
    seq: Number(raw.seq ?? 0),
    workerId: typeof raw.worker_id === "string" ? raw.worker_id : typeof raw.workerId === "string" ? raw.workerId : undefined,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    detail: typeof raw.detail === "string" ? raw.detail : undefined,
    updatedAt: new Date(
      typeof raw.updated_at === "number"
        ? raw.updated_at
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : typeof raw.updatedAt === "number"
            ? raw.updatedAt
            : typeof raw.updatedAt === "string"
              ? raw.updatedAt
              : Date.now(),
    ),
  };
}

function normalizeGlobalConfig(raw: Record<string, unknown>): GlobalConfig {
  const models = (raw.models as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    defaultModel: String(raw.default_model ?? raw.defaultModel ?? ""),
    defaultThinking: Boolean(raw.default_thinking ?? raw.defaultThinking),
    models: models.map((model) => ({
      provider: String(model.provider ?? ""),
      model: String(model.model ?? ""),
      maxContextSize: Number(model.max_context_size ?? model.maxContextSize ?? 0),
      capabilities: model.capabilities ? new Set(model.capabilities as string[]) as never : undefined,
      name: String(model.name ?? ""),
      providerType: model.provider_type as never,
    })),
  };
}

function normalizeTextConfigFile(raw: Record<string, unknown>): TextConfigFile {
  return {
    content: String(raw.content ?? ""),
    path: String(raw.path ?? ""),
  };
}

function normalizeUpdateTextConfigResponse(raw: Record<string, unknown>): UpdateTextConfigResponse {
  return {
    success: Boolean(raw.success),
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

function filePayloadToBlob(raw: Record<string, unknown>): Blob {
  const bytes = (raw.data as number[] | undefined) ?? [];
  const contentType = typeof raw.content_type === "string" ? raw.content_type : "application/octet-stream";
  return new Blob([new Uint8Array(bytes)], { type: contentType });
}
