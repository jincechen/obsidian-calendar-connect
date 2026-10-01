/**
 * Small promise-based questions the editing flows ask: delete confirmation.
 * Every prompt resolves to null when dismissed (Esc, ×, click outside).
 */
import { App, ButtonComponent, Modal } from "obsidian";

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
