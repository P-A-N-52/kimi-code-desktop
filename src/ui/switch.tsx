import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Switch({
	className,
	...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			className={cn(
				"inline-flex h-[18px] w-[32px] items-center rounded-full border border-line-strong bg-secondary transition-colors data-[state=checked]:border-bright data-[state=checked]:bg-bright disabled:cursor-not-allowed disabled:border-line disabled:bg-hover disabled:opacity-60 disabled:data-[state=checked]:border-line disabled:data-[state=checked]:bg-muted",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb className="block size-[14px] translate-x-[2px] rounded-full bg-muted transition-transform data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-background data-[disabled]:bg-faint data-[disabled]:data-[state=checked]:bg-secondary" />
		</SwitchPrimitive.Root>
	);
}
