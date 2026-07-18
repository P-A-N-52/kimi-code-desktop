import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
	return (
		<kbd
			className={cn(
				"rounded border border-line bg-secondary px-1 py-px font-mono text-[10px] text-faint",
				className,
			)}
			{...props}
		/>
	);
}
