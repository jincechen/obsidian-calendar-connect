import { isValidEmail, mapsUrl, markdownInline, safeColor, safeExternalUrl, truncate } from "../src/safety";
import { check } from "./harness";

// --- safeColor ---------------------------------------------------------------
for (const ok of ["#abc", "#a1b2c3", "#a1b2c3d4", "#ABCD", " #a1b2c3 "]) {
	check(`safeColor accepts ${JSON.stringify(ok)}`, safeColor(ok), ok.trim());
}
for (const bad of [
	"red",
	"#12345",
	"#1234567",
	"#ab",
	"#fff;background:url(x)",
	"#fff ;x",
	"var(--x)",
	"rgb(0,0,0)",
	"#ggg",
	"",
	null,
	undefined,
	123,
	{},
	["#abc"],
]) {
	check(`safeColor rejects ${JSON.stringify(bad)}`, safeColor(bad), null);
}

// --- safeExternalUrl -----------------------------------------------------------
check("safeExternalUrl accepts https", safeExternalUrl("https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
check("safeExternalUrl normalises", safeExternalUrl("  HTTPS://Calendar.Google.com  "), "https://calendar.google.com/");
check(
	"safeExternalUrl keeps query strings",
	safeExternalUrl("https://www.google.com/calendar/event?eid=abc%20d"),
	"https://www.google.com/calendar/event?eid=abc%20d"
);
for (const bad of [
	"http://example.com",
	"javascript:alert(1)",
	"JavaScript:alert(1)",
	"data:text/html,<script>alert(1)</script>",
	"file:///etc/passwd",
	"obsidian://open?vault=x",
	"vbscript:msgbox",
	"//example.com/path",
	"example.com",
	"https://",
	"https:// spaced.com",
	"not a url",
	"https://user:pass@example.com/",
	"https://user@example.com/",
	"",
	"   ",
	null,
	undefined,
	42,
]) {
	check(`safeExternalUrl rejects ${JSON.stringify(bad)}`, safeExternalUrl(bad), null);
}

// --- mapsUrl -----------------------------------------------------------------
check(
	"mapsUrl encodes the location",
	mapsUrl("Room 4 & 5, 10 Downing St #2"),
	"https://www.google.com/maps/search/?api=1&query=Room%204%20%26%205%2C%2010%20Downing%20St%20%232"
);
check("mapsUrl is always https and safe", safeExternalUrl(mapsUrl("javascript:alert(1)")) !== null, true);

// --- isValidEmail ------------------------------------------------------------
for (const ok of ["alex@example.com", "a.b+tag@sub.example.co.uk", " bob@example.org "]) {
	check(`isValidEmail accepts ${ok}`, isValidEmail(ok), true);
}
for (const bad of ["", "alex", "alex@", "@example.com", "alex@example", "a b@example.com", "a@b@c.com", "<a@b.com>", "a@b.com, c@d.com"]) {
	check(`isValidEmail rejects ${JSON.stringify(bad)}`, isValidEmail(bad), false);
}

// --- truncate ------------------------------------------------------------------
check("truncate: 0 shows nothing", truncate("hello", 0), "");
check("truncate: negative shows nothing", truncate("hello", -3), "");
check("truncate: short text unchanged", truncate("hello", 10), "hello");
check("truncate: exact length unchanged", truncate("hello", 5), "hello");
check("truncate: long text gets an ellipsis", truncate("hello world", 5), "hello…");
check("truncate: trailing space trimmed before the ellipsis", truncate("hello world", 6), "hello…");

// --- markdownInline: event text pasted into a note stays inert ---------------
// Every syntax character gains a backslash, so it renders literally.
const escaped = (text: string) => text.replace(/[`![\]()<>%*]/g, (c) => "\\" + c);
check("markdownInline flattens lines", markdownInline("a\n```js\nx\n```"), escaped("a ```js x ```"));
check("markdownInline escapes images", markdownInline("![](https://evil/p)"), escaped("![](https://evil/p)"));
check("markdownInline escapes html and templater", markdownInline("<%* x %>"), escaped("<%* x %>"));
check("markdownInline keeps plain text", markdownInline("  Team sync 3pm "), "Team sync 3pm");
