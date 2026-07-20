import { CheckCircle2, Circle, Clock3, ExternalLink } from "lucide-react";
import { isSafeBrowserUrl } from "@/lib/safe-url";
import { parseDiffDisplay } from "./diff-display";
import { DiffView } from "./diff-view";
import { TermView } from "./term-view";

type DisplayBlock = { type: string; data: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function imageUrl(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["url", "src", "image_url", "data"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return null;
}

function SearchResults({ data }: { data: unknown }) {
  const record = asRecord(data);
  const rawItems = Array.isArray(data)
    ? data
    : Array.isArray(record?.results)
      ? record.results
      : Array.isArray(record?.items)
        ? record.items
        : [];
  if (!rawItems.length) return <JsonFallback value={data} />;

  return (
    <div className="divide-y divide-line">
      {rawItems.map((item, index) => {
        const result = asRecord(item);
        if (!result) return null;
        const title = String(result.title ?? result.name ?? `Result ${index + 1}`);
        const rawUrl = typeof result.url === "string" ? result.url : null;
        const url = rawUrl && isSafeBrowserUrl(rawUrl) ? rawUrl : null;
        const snippet = result.snippet ?? result.description ?? result.content;
        return (
          <div key={String(result.id ?? url ?? `${title}:${pretty(item)}`)} className="px-3 py-2.5">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-[12px] font-medium text-foreground hover:underline"
              >
                {title}
                <ExternalLink size={10} strokeWidth={1.5} />
              </a>
            ) : (
              <div className="text-[12px] font-medium text-foreground">{title}</div>
            )}
            {snippet ? (
              <p className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-muted">
                {String(snippet)}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TodoItems({ data }: { data: unknown }) {
  const record = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.todos)
        ? record.todos
        : [];
  if (!items.length) return <JsonFallback value={data} />;

  return (
    <div className="space-y-1 p-3">
      {items.map((item) => {
        const recordItem = asRecord(item);
        const title = String(recordItem?.title ?? recordItem?.text ?? item);
        const status = String(recordItem?.status ?? "pending");
        const Icon =
          status === "done" || status === "completed"
            ? CheckCircle2
            : status === "in_progress" || status === "running"
              ? Clock3
              : Circle;
        return (
          <div
            key={String(recordItem?.id ?? `${title}:${pretty(item)}`)}
            className="flex items-start gap-2 text-[11.5px] text-muted"
          >
            <Icon
              size={12}
              strokeWidth={1.5}
              className={
                status === "done" || status === "completed"
                  ? "mt-0.5 text-success"
                  : "mt-0.5 text-faint"
              }
            />
            <span>{title}</span>
          </div>
        );
      })}
    </div>
  );
}

function JsonFallback({ value, label }: { value: unknown; label?: string }) {
  return (
    <div className="p-3">
      {label ? (
        <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-faint">
          {label}
        </div>
      ) : null}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted">
        {pretty(value)}
      </pre>
    </div>
  );
}

function DisplayItem({ item }: { item: DisplayBlock }) {
  const raw = item.data ?? item;
  switch (item.type) {
    case "diff": {
      const diff = parseDiffDisplay(raw);
      return diff ? <DiffView data={diff} /> : <JsonFallback value={raw} label="diff" />;
    }
    case "shell": {
      const record = asRecord(raw);
      const command = typeof record?.command === "string" ? `$ ${record.command}` : "";
      const output = record?.output ?? record?.stdout ?? record?.text ?? "";
      return <TermView output={[command, String(output)].filter(Boolean).join("\n")} />;
    }
    case "todo":
      return <TodoItems data={raw} />;
    case "brief": {
      const record = asRecord(item);
      const value = record?.text ?? raw;
      return <div className="p-3 text-[11.5px] text-muted">{pretty(value)}</div>;
    }
    case "image": {
      const rawUrl = imageUrl(raw);
      const url = rawUrl && isSafeBrowserUrl(rawUrl) ? rawUrl : null;
      return url ? (
        <a href={url} target="_blank" rel="noreferrer" className="block p-3">
          <img
            src={url}
            alt="Tool result"
            loading="lazy"
            className="max-h-80 max-w-full rounded-r1 object-contain"
          />
        </a>
      ) : (
        <JsonFallback value={raw} label="image" />
      );
    }
    case "search_response":
      return <SearchResults data={raw} />;
    case "mcp_content": {
      const record = asRecord(raw);
      const content = record?.content ?? record?.text ?? raw;
      return <JsonFallback value={content} label="MCP content" />;
    }
    default:
      return <JsonFallback value={raw} label={item.type} />;
  }
}

export function ToolDisplayContent({ display }: { display?: DisplayBlock[] }) {
  if (!display?.length) return null;
  return (
    <div data-slot="tool-display" className="divide-y divide-line">
      {display.map((item) => (
        <DisplayItem key={`${item.type}:${pretty(item.data)}`} item={item} />
      ))}
    </div>
  );
}
