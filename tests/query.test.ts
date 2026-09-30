import {
	compileTitlePattern,
	compileTitlePatterns,
	isValidPeriod,
	parseQuery,
	resolveAccounts,
	resolveCalendars,
	QueryError,
} from "../src/query";
import { moment } from "../src/moment-shim";
import { DEFAULT_SETTINGS } from "../src/settings";
import { check, throws as throwsAny } from "./harness";

const throws = (name: string, fn: () => unknown) => throwsAny(name, fn, QueryError);
const today = moment().startOf("day");
const fmt = (m: ReturnType<typeof moment> | null) => (m ? m.format("YYYY-MM-DD HH:mm:ss") : null);

// ---- query defaults ----
const base = { ...DEFAULT_SETTINGS };

const plain = parseQuery("", base);
check("default view is list", plain.query.view, "list");
check("default list fields", plain.query.fields, ["time", "title", "location", "link"]);
check("default range starts today", fmt(plain.query.from), today.format("YYYY-MM-DD 00:00:00"));
check("default period 1d is just today", fmt(plain.query.to), today.format("YYYY-MM-DD 23:59:59"));
check("no warnings", plain.warnings, []);
check("controls default on", plain.query.controls, true);
check("refresh defaults to the setting", plain.query.refresh, 0);
check("all-day included", plain.query.allDay, "include");
check("declined hidden by setting", plain.query.hideDeclined, true);
check("default empty message", plain.query.emptyMessage, "No events in this period.");
check(
	"formats come from settings",
	[plain.query.dateHeadingFormat, plain.query.tableDateFormat, plain.query.descriptionLength],
	[base.dateHeadingFormat, base.tableDateFormat, base.descriptionLength]
);
check("setting view honoured", parseQuery("", { ...base, defaultView: "agenda" }).query.view, "agenda");
check("setting refresh honoured", parseQuery("", { ...base, autoRefresh: 300 }).query.refresh, 300);

// ---- views and fields ----
check("agenda default fields", parseQuery("view: agenda", base).query.fields, ["time", "title", "location", "link"]);
const table = parseQuery("view: table", base);
check("table view", table.query.view, "table");
check("table default fields", table.query.fields, ["date", "time", "title", "calendar", "location"]);
check(
	"explicit table fields",
	parseQuery("view: table\nfields: date, time, title, calendar", base).query.fields,
	["date", "time", "title", "calendar"]
);
throws("table needs a field", () => parseQuery("view: table\nhide: date, time, title, calendar, location", base));

const ranged = parseQuery("view: list\nperiod: 1m\nlimit: 5", base);
check("period 1m", fmt(ranged.query.to), today.clone().add(1, "month").subtract(1, "day").format("YYYY-MM-DD 23:59:59"));
check("period 7d is seven days", fmt(parseQuery("period: 7d", base).query.to), today.clone().add(6, "days").format("YYYY-MM-DD 23:59:59"));
check("period eom", fmt(parseQuery("period: eom", base).query.to), today.clone().endOf("month").format("YYYY-MM-DD 23:59:59"));
check("to wins over period", fmt(parseQuery("to: tomorrow\nperiod: 1m", base).query.to), today.clone().add(1, "day").format("YYYY-MM-DD 23:59:59"));
check("period from setting", fmt(parseQuery("", { ...base, defaultPeriod: "2w" }).query.to), today.clone().add(13, "days").format("YYYY-MM-DD 23:59:59"));
throws("bad period", () => parseQuery("period: soonish", base));
check("limit", ranged.query.limit, 5);

const fields = parseQuery("show:\n  - attendees\n  - meet\nhide: location", base);
check("show adds, alias meet -> link, hide removes", fields.query.fields, ["time", "title", "link", "attendees"]);
check(
	"field aliases",
	parseQuery("fields: url, guests, people, rsvp, where, cal, notes, desc, length", base).query.fields,
	["link", "attendees", "response", "location", "calendar", "description", "duration"]
);
check("account field allowed", parseQuery("show: account", base).warnings, []);

// ---- filters ----
const filters = parseQuery(
	["calendars: Work, Personal", "exclude: Birthdays", "all-day: only", "declined: show", "search: review"].join("\n"),
	base
);
check("calendars list", filters.query.calendars, ["Work", "Personal"]);
check("exclude list", filters.query.excludeCalendars, ["Birthdays"]);
check("all-day only", filters.query.allDay, "only");
check("declined: show", filters.query.hideDeclined, false);
check("search passthrough", filters.query.search, "review");
check("filters raise no warnings", filters.warnings, []);
check("calendar alias", parseQuery("calendar: Work", base).query.calendars, ["Work"]);
check("calendars default to the setting", parseQuery("", { ...base, defaultCalendars: ["a::b"] }).query.calendars, ["a::b"]);
check("declined: hide", parseQuery("declined: hide", { ...base, hideDeclined: false }).query.hideDeclined, true);
check("declined: true shows them", parseQuery("declined: true", base).query.hideDeclined, false);
check("declined: false hides them", parseQuery("declined: false", { ...base, hideDeclined: false }).query.hideDeclined, true);

// ---- key normalisation ----
check("allDay camelCase", parseQuery("allDay: exclude", base).query.allDay, "exclude");
check("all_day snake case", parseQuery("all_day: exclude", base).query.allDay, "exclude");
check("ALL-DAY upper case", parseQuery("ALL-DAY: only", base).query.allDay, "only");
check("hideTitles camelCase", parseQuery("hideTitles: EOD", base).query.hiddenTitles.length, 1);
check("time_format snake case", parseQuery("time_format: 12h", base).query.use24HourTime, false);
check("normalised keys do not warn", parseQuery("allDay: exclude\nhide_titles: EOD", base).warnings, []);

// ---- options ----
check("controls: false", parseQuery("controls: false", base).query.controls, false);
check("time-format 24h", parseQuery("time-format: 24h", { ...base, use24HourTime: false }).query.use24HourTime, true);
check("time-format 12h", parseQuery("time-format: 12h", base).query.use24HourTime, false);
const badTime = parseQuery("time-format: hours", base);
check("bad time-format warns", badTime.warnings, ['`time-format` expects 24h or 12h — got "hours"']);
check("bad time-format keeps the setting", badTime.query.use24HourTime, base.use24HourTime);
check("empty message", parseQuery("empty: Nothing today", base).query.emptyMessage, "Nothing today");
check("empty-message alias", parseQuery("empty-message: Free!", base).query.emptyMessage, "Free!");

// ---- refresh ----
check("refresh 5m -> 300s", parseQuery("refresh: 5m", base).query.refresh, 300);
check("refresh 90", parseQuery("refresh: 90", base).query.refresh, 90);
check("refresh clamp", parseQuery("refresh: 10", base).query.refresh, 60);
check("refresh 30s clamps", parseQuery("refresh: 30s", base).query.refresh, 60);
check("clamp warning", parseQuery("refresh: 10", base).warnings, ["`refresh` is clamped to a 60 second minimum"]);
check("refresh 0 disables", parseQuery("refresh: 0", { ...base, autoRefresh: 300 }).query.refresh, 0);
check("refresh 0 does not warn", parseQuery("refresh: 0", base).warnings, []);
throws("bad refresh", () => parseQuery("refresh: often", base));

// ---- unknown keys and fields ----
check("unknown key warns", parseQuery("perod: 7d", base).warnings, ["Unknown option `perod`"]);
check("unknown field warns", parseQuery("show: sparkles", base).warnings, ['`show` — unknown field "sparkles"']);
check("unknown field is dropped", parseQuery("fields: title, sparkles", base).query.fields, ["title"]);

// ---- errors ----
throws("bad view", () => parseQuery("view: kanban", base));
throws("bad date", () => parseQuery("from: whenever", base));
throws("inverted range", () => parseQuery("from: today\nto: yesterday", base));
throws("bad limit", () => parseQuery("limit: 0", base));
throws("bad boolean", () => parseQuery("declined: maybe", base));
throws("bad all-day", () => parseQuery("all-day: sometimes", base));
throws("list block", () => parseQuery("- one\n- two", base));
throws("broken yaml", () => parseQuery("view: [list", base));

// ---- calendar and account resolution ----
const PERSONAL = "alex@example.com";
const WORK = "user@work.example";

function cal(accountId: string, accountLabel: string, id: string, name: string) {
	return { key: `${accountId}::${id}`, id, name, accountId, accountLabel };
}

const available = [
	cal(PERSONAL, "Personal", PERSONAL, "Alex Rivera"),
	cal(PERSONAL, "Personal", "shared123@group.calendar.google.com", "Household"),
	cal(PERSONAL, "Personal", "en.uk#holiday@group.v.calendar.google.com", "Holidays in United Kingdom"),
	cal(WORK, "Work", WORK, "Alex Rivera"),
	cal(WORK, "Work", "team456@group.calendar.google.com", "Clinic rota"),
];

check("match by substring", resolveCalendars(["rota"], available).matched, [`${WORK}::team456@group.calendar.google.com`]);
check("match by id", resolveCalendars(["shared123@group.calendar.google.com"], available).matched, [
	`${PERSONAL}::shared123@group.calendar.google.com`,
]);
check("match by full key", resolveCalendars([`${WORK}::${WORK}`], available).matched, [`${WORK}::${WORK}`]);
check("unmatched reported", resolveCalendars(["nope"], available).unmatched, ["nope"]);
check("dedupes overlaps", resolveCalendars(["rota", "Clinic rota"], available).matched.length, 1);

// A bare name present in both accounts should hit both, and say so.
const bothAccounts = resolveCalendars(["Alex Rivera"], available);
check("bare name spans accounts", bothAccounts.matched.length, 2);
check("ambiguity is flagged", bothAccounts.ambiguous, ["Alex Rivera"]);

// `account/calendar` narrows it to one.
const scoped = resolveCalendars(["work/Alex Rivera"], available);
check("account/calendar narrows", scoped.matched, [`${WORK}::${WORK}`]);
check("scoped is unambiguous", scoped.ambiguous, []);
check("scope by address", resolveCalendars([`${PERSONAL}/Alex Rivera`], available).matched, [`${PERSONAL}::${PERSONAL}`]);

// A slash that is not an account prefix must not silently drop the calendar.
const slashy = [...available, cal(WORK, "Work", "odd@group.calendar.google.com", "On-call / Rota")];
check("non-prefix slash still matches", resolveCalendars(["On-call / Rota"], slashy).matched, [
	`${WORK}::odd@group.calendar.google.com`,
]);

check("account by label", resolveAccounts(["work"], available).matched, [WORK]);
check("account by address", resolveAccounts([PERSONAL], available).matched, [PERSONAL]);
check("account unmatched", resolveAccounts(["nope"], available).unmatched, ["nope"]);
check("accounts option parsed", parseQuery("accounts: work, personal", base).query.accounts, ["work", "personal"]);
check("account alias", parseQuery("account: work", base).query.accounts, ["work"]);

// ---- settings validation ----
check("period accepts a duration", isValidPeriod("7d"), true);
check("period accepts a date keyword", isValidPeriod("eom"), true);
check("period accepts an offset", isValidPeriod("+2w"), true);
check("period rejects a typo", isValidPeriod("7dd"), false);
check("period rejects prose", isValidPeriod("a fortnight"), false);
check("period rejects empty", isValidPeriod("  "), false);

// 0 must hide the description, not show all of it.
check(
	"descriptionLength 0 carries through",
	parseQuery("show: description", { ...base, descriptionLength: 0 }).query.descriptionLength,
	0
);

// ---- hiding events by title pattern ----
const hides = (pattern: string, title: string) => compileTitlePattern(pattern)?.test(title) ?? null;

// A bare word is an exact match, not a substring.
check("bare pattern matches exactly", hides("EOD", "EOD"), true);
check("bare pattern is case-insensitive", hides("eod", "EOD"), true);
check("bare pattern does not match a substring", hides("EOD", "Prep for EOD"), false);
check("bare pattern does not match a prefix", hides("EOD", "EOD review"), false);
check("multi-word exact", hides("Start of Day", "Start of Day"), true);

// Globs.
check("trailing star is a prefix", hides("Start of *", "Start of Day"), true);
check("trailing star needs the prefix", hides("Start of *", "End of Day"), false);
check("surrounding stars match anywhere", hides("*EOD*", "Prep for EOD tomorrow"), true);
check("surrounding stars still match exact", hides("*EOD*", "EOD"), true);
check("leading star is a suffix", hides("*Day", "Start of Day"), true);
check("question mark matches one char", hides("Day ?", "Day 1"), true);
check("question mark is not a run", hides("Day ?", "Day 12"), false);

// Regex form.
check("regex form", hides("/^(EOD|SOD)$/", "SOD"), true);
check("regex is case-insensitive by default", hides("/eod/", "My EOD note"), true);
check("regex honours explicit flags", hides("/^eod$/", "EOD"), true);
check("invalid regex compiles to null", compileTitlePattern("/[unclosed/"), null);
check("blank pattern is ignored", compileTitlePattern("   "), null);

// A `g` flag would make .test() stateful across events.
const global = compileTitlePattern("/EOD/g");
check("g flag stripped", global?.flags.includes("g"), false);
check("so repeated tests agree", [global?.test("EOD"), global?.test("EOD")], [true, true]);

// Regex metacharacters in a glob are literal.
check("dots are literal in globs", hides("a.b", "axb"), false);
check("dots match themselves", hides("a.b", "a.b"), true);
check("parens are literal", hides("Standup (daily)", "Standup (daily)"), true);
check("plus is literal", hides("C++", "C++"), true);

const invalid: string[] = [];
check(
	"compiles a list and reports only real failures",
	compileTitlePatterns(["EOD", "  ", "/[bad/", "Start of *"], (p) => invalid.push(p)).length,
	2
);
check("invalid reported", invalid, ["/[bad/"]);

// Settings list and block list combine.
const hidden = { ...base, hiddenTitles: ["EOD"] };
check("settings patterns compile", parseQuery("", hidden).query.hiddenTitles.length, 1);
check("block adds to settings", parseQuery("hide-titles: Start of *, Lunch", hidden).query.hiddenTitles.length, 3);
check("block alone", parseQuery("hide-titles: EOD", base).query.hiddenTitles.length, 1);
check("yaml list form", parseQuery("hide-titles:\n  - EOD\n  - Lunch", base).query.hiddenTitles.length, 2);
check("exclude-titles alias", parseQuery("exclude-titles: EOD", base).query.hiddenTitles.length, 1);
check("bad pattern warns", parseQuery("hide-titles: /[bad/", base).warnings, ['Invalid hide pattern "/[bad/"']);
check("hide-titles is a known option", parseQuery("hide-titles: EOD", base).warnings, []);

// ---- prototype keys never match a lookup table ----
check(
	"`constructor` is an unknown field, not Object",
	parseQuery("fields: title, constructor", base).warnings,
	['`fields` — unknown field "constructor"']
);
check("`toString` is an unknown option", parseQuery("toString: x", base).warnings, ["Unknown option `toString`"]);
