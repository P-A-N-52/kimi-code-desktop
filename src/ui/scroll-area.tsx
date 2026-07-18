import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({
	className,
	children,
	...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root>) {
	return (
		<ScrollAreaPrimitive.Root
			className={cn("relative overflow-hidden", className)}
			{...props}
		>
			<ScrollAreaPrimitive.Viewport className="size-full">
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollAreaPrimitive.Scrollbar
				orientation="vertical"
				className="flex w-2 p-px"
			>
				<ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-line-strong" />
			</ScrollAreaPrimitive.Scrollbar>
		</ScrollAreaPrimitive.Root>
	);
}
