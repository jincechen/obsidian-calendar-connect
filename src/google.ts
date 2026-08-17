import { AuthError, ReauthRequiredError, type GoogleAuth } from "./auth";
import { HttpError, parseGoogleError, request, type HttpResponse } from "./http";
import { safeColor } from "./safety";
import { calendarKey } from "./settings";
import type { CalendarInfo, RawCalendarListEntry } from "./types";

const API_BASE = "https://www.googleapis.com/calendar/v3";
const PAGE_SIZE = 250;
/** Guard against a runaway listing. */
const MAX_PAGES = 10;

export type CalendarApiErrorKind =
	| "conflict"
	| "forbidden"
	| "notFound"
	| "rateLimited"
	| "quota"
	| "apiDisabled"
	| "network"
	| "auth"
	| "other";

/** A Calendar API failure. `status` is 0 when no response arrived. */
export class CalendarApiError extends Error {
	constructor(
		message: string,
		readonly kind: CalendarApiErrorKind,
		readonly status: number = 0,
		readonly reason?: string
	) {
		super(message);
		this.name = "CalendarApiError";
	}
}

export interface AccountRef {
	id: string;
	label: string;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const API_DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);

function kindFor(status: number, reason: string | undefined, message: string): CalendarApiErrorKind {
	if (status === 412) return "conflict";
	if (status === 401) return "auth";
	if (status === 429) return "rateLimited";
	if (status === 404 || status === 410) return "notFound";
	if (status === 403) {
		if (reason && RATE_LIMIT_REASONS.has(reason)) return "rateLimited";
		if (reason && QUOTA_REASONS.has(reason)) return "quota";
		if ((reason && API_DISABLED_REASONS.has(reason)) || /calendar.*api.*disabled|has not been used/i.test(message)) {
			return "apiDisabled";
		}
		return "forbidden";
	}
	return "other";
}

function errorFromResponse(response: HttpResponse): CalendarApiError {
	const { message, reason } = parseGoogleError(response.json, response.text);
	return new CalendarApiError(message, kindFor(response.status, reason, message), response.status, reason);
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface CallOptions {
	query?: Record<string, string>;
}

export class GoogleCalendarClient {
	/** `getAccount` is a getter because the label can be renamed while the client lives. */
	constructor(
		private readonly auth: GoogleAuth,
		private readonly getAccount: () => AccountRef
	) {}

	/**
	 * One API call: Bearer token, a single refresh-and-retry on 401, and failures
	 * mapped to CalendarApiError. AuthErrors from the token layer pass through unchanged
	 * so callers can tell "needs reconnecting" from an API failure.
	 */
	private async call(method: "GET", path: string, options: CallOptions = {}): Promise<HttpResponse> {
		const query = options.query ? new URLSearchParams(options.query).toString() : "";
		const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;

		const send = (token: string) => request({ url, method, headers: { Authorization: `Bearer ${token}` } });

		let response: HttpResponse;
		try {
			response = await send(await this.auth.getAccessToken());
			// A token can be revoked server-side before it expires; one retry covers that.
			if (response.status === 401) response = await send(await this.auth.refresh());
		} catch (error) {
			if (error instanceof AuthError || error instanceof CalendarApiError) throw error;
			if (error instanceof HttpError) throw new CalendarApiError(error.message, "network", 0, error.kind);
			throw new CalendarApiError(error instanceof Error ? error.message : String(error), "other");
		}

		if (response.status >= 400) throw errorFromResponse(response);
		return response;
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		const account = this.getAccount();
		const calendars: CalendarInfo[] = [];
		let pageToken: string | undefined;
		let page = 0;

		do {
			const query: Record<string, string> = {
				minAccessRole: "reader",
				maxResults: String(PAGE_SIZE),
				showDeleted: "false",
			};
			if (pageToken) query.pageToken = pageToken;

			const body = asObject((await this.call("GET", "/users/me/calendarList", { query })).json);
			const items = Array.isArray(body.items) ? (body.items as RawCalendarListEntry[]) : [];
			for (const raw of items) {
				if (!raw || !raw.id || raw.deleted) continue;
				calendars.push({
					key: calendarKey(account.id, raw.id),
					id: raw.id,
					name: raw.summaryOverride || raw.summary || raw.id,
					color: safeColor(raw.backgroundColor) ?? "",
					primary: Boolean(raw.primary),
					timeZone: raw.timeZone,
					accountId: account.id,
					accountLabel: account.label,
				});
			}
			pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
		} while (pageToken && ++page < MAX_PAGES);

		return calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
	}

	/** The primary calendar's id is the account's email address, which we use as its stable id. */
	async fetchPrimaryAddress(): Promise<string | null> {
		const body = asObject((await this.call("GET", "/users/me/calendarList/primary")).json);
		return typeof body.id === "string" && body.id !== "" ? body.id : null;
	}

}

/** A sentence for the user. Never includes tokens or request headers. */
export function describeError(error: unknown): string {
	if (error instanceof ReauthRequiredError) return "Google sign-in expired or was revoked — reconnect the account.";
	if (error instanceof AuthError) return error.message;
	if (error instanceof CalendarApiError) {
		switch (error.kind) {
			case "conflict":
				return "This event changed in Google Calendar since it was loaded.";
			case "forbidden":
				return `Google Calendar didn't allow that: ${error.message}`;
			case "notFound":
				return "That event or calendar no longer exists in Google Calendar.";
			case "rateLimited":
				return "Google Calendar is limiting requests right now. Wait a moment and try again.";
			case "quota":
				return "The Google Cloud project has used up its Calendar API quota. Try again later.";
			case "apiDisabled":
				return "The Google Calendar API is not enabled for this Cloud project. Enable it and retry.";
			case "network":
				return error.reason === "timeout"
					? "Google took too long to respond. Check your connection."
					: "Couldn't reach Google. Check your connection.";
			case "auth":
				return "Google rejected the sign-in — reconnect the account.";
			default:
				return error.status
					? `Google Calendar error ${error.status}: ${error.message}`
					: `Google Calendar error: ${error.message}`;
		}
	}
	if (error instanceof HttpError) {
		return error.kind === "timeout"
			? "Google took too long to respond. Check your connection."
			: "Couldn't reach Google. Check your connection.";
	}
	if (error instanceof Error) return error.message;
	return String(error);
}
