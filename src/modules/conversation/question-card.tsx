import { useState } from "react";
import type { LiveMessage } from "@/hooks/types";
import type { QuestionItem } from "@/hooks/wireTypes";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

type Question = NonNullable<NonNullable<LiveMessage["toolCall"]>["question"]>;

const DEFAULT_OTHER_LABEL = "其他";

function QuestionField({
	item,
	value,
	onChange,
	readOnly,
}: {
	item: QuestionItem;
	value: string;
	onChange: (v: string) => void;
	readOnly?: boolean;
}) {
	const otherLabel = item.other_label?.trim() || DEFAULT_OTHER_LABEL;
	const optionLabels = item.options.map((opt) => opt.label);
	const isOptionSelected = optionLabels.includes(value);
	const [otherText, setOtherText] = useState(
		value && !isOptionSelected ? value : "",
	);
	const selected = value ? value.split("|||") : [];
	const toggle = (label: string) => {
		if (readOnly) return;
		setOtherText("");
		if (item.multi_select) {
			const next = selected.includes(label)
				? selected.filter((s) => s !== label)
				: [...selected, label];
			onChange(next.join("|||"));
		} else {
			onChange(label);
		}
	};
	const selectOther = (text: string) => {
		if (readOnly) return;
		setOtherText(text);
		onChange(text);
	};
	return (
		<div className="mb-3 last:mb-0">
			<div className="mb-1.5 text-[12.5px] font-medium text-foreground">
				{item.header}
			</div>
			{item.body && <div className="mb-1.5 text-[12px] text-muted">{item.body}</div>}
			{readOnly ? (
				value.trim() ? (
					<div className="rounded-r1 border border-line bg-background px-2.5 py-1.5 text-[12.5px] text-foreground">
						{value.split("|||").join("、")}
					</div>
				) : (
					<div className="text-[12px] text-faint">未作答</div>
				)
			) : (
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
					<input
						value={otherText}
						onChange={(e) => selectOther(e.target.value)}
						placeholder={otherLabel}
						aria-label={otherLabel}
						className={cn(
							"h-8 rounded-r1 border bg-background px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-faint focus:border-line-strong",
							otherText.trim()
								? "border-line-strong"
								: "border-line",
						)}
					/>
					{item.other_description ? (
						<div className="text-[11px] text-faint">{item.other_description}</div>
					) : null}
				</div>
			)}
		</div>
	);
}

function AnswerSummary({ answers }: { answers: Record<string, string> }) {
	const entries = Object.entries(answers).filter(([, value]) => value.trim());
	if (entries.length === 0) return null;
	return (
		<div className="space-y-2">
			{entries.map(([header, value]) => (
				<div key={header}>
					<div className="mb-1 text-[12px] font-medium text-muted">{header}</div>
					<div className="rounded-r1 border border-line bg-background px-2.5 py-1.5 text-[12.5px] text-foreground">
						{value.split("|||").join("、")}
					</div>
				</div>
			))}
		</div>
	);
}

export function QuestionCard({
	question,
	onRespond,
	dismissed,
}: {
	question: Question;
	onRespond: (requestId: string, answers: Record<string, string>) => void;
	/** True when the user skipped / dismissed without answering. */
	dismissed?: boolean;
}) {
	const [answers, setAnswers] = useState<Record<string, string>>(
		() => question.answers ?? {},
	);
	const resolved = question.resolved || question.submitted;
	const displayAnswers = question.answers ?? answers;
	const hasAnswers = Object.values(displayAnswers).some((v) => v.trim().length > 0);
	const canSubmit =
		!resolved &&
		question.questions.some((q) => (answers[q.header] ?? "").trim().length > 0);

	return (
		<div className="my-3 overflow-hidden rounded-r2 border border-line bg-elevated">
			<div className="border-b border-line px-3 py-2.5 text-[13px] font-medium text-foreground">
				Kimi 想确认几个问题
			</div>
			<div className="px-3 py-2.5">
				{question.questions.length > 0 ? (
					question.questions.map((q) => (
						<QuestionField
							key={q.header}
							item={q}
							value={
								resolved
									? (displayAnswers[q.header] ?? "")
									: (answers[q.header] ?? "")
							}
							onChange={(v) => setAnswers((prev) => ({ ...prev, [q.header]: v }))}
							readOnly={resolved}
						/>
					))
				) : resolved && hasAnswers ? (
					<AnswerSummary answers={displayAnswers} />
				) : null}
			</div>
			<div className="flex items-center gap-2 px-3 pb-3">
				{resolved ? (
					<span className="font-mono text-[11px] text-muted">
						{dismissed || !hasAnswers ? "已跳过，未作答" : "已提交"}
					</span>
				) : (
					<Button
						variant="primary"
						disabled={!canSubmit}
						onClick={() => onRespond(question.id, answers)}
					>
						提交
					</Button>
				)}
			</div>
		</div>
	);
}
