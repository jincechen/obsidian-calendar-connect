import { Modal, Notice, type App } from "obsidian";
import { authorizeWith, type ClientConfig, type ConsentView, type TokenGrant } from "../auth";
import { openExternal } from "../safety";

/**
 * Walks the user through Google's consent screen. Works the same everywhere:
 * open the link, approve, paste the address the browser lands on. On desktop a
 * loopback listener usually finishes first and this closes by itself.
 */
export class ConsentModal extends Modal {
	constructor(app: App, private readonly view: ConsentView) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, view } = this;
		this.setTitle("Connect a Google account");
		contentEl.addClass("cc-consent");

		const steps = contentEl.createEl("ol", { cls: "cc-consent-steps" });
		steps.createEl("li", { text: "Open the link below and approve access for the account you want to add." });
		steps.createEl("li", {
			text: "If your browser shows “This site can’t be reached”, that’s expected — copy the full address from the address bar.",
		});
		steps.createEl("li", { text: "Paste it here and select Continue." });

		const links = contentEl.createDiv({ cls: "modal-button-container cc-consent-links" });
		const openButton = links.createEl("button", { text: "Open in browser" });
		openButton.addEventListener("click", () => {
			if (!openExternal(view.url)) new Notice("Couldn't open the browser. Use Copy link instead.");
		});
		const copyButton = links.createEl("button", { text: "Copy link" });
		copyButton.addEventListener("click", () => {
			navigator.clipboard.writeText(view.url).then(
				() => new Notice("Sign-in link copied."),
				() => new Notice("Couldn't copy the link. Use Open in browser instead.")
			);
		});

		if (view.listening) {
			contentEl.createEl("p", {
				cls: "cc-consent-hint setting-item-description",
				text: "Or just approve in the browser — this window will close by itself.",
			});
		}

		const input = contentEl.createEl("textarea", {
			cls: "cc-consent-input",
			attr: {
				rows: "3",
				placeholder: "http://127.0.0.1:…/?state=…&code=…",
				spellcheck: "false",
				autocapitalize: "off",
				autocomplete: "off",
				"aria-label": "Address from the browser",
			},
		});
		const errorEl = contentEl.createDiv({ cls: "cc-consent-error", attr: { role: "alert" } });
		errorEl.hide();

		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelButton = footer.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => this.close());
		const continueButton = footer.createEl("button", { text: "Continue", cls: "mod-cta" });

		const submit = () => {
			// On success the flow closes this modal itself.
			const error = view.submit(input.value);
			if (error) {
				errorEl.setText(error);
				errorEl.show();
				input.focus();
			}
		};
		continueButton.addEventListener("click", submit);
		input.addEventListener("input", () => errorEl.hide());
		input.addEventListener("keydown", (event) => {
			// An address never contains a newline, so Enter submits.
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				submit();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
		// Closing by any route cancels; a no-op once the flow has already settled.
		this.view.cancel();
	}
}

/**
 * Runs the consent flow with this modal as its UI. Lives here rather than in
 * auth.ts because auth.ts is imported by tests and must stay free of UI classes.
 */
export function authorize(app: App, config: ClientConfig & { port: number }): Promise<TokenGrant> {
	return authorizeWith(config, (view) => {
		const modal = new ConsentModal(app, view);
		modal.open();
		return () => modal.close();
	});
}
