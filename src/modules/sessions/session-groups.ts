import type { Session } from "@/lib/api/models";

export type SessionGroup = { label: string; items: Session[] };

const DAY_MS = 86400000;

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function groupSessionsByDay(
	sessions: Session[],
	now: Date = new Date(),
): SessionGroup[] {
	const today = startOfDay(now);
	const buckets: SessionGroup[] = [
		{ label: "今天", items: [] },
		{ label: "昨天", items: [] },
		{ label: "本周", items: [] },
		{ label: "更早", items: [] },
	];
	for (const session of sessions) {
		const t = startOfDay(new Date(session.lastUpdated));
		const diff = today - t;
		if (diff <= 0) buckets[0].items.push(session);
		else if (diff < 2 * DAY_MS) buckets[1].items.push(session);
		else if (diff < 7 * DAY_MS) buckets[2].items.push(session);
		else buckets[3].items.push(session);
	}
	return buckets.filter((b) => b.items.length > 0);
}
