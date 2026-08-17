import { requestUrl } from "obsidian";

/**
 * Which failures may be retried automatically.
 * - `idempotent`: repeating the request cannot do harm (reads, deletes, inserts with a client id).
 * - `rate-only`: only when Google said "slow down", which means the request was not applied.
 * - `none`: never.
 */
export type RetryPolicy = "idempotent" | "rate-only" | "none";

export interface HttpRequest {
	url: string;
	method: "GET" | "POST" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
	/** Default 20000. `requestUrl` has no timeout of its own. */
	timeoutMs?: number;
	/** Default "idempotent" for GET/DELETE, "none" otherwise. */
	retryPolicy?: RetryPolicy;
	/** Default 3. */
	maxRetries?: number;
}

export interface HttpResponse {
	status: number;
	json: unknown;
	text: string;
	/** Header names lowercased. */
	headers: Record<string, string>;
}

/** The request never produced an HTTP response. HTTP error statuses are not errors here. */
export class HttpError extends Error {
	constructor(readonly kind: "timeout" | "network", message: string) {
		super(message);
		this.name = "HttpError";
	}
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 10_000;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** Whether a response with this status (and Google error reason) is worth repeating. */
export function retryDecision(status: number, reason: string | undefined, policy: RetryPolicy): boolean {
	if (policy === "none") return false;
	// 403 is retryable only for rate limits; quotaExceeded, forbiddenForNonOrganizer,
	// requiredAccessLevel etc. will fail the same way every time.
	if (status === 403) return reason !== undefined && RATE_LIMIT_REASONS.has(reason);
	if (status === 429 || status === 503) return true;
	if (policy === "idempotent") return status === 500 || status === 502 || status === 504;
	return false;
}

/**
 * Milliseconds to wait before retry number `attempt` (0-based). A `Retry-After`
 * header (seconds, or an HTTP date) wins but is capped; otherwise exponential
 * backoff with jitter in [50%, 100%] of the step.
 */
export function backoffDelay(attempt: number, retryAfter?: string, rand: () => number = Math.random): number {
	if (retryAfter !== undefined && retryAfter.trim() !== "") {
		const trimmed = retryAfter.trim();
		if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.min(MAX_RETRY_AFTER_MS, Number(trimmed) * 1000);
		const at = Date.parse(trimmed);
		if (!Number.isNaN(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
	}
	const step = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
	return Math.round(step * (0.5 + rand() / 2));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Pulls a message and machine reason out of either error shape Google uses:
 * API errors `{error: {message, errors: [{reason}], status}}` and OAuth errors
 * `{error: "invalid_grant", error_description}`.
 */
export function parseGoogleError(json: unknown, text: string): { message: string; reason?: string } {
	const body = asRecord(json);
	const error = body?.["error"];

	const apiError = asRecord(error);
	if (apiError) {
		const errors = Array.isArray(apiError["errors"]) ? apiError["errors"] : [];
		let reason = asString(asRecord(errors[0])?.["reason"]);
		if (!reason && Array.isArray(apiError["details"])) {
			// Newer responses carry the reason in a google.rpc.ErrorInfo detail instead.
			for (const detail of apiError["details"]) {
				reason = asString(asRecord(detail)?.["reason"]);
				if (reason) break;
			}
		}
		const message = asString(apiError["message"]) ?? asString(apiError["status"]) ?? fallbackMessage(text);
		return reason ? { message, reason } : { message };
	}

	const oauthError = asString(error);
	if (oauthError) {
		return { message: asString(body?.["error_description"]) ?? oauthError, reason: oauthError };
	}

	return { message: fallbackMessage(text) };
}

function fallbackMessage(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "Unknown error";
	return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

let sleepImpl = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test hook: replace the backoff sleep (pass null to restore the real one). */
export function setSleep(fn: ((ms: number) => Promise<void>) | null): void {
	sleepImpl = fn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "the server";
	}
}

function lowercaseHeaders(headers: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	const record = asRecord(headers);
	if (!record) return result;
	for (const [name, value] of Object.entries(record)) {
		if (typeof value === "string") result[name.toLowerCase()] = value;
		else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ");
		else if (value !== undefined && value !== null) result[name.toLowerCase()] = String(value);
	}
	return result;
}

/** One attempt, bounded by a timeout. Error messages name the host only, never headers. */
async function attemptOnce(req: HttpRequest): Promise<HttpResponse> {
	const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const pending = requestUrl({
		url: req.url,
		method: req.method,
		headers: req.headers,
		body: req.body,
		contentType: req.contentType,
		throw: false,
	});
	// The losing side of the race must not surface as an unhandled rejection.
	pending.catch(() => undefined);

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new HttpError("timeout", `Request to ${hostOf(req.url)} timed out after ${Math.round(timeoutMs / 1000)}s`)),
			timeoutMs
		);
	});

	try {
		const raw = await Promise.race([pending, timeout]);
		// `json` is a getter that throws for non-JSON bodies in Obsidian.
		let text = "";
		try {
			text = raw.text ?? "";
		} catch {
			/* Binary or empty body. */
		}
		let json: unknown = null;
		try {
			json = raw.json as unknown;
		} catch {
			/* Not JSON. */
		}
		return { status: raw.status, json, text, headers: lowercaseHeaders(raw.headers) };
	} catch (error) {
		if (error instanceof HttpError) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new HttpError("network", `Request to ${hostOf(req.url)} failed: ${detail}`);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * `requestUrl` with a timeout and retries. Resolves for every HTTP status;
 * rejects only with `HttpError` when no response arrived.
 */
export async function request(req: HttpRequest): Promise<HttpResponse> {
	const policy = req.retryPolicy ?? (req.method === "GET" || req.method === "DELETE" ? "idempotent" : "none");
	const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;

	for (let attempt = 0; ; attempt++) {
		let response: HttpResponse;
		try {
			response = await attemptOnce(req);
		} catch (error) {
			// Without a response we cannot know whether the request was applied, so
			// only requests that are safe to repeat are retried.
			if (error instanceof HttpError && policy === "idempotent" && attempt < maxRetries) {
				await sleepImpl(backoffDelay(attempt));
				continue;
			}
			throw error;
		}

		if (response.status >= 400 && attempt < maxRetries) {
			const { reason } = parseGoogleError(response.json, response.text);
			if (retryDecision(response.status, reason, policy)) {
				await sleepImpl(backoffDelay(attempt, response.headers["retry-after"]));
				continue;
			}
		}
		return response;
	}
}
