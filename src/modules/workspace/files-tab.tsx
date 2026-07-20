import { ArrowLeft, FileText, Folder, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { useToolEventsStore } from "@/lib/tool-events/store";
import { cn } from "@/lib/utils";

type FilesTabProps = {
  sessionId: string;
  listDirectory: (sessionId: string, path?: string) => Promise<SessionFileEntry[]>;
  getFile: (sessionId: string, path: string) => Promise<Blob>;
};

const TEXT_EXTENSIONS = new Set([
  "css",
  "csv",
  "html",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "py",
  "rs",
  "sh",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

function joinPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function parentPath(path: string): string {
  if (path === "." || !path.includes("/")) return ".";
  return path.slice(0, path.lastIndexOf("/")) || ".";
}

function canPreviewText(blob: Blob, path: string): boolean {
  if (blob.type.startsWith("text/")) return true;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(extension) || blob.type.includes("json");
}

export function FilesTab({ sessionId, listDirectory, getFile }: FilesTabProps) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<SessionFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const newFiles = useToolEventsStore((state) => state.newFiles);
  const newFileSet = useMemo(() => new Set(newFiles), [newFiles]);

  const loadDirectory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listDirectory(sessionId, path);
      setEntries(
        [...next].sort((left, right) =>
          left.type === right.type
            ? left.name.localeCompare(right.name)
            : left.type === "directory"
              ? -1
              : 1,
        ),
      );
    } catch (err) {
      setEntries([]);
      setError(err instanceof Error ? err.message : "无法读取目录");
    } finally {
      setLoading(false);
    }
  }, [listDirectory, path, sessionId]);

  useEffect(() => {
    void sessionId;
    setPath(".");
    setSelectedPath(null);
    setPreview(null);
  }, [sessionId]);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const openFile = useCallback(
    async (filePath: string) => {
      setSelectedPath(filePath);
      setPreview(null);
      setPreviewLoading(true);
      try {
        const blob = await getFile(sessionId, filePath);
        if (!canPreviewText(blob, filePath)) {
          setPreview(`二进制文件 · ${blob.type || "未知类型"} · ${blob.size} bytes`);
          return;
        }
        const text = await blob.text();
        setPreview(text.length > 200_000 ? `${text.slice(0, 200_000)}\n\n…预览已截断` : text);
      } catch (err) {
        setPreview(err instanceof Error ? err.message : "无法读取文件");
      } finally {
        setPreviewLoading(false);
      }
    },
    [getFile, sessionId],
  );

  if (selectedPath) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <button
          type="button"
          onClick={() => {
            setSelectedPath(null);
            setPreview(null);
          }}
          className="flex items-center gap-2 border-b border-line px-2 py-2 text-left font-mono text-[11px] text-muted hover:bg-hover hover:text-foreground"
        >
          <ArrowLeft size={13} />
          <span className="truncate">{selectedPath}</span>
        </button>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {previewLoading ? (
            <LoaderCircle className="mx-auto mt-10 animate-spin text-muted" size={18} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-foreground">
              {preview}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-2">
        <button
          type="button"
          disabled={path === "."}
          onClick={() => setPath(parentPath(path))}
          className="rounded-r1 p-1 text-muted hover:bg-hover disabled:opacity-30"
          aria-label="返回上级目录"
        >
          <ArrowLeft size={13} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">
          {path === "." ? "/" : `/${path}`}
        </span>
        <button
          type="button"
          onClick={() => void loadDirectory()}
          className="rounded-r1 p-1 text-muted hover:bg-hover"
          aria-label="刷新文件"
        >
          <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && <p className="p-3 text-[11px] text-danger">{error}</p>}
        {!error && !loading && entries.length === 0 && (
          <p className="py-10 text-center font-mono text-[11px] text-faint">目录为空</p>
        )}
        {entries.map((entry) => {
          const entryPath = joinPath(path, entry.name);
          const isNew = newFileSet.has(entryPath);
          return (
            <button
              key={`${entry.type}:${entry.name}`}
              type="button"
              onClick={() =>
                entry.type === "directory" ? setPath(entryPath) : void openFile(entryPath)
              }
              className="flex w-full items-center gap-2 rounded-r1 px-2 py-1.5 text-left hover:bg-hover"
            >
              {entry.type === "directory" ? (
                <Folder size={13} className="shrink-0 text-warning" />
              ) : (
                <FileText size={13} className="shrink-0 text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {entry.name}
              </span>
              {isNew && (
                <span className="rounded bg-success/10 px-1 text-[9px] text-success">NEW</span>
              )}
              {entry.size !== undefined && entry.type === "file" && (
                <span className="font-mono text-[9px] text-faint">{entry.size} B</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
