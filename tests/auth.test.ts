import {
	AuthError,
	authorizeWith,
	buildConsent,
	canWriteWith,
	GoogleAuth,
	hasCalendarList,
	parseRedirect,
	parseScopes,
	randomPastePort,
	ReauthRequiredError,
	SCOPE_CALENDAR_LIST,
	SCOPE_EVENTS,
	type ConsentView,
	type PendingConsent,
} from "../src/auth";
import { setSleep } from "../src/http";
import { DeviceTokenStore, secretIdFor, type SecretBackend, type StoredGrant } from "../src/tokens";
import { check, rejects, throws } from "./harness";
import { serial } from "./http.test";
import { requestUrlMock, type ShimRequest, type ShimResponse } from "./obsidian-shim";

// --- secretIdFor -------------------------------------------------------------

{
	const ids = ["alex@example.com", "Alex@Example.com", "a.b@x.org", "a-b@x.org", "", "日本語@例え.jp", "x".repeat(200)];
	const secretIds = ids.map(secretIdFor);
	check(
		"secretIdFor charset",
		secretIds.every((id) => /^[a-z0-9-]+$/.test(id)),
		true
	);
	check("secretIdFor prefix", secretIds.every((id) => id.startsWith("calendar-connect-")), true);
	check("secretIdFor deterministic", secretIdFor("alex@example.com"), secretIds[0]);
	check("secretIdFor distinct ids stay distinct", new Set(secretIds).size, ids.length);
	check("secretIdFor readable slug", secretIdFor("alex@example.com").startsWith("calendar-connect-alex-example-com-"), true);
	check("secretIdFor no double dashes", secretIds.every((id) => !id.includes("--")), true);
	check("secretIdFor bounded length", secretIds.every((id) => id.length <= 17 + 40 + 1 + 8), true);
	check("secretIdFor hash suffix", /-[0-9a-f]{8}$/.test(secretIds[0]), true);
}

// --- DeviceTokenStore ----------------------------------------------------------

{
	const secrets = new Map<string, string>();
	const backend: SecretBackend = {
		getSecret: (id) => secrets.get(id) ?? null,
		setSecret: (id, value) => {
			secrets.set(id, value);
		},
	};
	const store = new DeviceTokenStore(backend);
	const grant: StoredGrant = { refreshToken: "1//refresh", scopes: [SCOPE_CALENDAR_LIST, SCOPE_EVENTS] };

	check("token store empty → null", store.load("alex@example.com"), null);
	store.save("alex@example.com", grant);
	check("token store round trip", store.load("alex@example.com"), grant);
	check("token store keyed by secretIdFor", secrets.has(secretIdFor("alex@example.com")), true);
	check("token store other account unaffected", store.load("sam@example.com"), null);
	store.save("alex@example.com", null);
	check("token store clear writes empty string", secrets.get(secretIdFor("alex@example.com")), "");
	check("token store cleared → null", store.load("alex@example.com"), null);

	secrets.set(secretIdFor("bad@example.com"), "{not json");
	check("token store malformed JSON → null", store.load("bad@example.com"), null);
	secrets.set(secretIdFor("bad@example.com"), JSON.stringify({ refreshToken: 5, scopes: [] }));
	check("token store wrong types → null", store.load("bad@example.com"), null);
	secrets.set(secretIdFor("bad@example.com"), JSON.stringify("1//just-a-string"));
	check("token store non-object → null", store.load("bad@example.com"), null);
	secrets.set(secretIdFor("bad@example.com"), JSON.stringify({ refreshToken: "r", scopes: ["a", 3, ""] }));
	check("token store drops non-string scopes", store.load("bad@example.com"), { refreshToken: "r", scopes: ["a"] });

	const throwing = new DeviceTokenStore({
		getSecret: () => {
			throw new Error("keychain locked");
		},
		setSecret: () => undefined,
	});
	check("token store unreadable keychain → null", throwing.load("alex@example.com"), null);
}

// --- Scopes --------------------------------------------------------------------

check("parseScopes string", parseScopes(`${SCOPE_CALENDAR_LIST}  ${SCOPE_EVENTS} `), [SCOPE_CALENDAR_LIST, SCOPE_EVENTS]);
check("parseScopes array", parseScopes([SCOPE_EVENTS, 4, "", SCOPE_EVENTS]), [SCOPE_EVENTS]);
check("parseScopes missing", parseScopes(undefined), []);
check("canWriteWith events", canWriteWith([SCOPE_CALENDAR_LIST, SCOPE_EVENTS]), true);
check("canWriteWith full calendar", canWriteWith(["https://www.googleapis.com/auth/calendar"]), true);
check("canWriteWith list only", canWriteWith([SCOPE_CALENDAR_LIST]), false);
check("canWriteWith readonly", canWriteWith(["https://www.googleapis.com/auth/calendar.readonly"]), false);
check("hasCalendarList", hasCalendarList([SCOPE_CALENDAR_LIST]), true);
check("hasCalendarList events only", hasCalendarList([SCOPE_EVENTS]), false);
{
	let inRange = true;
	for (let i = 0; i < 200; i++) {
		const port = randomPastePort();
		if (!Number.isInteger(port) || port < 49152 || port > 65535) inRange = false;
	}
	check("randomPastePort in the dynamic range", inRange, true);
}

// --- parseRedirect ---------------------------------------------------------------

const pending: PendingConsent = {
	url: "https://accounts.google.com/o/oauth2/v2/auth?x",
	state: "st4te_-x",
	verifier: "v",
	redirectUri: "http://127.0.0.1:51234",
};
check(
	"parseRedirect full URL",
	parseRedirect("http://127.0.0.1:51234/?state=st4te_-x&code=4/0Abc-DEF&scope=a%20b", pending),
	"4/0Abc-DEF"
);
check(
	"parseRedirect URL-encoded code",
	parseRedirect("http://127.0.0.1:51234/?state=st4te_-x&code=4%2F0Abc", pending),
	"4/0Abc"
);
check("parseRedirect surrounding whitespace", parseRedirect("  \n http://127.0.0.1:51234/?code=abc&state=st4te_-x \n", pending), "abc");
check("parseRedirect bare query with ?", parseRedirect("?code=abc&state=st4te_-x", pending), "abc");
check("parseRedirect bare query", parseRedirect("code=abc&state=st4te_-x", pending), "abc");
check("parseRedirect scheme-less address", parseRedirect("127.0.0.1:51234/?state=st4te_-x&code=abc", pending), "abc");
check("parseRedirect ignores fragment", parseRedirect("http://127.0.0.1:51234/?state=st4te_-x&code=abc#frag", pending), "abc");
throws("parseRedirect state mismatch", () => parseRedirect("http://127.0.0.1:51234/?state=other&code=abc", pending), AuthError);
throws("parseRedirect missing state", () => parseRedirect("code=abc", pending), AuthError);
throws("parseRedirect error=", () => parseRedirect("http://127.0.0.1:51234/?error=access_denied&state=st4te_-x", pending), AuthError);
throws("parseRedirect missing code", () => parseRedirect("http://127.0.0.1:51234/?state=st4te_-x", pending), AuthError);
throws("parseRedirect empty", () => parseRedirect("   ", pending), AuthError);
throws("parseRedirect junk", () => parseRedirect("hello there", pending), AuthError);
{
	let message = "";
	try {
		parseRedirect("http://127.0.0.1:51234/?error=access_denied&state=st4te_-x", pending);
	} catch (error) {
		message = (error as Error).message;
	}
	check("parseRedirect access_denied message", /declined/.test(message), true);
}

// --- Async: consent URL, token endpoint, GoogleAuth, authorizeWith ---------------

function json(status: number, body: unknown): ShimResponse {
	return { status, json: body, text: JSON.stringify(body), headers: {} };
}

function formOf(req: ShimRequest): URLSearchParams {
	return new URLSearchParams(req.body ?? "");
}

const CONFIG = { clientId: "client-1.apps.googleusercontent.com", clientSecret: "shh" };
const BOTH = `${SCOPE_CALENDAR_LIST} ${SCOPE_EVENTS}`;

serial(async () => {
	setSleep(async () => undefined);
	try {
		// buildConsent
		const consent = await buildConsent(CONFIG.clientId, "http://127.0.0.1:50000");
		const url = new URL(consent.url);
		const params = url.searchParams;
		check("consent endpoint", `${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
		check("consent client_id", params.get("client_id"), CONFIG.clientId);
		check("consent redirect_uri", params.get("redirect_uri"), "http://127.0.0.1:50000");
		check("consent response_type", params.get("response_type"), "code");
		check("consent scopes", (params.get("scope") ?? "").split(" ").sort(), [SCOPE_CALENDAR_LIST, SCOPE_EVENTS].sort());
		check("consent offline", params.get("access_type"), "offline");
		check("consent prompt", params.get("prompt"), "select_account consent");
		check("consent S256", params.get("code_challenge_method"), "S256");
		check("consent no include_granted_scopes", params.has("include_granted_scopes"), false);
		check("consent state matches pending", params.get("state"), consent.state);
		check("consent state is url-safe", /^[A-Za-z0-9_-]{16,}$/.test(consent.state), true);
		check("consent verifier length", consent.verifier.length >= 43 && consent.verifier.length <= 128, true);
		const expectedChallenge = Buffer.from(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(consent.verifier))
		)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		check("consent challenge is S256 of the verifier", params.get("code_challenge"), expectedChallenge);
		const second = await buildConsent(CONFIG.clientId, "http://127.0.0.1:50000");
		check("consent state and verifier are fresh", second.state !== consent.state && second.verifier !== consent.verifier, true);

		// GoogleAuth: coalescing, no grant change when nothing changed.
		let grant: StoredGrant | null = { refreshToken: "1//r1", scopes: [SCOPE_CALENDAR_LIST, SCOPE_EVENTS] };
		const changes: StoredGrant[] = [];
		const auth = new GoogleAuth(
			() => CONFIG,
			() => grant,
			(next) => {
				changes.push(next);
				grant = next;
			}
		);
		check("GoogleAuth connected", auth.isConnected(), true);
		check("GoogleAuth canWrite", auth.canWrite(), true);

		let tokenCalls = 0;
		let lastForm: URLSearchParams | null = null;
		requestUrlMock.handler = async (req) => {
			tokenCalls++;
			lastForm = formOf(req);
			await new Promise((resolve) => setTimeout(resolve, 5));
			return json(200, { access_token: `at${tokenCalls}`, expires_in: 3599, scope: BOTH, token_type: "Bearer" });
		};
		const [a, b, c] = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.refresh()]);
		check("GoogleAuth coalesces concurrent refreshes", [tokenCalls, a, b, c], [1, "at1", "at1", "at1"]);
		const form = lastForm as URLSearchParams | null;
		check("refresh form", form && [form.get("grant_type"), form.get("refresh_token"), form.get("client_id")], [
			"refresh_token",
			"1//r1",
			CONFIG.clientId,
		]);
		check("GoogleAuth caches the access token", [await auth.getAccessToken(), tokenCalls], ["at1", 1]);
		check("no grant change when nothing changed", changes.length, 0);

		// seed avoids a refresh.
		const seeded = new GoogleAuth(() => CONFIG, () => grant, () => undefined);
		tokenCalls = 0;
		seeded.seed("seeded-token", Date.now() + 3600_000);
		check("seed primes the access token", [await seeded.getAccessToken(), tokenCalls], ["seeded-token", 0]);
		seeded.seed("nearly-expired", Date.now() + 30_000);
		check("token inside the 60s skew is refreshed", [await seeded.getAccessToken(), tokenCalls], ["at1", 1]);

		// Rotation and scope changes reach onGrantChange.
		requestUrlMock.handler = () => json(200, { access_token: "at-rot", expires_in: 3599, refresh_token: "1//r2", scope: BOTH });
		await auth.refresh();
		check("rotated refresh token → onGrantChange", changes, [{ refreshToken: "1//r2", scopes: [SCOPE_CALENDAR_LIST, SCOPE_EVENTS] }]);
		changes.length = 0;
		requestUrlMock.handler = () => json(200, { access_token: "at-ro", expires_in: 3599, scope: SCOPE_CALENDAR_LIST });
		await auth.refresh();
		check("narrowed scopes → onGrantChange", changes, [{ refreshToken: "1//r2", scopes: [SCOPE_CALENDAR_LIST] }]);
		check("canWrite follows the grant", auth.canWrite(), false);
		changes.length = 0;
		requestUrlMock.handler = () => json(200, { access_token: "at-same", expires_in: 3599, refresh_token: "1//r2" });
		await auth.refresh();
		check("same token, no scope field → no onGrantChange", changes.length, 0);

		// invalid_grant → ReauthRequiredError.
		requestUrlMock.handler = () => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
		await rejects("invalid_grant → ReauthRequiredError", () => auth.refresh(), ReauthRequiredError);
		await rejects("getAccessToken after invalid_grant refreshes again", () => auth.getAccessToken(), ReauthRequiredError);
		requestUrlMock.handler = () => json(401, { error: "invalid_client", error_description: "Unauthorized" });
		await rejects("invalid_client → AuthError", () => auth.refresh(), AuthError);
		requestUrlMock.handler = () => {
			throw new Error("offline");
		};
		try {
			await auth.refresh();
		} catch (error) {
			check("offline refresh is not an auth error", error instanceof AuthError, false);
		}

		grant = null;
		check("GoogleAuth not connected without a grant", auth.isConnected(), false);
		await rejects("getAccessToken without a grant", () => auth.getAccessToken(), AuthError);

		// authorizeWith over the paste path (the shim is not a desktop app).
		const views: ConsentView[] = [];
		let closed = 0;
		const presenter = (view: ConsentView) => {
			views.push(view);
			return () => {
				closed++;
			};
		};
		const exchanged: URLSearchParams[] = [];
		requestUrlMock.handler = (req) => {
			exchanged.push(formOf(req));
			return json(200, { access_token: "at-new", expires_in: 3599, refresh_token: "1//new", scope: BOTH });
		};
		const flow = authorizeWith({ ...CONFIG, port: 0 }, presenter);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const view = views[0];
		check("authorize opens the consent UI without a listener", view && view.listening, false);
		const redirect = new URL(view.url).searchParams.get("redirect_uri") ?? "";
		const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(redirect)?.[1]);
		check("paste-only redirect uses a dynamic port", port >= 49152 && port <= 65535, true);
		const state = new URL(view.url).searchParams.get("state");
		check("bad paste returns an inline error", typeof view.submit("http://127.0.0.1/?code=x&state=wrong"), "string");
		check("submit accepts the right address", view.submit(`${redirect}/?state=${state}&code=4/abc`), null);
		const granted = await flow;
		check("authorize returns the grant", [granted.refreshToken, granted.accessToken, granted.scopes], [
			"1//new",
			"at-new",
			[SCOPE_CALENDAR_LIST, SCOPE_EVENTS],
		]);
		check("authorize closed the UI once", closed, 1);
		const exchange = exchanged[0];
		check("code exchange form", exchange && [exchange.get("grant_type"), exchange.get("code"), exchange.get("redirect_uri"), Boolean(exchange.get("code_verifier"))], [
			"authorization_code",
			"4/abc",
			redirect,
			true,
		]);
		view.cancel();
		check("cancel after settling is a no-op", closed, 1);

		// Cancel.
		views.length = 0;
		const cancelled = authorizeWith({ ...CONFIG, port: 0 }, presenter);
		await new Promise((resolve) => setTimeout(resolve, 10));
		views[0].cancel();
		await rejects("closing the consent UI cancels", () => cancelled, AuthError);

		// Missing calendar-list scope is an error (and the grant is revoked).
		views.length = 0;
		const urls: string[] = [];
		requestUrlMock.handler = (req) => {
			urls.push(req.url);
			return json(200, { access_token: "at", expires_in: 3599, refresh_token: "1//partial", scope: SCOPE_EVENTS });
		};
		const partial = authorizeWith({ ...CONFIG, port: 0 }, presenter);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const partialState = new URL(views[0].url).searchParams.get("state");
		views[0].submit(`code=abc&state=${partialState}`);
		let partialMessage = "";
		try {
			await partial;
		} catch (error) {
			partialMessage = error instanceof AuthError ? error.message : "wrong error type";
		}
		check("missing calendar-list scope → AuthError", /tick every box/.test(partialMessage), true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		check("partial grant is revoked", urls.some((u) => u.includes("/revoke")), true);

		// Missing write scope is fine.
		views.length = 0;
		requestUrlMock.handler = () => json(200, { access_token: "at", expires_in: 3599, refresh_token: "1//ro", scope: SCOPE_CALENDAR_LIST });
		const readOnly = authorizeWith({ ...CONFIG, port: 0 }, presenter);
		await new Promise((resolve) => setTimeout(resolve, 10));
		views[0].submit(`code=abc&state=${new URL(views[0].url).searchParams.get("state")}`);
		const roGrant = await readOnly;
		check("read-only grant connects", canWriteWith(roGrant.scopes), false);

		await rejects("authorize without a client", () => authorizeWith({ clientId: "", clientSecret: "", port: 0 }, presenter), AuthError);

		// Exchange rejected by Google.
		views.length = 0;
		requestUrlMock.handler = () => json(400, { error: "invalid_grant", error_description: "Bad Request" });
		const rejected = authorizeWith({ ...CONFIG, port: 0 }, presenter);
		await new Promise((resolve) => setTimeout(resolve, 10));
		views[0].submit(`code=abc&state=${new URL(views[0].url).searchParams.get("state")}`);
		await rejects("rejected code exchange → AuthError", () => rejected, AuthError);
	} finally {
		requestUrlMock.handler = null;
		setSleep(null);
	}
});
