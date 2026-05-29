import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface DiffReviewActionsProps {
  className?: string;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  onAcceptHunk?: (hunkIndex: number) => void;
  onRejectHunk?: (hunkIndex: number) => void;
  hunkCount?: number;
}

export function DiffReviewActions({
  className,
  onAcceptAll,
  onRejectAll,
  onAcceptHunk,
  onRejectHunk,
  hunkCount,
}: DiffReviewActionsProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-700"
          onClick={() => {
            console.log("Accept All");
            onAcceptAll?.();
          }}
        >
          <CheckIcon className="mr-1 size-3.5" />
          Accept All
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => {
            console.log("Reject All");
            onRejectAll?.();
          }}
        >
          <XIcon className="mr-1 size-3.5" />
          Reject All
        </Button>
      </div>

      {typeof hunkCount === "number" && hunkCount > 0 && (onAcceptHunk || onRejectHunk) ? (
        <div className="space-y-1">
          {Array.from({ length: hunkCount }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs"
            >
              <span className="font-mono text-muted-foreground">Hunk {i + 1}</span>
              <div className="flex items-center gap-1">
                {onAcceptHunk ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                    onClick={() => {
                      console.log(`Accept Hunk ${i}`);
                      onAcceptHunk(i);
                    }}
                    aria-label={`Accept hunk ${i + 1}`}
                  >
                    <CheckIcon className="size-3.5" />
                  </Button>
                ) : null}
                {onRejectHunk ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      console.log(`Reject Hunk ${i}`);
                      onRejectHunk(i);
                    }}
                    aria-label={`Reject hunk ${i + 1}`}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
