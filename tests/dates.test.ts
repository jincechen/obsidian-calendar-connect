import { moment } from "../src/moment-shim";
import {
	bucketByDay,
	formatDuration,
	parseDuration,
	resolveDate,
	timeLabel,
	MAX_REPEAT_DAYS,
} from "../src/dates";
import { makeEvent } from "./fixtures";
import { check } from "./harness";

const today = moment().startOf("day");
const fmt = (m: ReturnType<typeof moment> | null) => (m ? m.format("YYYY-MM-DD HH:mm:ss") : null);

check("today@start", fmt(resolveDate("today", "start")), today.format("YYYY-MM-DD 00:00:00"));
check("today@end", fmt(resolveDate("today", "end")), today.format("YYYY-MM-DD 23:59:59"));
check("tomorrow@start", fmt(resolveDate("tomorrow", "start")), today.clone().add(1, "day").format("YYYY-MM-DD 00:00:00"));
check("bare offset +3d", fmt(resolveDate("+3d", "start")), today.clone().add(3, "days").format("YYYY-MM-DD 00:00:00"));
check("today+2w@end", fmt(resolveDate("today+2w", "end")), today.clone().add(2, "weeks").format("YYYY-MM-DD 23:59:59"));
check("sow-1w", fmt(resolveDate("sow-1w", "start")), today.clone().startOf("week").subtract(1, "week").format("YYYY-MM-DD 00:00:00"));
check("eom is precise", fmt(resolveDate("eom", "start")), today.clone().endOf("month").format("YYYY-MM-DD 23:59:59"));
check("iso date@end", fmt(resolveDate("2026-08-14", "end")), "2026-08-14 23:59:59");
check("iso datetime keeps time", fmt(resolveDate("2026-08-14T09:30", "end")), "2026-08-14 09:30:00");
check("hour offset stays precise", fmt(resolveDate("now+2h", "end"))?.slice(0, 10), moment().add(2, "hours").format("YYYY-MM-DD"));
check("month vs minute: 1m", parseDuration("1m"), { value: 1, unit: "months" });
check("minutes need min", parseDuration("90min"), { value: 90, unit: "minutes" });
check("2 weeks", parseDuration("2 weeks"), { value: 2, unit: "weeks" });
check("garbage duration", parseDuration("soon"), null);
check("garbage date", resolveDate("next tuesday-ish", "start"), null);

const start = moment("2026-08-14T09:30");
check("duration 1h30", formatDuration(start, start.clone().add(90, "minutes"), false), "1h 30m");
check("duration 45m", formatDuration(start, start.clone().add(45, "minutes"), false), "45m");
check("duration all-day", formatDuration(start.clone().startOf("day"), start.clone().endOf("day"), true), "all day");
check("time label", timeLabel(makeEvent(), true), "09:30–10:00");
check("time label 12h", timeLabel(makeEvent(), false), "9:30am–10:00am");

const at = (text: string) => moment(text);

const allDay = makeEvent({
	allDay: true,
	start: at("2026-08-14T00:00"),
	end: at("2026-08-14T00:00").endOf("day"),
});

// ---- bucketByDay ----
type Buckets = ReturnType<typeof bucketByDay>;
const summary = (buckets: Buckets) =>
	buckets.map((bucket) => ({
		day: bucket.day.format("YYYY-MM-DD"),
		items: bucket.items.map((item) =>
			item.part ? `${item.event.title} ${item.part.index}/${item.part.count}` : item.event.title
		),
	}));
const day = (text: string) => moment(text).startOf("day");

const holiday = makeEvent({
	id: "holiday",
	title: "Holiday",
	allDay: true,
	start: at("2026-08-14T00:00"),
	end: at("2026-08-16T00:00").endOf("day"),
});
check("3-day all-day event repeats with parts", summary(bucketByDay([holiday], day("2026-08-13"), day("2026-08-20").endOf("day"))), [
	{ day: "2026-08-14", items: ["Holiday 1/3"] },
	{ day: "2026-08-15", items: ["Holiday 2/3"] },
	{ day: "2026-08-16", items: ["Holiday 3/3"] },
]);
check(
	"parts are clamped to the range but keep their numbering",
	summary(bucketByDay([holiday], day("2026-08-15"), day("2026-08-15").endOf("day"))),
	[{ day: "2026-08-15", items: ["Holiday 2/3"] }]
);
check(
	"single-day all-day has no part",
	bucketByDay([allDay], day("2026-08-14"), day("2026-08-14").endOf("day"))[0].items[0].part,
	undefined
);

const overnight = makeEvent({
	id: "overnight",
	title: "Night shift",
	start: at("2026-08-14T22:00"),
	end: at("2026-08-15T06:00"),
});
check(
	"timed event crossing midnight appears on both days",
	summary(bucketByDay([overnight], day("2026-08-14"), day("2026-08-15").endOf("day"))),
	[
		{ day: "2026-08-14", items: ["Night shift 1/2"] },
		{ day: "2026-08-15", items: ["Night shift 2/2"] },
	]
);
const toMidnight = makeEvent({ title: "Late", start: at("2026-08-14T22:00"), end: at("2026-08-15T00:00") });
check(
	"ending exactly at midnight stays on one day",
	summary(bucketByDay([toMidnight], day("2026-08-14"), day("2026-08-15").endOf("day"))),
	[{ day: "2026-08-14", items: ["Late"] }]
);

const standup = makeEvent({ id: "a", title: "Standup", start: at("2026-08-14T09:00"), end: at("2026-08-14T09:15") });
const breakfast = makeEvent({ id: "b", title: "Breakfast", start: at("2026-08-14T08:00"), end: at("2026-08-14T08:30") });
const alarm = makeEvent({ id: "c", title: "Alarm", start: at("2026-08-14T08:00"), end: at("2026-08-14T08:05") });
const review = makeEvent({ id: "d", title: "Review", start: at("2026-08-16T11:00"), end: at("2026-08-16T12:00") });
const birthday = makeEvent({
	id: "e",
	title: "Birthday",
	allDay: true,
	start: at("2026-08-14T00:00"),
	end: at("2026-08-14T00:00").endOf("day"),
});
check(
	"ordering: all-day first, then by start, then title; empty days omitted",
	summary(
		bucketByDay([review, standup, breakfast, overnight, birthday, alarm], day("2026-08-14"), day("2026-08-16").endOf("day"))
	),
	[
		{ day: "2026-08-14", items: ["Birthday", "Alarm", "Breakfast", "Standup", "Night shift 1/2"] },
		{ day: "2026-08-15", items: ["Night shift 2/2"] },
		{ day: "2026-08-16", items: ["Review"] },
	]
);
const morning = makeEvent({ title: "Morning", start: at("2026-08-15T07:00"), end: at("2026-08-15T08:00") });
check(
	"a continuation sorts before that day's own timed events",
	summary(bucketByDay([morning, overnight], day("2026-08-15"), day("2026-08-15").endOf("day"))),
	[{ day: "2026-08-15", items: ["Night shift 2/2", "Morning"] }]
);
check(
	"events outside the range are dropped",
	summary(bucketByDay([standup, review], day("2026-08-16"), day("2026-08-16").endOf("day"))),
	[{ day: "2026-08-16", items: ["Review"] }]
);
check("no events, no buckets", bucketByDay([], day("2026-08-14"), day("2026-08-20")).length, 0);

// A years-long event is listed once, not on every day of a long range.
const forever = makeEvent({
	id: "forever",
	title: "Forever",
	allDay: true,
	start: at("2026-01-01T00:00"),
	end: at("2028-12-31T00:00").endOf("day"),
});
const longRange = bucketByDay([forever, holiday], day("2026-08-01"), day("2026-12-31").endOf("day"));
check("long event listed once", longRange.filter((b) => b.items.some((i) => i.event.id === "forever")).length, 1);
check("on the first in-range day", longRange[0].day.format("YYYY-MM-DD"), "2026-08-01");
check("short events still repeat", longRange.filter((b) => b.items.some((i) => i.event.id === "holiday")).length, 3);
const monthTrip = makeEvent({
	id: "trip",
	allDay: true,
	start: at("2026-08-01T00:00"),
	end: at("2026-08-01T00:00").add(MAX_REPEAT_DAYS - 1, "days").endOf("day"),
});
check(
	"an event at the cap still repeats",
	bucketByDay([monthTrip], day("2026-08-01"), day("2026-12-31").endOf("day")).length,
	MAX_REPEAT_DAYS
);
