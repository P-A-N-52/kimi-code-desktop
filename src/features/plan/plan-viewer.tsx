import { FileTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Streamdown } from "streamdown";
import {
  safeRehypePlugins,
  safeRemarkPlugins,
  streamdownComponents,
  streamdownRootClass,
  escapeHtmlOutsideCodeBlocks,
} from "@/components/ai-elements/streamdown";
import type { PlanDisplayEvent } from "@/hooks/wireTypes";

interface PlanViewerProps {
  className?: string;
  plan?: PlanDisplayEvent["payload"] | null;
}

const MOCK_PLAN: PlanDisplayEvent["payload"] = {
  content: `# Plan: Implement Side Chat Feature

## Overview
Add a floating/drawer side chat panel for parallel conversations outside the main session.

## Steps

1. **Create Store**
   - Define Zustand store for messages, isOpen, inputText
   - Actions: addMessage, toggleOpen, sendMessage

2. **Create Hook**
   - Wrap store logic in useSideChat hook
   - Handle Enter key to send

3. **Create Panel Component**
   - 400px width, slide from right
   - Message list with ScrollArea
   - Textarea input with send button
   - Floating trigger when closed

## Acceptance Criteria
- [x] Store created
- [ ] Panel UI complete
- [ ] WebSocket wired up
`,
  file_path: ".kimi/plans/side-chat.md",
};

export function PlanViewer({ className, plan }: PlanViewerProps) {
  const data = plan ?? MOCK_PLAN;
  const safeContent = escapeHtmlOutsideCodeBlocks(data.content);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="border-b px-3 py-3">
        <div className="flex items-center gap-2">
          <FileTextIcon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Plan</h2>
        </div>
        {data.file_path ? (
          <p className="mt-1 truncate text-xs text-muted-foreground" title={data.file_path}>
            {data.file_path}
          </p>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("prose prose-sm max-w-none p-4 dark:prose-invert", streamdownRootClass)}>
          <Streamdown
            components={streamdownComponents}
            rehypePlugins={safeRehypePlugins}
            remarkPlugins={safeRemarkPlugins}
          >
            {safeContent}
          </Streamdown>
        </div>
      </ScrollArea>
    </div>
  );
}
