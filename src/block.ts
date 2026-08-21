import { MarkdownRenderChild } from "obsidian";
import { moment, type Moment } from "./moment-shim";
import { AuthError } from "./auth";
import { describeError } from "./google";
import type CalendarConnectPlugin from "./main";
import { QueryError, parseQuery, type BlockQuery } from "./query";
import { renderEvents, renderMessage, type BlockActions } from "./render";
import { openExternal } from "./safety";
import type { CalEvent } from "./types";

/** What was last drawn. */
interface Drawn {
	events: CalEvent[];
	query: BlockQuery;
	warnings: string[];
	lastUpdated: Moment | null;
}

/**
 * One rendered `calendar-connect` block. Fetching goes through the plugin's shared
 * cache; the block owns only its timers and what it last drew.
 */
export class CalendarBlock extends MarkdownRenderChild {
	private renderToken = 0;
	private refreshTimer: number | null = null;
	private refreshSeconds = 0;
	private drawn: Drawn | null = null;
	/** Epoch ms of the data last drawn; drives the catch-up refresh. */
	private fetchedAt = 0;
	private calendarKeys: string[] = [];

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly plugin: CalendarConnectPlugin
	) {
		super(containerEl);
	}

	onload(): void {
		this.plugin.registerBlock(this);
		this.registerDomEvent(this.containerEl.doc, "visibilitychange", () => this.catchUp());
		void this.render();
	}

	onunload(): void {
		this.plugin.unregisterBlock(this);
		this.clearTimer();
	}

	/**
	 * Parses the block and draws it. `maxAgeMs` bounds how old cached data may be;
	 * by default the cache lifetime from settings.
	 */
	async render(maxAgeMs?: number): Promise<void> {
		// Guard against an older render (e.g. auto-refresh) landing after a newer one.
		const token = ++this.renderToken;
		const settings = this.plugin.settings;

		let parsed;
		try {
			parsed = parseQuery(this.source, settings);
		} catch (error) {
			this.reset();
			renderMessage(
				this.containerEl,
				"error",
				error instanceof QueryError ? "Invalid calendar-connect block" : "Could not read this block",
				error instanceof Error ? error.message : String(error)
			);
			return;
		}
		const { query, warnings } = parsed;

		if (settings.accounts.length === 0) {
			this.reset();
			renderMessage(
				this.containerEl,
				"notice",
				"No Google account connected",
				"Add your Google Cloud client in the plugin settings, then add an account.",
				{ label: "Add account", onClick: () => void this.plugin.connectAccount() }
			);
			return;
		}

		if (this.plugin.connectedAccounts().length === 0) {
			this.reset();
			const first = settings.accounts[0];
			renderMessage(
				this.containerEl,
				"notice",
				"Not signed in on this device",
				"Sign-in is kept in each device's keychain and never synced. Connect to show events here.",
				{ label: "Connect", onClick: () => void this.plugin.connectAccount(first) }
			);
			return;
		}

		this.scheduleRefresh(query.refresh);

		if (this.containerEl.childElementCount === 0) {
			renderMessage(this.containerEl, "notice", "Loading events…");
		}

		try {
			const result = await this.plugin.runQuery(query, maxAgeMs ?? settings.cacheTtl * 1000);
			if (token !== this.renderToken) return;

			this.calendarKeys = result.calendarKeys;
			this.fetchedAt = result.fetchedAt ?? Date.now();
			this.draw({
				events: result.events,
				query,
				warnings: [...warnings, ...result.warnings],
				lastUpdated: result.fetchedAt === null ? null : moment(result.fetchedAt),
			});
		} catch (error) {
			if (token !== this.renderToken) return;
			this.drawn = null;
			if (error instanceof AuthError) {
				renderMessage(this.containerEl, "error", "Google Calendar needs reconnecting", describeError(error), {
					label: "Reconnect",
					onClick: () => void this.plugin.connectAccount(this.plugin.reconnectTarget()),
				});
			} else {
				renderMessage(this.containerEl, "error", "Could not load events", describeError(error), {
					label: "Retry",
					onClick: () => this.refresh(),
				});
			}
		}
	}

	/** Drops this block's calendars from the cache and fetches them again. */
	refresh(): void {
		for (const key of this.calendarKeys) this.plugin.store.invalidateCalendar(key);
		void this.render(0);
	}

	private draw(state: Drawn, now: Moment = moment()): void {
		renderEvents(this.containerEl, state.events, state.query, {
			warnings: state.warnings,
			lastUpdated: state.lastUpdated,
			now,
			actions: this.actions(state.query),
		});
		this.drawn = state;
	}

	private reset(): void {
		this.clearTimer();
		this.drawn = null;
		this.calendarKeys = [];
	}

	// --- Auto-refresh -------------------------------------------------------

	private clearTimer(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.refreshSeconds = 0;
	}

	private scheduleRefresh(seconds: number): void {
		if (seconds === this.refreshSeconds && this.refreshTimer !== null) return;
		this.clearTimer();
		if (seconds <= 0) return;
		this.refreshSeconds = seconds;
		this.refreshTimer = window.setInterval(() => {
			// Hidden pages and detached blocks cost nothing; `catchUp` covers the return.
			if (this.containerEl.doc.hidden || !this.containerEl.isConnected) return;
			void this.render(this.refreshMaxAge(seconds));
		}, seconds * 1000);
		this.registerInterval(this.refreshTimer);
	}

	/**
	 * Data younger than this is reused by an auto-refresh. A second of slack keeps
	 * timer jitter from making the previous tick's response look fresh enough.
	 */
	private refreshMaxAge(seconds: number): number {
		return Math.max(0, Math.min(this.plugin.settings.cacheTtl, seconds) * 1000 - 1000);
	}

	/** On returning to the app, refresh once if the data went stale while hidden. */
	private catchUp(): void {
		if (this.containerEl.doc.hidden || !this.containerEl.isConnected || !this.drawn) return;
		const seconds = this.drawn.query.refresh > 0 ? this.drawn.query.refresh : this.plugin.settings.cacheTtl;
		if (Date.now() - this.fetchedAt > seconds * 1000) void this.render(seconds > 0 ? this.refreshMaxAge(seconds) : 0);
	}

	// --- Actions --------------------------------------------------------------

	private actions(_query: BlockQuery): BlockActions {
		return {
			open: (event) => void openExternal(event.link),
			refresh: () => this.refresh(),
		};
	}
}
