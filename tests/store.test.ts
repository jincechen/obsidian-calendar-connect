import { moment } from "../src/moment-shim";
import { parseQuery, type BlockQuery } from "../src/query";
import { DEFAULT_SETTINGS } from "../src/settings";
import { EventStore, compareEvents, finishEvents, keepEvent, selectCalendars } from "../src/store";
import type { CalEvent } from "../src/types";
import { makeCalendar, makeEvent } from "./fixtures";
import { check, later } from "./harness";

const base = parseQuery("", { ...DEFAULT_SETTINGS, hideDeclined: false }).query;
const query = (overrides: Partial<BlockQuery> = {}): BlockQuery => ({ ...base, ...overrides });

// ---- keepEvent ----
const plain = makeEvent();
const allDay = makeEvent({ allDay: true, title: "Holiday" });
check("keeps an ordinary event", keepEvent(plain, query()), true);
check("cancelled always hidden", keepEvent(makeEvent({ status: "cancelled" }), query()), false);
const declined = makeEvent({ selfResponse: "declined" });
check("declined hidden when asked", keepEvent(declined, query({ hideDeclined: true })), false);
check("declined shown otherwise", keepEvent(declined, query({ hideDeclined: false })), true);
check("all-day exclude", keepEvent(allDay, query({ allDay: "exclude" })), false);
check("all-day exclude keeps timed", keepEvent(plain, query({ allDay: "exclude" })), true);
check("all-day only drops timed", keepEvent(plain, query({ allDay: "only" })), false);
check("all-day only keeps all-day", keepEvent(allDay, query({ allDay: "only" })), true);
check("hidden title", keepEvent(makeEvent({ title: "EOD" }), query({ hiddenTitles: [/^eod$/i] })), false);
const sticky = /review/gi;
check(
	"global regex judged alike every time",
	[plain, plain, plain].map((event) => keepEvent(event, query({ hiddenTitles: [sticky] }))),
	[false, false, false]
);

// ---- compareEvents ----
const at = (title: string, start: string, extra: Partial<CalEvent> = {}) =>
	makeEvent({ title, start: moment(start), end: moment(start).add(30, "minutes"), ...extra });
const ordered = [
	at("Late", "2026-08-15T08:00"),
	at("B same time", "2026-08-14T09:00"),
	at("A same time", "2026-08-14T09:00"),
	at("All day", "2026-08-14T00:00", { allDay: true }),
	at("Early", "2026-08-14T07:00"),
]
	.sort(compareEvents)
	.map((event) => event.title);
check("all-day first, then start, then title, day by day", ordered, [
	"All day",
	"Early",
	"A same time",
	"B same time",
	"Late",
]);

const finished = finishEvents(
	[at("Two", "2026-08-14T10:00"), at("Gone", "2026-08-14T08:00", { status: "cancelled" }), at("One", "2026-08-14T09:00")],
	query({ limit: 1 })
);
check("finishEvents filters, sorts and limits", finished.map((event) => event.title), ["One"]);

// ---- selectCalendars ----
const work = makeCalendar({ id: "work@x.com", accountId: "work@x.com", accountLabel: "Work", name: "Work" });
const team = makeCalendar({ id: "team-cal", accountId: "work@x.com", accountLabel: "Work", name: "Team" });
const home = makeCalendar({ id: "me@x.com", accountId: "me@x.com", accountLabel: "Personal", name: "Team" });
const all = [work, team, home];
const keys = (result: { selected: Array<{ key: string }> }) => result.selected.map((c) => c.key);

check("no filters selects everything", keys(selectCalendars(query({ calendars: [] }), all)), all.map((c) => c.key));
check(
	"accounts narrow",
	keys(selectCalendars(query({ calendars: [], accounts: ["work"] }), all)),
	[work.key, team.key]
);
const unknownAccount = selectCalendars(query({ calendars: [], accounts: ["nobody"] }), all);
check("unknown account warns", unknownAccount.warnings, ["No account matched: nobody"]);
check("unknown account selects nothing", unknownAccount.selected.length, 0);
const ambiguous = selectCalendars(query({ calendars: ["team"] }), all);
check("ambiguous name selects both", keys(ambiguous), [team.key, home.key]);
check("ambiguous name warns", ambiguous.warnings.length, 1);
check("account/calendar disambiguates", keys(selectCalendars(query({ calendars: ["personal/team"] }), all)), [home.key]);
check(
	"unknown calendar warns",
	selectCalendars(query({ calendars: ["Nope"] }), all).warnings,
	["No calendar matched: Nope"]
);
check(
	"exclude removes",
	keys(selectCalendars(query({ calendars: [], excludeCalendars: ["work/team"] }), all)),
	[work.key, home.key]
);

// ---- EventStore ----
const from = moment("2026-08-14T00:00");
const to = moment("2026-08-14T23:59");
const calendar = { key: work.key };

later(async () => {
	let now = 1_000_000;
	const store = new EventStore(() => now);
	let calls = 0;
	const fetcher = () => {
		calls++;
		return Promise.resolve([makeEvent()]);
	};

	await store.fetch(calendar, from, to, undefined, fetcher, 60_000);
	await store.fetch(calendar, from, to, undefined, fetcher, 60_000);
	check("TTL hit reuses the response", calls, 1);

	now += 61_000;
	const refreshed = await store.fetch(calendar, from, to, undefined, fetcher, 60_000);
	check("TTL miss fetches again", calls, 2);
	check("fetchedAt is the response time", refreshed.fetchedAt, now);

	await store.fetch(calendar, from, to, "search", fetcher, 60_000);
	check("search is part of the key", calls, 3);

	await store.fetch(calendar, from, to, undefined, fetcher, 0);
	check("maxAge 0 always fetches", calls, 4);
});

later(async () => {
	const store = new EventStore();
	let calls = 0;
	let release: (events: CalEvent[]) => void = () => undefined;
	const fetcher = () => {
		calls++;
		return new Promise<CalEvent[]>((resolve) => {
			release = resolve;
		});
	};
	const first = store.fetch(calendar, from, to, undefined, fetcher, 60_000);
	const second = store.fetch(calendar, from, to, undefined, fetcher, 60_000);
	release([makeEvent()]);
	const [a, b] = await Promise.all([first, second]);
	check("concurrent identical fetches share one call", calls, 1);
	check("both callers get the events", [a.events.length, b.events.length], [1, 1]);
});

later(async () => {
	const store = new EventStore();
	let release: (events: CalEvent[]) => void = () => undefined;
	const slow = () =>
		new Promise<CalEvent[]>((resolve) => {
			release = resolve;
		});
	const pending = store.fetch(calendar, from, to, undefined, slow, 60_000);
	store.invalidateCalendar(work.key);
	release([makeEvent()]);
	await pending;
	check("a response that straddles an invalidation is not cached", store.size, 0);
});

later(async () => {
	const store = new EventStore();
	let calls = 0;
	const fetcher = () => {
		calls++;
		return Promise.resolve([] as CalEvent[]);
	};
	const failing = () => Promise.reject(new Error("boom"));
	let failed = false;
	await store.fetch(calendar, from, to, undefined, failing, 60_000).catch(() => {
		failed = true;
	});
	check("errors propagate", failed, true);
	check("errors are not cached", store.size, 0);

	await store.fetch(calendar, from, to, undefined, fetcher, 60_000);
	await store.fetch(calendar, from, to.clone().add(1, "day"), undefined, fetcher, 60_000);
	await store.fetch({ key: home.key }, from, to, undefined, fetcher, 60_000);
	check("three entries", store.size, 3);
	store.invalidateCalendar(work.key);
	check("invalidateCalendar drops every range of that calendar only", store.size, 1);
	// A calendar key that is a prefix of another must not take the other with it.
	await store.fetch({ key: `${home.key}x` }, from, to, undefined, fetcher, 60_000);
	store.invalidateCalendar(home.key);
	check("prefix match stops at the key boundary", store.size, 1);
	store.invalidateAll();
	check("invalidateAll empties", store.size, 0);
	check("fetcher calls", calls, 4);
});

later(async () => {
	let now = 0;
	const store = new EventStore(() => now, 3);
	const fetcher = () => Promise.resolve([] as CalEvent[]);
	for (let day = 0; day < 5; day++) {
		now += 1000;
		await store.fetch(calendar, from.clone().add(day, "days"), to.clone().add(day, "days"), undefined, fetcher, 60_000);
	}
	check("cap keeps the newest entries", store.size, 3);
	let calls = 0;
	const counting = () => {
		calls++;
		return Promise.resolve([] as CalEvent[]);
	};
	await store.fetch(calendar, from.clone().add(4, "days"), to.clone().add(4, "days"), undefined, counting, 60_000);
	await store.fetch(calendar, from, to, undefined, counting, 60_000);
	check("newest survived, oldest was evicted", calls, 1);

	// Entries older than max(ttl, 10 min) are dropped on the next write.
	const aging = new EventStore(() => now);
	await aging.fetch(calendar, from, to, undefined, fetcher, 1000);
	now += 11 * 60 * 1000;
	await aging.fetch({ key: home.key }, from, to, undefined, fetcher, 1000);
	check("stale entries are pruned", aging.size, 1);
});
