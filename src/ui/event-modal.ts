/**
 * The event editor: one modal with three modes.
 *  - view:   everything disabled, with a banner saying why (plus RSVP when allowed)
 *  - edit:   an existing event the account may change
 *  - create: a new event
 * Writes are never optimistic and never retried automatically: on success the
 * affected calendars are invalidated and every block re-renders from Google.
 */
import { App, ButtonComponent, DropdownComponent, Modal, Notice, Setting, TextComponent, setIcon } from "obsidian";
import type { Moment } from "../moment-shim";
import type { CalendarConnectSettings } from "../settings";
import type { CalEvent, CalendarInfo, Editability, RawEvent } from "../types";
import { CalendarApiError, describeError, normaliseEvent, type GoogleCalendarClient, type SendUpdates } from "../google";
import { HttpError } from "../http";
import { isValidEmail, openExternal, safeExternalUrl } from "../safety";
import {
	buildEventPatch,
	buildInsertBody,
	buildMasterPatch,
	buildRsvpPatch,
	diffDraft,
	draftFromEvent,
	editabilityOf,
	hasOtherGuests,
	newDraft,
	newEventId,
	normaliseEmail,
	pickTimeZone,
	scopeOptions,
	validateDraft,
	withStart,
	type ChangeSet,
	type DraftErrors,
	type EventDraft,
	type RsvpResponse,
} from "../editing";
import { askNotifyGuests, askRecurringScope, confirmDelete, type RecurringScope } from "./prompts";

export interface EditContext {
	app: App;
	settings(): CalendarConnectSettings;
	/** Known calendars (all accounts). */
	calendars(): CalendarInfo[];
	clientFor(accountId: string): GoogleCalendarClient | null;
	canWrite(accountId: string): boolean;
	/** Invalidate these calendar keys and re-render every block. */
	afterChange(calendarKeys: string[]): void;
}

type Mode = "view" | "edit" | "create";

const WRITE_ROLES = ["writer", "owner"];
const NOT_SIGNED_IN = "This account isn't signed in on this device.";

const RSVP_OPTIONS: Array<{ label: string; value: RsvpResponse }> = [
	{ label: "Yes", value: "accepted" },
	{ label: "Maybe", value: "tentative" },
	{ label: "No", value: "declined" },
];

function responseIcon(response: string | undefined): string {
	if (response === "accepted") return "check";
	if (response === "tentative") return "help-circle";
	if (response === "declined") return "x";
	return "circle";
}

function responseLabel(response: string | undefined): string {
	if (response === "accepted") return "Going";
	if (response === "tentative") return "Maybe";
	if (response === "declined") return "Not going";
	return "Awaiting reply";
}

function isWritableCalendar(ctx: EditContext, calendar: CalendarInfo): boolean {
	return WRITE_ROLES.includes(calendar.accessRole) && ctx.canWrite(calendar.accountId);
}

/** The event's calendar, or a stand-in built from the event when the list does not know it. */
function calendarOf(ctx: EditContext, event: CalEvent): CalendarInfo {
	return (
		ctx.calendars().find((c) => c.key === event.calendarKey) ?? {
			key: event.calendarKey,
			id: event.calendarId,
			name: event.calendarName,
			color: event.calendarColor,
			primary: false,
			accessRole: "reader",
			accountId: event.accountId,
			accountLabel: event.accountLabel,
		}
	);
}

/** Network failures and timeouts: the write may or may not have reached Google. */
function isUncertain(error: unknown): boolean {
	return (error instanceof CalendarApiError && error.kind === "network") || error instanceof HttpError;
}

function isKind(error: unknown, kind: CalendarApiError["kind"]): boolean {
	return error instanceof CalendarApiError && error.kind === kind;
}

/** Thrown after a calendar move succeeded but a later step failed. */
class PartialSaveError extends Error {
	constructor(readonly original: unknown) {
		super(describeError(original));
	}
}

class EventModal extends Modal {
	private mode: Mode;
	private event: CalEvent | null;
	private editability: Editability;
	private original: EventDraft;
	private draft: EventDraft;
	private errors: DraftErrors = {};
	private busy = false;
	/** Set when something went wrong and the user should see it above the form. */
	private errorText: string | null = null;
	/** Overrides the editability reason after a 403. */
	private viewReason: string | null = null;
	/** The block is `editable: false`: no writes at all, not even RSVP. */
	private readonly readOnly: boolean;

	// Elements refreshed without a full re-render.
	private titleRow: Setting | null = null;
	private startRow: Setting | null = null;
	private endRow: Setting | null = null;
	private guestsRow: Setting | null = null;
	private descriptionRow: Setting | null = null;
	private timeInputs: HTMLInputElement[] = [];
	private startDateEl: HTMLInputElement | null = null;
	private startTimeEl: HTMLInputElement | null = null;
	private endDateEl: HTMLInputElement | null = null;
	private endTimeEl: HTMLInputElement | null = null;
	private guestInput: TextComponent | null = null;
	private chipsEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;
	private saveButton: ButtonComponent | null = null;
	private deleteButton: ButtonComponent | null = null;

	constructor(
		private readonly ctx: EditContext,
		init: { event: CalEvent; readOnly?: boolean } | { draft: EventDraft }
	) {
		super(ctx.app);
		this.readOnly = "event" in init && init.readOnly === true;
		if ("event" in init) {
			this.event = init.event;
			this.editability = this.computeEditability(init.event);
			this.mode = !init.readOnly && this.editability.canEdit ? "edit" : "view";
			if (init.readOnly && !this.editability.reason) this.viewReason = "This block is read-only";
			this.original = draftFromEvent(init.event);
		} else {
			this.event = null;
			this.editability = { canEdit: true, canDelete: false, canMove: true, canRsvp: false };
			this.mode = "create";
			this.original = init.draft;
		}
		this.draft = { ...this.original, guests: [...this.original.guests] };
		this.scope.register(["Mod"], "Enter", (evt) => {
			evt.preventDefault();
			void this.save();
			return false;
		});
	}

	onOpen(): void {
		this.modalEl.addClass("cc-editor");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private computeEditability(event: CalEvent): Editability {
		return editabilityOf(event, calendarOf(this.ctx, event), this.ctx.canWrite(event.accountId));
	}

	private get editable(): boolean {
		return this.mode !== "view";
	}

	// --- Rendering ---------------------------------------------------------

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.timeInputs = [];
		this.setTitle(this.mode === "create" ? "New event" : this.mode === "edit" ? "Edit event" : "Event");
		this.modalEl.toggleClass("is-read-only", !this.editable);

		if (this.mode === "view") this.renderBanner(contentEl);
		this.errorEl = contentEl.createDiv({ cls: "cc-editor-error", attr: { role: "alert" } });

		const form = contentEl.createDiv({ cls: "cc-editor-form" });
		this.renderTitle(form);
		this.renderCalendar(form);
		this.renderTimes(form);
		this.renderLocation(form);
		this.renderGuests(form);
		this.renderDescription(form);
		if (this.event && this.editability.canRsvp && !this.readOnly) this.renderRsvp(form, this.event);
		this.renderFooter(contentEl);
		this.refresh();
	}

	private renderBanner(parent: HTMLElement): void {
		const reason = this.viewReason ?? this.editability.reason ?? "You can't change this event";
		const banner = parent.createDiv({ cls: "cc-editor-banner" });
		const icon = banner.createSpan({ cls: "cc-editor-banner-icon" });
		setIcon(icon, "lock");
		banner.createSpan({ cls: "cc-editor-banner-text", text: reason });
	}

	private renderTitle(parent: HTMLElement): void {
		this.titleRow = new Setting(parent).setName("Title").addText((text) => {
			text.setPlaceholder("(No title)").setValue(this.draft.title).setDisabled(!this.editable);
			text.inputEl.addClass("cc-editor-title");
			text.onChange((value) => {
				this.draft.title = value;
				this.refresh();
			});
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter" && !evt.isComposing && !evt.shiftKey) {
					evt.preventDefault();
					void this.save();
				}
			});
			if (this.editable) window.setTimeout(() => text.inputEl.focus(), 0);
		});
	}

	/** Calendars this modal may offer, as `key → label`. */
	private calendarChoices(): Array<{ key: string; label: string }> {
		const all = this.ctx.calendars();
		if (this.mode === "create") {
			return all
				.filter((c) => isWritableCalendar(this.ctx, c))
				.map((c) => ({ key: c.key, label: `${c.accountLabel} · ${c.name}` }));
		}
		const event = this.event as CalEvent;
		const choices = all
			.filter((c) => c.accountId === event.accountId && (c.key === event.calendarKey || isWritableCalendar(this.ctx, c)))
			.map((c) => ({ key: c.key, label: c.name }));
		if (!choices.some((c) => c.key === event.calendarKey)) choices.unshift({ key: event.calendarKey, label: event.calendarName });
		return choices;
	}

	private renderCalendar(parent: HTMLElement): void {
		const choices = this.calendarChoices();
		const canChange = this.mode === "create" || (this.mode === "edit" && this.editability.canMove);
		const row = new Setting(parent).setName("Calendar").addDropdown((dropdown: DropdownComponent) => {
			for (const choice of choices) dropdown.addOption(choice.key, choice.label);
			dropdown.setValue(this.draft.calendarKey);
			dropdown.setDisabled(!canChange || choices.length < 2);
			dropdown.onChange((value) => {
				this.draft.calendarKey = value;
				this.refresh();
			});
		});
		if (this.mode === "edit" && !this.editability.canMove) row.setDesc("Only the organizer can move this event");
		else if (this.mode === "edit" && this.event?.recurringEventId) row.setDesc("Moving applies to the whole series");
	}

	private renderTimes(parent: HTMLElement): void {
		new Setting(parent).setName("All day").addToggle((toggle) => {
			toggle.setValue(this.draft.allDay).setDisabled(!this.editable);
			toggle.onChange((value) => {
				this.draft.allDay = value;
				this.refresh();
			});
		});

		this.startRow = new Setting(parent).setName("Starts");
		this.startDateEl = this.dateInput(this.startRow, this.draft.startDate, "Start date");
		this.startTimeEl = this.timeInput(this.startRow, this.draft.startTime, "Start time");
		const onStart = () => {
			this.draft = withStart(this.draft, this.startDateEl?.value ?? "", this.startTimeEl?.value ?? "");
			if (this.endDateEl) this.endDateEl.value = this.draft.endDate;
			if (this.endTimeEl) this.endTimeEl.value = this.draft.endTime;
			this.refresh();
		};
		this.startDateEl.addEventListener("change", onStart);
		this.startTimeEl.addEventListener("change", onStart);

		this.endRow = new Setting(parent).setName("Ends");
		this.endDateEl = this.dateInput(this.endRow, this.draft.endDate, "End date");
		this.endTimeEl = this.timeInput(this.endRow, this.draft.endTime, "End time");
		const onEnd = () => {
			this.draft.endDate = this.endDateEl?.value ?? "";
			this.draft.endTime = this.endTimeEl?.value ?? "";
			this.refresh();
		};
		this.endDateEl.addEventListener("change", onEnd);
		this.endTimeEl.addEventListener("change", onEnd);
	}

	private dateInput(row: Setting, value: string, label: string): HTMLInputElement {
		const input = row.controlEl.createEl("input", { type: "date", cls: "cc-editor-date", value, attr: { "aria-label": label } });
		input.disabled = !this.editable;
		return input;
	}

	private timeInput(row: Setting, value: string, label: string): HTMLInputElement {
		const input = row.controlEl.createEl("input", { type: "time", cls: "cc-editor-time", value, attr: { "aria-label": label } });
		input.disabled = !this.editable;
		this.timeInputs.push(input);
		return input;
	}

	private renderLocation(parent: HTMLElement): void {
		new Setting(parent).setName("Location").addText((text) => {
			text.setPlaceholder("Add location").setValue(this.draft.location).setDisabled(!this.editable);
			text.onChange((value) => {
				this.draft.location = value;
				this.refresh();
			});
		});
	}

	private renderGuests(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: "cc-editor-guests" });
		this.guestsRow = new Setting(section).setName("Guests");
		if (this.editable) {
			this.guestsRow.addText((text) => {
				this.guestInput = text;
				text.setPlaceholder("Add guest email");
				text.inputEl.type = "email";
				text.inputEl.addEventListener("keydown", (evt) => {
					if ((evt.key === "Enter" || evt.key === ",") && !evt.isComposing) {
						evt.preventDefault();
						evt.stopPropagation();
						this.commitGuestInput();
					}
				});
				text.inputEl.addEventListener("blur", () => {
					if (text.getValue().trim()) this.commitGuestInput();
				});
			});
		} else {
			this.guestInput = null;
			if (!this.draft.guests.length) this.guestsRow.setDesc("No guests");
		}
		this.chipsEl = section.createDiv({ cls: "cc-editor-chips" });
		this.renderChips();
	}

	private renderChips(): void {
		const el = this.chipsEl;
		if (!el) return;
		el.empty();
		const known = new Map<string, { name?: string; response?: string; self: boolean; organizer: boolean }>();
		for (const a of this.event?.rawAttendees ?? []) {
			if (!a.email) continue;
			known.set(normaliseEmail(a.email), {
				name: a.displayName,
				response: a.responseStatus,
				self: a.self === true,
				organizer: a.organizer === true,
			});
		}
		el.toggle(this.draft.guests.length > 0);
		for (const email of this.draft.guests) {
			const info = known.get(email);
			const chip = el.createDiv({ cls: "cc-editor-chip" });
			if (info?.organizer) chip.addClass("is-organizer");
			if (info?.self) chip.addClass("is-self");
			const icon = chip.createSpan({ cls: "cc-editor-chip-icon" });
			setIcon(icon, info ? responseIcon(info.response) : "circle");
			const status = info ? responseLabel(info.response) : "Not invited yet";
			chip.setAttr("aria-label", `${email} — ${status}${info?.organizer ? ", organizer" : ""}`);
			chip.setAttr("title", `${email} — ${status}`);
			chip.createSpan({ cls: "cc-editor-chip-name", text: info?.name || email });
			if (info?.organizer) chip.createSpan({ cls: "cc-editor-chip-meta", text: "organizer" });
			if (this.editable && !info?.self) {
				const remove = chip.createEl("button", {
					cls: ["cc-editor-chip-remove", "clickable-icon"],
					attr: { "aria-label": `Remove ${email}`, type: "button" },
				});
				setIcon(remove, "x");
				remove.addEventListener("click", () => {
					this.draft.guests = this.draft.guests.filter((g) => g !== email);
					this.renderChips();
					this.refresh();
				});
			}
		}
	}

	/** Adds whatever is typed in the guest box. Returns false when something in it is invalid. */
	private commitGuestInput(): boolean {
		const input = this.guestInput;
		if (!input) return true;
		const parts = input
			.getValue()
			.split(/[,;\s]+/)
			.map(normaliseEmail)
			.filter(Boolean);
		const invalid = parts.filter((p) => !isValidEmail(p));
		for (const email of parts) {
			if (isValidEmail(email) && !this.draft.guests.includes(email)) this.draft.guests.push(email);
		}
		input.setValue(invalid.join(", "));
		this.guestsRow?.setErrorMessage(invalid.length ? `Not a valid email: ${invalid.join(", ")}` : null);
		this.renderChips();
		this.refresh();
		return invalid.length === 0;
	}

	private renderDescription(parent: HTMLElement): void {
		this.descriptionRow = new Setting(parent).setName("Description").setClass("cc-editor-description");
		this.descriptionRow.addTextArea((area) => {
			area.setPlaceholder("Add description").setValue(this.draft.description).setDisabled(!this.editable);
			area.inputEl.rows = 4;
			area.onChange((value) => {
				this.draft.description = value;
				this.refresh();
			});
		});
	}

	private renderRsvp(parent: HTMLElement, event: CalEvent): void {
		const row = new Setting(parent).setName("Going?");
		const group = row.controlEl.createDiv({ cls: "cc-editor-rsvp", attr: { role: "group", "aria-label": "Your response" } });
		for (const option of RSVP_OPTIONS) {
			const active = event.selfResponse === option.value;
			const button = group.createEl("button", {
				text: option.label,
				cls: active ? ["cc-editor-rsvp-option", "is-active"] : "cc-editor-rsvp-option",
				attr: { type: "button", "aria-pressed": String(active) },
			});
			button.addEventListener("click", () => void this.rsvp(option.value));
		}
	}

	private renderFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: ["modal-button-container", "cc-editor-footer"] });
		this.deleteButton = null;
		this.saveButton = null;
		if (this.mode === "edit" && this.editability.canDelete) {
			this.deleteButton = new ButtonComponent(footer)
				.setButtonText("Delete")
				.setDestructive()
				.setClass("cc-editor-delete")
				.onClick(() => void this.remove());
		}
		const link = safeExternalUrl(this.event?.link);
		if (link) {
			new ButtonComponent(footer).setButtonText("Open in Google Calendar").onClick(() => openExternal(link));
		}
		new ButtonComponent(footer).setButtonText(this.editable ? "Cancel" : "Close").onClick(() => this.close());
		if (this.editable) {
			this.saveButton = new ButtonComponent(footer)
				.setButtonText(this.mode === "create" ? "Create" : "Save")
				.setCta()
				.onClick(() => void this.save());
		}
	}

	/** Syncs validation, visibility and button states with the draft. */
	private refresh(): void {
		for (const input of this.timeInputs) input.toggle(!this.draft.allDay);
		this.errorEl?.setText(this.errorText ?? "");
		this.errorEl?.toggle(!!this.errorText);
		if (!this.editable) return;
		this.errors = validateDraft(this.draft);
		const e = this.errors;
		this.titleRow?.setErrorMessage(e.title ?? null);
		this.startRow?.setErrorMessage(e.startDate ?? e.startTime ?? null);
		this.endRow?.setErrorMessage(e.endDate ?? e.endTime ?? null);
		if (e.guests) this.guestsRow?.setErrorMessage(e.guests);
		const flattened = !!this.event?.descriptionIsHtml && this.draft.description !== this.original.description;
		this.descriptionRow?.setDesc(flattened ? "Saving replaces rich formatting with plain text" : "");
		const invalid = Object.keys(e).length > 0;
		this.saveButton?.setDisabled(invalid || this.busy);
		this.saveButton?.setButtonText(this.busy ? "Saving…" : this.mode === "create" ? "Create" : "Save");
		this.deleteButton?.setDisabled(this.busy);
		this.modalEl.toggleClass("is-busy", this.busy);
	}

	private showError(text: string | null): void {
		this.errorText = text;
		if (this.errorEl) {
			this.errorEl.setText(text ?? "");
			this.errorEl.toggle(!!text);
		}
	}

	/**
	 * Esc, clicking outside and Cancel wait while a request is in flight: closing
	 * then would drop its outcome (an error, or a conflict prompt) on the floor.
	 */
	close(): void {
		if (this.busy) return;
		super.close();
	}

	/** Closes once an operation has settled, even while still marked busy. */
	private finish(): void {
		this.busy = false;
		super.close();
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.refresh();
	}

	// --- Saving --------------------------------------------------------------

	private async save(): Promise<void> {
		if (!this.editable || this.busy) return;
		if (!this.commitGuestInput()) return;
		this.refresh();
		if (Object.keys(this.errors).length) return;
		this.showError(null);
		if (this.mode === "create") return this.create();

		const event = this.event as CalEvent;
		const changes = diffDraft(this.original, this.draft);
		if (!changes.any) {
			this.finish();
			return;
		}

		let scope: RecurringScope | null = null;
		if (event.recurringEventId) {
			const options = scopeOptions(changes);
			if (options.error) {
				this.showError(options.error);
				return;
			}
			scope = await askRecurringScope(this.app, {
				verb: "Save",
				thisEvent: options.thisEvent,
				allEvents: options.allEvents,
				hint: changes.dateChanged
					? "A date change can only apply to this event."
					: changes.calendar
						? "Moving to another calendar always moves the whole series."
						: undefined,
			});
			if (!scope) return;
		}

		let sendUpdates: SendUpdates = "none";
		if (hasOtherGuests(event.rawAttendees, this.draft.guests, event.accountId)) {
			const choice = await askNotifyGuests(this.app, this.ctx.settings(), "update");
			if (!choice) return;
			sendUpdates = choice;
		}

		const client = this.ctx.clientFor(event.accountId);
		if (!client) {
			this.showError(NOT_SIGNED_IN);
			return;
		}

		this.setBusy(true);
		try {
			const keys = await this.write(client, event, this.draft, changes, scope, sendUpdates);
			this.succeed(keys);
		} catch (error) {
			this.handleSaveError(error);
		} finally {
			this.setBusy(false);
		}
	}

	/** Executes one save. Returns the calendar keys that changed. */
	private async write(
		client: GoogleCalendarClient,
		event: CalEvent,
		draft: EventDraft,
		changes: ChangeSet,
		scope: RecurringScope | null,
		sendUpdates: SendUpdates
	): Promise<string[]> {
		const keys = [event.calendarKey];
		let calendarId = event.calendarId;
		let eventId = event.id;
		let etag = event.etag;
		let master: RawEvent | null = null;
		if (scope === "allEvents" && event.recurringEventId) {
			eventId = event.recurringEventId;
			master = await client.getEvent(calendarId, eventId);
			etag = master.etag;
		}

		let moved = false;
		if (changes.calendar) {
			const target = this.ctx.calendars().find((c) => c.key === draft.calendarKey);
			if (!target) throw new Error("That calendar is no longer available.");
			const result = await client.moveEvent(calendarId, eventId, target.id, { sendUpdates });
			moved = true;
			calendarId = target.id;
			etag = result.etag;
			if (master) master = result;
			keys.push(target.key);
		}

		const rest: ChangeSet = { ...changes, calendar: false };
		rest.any = rest.title || rest.time || rest.location || rest.description || rest.guests;
		if (!rest.any) return keys;
		try {
			const timeZone = pickTimeZone(event, calendarOf(this.ctx, event));
			const patch = master
				? buildMasterPatch(master, event, draft, rest, timeZone)
				: buildEventPatch(event, draft, rest, timeZone);
			if (Object.keys(patch).length) await client.patchEvent(calendarId, eventId, patch, { etag, sendUpdates });
		} catch (error) {
			if (moved) throw new PartialSaveError(error);
			throw error;
		}
		return keys;
	}

	private succeed(keys: string[], message = "Event saved"): void {
		this.ctx.afterChange([...new Set(keys)]);
		new Notice(message);
		this.finish();
	}

	private handleSaveError(error: unknown): void {
		const event = this.event as CalEvent;
		const keys = [event.calendarKey, this.draft.calendarKey];
		if (error instanceof PartialSaveError) {
			new Notice(`Moved the event, but couldn't save the other changes: ${error.message}`);
			this.ctx.afterChange([...new Set(keys)]);
			this.finish();
			return;
		}
		if (isUncertain(error)) {
			this.uncertain(keys);
			return;
		}
		if (isKind(error, "forbidden")) {
			this.toViewMode(describeError(error));
			return;
		}
		this.showError(describeError(error));
	}

	private toViewMode(reason: string): void {
		this.mode = "view";
		this.viewReason = reason;
		this.errorText = null;
		this.render();
	}

	private uncertain(keys: string[]): void {
		new Notice("Couldn't confirm the save — refreshing to check");
		this.ctx.afterChange([...new Set(keys)]);
		this.finish();
	}

	private async create(): Promise<void> {
		const calendar = this.ctx.calendars().find((c) => c.key === this.draft.calendarKey);
		if (!calendar) {
			this.showError("Choose a calendar for the event.");
			return;
		}
		const client = this.ctx.clientFor(calendar.accountId);
		if (!client) {
			this.showError(NOT_SIGNED_IN);
			return;
		}
		let sendUpdates: SendUpdates = "none";
		if (hasOtherGuests([], this.draft.guests, calendar.accountId)) {
			const choice = await askNotifyGuests(this.app, this.ctx.settings(), "invitation");
			if (!choice) return;
			sendUpdates = choice;
		}
		this.setBusy(true);
		try {
			const body = buildInsertBody(this.draft, pickTimeZone(undefined, calendar), newEventId());
			await client.insertEvent(calendar.id, body, { sendUpdates });
			this.succeed([calendar.key], "Event created");
		} catch (error) {
			if (isUncertain(error)) this.uncertain([calendar.key]);
			else this.showError(describeError(error));
		} finally {
			this.setBusy(false);
		}
	}

	// --- RSVP and delete ---------------------------------------------------------

	private async rsvp(response: RsvpResponse): Promise<void> {
		const event = this.event;
		if (!event || this.busy) return;
		const client = this.ctx.clientFor(event.accountId);
		if (!client) {
			this.showError(NOT_SIGNED_IN);
			return;
		}
		this.setBusy(true);
		try {
			const raw = await client.patchEvent(event.calendarId, event.id, buildRsvpPatch(event, response), {
				etag: event.etag,
				sendUpdates: "none",
			});
			this.ctx.afterChange([event.calendarKey]);
			const fresh = normaliseEvent(raw, calendarOf(this.ctx, event));
			if (!fresh) {
				this.finish();
				return;
			}
			// Keep whatever the user has typed; only the event (and its etag) moves on.
			const draft = this.draft;
			this.event = fresh;
			this.editability = this.computeEditability(fresh);
			this.original = draftFromEvent(fresh);
			this.draft = draft;
			this.render();
		} catch (error) {
			if (isUncertain(error)) this.ctx.afterChange([event.calendarKey]);
			this.showError(describeError(error));
		} finally {
			this.setBusy(false);
		}
	}

	private async remove(): Promise<void> {
		if (!this.event || this.busy) return;
		this.setBusy(true);
		try {
			if (await deleteFlow(this.ctx, this.event)) this.finish();
		} finally {
			this.setBusy(false);
		}
	}
}

/** View (readOnly or not editable) or edit an existing event. */
export function openEventEditor(ctx: EditContext, event: CalEvent, opts: { readOnly?: boolean } = {}): void {
	new EventModal(ctx, { event, readOnly: opts.readOnly }).open();
}

/** The calendar a new event goes to: the requested one, the setting, then the first writable primary. */
function creationCalendar(ctx: EditContext, requested: string | undefined): CalendarInfo | undefined {
	const writable = ctx.calendars().filter((c) => isWritableCalendar(ctx, c));
	for (const key of [requested, ctx.settings().newEventCalendar]) {
		const found = key ? writable.find((c) => c.key === key) : undefined;
		if (found) return found;
	}
	return writable.find((c) => c.primary) ?? writable[0];
}

/** Create mode. `calendarKey` preselects; falls back to settings.newEventCalendar, then first writable primary. */
export function openEventCreator(ctx: EditContext, opts: { start: Moment; calendarKey?: string }): void {
	const calendar = creationCalendar(ctx, opts.calendarKey);
	if (!calendar) {
		new Notice("No calendar you can add events to. Connect an account with editing enabled.");
		return;
	}
	const draft = newDraft(opts.start, ctx.settings().defaultEventMinutes, calendar.key);
	new EventModal(ctx, { draft }).open();
}

/** RSVP without opening the modal. */
export async function respond(ctx: EditContext, event: CalEvent, response: "accepted" | "tentative" | "declined"): Promise<void> {
	const client = ctx.clientFor(event.accountId);
	if (!client) {
		new Notice(NOT_SIGNED_IN);
		return;
	}
	try {
		await client.patchEvent(event.calendarId, event.id, buildRsvpPatch(event, response), {
			etag: event.etag,
			sendUpdates: "none",
		});
		ctx.afterChange([event.calendarKey]);
	} catch (error) {
		new Notice(`Couldn't send your response: ${describeError(error)}`);
		// A conflict means our copy is stale; a network error means it may have gone through.
		if (isUncertain(error) || isKind(error, "conflict")) ctx.afterChange([event.calendarKey]);
	}
}

/** Confirm → recurring scope → notify → delete. Resolves true when the event was deleted. */
async function deleteFlow(ctx: EditContext, event: CalEvent): Promise<boolean> {
	const { app } = ctx;
	if (ctx.settings().confirmDelete && !(await confirmDelete(app, event.title))) return false;

	let eventId = event.id;
	if (event.recurringEventId) {
		const scope = await askRecurringScope(app, { verb: "Delete" });
		if (!scope) return false;
		if (scope === "allEvents") eventId = event.recurringEventId;
	}

	let sendUpdates: SendUpdates = "none";
	if (hasOtherGuests(event.rawAttendees, [], event.accountId)) {
		const choice = await askNotifyGuests(app, ctx.settings(), "cancellation");
		if (!choice) return false;
		sendUpdates = choice;
	}

	const client = ctx.clientFor(event.accountId);
	if (!client) {
		new Notice(NOT_SIGNED_IN);
		return false;
	}
	try {
		await client.deleteEvent(event.calendarId, eventId, { sendUpdates });
	} catch (error) {
		if (isUncertain(error)) {
			new Notice("Couldn't confirm the delete — refreshing to check");
			ctx.afterChange([event.calendarKey]);
			return true;
		}
		new Notice(`Couldn't delete the event: ${describeError(error)}`);
		return false;
	}
	ctx.afterChange([event.calendarKey]);
	new Notice("Event deleted");
	return true;
}

/** Delete with confirm / recurring scope / notify prompts. */
export async function deleteWithPrompts(ctx: EditContext, event: CalEvent): Promise<void> {
	await deleteFlow(ctx, event);
}
