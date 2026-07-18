import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CodeBlock({
	code,
	language,
}: {
	code: string;
	language?: string;
}) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		await navigator.clipboard.writeText(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div className="my-3 overflow-hidden rounded-r2 border border-line bg-elevated">
			<div className="flex items-center justify-between border-b border-line bg-secondary px-3 py-1.5">
				<span className="font-mono text-[11px] text-muted">{language ?? "code"}</span>
				<button
					type="button"
					onClick={copy}
					className="flex items-center gap-1 font-mono text-[11px] text-faint transition-colors hover:text-foreground"
				>
					{copied ? <Check size={11} strokeWidth={1.5} /> : <Copy size={11} strokeWidth={1.5} />}
					{copied ? "已复制" : "复制"}
				</button>
			</div>
			<pre className="overflow-x-auto p-3 font-mono text-[12px] leading-[1.75] text-foreground">
				{code}
			</pre>
		</div>
	);
}
