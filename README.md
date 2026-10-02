# Calendar Connect

An Obsidian plugin that lists your Google Calendar events in a code block, one compact line each,
like a Tasks query for your calendar. You can also create, edit, delete and RSVP to events without
leaving the note.

````markdown
```calendar-connect
from: today
period: 1d
```
````

Each device signs in on its own and keeps its sign-in in that device's keychain. Desktop and
mobile work independently of each other.

Requires Obsidian 1.13.1 or later.

---

## Features

- **A compact daily agenda.** Events show one per line. All-day events sit at the top of each day,
  the current and next events are highlighted, and past events are dimmed.
- **List, agenda and table views.** Choose one per block or set a default.
- **Full editing.** You can change the title, time, all-day setting, location, description and
  guests, move an event to another calendar, delete it, create new events and RSVP.
- **Multiple Google accounts.** Personal and work accounts can sit side by side, or each block can
  filter to one.
- **Flexible ranges.** Ranges can use `today`, `sow`, `eom`, `+3d`, `2026-09-01` or a period such
  as `2w`.
- **Hide noisy events.** Match titles exactly, with a wildcard (`Start of *`) or with a regular
  expression.
- **Keeps itself current.** Optional auto-refresh pauses while Obsidian is in the background. A
  minute ticker keeps "now" and "next" correct without any network calls.
- **Works on mobile**, with its own sign-in.

---

## What this plugin accesses

- **Two scopes:**
  - `calendar.calendarlist.readonly`, to list your calendars.
  - `calendar.events`, to read and change events.

  If you don't grant the second scope at the consent screen, the account connects read-only.
- **Network.** The plugin talks only to Google:
  - `accounts.google.com` and `oauth2.googleapis.com` to sign in.
  - `www.googleapis.com/calendar/v3` for calendar data.

  It makes no requests until you connect an account. There is no third-party server and no
  telemetry.
- **Your own OAuth client.** You create the client in your own Google Cloud project, so nobody
  else is involved.
- **Tokens stay on the device.** Refresh tokens are stored only in the device keychain
  (`app.secretStorage`). Access tokens are held only in memory. Nothing that can act on your account
  is written into your vault.
- **`data.json`** (synced with the vault) holds:
  - the OAuth client ID and secret
  - each account's address and label, plus an optional per-account client
  - the cached calendar list and your display preferences

  It holds no tokens.
- **Clipboard.** The plugin writes to the clipboard only when you choose a Copy action. It never
  reads the clipboard.

Revoke access at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
Removing an account in the plugin also revokes its token and clears it from the keychain.

---

## Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or reuse one).
2. **APIs & Services → Library:** enable the **Google Calendar API**.
3. **OAuth consent screen** (Google Auth Platform):
   - User type: **External**.
   - **Data access → Add scopes:**
     `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and
     `https://www.googleapis.com/auth/calendar.events`.
   - **Audience → Publishing status: In production.** Do not leave it in *Testing*: Google expires
     a Testing project's refresh tokens after **7 days**, so you would have to reconnect every week.
     Personal use needs no verification. Google will show an "unverified app" screen at sign-in;
     choose **Advanced → Continue**.
4. **Credentials → Create credentials → OAuth client ID → Desktop app.** Desktop clients accept any
   `http://127.0.0.1:<port>` redirect, so there's no redirect URI to register.
5. In Obsidian, open **Settings → Calendar Connect → Google Cloud client** and paste the
   **Client ID** and **Client secret**.
6. Under **Accounts**, click **Add account** and complete the sign-in (see below).
7. Under **Calendars**, choose the calendars blocks show by default (leave all of them off to show
   every calendar). Also choose the **Calendar for new events**.

### Signing in on desktop

Your browser opens Google's consent screen, and a dialog in Obsidian walks you through it. After
you approve, the browser redirects to a small listener on `127.0.0.1` and the dialog closes by
itself. If that doesn't happen, for example because you signed in from a different browser, copy the
address from the browser's address bar and paste it into the dialog.

### Signing in on mobile

Mobile has no local listener, so you finish the sign-in by pasting:

1. Tap **Add account** (or **Connect** on an account synced from another device), then **Open in
   browser**.
2. Approve access. The browser then tries to load `http://127.0.0.1:…/?state=…&code=…` and shows an
   error page such as "This site can't be reached". **This is expected.**
3. Copy that full address from the address bar, switch back to Obsidian, paste it into the dialog
   and tap **Continue**.

Each device needs its own sign-in. On a device that hasn't signed in yet, blocks show **"Not signed in on this
device — Connect"**, and the account row in settings shows a warning.

### Multiple accounts

One OAuth client can serve every account, so you don't need a Cloud project per account. Re-adding
the same Google account updates it in place. Rename an account with its **Label**: that label is what
`accounts:` and `account/calendar` match against. If a Workspace admin blocks outside apps, give
that account its own client under **Separate OAuth client**.

---

## Block reference

Every key is optional. Key names ignore case, and `-`, `_` and spaces are interchangeable, so
`all-day`, `all_day` and `allDay` all work.

| Key | Default | Notes |
| --- | --- | --- |
| `from` | `today` | Start of the range. |
| `to` | — | End of the range, inclusive of the named day. |
| `period` | setting (`1d`) | Length of the range when `to` is not set, counting the `from` day: `1d` is just that day, `7d` a week, also `2w`, `1m`, or an end like `eom`. |
| `view` | setting (`list`) | `list` (compact), `agenda` or `table`. |
| `calendars` | setting / all | Names or IDs. `account/calendar` narrows to one account. |
| `exclude` | — | Calendars to drop. |
| `accounts` | all | Account labels or addresses. |
| `search` | — | Google full-text search. |
| `hide-titles` | added to the setting | Title patterns to hide (see below). |
| `all-day` | `include` | `include`, `exclude` or `only`. |
| `declined` | setting (hide) | `show` to include events you declined. |
| `past` | setting (`dim`) | `show`, `dim` or `hide` for events that have ended. |
| `now` | `true` | Highlight the current and next event and draw a now-line. |
| `show` / `hide` / `fields` | per view | Add, remove or replace fields: `date`, `time`, `duration`, `title`, `calendar`, `account`, `location`, `description`, `attendees`, `response`, `link`. |
| `limit` | — | Maximum number of events. |
| `time-format` | setting | `24h` or `12h`. |
| `empty` | — | Text shown when nothing matches. |
| `refresh` | setting (`0`) | Auto-refresh interval such as `5m` or `300`. `0` turns it off; the minimum is 60 seconds. |
| `controls` | `true` | Footer with "+ New event" and refresh. |
| `new-event` | setting | Calendar used for new events from this block. `false` hides the button. |
| `editable` | `true` | `false` makes the block read-only. |

**Date expressions:**
- Keywords: `now`, `today`, `tomorrow`, `yesterday`, `sow`/`eow`, `som`/`eom` and `soy`/`eoy`
  (start and end of week, month and year).
- ISO dates, such as `2026-08-14`.
- Offsets, such as `+3d`, `today+2w` and `sow-1w`.

In `period`, `from` and `to`, the unit `m` means **months**. Write `min` for minutes.

**Hidden titles:**
- `EOD` matches that title exactly (ignoring case).
- `Start of *` matches a prefix.
- `*lunch*` matches the text anywhere in the title.
- `/^(EOD|SOD)$/` is a regular expression.

### Examples

A daily-note agenda:

````markdown
```calendar-connect
from: today
period: 1d
refresh: 5m
```
````

This week, as an agenda, work calendars only:

````markdown
```calendar-connect
from: sow
to: eow
view: agenda
accounts: work
all-day: exclude
```
````

A read-only shared calendar, with no footer:

````markdown
```calendar-connect
calendars: Team holidays
period: 1m
editable: false
controls: false
```
````

New events from this block go to a specific calendar:

````markdown
```calendar-connect
period: 3d
new-event: personal/Household
```
````

---

## Editing

- **Open an event.** Click a row (or focus it and press Enter or Space) to open the editor. If you
  can't edit the event, a read-only view opens instead.
- **Event menu.** Right-click, long-press, use the **⋯** button or press Shift+F10. The menu has:
  - Edit
  - RSVP (Yes / Maybe / No)
  - Join call
  - Open in Google Calendar
  - Copy title, or copy as Markdown
  - Delete
- **Create an event.** Use **+** on a day heading, the footer's **+ New event**, or the **Create
  event** command. New events start at the next half-hour slot.
- **Recurring events.** Choose **This event** or **All events**:
  - A date change applies only to this event.
  - Moving to another calendar applies to the whole series.
- **Guests.** When an event has other guests, you're asked whether to notify them. Change this
  under **Settings → Editing → Notify guests**.
- **Conflicts.** If the event changed in Google Calendar while you were editing, you can **Reload**
  the event or **Apply my changes** on top of the new version.
- **Permissions.** You can edit an event only if all of these are true:
  - the account has the edit scope
  - your role on the calendar is *writer* or *owner*
  - you are the organiser, or guests may modify the event

  For events that are locked, private copies or special types such as birthdays, you can only RSVP.
  `editable: false` makes a whole block read-only.

---

## Installing from source

```sh
npm ci
npm run build
./install.sh /path/to/your/vault
```

Then enable **Calendar Connect** under **Settings → Community plugins**. `npm test` runs the
unit tests.

## Credits

Calendar Connect is an independent plugin. It was inspired by
[lukewowo/obsidian-gcal](https://github.com/lukewowo/obsidian-gcal) by lukewowo (MIT) and borrows from
its implementation of the code block, Google sign-in, and the agenda and table views. Any mistakes are
this project's own. See `LICENSE`.
