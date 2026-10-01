import type { CalendarInfo, PastMode, ViewMode } from "./types";

/**
 * One connected Google account as the vault knows it. Deliberately holds no
 * tokens: those live in the device keychain (see tokens.ts), so nothing that can
 * act on the account is ever written into a synced file.
 */
export interface AccountSettings {
	/** The account's primary calendar address, which doubles as a stable unique id. */
	id: string;
	label: string;
	/** Per-account OAuth client, for workspaces that will not allow an outside one. */
	clientId?: string;
	clientSecret?: string;
}

export interface CalendarConnectSettings {
	/** OAuth client used by every account that does not override it. */
	clientId: string;
	clientSecret: string;
	/** 0 = ask the OS for a free port each time. */
	oauthPort: number;
	accounts: AccountSettings[];

	/** Cached from the API so the settings tab can render instantly. */
	knownCalendars: CalendarInfo[];
	/** Calendar keys (`accountId::calendarId`) queried when a block names none. Empty = all. */
	defaultCalendars: string[];
	/** Calendar key that "+ New event" uses. Empty = the first writable primary calendar. */
	newEventCalendar: string;

	defaultView: ViewMode;
	defaultPeriod: string;
	use24HourTime: boolean;
	dateHeadingFormat: string;
	tableDateFormat: string;
	hideDeclined: boolean;
	pastEvents: PastMode;
	/** Title patterns hidden in every block. Globs, or /regex/. */
	hiddenTitles: string[];
	descriptionLength: number;

	/** Length of a new event, in minutes. */
	defaultEventMinutes: number;
	confirmDelete: boolean;

	/** Seconds an API response stays reusable. */
	cacheTtl: number;
	/** Seconds between automatic block refreshes. 0 disables; otherwise at least 60. */
	autoRefresh: number;
}

export const DEFAULT_SETTINGS: CalendarConnectSettings = {
	clientId: "",
	clientSecret: "",
	oauthPort: 0,
	accounts: [],

	knownCalendars: [],
	defaultCalendars: [],
	newEventCalendar: "",

	defaultView: "list",
	defaultPeriod: "1d",
	use24HourTime: true,
	dateHeadingFormat: "dddd D MMMM",
	tableDateFormat: "ddd D MMM",
	hideDeclined: true,
	pastEvents: "dim",
	hiddenTitles: [],
	descriptionLength: 200,

	defaultEventMinutes: 30,
	confirmDelete: true,

	cacheTtl: 300,
	autoRefresh: 0,
};

/** Shortest auto-refresh interval, so a stray value cannot hammer the API. */
export const MIN_AUTO_REFRESH = 60;

export const CALENDAR_KEY_SEPARATOR = "::";

export function calendarKey(accountId: string, calendarId: string): string {
	return `${accountId}${CALENDAR_KEY_SEPARATOR}${calendarId}`;
}

/** Prefixes for the settings-tab control keys of repeated rows. */
export const CALENDAR_KEY_PREFIX = "calendar:";
export const ACCOUNT_KEY_PREFIX = "account:";

// --- Sanitising -----------------------------------------------------------
// data.json is synced and hand-editable, so nothing read from it is trusted:
// every field is type-checked and clamped, and unknown keys are dropped.

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function optStr(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sanitiseAccount(value: unknown): AccountSettings | null {
	if (!isRecord(value)) return null;
	const id = optStr(value.id);
	if (!id) return null;
	return {
		id,
		label: optStr(value.label) ?? id,
		clientId: optStr(value.clientId),
		clientSecret: optStr(value.clientSecret),
	};
}

function sanitiseCalendar(value: unknown): CalendarInfo | null {
	if (!isRecord(value)) return null;
	const id = optStr(value.id);
	const accountId = optStr(value.accountId);
	if (!id || !accountId) return null;
	const color = str(value.color, "");
	return {
		key: calendarKey(accountId, id),
		id,
		name: str(value.name, id),
		color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : "",
		primary: bool(value.primary, false),
		timeZone: optStr(value.timeZone),
		accessRole: str(value.accessRole, "reader"),
		accountId,
		accountLabel: str(value.accountLabel, accountId),
	};
}

/** Builds settings from whatever `loadData()` returned, never trusting its shape. */
export function sanitiseSettings(raw: unknown): CalendarConnectSettings {
	const data: Raw = isRecord(raw) ? raw : {};
	const d = DEFAULT_SETTINGS;

	const accounts: AccountSettings[] = [];
	for (const entry of Array.isArray(data.accounts) ? data.accounts : []) {
		const account = sanitiseAccount(entry);
		if (account && !accounts.some((a) => a.id === account.id)) accounts.push(account);
	}
	const accountIds = new Set(accounts.map((a) => a.id));

	const knownCalendars: CalendarInfo[] = [];
	for (const entry of Array.isArray(data.knownCalendars) ? data.knownCalendars : []) {
		const calendar = sanitiseCalendar(entry);
		if (calendar && accountIds.has(calendar.accountId) && !knownCalendars.some((c) => c.key === calendar.key)) {
			knownCalendars.push(calendar);
		}
	}

	const autoRefresh = num(data.autoRefresh, d.autoRefresh, 0, 24 * 3600);

	return {
		clientId: str(data.clientId, d.clientId).trim(),
		clientSecret: str(data.clientSecret, d.clientSecret).trim(),
		oauthPort: num(data.oauthPort, d.oauthPort, 0, 65535),
		accounts,

		knownCalendars,
		defaultCalendars: strings(data.defaultCalendars),
		newEventCalendar: str(data.newEventCalendar, d.newEventCalendar),

		defaultView: oneOf(data.defaultView, ["list", "agenda", "table"] as const, d.defaultView),
		defaultPeriod: str(data.defaultPeriod, d.defaultPeriod).trim() || d.defaultPeriod,
		use24HourTime: bool(data.use24HourTime, d.use24HourTime),
		dateHeadingFormat: str(data.dateHeadingFormat, d.dateHeadingFormat) || d.dateHeadingFormat,
		tableDateFormat: str(data.tableDateFormat, d.tableDateFormat) || d.tableDateFormat,
		hideDeclined: bool(data.hideDeclined, d.hideDeclined),
		pastEvents: oneOf(data.pastEvents, ["show", "dim", "hide"] as const, d.pastEvents),
		hiddenTitles: strings(data.hiddenTitles).map((line) => line.trim()).filter(Boolean),
		descriptionLength: num(data.descriptionLength, d.descriptionLength, 0, 10000),

		defaultEventMinutes: num(data.defaultEventMinutes, d.defaultEventMinutes, 5, 24 * 60),
		confirmDelete: bool(data.confirmDelete, d.confirmDelete),

		cacheTtl: num(data.cacheTtl, d.cacheTtl, 0, 24 * 3600),
		autoRefresh: autoRefresh === 0 ? 0 : Math.max(MIN_AUTO_REFRESH, autoRefresh),
	};
}
