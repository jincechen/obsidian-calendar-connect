import { moment } from "../src/moment-shim";
import type { CalEvent, CalendarInfo } from "../src/types";

export const ACCOUNT = "alex@example.com";

export function makeCalendar(overrides: Partial<CalendarInfo> = {}): CalendarInfo {
	const id = overrides.id ?? ACCOUNT;
	const accountId = overrides.accountId ?? ACCOUNT;
	return {
		key: `${accountId}::${id}`,
		id,
		name: "Alex",
		color: "#7a86b8",
		primary: true,
		timeZone: "Europe/London",
		accessRole: "owner",
		accountId,
		accountLabel: "Personal",
		...overrides,
	};
}

/** A timed, organiser-owned, non-recurring event, 2026-08-14 09:30–10:00 local. */
export function makeEvent(overrides: Partial<CalEvent> = {}): CalEvent {
	const calendar = makeCalendar();
	return {
		id: "evt123",
		calendarKey: calendar.key,
		calendarId: calendar.id,
		calendarName: calendar.name,
		calendarColor: calendar.color,
		accountId: calendar.accountId,
		accountLabel: calendar.accountLabel,
		title: "Design review",
		start: moment("2026-08-14T09:30"),
		end: moment("2026-08-14T10:00"),
		allDay: false,
		location: "Room 4",
		description: "Agenda: specs",
		link: "https://calendar.google.com/event?eid=abc",
		meetUrl: "https://meet.google.com/xyz-abcd-efg",
		status: "confirmed",
		organizer: ACCOUNT,
		attendees: [],
		recurring: false,
		...overrides,
	};
}
