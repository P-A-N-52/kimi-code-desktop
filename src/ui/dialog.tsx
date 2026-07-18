import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
	className,
	children,
	...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
			<DialogPrimitive.Content
				className={cn(
					"fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-r3 border border-line-strong bg-elevated p-5 shadow-pop focus:outline-none",
					className,
				)}
				{...props}
			>
				{children}
				<DialogPrimitive.Close
					aria-label="关闭"
					className="absolute right-3.5 top-3.5 flex size-[26px] items-center justify-center rounded-r1 text-muted transition-colors hover:bg-hover hover:text-foreground"
				>
					<X size={13} strokeWidth={1.5} />
				</DialogPrimitive.Close>
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}

export function DialogTitle({
	className,
	...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			className={cn("text-[14px] font-semibold text-foreground", className)}
			{...props}
		/>
	);
}

export function DialogDescription({
	className,
	...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			className={cn("mt-1 text-[12.5px] text-muted", className)}
			{...props}
		/>
	);
}
