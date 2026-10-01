import { Notice, Plugin } from "obsidian";
import { AuthError, GoogleAuth, ReauthRequiredError, canWriteWith, revoke, type ClientConfig } from "./auth";
import { CalendarBlock } from "./block";
import { GoogleCalendarClient, describeError } from "./google";
import type { BlockQuery } from "./query";
import { sanitiseSettings, type AccountSettings, type CalendarConnectSettings } from "./settings";
import { CalendarConnectSettingTab } from "./settings-tab";
import { EventStore, finishEvents, selectCalendars } from "./store";
import { DeviceTokenStore, type StoredGrant } from "./tokens";
import type { CalEvent, CalendarInfo } from "./types";
import { authorize } from "./ui/consent-modal";
import { type EditContext } from "./ui/event-modal";

// Deliberately specific: `calendar` alone would collide with other plugins.
export const BLOCK_LANGUAGE = "calendar-connect";

/** How long a calendar list is reused, and how soon a list with failures is retried. */
const CALENDAR_LIST_TTL_MS = 60 * 60 * 1000;
const CALENDAR_LIST_RETRY_MS = 2 * 60 * 1000;

/** Account ids are primary-calendar addresses; a generated fallback id has no "@". */
function isAddress(id: string): boolean {
	return id.includes("@");
}

/** The live auth + client pair for one account signed in on this device. */
interface AccountRuntime {
	auth: GoogleAuth;
	client: GoogleCalendarClient;
	/** The OAuth client it was built for; a change means rebuilding. */
	signature: string;
}

export interface CalendarList {
	calendars: CalendarInfo[];
	errors: string[];
}

export interface QueryResult {
	events: CalEvent[];
	warnings: string[];
	/** Calendars the result was drawn from, for a targeted refresh. */
	calendarKeys: string[];
	/** Epoch ms of the oldest response used, or null when nothing was fetched. */
	fetchedAt: number | null;
}

export function reconnectWarning(label: string): string {
	return `${label}: needs reconnecting — open settings`;
}

export function notSignedInWarning(label: string): string {
	return `${label}: not signed in on this device — open settings`;
}

export default class CalendarConnectPlugin extends Plugin {
	settings: CalendarConnectSettings = sanitiseSettings(undefined);
	readonly store = new EventStore();
	editContext!: EditContext;

	private tokens!: DeviceTokenStore;
	/** Grants read from this device's keychain. Only accounts in here are signed in. */
	private readonly grants = new Map<string, StoredGrant>();
	private readonly runtimes = new Map<string, AccountRuntime>();
	/** Accounts whose refresh token Google rejected this session. In memory only. */
	private readonly needsReconnect = new Set<string>();
	private readonly blocks = new Set<CalendarBlock>();
	private calendarsPromise: Promise<CalendarList> | null = null;
	private calendarsFetchedAt = 0;
	private connecting = false;
	private settingTab: CalendarConnectSettingTab | null = null;

	async onload(): Promise<void> {
		this.tokens = new DeviceTokenStore(this.app.secretStorage);
		await this.loadSettings();
		this.syncRuntimes();

		this.editContext = {
			app: this.app,
			settings: () => this.settings,
			calendars: () => this.settings.knownCalendars,
			clientFor: (accountId) => this.clientFor(accountId),
			canWrite: (accountId) => this.canWrite(accountId),
			afterChange: (calendarKeys) => {
				// A calendar subscribed by two accounts is cached under both keys.
				const ids = new Set(calendarKeys.map((key) => this.calendar(key)?.id).filter(Boolean));
				const keys = new Set(calendarKeys);
				for (const calendar of this.settings.knownCalendars) {
					if (ids.has(calendar.id)) keys.add(calendar.key);
				}
				for (const key of keys) this.store.invalidateCalendar(key);
				this.refreshAllBlocks();
			},
		};

		this.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, (source, el, ctx) => {
			ctx.addChild(new CalendarBlock(el, source, this));
		});

		this.settingTab = new CalendarConnectSettingTab(this);
		this.addSettingTab(this.settingTab);

		this.addCommand({
			id: "refresh",
			name: "Refresh calendar data",
			callback: () => {
				this.invalidateAll();
				this.refreshAllBlocks();
				new Notice("Google Calendar refreshed");
			},
		});

		this.addCommand({
			id: "add-account",
			name: "Add a Google account",
			callback: () => void this.connectAccount(),
		});

		this.addCommand({
			id: "insert-block",
			name: "Insert calendar block",
			editorCallback: (editor) => {
				editor.replaceSelection(`\`\`\`${BLOCK_LANGUAGE}\nfrom: today\nperiod: 1d\n\`\`\`\n`);
			},
		});

		// One ticker for every block: re-draws past/now/next states without a network call.
		this.registerInterval(
			window.setInterval(() => {
				for (const block of this.blocks) block.tick();
			}, 60_000)
		);
	}

	onunload(): void {
		this.store.invalidateAll();
		this.blocks.clear();
		this.runtimes.clear();
		this.grants.clear();
		this.needsReconnect.clear();
		this.calendarsPromise = null;
	}

	async loadSettings(): Promise<void> {
		const raw: unknown = await this.loadData();
		this.settings = sanitiseSettings(raw);
		// Write back once when sanitising changed something, so the file stops carrying junk.
		if (raw !== null && raw !== undefined && JSON.stringify(raw) !== JSON.stringify(this.settings)) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Re-validates settings in place after a write from the settings tab. */
	sanitiseInPlace(): void {
		Object.assign(this.settings, sanitiseSettings(this.settings));
	}

	/** Another device synced a new data.json. Keeps in-memory access tokens where it can. */
	async onExternalSettingsChange(): Promise<void> {
		this.settings = sanitiseSettings(await this.loadData());
		this.syncRuntimes();
		this.calendarsPromise = null;
		this.store.invalidateAll();
		this.refreshAllBlocks();
		this.updateSettingTab();
	}

	updateSettingTab(): void {
		if (this.settingTab?.containerEl.isConnected) this.settingTab.update();
	}

	// --- Accounts ---------------------------------------------------------

	account(id: string): AccountSettings | undefined {
		return this.settings.accounts.find((entry) => entry.id === id);
	}

	/** Client credentials for an account, falling back to the shared ones. */
	configFor(account: AccountSettings | undefined): ClientConfig {
		return {
			clientId: (account?.clientId || this.settings.clientId).trim(),
			clientSecret: (account?.clientSecret || this.settings.clientSecret).trim(),
		};
	}

	private loadGrant(id: string): StoredGrant | null {
		try {
			return this.tokens.load(id);
		} catch (error) {
			console.error("Calendar Connect: could not read the keychain", error);
			return null;
		}
	}

	private saveGrant(id: string, grant: StoredGrant | null): void {
		if (grant) this.grants.set(id, grant);
		else this.grants.delete(id);
		try {
			this.tokens.save(id, grant);
		} catch (error) {
			console.error("Calendar Connect: could not write the keychain", error);
			new Notice("Google Calendar: could not save the sign-in to this device's keychain.", 10000);
		}
	}

	private buildRuntime(id: string): AccountRuntime {
		const auth = new GoogleAuth(
			() => this.configFor(this.account(id)),
			() => this.grants.get(id) ?? null,
			(grant) => this.saveGrant(id, grant)
		);
		const client = new GoogleCalendarClient(auth, () => ({ id, label: this.account(id)?.label ?? id }));
		return { auth, client, signature: this.clientSignature(id) };
	}

	private clientSignature(id: string): string {
		const config = this.configFor(this.account(id));
		return `${config.clientId}\n${config.clientSecret}`;
	}

	/**
	 * Brings runtimes in line with the account list: builds them for new accounts
	 * or ones whose OAuth client changed, drops removed ones, and leaves the rest
	 * (and their in-memory access tokens) alone.
	 */
	syncRuntimes(): void {
		const ids = new Set(this.settings.accounts.map((account) => account.id));
		for (const id of [...this.runtimes.keys()]) {
			if (!ids.has(id)) {
				this.runtimes.delete(id);
				this.grants.delete(id);
				this.needsReconnect.delete(id);
			}
		}
		for (const id of ids) {
			if (!this.grants.has(id)) {
				const grant = this.loadGrant(id);
				if (grant) this.grants.set(id, grant);
			}
			const existing = this.runtimes.get(id);
			if (!existing || existing.signature !== this.clientSignature(id)) {
				this.runtimes.set(id, this.buildRuntime(id));
				this.needsReconnect.delete(id);
			}
		}
	}

	/** Accounts with a sign-in stored on this device. */
	connectedAccounts(): AccountSettings[] {
		return this.settings.accounts.filter((account) => this.grants.has(account.id));
	}

	isSignedIn(id: string): boolean {
		return this.grants.has(id);
	}

	needsReconnecting(id: string): boolean {
		return this.needsReconnect.has(id);
	}

	canWrite(id: string): boolean {
		if (!this.grants.has(id) || this.needsReconnect.has(id)) return false;
		return this.runtimes.get(id)?.auth.canWrite() ?? false;
	}

	clientFor(id: string): GoogleCalendarClient | null {
		return this.grants.has(id) ? this.runtimes.get(id)?.client ?? null : null;
	}

	/** The account a "Reconnect" button should act on. */
	reconnectTarget(): AccountSettings | undefined {
		return (
			this.settings.accounts.find((account) => this.needsReconnect.has(account.id)) ??
			this.settings.accounts.find((account) => !this.grants.has(account.id)) ??
			this.settings.accounts[0]
		);
	}

	private markReauth(id: string, error: unknown): void {
		if (error instanceof ReauthRequiredError && !this.needsReconnect.has(id)) {
			this.needsReconnect.add(id);
			this.updateSettingTab();
		}
	}

	/**
	 * Runs consent (desktop or mobile), identifies the account by its primary
	 * calendar address so re-adding the same Google account updates it in place,
	 * and stores the grant in this device's keychain. Resolves false on failure.
	 */
	async connectAccount(existing?: AccountSettings): Promise<boolean> {
		const config = this.configFor(existing);
		if (!config.clientId || !config.clientSecret) {
			new Notice(
				"Add your Google Cloud client ID and secret first: Settings → Calendar Connect → Google Cloud client.",
				10000
			);
			return false;
		}
		if (this.connecting) {
			new Notice("A Google sign-in is already in progress.");
			return false;
		}

		this.connecting = true;
		try {
			const grant = await authorize(this.app, { ...config, port: this.settings.oauthPort });
			let held: StoredGrant = { refreshToken: grant.refreshToken, scopes: grant.scopes };

			// A throwaway runtime to ask who this is, before the account exists in settings.
			const probeAuth = new GoogleAuth(
				() => config,
				() => held,
				(next) => {
					held = next;
				}
			);
			probeAuth.seed(grant.accessToken, grant.expiresAt);
			let address: string | null = null;
			try {
				address = await new GoogleCalendarClient(probeAuth, () => ({
					id: existing?.id ?? "new-account",
					label: existing?.label ?? "Google account",
				})).fetchPrimaryAddress();
			} catch {
				// Falling back to a generated id is better than failing the whole connect.
			}
			const id = address ?? existing?.id ?? crypto.randomUUID();

			// Reconnecting a known address but choosing another Google account on the
			// chooser: refuse, rather than renaming or dropping the account meant.
			if (existing && address && isAddress(existing.id) && address !== existing.id) {
				throw new AuthError(
					`You signed in as ${address}, not ${existing.id}. Reconnect and choose ${existing.id} on Google's account screen.`
				);
			}

			const already = this.account(id);
			// A grant only refreshes with the client that issued it, so an account
			// with its own client cannot take one issued by the shared client.
			if (!existing && already && this.configFor(already).clientId !== config.clientId) {
				throw new AuthError(`${id} uses its own OAuth client. Use Reconnect on it in the settings instead.`);
			}

			// The branches below only ever see a record that never learned its address
			// (a generated id). It is the same user and client, so nothing is revoked:
			// Google revokes per user and client, which would kill the fresh grant.
			if (already) {
				if (existing && existing.id !== id) this.dropAccount(existing.id);
			} else if (existing) {
				const previousId = existing.id;
				this.purgeAccountData(previousId);
				this.forgetDevice(previousId);
				const record = this.account(previousId);
				if (record) {
					record.id = id;
					if (!record.label || record.label === previousId) record.label = address ?? id;
				}
			} else {
				this.settings.accounts.push({ id, label: address ?? id });
			}

			this.saveGrant(id, held);
			this.needsReconnect.delete(id);
			await this.saveSettings();

			this.syncRuntimes();
			// The fresh runtime can use the access token we already hold.
			this.runtimes.get(id)?.auth.seed(grant.accessToken, grant.expiresAt);

			const name = this.account(id)?.label ?? address ?? "Google account";
			new Notice(
				canWriteWith(held.scopes)
					? `Connected ${name} (read & write)`
					: `Connected ${name} (read-only: editing permission not granted)`,
				8000
			);

			this.invalidateAll();
			await this.getCalendars().catch(() => undefined);
			this.refreshAllBlocks();
			this.updateSettingTab();
			return true;
		} catch (error) {
			new Notice(`Google Calendar: ${describeError(error)}`, 10000);
			return false;
		} finally {
			this.connecting = false;
		}
	}

	/** Signs the account out everywhere it can: revokes the token, clears the keychain, forgets it. */
	async removeAccount(id: string): Promise<void> {
		if (!this.account(id)) return;
		const grant = this.grants.get(id);
		if (grant) {
			try {
				await revoke(grant.refreshToken);
			} catch {
				// Best effort: the token is forgotten locally either way.
			}
		}
		this.dropAccount(id);
		await this.saveSettings();
		this.invalidateAll();
		this.refreshAllBlocks();
		this.updateSettingTab();
	}

	/** Removes an account record, its calendars and selections, and this device's sign-in for it. */
	private dropAccount(id: string): void {
		this.settings.accounts = this.settings.accounts.filter((entry) => entry.id !== id);
		this.purgeAccountData(id);
		this.forgetDevice(id);
	}

	private forgetDevice(id: string): void {
		this.saveGrant(id, null);
		this.runtimes.delete(id);
		this.needsReconnect.delete(id);
	}

	/** Drops cached calendars and default selections belonging to an account. */
	private purgeAccountData(id: string): void {
		this.settings.knownCalendars = this.settings.knownCalendars.filter((calendar) => calendar.accountId !== id);
		const remaining = new Set(this.settings.knownCalendars.map((calendar) => calendar.key));
		this.settings.defaultCalendars = this.settings.defaultCalendars.filter((key) => remaining.has(key));
	}

	async renameAccount(id: string, label: string): Promise<void> {
		const account = this.account(id);
		if (!account) return;
		account.label = label;
		for (const calendar of this.settings.knownCalendars) {
			if (calendar.accountId === id) calendar.accountLabel = label;
		}
		await this.saveSettings();
		// Cached events carry the old label.
		this.store.invalidateAll();
		this.refreshAllBlocks();
	}

	// --- Blocks -----------------------------------------------------------

	registerBlock(block: CalendarBlock): void {
		this.blocks.add(block);
	}

	unregisterBlock(block: CalendarBlock): void {
		this.blocks.delete(block);
	}

	refreshAllBlocks(): void {
		for (const block of this.blocks) void block.render();
	}

	invalidateAll(): void {
		this.store.invalidateAll();
		this.calendarsPromise = null;
	}

	// --- Data -------------------------------------------------------------

	calendar(key: string): CalendarInfo | undefined {
		return this.settings.knownCalendars.find((calendar) => calendar.key === key);
	}

	/**
	 * Calendar lists for every account signed in here. One account failing does
	 * not take down the others — its error is returned for the block to surface.
	 */
	getCalendars(): Promise<CalendarList> {
		const age = Date.now() - this.calendarsFetchedAt;
		if (this.calendarsPromise && age > CALENDAR_LIST_TTL_MS) this.calendarsPromise = null;
		if (!this.calendarsPromise) {
			this.calendarsFetchedAt = Date.now();
			const promise = this.fetchAllCalendars();
			this.calendarsPromise = promise;
			promise.then(
				(list) => {
					// A partial failure is retried soon rather than cached for an hour.
					if (list.errors.length && this.calendarsPromise === promise) {
						this.calendarsFetchedAt = Date.now() - CALENDAR_LIST_TTL_MS + CALENDAR_LIST_RETRY_MS;
					}
				},
				() => {
					if (this.calendarsPromise === promise) this.calendarsPromise = null;
				}
			);
		}
		return this.calendarsPromise;
	}

	async reloadCalendars(): Promise<CalendarList> {
		this.calendarsPromise = null;
		return this.getCalendars();
	}

	private async fetchAllCalendars(): Promise<CalendarList> {
		const accounts = this.connectedAccounts().filter((account) => !this.needsReconnect.has(account.id));
		const settled = await Promise.allSettled(
			accounts.map((account) => {
				const runtime = this.runtimes.get(account.id);
				if (!runtime) return Promise.reject(new Error(`No runtime for ${account.label}`));
				return runtime.client.listCalendars();
			})
		);

		const fresh = new Map<string, CalendarInfo[]>();
		const errors: string[] = [];
		settled.forEach((outcome, index) => {
			const account = accounts[index];
			if (outcome.status === "fulfilled") {
				fresh.set(account.id, outcome.value);
				return;
			}
			this.markReauth(account.id, outcome.reason);
			errors.push(
				outcome.reason instanceof ReauthRequiredError
					? reconnectWarning(account.label)
					: `${account.label}: ${describeError(outcome.reason)}`
			);
		});

		// Accounts that failed, or are only signed in on other devices, keep their
		// synced list; otherwise this device would wipe another device's calendars.
		const next: CalendarInfo[] = [];
		for (const account of this.settings.accounts) {
			const list = fresh.get(account.id) ?? this.settings.knownCalendars.filter((c) => c.accountId === account.id);
			next.push(...list);
		}

		// Saving only on change keeps data.json still, so sync does not churn.
		if (JSON.stringify(next) !== JSON.stringify(this.settings.knownCalendars)) {
			this.settings.knownCalendars = next;
			const keys = new Set(next.map((calendar) => calendar.key));
			this.settings.defaultCalendars = this.settings.defaultCalendars.filter((key) => keys.has(key));
			await this.saveSettings();
			this.updateSettingTab();
		}

		return { calendars: this.settings.knownCalendars, errors };
	}

	/**
	 * Resolves a block's calendars, fetches each through the cache (`maxAgeMs`
	 * old at most) and returns filtered, ordered events. Calendars of accounts
	 * this device cannot use become warnings; only a total failure throws.
	 */
	async runQuery(query: BlockQuery, maxAgeMs: number): Promise<QueryResult> {
		const { calendars: available, errors } = await this.getCalendars();
		const warnings = [...errors];

		const selection = selectCalendars(query, available);
		warnings.push(...selection.warnings);
		if (selection.selected.length === 0) {
			warnings.push("No calendars selected — check the `calendars` option or the plugin settings.");
			return { events: [], warnings: unique(warnings), calendarKeys: [], fetchedAt: null };
		}

		const fetchable: CalendarInfo[] = [];
		const reconnect: AccountSettings[] = [];
		for (const calendar of selection.selected) {
			const account = this.account(calendar.accountId);
			if (!account) continue;
			if (!this.grants.has(account.id)) warnings.push(notSignedInWarning(account.label));
			else if (this.needsReconnect.has(account.id)) {
				warnings.push(reconnectWarning(account.label));
				if (!reconnect.includes(account)) reconnect.push(account);
			} else fetchable.push(calendar);
		}

		if (fetchable.length === 0) {
			if (reconnect.length) throw new ReauthRequiredError(`${reconnect[0].label} needs reconnecting`);
			return { events: [], warnings: unique(warnings), calendarKeys: [], fetchedAt: null };
		}

		const settled = await Promise.allSettled(
			fetchable.map((calendar) =>
				this.store.fetch(
					calendar,
					query.from,
					query.to,
					query.search,
					() => {
						const client = this.clientFor(calendar.accountId);
						if (!client) return Promise.reject(new Error(`${calendar.accountLabel} is not signed in on this device`));
						return client.listEvents(
							{ calendarId: calendar.id, timeMin: query.from, timeMax: query.to, search: query.search },
							calendar
						);
					},
					maxAgeMs
				)
			)
		);

		const events: CalEvent[] = [];
		let fetchedAt: number | null = null;
		settled.forEach((outcome, index) => {
			const calendar = fetchable[index];
			if (outcome.status === "fulfilled") {
				events.push(...outcome.value.events);
				fetchedAt = fetchedAt === null ? outcome.value.fetchedAt : Math.min(fetchedAt, outcome.value.fetchedAt);
				return;
			}
			this.markReauth(calendar.accountId, outcome.reason);
			warnings.push(
				outcome.reason instanceof ReauthRequiredError
					? reconnectWarning(calendar.accountLabel)
					: `${calendar.name}: ${describeError(outcome.reason)}`
			);
		});

		// Every calendar failing is an error, not a quietly empty agenda.
		const firstFailure = settled.find((outcome) => outcome.status === "rejected");
		if (settled.every((outcome) => outcome.status === "rejected") && firstFailure?.status === "rejected") {
			throw firstFailure.reason;
		}

		return {
			events: finishEvents(events, query),
			warnings: unique(warnings),
			calendarKeys: fetchable.map((calendar) => calendar.key),
			fetchedAt,
		};
	}
}

function unique(items: string[]): string[] {
	return [...new Set(items)];
}
