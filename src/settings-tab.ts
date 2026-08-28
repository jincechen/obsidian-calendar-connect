import {
	Notice,
	PluginSettingTab,
	type Setting,
	type SettingDefinition,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	type SettingDefinitionList,
	type SettingDefinitionPage,
} from "obsidian";
import { SCOPE_CALENDAR_LIST, SCOPE_EVENTS_READONLY } from "./auth";
import { describeError } from "./google";
import type CalendarConnectPlugin from "./main";
import { isValidPeriod } from "./query";
import { openExternal } from "./safety";
import {
	ACCOUNT_KEY_PREFIX,
	CALENDAR_KEY_PREFIX,
	DEFAULT_SETTINGS,
	MIN_AUTO_REFRESH,
	type AccountSettings,
} from "./settings";

const CONSOLE_URL = "https://console.cloud.google.com/apis/credentials";

/** Settings that only affect the OAuth client; changing them rebuilds runtimes rather than redrawing blocks. */
const CLIENT_KEYS = new Set(["clientId", "clientSecret", "oauthPort"]);

/**
 * Settings are declared rather than rendered, which is what puts them in
 * Obsidian's settings search. The base class owns the DOM; this class only
 * describes the shape and bridges control keys to `CalendarConnectSettings`.
 *
 * Keys are either a plain field name on the settings object, or a prefixed
 * composite for the repeated rows: `calendar:<calendarKey>` and
 * `account:<accountId>:<field>`.
 */
export class CalendarConnectSettingTab extends PluginSettingTab {
	constructor(private readonly plugin: CalendarConnectPlugin) {
		super(plugin.app, plugin);
	}

	// --- Key routing ------------------------------------------------------

	/** Splits `prefix:<id>:<field>`. Ids may contain colons; field names may not. */
	static split(key: string, prefix: string): { id: string; field: string } | null {
		if (!key.startsWith(prefix)) return null;
		const rest = key.slice(prefix.length);
		const cut = rest.lastIndexOf(":");
		return cut < 0 ? { id: rest, field: "" } : { id: rest.slice(0, cut), field: rest.slice(cut + 1) };
	}

	getControlValue(key: string): unknown {
		const settings = this.plugin.settings;

		if (key === "hiddenTitles") return settings.hiddenTitles.join("\n");

		if (key.startsWith(CALENDAR_KEY_PREFIX)) {
			return settings.defaultCalendars.includes(key.slice(CALENDAR_KEY_PREFIX.length));
		}

		const account = CalendarConnectSettingTab.split(key, ACCOUNT_KEY_PREFIX);
		if (account) {
			const entry = this.plugin.account(account.id);
			if (!entry) return "";
			if (account.field === "label") return entry.label;
			if (account.field === "clientId") return entry.clientId ?? "";
			return "";
		}

		return (settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;

		if (key === "hiddenTitles") {
			settings.hiddenTitles = String(value ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
		} else if (key.startsWith(CALENDAR_KEY_PREFIX)) {
			const calendarKey = key.slice(CALENDAR_KEY_PREFIX.length);
			const selected = new Set(settings.defaultCalendars);
			if (value) selected.add(calendarKey);
			else selected.delete(calendarKey);
			settings.defaultCalendars = [...selected];
		} else {
			const account = CalendarConnectSettingTab.split(key, ACCOUNT_KEY_PREFIX);
			if (account) {
				await this.setAccountField(account.id, account.field, String(value ?? "").trim());
				return;
			}
			(settings as unknown as Record<string, unknown>)[key] = value;
		}

		// Every write goes back through the sanitiser, so a control can never store a
		// value (NaN, an unknown enum, a 5-second refresh) the plugin would not load.
		this.plugin.sanitiseInPlace();
		await this.plugin.saveSettings();

		if (CLIENT_KEYS.has(key)) this.plugin.syncRuntimes();
		else this.plugin.refreshAllBlocks();
	}

	private async setAccountField(id: string, field: string, text: string): Promise<void> {
		const entry = this.plugin.account(id);
		if (!entry) return;
		if (field === "label") {
			// No update() here: it would redraw the field being typed in.
			await this.plugin.renameAccount(entry.id, text || entry.id);
			return;
		}
		if (field === "clientId") entry.clientId = text || undefined;
		else if (field === "clientSecret") entry.clientSecret = text || undefined;
		else return;
		await this.plugin.saveSettings();
		this.plugin.syncRuntimes();
	}

	// --- Definitions ------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.clientGroup(),
			this.accountsList(),
			this.calendarsGroup(),
			this.displayGroup(),
			this.syncGroup(),
		];
	}

	/** A masked text row; there is no password control type. */
	private secretRow(name: string, desc: string, read: () => string, write: (value: string) => Promise<void>): SettingDefinition {
		return {
			name,
			desc,
			render: (setting: Setting) => {
				setting.addText((text) => {
					text.inputEl.type = "password";
					text.inputEl.autocomplete = "off";
					text.setPlaceholder("GOCSPX-…").setValue(read());
					text.onChange((value) => {
						void write(value.trim());
					});
				});
			},
		};
	}

	private clientGroup(): SettingDefinitionGroup {
		const steps = createFragment((frag) => {
			frag.appendText("The plugin signs in with your own Google Cloud client, so no third-party server is involved. ");
			const link = frag.createEl("a", { text: "Open the Google Cloud console", href: CONSOLE_URL });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				openExternal(CONSOLE_URL);
			});
			const list = frag.createEl("ol");
			list.createEl("li", { text: "Create a project and enable the Google Calendar API." });
			list.createEl("li", { text: "Configure the OAuth consent screen with user type External." });
			const scopes = list.createEl("li", { text: "Add the scopes " });
			scopes.createEl("code", { text: SCOPE_CALENDAR_LIST.replace("https://www.googleapis.com", "…") });
			scopes.appendText(" and ");
			scopes.createEl("code", { text: SCOPE_EVENTS_READONLY.replace("https://www.googleapis.com", "…") });
			scopes.appendText(".");
			list.createEl("li", {
				text:
					"Set Publishing status to In production (Testing makes sign-ins expire after 7 days). " +
					"Expect an 'unverified app' screen when signing in: choose Advanced → Continue.",
			});
			list.createEl("li", { text: "Create an OAuth client of type Desktop app and paste its ID and secret below." });
			list.createEl("li", { text: "Add an account in the Accounts section." });
		});

		return {
			type: "group",
			heading: "Google Cloud client",
			items: [
				{ name: "Setup", desc: steps, aliases: ["google", "cloud", "credentials", "oauth", "production"] },
				{
					name: "Client ID",
					desc: "Shared by every account unless one overrides it.",
					control: { type: "text", key: "clientId", placeholder: "xxxxx.apps.googleusercontent.com" },
				},
				this.secretRow(
					"Client secret",
					"Synced with your vault settings, like all plugin settings. Sign-ins themselves stay in each device's keychain.",
					() => this.plugin.settings.clientSecret,
					async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
						this.plugin.syncRuntimes();
					}
				),
				{
					type: "page",
					name: "Advanced",
					desc: "Callback port",
					items: [
						{
							name: "Callback port",
							desc: "0 picks a free port each time, which suits a Desktop app client. Set a fixed port only for a Web application client with http://127.0.0.1:PORT registered.",
							control: { type: "number", key: "oauthPort", min: 0, max: 65535, step: 1, defaultValue: 0 },
						},
					],
				},
			],
		};
	}

	/** One status line per account, worked out from this device's keychain. */
	private accountStatus(account: AccountSettings): { desc: string; warning: boolean; action: string } {
		const calendars = this.plugin.settings.knownCalendars.filter((c) => c.accountId === account.id).length;
		const count = `${calendars} calendar${calendars === 1 ? "" : "s"}`;
		if (!this.plugin.isSignedIn(account.id)) {
			return { desc: `${account.id} · Not signed in on this device`, warning: true, action: "Connect" };
		}
		if (this.plugin.needsReconnecting(account.id)) {
			return { desc: `${account.id} · Needs reconnecting`, warning: true, action: "Reconnect" };
		}
		return { desc: `${account.id} · ${count}`, warning: false, action: "Reconnect" };
	}

	private accountsList(): SettingDefinitionList {
		const accounts = this.plugin.settings.accounts;
		const connect = (account?: AccountSettings) => {
			void this.plugin.connectAccount(account).then(() => this.update());
		};

		return {
			type: "list",
			heading: "Accounts",
			emptyState: "No accounts yet. Fill in the Google Cloud client above, then add one.",
			addItem: { name: "Add account", action: () => connect() },
			onDelete: (index: number) => {
				const account = accounts[index];
				if (!account) return;
				void this.plugin.removeAccount(account.id).then(() => {
					new Notice(`Removed ${account.label}`);
					this.update();
				});
			},
			items: accounts.map((account): SettingDefinitionPage => {
				const id = account.id;
				const status = this.accountStatus(account);
				return {
					type: "page",
					name: account.label,
					desc: status.desc,
					status: status.warning ? "warning" : null,
					items: [
						{
							name: "Label",
							desc: "What `accounts:` and `account/calendar` match against in a block.",
							control: { type: "text", key: `${ACCOUNT_KEY_PREFIX}${id}:label` },
						},
						{
							name: status.action,
							desc: "Opens Google's consent screen for this account. The sign-in is stored in this device's keychain only.",
							action: () => connect(this.plugin.account(id)),
						},
						{
							name: "Separate OAuth client",
							desc: "Only needed if a Workspace admin blocks outside apps. Leave empty to use the shared client.",
						},
						{
							name: "Client ID",
							control: {
								type: "text",
								key: `${ACCOUNT_KEY_PREFIX}${id}:clientId`,
								placeholder: "Falls back to the shared client",
							},
						},
						this.secretRow(
							"Client secret",
							"",
							() => this.plugin.account(id)?.clientSecret ?? "",
							(value) => this.setAccountField(id, "clientSecret", value)
						),
					],
				};
			}),
		};
	}

	private calendarsGroup(): SettingDefinitionGroup {
		const calendars = this.plugin.settings.knownCalendars;
		const hasAccounts = this.plugin.connectedAccounts().length > 0;

		const toggles: SettingDefinition[] = calendars.length
			? calendars.map((calendar) => ({
					name: calendar.name,
					desc: `${calendar.accountLabel} · ${calendar.id}`,
					aliases: [calendar.accountLabel, calendar.id],
					control: { type: "toggle" as const, key: `${CALENDAR_KEY_PREFIX}${calendar.key}` },
				}))
			: [
					{
						name: "No calendars loaded",
						desc: hasAccounts ? "Use the reload button on this section." : "Add an account first.",
						searchable: false,
					},
				];

		return {
			type: "group",
			heading: "Calendars",
			search:
				calendars.length > 8
					? {
							placeholder: "Filter calendars",
							match: (def, query) =>
								`${def.name} ${typeof def.desc === "string" ? def.desc : ""}`
									.toLowerCase()
									.includes(query.toLowerCase()),
						}
					: undefined,
			extraButtons: [
				(button) =>
					button
						.setIcon("refresh-cw")
						.setTooltip("Reload the calendar list from Google")
						.setDisabled(!hasAccounts)
						.onClick(() => {
							void this.plugin.reloadCalendars().then(
								({ errors }) => {
									new Notice(errors.length ? `Updated with errors: ${errors.join("; ")}` : "Calendar list updated");
									this.update();
								},
								(error: unknown) => new Notice(`Google Calendar: ${describeError(error)}`, 10000)
							);
						}),
			],
			items: [
				{
					name: "Default calendars",
					desc: "Calendars a block shows when it names none. Leave all off to show every calendar.",
					searchable: false,
				},
				...toggles,
			],
		};
	}

	private displayGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "Display",
			items: [
				{
					name: "View",
					desc: "Used when a block omits `view`.",
					control: {
						type: "dropdown",
						key: "defaultView",
						options: { agenda: "Agenda", table: "Table" },
					},
				},
				{
					name: "Period",
					desc: "How far ahead a block looks when it sets neither `to` nor `period`. For example 1d, 7d, 2w, 1m or eom.",
					control: {
						type: "text",
						key: "defaultPeriod",
						placeholder: DEFAULT_SETTINGS.defaultPeriod,
						// A typo here would break every block relying on the default, with
						// an error naming an option the user never wrote.
						validate: (value: string) =>
							isValidPeriod(value) ? undefined : `"${value}" is not a period. Try 1d, 7d, 2w, 1m or eom.`,
					},
				},
				{ name: "24-hour time", control: { type: "toggle", key: "use24HourTime" } },
				{
					name: "Date heading format",
					desc: "Moment format for day headings. Today, Tomorrow and Yesterday are always named.",
					control: { type: "text", key: "dateHeadingFormat", placeholder: DEFAULT_SETTINGS.dateHeadingFormat },
				},
				{
					name: "Table date format",
					desc: "Moment format for the `date` field.",
					control: { type: "text", key: "tableDateFormat", placeholder: DEFAULT_SETTINGS.tableDateFormat },
				},
				{ name: "Hide declined events", control: { type: "toggle", key: "hideDeclined" } },
				{
					name: "Hidden events",
					desc: "One title pattern per line, hidden in every block. `EOD` matches that title exactly, `Start of *` a prefix, `*EOD*` anywhere, and `/regex/` is a regular expression. Blocks add more with `hide-titles`.",
					aliases: ["filter", "exclude", "ignore", "mute"],
					control: { type: "textarea", key: "hiddenTitles", placeholder: "EOD\nStart of *\n*lunch*" },
				},
				{
					name: "Description length",
					desc: "Characters of a description shown before it is cut off. 0 hides descriptions.",
					control: { type: "number", key: "descriptionLength", min: 0, step: 10 },
				},
			],
		};
	}

	private syncGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "Sync",
			items: [
				{
					name: "Cache lifetime",
					desc: "Seconds a response from Google is reused before asking again. 0 asks on every render.",
					control: { type: "number", key: "cacheTtl", min: 0, step: 30 },
				},
				{
					name: "Auto-refresh",
					desc: "Seconds between automatic refreshes of open blocks. 0 disables it. Blocks override it with `refresh`. Refreshes pause while Obsidian is in the background.",
					control: {
						type: "number",
						key: "autoRefresh",
						min: 0,
						step: 60,
						// Mirrors the clamp in sanitiseSettings and parseQuery.
						validate: (value: number) =>
							value === 0 || value >= MIN_AUTO_REFRESH
								? undefined
								: `Use 0 to disable, or at least ${MIN_AUTO_REFRESH} seconds.`,
					},
				},
			],
		};
	}
}
