import { moment } from "../src/moment-shim";
import {
	buildEventPatch,
	buildInsertBody,
	buildMasterPatch,
	buildRsvpPatch,
	diffDraft,
	draftFromEvent,
	editabilityOf,
	hasOtherGuests,
	newDraft,
	newEventId,
	pickTimeZone,
	rebaseDraft,
	scopeOptions,
	validateDraft,
	withStart,
	type ChangeSet,
	type EventDraft,
} from "../src/editing";
import type { CalEvent, RawAttendee, RawEvent } from "../src/types";
import { ACCOUNT, makeCalendar, makeEvent } from "./fixtures";
import { check, throws } from "./harness";

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

// --- buildMasterPatch ---------------------------------------------------------------
{
	const instance = makeEvent({
		id: "evt123_20260814T083000Z",
		recurring: true,
		recurringEventId: "evt123",
	});
	const master: RawEvent = {
		id: "evt123",
		etag: '"m1"',
		recurrence: ["RRULE:FREQ=WEEKLY"],
		start: { dateTime: moment("2026-01-05T09:30").format(), timeZone: TZ },
		end: { dateTime: moment("2026-01-05T10:00").format(), timeZone: TZ },
		attendees: [{ email: "bob@example.com", responseStatus: "accepted" }],
	};
	const masterPatch = (edit: (d: EventDraft) => void, m: RawEvent = master, inst: CalEvent = instance, tz = "Asia/Tokyo") => {
		const original = draftFromEvent(inst);
		const draft: EventDraft = { ...original, guests: [...original.guests] };
		edit(draft);
		return buildMasterPatch(m, inst, draft, diffDraft(original, draft), tz);
	};

	check(
		"master: +1h applied on the master's own date",
		masterPatch((d) => {
			d.startTime = "10:30";
			d.endTime = "11:00";
		}),
		{
			start: { dateTime: local("2026-01-05 10:30"), timeZone: TZ, date: null },
			end: { dateTime: local("2026-01-05 11:00"), timeZone: TZ, date: null },
		}
	);
	check(
		"master: duration change keeps the master's start",
		masterPatch((d) => (d.endTime = "10:45")),
		{
			start: { dateTime: local("2026-01-05 09:30"), timeZone: TZ, date: null },
			end: { dateTime: local("2026-01-05 10:45"), timeZone: TZ, date: null },
		}
	);
	check(
		"master: falls back to the given zone when the master has none",
		(masterPatch((d) => (d.endTime = "10:45"), { ...master, start: { dateTime: master.start?.dateTime } }).start as { timeZone: string }).timeZone,
		"Asia/Tokyo"
	);
	// An occurrence already moved from its 09:30 slot to 14:00.
	const moved = makeEvent({
		...instance,
		start: moment("2026-08-14T14:00"),
		end: moment("2026-08-14T14:30"),
		rawOriginalStart: { dateTime: moment("2026-08-14T09:30").format(), timeZone: TZ },
	});
	check(
		"master: a new start on a moved occurrence is measured from its series slot",
		masterPatch(
			(d) => {
				d.startTime = "15:00";
				d.endTime = "15:30";
			},
			master,
			moved
		),
		{
			start: { dateTime: local("2026-01-05 15:00"), timeZone: TZ, date: null },
			end: { dateTime: local("2026-01-05 15:30"), timeZone: TZ, date: null },
		}
	);
	check(
		"master: a length-only edit on a moved occurrence keeps the series start",
		masterPatch((d) => (d.endTime = "14:45"), master, moved),
		{
			start: { dateTime: local("2026-01-05 09:30"), timeZone: TZ, date: null },
			end: { dateTime: local("2026-01-05 10:15"), timeZone: TZ, date: null },
		}
	);
	check("master: title only", masterPatch((d) => (d.title = "Weekly")), { summary: "Weekly" });
	check(
		"master: guests round-trip the master's attendees",
		masterPatch((d) => (d.guests = ["bob@example.com", "eve@example.com"])),
		{ attendees: [{ email: "bob@example.com", responseStatus: "accepted" }, { email: "eve@example.com" }] }
	);
	throws("master: a date change throws", () =>
		masterPatch((d) => {
			d.startDate = "2026-08-15";
			d.endDate = "2026-08-15";
		})
	);
	check("master: all-day toggle uses the master's own date", masterPatch((d) => (d.allDay = true)), {
		start: { date: "2026-01-05", dateTime: null, timeZone: TZ },
		end: { date: "2026-01-06", dateTime: null, timeZone: TZ },
	});

	const allDayMaster: RawEvent = { id: "bday", start: { date: "2025-03-01" }, end: { date: "2025-03-02" } };
	const allDayInstance = allDayEvent("2026-08-14", "2026-08-14", { recurring: true, recurringEventId: "bday" });
	check(
		"master: all-day → timed lands on the master's first day",
		masterPatch((d) => (d.allDay = false), allDayMaster, allDayInstance),
		{
			start: { dateTime: local("2025-03-01 09:00"), timeZone: "Asia/Tokyo", date: null },
			end: { dateTime: local("2025-03-01 10:00"), timeZone: "Asia/Tokyo", date: null },
		}
	);
	check(
		"master: all-day length change",
		masterPatch((d) => (d.endDate = "2026-08-15"), allDayMaster, allDayInstance),
		{ start: { date: "2025-03-01", dateTime: null }, end: { date: "2025-03-03", dateTime: null } }
	);
}

// --- scopeOptions --------------------------------------------------------------------
{
	const base: ChangeSet = {
		title: false,
		time: false,
		dateChanged: false,
		location: false,
		description: false,
		guests: false,
		calendar: false,
		any: true,
	};
	check("scope: title change → both", scopeOptions({ ...base, title: true }), { thisEvent: true, allEvents: true });
	check("scope: time change → both", scopeOptions({ ...base, time: true }), { thisEvent: true, allEvents: true });
	check("scope: date change → this event only", scopeOptions({ ...base, time: true, dateChanged: true }), {
		thisEvent: true,
		allEvents: false,
	});
	check("scope: calendar change → all events only", scopeOptions({ ...base, calendar: true }), { thisEvent: false, allEvents: true });
	check("scope: date + calendar → error", scopeOptions({ ...base, time: true, dateChanged: true, calendar: true }), {
		thisEvent: false,
		allEvents: false,
		error: "Change the date and the calendar in two separate saves.",
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

// --- buildRsvpPatch --------------------------------------------------------------------
{
	const bob = { email: "bob@example.com", organizer: true, responseStatus: "accepted" };
	const me = { email: ACCOUNT, self: true, displayName: "Alex", responseStatus: "needsAction", comment: "hi" };
	const carol = { email: "carol@example.com", responseStatus: "tentative" };
	const guestEvent = makeEvent({ organizerSelf: false, organizer: "bob@example.com", rawAttendees: [bob, me, carol] });
	check("rsvp: full list with only my response changed", buildRsvpPatch(guestEvent, "accepted"), {
		attendees: [bob, { ...me, responseStatus: "accepted" }, carol],
	});
	check("rsvp: original attendee objects are not mutated", me.responseStatus, "needsAction");
	check(
		"rsvp: attendeesOmitted form",
		buildRsvpPatch(makeEvent({ organizerSelf: false, attendeesOmitted: true, rawAttendees: [me] }), "declined"),
		{ attendeesOmitted: true, attendees: [{ email: ACCOUNT, responseStatus: "declined" }] }
	);
	throws("rsvp: throws without a self attendee", () => buildRsvpPatch(makeEvent({ rawAttendees: [bob] }), "accepted"));
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

// --- hasOtherGuests ------------------------------------------------------------------------
{
	const self = { email: ACCOUNT, self: true, organizer: true };
	const room = { email: "room-4@resource.calendar.google.com", resource: true };
	check("hasOtherGuests: nobody", hasOtherGuests([]), false);
	check("hasOtherGuests: only me", hasOtherGuests([self]), false);
	check("hasOtherGuests: me and a room", hasOtherGuests([self, room]), false);
	check("hasOtherGuests: someone else", hasOtherGuests([self, { email: "bob@example.com" }]), true);
	check("hasOtherGuests: an added guest counts", hasOtherGuests([self], ["bob@example.com"]), true);
	check("hasOtherGuests: re-listing existing guests does not", hasOtherGuests([self, room], [ACCOUNT, room.email]), false);
	check("hasOtherGuests: my own address via selfEmail", hasOtherGuests([], [" ALEX@example.com "], ACCOUNT), false);
	check("hasOtherGuests: new event with a guest", hasOtherGuests([], ["bob@example.com"], ACCOUNT), true);
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

// --- rebaseDraft -------------------------------------------------------------------------
{
	const original = { ...draftFromEvent(makeEvent()), guests: ["a@x.com", "b@x.com"] };
	const mine = { ...original, location: "Room 9", guests: ["a@x.com", "c@x.com"] };
	const fresh = { ...original, title: "Renamed elsewhere", guests: ["a@x.com", "b@x.com", "d@x.com"] };
	const rebased = rebaseDraft(original, mine, fresh);
	check("rebase: keeps the remote title", rebased.title, "Renamed elsewhere");
	check("rebase: applies my location", rebased.location, "Room 9");
	check("rebase: merges guests", rebased.guests, ["a@x.com", "d@x.com", "c@x.com"]);
	const again = diffDraft(fresh, rebased);
	check("rebase: only my edits remain to write", [again.title, again.location, again.guests, again.time], [false, true, true, false]);
}
