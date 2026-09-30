import { parseYaml } from "obsidian";
import type { Moment } from "./moment-shim";
import { addDuration, parseDuration, resolveDate } from "./dates";
import { MIN_AUTO_REFRESH, type CalendarConnectSettings } from "./settings";
import type { AllDayMode, Field, ViewMode } from "./types";

export interface BlockQuery {
	from: Moment;
	to: Moment;
	view: ViewMode;
	/** Names or IDs as written by the user; resolved against the calendar list later. */
	calendars: string[];
	excludeCalendars: string[];
	/** Account labels or addresses; empty means every connected account. */
	accounts: string[];
	fields: Field[];
	limit: number | null;
	search?: string;
	/** Compiled from the settings list plus the block's own `hide-titles`. */
	hiddenTitles: RegExp[];
	allDay: AllDayMode;
	hideDeclined: boolean;
	use24HourTime: boolean;
	dateHeadingFormat: string;
	tableDateFormat: string;
	descriptionLength: number;
	emptyMessage: string;
	/** Seconds; 0 disables, otherwise at least 60. */
	refresh: number;
	/** Footer with the last-updated time and refresh. */
	controls: boolean;
}

export interface ParsedQuery {
	query: BlockQuery;
	warnings: string[];
}

export class QueryError extends Error {}

const VIEWS: ViewMode[] = ["list", "agenda", "table"];
const ALL_DAY_MODES: AllDayMode[] = ["include", "exclude", "only"];

const FIELDS: Field[] = [
	"date",
	"time",
	"duration",
	"title",
	"calendar",
	"account",
	"location",
	"description",
	"attendees",
	"response",
	"link",
];

const FIELD_ALIASES: Record<string, Field> = {
	meet: "link",
	url: "link",
	guests: "attendees",
	people: "attendees",
	rsvp: "response",
	where: "location",
	cal: "calendar",
	notes: "description",
	desc: "description",
	length: "duration",
};

export const DEFAULT_FIELDS: Record<ViewMode, Field[]> = {
	list: ["time", "title", "location", "link"],
	agenda: ["time", "title", "location", "link"],
	table: ["date", "time", "title", "calendar", "location"],
};

/**
 * Normalised spelling → canonical option. Normalising lowercases and drops `-`,
 * `_` and spaces, so `all-day`, `all_day` and `allDay` are the same key.
 */
const KEY_ALIASES: Record<string, string> = {
	from: "from",
	to: "to",
	period: "period",
	view: "view",
	calendars: "calendars",
	calendar: "calendars",
	exclude: "exclude",
	excludecalendars: "exclude",
	accounts: "accounts",
	account: "accounts",
	search: "search",
	hidetitles: "hidetitles",
	excludetitles: "hidetitles",
	allday: "allday",
	declined: "declined",
	show: "show",
	hide: "hide",
	fields: "fields",
	limit: "limit",
	timeformat: "timeformat",
	empty: "empty",
	emptymessage: "empty",
	refresh: "refresh",
	controls: "controls",
};

function normaliseKey(key: string): string {
	return key.trim().toLowerCase().replace(/[-_\s]+/g, "");
}

/** Accepts a YAML list, a comma-separated string, or a single scalar. */
function toList(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap((item) => toList(item));
	return String(value)
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function toBool(value: unknown, key: string): boolean {
	if (typeof value === "boolean") return value;
	const text = String(value).trim().toLowerCase();
	if (["true", "yes", "on", "show", "1"].includes(text)) return true;
	if (["false", "no", "off", "hide", "0"].includes(text)) return false;
	throw new QueryError(`\`${key}\` expects true or false, got "${value}"`);
}

function toEnum<T extends string>(value: unknown, allowed: T[], key: string): T {
	const text = String(value).trim().toLowerCase();
	const match = allowed.find((option) => option === text);
	if (!match) throw new QueryError(`\`${key}\` expects one of ${allowed.join(", ")} — got "${value}"`);
	return match;
}

/** Own-property lookup, so `constructor` or `__proto__` in a block never matches a table entry. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function toFields(value: unknown, key: string, warnings: string[]): Field[] {
	const fields: Field[] = [];
	for (const raw of toList(value)) {
		const text = raw.toLowerCase();
		const field = FIELDS.includes(text as Field) ? (text as Field) : own(FIELD_ALIASES, text);
		if (!field) {
			warnings.push(`\`${key}\` — unknown field "${raw}"`);
			continue;
		}
		if (!fields.includes(field)) fields.push(field);
	}
	return fields;
}

/**
 * Interval in seconds. Accepts a bare number (`60`) or `30s` / `5m` / `1h`.
 * Note `m` is minutes here, unlike in `period` where it means months — an
 * interval measured in months would never be meaningful.
 */
function toSeconds(value: unknown, key: string): number {
	const text = String(value).trim().toLowerCase();
	if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

	const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(text);
	if (!match) throw new QueryError(`\`${key}\` expects an interval such as 90, 30s, 5m or 1h — got "${value}"`);

	const unit = match[2];
	const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
	return Number(match[1]) * multiplier;
}

/**
 * Whether a string is usable as `period` — either a duration (`7d`) or a date
 * expression to run until (`eom`). Exported so the settings tab can reject a typo
 * at the point it is made, rather than breaking every block that relies on it.
 */
export function isValidPeriod(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	return Boolean(parseDuration(trimmed) ?? resolveDate(trimmed, "end"));
}

/**
 * Compiles one hide pattern.
 *
 * `/foo/i` is a regular expression. Anything else is a glob: `*` matches any run
 * of characters and `?` matches one, anchored at both ends and case-insensitive.
 * So `EOD` hides only an event called exactly that, `Start of *` hides anything
 * beginning that way, and `*EOD*` hides anything containing it.
 */
export function compileTitlePattern(pattern: string): RegExp | null {
	const text = pattern.trim();
	if (!text) return null;

	const delimited = /^\/(.*)\/([gimsuy]*)$/.exec(text);
	if (delimited) {
		try {
			// `g` is dropped: a global regex carries lastIndex between .test() calls.
			return new RegExp(delimited[1], delimited[2].replace(/g/g, "") || "i");
		} catch {
			return null;
		}
	}

	const escaped = text
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

export function compileTitlePatterns(patterns: string[], onInvalid?: (pattern: string) => void): RegExp[] {
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		const regex = compileTitlePattern(pattern);
		if (regex) compiled.push(regex);
		else if (pattern.trim()) onInvalid?.(pattern);
	}
	return compiled;
}

function requireDate(value: unknown, key: string, edge: "start" | "end"): Moment {
	const resolved = resolveDate(String(value), edge);
	if (!resolved) {
		throw new QueryError(
			`\`${key}\` could not be understood: "${value}". Try today, tomorrow, sow, eom, +3d, or 2026-08-14.`
		);
	}
	return resolved;
}

/**
 * End of a range that is `periodText` long. A duration is a length, so `1d` is
 * just the `from` day and `7d` is seven days including it. Hours and minutes stay
 * precise; anything longer runs to the end of its last day.
 */
function periodEnd(from: Moment, periodText: string): Moment {
	const duration = parseDuration(periodText);
	if (!duration) {
		// `period: eom` is a reasonable thing to write, so fall back to date resolution.
		const resolved = resolveDate(periodText, "end");
		if (!resolved) throw new QueryError(`\`period\` expects a duration such as 7d, 2w or 1m — got "${periodText}"`);
		return resolved;
	}
	const end = addDuration(from, duration);
	if (duration.unit === "minutes" || duration.unit === "hours") return end;
	return end.subtract(1, "day").endOf("day");
}

export function parseQuery(source: string, settings: CalendarConnectSettings): ParsedQuery {
	const warnings: string[] = [];

	let raw: unknown;
	try {
		raw = source.trim() ? parseYaml(source) : {};
	} catch (error) {
		throw new QueryError(`Could not read the block options: ${(error as Error).message}`);
	}
	if (raw === null || raw === undefined) raw = {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new QueryError("Block options must be written as `key: value` lines");
	}

	const options = new Map<string, unknown>();
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const canonical = own(KEY_ALIASES, normaliseKey(key));
		if (canonical) options.set(canonical, value);
		else warnings.push(`Unknown option \`${key}\``);
	}
	const get = (key: string) => options.get(key);
	const has = (key: string) => options.has(key) && options.get(key) !== undefined;

	const view = has("view") ? toEnum(get("view"), VIEWS, "view") : settings.defaultView;

	const from = requireDate(get("from") ?? "today", "from", "start");
	const to = has("to")
		? requireDate(get("to"), "to", "end")
		: periodEnd(from, String(get("period") ?? settings.defaultPeriod).trim());
	if (to.isSameOrBefore(from)) {
		throw new QueryError(`The range ends before it starts (${from.format()} → ${to.format()})`);
	}

	let fields = has("fields") ? toFields(get("fields"), "fields", warnings) : [...DEFAULT_FIELDS[view]];
	if (has("show")) {
		for (const field of toFields(get("show"), "show", warnings)) {
			if (!fields.includes(field)) fields.push(field);
		}
	}
	if (has("hide")) {
		const hidden = toFields(get("hide"), "hide", warnings);
		fields = fields.filter((field) => !hidden.includes(field));
	}
	if (view === "table" && fields.length === 0) {
		throw new QueryError("A table needs at least one field");
	}

	const limitRaw = get("limit");
	let limit: number | null = null;
	if (limitRaw !== undefined && limitRaw !== null) {
		const parsed = Number(limitRaw);
		if (!Number.isFinite(parsed) || parsed < 1) throw new QueryError(`\`limit\` expects a positive number — got "${limitRaw}"`);
		limit = Math.floor(parsed);
	}

	let use24HourTime = settings.use24HourTime;
	if (has("timeformat")) {
		const text = String(get("timeformat")).trim().toLowerCase();
		if (text.startsWith("24")) use24HourTime = true;
		else if (text.startsWith("12")) use24HourTime = false;
		else warnings.push(`\`time-format\` expects 24h or 12h — got "${get("timeformat")}"`);
	}

	let refresh = has("refresh") ? Math.max(0, toSeconds(get("refresh"), "refresh")) : settings.autoRefresh;
	if (refresh > 0 && refresh < MIN_AUTO_REFRESH) {
		warnings.push(`\`refresh\` is clamped to a ${MIN_AUTO_REFRESH} second minimum`);
		refresh = MIN_AUTO_REFRESH;
	}

	const calendars = toList(get("calendars"));
	const searchRaw = get("search");
	const emptyRaw = get("empty");
	// The block's list adds to the one in settings rather than replacing it.
	const hiddenTitles = compileTitlePatterns(
		[...settings.hiddenTitles, ...toList(get("hidetitles"))],
		(pattern) => warnings.push(`Invalid hide pattern "${pattern}"`)
	);

	return {
		warnings,
		query: {
			from,
			to,
			view,
			calendars: calendars.length ? calendars : settings.defaultCalendars,
			excludeCalendars: toList(get("exclude")),
			accounts: toList(get("accounts")),
			fields,
			limit,
			search: searchRaw === undefined || searchRaw === null ? undefined : String(searchRaw),
			hiddenTitles,
			allDay: has("allday") ? toEnum(get("allday"), ALL_DAY_MODES, "all-day") : "include",
			hideDeclined: has("declined") ? !toBool(get("declined"), "declined") : settings.hideDeclined,
			use24HourTime,
			dateHeadingFormat: settings.dateHeadingFormat,
			tableDateFormat: settings.tableDateFormat,
			descriptionLength: settings.descriptionLength,
			emptyMessage: emptyRaw === undefined || emptyRaw === null ? "No events in this period." : String(emptyRaw),
			refresh,
			controls: has("controls") ? toBool(get("controls"), "controls") : true,
		},
	};
}

/** The subset of CalendarInfo the resolvers need, kept narrow so tests can supply plain objects. */
export interface ResolvableCalendar {
	key: string;
	id: string;
	name: string;
	accountId: string;
	accountLabel: string;
}

function matchesAccount(calendar: ResolvableCalendar, needle: string): boolean {
	const id = calendar.accountId.toLowerCase();
	const label = calendar.accountLabel.toLowerCase();
	return id === needle || label === needle || label.includes(needle) || id.startsWith(`${needle}@`);
}

/**
 * Maps user-written account labels or addresses onto account IDs.
 * `work` matches an account labelled "Work", and `alex@example.com` matches by address.
 */
export function resolveAccounts(
	requested: string[],
	available: ResolvableCalendar[]
): { matched: string[]; unmatched: string[] } {
	const matched = new Set<string>();
	const unmatched: string[] = [];

	for (const term of requested) {
		const needle = term.trim().toLowerCase();
		const hits = available.filter((calendar) => matchesAccount(calendar, needle));
		if (hits.length === 0) unmatched.push(term);
		else for (const hit of hits) matched.add(hit.accountId);
	}

	return { matched: [...matched], unmatched };
}

/**
 * Maps user-written calendar names or IDs onto calendar keys.
 *
 * A bare term is matched across every account, so `calendars: personal` picks up a
 * "Personal" calendar in each. `account/calendar` narrows to one account first, which
 * is how you disambiguate when the same name exists in two. Matching within a scope
 * is by exact ID, then exact name, then substring — all case-insensitive.
 */
export function resolveCalendars(
	requested: string[],
	available: ResolvableCalendar[]
): { matched: string[]; unmatched: string[]; ambiguous: string[] } {
	const matched = new Set<string>();
	const unmatched: string[] = [];
	const ambiguous: string[] = [];

	for (const term of requested) {
		const trimmed = term.trim();

		// A calendar key from settings is already fully qualified.
		if (available.some((calendar) => calendar.key === trimmed)) {
			matched.add(trimmed);
			continue;
		}

		let scope = available;
		let calendarPart = trimmed;
		const slash = trimmed.indexOf("/");
		if (slash > 0) {
			const accountNeedle = trimmed.slice(0, slash).trim().toLowerCase();
			const scoped = available.filter((calendar) => matchesAccount(calendar, accountNeedle));
			if (scoped.length > 0) {
				scope = scoped;
				calendarPart = trimmed.slice(slash + 1).trim();
			}
			// If the prefix matches no account, fall through and treat the whole
			// string as a calendar name — some calendars legitimately contain "/".
		}

		const needle = calendarPart.toLowerCase();
		const byId = scope.filter((calendar) => calendar.id.toLowerCase() === needle);
		const byName = byId.length ? byId : scope.filter((calendar) => calendar.name.toLowerCase() === needle);
		const hits = byName.length ? byName : scope.filter((calendar) => calendar.name.toLowerCase().includes(needle));

		if (hits.length === 0) {
			unmatched.push(term);
			continue;
		}
		for (const hit of hits) matched.add(hit.key);
		if (new Set(hits.map((hit) => hit.accountId)).size > 1) ambiguous.push(term);
	}

	return { matched: [...matched], unmatched, ambiguous };
}
