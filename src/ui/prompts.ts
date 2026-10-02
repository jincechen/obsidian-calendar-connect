/**
 * Small promise-based questions the editing flows ask: recurring scope, whether
 * to notify guests, delete confirmation, and what to do after a 412 conflict.
 * Every prompt resolves to null when dismissed (Esc, ×, click outside).
 */
import { App, ButtonComponent, Modal } from "obsidian";
import type { CalendarConnectSettings } from "../settings";
import type { SendUpdates } from "../google";

export interface ChoiceOption<T> {
	label: string;
	value: T;
	cta?: boolean;
	warning?: boolean;
	disabled?: boolean;
	/** Shown under the buttons when this option is disabled, to say why. */
	hint?: string;
}

export interface ChoiceRequest<T> {
	title: string;
	message?: string;
	options: Array<ChoiceOption<T>>;
}

class ChoiceModal<T> extends Modal {
	private settled = false;

	constructor(app: App, private readonly request: ChoiceRequest<T>, private readonly resolve: (value: T | null) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, request } = this;
		this.modalEl.addClass("cc-editor-prompt");
		this.setTitle(request.title);
		if (request.message) contentEl.createEl("p", { cls: "cc-editor-prompt-message", text: request.message });

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		let focus: ButtonComponent | null = null;
		for (const option of request.options) {
			const button = new ButtonComponent(buttons).setButtonText(option.label).onClick(() => {
				this.finish(option.value);
				this.close();
			});
			if (option.cta) button.setCta();
			if (option.warning) button.setDestructive();
			if (option.disabled) {
				button.setDisabled(true);
				if (option.hint) button.setTooltip(option.hint);
			} else if (!focus || option.cta) {
				focus = button;
			}
		}
		const hints = request.options.filter((o) => o.disabled && o.hint).map((o) => o.hint as string);
		for (const hint of hints) contentEl.createDiv({ cls: "cc-editor-prompt-hint", text: hint });
		window.setTimeout(() => focus?.buttonEl.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null);
	}

	private finish(value: T | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(value);
	}
}

/** Shows a row of buttons; resolves with the chosen value, or null when dismissed. */
export function choose<T>(app: App, request: ChoiceRequest<T>): Promise<T | null> {
	return new Promise((resolve) => new ChoiceModal(app, request, resolve).open());
}

export type RecurringScope = "thisEvent" | "allEvents";

export function askRecurringScope(
	app: App,
	opts: { verb: "Save" | "Delete"; thisEvent?: boolean; allEvents?: boolean; hint?: string }
): Promise<RecurringScope | null> {
	const thisAllowed = opts.thisEvent ?? true;
	const allAllowed = opts.allEvents ?? true;
	return choose<RecurringScope>(app, {
		title: opts.verb === "Delete" ? "Delete recurring event" : "Change recurring event",
		message:
			opts.verb === "Delete"
				? "Delete only this occurrence, or every event in the series?"
				: "Apply your changes to this occurrence only, or to every event in the series?",
		options: [
			{
				label: "This event",
				value: "thisEvent",
				cta: thisAllowed && !allAllowed,
				disabled: !thisAllowed,
				hint: thisAllowed ? undefined : opts.hint,
			},
			{
				label: "All events",
				value: "allEvents",
				warning: opts.verb === "Delete",
				cta: opts.verb !== "Delete" && allAllowed && !thisAllowed,
				disabled: !allAllowed,
				hint: allAllowed ? undefined : opts.hint,
			},
		],
	});
}

/** Resolves the notify setting; asks only when it is "ask". Null = the user cancelled. */
export async function askNotifyGuests(
	app: App,
	settings: CalendarConnectSettings,
	what: "update" | "cancellation" | "invitation" = "update"
): Promise<SendUpdates | null> {
	if (settings.notifyGuests === "always") return "all";
	if (settings.notifyGuests === "never") return "none";
	const value = await choose<SendUpdates | "cancel">(app, {
		title: "Notify guests?",
		message: `Email the guests ${what === "invitation" ? "an invitation" : `a ${what}`}?`,
		options: [
			{ label: "Cancel", value: "cancel" },
			{ label: "Don't send", value: "none" },
			{ label: "Send updates", value: "all", cta: true },
		],
	});
	return value === "cancel" || value === null ? null : value;
}

export async function confirmDelete(app: App, title: string): Promise<boolean> {
	const value = await choose<boolean>(app, {
		title: "Delete event?",
		message: `“${title || "(No title)"}” will be deleted from Google Calendar.`,
		options: [
			{ label: "Cancel", value: false },
			{ label: "Delete", value: true, cta: true, warning: true },
		],
	});
	return value === true;
}

export type ConflictChoice = "reload" | "apply";

/** Null = cancel: keep the modal open with the user's edits. */
export async function askConflict(app: App): Promise<ConflictChoice | null> {
	const value = await choose<ConflictChoice | "cancel">(app, {
		title: "Changed in Google Calendar",
		message:
			"This event was changed somewhere else since you opened it. Reload it (your edits are discarded) or apply your changes on top?",
		options: [
			{ label: "Cancel", value: "cancel" },
			{ label: "Reload event", value: "reload" },
			{ label: "Apply my changes", value: "apply", cta: true },
		],
	});
	return value === "cancel" ? null : value;
}
