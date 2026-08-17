/**
 * Refresh tokens live in the device keychain (`app.secretStorage`), never in
 * `data.json`, so nothing that can act on an account is synced between devices.
 * Each device signs in on its own.
 */

/** What survives a restart. The access token is kept in memory only. */
export interface StoredGrant {
	refreshToken: string;
	scopes: string[];
}

/** The slice of `app.secretStorage` used here, so tests can pass an in-memory fake. */
export interface SecretBackend {
	getSecret(id: string): string | null;
	setSecret(id: string, value: string): void;
}

/** 32-bit FNV-1a over the UTF-8 bytes, as 8 hex digits. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Keychain ids may only contain lowercase letters, digits and dashes. The slug
 * keeps entries recognisable; the hash of the raw id keeps distinct accounts
 * distinct even when their slugs collide (`a.b@x` vs `a-b@x`).
 */
export function secretIdFor(accountId: string): string {
	const slug =
		accountId
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/, "") || "account";
	return `calendar-connect-${slug}-${fnv1a(accountId)}`;
}

function parseGrant(raw: string | null): StoredGrant | null {
	if (!raw) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const refreshToken = record["refreshToken"];
	if (typeof refreshToken !== "string" || refreshToken === "") return null;
	const scopes = Array.isArray(record["scopes"])
		? record["scopes"].filter((scope): scope is string => typeof scope === "string" && scope !== "")
		: [];
	return { refreshToken, scopes };
}

export class DeviceTokenStore {
	constructor(private readonly backend: SecretBackend) {}

	/** The stored grant, or null when there is none or it is unreadable. */
	load(accountId: string): StoredGrant | null {
		let raw: string | null;
		try {
			raw = this.backend.getSecret(secretIdFor(accountId));
		} catch {
			return null;
		}
		return parseGrant(raw);
	}

	/** Stores the grant; null clears the entry. Keychain failures propagate. */
	save(accountId: string, grant: StoredGrant | null): void {
		const value = grant ? JSON.stringify({ refreshToken: grant.refreshToken, scopes: grant.scopes }) : "";
		this.backend.setSecret(secretIdFor(accountId), value);
	}
}
