import { moment, type Moment } from "./moment-shim";
import { AuthError, ReauthRequiredError, type GoogleAuth } from "./auth";
import { HttpError, parseGoogleError, request, type HttpResponse, type RetryPolicy } from "./http";
import { safeColor } from "./safety";
import { calendarKey } from "./settings";
import type { Attendee, CalEvent, CalendarInfo, RawAttendee, RawCalendarListEntry, RawEvent } from "./types";

const API_BASE = "https://www.googleapis.com/calendar/v3";
const PAGE_SIZE = 250;
/** Guard against a runaway range pulling an entire calendar history. */
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

export type SendUpdates = "all" | "externalOnly" | "none";

export interface AccountRef {
	id: string;
	label: string;
}

export interface EventQuery {
	calendarId: string;
	timeMin: Moment;
	timeMax: Moment;
	/** Google full-text search across title, description, location and attendees. */
	search?: string;
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

/** Decodes the handful of entities Google's rich-text descriptions use. */
function decodeEntities(text: string): string {
	return (
		text
			.replace(/&nbsp;/g, " ")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;|&apos;/g, "'")
			.replace(/&#(\d+);/g, (whole, code: string) => fromCodePoint(Number(code)) ?? whole)
			.replace(/&#x([0-9a-f]+);/gi, (whole, code: string) => fromCodePoint(parseInt(code, 16)) ?? whole)
			// Last, so "&amp;lt;" becomes the literal text "&lt;" rather than "<".
			.replace(/&amp;/g, "&")
	);
}

function fromCodePoint(code: number): string | null {
	if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
	return String.fromCodePoint(code);
}

/**
 * Flattens an HTML description to plain text. The result is only ever rendered
 * as text, so decoded `<` characters are harmless there.
 */
export function stripHtml(html: string): string {
	return decodeEntities(
		html
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
			.replace(/<[^>]+>/g, "")
	)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const HTML_PATTERN = /<[a-z][\s\S]*>/i;
const RFC3339_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function meetUrlOf(raw: RawEvent): string | undefined {
	if (raw.hangoutLink) return raw.hangoutLink;
	const video = raw.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video");
	return video?.uri || undefined;
}

function toAttendee(raw: RawAttendee): Attendee {
	return {
		email: raw.email,
		name: raw.displayName,
		response: raw.responseStatus,
		self: Boolean(raw.self),
		organizer: Boolean(raw.organizer),
		optional: Boolean(raw.optional),
		resource: Boolean(raw.resource),
	};
}

/**
 * Google's wire event as a `CalEvent`, or null when it has no id or no usable
 * start and end. Links are kept as given; rendering gates them with
 * `safeExternalUrl`.
 */
export function normaliseEvent(raw: RawEvent, calendar: CalendarInfo): CalEvent | null {
	if (!raw.id) return null;
	const startRaw = raw.start;
	const endRaw = raw.end;
	if (!startRaw || !endRaw) return null;

	const allDay = Boolean(startRaw.date);
	let start: Moment;
	let end: Moment;
	if (allDay) {
		if (!startRaw.date || !endRaw.date) return null;
		start = moment(startRaw.date, "YYYY-MM-DD", true).startOf("day");
		// Google's all-day end date is exclusive; pull it back so display maths is inclusive.
		end = moment(endRaw.date, "YYYY-MM-DD", true).subtract(1, "day").endOf("day");
	} else {
		// `moment(undefined)` would be "now", so absent values must be caught first.
		if (!startRaw.dateTime || !endRaw.dateTime) return null;
		// Google sends RFC 3339; anything else would hit moment's unreliable Date() fallback.
		if (!RFC3339_PREFIX.test(startRaw.dateTime) || !RFC3339_PREFIX.test(endRaw.dateTime)) return null;
		start = moment(startRaw.dateTime);
		end = moment(endRaw.dateTime);
	}
	if (!start.isValid() || !end.isValid()) return null;
	if (end.isBefore(start)) end = allDay ? start.clone().endOf("day") : start.clone();

	const attendees = (raw.attendees ?? []).map(toAttendee);
	const description = raw.description
		? (HTML_PATTERN.test(raw.description) ? stripHtml(raw.description) : raw.description.trim()) || undefined
		: undefined;

	return {
		id: raw.id,
		calendarKey: calendar.key,
		calendarId: calendar.id,
		calendarName: calendar.name,
		calendarColor: calendar.color,
		accountId: calendar.accountId,
		accountLabel: calendar.accountLabel,

		title: raw.summary?.trim() || "(no title)",
		start,
		end,
		allDay,
		location: raw.location?.trim() || undefined,
		description,
		link: raw.htmlLink || undefined,
		meetUrl: meetUrlOf(raw),
		status: raw.status,

		organizer: raw.organizer?.displayName ?? raw.organizer?.email,
		attendees,
		selfResponse: attendees.find((attendee) => attendee.self)?.response,

		recurring: Boolean(raw.recurringEventId) || Boolean(raw.recurrence?.length),
	};
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface CallOptions {
	query?: Record<string, string>;
	body?: unknown;
	headers?: Record<string, string>;
	retryPolicy?: RetryPolicy;
	/** Error statuses the caller handles itself. */
	allow?: number[];
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
	private async call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options: CallOptions = {}): Promise<HttpResponse> {
		const query = options.query ? new URLSearchParams(options.query).toString() : "";
		const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;
		const hasBody = options.body !== undefined;

		const send = (token: string) =>
			request({
				url,
				method,
				headers: { ...options.headers, Authorization: `Bearer ${token}` },
				body: hasBody ? JSON.stringify(options.body) : undefined,
				contentType: hasBody ? "application/json" : undefined,
				retryPolicy: options.retryPolicy,
			});

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

		if (response.status >= 400 && !(options.allow ?? []).includes(response.status)) {
			throw errorFromResponse(response);
		}
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
					accessRole: raw.accessRole ?? "reader",
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

	async listEvents(query: EventQuery, calendar: CalendarInfo): Promise<CalEvent[]> {
		const events: CalEvent[] = [];
		let pageToken: string | undefined;
		let page = 0;

		do {
			const params: Record<string, string> = {
				singleEvents: "true",
				orderBy: "startTime",
				maxResults: String(PAGE_SIZE),
				timeMin: query.timeMin.toISOString(),
				timeMax: query.timeMax.toISOString(),
			};
			if (query.search) params.q = query.search;
			if (pageToken) params.pageToken = pageToken;

			const response = await this.call("GET", `/calendars/${encodeURIComponent(query.calendarId)}/events`, {
				query: params,
			});
			const body = asObject(response.json);
			const items = Array.isArray(body.items) ? (body.items as RawEvent[]) : [];
			for (const raw of items) {
				const event = raw ? normaliseEvent(raw, calendar) : null;
				if (event) events.push(event);
			}
			pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
		} while (pageToken && ++page < MAX_PAGES);

		return events;
	}

	async getEvent(calendarId: string, eventId: string): Promise<RawEvent> {
		const response = await this.call("GET", eventPath(calendarId, eventId));
		return asObject(response.json) as RawEvent;
	}

	/**
	 * Creates an event. The body carries a client-generated id, so a retry after a
	 * lost response is safe: Google answers 409 and we fetch what was created.
	 */
	async insertEvent(calendarId: string, body: RawEvent, opts: { sendUpdates: SendUpdates }): Promise<RawEvent> {
		const response = await this.call("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
			query: { sendUpdates: opts.sendUpdates },
			body,
			retryPolicy: "idempotent",
			allow: body.id ? [409] : [],
		});
		if (response.status === 409 && body.id) return this.getEvent(calendarId, body.id);
		return asObject(response.json) as RawEvent;
	}

	/**
	 * Partial update. With `etag`, Google rejects a stale write with 412 (kind
	 * "conflict"). `null` values in the body are sent as-is: they clear fields.
	 */
	async patchEvent(
		calendarId: string,
		eventId: string,
		body: Record<string, unknown>,
		opts: { etag?: string; sendUpdates: SendUpdates }
	): Promise<RawEvent> {
		const response = await this.call("PATCH", eventPath(calendarId, eventId), {
			query: { sendUpdates: opts.sendUpdates },
			body,
			headers: opts.etag ? { "If-Match": opts.etag } : undefined,
			retryPolicy: "rate-only",
		});
		return asObject(response.json) as RawEvent;
	}

	/** Deleting something already gone (404/410) counts as success. */
	async deleteEvent(calendarId: string, eventId: string, opts: { sendUpdates: SendUpdates }): Promise<void> {
		await this.call("DELETE", eventPath(calendarId, eventId), {
			query: { sendUpdates: opts.sendUpdates },
			retryPolicy: "idempotent",
			allow: [404, 410],
		});
	}

	async moveEvent(
		calendarId: string,
		eventId: string,
		destinationId: string,
		opts: { sendUpdates: SendUpdates }
	): Promise<RawEvent> {
		const response = await this.call("POST", `${eventPath(calendarId, eventId)}/move`, {
			query: { destination: destinationId, sendUpdates: opts.sendUpdates },
			retryPolicy: "rate-only",
		});
		return asObject(response.json) as RawEvent;
	}
}

function eventPath(calendarId: string, eventId: string): string {
	return `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
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
