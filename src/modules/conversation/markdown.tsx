import type { StreamdownProps } from "streamdown";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

const mathPlugin = defaultRemarkPlugins.math;
const remarkMathWithInline = (
	Array.isArray(mathPlugin)
		? [mathPlugin[0], { ...mathPlugin[1], singleDollarTextMath: true }]
		: [mathPlugin, { singleDollarTextMath: true }]
) as typeof mathPlugin;

const remarkPlugins: StreamdownProps["remarkPlugins"] = [
	defaultRemarkPlugins.gfm,
	remarkMathWithInline,
	defaultRemarkPlugins.cjkFriendly,
];

const rehypePlugins: StreamdownProps["rehypePlugins"] = [
	defaultRehypePlugins.katex,
];

export function Markdown({ content, className }: { content: string; className?: string }) {
	return (
		<div className={cn("text-[14px] leading-[1.65] [&_code]:rounded [&_code]:border [&_code]:border-line [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12px] [&_p]:mb-2.5 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-r2 [&_pre]:border [&_pre]:border-line [&_pre]:bg-elevated [&_pre]:p-3 [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0", className)}>
			<Streamdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
				{content}
			</Streamdown>
		</div>
	);
}
