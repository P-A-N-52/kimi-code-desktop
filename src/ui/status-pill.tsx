import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const pillVariants = cva(
	"inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 font-mono text-[11px] font-medium transition-colors",
	{
		variants: {
			tone: {
				neutral: "text-muted hover:bg-hover hover:text-foreground",
				amber: "border-warn/30 bg-warn-bg text-warn",
				red: "border-danger/30 bg-danger-bg text-danger",
			},
			on: {
				true: "border-line-strong bg-active text-bright",
				false: "",
			},
		},
		defaultVariants: { tone: "neutral", on: false },
	},
);

export function StatusPill({
	className,
	tone,
	on,
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof pillVariants> & { children: ReactNode }) {
	return (
		<button
			type="button"
			className={cn(pillVariants({ tone, on }), className)}
			{...props}
		>
			{on !== undefined && (
				<span
					className={cn(
						"size-[5px] rounded-full bg-current opacity-0 transition-opacity",
						on && "opacity-100",
					)}
				/>
			)}
			{children}
		</button>
	);
}
