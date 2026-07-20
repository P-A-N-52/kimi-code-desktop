import {
  Bot,
  ChevronRight,
  FileText,
  ListChecks,
  Map as MapIcon,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  Target,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import { getToolPresentation, type ToolPresentation } from "@/lib/tool-events/tool-registry";
import { cn } from "@/lib/utils";
import { Attachments } from "./attachments";
import { findDiffDisplay } from "./diff-display";
import { computeDiffLines } from "./diff-view";
import { SubagentSteps } from "./subagent-steps";
import { TermView } from "./term-view";
import { ToolDisplayContent } from "./tool-display-content";

type ToolCall = NonNullable<LiveMessage["toolCall"]>;

function toolIcon(presentation: ToolPresentation) {
  if (presentation.category === "shell") return SquareTerminal;
  if (presentation.category === "search") return Search;
  if (presentation.category === "agent" || presentation.category === "task") return Bot;
  if (presentation.category === "todo") return ListChecks;
  if (presentation.category === "goal") return Target;
  if (presentation.category === "plan") return MapIcon;
  if (presentation.category === "skill") return Sparkles;
  if (presentation.category === "file") {
    return /write|edit|replace/i.test(presentation.canonicalName) ? Pencil : FileText;
  }
  return Wrench;
}

function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const r = input as Record<string, unknown>;
  const candidate = r.file_path ?? r.path ?? r.command ?? r.pattern ?? r.query ?? r.cmd;
  if (typeof candidate === "string") {
    return candidate.length > 80 ? `${candidate.slice(0, 80)}…` : candidate;
  }
  const json = JSON.stringify(input);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

function isRunningState(state: ToolCall["state"]): boolean {
  return state === "input-streaming" || state === "input-available";
}

export function ToolCard({ toolCall, defaultOpen }: { toolCall: ToolCall; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const presentation = getToolPresentation(toolCall.title);
  const Icon = toolIcon(presentation);
  const running = isRunningState(toolCall.state) || toolCall.subagentRunning === true;
  const diff = findDiffDisplay(toolCall.display);
  const diffStats = diff ? computeDiffLines(diff) : null;

  let status: React.ReactNode = null;
  if (running) {
    status = (
      <span className="size-[10px] animate-spin rounded-full border border-muted border-t-transparent" />
    );
  } else if (toolCall.isError) {
    status = <span className="font-mono text-[11px] text-danger">✗ 失败</span>;
  } else if (diffStats) {
    status = (
      <span className="font-mono text-[11px]">
        <span className="text-success">+{diffStats.adds}</span>{" "}
        <span className="text-danger">−{diffStats.dels}</span>
      </span>
    );
  } else if (toolCall.state === "output-available") {
    status = <span className="font-mono text-[11px] text-success">✓</span>;
  }

  return (
    <div className="my-2.5 overflow-hidden rounded-r2 border border-line bg-elevated">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover"
      >
        <Icon size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
        <span className="font-mono text-[12px] font-semibold text-foreground">
          {presentation.displayName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
          {summarizeInput(toolCall.input)}
        </span>
        {status}
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div data-slot="tool-body" className="border-t border-line">
          {toolCall.isError && toolCall.errorText ? (
            <div className="p-3 font-mono text-[11.5px] text-danger">{toolCall.errorText}</div>
          ) : toolCall.display?.length ? (
            <ToolDisplayContent display={toolCall.display} />
          ) : toolCall.output ? (
            <TermView output={toolCall.output} />
          ) : !toolCall.mediaParts?.length &&
            !toolCall.subagentSteps?.length &&
            !toolCall.subagentRunning ? (
            <div className="p-3 font-mono text-[11px] text-faint">（无输出）</div>
          ) : null}
          {toolCall.mediaParts?.length ? (
            <div className="border-t border-line p-3">
              <Attachments
                parts={toolCall.mediaParts.map((part) => ({
                  type: "file" as const,
                  mediaType: part.type === "image_url" ? "image/*" : "video/*",
                  filename: (() => {
                    try {
                      return new URL(part.url).pathname.split("/").pop() || "media";
                    } catch {
                      return "media";
                    }
                  })(),
                  url: part.url,
                }))}
              />
            </div>
          ) : null}
          <SubagentSteps
            steps={toolCall.subagentSteps}
            running={toolCall.subagentRunning}
            agentType={toolCall.subagentType}
          />
        </div>
      )}
    </div>
  );
}
