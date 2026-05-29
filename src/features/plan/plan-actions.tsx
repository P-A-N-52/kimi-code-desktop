import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface PlanActionsProps {
  className?: string;
  onApprove?: () => void;
  onReject?: () => void;
  onEdit?: () => void;
}

export function PlanActions({ className, onApprove, onReject, onEdit }: PlanActionsProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button
        type="button"
        variant="default"
        size="sm"
        className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-700"
        onClick={() => {
          console.log("Approve Plan");
          onApprove?.();
        }}
      >
        <CheckIcon className="mr-1 size-3.5" />
        Approve Plan
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => {
          console.log("Reject Plan");
          onReject?.();
        }}
      >
        <XIcon className="mr-1 size-3.5" />
        Reject Plan
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
        onClick={() => {
          console.log("Edit Plan");
          onEdit?.();
        }}
      >
        <PencilIcon className="mr-1 size-3.5" />
        Edit Plan
      </Button>
    </div>
  );
}
