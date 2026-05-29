import { useCallback, useState } from "react";
import { Edit3Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import type { PlanDisplayEvent } from "@/hooks/wireTypes";

interface PlanEditorProps {
  className?: string;
  plan?: PlanDisplayEvent["payload"] | null;
  onChange?: (content: string) => void;
  readOnly?: boolean;
}

const MOCK_PLAN_CONTENT = `# Plan: Implement Side Chat Feature

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
`;

export function PlanEditor({
  className,
  plan,
  onChange,
  readOnly = false,
}: PlanEditorProps) {
  const initialContent = plan?.content ?? MOCK_PLAN_CONTENT;
  const [content, setContent] = useState(initialContent);

  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      onChange?.(value);
    },
    [onChange],
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="border-b px-3 py-3">
        <div className="flex items-center gap-2">
          <Edit3Icon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Edit Plan</h2>
        </div>
        {plan?.file_path ? (
          <p className="mt-1 truncate text-xs text-muted-foreground" title={plan.file_path}>
            {plan.file_path}
          </p>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <CodeMirror
            value={content}
            height="100%"
            minHeight="300px"
            extensions={[yaml()]}
            onChange={handleChange}
            readOnly={readOnly}
            theme="dark"
            className="overflow-hidden rounded-lg border text-sm"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightActiveLine: true,
              foldGutter: true,
            }}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
