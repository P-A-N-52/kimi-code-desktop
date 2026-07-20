export function StreamingCaret() {
	return (
		<span
			data-testid="streaming-caret"
			aria-hidden
			className="ml-0.5 inline-block h-[15px] w-[7px] animate-blink rounded-[1px] bg-foreground align-text-bottom"
		/>
	);
}
