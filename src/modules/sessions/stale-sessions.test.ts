import { describe, expect, it } from "vitest";
import type { Session } from "@/lib/api/models";
import { selectSessionsOlderThan, STALE_ARCHIVE_DAYS } from "./stale-sessions";

function session(
	id: string,
	daysAgo: number,
	extra: Partial<Session> = {},
): Session {
	const now = new Date("2026-07-22T12:00:00Z");
	return {
		sessionId: id,
		title: id,
		lastUpdated: new Date(now.getTime() - daysAgo * 86_400_000),
		...extra,
	};
}

describe("selectSessionsOlderThan", () => {
	const now = new Date("2026-07-22T12:00:00Z");

	it("selects only sessions older than the cutoff", () => {
		const sessions = [
			session("fresh", 1),
			session("edge-new", 30),
			session("stale", 31),
			session("older", 90),
		];
		const stale = selectSessionsOlderThan(sessions, STALE_ARCHIVE_DAYS, now);
		expect(stale.map((s) => s.sessionId)).toEqual(["stale", "older"]);
	});

	it("skips running sessions", () => {
		const sessions = [session("busy", 60, { isRunning: true }), session("idle", 60)];
		const stale = selectSessionsOlderThan(sessions, STALE_ARCHIVE_DAYS, now);
		expect(stale.map((s) => s.sessionId)).toEqual(["idle"]);
	});
});
