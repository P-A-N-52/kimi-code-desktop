import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function IconButton({
	label,
	active,
	className,
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	label: string;
	active?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className={cn(
				"flex size-[30px] items-center justify-center rounded-r1 text-muted transition-colors hover:bg-hover hover:text-foreground",
				active && "bg-active text-bright",
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}
