import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-1.5 rounded-r1 text-[12.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				primary: "bg-bright text-background hover:opacity-85",
				ghost: "border border-line-strong text-muted hover:bg-hover hover:text-foreground",
				danger: "border border-danger/40 text-danger hover:bg-danger-bg",
			},
			size: {
				sm: "h-7 px-3",
				md: "h-8 px-4",
			},
		},
		defaultVariants: { variant: "primary", size: "sm" },
	},
);

export function Button({
	className,
	variant,
	size,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonVariants>) {
	return (
		<button
			type="button"
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
