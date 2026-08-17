import type { CalendarInfo } from "./types";

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
}

export const DEFAULT_SETTINGS: CalendarConnectSettings = {
	clientId: "",
	clientSecret: "",
	oauthPort: 0,
	accounts: [],

	knownCalendars: [],
};

export const CALENDAR_KEY_SEPARATOR = "::";

export function calendarKey(accountId: string, calendarId: string): string {
	return `${accountId}${CALENDAR_KEY_SEPARATOR}${calendarId}`;
}

/** Prefix for the settings-tab control keys of account rows. */
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

	return {
		clientId: str(data.clientId, d.clientId).trim(),
		clientSecret: str(data.clientSecret, d.clientSecret).trim(),
		oauthPort: num(data.oauthPort, d.oauthPort, 0, 65535),
		accounts,

		knownCalendars,
	};
}
