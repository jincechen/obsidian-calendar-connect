import { backoffDelay, HttpError, parseGoogleError, request, retryDecision, setSleep } from "../src/http";
import { check, later, rejects } from "./harness";
import { requestUrlMock, type ShimRequest, type ShimResponse } from "./obsidian-shim";

// --- retryDecision -----------------------------------------------------------

const matrix: Array<[number, string | undefined, boolean, boolean, boolean]> = [
	// status, reason, idempotent, rate-only, none
	[429, undefined, true, true, false],
	[503, undefined, true, true, false],
	[500, undefined, true, false, false],
	[502, undefined, true, false, false],
	[504, undefined, true, false, false],
	[403, "rateLimitExceeded", true, true, false],
	[403, "userRateLimitExceeded", true, true, false],
	[403, "quotaExceeded", false, false, false],
	[403, "forbiddenForNonOrganizer", false, false, false],
	[403, "requiredAccessLevel", false, false, false],
	[403, undefined, false, false, false],
	[400, undefined, false, false, false],
	[401, undefined, false, false, false],
	[404, undefined, false, false, false],
	[409, undefined, false, false, false],
	[410, undefined, false, false, false],
	[412, undefined, false, false, false],
];
for (const [status, reason, idempotent, rateOnly, none] of matrix) {
	const label = `retryDecision ${status}${reason ? ` ${reason}` : ""}`;
	check(`${label} idempotent`, retryDecision(status, reason, "idempotent"), idempotent);
	check(`${label} rate-only`, retryDecision(status, reason, "rate-only"), rateOnly);
	check(`${label} none`, retryDecision(status, reason, "none"), none);
}

// --- backoffDelay ------------------------------------------------------------

check("backoff attempt 0, rand 0 → half step", backoffDelay(0, undefined, () => 0), 250);
check("backoff attempt 0, rand 1 → full step", backoffDelay(0, undefined, () => 1), 500);
check("backoff attempt 2, rand 1", backoffDelay(2, undefined, () => 1), 2000);
check("backoff capped at 8s", backoffDelay(10, undefined, () => 1), 8000);
check("backoff capped, rand 0", backoffDelay(10, undefined, () => 0), 4000);
{
	let inBounds = true;
	for (let attempt = 0; attempt < 6; attempt++) {
		for (let i = 0; i < 50; i++) {
			const step = Math.min(8000, 500 * 2 ** attempt);
			const delay = backoffDelay(attempt);
			if (delay < step / 2 || delay > step) inBounds = false;
		}
	}
	check("backoff jitter stays within [50%, 100%] of the step", inBounds, true);
}
check("Retry-After seconds honoured", backoffDelay(0, "3", () => 0), 3000);
check("Retry-After capped at 10s", backoffDelay(0, "120", () => 0), 10000);
check("Retry-After 0", backoffDelay(3, "0", () => 0), 0);
check("Retry-After garbage falls back to backoff", backoffDelay(1, "soon", () => 1), 1000);
check("Retry-After empty falls back to backoff", backoffDelay(1, "", () => 1), 1000);
check(
	"Retry-After HTTP date in the past → 0",
	backoffDelay(0, "Wed, 21 Oct 2015 07:28:00 GMT", () => 0),
	0
);

// --- parseGoogleError --------------------------------------------------------

check(
	"parseGoogleError API shape",
	parseGoogleError(
		{
			error: {
				code: 403,
				message: "Rate Limit Exceeded",
				errors: [{ domain: "usageLimits", reason: "rateLimitExceeded", message: "Rate Limit Exceeded" }],
				status: "PERMISSION_DENIED",
			},
		},
		""
	),
	{ message: "Rate Limit Exceeded", reason: "rateLimitExceeded" }
);
check(
	"parseGoogleError API shape with ErrorInfo details only",
	parseGoogleError(
		{
			error: {
				message: "Calendar API has not been used in project 1 before or it is disabled.",
				status: "PERMISSION_DENIED",
				details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
			},
		},
		""
	),
	{ message: "Calendar API has not been used in project 1 before or it is disabled.", reason: "SERVICE_DISABLED" }
);
check(
	"parseGoogleError API shape without message uses status",
	parseGoogleError({ error: { status: "NOT_FOUND" } }, ""),
	{ message: "NOT_FOUND" }
);
check(
	"parseGoogleError OAuth shape",
	parseGoogleError({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, ""),
	{ message: "Token has been expired or revoked.", reason: "invalid_grant" }
);
check(
	"parseGoogleError OAuth shape without description",
	parseGoogleError({ error: "invalid_client" }, ""),
	{ message: "invalid_client", reason: "invalid_client" }
);
check("parseGoogleError non-JSON body uses text", parseGoogleError(null, "  Bad Gateway \n"), { message: "Bad Gateway" });
check("parseGoogleError empty", parseGoogleError(undefined, ""), { message: "Unknown error" });
check(
	"parseGoogleError long text is truncated",
	parseGoogleError(null, "x".repeat(500)).message.length,
	301
);

// --- request() ---------------------------------------------------------------

/**
 * The network mock and sleep hook are global, so every async test in the http,
 * auth and google files runs through this one queue rather than interleaving.
 */
let queue: Promise<unknown> = Promise.resolve();
export function serial(task: () => Promise<unknown>): void {
	const run = queue.then(task);
	queue = run.catch(() => undefined);
	later(() => run);
}

function respond(status: number, json: unknown = {}, headers: Record<string, string> = {}): ShimResponse {
	return { status, json, text: JSON.stringify(json), headers };
}

serial(async () => {
	const sleeps: number[] = [];
	setSleep(async (ms) => {
		sleeps.push(ms);
	});
	try {
		// Retry then success.
		let calls = 0;
		requestUrlMock.handler = () => (++calls < 3 ? respond(503) : respond(200, { ok: true }, { "Content-Type": "application/json" }));
		const ok = await request({ url: "https://example.test/a", method: "GET" });
		check("request retries 503 then succeeds", [calls, ok.status, ok.json], [3, 200, { ok: true }]);
		check("request lowercases response headers", ok.headers["content-type"], "application/json");
		check("request slept between attempts", sleeps.length, 2);

		// Retry-After honoured (header in any case).
		sleeps.length = 0;
		calls = 0;
		requestUrlMock.handler = () => (++calls === 1 ? respond(429, {}, { "Retry-After": "2" }) : respond(200));
		await request({ url: "https://example.test/a", method: "GET" });
		check("request honours Retry-After", sleeps, [2000]);

		// Gives up after maxRetries and returns the last response.
		calls = 0;
		requestUrlMock.handler = () => {
			calls++;
			return respond(500);
		};
		const failed = await request({ url: "https://example.test/a", method: "GET" });
		check("request gives up after 3 retries", [calls, failed.status], [4, 500]);

		calls = 0;
		await request({ url: "https://example.test/a", method: "GET", maxRetries: 1 });
		check("request respects maxRetries", calls, 2);

		// No retry on 412.
		calls = 0;
		requestUrlMock.handler = () => {
			calls++;
			return respond(412, { error: { message: "Precondition Failed", errors: [{ reason: "conditionNotMet" }] } });
		};
		const conflict = await request({ url: "https://example.test/a", method: "PATCH", retryPolicy: "rate-only" });
		check("request does not retry 412", [calls, conflict.status], [1, 412]);

		// POST defaults to no retries.
		calls = 0;
		requestUrlMock.handler = () => {
			calls++;
			return respond(503);
		};
		await request({ url: "https://example.test/a", method: "POST" });
		check("POST defaults to retry policy none", calls, 1);

		// rate-only does not retry 500.
		calls = 0;
		requestUrlMock.handler = () => {
			calls++;
			return respond(500);
		};
		await request({ url: "https://example.test/a", method: "PATCH", retryPolicy: "rate-only" });
		check("rate-only does not retry 500", calls, 1);

		// 403 rate limit is retried under rate-only.
		calls = 0;
		requestUrlMock.handler = () =>
			++calls === 1 ? respond(403, { error: { message: "x", errors: [{ reason: "userRateLimitExceeded" }] } }) : respond(200);
		const limited = await request({ url: "https://example.test/a", method: "PATCH", retryPolicy: "rate-only" });
		check("rate-only retries 403 userRateLimitExceeded", [calls, limited.status], [2, 200]);

		// Request parameters pass through.
		let seen: ShimRequest | null = null;
		requestUrlMock.handler = (req) => {
			seen = req;
			return respond(200);
		};
		await request({
			url: "https://example.test/b",
			method: "PATCH",
			headers: { "If-Match": "\"1\"" },
			body: "{}",
			contentType: "application/json",
		});
		const passed = seen as ShimRequest | null;
		check("request passes method, body, headers and throw:false", passed && [passed.method, passed.body, passed.headers, passed.contentType, passed.throw], [
			"PATCH",
			"{}",
			{ "If-Match": "\"1\"" },
			"application/json",
			false,
		]);

		// Non-JSON body: Obsidian's json getter throws.
		requestUrlMock.handler = () => ({
			status: 502,
			headers: {},
			text: "<html>Bad Gateway</html>",
			get json(): unknown {
				throw new SyntaxError("Unexpected token <");
			},
		});
		const html = await request({ url: "https://example.test/c", method: "POST" });
		check("request tolerates a throwing json getter", [html.status, html.json, html.text], [502, null, "<html>Bad Gateway</html>"]);

		// Timeout.
		requestUrlMock.handler = () => new Promise<ShimResponse>((resolve) => setTimeout(() => resolve(respond(200)), 200));
		await rejects(
			"request times out",
			() => request({ url: "https://example.test/slow", method: "POST", timeoutMs: 20 }),
			HttpError
		);
		try {
			await request({ url: "https://example.test/slow", method: "POST", timeoutMs: 20 });
		} catch (error) {
			check("timeout error kind", (error as HttpError).kind, "timeout");
		}

		// Thrown network error → HttpError("network"); idempotent retries it.
		calls = 0;
		requestUrlMock.handler = () => {
			calls++;
			throw new Error("net::ERR_INTERNET_DISCONNECTED");
		};
		try {
			await request({ url: "https://example.test/d", method: "GET", headers: { Authorization: "Bearer SECRET" } });
			check("network failure rejects", "resolved", "rejected");
		} catch (error) {
			check("network failure kind", (error as HttpError).kind, "network");
			check("network failure retried for GET", calls, 4);
			check("network error message never includes headers", /SECRET/.test((error as Error).message), false);
		}

		// rate-only does not retry network failures.
		calls = 0;
		await rejects("rate-only network failure rejects", () => request({ url: "https://example.test/d", method: "PATCH", retryPolicy: "rate-only" }), HttpError);
		check("rate-only does not retry network failures", calls, 1);
	} finally {
		requestUrlMock.handler = null;
		setSleep(null);
	}
});
