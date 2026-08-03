export type DiffDisplayData = {
	type: "diff";
	path: string;
	old_text: string;
	new_text: string;
	is_summary?: boolean;
};

const diffDisplayCache = new WeakMap<object, DiffDisplayData>();

export function parseDiffDisplay(data: unknown): DiffDisplayData | null {
	if (typeof data !== "object" || data === null) return null;
	const r = data as Record<string, unknown>;
	if (typeof r.old_text !== "string" || typeof r.new_text !== "string") {
		return null;
	}
	const path = typeof r.path === "string" ? r.path : "";
	const isSummary = r.is_summary === true;
	const cached = diffDisplayCache.get(data);
	if (cached) return cached;

	const parsed = {
		type: "diff" as const,
		path,
		old_text: r.old_text,
		new_text: r.new_text,
		is_summary: isSummary,
	};
	diffDisplayCache.set(data, parsed);
	return parsed;
}

export function findDiffDisplay(
	display?: Array<{ type: string; data: unknown }>,
): DiffDisplayData | null {
	if (!display) return null;
	for (const block of display) {
		const parsed = parseDiffDisplay(block?.data ?? block);
		if (parsed) return parsed;
	}
	return null;
}
