import { useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import type { QuestionItem } from "@/hooks/wireTypes";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

type Question = NonNullable<NonNullable<LiveMessage["toolCall"]>["question"]>;

function QuestionField({
	item,
	value,
	onChange,
}: {
	item: QuestionItem;
	value: string;
	onChange: (v: string) => void;
}) {
	const [otherText, setOtherText] = useState("");
	const selected = value ? value.split("|||") : [];
	const toggle = (label: string) => {
		if (item.multi_select) {
			const next = selected.includes(label)
				? selected.filter((s) => s !== label)
				: [...selected, label];
			onChange(next.join("|||"));
		} else {
			onChange(label);
		}
	};
	return (
		<div className="mb-3 last:mb-0">
			<div className="mb-1.5 text-[12.5px] font-medium text-foreground">
				{item.header}
			</div>
			{item.body && <div className="mb-1.5 text-[12px] text-muted">{item.body}</div>}
			<div className="flex flex-col gap-1">
				{item.options.map((opt) => {
					const active = selected.includes(opt.label);
					return (
						<button
							key={opt.label}
							type="button"
							onClick={() => toggle(opt.label)}
							className={cn(
								"rounded-r1 border px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
								active
									? "border-line-strong bg-active text-foreground"
									: "border-line text-muted hover:bg-hover hover:text-foreground",
							)}
						>
							<div>{opt.label}</div>
							{opt.description && (
								<div className="text-[11px] text-faint">{opt.description}</div>
							)}
						</button>
					);
				})}
				{item.other_label && (
					<input
						value={otherText}
						onChange={(e) => {
							setOtherText(e.target.value);
							onChange(e.target.value);
						}}
						placeholder={item.other_label}
						className="h-8 rounded-r1 border border-line bg-background px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-faint focus:border-line-strong"
					/>
				)}
			</div>
		</div>
	);
}

export function QuestionCard({
	question,
	onRespond,
}: {
	question: Question;
	onRespond: (requestId: string, answers: Record<string, string>) => void;
}) {
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const resolved = question.resolved || question.submitted;

	return (
		<div className="my-3 overflow-hidden rounded-r2 border border-line bg-elevated">
			<div className="border-b border-line px-3 py-2.5 text-[13px] font-medium text-foreground">
				Kimi 想确认几个问题
			</div>
			<div className="px-3 py-2.5">
				{question.questions.map((q) => (
					<QuestionField
						key={q.header}
						item={q}
						value={answers[q.header] ?? ""}
						onChange={(v) => setAnswers((prev) => ({ ...prev, [q.header]: v }))}
					/>
				))}
			</div>
			<div className="flex items-center gap-2 px-3 pb-3">
				{resolved ? (
					<span className="font-mono text-[11px] text-muted">已提交</span>
				) : (
					<Button
						variant="primary"
						onClick={() => onRespond(question.id, answers)}
					>
						提交
					</Button>
				)}
			</div>
		</div>
	);
}
