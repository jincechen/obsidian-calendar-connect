import { safeColor, safeExternalUrl } from "../src/safety";
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
