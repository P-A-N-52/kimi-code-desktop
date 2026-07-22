import type { Session } from "@/lib/api/models";

/** Default cutoff for one-click stale archive (last activity). */
export const STALE_ARCHIVE_DAYS = 30;

/** Day options offered by the one-click archive control. */
export const STALE_ARCHIVE_DAY_OPTIONS = [30, 60, 90] as const;

export type StaleArchiveDays = (typeof STALE_ARCHIVE_DAY_OPTIONS)[number];

const DAY_MS = 86_400_000;

/**
 * Sessions whose last activity (`lastUpdated`) is older than `days` before `now`.
 * Skips currently running sessions.
 */
export function selectSessionsOlderThan(
	sessions: Session[],
	days: number = STALE_ARCHIVE_DAYS,
	now: Date = new Date(),
): Session[] {
	const cutoff = now.getTime() - days * DAY_MS;
	return sessions.filter((session) => {
		if (session.isRunning) return false;
		const updated = new Date(session.lastUpdated).getTime();
		if (Number.isNaN(updated)) return false;
		return updated < cutoff;
	});
}
