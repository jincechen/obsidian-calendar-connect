import { DEFAULT_SETTINGS, sanitiseSettings } from "../src/settings";
import { check } from "./harness";

// Defaults come back for nothing at all, and are never shared by reference.
check("empty input gives defaults", sanitiseSettings(undefined), DEFAULT_SETTINGS);
const a = sanitiseSettings({});
const b = sanitiseSettings({});
a.accounts.push({ id: "x", label: "x" });
check("arrays are not aliased", b.accounts.length, 0);
check("defaults untouched", DEFAULT_SETTINGS.accounts.length, 0);

// Types are coerced and unknown keys dropped — including anything token-like.
const messy = sanitiseSettings({
	clientId: "  id.apps.googleusercontent.com ",
	oauthPort: "8080",
	accounts: [
		{ id: "a@x.com", label: "A", tokens: { refreshToken: "secret" }, refreshToken: "secret" },
		{ id: "a@x.com", label: "duplicate" },
		{ label: "no id" },
		"nonsense",
	],
	knownCalendars: [
		{ id: "a@x.com", accountId: "a@x.com", name: "A", color: "red;background:url(x)" },
		{ id: "orphan", accountId: "gone@x.com", name: "Orphan" },
	],
	noteTypes: [{ id: "n" }],
	evil: "<script>",
});
check("client id trimmed", messy.clientId, "id.apps.googleusercontent.com");
check("numeric string coerced", messy.oauthPort, 8080);
check("negative clamped", sanitiseSettings({ oauthPort: -5 }).oauthPort, 0);
check("accounts deduplicated and invalid dropped", messy.accounts.map((x) => x.label), ["A"]);
check("no tokens survive", JSON.stringify(messy).includes("secret"), false);
check("unsafe colour emptied", messy.knownCalendars[0].color, "");
check("orphan calendars dropped", messy.knownCalendars.length, 1);
check("unknown keys dropped", Object.keys(messy).includes("evil") || Object.keys(messy).includes("noteTypes"), false);
