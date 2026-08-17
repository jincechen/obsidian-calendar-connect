import { AuthError, GoogleAuth, ReauthRequiredError } from "../src/auth";
import { describeError, GoogleCalendarClient, CalendarApiError } from "../src/google";
import { HttpError, setSleep } from "../src/http";
import { check } from "./harness";
import { serial } from "./http.test";
import { requestUrlMock, type ShimRequest, type ShimResponse } from "./obsidian-shim";

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
