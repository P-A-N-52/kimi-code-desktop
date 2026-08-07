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
import { isAskUserToolCall } from "@/modules/statusbar/permission-mode";
import { Expandable } from "@/ui/expandable";
import { StatusDot } from "@/ui/status-dot";
import { AgentToolCard } from "./agent-tool-card";
import { Attachments } from "./attachments";
import { findDiffDisplay } from "./diff-display";
import { computeDiffLines } from "./diff-view";
import { SwarmToolCard } from "./swarm-tool-card";
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
  const candidate =
    r.description ?? r.file_path ?? r.path ?? r.command ?? r.pattern ?? r.query ?? r.cmd;
  if (typeof candidate === "string") {
    return candidate.length > 80 ? `${candidate.slice(0, 80)}…` : candidate;
  }
  const json = JSON.stringify(input);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

function isRunningState(state: ToolCall["state"]): boolean {
  return state === "input-streaming" || state === "input-available";
}

/** Match Rust `canonical_agent_tool_name` swarm shape — history/edge titles may not say AgentSwarm. */
function looksLikeAgentSwarm(toolCall: ToolCall): boolean {
  if (getToolPresentation(toolCall.title).canonicalName === "AgentSwarm") return true;
  if (typeof toolCall.input !== "object" || toolCall.input === null) return false;
  const r = toolCall.input as Record<string, unknown>;
  return (
    r.prompt_template != null ||
    r.promptTemplate != null ||
    r.resume_agent_ids != null ||
    r.resumeAgentIds != null
  );
}

/** Single Agent / Task tools (not swarm). History titles may be free-form descriptions. */
function looksLikeAgent(toolCall: ToolCall): boolean {
  // Ask User must never render as the Agent/subagent card — ACP titles are
  // free-form descriptions ("Asking user questions") and Agent heuristics
  // can otherwise steal the row before QuestionRequest arrives.
  if (isAskUserToolCall(toolCall)) return false;
  if (looksLikeAgentSwarm(toolCall)) return false;
  const name = getToolPresentation(toolCall.title).canonicalName;
  if (name === "Agent" || name === "Task" || name === "CreateSubagent") return true;
  if (typeof toolCall.input !== "object" || toolCall.input === null) return false;
  const r = toolCall.input as Record<string, unknown>;
  const hasType = r.subagent_type != null || r.subagentType != null;
  const hasPrompt = r.prompt != null;
  return hasType && hasPrompt;
}

function GenericToolCard({
  toolCall,
  presentation,
  defaultOpen,
}: {
  toolCall: ToolCall;
  presentation: ToolPresentation;
  defaultOpen?: boolean;
}) {
  const Icon = toolIcon(presentation);
  const extrasInProgress = toolCall.extras?.in_progress === true;
  // Generic tools must not treat subagent flags as running — those belong to
  // Agent/Swarm cards only. Progress ticks use extras.in_progress.
  const running = isRunningState(toolCall.state) || extrasInProgress;
  const [open, setOpen] = useState(defaultOpen ?? running);
  const diff = findDiffDisplay(toolCall.display);
  const diffStats = diff ? computeDiffLines(diff) : null;

  let status: React.ReactNode = null;
  if (running) {
    status = <StatusDot status="running" />;
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
        aria-expanded={open}
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
          className={cn(
            "shrink-0 text-faint transition-transform duration-[160ms] ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      <Expandable open={open} data-slot="tool-body">
        <div className="border-t border-line">
          {toolCall.isError && toolCall.errorText ? (
            <div className="p-3 font-mono text-[11.5px] text-danger">{toolCall.errorText}</div>
          ) : toolCall.display?.length ? (
            <ToolDisplayContent display={toolCall.display} />
          ) : toolCall.output ? (
            <TermView output={toolCall.output} />
          ) : !toolCall.mediaParts?.length ? (
            <div className="p-3 font-mono text-[11px] text-faint">（无输出）</div>
          ) : null}
          {toolCall.mediaParts?.length ? (
            <div className="border-t border-line p-3">
              <Attachments
                parts={toolCall.mediaParts.map((part) => ({
                  type: "file" as const,
                  mediaType:
                    part.type === "image_url"
                      ? "image/*"
                      : part.type === "video_url"
                        ? "video/*"
                        : "audio/*",
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
        </div>
      </Expandable>
    </div>
  );
}

export function ToolCard({ toolCall, defaultOpen }: { toolCall: ToolCall; defaultOpen?: boolean }) {
  const presentation = getToolPresentation(toolCall.title);
  if (looksLikeAgentSwarm(toolCall)) {
    return <SwarmToolCard toolCall={toolCall} />;
  }
  if (looksLikeAgent(toolCall)) {
    return <AgentToolCard toolCall={toolCall} defaultOpen={defaultOpen} />;
  }
  return (
    <GenericToolCard toolCall={toolCall} presentation={presentation} defaultOpen={defaultOpen} />
  );
}
