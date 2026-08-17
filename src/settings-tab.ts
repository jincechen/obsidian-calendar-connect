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
import type CalendarConnectPlugin from "./main";
import { openExternal } from "./safety";
import { ACCOUNT_KEY_PREFIX, type AccountSettings } from "./settings";

const CONSOLE_URL = "https://console.cloud.google.com/apis/credentials";

/**
 * Settings are declared rather than rendered, which is what puts them in
 * Obsidian's settings search. The base class owns the DOM; this class only
 * describes the shape and bridges control keys to `CalendarConnectSettings`.
 *
 * Keys are either a plain field name on the settings object, or a prefixed
 * composite for the account rows: `account:<accountId>:<field>`.
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
		const account = CalendarConnectSettingTab.split(key, ACCOUNT_KEY_PREFIX);
		if (account) {
			const entry = this.plugin.account(account.id);
			if (!entry) return "";
			if (account.field === "label") return entry.label;
			if (account.field === "clientId") return entry.clientId ?? "";
			return "";
		}

		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const account = CalendarConnectSettingTab.split(key, ACCOUNT_KEY_PREFIX);
		if (account) {
			await this.setAccountField(account.id, account.field, String(value ?? "").trim());
			return;
		}
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;

		// Every write goes back through the sanitiser, so a control can never store a
		// value (NaN, an out-of-range port) the plugin would not load.
		this.plugin.sanitiseInPlace();
		await this.plugin.saveSettings();
		this.plugin.syncRuntimes();
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
		return [this.clientGroup(), this.accountsList()];
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
							desc: "Shown in place of the address.",
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
}
