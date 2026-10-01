/**
 * Pure editing logic: what the account may do to an event, the editor's draft,
 * validation, and the request bodies sent to Google. Nothing here touches the
 * DOM or the network, so every rule is covered by tests/editing.test.ts.
 */
import { moment, type Moment } from "./moment-shim";
import { isValidEmail } from "./safety";
import type { CalEvent, CalendarInfo, Editability, RawAttendee, RawEventDate } from "./types";

const DATE = "YYYY-MM-DD";
const TIME = "HH:mm";
const MAX_TITLE = 1024;

// --- Editability -----------------------------------------------------------

const WRITE_ROLES = ["writer", "owner"];

/** What this account may do to `event`. `canWrite` = the account was granted the events scope. */
export function editabilityOf(event: CalEvent, calendar: CalendarInfo | undefined, canWrite: boolean): Editability {
	const none = { canEdit: false, canDelete: false, canMove: false, canRsvp: false };
	if (!canWrite) return { ...none, reason: "Read-only — reconnect this account to enable editing" };
	if (!calendar || !WRITE_ROLES.includes(calendar.accessRole)) {
		return { ...none, reason: `You can only view ${calendar?.name ?? event.calendarName}` };
	}

	const isGuest = !event.organizerSelf && event.rawAttendees.some((a) => a.self === true);
	const canRsvp = isGuest;
	const special = specialReason(event);
	if (special) return { canEdit: false, canDelete: false, canMove: false, canRsvp, reason: special };

	const canEdit = event.organizerSelf || event.guestsCanModify;
	const canDelete = event.organizerSelf;
	const result: Editability = { canEdit, canDelete, canMove: canDelete, canRsvp };
	if (!canEdit) {
		result.reason = event.organizer
			? `Only the organizer (${event.organizer}) can change this event`
			: "Only the organizer can change this event";
	}
	return result;
}

function specialReason(event: CalEvent): string | null {
	if (event.locked) return "This event is locked and can't be changed";
	if (event.privateCopy) return "This is a private copy of someone else's event, so it can't be changed";
	const type = event.eventType || "default";
	if (type !== "default") return `Events of this kind (${type}) can only be changed in Google Calendar`;
	return null;
}

// --- Draft -----------------------------------------------------------------

/** The editor's working copy. Dates are `YYYY-MM-DD`, times `HH:mm`, both local. */
export interface EventDraft {
	title: string;
	allDay: boolean;
	startDate: string;
	startTime: string;
	/** For all-day events, the inclusive last day. */
	endDate: string;
	endTime: string;
	location: string;
	description: string;
	/** Lowercased, trimmed emails. */
	guests: string[];
	calendarKey: string;
}

export function normaliseEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function draftFromEvent(event: CalEvent): EventDraft {
	const start = event.start.clone();
	const end = event.end.clone();
	const guests: string[] = [];
	for (const attendee of event.rawAttendees) {
		const email = attendee.email ? normaliseEmail(attendee.email) : "";
		if (email && !guests.includes(email)) guests.push(email);
	}
	return {
		title: event.title,
		allDay: event.allDay,
		startDate: start.format(DATE),
		// All-day events still carry times, so toggling all-day off lands somewhere sensible.
		startTime: event.allDay ? "09:00" : start.format(TIME),
		endDate: end.format(DATE),
		endTime: event.allDay ? "10:00" : end.format(TIME),
		location: event.location ?? "",
		description: event.description ?? "",
		guests,
		calendarKey: event.calendarKey,
	};
}

/** Local wall-time start of a timed draft (invalid moment when the fields are). */
export function draftStart(draft: EventDraft): Moment {
	return moment(`${draft.startDate} ${draft.startTime}`, `${DATE} ${TIME}`, true);
}

export function draftEnd(draft: EventDraft): Moment {
	return moment(`${draft.endDate} ${draft.endTime}`, `${DATE} ${TIME}`, true);
}

/**
 * The draft with a new start, and the end moved by the same amount so the
 * length is kept. When the old values do not parse, only the start changes.
 */
export function withStart(draft: EventDraft, startDate: string, startTime: string): EventDraft {
	const next = { ...draft, startDate, startTime };
	if (draft.allDay) {
		const before = parseDate(draft.startDate);
		const after = parseDate(startDate);
		const end = parseDate(draft.endDate);
		if (before.isValid() && after.isValid() && end.isValid()) {
			const days = Math.round(end.diff(before, "days", true));
			next.endDate = after.add(Math.max(0, days), "days").format(DATE);
		}
		return next;
	}
	const before = draftStart(draft);
	const end = draftEnd(draft);
	const after = draftStart(next);
	if (before.isValid() && end.isValid() && after.isValid() && end.isAfter(before)) {
		const moved = after.clone().add(end.valueOf() - before.valueOf(), "milliseconds");
		next.endDate = moved.format(DATE);
		next.endTime = moved.format(TIME);
	}
	return next;
}

function parseDate(value: string): Moment {
	return moment(value, DATE, true);
}

export type DraftErrors = Partial<Record<keyof EventDraft, string>>;

/** Field → message. Empty object = valid. */
export function validateDraft(draft: EventDraft): DraftErrors {
	const errors: DraftErrors = {};
	if (draft.title.length > MAX_TITLE) errors.title = `Keep the title under ${MAX_TITLE} characters`;

	const startDay = parseDate(draft.startDate);
	const endDay = parseDate(draft.endDate);
	if (!startDay.isValid()) errors.startDate = "Enter a valid date";
	if (!endDay.isValid()) errors.endDate = "Enter a valid date";

	if (draft.allDay) {
		if (startDay.isValid() && endDay.isValid() && endDay.isBefore(startDay, "day")) {
			errors.endDate = "The end can't be before the start";
		}
	} else {
		if (!moment(draft.startTime, TIME, true).isValid()) errors.startTime = "Enter a valid time";
		if (!moment(draft.endTime, TIME, true).isValid()) errors.endTime = "Enter a valid time";
		if (!errors.startDate && !errors.endDate && !errors.startTime && !errors.endTime) {
			const start = draftStart(draft);
			const end = draftEnd(draft);
			// Google allows zero-length events (reminders, deadlines), so only a
			// negative length is an error.
			if (end.isBefore(start)) {
				if (endDay.isBefore(startDay, "day")) errors.endDate = "The end can't be before the start";
				else errors.endTime = "The event can't end before it starts";
			}
		}
	}

	const bad = draft.guests.find((email) => !isValidEmail(email));
	if (bad !== undefined) errors.guests = `Not a valid email: ${bad}`;
	return errors;
}

// --- Changes ---------------------------------------------------------------

export interface ChangeSet {
	title: boolean;
	/** Start, end or all-day changed. */
	time: boolean;
	/** The start date changed — what makes a recurring change "This event" only. */
	dateChanged: boolean;
	location: boolean;
	description: boolean;
	guests: boolean;
	calendar: boolean;
	any: boolean;
}

export function diffDraft(original: EventDraft, draft: EventDraft): ChangeSet {
	let time = original.allDay !== draft.allDay || original.startDate !== draft.startDate || original.endDate !== draft.endDate;
	if (!draft.allDay && !original.allDay) {
		time = time || original.startTime !== draft.startTime || original.endTime !== draft.endTime;
	}
	const sameGuests =
		original.guests.length === draft.guests.length &&
		[...original.guests].sort().join("\n") === [...draft.guests].sort().join("\n");
	const changes = {
		title: original.title !== draft.title,
		time,
		dateChanged: original.startDate !== draft.startDate,
		location: original.location !== draft.location,
		description: original.description !== draft.description,
		guests: !sameGuests,
		calendar: original.calendarKey !== draft.calendarKey,
	};
	return { ...changes, any: Object.values(changes).some(Boolean) };
}

// --- Request bodies ----------------------------------------------------------

/** The zone sent with timed writes: the event's own, else the calendar's, else this device's. */
export function pickTimeZone(event: CalEvent | undefined, calendar: CalendarInfo | undefined): string {
	return event?.rawStart.timeZone || calendar?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function timedDate(value: Moment, timeZone: string): RawEventDate {
	// `date: null` matters: it clears the all-day form when a patch switches to timed.
	return { dateTime: value.format(), timeZone, date: null };
}

function allDayDate(date: string, timeZone: string | null | undefined): RawEventDate {
	const value: RawEventDate = { date, dateTime: null };
	if (timeZone) value.timeZone = timeZone;
	return value;
}

function nextDay(date: string): string {
	return parseDate(date).add(1, "days").format(DATE);
}

/** Start and end exactly as the draft says. All-day ends go to Google exclusive. */
function draftTimes(draft: EventDraft, timeZone: string, allDayZone?: string | null): { start: RawEventDate; end: RawEventDate } {
	if (draft.allDay) {
		return { start: allDayDate(draft.startDate, allDayZone), end: allDayDate(nextDay(draft.endDate), allDayZone) };
	}
	return { start: timedDate(draftStart(draft), timeZone), end: timedDate(draftEnd(draft), timeZone) };
}

/** Kept guests keep their original objects (responses, names, flags); new ones are bare. */
function attendeesFor(guests: string[], existing: RawAttendee[]): RawAttendee[] {
	const byEmail = new Map<string, RawAttendee>();
	for (const attendee of existing) {
		if (attendee.email) byEmail.set(normaliseEmail(attendee.email), attendee);
	}
	// Attendees without an email cannot appear in the draft, so they are never dropped.
	const result = existing.filter((a) => !a.email);
	for (const email of guests) result.push(byEmail.get(email) ?? { email });
	return result;
}

function textFields(draft: EventDraft, changes: ChangeSet, attendees: RawAttendee[]): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (changes.title) patch.summary = draft.title;
	if (changes.location) patch.location = draft.location;
	// Only when the text changed: rewriting an untouched HTML description would flatten it.
	if (changes.description) patch.description = draft.description;
	if (changes.guests) patch.attendees = attendeesFor(draft.guests, attendees);
	return patch;
}

/** A patch for one event (or one occurrence) holding only what changed. */
export function buildEventPatch(event: CalEvent, draft: EventDraft, changes: ChangeSet, timeZone: string): Record<string, unknown> {
	const patch = textFields(draft, changes, event.rawAttendees);
	if (changes.time) Object.assign(patch, draftTimes(draft, timeZone, event.rawStart.timeZone));
	return patch;
}
