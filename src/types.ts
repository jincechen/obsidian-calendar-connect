import type { Moment } from "./moment-shim";

export type ViewMode = "list" | "agenda" | "table";

export type AllDayMode = "include" | "exclude" | "only";

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

// --- Google's wire shapes ------------------------------------------------
// Only the members this plugin reads. Everything is optional because
// Google omits fields freely; normalisation is where defaults are decided.

export interface RawEventDate {
	date?: string;
	dateTime?: string;
	timeZone?: string;
}

export interface RawAttendee {
	email?: string;
	displayName?: string;
	responseStatus?: string;
	self?: boolean;
	organizer?: boolean;
	optional?: boolean;
	resource?: boolean;
}

export interface RawEvent {
	id?: string;
	status?: string;
	htmlLink?: string;
	summary?: string;
	description?: string;
	location?: string;
	hangoutLink?: string;
	start?: RawEventDate;
	end?: RawEventDate;
	recurringEventId?: string;
	recurrence?: string[];
	organizer?: { email?: string; displayName?: string };
	attendees?: RawAttendee[];
	conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

export interface RawCalendarListEntry {
	id?: string;
	summary?: string;
	summaryOverride?: string;
	backgroundColor?: string;
	primary?: boolean;
	timeZone?: string;
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
	/** Plain text. HTML descriptions are flattened. */
	description?: string;
	link?: string;
	meetUrl?: string;
	/** confirmed | tentative | cancelled */
	status?: string;

	organizer?: string;
	attendees: Attendee[];
	/** This account's own response, when it is an attendee. */
	selfResponse?: string;

	recurring: boolean;
}
