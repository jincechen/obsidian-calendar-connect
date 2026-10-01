import { Menu, Notice, setIcon } from "obsidian";
import type { Moment } from "./moment-shim";
import {
	bucketByDay,
	dayHeading,
	formatDuration,
	formatTime,
	relativeStart,
	timeLabel,
	timeState,
	type DayItem,
	type TimeState,
} from "./dates";
import type { BlockQuery } from "./query";
import { visibleEvents } from "./store";
import { mapsUrl, markdownInline, openExternal, safeColor, safeExternalUrl, truncate } from "./safety";
import type { CalEvent, Editability, Field } from "./types";

/** What a rendered block can ask its owner to do. `block.ts` supplies the implementation. */
export interface BlockActions {
	editability(event: CalEvent): Editability;
	/** Editor or read-only viewer. */
	open(event: CalEvent): void;
	canCreate(): boolean;
	/** `day` is the start of the day to create on. */
	create(day: Moment): void;
	remove(event: CalEvent): void;
	refresh(): void;
}

export interface RenderOptions {
	warnings: string[];
	lastUpdated: Moment | null;
	now: Moment;
	actions: BlockActions;
}

const FIELD_LABELS: Record<Field, string> = {
	date: "Date",
	time: "Time",
	duration: "Length",
	title: "Event",
	calendar: "Calendar",
	account: "Account",
	location: "Location",
	description: "Notes",
	attendees: "Guests",
	response: "RSVP",
	link: "Link",
};

const FIELD_ICONS: Partial<Record<Field, string>> = {
	location: "map-pin",
	description: "align-left",
	attendees: "users",
	calendar: "calendar",
	account: "at-sign",
	duration: "hourglass",
	response: "circle-check",
	date: "calendar-days",
};

const RESPONSE_LABELS: Record<string, string> = {
	accepted: "Going",
	tentative: "Maybe",
	declined: "Declined",
	needsAction: "Not answered",
};

/** Own-property lookup: Google's value must not resolve to an Object.prototype member. */
function responseLabel(response: string): string | undefined {
	return Object.prototype.hasOwnProperty.call(RESPONSE_LABELS, response) ? RESPONSE_LABELS[response] : undefined;
}

/** The "next" event only shows how soon it starts when that is under this many minutes away. */
const RELATIVE_WINDOW_MINUTES = 120;

const READ_ONLY: Editability = {
	canEdit: false,
	canDelete: false,
	canMove: false,
	canRsvp: false,
	reason: "This block is read-only",
};

// --- Time-dependent state --------------------------------------------------

interface ViewState {
	states: Map<CalEvent, TimeState>;
	/** First upcoming timed event, when `now` highlighting is on. */
	next: CalEvent | null;
	/** "in 25m" for `next`, when it is close enough to be worth saying. */
	relative: string | null;
}

function viewState(events: CalEvent[], query: BlockQuery, now: Moment): ViewState {
	const states = new Map<CalEvent, TimeState>();
	let next: CalEvent | null = null;
	for (const event of events) {
		const state = timeState(event, now);
		states.set(event, state);
		if (!query.highlightNow || state !== "future" || event.allDay || event.selfResponse === "declined") continue;
		if (
			!next ||
			event.start.isBefore(next.start) ||
			(event.start.isSame(next.start) && event.title.localeCompare(next.title) < 0)
		) {
			next = event;
		}
	}
	const relative =
		next && next.start.diff(now, "minutes", true) < RELATIVE_WINDOW_MINUTES ? relativeStart(next, now) : null;
	return { states, next, relative };
}

/** Changes whenever the minute tick would change what is drawn (past/now/next states, relative labels). */
export function stateSignature(events: CalEvent[], query: BlockQuery, now: Moment): string {
	const view = viewState(events, query, now);
	const parts = events.map((event) => {
		const isNext = event === view.next;
		return `${event.calendarKey}/${event.id}:${view.states.get(event) ?? ""}${isNext ? `:next:${view.relative ?? ""}` : ""}`;
	});
	// The date matters too: "Today" and the now-line move at midnight.
	return `${now.format("YYYY-MM-DD")}|${parts.join(",")}`;
}

// --- Shared helpers --------------------------------------------------------

function editabilityFor(event: CalEvent, query: BlockQuery, actions: BlockActions): Editability {
	return query.editable ? actions.editability(event) : READ_ONLY;
}

function canCreate(query: BlockQuery, actions: BlockActions): boolean {
	return query.editable && query.newEventCalendar !== false && actions.canCreate();
}

function setColor(el: HTMLElement, event: CalEvent): void {
	// An empty value removes the property, so the CSS falls back to the accent colour.
	el.style.setProperty("--cc-color", safeColor(event.calendarColor) ?? "");
}

/** `09:30–10:00`, `All day`, `Day 2/3`, or `→ 18:00` on the last day of a timed event crossing midnight. */
function timeText(event: CalEvent, query: BlockQuery, part?: DayItem["part"]): string {
	if (event.allDay) return part ? `Day ${part.index}/${part.count}` : "All day";
	if (part && part.index > 1) {
		return part.index === part.count ? `→ ${formatTime(event.end, query.use24HourTime)}` : `Day ${part.index}/${part.count}`;
	}
	return timeLabel(event, query.use24HourTime);
}

function guestCount(event: CalEvent): number {
	return event.attendees.filter((attendee) => !attendee.resource && !attendee.self).length;
}

function attendeeSummary(event: CalEvent): string {
	const guests = event.attendees.filter((attendee) => !attendee.resource && !attendee.self);
	if (guests.length === 0) return "";
	const accepted = guests.filter((guest) => guest.response === "accepted").length;
	const named = guests
		.slice(0, 3)
		.map((guest) => guest.name ?? guest.email ?? "unknown")
		.join(", ");
	const overflow = guests.length > 3 ? ` +${guests.length - 3}` : "";
	return `${named}${overflow} · ${accepted}/${guests.length} yes`;
}

function oneLine(text: string | undefined, max: number): string {
	return text ? truncate(text.replace(/\s+/g, " ").trim(), max) : "";
}

/** Plain-text value for a field, used by the agenda meta line and table cells. */
function fieldText(event: CalEvent, field: Field, query: BlockQuery): string {
	switch (field) {
		case "date":
			return event.start.format(query.tableDateFormat);
		case "time":
			return timeText(event, query);
		case "duration":
			return formatDuration(event.start, event.end, event.allDay);
		case "title":
			return event.title;
		case "calendar":
			return event.calendarName;
		case "account":
			return event.accountLabel;
		case "location":
			return event.location ?? "";
		case "description":
			return oneLine(event.description, query.descriptionLength);
		case "attendees":
			return attendeeSummary(event);
		case "response":
			return event.selfResponse ? responseLabel(event.selfResponse) ?? event.selfResponse : "";
		case "link":
			return safeExternalUrl(event.meetUrl) ?? safeExternalUrl(event.link) ?? "";
	}
}

function copyText(text: string, what: string): void {
	void navigator.clipboard.writeText(text).then(
		() => new Notice(`${what} copied`),
		() => new Notice(`Couldn't copy the ${what.toLowerCase()}`)
	);
}

/** A small icon control in the Obsidian idiom. Activating it never also activates the row. */
function iconButton(parent: HTMLElement, cls: string, icon: string, label: string, run: (el: HTMLElement) => void): HTMLElement {
	const button = parent.createDiv({
		cls: `clickable-icon ${cls}`,
		attr: { role: "button", tabindex: "0", "aria-label": label },
	});
	setIcon(button, icon);
	button.addEventListener("click", (mouse) => {
		mouse.preventDefault();
		mouse.stopPropagation();
		run(button);
	});
	button.addEventListener("keydown", (key) => {
		if (key.key !== "Enter" && key.key !== " ") return;
		key.preventDefault();
		key.stopPropagation();
		run(button);
	});
	return button;
}

// --- Event menu --------------------------------------------------------------

/** Keyboard Shift+F10 can also raise a native contextmenu; this keeps it to one menu. */
let lastMenuAt = 0;

function showEventMenu(
	event: CalEvent,
	query: BlockQuery,
	actions: BlockActions,
	at: MouseEvent | HTMLElement
): void {
	const stamp = Date.now();
	if (stamp - lastMenuAt < 150) return;
	lastMenuAt = stamp;

	const editability = editabilityFor(event, query, actions);
	const menu = new Menu();

	menu.addItem((item) =>
		item
			.setTitle(editability.canEdit ? "Edit" : "View details")
			.setIcon(editability.canEdit ? "pencil" : "eye")
			.onClick(() => actions.open(event))
	);

	const meet = safeExternalUrl(event.meetUrl);
	if (meet) menu.addItem((item) => item.setTitle("Join call").setIcon("video").onClick(() => openExternal(meet)));
	const link = safeExternalUrl(event.link);
	if (link) {
		menu.addItem((item) =>
			item.setTitle("Open in Google Calendar").setIcon("external-link").onClick(() => openExternal(link))
		);
	}

	menu.addItem((item) => item.setTitle("Copy title").setIcon("copy").onClick(() => copyText(event.title, "Title")));
	menu.addItem((item) =>
		item
			.setTitle("Copy as Markdown")
			.setIcon("clipboard-list")
			.onClick(() => copyText(`- ${timeText(event, query)} ${markdownInline(event.title)}`, "Event"))
	);

	if (editability.canDelete) {
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Delete")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => actions.remove(event))
		);
	}

	if (at instanceof HTMLElement) {
		const rect = at.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom }, at.doc);
	} else {
		menu.showAtMouseEvent(at);
	}
}

/**
 * Click / Enter / Space opens the event; right-click, Android long-press and
 * Shift+F10 open the menu. Inner controls stop propagation, so they never
 * also count as a click on the row.
 */
function attachRowBehaviour(row: HTMLElement, event: CalEvent, query: BlockQuery, actions: BlockActions): void {
	row.setAttr("role", "button");
	row.setAttr("tabindex", "0");
	row.addEventListener("click", (mouse) => {
		if (mouse.defaultPrevented) return;
		actions.open(event);
	});
	row.addEventListener("keydown", (key) => {
		if (key.target !== row) return;
		if (key.key === "Enter" || key.key === " ") {
			key.preventDefault();
			actions.open(event);
		} else if ((key.key === "F10" && key.shiftKey) || key.key === "ContextMenu") {
			key.preventDefault();
			showEventMenu(event, query, actions, row);
		}
	});
	row.addEventListener("contextmenu", (mouse) => {
		mouse.preventDefault();
		mouse.stopPropagation();
		// A keyboard-raised contextmenu has no pointer position.
		showEventMenu(event, query, actions, mouse.clientX === 0 && mouse.clientY === 0 ? row : mouse);
	});
}

function applyStateClasses(
	el: HTMLElement,
	event: CalEvent,
	query: BlockQuery,
	view: ViewState,
	editability: Editability
): void {
	const state = view.states.get(event);
	el.toggleClass("is-all-day", event.allDay);
	el.toggleClass("is-past", state === "past" && query.past !== "show");
	el.toggleClass("is-now", state === "now" && query.highlightNow && !event.allDay);
	el.toggleClass("is-next", event === view.next);
	el.toggleClass("is-declined", event.selfResponse === "declined");
	el.toggleClass("is-tentative", event.selfResponse === "tentative" || event.status === "tentative");
	el.toggleClass("is-readonly", !editability.canEdit);
}

function isHidden(event: CalEvent, query: BlockQuery, view: ViewState): boolean {
	// All-day events of today are "now", never "past", so they stay visible.
	return query.past === "hide" && view.states.get(event) === "past";
}

/** Day buckets with hidden rows removed and emptied days dropped. */
function visibleBuckets(events: CalEvent[], query: BlockQuery, view: ViewState) {
	return bucketByDay(events, query.from, query.to)
		.map((bucket) => ({ ...bucket, items: bucket.items.filter((item) => !isHidden(item.event, query, view)) }))
		.filter((bucket) => bucket.items.length > 0);
}

/**
 * Index in `items` before which the now-line goes: the first timed row that has
 * not ended, or the end of the day when every timed row has.
 */
function nowLineIndex(items: DayItem[], view: ViewState): number {
	const index = items.findIndex((item) => !item.event.allDay && view.states.get(item.event) !== "past");
	return index === -1 ? items.length : index;
}

function createNowLine(parent: HTMLElement, tag: "li" | "div"): void {
	const line = parent.createEl(tag, { cls: "cc-now-line", attr: { "aria-hidden": "true" } });
	line.createSpan({ cls: "cc-now-label", text: "now" });
	line.createSpan({ cls: "cc-now-rule" });
}

function dayHeader(
	parent: HTMLElement,
	cls: string,
	day: Moment,
	count: number,
	query: BlockQuery,
	actions: BlockActions
): void {
	const header = parent.createDiv({ cls });
	header.createSpan({ cls: "cc-day-label", text: dayHeading(day, query.dateHeadingFormat) });
	header.createSpan({ cls: "cc-day-count", text: String(count) });
	if (canCreate(query, actions)) {
		iconButton(header, "cc-day-add", "plus", `New event on ${day.format("dddd D MMMM")}`, () =>
			actions.create(day.clone().startOf("day"))
		);
	}
}

// --- List view ---------------------------------------------------------------

function renderRow(
	list: HTMLElement,
	item: DayItem,
	query: BlockQuery,
	view: ViewState,
	actions: BlockActions
): void {
	const { event, part } = item;
	const editability = editabilityFor(event, query, actions);
	const row = list.createEl("li", { cls: "cc-row" });
	setColor(row, event);
	applyStateClasses(row, event, query, view, editability);

	if (query.fields.includes("time")) {
		const time = row.createSpan({ cls: "cc-row-time" });
		const single = !event.allDay && !part && !event.end.isSame(event.start);
		if (single) {
			// Split so a narrow block can drop the end time.
			time.createSpan({ cls: "cc-row-time-start", text: formatTime(event.start, query.use24HourTime) });
			time.createSpan({ cls: "cc-row-time-end", text: `–${formatTime(event.end, query.use24HourTime)}` });
		} else {
			time.setText(timeText(event, query, part));
		}
	}

	const dot = row.createSpan({ cls: "cc-row-dot" });
	dot.toggleClass("is-hollow", event.selfResponse === "needsAction" || event.selfResponse === "tentative");

	const content = row.createDiv({ cls: "cc-row-content" });
	const line = content.createDiv({ cls: "cc-row-line" });
	line.createSpan({ cls: "cc-row-title", text: event.title || "(No title)" });

	const chips: string[] = [];
	for (const field of query.fields) {
		switch (field) {
			case "date":
				chips.push(event.start.format(query.tableDateFormat));
				break;
			case "calendar":
				chips.push(event.calendarName);
				break;
			case "account":
				chips.push(event.accountLabel);
				break;
			case "duration":
				// "all day" would only repeat the time column.
				if (!event.allDay || event.end.diff(event.start, "hours", true) > 24) {
					chips.push(formatDuration(event.start, event.end, event.allDay));
				}
				break;
			case "attendees": {
				const guests = guestCount(event);
				if (guests > 0) chips.push(guests === 1 ? "1 guest" : `${guests} guests`);
				break;
			}
			case "response":
				if (event.selfResponse) chips.push(responseLabel(event.selfResponse) ?? event.selfResponse);
				break;
		}
	}
	if (chips.length > 0) {
		const meta = line.createSpan({ cls: "cc-row-meta" });
		for (const chip of chips) meta.createSpan({ cls: "cc-chip", text: chip });
	}

	const location = event.location?.trim();
	const meet = safeExternalUrl(event.meetUrl);
	const showLocation = Boolean(location) && query.fields.includes("location");
	const showMeet = Boolean(meet) && query.fields.includes("link");
	if (showLocation || showMeet || event.recurring) {
		const icons = line.createSpan({ cls: "cc-row-icons" });
		if (showMeet && meet) {
			iconButton(icons, "cc-row-icon cc-row-meet", "video", "Join call", () => openExternal(meet));
		}
		if (showLocation && location) {
			iconButton(icons, "cc-row-icon cc-row-location", "map-pin", location, () => openExternal(mapsUrl(location)));
		}
		if (event.recurring) {
			const repeat = icons.createSpan({ cls: "cc-row-icon cc-row-recurring", attr: { "aria-label": "Recurring" } });
			setIcon(repeat, "repeat");
		}
	}

	if (event === view.next && view.relative && (!part || part.index === 1)) {
		line.createSpan({ cls: "cc-row-rel", text: view.relative });
	}

	if (query.fields.includes("description")) {
		const description = oneLine(event.description, query.descriptionLength);
		if (description) {
			row.addClass("has-desc");
			content.createDiv({ cls: "cc-row-desc", text: description });
		}
	}

	iconButton(row, "cc-row-more", "more-horizontal", "More options", (button) =>
		showEventMenu(event, query, actions, button)
	);

	attachRowBehaviour(row, event, query, actions);
}

function renderList(container: HTMLElement, events: CalEvent[], query: BlockQuery, options: RenderOptions): boolean {
	const view = viewState(events, query, options.now);
	const buckets = visibleBuckets(events, query, view);
	if (buckets.length === 0) return false;

	const multiDay = !query.from.isSame(query.to, "day");
	const today = options.now.clone().startOf("day");

	for (const bucket of buckets) {
		const isToday = bucket.day.isSame(today, "day");
		const section = container.createDiv({ cls: "cc-day" });
		section.toggleClass("is-today", isToday);
		section.toggleClass("is-past-day", bucket.day.isBefore(today, "day"));
		if (multiDay) dayHeader(section, "cc-day-header", bucket.day, bucket.items.length, query, options.actions);

		const list = section.createEl("ul", { cls: "cc-rows" });
		const lineAt = query.highlightNow && isToday ? nowLineIndex(bucket.items, view) : -1;
		bucket.items.forEach((item, index) => {
			if (index === lineAt) createNowLine(list, "li");
			renderRow(list, item, query, view, options.actions);
		});
		if (lineAt === bucket.items.length) createNowLine(list, "li");
	}
	return true;
}

// --- Agenda view -------------------------------------------------------------

function renderMeta(parent: HTMLElement, field: Field, event: CalEvent, query: BlockQuery): void {
	if (field === "link") {
		const meet = safeExternalUrl(event.meetUrl);
		const url = meet ?? safeExternalUrl(event.link);
		if (!url) return;
		const line = parent.createDiv({ cls: "cc-meta cc-meta-link" });
		setIcon(line.createSpan({ cls: "cc-meta-icon" }), meet ? "video" : "external-link");
		const anchor = line.createEl("a", {
			cls: "cc-meta-text cc-link",
			text: meet ? "Join call" : "Open in Google Calendar",
			href: url,
		});
		anchor.addEventListener("click", (mouse) => {
			mouse.preventDefault();
			mouse.stopPropagation();
			openExternal(url);
		});
		return;
	}

	const text = fieldText(event, field, query);
	if (!text) return;
	const line = parent.createDiv({ cls: `cc-meta cc-meta-${field}` });
	const icon = FIELD_ICONS[field];
	if (icon) setIcon(line.createSpan({ cls: "cc-meta-icon" }), icon);

	if (field === "location") {
		const location = text;
		const anchor = line.createEl("a", { cls: "cc-meta-text cc-link", text: location, href: mapsUrl(location) });
		anchor.addEventListener("click", (mouse) => {
			mouse.preventDefault();
			mouse.stopPropagation();
			openExternal(mapsUrl(location));
		});
		return;
	}
	line.createSpan({ cls: "cc-meta-text", text });
}

function renderAgenda(container: HTMLElement, events: CalEvent[], query: BlockQuery, options: RenderOptions): boolean {
	const view = viewState(events, query, options.now);
	const buckets = visibleBuckets(events, query, view);
	if (buckets.length === 0) return false;

	const today = options.now.clone().startOf("day");
	const showTime = query.fields.includes("time");
	const metaFields = query.fields.filter((field) => field !== "time" && field !== "title" && field !== "date");

	for (const bucket of buckets) {
		const isToday = bucket.day.isSame(today, "day");
		const section = container.createDiv({ cls: "cc-group" });
		section.toggleClass("is-today", isToday);
		dayHeader(section, "cc-group-heading cc-day-header", bucket.day, bucket.items.length, query, options.actions);

		const list = section.createDiv({ cls: "cc-agenda" });
		const lineAt = query.highlightNow && isToday ? nowLineIndex(bucket.items, view) : -1;
		bucket.items.forEach(({ event, part }, index) => {
			if (index === lineAt) createNowLine(list, "div");
			const editability = editabilityFor(event, query, options.actions);
			const row = list.createDiv({ cls: "cc-event" });
			row.toggleClass("no-gutter", !showTime);
			setColor(row, event);
			applyStateClasses(row, event, query, view, editability);

			if (showTime) row.createDiv({ cls: "cc-event-time", text: timeText(event, query, part) });

			const body = row.createDiv({ cls: "cc-event-body" });
			const titleLine = body.createDiv({ cls: "cc-event-title-line" });
			titleLine.createSpan({ cls: "cc-event-title", text: event.title || "(No title)" });
			if (event === view.next && view.relative && (!part || part.index === 1)) {
				titleLine.createSpan({ cls: "cc-row-rel", text: view.relative });
			}
			iconButton(titleLine, "cc-row-more", "more-horizontal", "More options", (button) =>
				showEventMenu(event, query, options.actions, button)
			);

			// Short metadata shares one wrapping row; a description is prose and gets its own line.
			const inline = metaFields.filter((field) => field !== "description");
			if (inline.length > 0) {
				const metaRow = body.createDiv({ cls: "cc-meta-row" });
				for (const field of inline) renderMeta(metaRow, field, event, query);
				if (metaRow.childElementCount === 0) metaRow.remove();
			}
			if (metaFields.includes("description")) renderMeta(body, "description", event, query);

			attachRowBehaviour(row, event, query, options.actions);
		});
		if (lineAt === bucket.items.length) createNowLine(list, "div");
	}
	return true;
}

// --- Table view --------------------------------------------------------------

function renderTable(container: HTMLElement, events: CalEvent[], query: BlockQuery, options: RenderOptions): boolean {
	const view = viewState(events, query, options.now);
	const visible = events.filter((event) => !isHidden(event, query, view));
	if (visible.length === 0) return false;

	const wrapper = container.createDiv({ cls: "cc-table-wrapper" });
	const table = wrapper.createEl("table", { cls: "cc-table" });
	const head = table.createEl("thead").createEl("tr");
	for (const field of query.fields) {
		head.createEl("th", { cls: `cc-col-${field}`, text: FIELD_LABELS[field] });
	}

	const body = table.createEl("tbody");
	for (const event of visible) {
		const editability = editabilityFor(event, query, options.actions);
		const row = body.createEl("tr", { cls: "cc-table-row" });
		setColor(row, event);
		applyStateClasses(row, event, query, view, editability);

		for (const field of query.fields) {
			const cell = row.createEl("td", { cls: `cc-col-${field}` });
			if (field === "link") {
				const meet = safeExternalUrl(event.meetUrl);
				const url = meet ?? safeExternalUrl(event.link);
				if (url) {
					const anchor = cell.createEl("a", { cls: "cc-link", text: meet ? "Join" : "Open", href: url });
					anchor.addEventListener("click", (mouse) => {
						mouse.preventDefault();
						mouse.stopPropagation();
						openExternal(url);
					});
				}
				continue;
			}
			if (field === "calendar") cell.createSpan({ cls: "cc-dot" });
			if (field === "title" && event === view.next && view.relative) {
				cell.createSpan({ text: event.title || "(No title)" });
				cell.createSpan({ cls: "cc-row-rel", text: view.relative });
				continue;
			}
			cell.createSpan({ text: fieldText(event, field, query) });
		}

		attachRowBehaviour(row, event, query, options.actions);
	}
	return true;
}

// --- Block chrome ------------------------------------------------------------

/** Where "+ New event" creates: today when it is in range, otherwise the first day shown. */
function defaultCreateDay(query: BlockQuery, now: Moment): Moment {
	const today = now.clone().startOf("day");
	const inRange = !today.isBefore(query.from, "day") && !today.isAfter(query.to, "day");
	return inRange ? today : query.from.clone().startOf("day");
}

function renderFooter(container: HTMLElement, query: BlockQuery, options: RenderOptions): void {
	const footer = container.createDiv({ cls: "cc-footer" });
	if (canCreate(query, options.actions)) {
		const button = footer.createEl("button", { cls: "cc-new-event" });
		setIcon(button.createSpan({ cls: "cc-new-event-icon" }), "plus");
		button.createSpan({ text: "New event" });
		button.addEventListener("click", (mouse) => {
			mouse.preventDefault();
			options.actions.create(defaultCreateDay(query, options.now));
		});
	}
	footer.createSpan({ cls: "cc-footer-spacer" });
	if (options.lastUpdated) {
		footer.createSpan({ cls: "cc-updated", text: `Updated ${options.lastUpdated.fromNow()}` });
	}
	iconButton(footer, "cc-refresh", "refresh-cw", "Refresh events", () => options.actions.refresh());
}

const VIEW_CLASSES = ["cc-view-list", "cc-view-agenda", "cc-view-table"];

export function renderEvents(container: HTMLElement, events: CalEvent[], query: BlockQuery, options: RenderOptions): void {
	container.empty();
	container.removeClass(...VIEW_CLASSES);
	container.addClass("cc-block", `cc-view-${query.view}`);
	container.toggleClass("cc-12h", !query.use24HourTime);
	container.toggleClass("cc-no-time", !query.fields.includes("time"));

	for (const warning of options.warnings) {
		const box = container.createDiv({ cls: "cc-warning" });
		setIcon(box.createSpan({ cls: "cc-warning-icon" }), "alert-triangle");
		box.createSpan({ cls: "cc-warning-text", text: warning });
	}

	const shown = visibleEvents(events, query, options.now);
	const drawn =
		shown.length > 0 &&
		(query.view === "table"
			? renderTable(container, shown, query, options)
			: query.view === "agenda"
				? renderAgenda(container, shown, query, options)
				: renderList(container, shown, query, options));
	if (!drawn) container.createDiv({ cls: "cc-empty", text: query.emptyMessage });

	if (query.controls) renderFooter(container, query, options);
}

export function renderMessage(
	container: HTMLElement,
	kind: "error" | "notice",
	title: string,
	detail?: string,
	action?: { label: string; onClick: () => void }
): void {
	container.empty();
	container.addClass("cc-block");

	const box = container.createDiv({ cls: `cc-message cc-message-${kind}` });
	const heading = box.createDiv({ cls: "cc-message-title" });
	setIcon(heading.createSpan({ cls: "cc-message-icon" }), kind === "error" ? "alert-triangle" : "info");
	heading.createSpan({ text: title });
	if (detail) box.createDiv({ cls: "cc-message-detail", text: detail });
	if (action) {
		const button = box.createEl("button", { cls: "cc-message-action mod-cta", text: action.label });
		button.addEventListener("click", action.onClick);
	}
}
