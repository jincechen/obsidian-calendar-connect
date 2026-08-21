import type { Moment } from "./moment-shim";
import { resolveAccounts, resolveCalendars, type BlockQuery } from "./query";
import type { CalEvent, CalendarInfo } from "./types";

// Pure data handling between the API and the renderer: filtering, ordering, the
// event cache and calendar selection. Nothing here touches the DOM or Obsidian's
// UI classes, so the tests can import it directly.

/** Whether an event survives the block's filters. Cancelled events never do. */
export function keepEvent(event: CalEvent, query: BlockQuery): boolean {
	if (event.status === "cancelled") return false;
	if (query.hideDeclined && event.selfResponse === "declined") return false;
	if (query.allDay === "exclude" && event.allDay) return false;
	if (query.allDay === "only" && !event.allDay) return false;
	return true;
}

/** All-day events sort above timed ones on the same day, then by start, then title. */
export function compareEvents(a: CalEvent, b: CalEvent): number {
	const dayDiff = a.start.clone().startOf("day").valueOf() - b.start.clone().startOf("day").valueOf();
	if (dayDiff !== 0) return dayDiff;
	if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
	return a.start.valueOf() - b.start.valueOf() || a.title.localeCompare(b.title);
}

/** Filter, order and cap a block's events. */
export function finishEvents(events: CalEvent[], query: BlockQuery): CalEvent[] {
	const kept = events.filter((event) => keepEvent(event, query)).sort(compareEvents);
	return query.limit === null ? kept : kept.slice(0, query.limit);
}

/**
 * Narrows the known calendars to what a block asked for. Unknown or ambiguous
 * terms become warnings rather than errors, so one typo does not blank a block.
 */
export function selectCalendars(
	query: Pick<BlockQuery, "accounts" | "calendars" | "excludeCalendars">,
	available: CalendarInfo[]
): { selected: CalendarInfo[]; warnings: string[] } {
	const warnings: string[] = [];
	let selected = available;

	if (query.accounts.length > 0) {
		const { matched, unmatched } = resolveAccounts(query.accounts, available);
		if (unmatched.length) warnings.push(`No account matched: ${unmatched.join(", ")}`);
		selected = selected.filter((calendar) => matched.includes(calendar.accountId));
	}

	if (query.calendars.length > 0) {
		const { matched, unmatched, ambiguous } = resolveCalendars(query.calendars, selected);
		if (unmatched.length) warnings.push(`No calendar matched: ${unmatched.join(", ")}`);
		for (const term of ambiguous) {
			warnings.push(`"${term}" matched calendars in more than one account — use \`account/calendar\` to narrow it.`);
		}
		selected = selected.filter((calendar) => matched.includes(calendar.key));
	}

	if (query.excludeCalendars.length > 0) {
		const { matched } = resolveCalendars(query.excludeCalendars, selected);
		selected = selected.filter((calendar) => !matched.includes(calendar.key));
	}

	return { selected, warnings };
}

export interface CacheEntry {
	events: CalEvent[];
	/** Epoch milliseconds of the response this entry holds. */
	fetchedAt: number;
}

/** Entries are kept at least this long, so blocks with a short TTL do not evict others' data. */
const MIN_RETENTION_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 100;

/**
 * A small TTL cache of event lists, one entry per calendar and time range.
 *
 * Identical requests that overlap share one network call. Invalidating a
 * calendar also detaches any request already in flight for it, so a response
 * that started before a write can never be cached as if it came after it.
 */
export class EventStore {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<CacheEntry>>();

	constructor(
		private readonly clock: () => number = () => Date.now(),
		private readonly maxEntries = MAX_ENTRIES
	) {}

	static keyFor(calendarKey: string, from: Moment, to: Moment, search?: string): string {
		return [
			calendarKey,
			from.clone().startOf("minute").toISOString(),
			to.clone().startOf("minute").toISOString(),
			search ?? "",
		].join("|");
	}

	get size(): number {
		return this.cache.size;
	}

	/**
	 * Events for one calendar and range: from the cache when younger than
	 * `maxAgeMs`, otherwise from `fetcher`, sharing any identical request in flight.
	 */
	fetch(
		calendar: Pick<CalendarInfo, "key">,
		from: Moment,
		to: Moment,
		search: string | undefined,
		fetcher: () => Promise<CalEvent[]>,
		maxAgeMs: number
	): Promise<CacheEntry> {
		const key = EventStore.keyFor(calendar.key, from, to, search);

		const cached = this.cache.get(key);
		if (cached && this.clock() - cached.fetchedAt < maxAgeMs) return Promise.resolve(cached);

		const running = this.inflight.get(key);
		if (running) return running;

		const request = fetcher().then(
			(events) => {
				const entry: CacheEntry = { events, fetchedAt: this.clock() };
				// Only the request still registered may write: an invalidation in the
				// meantime means this response may predate a change.
				if (this.inflight.get(key) === request) {
					this.inflight.delete(key);
					this.set(key, entry, maxAgeMs);
				}
				return entry;
			},
			(error: unknown) => {
				if (this.inflight.get(key) === request) this.inflight.delete(key);
				throw error;
			}
		);
		this.inflight.set(key, request);
		return request;
	}

	/** Forget everything cached or in flight for one calendar, across every range. */
	invalidateCalendar(calendarKey: string): void {
		const prefix = `${calendarKey}|`;
		for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
		for (const key of [...this.inflight.keys()]) if (key.startsWith(prefix)) this.inflight.delete(key);
	}

	invalidateAll(): void {
		this.cache.clear();
		this.inflight.clear();
	}

	private set(key: string, entry: CacheEntry, ttlMs: number): void {
		this.cache.delete(key);
		this.cache.set(key, entry);

		const cutoff = this.clock() - Math.max(ttlMs, MIN_RETENTION_MS);
		for (const [existing, value] of this.cache) {
			if (value.fetchedAt < cutoff) this.cache.delete(existing);
		}

		if (this.cache.size > this.maxEntries) {
			const oldestFirst = [...this.cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
			for (const [existing] of oldestFirst.slice(0, this.cache.size - this.maxEntries)) {
				this.cache.delete(existing);
			}
		}
	}
}
