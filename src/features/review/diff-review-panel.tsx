import { FileDiffIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Diff } from "@/components/ui/diff";
import { parseDiff } from "@/components/ui/diff/utils";
import type { DiffProps } from "@/components/ui/diff";
import { DiffReviewActions } from "./diff-review-actions";

interface DiffReviewPanelProps {
  className?: string;
  diffText?: string;
  fileName?: string;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  onAcceptHunk?: (hunkIndex: number) => void;
  onRejectHunk?: (hunkIndex: number) => void;
}

const MOCK_DIFF = `diff --git a/src/example.ts b/src/example.ts
index 1234567..abcdefg 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,5 +1,5 @@
 export function greet(name: string): string {
-  return "Hello, " + name;
+  return \`Hello, \${name}!\`;
 }
 
 export function farewell(name: string): string {
@@ -10,6 +10,10 @@
   return "Goodbye, " + name;
 }
 
+export function welcome(name: string): string {
+  return "Welcome, " + name;
+}
+
 export const VERSION = "1.0.0";
`;

export function DiffReviewPanel({
  className,
  diffText = MOCK_DIFF,
  fileName = "src/example.ts",
  onAcceptAll,
  onRejectAll,
  onAcceptHunk,
  onRejectHunk,
}: DiffReviewPanelProps) {
  const files = parseDiff(diffText);
  const firstFile = files[0];
  const hunks = firstFile?.hunks ?? [];

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="border-b px-3 py-3">
        <div className="flex items-center gap-2">
          <FileDiffIcon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Diff Review</h2>
          {fileName ? (
            <span className="truncate text-xs text-muted-foreground">{fileName}</span>
          ) : null}
        </div>
      </div>

      <div className="border-b p-3">
        <DiffReviewActions
          onAcceptAll={onAcceptAll}
          onRejectAll={onRejectAll}
          onAcceptHunk={onAcceptHunk}
          onRejectHunk={onRejectHunk}
          hunkCount={hunks.length}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {files.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center text-muted-foreground">
              <FileDiffIcon className="size-6 opacity-50" />
              <p className="text-sm font-medium">No diff to review</p>
            </div>
          ) : (
            files.map((file) => (
              <div key={file.newPath ?? fileName} className="mb-4">
                {file.newPath ? (
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    {file.newPath}
                  </div>
                ) : null}
                <div className="overflow-hidden rounded-lg border">
                  <Diff
                    hunks={file.hunks}
                    type={file.type}
                    fileName={file.newPath ?? fileName}
                    className="text-[0.75rem]"
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
