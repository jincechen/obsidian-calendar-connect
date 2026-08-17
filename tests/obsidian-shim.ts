// Minimal stand-in for the parts of the `obsidian` module that the pure-logic
// modules use, so they can run under plain node. UI modules (modals, settings
// tab, block) are never imported by tests and need nothing here.
//
// `require` rather than `import`: moment is a CommonJS export of a callable
// value, and an ESM namespace import wraps it in an object.

export const moment = require("moment") as typeof import("moment");

const yaml = require("yaml") as { parse: (source: string) => unknown };

export function parseYaml(source: string): unknown {
	return yaml.parse(source);
}

export interface ShimRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
	throw?: boolean;
}

export interface ShimResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
}

/**
 * Tests install a handler to play the server. Without one, any network call is
 * a test bug and fails loudly.
 */
export const requestUrlMock: { handler: ((req: ShimRequest) => Promise<ShimResponse> | ShimResponse) | null } = {
	handler: null,
};

export async function requestUrl(req: ShimRequest | string): Promise<ShimResponse> {
	const request = typeof req === "string" ? { url: req } : req;
	if (!requestUrlMock.handler) throw new Error(`requestUrl called without a mock: ${request.url}`);
	return requestUrlMock.handler(request);
}

export const Platform = {
	isDesktopApp: false,
	isMobile: false,
	isMobileApp: false,
};

export class Notice {
	constructor(readonly message: string, readonly timeout?: number) {}
}
