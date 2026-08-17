/**
 * Guards for values that come from Google — and therefore from anyone who can
 * put an event on your calendar — before they reach the DOM or the OS.
 */

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/** A CSS-safe hex colour, or null. Anything else could smuggle CSS into a style. */
export function safeColor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!HEX_COLOR.test(trimmed)) return null;
	// #rgb, #rgba, #rrggbb, #rrggbbaa only.
	return [4, 5, 7, 9].includes(trimmed.length) ? trimmed : null;
}

/**
 * The URL normalised, if it is an absolute https URL; otherwise null.
 * Calendar data can carry arbitrary strings in link fields, and opening a
 * `file:`, `javascript:` or app-scheme URL from Electron is not harmless.
 */
export function safeExternalUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (!url.hostname || url.username || url.password) return null;
	return url.toString();
}

/** Opens a URL in the system browser, but only when `safeExternalUrl` accepts it. */
export function openExternal(value: unknown): boolean {
	const url = safeExternalUrl(value);
	if (!url) return false;
	window.open(url, "_blank", "noopener");
	return true;
}
