import { moment } from "../src/moment-shim";
import {
	buildEventPatch,
	buildInsertBody,
	diffDraft,
	draftFromEvent,
	editabilityOf,
	newDraft,
	newEventId,
	pickTimeZone,
	validateDraft,
	withStart,
	type EventDraft,
} from "../src/editing";
import type { CalEvent, RawAttendee } from "../src/types";
import { ACCOUNT, makeCalendar, makeEvent } from "./fixtures";
import { check } from "./harness";

// moment runs in this machine's zone, so expected wall-time strings are built with it too.
const local = (value: string) => moment(value, "YYYY-MM-DD HH:mm", true).format();
const TZ = "Europe/London";

/** Patch for `event` after `edit` is applied to its draft. */
function patchAfter(event: CalEvent, edit: (draft: EventDraft) => void, timeZone = TZ): Record<string, unknown> {
	const original = draftFromEvent(event);
	const draft: EventDraft = { ...original, guests: [...original.guests] };
	edit(draft);
	return buildEventPatch(event, draft, diffDraft(original, draft), timeZone);
}

function allDayEvent(first: string, last: string, overrides: Partial<CalEvent> = {}): CalEvent {
	const exclusive = moment(last, "YYYY-MM-DD", true).add(1, "days").format("YYYY-MM-DD");
	return makeEvent({
		allDay: true,
		start: moment(first, "YYYY-MM-DD", true).startOf("day"),
		end: moment(last, "YYYY-MM-DD", true).endOf("day"),
		rawStart: { date: first },
		rawEnd: { date: exclusive },
		...overrides,
	});
}

// --- Drafts --------------------------------------------------------------------

check("draftFromEvent: timed event", draftFromEvent(makeEvent()), {
	title: "Design review",
	allDay: false,
	startDate: "2026-08-14",
	startTime: "09:30",
	endDate: "2026-08-14",
	endTime: "10:00",
	location: "Room 4",
	description: "Agenda: specs",
	guests: [],
	calendarKey: `${ACCOUNT}::${ACCOUNT}`,
});
{
	const draft = draftFromEvent(allDayEvent("2026-08-14", "2026-08-16"));
	check("draftFromEvent: all-day end is the inclusive last day", [draft.allDay, draft.startDate, draft.endDate], [true, "2026-08-14", "2026-08-16"]);
	check("draftFromEvent: all-day carries default times", [draft.startTime, draft.endTime], ["09:00", "10:00"]);
}
check(
	"draftFromEvent: guests lowercased, trimmed and de-duplicated",
	draftFromEvent(makeEvent({ rawAttendees: [{ email: " Bob@Example.com" }, { email: "bob@example.com" }, { displayName: "No email" }] })).guests,
	["bob@example.com"]
);
check("newDraft: timed, default length", newDraft(moment("2026-08-14T23:45"), 30, "k"), {
	title: "",
	allDay: false,
	startDate: "2026-08-14",
	startTime: "23:45",
	endDate: "2026-08-15",
	endTime: "00:15",
	location: "",
	description: "",
	guests: [],
	calendarKey: "k",
});

// --- withStart -------------------------------------------------------------------
{
	const draft = draftFromEvent(makeEvent());
	const moved = withStart(draft, "2026-08-14", "11:00");
	check("withStart keeps a timed duration", [moved.startTime, moved.endDate, moved.endTime], ["11:00", "2026-08-14", "11:30"]);
	const late = withStart(draft, "2026-08-14", "23:45");
	check("withStart can push the end past midnight", [late.endDate, late.endTime], ["2026-08-15", "00:15"]);
	const broken = withStart(draft, "", "11:00");
	check("withStart leaves the end alone when the start is invalid", [broken.endDate, broken.endTime], ["2026-08-14", "10:00"]);
	const allDay = withStart(draftFromEvent(allDayEvent("2026-08-14", "2026-08-16")), "2026-08-20", "09:00");
	check("withStart keeps an all-day length in days", [allDay.startDate, allDay.endDate], ["2026-08-20", "2026-08-22"]);
}

// --- validateDraft ---------------------------------------------------------------
{
	const base = draftFromEvent(makeEvent());
	const v = (edit: Partial<EventDraft>) => validateDraft({ ...base, ...edit });
	check("validateDraft: valid timed draft", v({}), {});
	check("validateDraft: empty title is allowed", v({ title: "" }), {});
	check("validateDraft: end before start", v({ endTime: "09:00" }), { endTime: "The event can't end before it starts" });
	check("validateDraft: zero-length events are allowed", v({ endTime: "09:30" }), {});
	check("validateDraft: end date before start date", v({ endDate: "2026-08-13", endTime: "11:00" }), { endDate: "The end can't be before the start" });
	check("validateDraft: end on a later day is fine", v({ endDate: "2026-08-15", endTime: "08:00" }), {});
	check("validateDraft: impossible date", Object.keys(v({ startDate: "2026-02-30" })), ["startDate"]);
	check("validateDraft: empty date", Object.keys(v({ endDate: "" })), ["endDate"]);
	check("validateDraft: bad time", Object.keys(v({ startTime: "25:00" })), ["startTime"]);
	check("validateDraft: loose time format rejected", Object.keys(v({ endTime: "9:5" })), ["endTime"]);
	check("validateDraft: title over 1024 chars", Object.keys(v({ title: "x".repeat(1025) })), ["title"]);
	check("validateDraft: title of 1024 chars", v({ title: "x".repeat(1024) }), {});
	check("validateDraft: invalid guest", v({ guests: ["bob@example.com", "nope"] }), { guests: "Not a valid email: nope" });
	check("validateDraft: all-day same day", v({ allDay: true, endDate: "2026-08-14", endTime: "00:00" }), {});
	check("validateDraft: all-day ignores bogus times", v({ allDay: true, startTime: "", endTime: "xx" }), {});
	check("validateDraft: all-day end before start", v({ allDay: true, endDate: "2026-08-13" }), { endDate: "The end can't be before the start" });
}

// --- diffDraft -------------------------------------------------------------------
{
	const original = draftFromEvent(makeEvent());
	const none = diffDraft(original, { ...original, guests: [...original.guests] });
	check("diffDraft: no change", none.any, false);
	const reordered = diffDraft(
		{ ...original, guests: ["a@x.com", "b@x.com"] },
		{ ...original, guests: ["b@x.com", "a@x.com"] }
	);
	check("diffDraft: guest order does not count", reordered.guests, false);
	const timeOnly = diffDraft(original, { ...original, endTime: "10:30" });
	check("diffDraft: end time → time, not date", [timeOnly.time, timeOnly.dateChanged, timeOnly.any], [true, false, true]);
	const dateOnly = diffDraft(original, { ...original, startDate: "2026-08-15", endDate: "2026-08-15" });
	check("diffDraft: start date → dateChanged", [dateOnly.time, dateOnly.dateChanged], [true, true]);
	const allDayOriginal = draftFromEvent(allDayEvent("2026-08-14", "2026-08-14"));
	check("diffDraft: hidden times of an all-day draft are ignored", diffDraft(allDayOriginal, { ...allDayOriginal, startTime: "11:00" }).any, false);
	check("diffDraft: calendar", diffDraft(original, { ...original, calendarKey: "other" }).calendar, true);
}

// --- buildEventPatch -------------------------------------------------------------
check("patch: empty diff → {}", patchAfter(makeEvent(), () => undefined), {});
check("patch: title only", patchAfter(makeEvent(), (d) => (d.title = "Retro")), { summary: "Retro" });
check("patch: location cleared", patchAfter(makeEvent(), (d) => (d.location = "")), { location: "" });
check("patch: description changed", patchAfter(makeEvent(), (d) => (d.description = "New")), { description: "New" });
check(
	"patch: unchanged HTML description is left out",
	patchAfter(makeEvent({ description: "Hello world", descriptionIsHtml: true }), (d) => (d.title = "Retro")),
	{ summary: "Retro" }
);
check(
	"patch: edited HTML description is sent as plain text",
	patchAfter(makeEvent({ description: "Hello world", descriptionIsHtml: true }), (d) => (d.description = "Hello")),
	{ description: "Hello" }
);
check(
	"patch: timed time change sends start and end with date null",
	patchAfter(makeEvent(), (d) => {
		d.startTime = "11:00";
		d.endTime = "12:15";
	}),
	{
		start: { dateTime: local("2026-08-14 11:00"), timeZone: TZ, date: null },
		end: { dateTime: local("2026-08-14 12:15"), timeZone: TZ, date: null },
	}
);
{
	const patch = patchAfter(makeEvent(), (d) => (d.allDay = true));
	check("patch: timed → all-day", patch, {
		start: { date: "2026-08-14", dateTime: null, timeZone: TZ },
		end: { date: "2026-08-15", dateTime: null, timeZone: TZ },
	});
	check("patch: timed → all-day keeps dateTime:null through JSON", JSON.stringify(patch).includes('"dateTime":null'), true);
}
check(
	"patch: multi-day all-day end is exclusive",
	patchAfter(allDayEvent("2026-08-14", "2026-08-14"), (d) => (d.endDate = "2026-08-16")),
	{ start: { date: "2026-08-14", dateTime: null }, end: { date: "2026-08-17", dateTime: null } }
);
{
	const patch = patchAfter(allDayEvent("2026-08-14", "2026-08-14"), (d) => (d.allDay = false), "America/New_York");
	check("patch: all-day → timed sets the time zone and date null", patch, {
		start: { dateTime: local("2026-08-14 09:00"), timeZone: "America/New_York", date: null },
		end: { dateTime: local("2026-08-14 10:00"), timeZone: "America/New_York", date: null },
	});
	check("patch: all-day → timed keeps date:null through JSON", JSON.stringify(patch).includes('"date":null'), true);
}
{
	const attendees: RawAttendee[] = [
		{ email: ACCOUNT, self: true, organizer: true, responseStatus: "accepted" },
		{ email: "Bob@Example.com", displayName: "Bob", responseStatus: "tentative", optional: true },
		{ email: "carol@example.com", responseStatus: "declined" },
		{ id: "no-email-attendee", responseStatus: "accepted" },
	];
	const event = makeEvent({ rawAttendees: attendees });
	const patch = patchAfter(event, (d) => {
		d.guests = d.guests.filter((g) => g !== "carol@example.com");
		d.guests.push("dave@example.com");
	});
	check("patch: guest add/remove keeps responses of kept guests", patch, {
		attendees: [
			{ id: "no-email-attendee", responseStatus: "accepted" },
			{ email: ACCOUNT, self: true, organizer: true, responseStatus: "accepted" },
			{ email: "Bob@Example.com", displayName: "Bob", responseStatus: "tentative", optional: true },
			{ email: "dave@example.com" },
		],
	});
}

// --- buildInsertBody -----------------------------------------------------------------
{
	const draft = newDraft(moment("2026-08-14T14:00"), 45, "k");
	check("insert: timed", buildInsertBody({ ...draft, title: "Call" }, TZ, "abc12345"), {
		id: "abc12345",
		summary: "Call",
		start: { dateTime: local("2026-08-14 14:00"), timeZone: TZ },
		end: { dateTime: local("2026-08-14 14:45"), timeZone: TZ },
	});
	check(
		"insert: all-day with location, description and guests",
		buildInsertBody(
			{ ...draft, title: "Trip", allDay: true, endDate: "2026-08-16", location: "Rome", description: "Bring passport", guests: ["bob@example.com"] },
			TZ,
			"id2"
		),
		{
			id: "id2",
			summary: "Trip",
			location: "Rome",
			description: "Bring passport",
			start: { date: "2026-08-14" },
			end: { date: "2026-08-17" },
			attendees: [{ email: "bob@example.com" }],
		}
	);
}

// --- editabilityOf -----------------------------------------------------------------------
{
	const owner = makeCalendar();
	const me = { email: ACCOUNT, self: true, responseStatus: "needsAction" };
	const bob = { email: "bob@example.com", organizer: true, responseStatus: "accepted" };
	const asGuest = (overrides: Partial<CalEvent> = {}) =>
		makeEvent({ organizerSelf: false, organizer: "bob@example.com", rawAttendees: [bob, me], ...overrides });
	const flags = (e: ReturnType<typeof editabilityOf>) => [e.canEdit, e.canDelete, e.canMove, e.canRsvp];

	const noScope = editabilityOf(makeEvent(), owner, false);
	check("editability: no write scope", [flags(noScope), noScope.reason], [
		[false, false, false, false],
		"Read-only — reconnect this account to enable editing",
	]);
	const reader = editabilityOf(asGuest(), makeCalendar({ accessRole: "reader" }), true);
	check("editability: reader role", [flags(reader), reader.reason], [[false, false, false, false], "You can only view Alex"]);
	check("editability: freeBusyReader role", flags(editabilityOf(makeEvent(), makeCalendar({ accessRole: "freeBusyReader" }), true)), [
		false,
		false,
		false,
		false,
	]);
	check("editability: unknown calendar", flags(editabilityOf(makeEvent(), undefined, true)), [false, false, false, false]);
	check("editability: writer role, organizer", flags(editabilityOf(makeEvent(), makeCalendar({ accessRole: "writer" }), true)), [
		true,
		true,
		true,
		false,
	]);

	const organizer = editabilityOf(makeEvent(), owner, true);
	check("editability: organizer", [flags(organizer), organizer.reason], [[true, true, true, false], undefined]);
	const locked = editabilityOf(asGuest({ locked: true }), owner, true);
	check("editability: locked → RSVP only", [flags(locked), typeof locked.reason], [[false, false, false, true], "string"]);
	check("editability: locked organizer event", flags(editabilityOf(makeEvent({ locked: true }), owner, true)), [false, false, false, false]);
	check("editability: private copy → RSVP only", flags(editabilityOf(asGuest({ privateCopy: true }), owner, true)), [
		false,
		false,
		false,
		true,
	]);
	const birthday = editabilityOf(makeEvent({ eventType: "birthday" }), owner, true);
	check("editability: birthday", [flags(birthday), birthday.reason?.includes("birthday")], [[false, false, false, false], true]);
	const modifier = editabilityOf(asGuest({ guestsCanModify: true }), owner, true);
	check("editability: guest with guestsCanModify", [flags(modifier), modifier.reason], [[true, false, false, true], undefined]);
	const guest = editabilityOf(asGuest(), owner, true);
	check("editability: plain guest", [flags(guest), guest.reason], [
		[false, false, false, true],
		"Only the organizer (bob@example.com) can change this event",
	]);
	check("editability: not invited, not organizer", flags(editabilityOf(makeEvent({ organizerSelf: false }), owner, true)), [
		false,
		false,
		false,
		false,
	]);
}

// --- newEventId --------------------------------------------------------------------------
{
	const ids = Array.from({ length: 1000 }, () => newEventId());
	check("newEventId: 26 chars", ids.every((id) => id.length === 26), true);
	check("newEventId: base32hex charset", ids.every((id) => /^[0-9a-v]+$/.test(id)), true);
	check("newEventId: 1000 unique", new Set(ids).size, 1000);
	check("newEventId: rand 0", newEventId(() => 0), "0".repeat(26));
	check("newEventId: rand just below 1", newEventId(() => 0.999999999), "v".repeat(26));
}

// --- pickTimeZone ------------------------------------------------------------------------
check("pickTimeZone: event's own zone", pickTimeZone(makeEvent(), makeCalendar({ timeZone: "Asia/Tokyo" })), TZ);
check(
	"pickTimeZone: calendar zone when the event has none",
	pickTimeZone(makeEvent({ rawStart: { date: "2026-08-14" } }), makeCalendar({ timeZone: "Asia/Tokyo" })),
	"Asia/Tokyo"
);
check(
	"pickTimeZone: device zone last",
	pickTimeZone(undefined, makeCalendar({ timeZone: undefined })),
	Intl.DateTimeFormat().resolvedOptions().timeZone
);
