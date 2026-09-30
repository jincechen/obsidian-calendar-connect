import { Platform } from "obsidian";
import { HttpError, parseGoogleError, request, type RetryPolicy } from "./http";
import type { StoredGrant } from "./tokens";

// This module is imported by tests, so it must not import UI classes. The modal
// that drives `authorizeWith` lives in ui/consent-modal.ts, which also exports
// the app-facing `authorize(app, config)`.

export const SCOPE_CALENDAR_LIST = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const SCOPE_EVENTS = "https://www.googleapis.com/auth/calendar.events";
/** Broader scopes that also satisfy our needs, in case a grant carries them. */
const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar";
const SCOPE_CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
export const SCOPES = [SCOPE_CALENDAR_LIST, SCOPE_EVENTS];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** How long the consent flow may stay open. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
/** Token endpoint calls get longer than API calls: a failed exchange costs a whole sign-in. */
const TOKEN_TIMEOUT_MS = 30_000;
/** Refresh a little early so a long request can't expire mid-flight. */
const EXPIRY_SKEW_MS = 60 * 1000;

export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthError";
	}
}

/** The refresh token was revoked or expired (`invalid_grant`); only a new sign-in helps. */
export class ReauthRequiredError extends AuthError {
	constructor(message = "Google sign-in expired or was revoked — reconnect the account.") {
		super(message);
		this.name = "ReauthRequiredError";
	}
}

export interface ClientConfig {
	clientId: string;
	clientSecret: string;
}

export interface TokenGrant {
	refreshToken: string;
	accessToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
	scopes: string[];
}

// --- Pure helpers ----------------------------------------------------------

/** Everything needed to finish a consent request we started. */
export interface PendingConsent {
	url: string;
	state: string;
	verifier: string;
	redirectUri: string;
}

// Web Crypto rather than Node's `crypto`: typed by lib.dom, available in
// Obsidian's renderer on every platform, and global in Node 20 for tests.

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

async function sha256(text: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return new Uint8Array(digest);
}

/** Builds the consent URL with PKCE (S256), a fresh state, and both scopes. */
export async function buildConsent(clientId: string, redirectUri: string): Promise<PendingConsent> {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(await sha256(verifier));
	const state = base64url(randomBytes(16));
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: SCOPES.join(" "),
		access_type: "offline",
		// select_account forces the chooser, so the browser's default Google session
		// is not silently used; consent guarantees a refresh token every time.
		prompt: "select_account consent",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state, verifier, redirectUri };
}

/**
 * Extracts the authorization code from what the user pasted: the full redirect
 * URL, a scheme-less `127.0.0.1:port/?…`, `?code=…`, or `code=…&state=…`.
 * Throws AuthError with a sentence fit to show inline.
 */
export function parseRedirect(pasted: string, pending: PendingConsent): string {
	const text = pasted.trim().replace(/^["'<]+|["'>]+$/g, "");
	if (!text) throw new AuthError("Paste the address from your browser's address bar.");

	let query: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
		try {
			query = new URL(text).search;
		} catch {
			throw new AuthError("That doesn't look like a web address. Copy the full address from the address bar.");
		}
	} else {
		const mark = text.indexOf("?");
		query = mark >= 0 ? text.slice(mark) : text;
	}
	// A trailing fragment is never part of the query we want.
	const hash = query.indexOf("#");
	if (hash >= 0) query = query.slice(0, hash);
	const params = new URLSearchParams(query);

	const error = params.get("error");
	if (error) {
		if (error === "access_denied") throw new AuthError("Access was declined on Google's consent screen.");
		throw new AuthError(`Google returned an error: ${error}`);
	}
	if (params.get("state") !== pending.state) {
		throw new AuthError("That address belongs to a different sign-in attempt. Use the link from this window.");
	}
	const code = params.get("code");
	if (!code) {
		throw new AuthError("That address has no authorization code. Copy the full address from the address bar.");
	}
	return code;
}

/** Normalises a token response's `scope` (space-separated) or a stored list. */
export function parseScopes(value: unknown): string[] {
	const parts =
		typeof value === "string" ? value.split(/\s+/) : Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
	return [...new Set((parts as string[]).filter((scope) => scope !== ""))];
}

export function canWriteWith(scopes: string[]): boolean {
	return scopes.includes(SCOPE_EVENTS) || scopes.includes(SCOPE_CALENDAR);
}

export function hasCalendarList(scopes: string[]): boolean {
	return scopes.includes(SCOPE_CALENDAR_LIST) || scopes.includes(SCOPE_CALENDAR) || scopes.includes(SCOPE_CALENDAR_READONLY);
}

function sameScopes(a: string[], b: string[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	return left.size === right.size && [...left].every((scope) => right.has(scope));
}

// --- Token endpoint --------------------------------------------------------

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function expiresAtFrom(payload: Record<string, unknown>): number {
	const seconds = Number(payload["expires_in"]);
	return Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
}

/** POSTs a form to the token endpoint. Resolves the JSON body on success. */
async function postToken(
	form: Record<string, string>,
	retryPolicy: RetryPolicy
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; status: number; message: string; reason?: string }> {
	const response = await request({
		url: TOKEN_ENDPOINT,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(form).toString(),
		timeoutMs: TOKEN_TIMEOUT_MS,
		retryPolicy,
	});
	if (response.status >= 400) {
		const { message, reason } = parseGoogleError(response.json, response.text);
		return { ok: false, status: response.status, message, reason };
	}
	const payload = response.json && typeof response.json === "object" ? (response.json as Record<string, unknown>) : {};
	return { ok: true, payload };
}

/** Swaps an authorization code for tokens. Codes are single-use, so this is never retried. */
export async function exchangeCode(config: ClientConfig, code: string, pending: PendingConsent): Promise<TokenGrant> {
	let result;
	try {
		result = await postToken(
			{
				code,
				client_id: config.clientId,
				client_secret: config.clientSecret,
				redirect_uri: pending.redirectUri,
				grant_type: "authorization_code",
				code_verifier: pending.verifier,
			},
			"none"
		);
	} catch (error) {
		if (error instanceof HttpError) {
			throw new AuthError("Couldn't reach Google to finish signing in. Check your connection and try again.");
		}
		throw error;
	}
	if (!result.ok) {
		throw new AuthError(`Google rejected the sign-in (${result.reason ?? result.status}): ${result.message}`);
	}

	const { payload } = result;
	const refreshToken = asString(payload["refresh_token"]);
	if (!refreshToken) {
		throw new AuthError(
			"Google did not return a refresh token. Remove this app's access at myaccount.google.com/permissions and connect again."
		);
	}
	return {
		refreshToken,
		accessToken: asString(payload["access_token"]) ?? "",
		expiresAt: expiresAtFrom(payload),
		scopes: parseScopes(payload["scope"]),
	};
}

export interface RefreshResult {
	accessToken: string;
	expiresAt: number;
	/** Present only when Google rotated the refresh token. */
	refreshToken?: string;
	/** Empty when the response carried no `scope`. */
	scopes: string[];
}

/**
 * Trades a refresh token for an access token. `invalid_grant` becomes
 * `ReauthRequiredError`; a network failure stays an `HttpError` so callers can
 * tell "offline" from "signed out".
 */
export async function refreshGrant(config: ClientConfig, refreshToken: string): Promise<RefreshResult> {
	const result = await postToken(
		{
			client_id: config.clientId,
			client_secret: config.clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		},
		// A refresh changes nothing server-side, but an unexplained failure is not
		// worth hammering; only back off when Google says so.
		"rate-only"
	);
	if (!result.ok) {
		if (result.reason === "invalid_grant") throw new ReauthRequiredError();
		if (result.reason === "invalid_client" || result.reason === "unauthorized_client") {
			throw new AuthError(`Google rejected the OAuth client (${result.reason}). Check the client ID and secret in settings.`);
		}
		throw new AuthError(`Google's sign-in service returned an error (${result.reason ?? result.status}): ${result.message}`);
	}
	const accessToken = asString(result.payload["access_token"]);
	if (!accessToken) throw new AuthError("Google's sign-in service returned no access token.");
	return {
		accessToken,
		expiresAt: expiresAtFrom(result.payload),
		refreshToken: asString(result.payload["refresh_token"]),
		scopes: parseScopes(result.payload["scope"]),
	};
}

/** Best-effort revocation. Never throws: the caller is dropping the account regardless. */
export async function revoke(token: string): Promise<void> {
	try {
		await request({
			url: REVOKE_ENDPOINT,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: new URLSearchParams({ token }).toString(),
			retryPolicy: "none",
		});
	} catch {
		/* Nothing useful to do. */
	}
}

// --- Loopback listener (desktop only) --------------------------------------

// Node's own types are deliberately not imported: environments without
// @types/node would degrade every `http` value to `any`. These are the members
// actually used.

interface LoopbackAddress {
	port: number;
}

interface LoopbackRequest {
	url?: string;
}

interface LoopbackResponse {
	writeHead(status: number, headers?: Record<string, string>): LoopbackResponse;
	end(body?: string, callback?: () => void): void;
}

interface LoopbackServer {
	address(): LoopbackAddress | string | null;
	listen(port: number, host: string, onListening: () => void): void;
	close(): void;
	/** Node 18.2+. Optional so an older runtime simply skips it. */
	closeAllConnections?(): void;
	on(event: "error", handler: (error: { message: string }) => void): void;
}

type CreateServer = (handler: (req: LoopbackRequest, res: LoopbackResponse) => void) => LoopbackServer;

/**
 * Node's `http`, loaded on demand behind a platform guard. A static import would
 * run on plugin load and break mobile; `import("http")` would be resolved by
 * Chromium against the app:// origin and never reach Node.
 */
function loadCreateServer(): CreateServer | null {
	if (!Platform.isDesktopApp) return null;
	const electronRequire = (window as unknown as { require?: (id: string) => unknown }).require;
	if (!electronRequire) return null;
	try {
		const http = electronRequire("http") as { createServer?: CreateServer };
		return typeof http.createServer === "function" ? http.createServer : null;
	} catch {
		return null;
	}
}

/** What the loopback page tells the browser. Static text only: no request data is echoed. */
export type LoopbackOutcome = "ok" | "failed" | "stale";

const PAGE_STYLE = `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#14161a;color:#e6e8eb;
display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:30rem;padding:2rem}
h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{color:#9aa2ad;margin:0;line-height:1.5}`;

function staticPage(title: string, message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

const PAGES: Record<LoopbackOutcome, string> = {
	ok: staticPage("Connected", "Obsidian is now linked to your Google Calendar. You can close this tab."),
	failed: staticPage("Sign-in failed", "You can close this tab. Obsidian shows what went wrong."),
	stale: staticPage("Link out of date", "This sign-in link is from an earlier attempt. Go back to Obsidian and use the latest link."),
};

/** A running listener. `setHandler` receives each redirect's full URL. */
export interface Loopback {
	redirectUri: string;
	setHandler(handler: (url: string) => { outcome: LoopbackOutcome; after?: () => void }): void;
	close(): void;
}

/**
 * Starts a short-lived listener on 127.0.0.1 (port 0 = ephemeral). Desktop-app
 * OAuth clients accept any `http://127.0.0.1:<port>` redirect. Resolves null on
 * mobile or when the listener cannot start; the caller then falls back to paste.
 */
export function listenForRedirect(port: number): Promise<Loopback | null> {
	const createServer = loadCreateServer();
	if (!createServer) return Promise.resolve(null);

	return new Promise<Loopback | null>((resolve) => {
		let handler: ((url: string) => { outcome: LoopbackOutcome; after?: () => void }) | null = null;
		let listening = false;
		let closed = false;
		let server: LoopbackServer;

		const close = () => {
			if (closed) return;
			closed = true;
			// The browser holds the socket open with keep-alive, which would otherwise
			// keep the port bound long after we are done with it.
			server.closeAllConnections?.();
			server.close();
		};

		try {
			server = createServer((req, res) => {
				let url: URL;
				try {
					url = new URL(req.url ?? "/", "http://127.0.0.1");
				} catch {
					res.writeHead(400).end();
					return;
				}
				const params = url.searchParams;
				if (!params.has("code") && !params.has("error") && !params.has("state")) {
					// Favicon and other stray requests from the browser.
					res.writeHead(404).end();
					return;
				}
				const result = handler ? handler(`http://127.0.0.1${url.pathname}${url.search}`) : { outcome: "stale" as const };
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					Connection: "close",
				});
				// Settle once the page is flushed; a fallback timer covers a socket
				// that never reports back.
				let done = false;
				const after = () => {
					if (done) return;
					done = true;
					result.after?.();
				};
				res.end(PAGES[result.outcome], after);
				if (result.after) setTimeout(after, 500);
			});
		} catch {
			resolve(null);
			return;
		}

		server.on("error", () => {
			if (!listening) {
				try {
					close();
				} catch {
					/* Never bound. */
				}
				resolve(null);
			}
		});

		try {
			server.listen(port, "127.0.0.1", () => {
				listening = true;
				const address = server.address();
				if (typeof address !== "object" || address === null) {
					close();
					resolve(null);
					return;
				}
				resolve({
					redirectUri: `http://127.0.0.1:${address.port}`,
					setHandler: (fn) => {
						handler = fn;
					},
					close,
				});
			});
		} catch {
			resolve(null);
		}
	});
}

/** A redirect port for paste-only sign-in: nothing listens, the user copies the URL. */
export function randomPastePort(): number {
	const [value = 0] = new Uint32Array(randomBytes(4).buffer);
	return 49152 + (value % (65535 - 49152 + 1));
}

// --- The consent flow ------------------------------------------------------

/** What the consent UI is given. */
export interface ConsentView {
	url: string;
	/** True when a desktop listener can finish the flow without pasting. */
	listening: boolean;
	/** Validates a pasted address. Returns an error to show inline, or null once accepted. */
	submit(pasted: string): string | null;
	/** The user closed the UI. */
	cancel(): void;
}

/** Shows the consent UI and returns a function that closes it. */
export type ConsentPresenter = (view: ConsentView) => () => void;

/**
 * Runs the whole consent flow: listener when possible, paste always, exactly one
 * settles. Rejects with AuthError on cancel, timeout or failure. Requires the
 * calendar-list scope; a missing write scope is left for the caller to report.
 */
export async function authorizeWith(config: ClientConfig & { port: number }, present: ConsentPresenter): Promise<TokenGrant> {
	if (!config.clientId || !config.clientSecret) {
		throw new AuthError("Add your OAuth client ID and client secret in the plugin settings first.");
	}

	const loopback = await listenForRedirect(config.port);
	let pending: PendingConsent;
	try {
		pending = await buildConsent(config.clientId, loopback?.redirectUri ?? `http://127.0.0.1:${randomPastePort()}`);
	} catch (error) {
		loopback?.close();
		throw error;
	}

	const code = await new Promise<string>((resolve, reject) => {
		let settled = false;
		let closeUi: (() => void) | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			loopback?.close();
			closeUi?.();
			settle();
		};

		loopback?.setHandler((url) => {
			if (settled) return { outcome: "stale" };
			// A redirect carrying someone else's state (an old tab, a stray page) is
			// answered but ignored, so it cannot cancel the attempt in progress.
			let state: string | null = null;
			try {
				state = new URL(url).searchParams.get("state");
			} catch {
				/* Treated as stale. */
			}
			if (state !== pending.state) return { outcome: "stale" };
			try {
				const value = parseRedirect(url, pending);
				return { outcome: "ok", after: () => finish(() => resolve(value)) };
			} catch (error) {
				return { outcome: "failed", after: () => finish(() => reject(error)) };
			}
		});

		closeUi = present({
			url: pending.url,
			listening: loopback !== null,
			submit: (pasted) => {
				if (settled) return null;
				try {
					const value = parseRedirect(pasted, pending);
					finish(() => resolve(value));
					return null;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
			cancel: () => finish(() => reject(new AuthError("Authorization cancelled"))),
		});
		// The UI may have been settled synchronously while opening.
		if (settled) closeUi();

		timer = setTimeout(
			() => finish(() => reject(new AuthError("Timed out waiting for Google's consent screen. Try again."))),
			CONSENT_TIMEOUT_MS
		);
	});

	const grant = await exchangeCode(config, code, pending);
	if (!hasCalendarList(grant.scopes)) {
		void revoke(grant.refreshToken);
		throw new AuthError(
			"Google didn't grant access to your calendar list. Connect again and tick every box on Google's consent screen."
		);
	}
	return grant;
}

// --- Per-account token lifecycle -------------------------------------------

/**
 * Owns one account's access token. The refresh token and scopes come from the
 * device keychain via `getGrant`; the access token lives in memory only.
 */
export class GoogleAuth {
	private accessToken: string | null = null;
	private expiresAt = 0;
	/** The refresh token the cached access token was minted from. */
	private mintedFrom: string | null = null;
	private refreshInFlight: Promise<string> | null = null;

	constructor(
		private readonly getConfig: () => ClientConfig,
		private readonly getGrant: () => StoredGrant | null,
		private readonly onGrantChange: (grant: StoredGrant) => void
	) {}

	isConnected(): boolean {
		return Boolean(this.getGrant()?.refreshToken);
	}

	scopes(): string[] {
		return this.getGrant()?.scopes ?? [];
	}

	canWrite(): boolean {
		return canWriteWith(this.scopes());
	}

	seed(accessToken: string, expiresAt: number): void {
		if (!accessToken) return;
		this.accessToken = accessToken;
		this.expiresAt = expiresAt;
		this.mintedFrom = this.getGrant()?.refreshToken ?? null;
	}

	async getAccessToken(): Promise<string> {
		const grant = this.getGrant();
		if (!grant?.refreshToken) throw new AuthError("This Google account is not signed in on this device.");
		if (
			this.accessToken &&
			// Seeded before the grant was stored (null), or minted from the current grant.
			(this.mintedFrom === null || this.mintedFrom === grant.refreshToken) &&
			Date.now() < this.expiresAt - EXPIRY_SKEW_MS
		) {
			return this.accessToken;
		}
		return this.refresh();
	}

	/** Forces a refresh, coalescing concurrent callers onto one request. */
	refresh(): Promise<string> {
		if (this.refreshInFlight) return this.refreshInFlight;
		const run = this.runRefresh();
		this.refreshInFlight = run;
		const clear = () => {
			if (this.refreshInFlight === run) this.refreshInFlight = null;
		};
		run.then(clear, clear);
		return run;
	}

	private async runRefresh(): Promise<string> {
		const grant = this.getGrant();
		if (!grant?.refreshToken) throw new AuthError("This Google account is not signed in on this device.");

		let result: RefreshResult;
		try {
			result = await refreshGrant(this.getConfig(), grant.refreshToken);
		} catch (error) {
			if (error instanceof ReauthRequiredError) {
				this.accessToken = null;
				this.mintedFrom = null;
			}
			throw error;
		}

		const rotated = result.refreshToken !== undefined && result.refreshToken !== grant.refreshToken;
		const scopesChanged = result.scopes.length > 0 && !sameScopes(result.scopes, grant.scopes);
		const refreshToken = result.refreshToken ?? grant.refreshToken;

		this.accessToken = result.accessToken;
		this.expiresAt = result.expiresAt;
		this.mintedFrom = refreshToken;

		if (rotated || scopesChanged) {
			this.onGrantChange({ refreshToken, scopes: scopesChanged ? result.scopes : grant.scopes });
		}
		return result.accessToken;
	}
}
