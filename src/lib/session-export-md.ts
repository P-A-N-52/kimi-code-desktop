import type { LiveMessage, MessageAttachmentPart } from "@/hooks/types";

/** Documented limits for Desktop-local Markdown export (not CLI `/export-md`). */
export const SESSION_EXPORT_LIMITS = [
  "基于 Desktop 当前已渲染消息导出，格式与 CLI `/export-md` 不完全相同。",
  "不含二进制附件内容，仅列出附件文件名或类型。",
  "工具输出为摘要；审批与工具 extras 未做额外脱敏，分享前请自行检查。",
  "未连接 live 流时会话内容来自 wire.jsonl replay，可能与当前 UI 存在短暂差异。",
] as const;

function attachmentLabel(part: MessageAttachmentPart): string {
  if ("filename" in part && part.filename) return part.filename;
  if ("url" in part && part.url) return part.url;
  return "attachment";
}

function formatAttachments(parts: MessageAttachmentPart[] | undefined): string {
  if (!parts?.length) return "";
  const lines = parts.map((part) => `- ${attachmentLabel(part)}`);
  return `\n\n_Attachments:_\n${lines.join("\n")}`;
}

function formatToolMessage(message: LiveMessage): string {
  const tc = message.toolCall;
  if (!tc) return "";
  const lines = [`### Tool: ${tc.title}`];
  if (tc.input !== undefined) {
    lines.push("", "**Input:**", "```json", JSON.stringify(tc.input, null, 2), "```");
  }
  if (tc.output) {
    lines.push("", "**Output:**", "```", String(tc.output), "```");
  } else if (tc.message) {
    lines.push("", tc.message);
  }
  if (tc.isError && tc.errorText) {
    lines.push("", `_Error:_ ${tc.errorText}`);
  }
  return lines.join("\n");
}

function formatThinkingMessage(message: LiveMessage): string {
  if (!message.thinking?.trim()) return "";
  return `_Thinking (${message.thinkingDuration ?? "?"}s):_\n\n${message.thinking.trim()}`;
}

function formatUserMessage(message: LiveMessage): string {
  const label = message.variant === "steer" ? "Steer" : "User";
  const body = message.content?.trim() ?? "";
  return `## ${label}\n\n${body}${formatAttachments(message.attachments)}`;
}

function formatAssistantMessage(message: LiveMessage): string {
  switch (message.variant) {
    case "tool":
      return formatToolMessage(message);
    case "thinking":
      return formatThinkingMessage(message);
    case "code":
      return message.codeSnippet
        ? `\`\`\`${message.codeSnippet.language}\n${message.codeSnippet.code}\n\`\`\``
        : "";
    case "status":
    case "message-id":
      return "";
    default:
      return message.content?.trim()
        ? `${message.content.trim()}${formatAttachments(message.attachments)}`
        : "";
  }
}

export function messagesToSessionMarkdown(args: {
  title: string;
  sessionId?: string;
  workDir?: string | null;
  messages: readonly LiveMessage[];
  exportedAt?: Date;
}): string {
  const exportedAt = args.exportedAt ?? new Date();
  const header = [
    `# ${args.title.trim() || "Kimi Code Session"}`,
    "",
    `> Exported from Kimi Code Desktop at ${exportedAt.toISOString()}`,
    args.sessionId ? `> Session ID: \`${args.sessionId}\`` : null,
    args.workDir ? `> Work directory: \`${args.workDir}\`` : null,
    "",
    "## Export limits",
    ...SESSION_EXPORT_LIMITS.map((line) => `- ${line}`),
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const body: string[] = [];
  for (const message of args.messages) {
    if (message.role === "user") {
      const block = formatUserMessage(message);
      if (block.trim()) body.push(block);
      continue;
    }
    const block = formatAssistantMessage(message);
    if (!block.trim()) continue;
    if (
      message.variant === "tool" ||
      message.variant === "thinking" ||
      message.variant === "code"
    ) {
      body.push(block);
    } else {
      body.push(`## Assistant\n\n${block}`);
    }
  }

  if (body.length === 0) {
    body.push("_No exportable messages in the current session view._");
  }

  return `${header}${body.join("\n\n")}\n`;
}

export function defaultSessionExportFilename(title: string, sessionId?: string): string {
  const slug = (title.trim() || "session")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const suffix = sessionId ? `-${sessionId.slice(0, 8)}` : "";
  return `${slug || "session"}${suffix}.md`;
}
