import type { Moment } from "./moment-shim";

export type ViewMode = "list" | "agenda" | "table";

export type AllDayMode = "include" | "exclude" | "only";

/** How events that have already ended are shown. */
export type PastMode = "show" | "dim" | "hide";

/** Whether to tell guests about a change: ask each time, or a fixed answer. */
export type NotifyMode = "ask" | "always" | "never";

/** Fields that can be surfaced in a view and used as table columns. */
export type Field =
	| "date"
	| "time"
	| "duration"
	| "title"
	| "calendar"
	| "account"
	| "location"
	| "description"
	| "attendees"
	| "response"
	| "link";

/** The attendee response values Google uses. */
export type ResponseStatus = "needsAction" | "declined" | "tentative" | "accepted";

// --- Google's wire shapes ------------------------------------------------
// Only the members this plugin reads or writes. Everything is optional because
// Google omits fields freely; normalisation is where defaults are decided.

export interface RawEventDate {
	date?: string | null;
	dateTime?: string | null;
	timeZone?: string | null;
}

export interface RawAttendee {
	id?: string;
	email?: string;
	displayName?: string;
	responseStatus?: string;
	self?: boolean;
	organizer?: boolean;
	optional?: boolean;
	resource?: boolean;
	comment?: string;
	additionalGuests?: number;
}

export interface RawEvent {
	id?: string;
	etag?: string;
	status?: string;
	htmlLink?: string;
	summary?: string;
	description?: string;
	location?: string;
	hangoutLink?: string;
	start?: RawEventDate;
	end?: RawEventDate;
	originalStartTime?: RawEventDate;
	recurringEventId?: string;
	recurrence?: string[];
	organizer?: { email?: string; displayName?: string; self?: boolean };
	attendees?: RawAttendee[];
	attendeesOmitted?: boolean;
	guestsCanModify?: boolean;
	locked?: boolean;
	privateCopy?: boolean;
	/** "default" for ordinary events; birthdays, focus time, OOO, etc. are special. */
	eventType?: string;
	conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

export interface RawCalendarListEntry {
	id?: string;
	summary?: string;
	summaryOverride?: string;
	backgroundColor?: string;
	primary?: boolean;
	timeZone?: string;
	accessRole?: string;
	deleted?: boolean;
}

// --- Normalised shapes ---------------------------------------------------

export interface CalendarInfo {
	/** `accountId::calendarId` — unique even when two accounts subscribe to the same calendar. */
	key: string;
	id: string;
	name: string;
	/** Already validated as a hex colour, or empty when Google's value was not one. */
	color: string;
	primary: boolean;
	timeZone?: string;
	/** freeBusyReader | reader | writer | owner */
	accessRole: string;
	accountId: string;
	accountLabel: string;
}

export interface Attendee {
	email?: string;
	name?: string;
	response?: string;
	self: boolean;
	organizer: boolean;
	optional: boolean;
	resource: boolean;
}

export interface CalEvent {
	/** Google's event id (an instance id for an occurrence of a recurring event). */
	id: string;
	etag?: string;
	calendarKey: string;
	calendarId: string;
	calendarName: string;
	calendarColor: string;
	accountId: string;
	accountLabel: string;

	title: string;
	start: Moment;
	/** Inclusive end. For all-day events Google's exclusive end date is already adjusted. */
	end: Moment;
	allDay: boolean;
	location?: string;
	/** Plain text. HTML descriptions are flattened; see `descriptionIsHtml`. */
	description?: string;
	descriptionIsHtml: boolean;
	link?: string;
	meetUrl?: string;
	/** confirmed | tentative | cancelled */
	status?: string;

	organizer?: string;
	organizerSelf: boolean;
	attendees: Attendee[];
	/** This account's own response, when it is an attendee. */
	selfResponse?: string;

	recurring: boolean;
	recurringEventId?: string;

	guestsCanModify: boolean;
	locked: boolean;
	privateCopy: boolean;
	eventType: string;
	attendeesOmitted: boolean;

	/** Untouched wire values, which patches round-trip. */
	rawStart: RawEventDate;
	rawEnd: RawEventDate;
	/** For an occurrence of a series: its slot in the series pattern, before any one-off move. */
	rawOriginalStart?: RawEventDate;
	rawAttendees: RawAttendee[];
}

/** What the current account may do to one event. */
export interface Editability {
	canEdit: boolean;
	canDelete: boolean;
	canMove: boolean;
	canRsvp: boolean;
	/** Why editing is unavailable, for the read-only banner. */
	reason?: string;
}
