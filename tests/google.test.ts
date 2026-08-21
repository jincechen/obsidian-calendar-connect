import { AuthError, GoogleAuth, ReauthRequiredError } from "../src/auth";
import { describeError, GoogleCalendarClient, CalendarApiError, normaliseEvent, stripHtml } from "../src/google";
import { HttpError, setSleep } from "../src/http";
import { moment } from "../src/moment-shim";
import type { RawEvent } from "../src/types";
import { makeCalendar } from "./fixtures";
import { check } from "./harness";
import { serial } from "./http.test";
import { requestUrlMock, type ShimRequest, type ShimResponse } from "./obsidian-shim";

// --- stripHtml -------------------------------------------------------------------

check("stripHtml tags and breaks", stripHtml("<p>Hello <b>there</b></p><p>Line<br>two</p>"), "Hello there\nLine\ntwo");
check("stripHtml entities", stripHtml("Tom &amp; Jerry &lt;3&nbsp;&quot;x&quot; &#39;y&#39; &#8212; &#x41;"), "Tom & Jerry <3 \"x\" 'y' — A");
check("stripHtml decodes &amp; last", stripHtml("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
check("stripHtml collapses blank lines", stripHtml("a<br><br><br><br>b"), "a\n\nb");

// --- normaliseEvent ------------------------------------------------------------

const calendar = makeCalendar();

const fullRaw: RawEvent = {
	id: "evt1",
	status: "confirmed",
	htmlLink: "https://www.google.com/calendar/event?eid=abc",
	summary: "  Design review  ",
	description: "<b>Agenda</b><br>specs &amp; plans",
	location: " Room 4 ",
	start: { dateTime: "2026-08-14T09:30:00+01:00", timeZone: "Europe/London" },
	end: { dateTime: "2026-08-14T10:00:00+01:00", timeZone: "Europe/London" },
	recurringEventId: "series1",
	organizer: { email: "sam@example.com", displayName: "Sam" },
	attendees: [
		{ email: "sam@example.com", displayName: "Sam", organizer: true, responseStatus: "accepted" },
		{ email: "alex@example.com", self: true, responseStatus: "tentative", optional: true },
		{ email: "room@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
	],
	conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://meet.google.com/abc" }] },
};
{
	const event = normaliseEvent(fullRaw, calendar);
	check("normalise returns an event", event !== null, true);
	if (event) {
		check("normalise identity", [event.id, event.calendarKey, event.calendarId, event.accountId, event.accountLabel], [
			"evt1",
			calendar.key,
			calendar.id,
			calendar.accountId,
			calendar.accountLabel,
		]);
		check("normalise title trimmed", event.title, "Design review");
		check("normalise location trimmed", event.location, "Room 4");
		check("normalise HTML description", event.description, "Agenda\nspecs & plans");
		check("normalise times", [event.allDay, event.start.toISOString(), event.end.toISOString()], [
			false,
			"2026-08-14T08:30:00.000Z",
			"2026-08-14T09:00:00.000Z",
		]);
		check("normalise meet url from conference data", event.meetUrl, "https://meet.google.com/abc");
		check("normalise link", event.link, "https://www.google.com/calendar/event?eid=abc");
		check("normalise organizer", event.organizer, "Sam");
		check("normalise attendees", event.attendees, [
			{ email: "sam@example.com", name: "Sam", response: "accepted", self: false, organizer: true, optional: false, resource: false },
			{ email: "alex@example.com", response: "tentative", self: true, organizer: false, optional: true, resource: false },
			{ email: "room@resource.calendar.google.com", response: "accepted", self: false, organizer: false, optional: false, resource: true },
		]);
		check("normalise selfResponse", event.selfResponse, "tentative");
		check("normalise recurring", event.recurring, true);
		check("normalise status", event.status, "confirmed");
	}
}
{
	const event = normaliseEvent(
		{
			id: "allday",
			summary: "Holiday",
			description: "Plain a < b > c",
			start: { date: "2026-08-14" },
			end: { date: "2026-08-17" },
			organizer: { email: calendar.id },
			hangoutLink: "https://meet.google.com/xyz",
		},
		calendar
	);
	check("all-day parsed", event?.allDay, true);
	check("all-day start", event?.start.format("YYYY-MM-DD HH:mm"), "2026-08-14 00:00");
	check("all-day end is inclusive", event?.end.format("YYYY-MM-DD HH:mm"), "2026-08-16 23:59");
	check("plain description kept verbatim", event?.description, "Plain a < b > c");
	check("defaults", [event?.attendees, event?.recurring], [[], false]);
	check("hangoutLink wins", event?.meetUrl, "https://meet.google.com/xyz");
}
{
	const single = normaliseEvent({ id: "one", start: { date: "2026-08-14" }, end: { date: "2026-08-15" } }, calendar);
	check("one-day all-day event ends the same day", single?.end.format("YYYY-MM-DD"), "2026-08-14");
	check("empty title", single?.title, "(no title)");
	check("recurrence on a master counts as recurring", normaliseEvent({ ...fullRaw, recurringEventId: undefined, recurrence: ["RRULE:FREQ=DAILY"] }, calendar)?.recurring, true);
}
check("no id → null", normaliseEvent({ ...fullRaw, id: undefined }, calendar), null);
check("no start → null", normaliseEvent({ ...fullRaw, start: undefined }, calendar), null);
check("start without a value → null", normaliseEvent({ ...fullRaw, start: {} }, calendar), null);
check("timed start, missing end time → null", normaliseEvent({ ...fullRaw, end: { date: "2026-08-14" } }, calendar), null);
check("invalid date → null", normaliseEvent({ id: "x", start: { date: "2026-13-45" }, end: { date: "2026-13-46" } }, calendar), null);
check("invalid dateTime → null", normaliseEvent({ id: "x", start: { dateTime: "nope" }, end: { dateTime: "nope" } }, calendar), null);

// --- describeError ---------------------------------------------------------------

check("describe conflict", describeError(new CalendarApiError("Precondition Failed", "conflict", 412)), "This event changed in Google Calendar since it was loaded.");
check("describe reauth", describeError(new ReauthRequiredError()), "Google sign-in expired or was revoked — reconnect the account.");
check("describe network", describeError(new CalendarApiError("x", "network", 0, "network")), "Couldn't reach Google. Check your connection.");
check("describe raw HttpError", describeError(new HttpError("network", "x")), "Couldn't reach Google. Check your connection.");
check("describe other", describeError(new CalendarApiError("Bad Request", "other", 400)), "Google Calendar error 400: Bad Request");
check("describe auth error passes message", describeError(new AuthError("Add your OAuth client ID")), "Add your OAuth client ID");
check("describe string", describeError("boom"), "boom");

// --- GoogleCalendarClient ------------------------------------------------------------------

function json(status: number, body: unknown, headers: Record<string, string> = {}): ShimResponse {
	return { status, json: body, text: JSON.stringify(body), headers };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

serial(async () => {
	setSleep(async () => undefined);
	const seen: ShimRequest[] = [];
	let api: (req: ShimRequest) => ShimResponse = () => json(200, {});
	let tokenCount = 0;
	requestUrlMock.handler = (req) => {
		if (req.url === TOKEN_URL) {
			tokenCount++;
			return json(200, { access_token: `fresh${tokenCount}`, expires_in: 3599 });
		}
		seen.push(req);
		return api(req);
	};
	const grant = { refreshToken: "1//r", scopes: [] as string[] };
	const auth = new GoogleAuth(() => ({ clientId: "c", clientSecret: "s" }), () => grant, () => undefined);
	auth.seed("stale", Date.now() + 3600_000);
	const client = new GoogleCalendarClient(auth, () => ({ id: "alex@example.com", label: "Personal" }));

	try {
		// 401 → refresh → retry.
		api = (req) =>
			req.headers?.Authorization === "Bearer stale"
				? json(401, { error: { message: "Invalid Credentials", errors: [{ reason: "authError" }] } })
				: json(200, { id: "alex@example.com" });
		const address = await client.fetchPrimaryAddress();
		check("401 refreshes once and retries", [address, tokenCount, seen.map((r) => r.headers?.Authorization)], [
			"alex@example.com",
			1,
			["Bearer stale", "Bearer fresh1"],
		]);
		check("primary address endpoint", seen[0].url, "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary");

		// Persistent 401 → CalendarApiError auth.
		seen.length = 0;
		api = () => json(401, { error: { message: "Invalid Credentials" } });
		try {
			await client.listCalendars();
			check("persistent 401 rejects", "resolved", "rejected");
		} catch (error) {
			check("persistent 401 → kind auth", [error instanceof CalendarApiError, (error as CalendarApiError).kind, seen.length], [true, "auth", 2]);
		}

		// listCalendars sanitises colour, skips deleted, pages.
		seen.length = 0;
		api = (req) =>
			req.url.includes("pageToken=p2")
				? json(200, { items: [{ id: "team@group.calendar.google.com", summary: "Team", backgroundColor: "red;}", accessRole: "reader" }] })
				: json(200, {
						nextPageToken: "p2",
						items: [
							{ id: "alex@example.com", summary: "alex@example.com", summaryOverride: "Me", backgroundColor: "#9fe1e7", primary: true, accessRole: "owner", timeZone: "Europe/London" },
							{ id: "gone", summary: "Gone", deleted: true },
							{ summary: "No id" },
						],
				  });
		const calendars = await client.listCalendars();
		check("listCalendars entries", calendars.map((c) => [c.key, c.name, c.color, c.primary, c.timeZone]), [
			["alex@example.com::alex@example.com", "Me", "#9fe1e7", true, "Europe/London"],
			["alex@example.com::team@group.calendar.google.com", "Team", "", false, undefined],
		]);
		check("listCalendars paged", seen.length, 2);

		// listEvents: query params, encoded path, normalisation, skips id-less items.
		seen.length = 0;
		api = () => json(200, { items: [fullRaw, { summary: "no id", start: { date: "2026-08-14" }, end: { date: "2026-08-15" } }] });
		const cal = makeCalendar({ id: "team#x@group.calendar.google.com" });
		const events = await client.listEvents(
			{ calendarId: cal.id, timeMin: moment("2026-08-14T00:00:00Z"), timeMax: moment("2026-08-15T00:00:00Z"), search: "review" },
			cal
		);
		const listUrl = new URL(seen[0].url);
		check("listEvents path encodes the calendar id", listUrl.pathname, "/calendar/v3/calendars/team%23x%40group.calendar.google.com/events");
		check("listEvents params", [listUrl.searchParams.get("singleEvents"), listUrl.searchParams.get("orderBy"), listUrl.searchParams.get("q"), listUrl.searchParams.get("timeMin")], [
			"true",
			"startTime",
			"review",
			"2026-08-14T00:00:00.000Z",
		]);
		check("listEvents normalises and skips id-less events", events.map((e) => e.id), ["evt1"]);

		// Network failure → CalendarApiError network; reauth passes through.
		api = () => {
			throw new Error("offline");
		};
		try {
			await client.fetchPrimaryAddress();
		} catch (error) {
			check("network failure → CalendarApiError network", [error instanceof CalendarApiError, (error as CalendarApiError).kind], [true, "network"]);
		}
		const revoked = new GoogleAuth(() => ({ clientId: "c", clientSecret: "s" }), () => grant, () => undefined);
		requestUrlMock.handler = (req) =>
			req.url === TOKEN_URL ? json(400, { error: "invalid_grant" }) : json(200, {});
		try {
			await new GoogleCalendarClient(revoked, () => ({ id: "a", label: "A" })).fetchPrimaryAddress();
			check("reauth rejects", "resolved", "rejected");
		} catch (error) {
			check("ReauthRequiredError passes through call()", error instanceof ReauthRequiredError, true);
		}
	} finally {
		requestUrlMock.handler = null;
		setSleep(null);
	}
});
