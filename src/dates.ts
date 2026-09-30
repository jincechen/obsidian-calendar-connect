import { moment, type Moment, type MomentUnit } from "./moment-shim";
import type { CalEvent } from "./types";

export type Edge = "start" | "end";

export interface Duration {
	value: number;
	unit: string;
}

/** Longest-first so `min` beats `m` and `mo` beats `m`. */
const UNIT_ALIASES: Array<[RegExp, string]> = [
	[/^(minutes?|mins?)$/, "minutes"],
	[/^(hours?|hrs?|h)$/, "hours"],
	[/^(days?|d)$/, "days"],
	[/^(weeks?|wks?|w)$/, "weeks"],
	[/^(months?|mo|m)$/, "months"],
	[/^(years?|yrs?|y)$/, "years"],
];

const UNIT_PATTERN =
	"minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo|m|years?|yrs?|y";

const OFFSET_RE = new RegExp(`([+-])\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "gi");
const DURATION_RE = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})$`, "i");

function normaliseUnit(raw: string): string | null {
	const lower = raw.toLowerCase();
	for (const [pattern, unit] of UNIT_ALIASES) {
		if (pattern.test(lower)) return unit;
	}
	return null;
}

/** Parses `7d`, `2 weeks`, `90min`. Returns null when the text is not a duration. */
export function parseDuration(raw: string): Duration | null {
	const match = DURATION_RE.exec(raw.trim());
	if (!match) return null;
	const unit = normaliseUnit(match[2]);
	if (!unit) return null;
	return { value: Number(match[1]), unit };
}

interface Anchor {
	moment: Moment;
	/** Whether the anchor names a whole day, so it can be snapped to the start or end of it. */
	dayGranular: boolean;
}

function resolveAnchor(raw: string): Anchor | null {
	const text = raw.trim().toLowerCase();
	const now = moment();

	switch (text) {
		case "":
		case "today":
			return { moment: now.clone(), dayGranular: true };
		case "now":
			return { moment: now.clone(), dayGranular: false };
		case "tomorrow":
			return { moment: now.clone().add(1, "day"), dayGranular: true };
		case "yesterday":
			return { moment: now.clone().subtract(1, "day"), dayGranular: true };
		case "sow":
		case "start-of-week":
			return { moment: now.clone().startOf("week"), dayGranular: true };
		case "eow":
		case "end-of-week":
			return { moment: now.clone().endOf("week"), dayGranular: false };
		case "som":
		case "start-of-month":
			return { moment: now.clone().startOf("month"), dayGranular: true };
		case "eom":
		case "end-of-month":
			return { moment: now.clone().endOf("month"), dayGranular: false };
		case "soy":
		case "start-of-year":
			return { moment: now.clone().startOf("year"), dayGranular: true };
		case "eoy":
		case "end-of-year":
			return { moment: now.clone().endOf("year"), dayGranular: false };
	}

	const parsed = moment(
		raw.trim(),
		["YYYY-MM-DD", "YYYY-MM-DDTHH:mm", "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD HH:mm"],
		true
	);
	if (!parsed.isValid()) return null;
	return { moment: parsed, dayGranular: raw.trim().length <= 10 };
}

/**
 * Resolves a date expression such as `today`, `sow+1w`, `2026-08-14`, `+3d`.
 * `edge` decides whether a whole-day anchor becomes 00:00 or 23:59:59.999,
 * which is what makes `to:` ranges inclusive of the named day.
 */
export function resolveDate(raw: string, edge: Edge): Moment | null {
	const text = String(raw).trim();
	if (!text) return null;

	const offsets: Array<{ sign: number; value: number; unit: string }> = [];
	OFFSET_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OFFSET_RE.exec(text)) !== null) {
		const unit = normaliseUnit(match[3]);
		if (!unit) return null;
		offsets.push({ sign: match[1] === "-" ? -1 : 1, value: Number(match[2]), unit });
	}

	const anchorText = text.replace(OFFSET_RE, "").trim();
	// A bare offset such as `+3d` is relative to today.
	const anchor = resolveAnchor(anchorText);
	if (!anchor) return null;

	let result = anchor.moment;
	for (const offset of offsets) {
		result = result.add(offset.sign * offset.value, offset.unit as MomentUnit);
	}

	// Offsets in sub-day units imply the caller means a precise instant.
	const subDay = offsets.some((o) => o.unit === "minutes" || o.unit === "hours");
	if (anchor.dayGranular && !subDay) {
		result = edge === "start" ? result.startOf("day") : result.endOf("day");
	}

	return result;
}

export function addDuration(base: Moment, duration: Duration): Moment {
	return base.clone().add(duration.value, duration.unit as MomentUnit);
}

/** `Today` / `Tomorrow` / `Yesterday`, falling back to the supplied format. */
export function dayHeading(day: Moment, format: string): string {
	const today = moment().startOf("day");
	const diff = day.clone().startOf("day").diff(today, "days");
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	return day.format(format);
}

export function formatTime(value: Moment, use24Hour: boolean): string {
	return value.format(use24Hour ? "HH:mm" : "h:mma");
}

/** `09:30–10:00`, or `all day`. */
export function timeLabel(event: CalEvent, use24Hour: boolean): string {
	if (event.allDay) return "all day";
	const start = formatTime(event.start, use24Hour);
	if (event.end.isSame(event.start)) return start;
	return `${start}–${formatTime(event.end, use24Hour)}`;
}

/** `1h 30m`, `45m`, `2d`. */
export function formatDuration(start: Moment, end: Moment, allDay: boolean): string {
	if (allDay) {
		const days = Math.max(1, end.clone().endOf("day").diff(start.clone().startOf("day"), "days") + 1);
		return days === 1 ? "all day" : `${days}d`;
	}
	const totalMinutes = Math.max(0, end.diff(start, "minutes"));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	if (minutes === 0) return `${hours}h`;
	return `${hours}h ${minutes}m`;
}

export type TimeState = "past" | "now" | "future";

/**
 * Where an event sits relative to `now`. A timed event is past once its end has
 * arrived; an all-day event stays current until its last day is over.
 */
export function timeState(event: CalEvent, now: Moment): TimeState {
	if (event.allDay) {
		const start = event.start.clone().startOf("day");
		const end = event.end.clone().endOf("day");
		if (end.isBefore(now)) return "past";
		return start.isAfter(now) ? "future" : "now";
	}
	if (event.end.isSameOrBefore(now)) return "past";
	return event.start.isAfter(now) ? "future" : "now";
}

/** `in 25m`, `in 1h 5m`, `in 2d`, or `now` once it has started. */
export function relativeStart(event: CalEvent, now: Moment): string {
	if (!event.start.isAfter(now)) return "now";
	// Rounded up, so it never claims "in 0m" before the start.
	const minutes = Math.max(1, Math.ceil(event.start.diff(now, "minutes", true)));
	if (minutes < 60) return `in ${minutes}m`;
	if (minutes < 24 * 60) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
	}
	return `in ${Math.round(minutes / (24 * 60))}d`;
}

export interface DayItem {
	event: CalEvent;
	/** Set when the event spans several days: which of them this is, 1-based. */
	part?: { index: number; count: number };
}

export interface DayBucket {
	/** Start of the day. */
	day: Moment;
	items: DayItem[];
}

/** First and last calendar day an event occupies (an event ending at exactly 00:00 does not reach that day). */
function coveredDays(event: CalEvent): { first: Moment; last: Moment } {
	const first = event.start.clone().startOf("day");
	if (event.allDay) {
		const last = event.end.clone().startOf("day");
		return { first, last: last.isBefore(first) ? first : last };
	}
	const effectiveEnd = event.end.isAfter(event.start) ? event.end.clone().subtract(1, "millisecond") : event.start.clone();
	return { first, last: effectiveEnd.startOf("day") };
}

function compareItems(a: DayItem, b: DayItem): number {
	if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1;
	const byStart = a.event.start.valueOf() - b.event.start.valueOf();
	if (byStart !== 0) return byStart;
	return a.event.title.localeCompare(b.event.title);
}

/**
 * An event covering more in-range days than this is listed once, on its first
 * in-range day, rather than repeated. Holidays and trips still repeat; a stranger
 * inviting you to a years-long event cannot multiply into thousands of rows.
 */
export const MAX_REPEAT_DAYS = 31;

/**
 * Groups events by the days they cover within `from`..`to`. A multi-day event
 * (all-day, or timed and crossing midnight) appears on each covered day with its
 * part number. All-day items come first, then timed ones by start and title.
 * Days with nothing on them are left out.
 */
export function bucketByDay(events: CalEvent[], from: Moment, to: Moment): DayBucket[] {
	const rangeFirst = from.clone().startOf("day");
	const rangeLast = to.clone().startOf("day");
	const buckets = new Map<string, DayBucket>();

	for (const event of events) {
		const { first, last } = coveredDays(event);
		const count = Math.round(last.diff(first, "days", true)) + 1;
		let day = first.isBefore(rangeFirst) ? rangeFirst.clone() : first.clone();
		const clipped = last.isAfter(rangeLast) ? rangeLast : last;
		const span = Math.round(clipped.diff(day, "days", true)) + 1;
		const stop = span > MAX_REPEAT_DAYS ? day : clipped;

		while (!day.isAfter(stop)) {
			const key = day.format("YYYY-MM-DD");
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { day: day.clone(), items: [] };
				buckets.set(key, bucket);
			}
			const index = Math.round(day.diff(first, "days", true)) + 1;
			bucket.items.push(count > 1 ? { event, part: { index, count } } : { event });
			day = day.clone().add(1, "day");
		}
	}

	const result = [...buckets.values()].sort((a, b) => a.day.valueOf() - b.day.valueOf());
	for (const bucket of result) bucket.items.sort(compareItems);
	return result;
}
