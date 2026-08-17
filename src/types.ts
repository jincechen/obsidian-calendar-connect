// --- Google's wire shapes ------------------------------------------------
// Only the members this plugin reads. Everything is optional because
// Google omits fields freely; normalisation is where defaults are decided.

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
