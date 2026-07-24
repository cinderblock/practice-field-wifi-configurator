# Support System

A built-in support system available as a floating widget on every page —
click the support agent icon in the status bar to open it as a floating
panel in the bottom-right corner. The widget can be closed and reopened
without losing the chat session, and persists state across page
navigations via localStorage. An unread badge appears on the icon when
admin replies arrive while the widget is closed.

## Issue Reports

Teams can submit structured issue reports with:

- Standard template fields: what they were trying to do, what steps they
  took, what they expected, and what happened
- Automatic screenshot capture of the current page content (the widget
  hides itself during capture, via html2canvas)
- Auto-included recent system logs and browser metadata (user agent,
  screen size, page URL, client IP)

Issues are stored server-side (last 200; screenshots are kept in memory
only and are not written to the persistence file) and optionally forwarded
to a Slack channel — the report posts as a formatted message with the
recent logs and screenshot attached in its thread.

## Real-Time Chat

Teams can start a live chat session that bridges to a Slack channel:

- Each chat session becomes a single Slack thread (last 100 sessions kept)
- Screenshots can be attached to chat messages with one click (📷 button)
- A chat can be started directly from an existing issue report, and issues
  can be created from chat conversations to track them formally
- An admin's Slack replies appear in real time on the web chat UI, with
  the admin's Slack display name and any custom workspace emoji resolved

## Slack Integration

Configured on the admin page (`/admin` → Slack Integration):

- Requires a Slack App with a Bot Token (`xoxb-...`) and App-Level Token
  (`xapp-...`) with `connections:write` scope
- Uses Socket Mode for receiving messages (no public URL required)
- Test-connection button to verify configuration

The same channel also receives deploy announcements: on startup with a new
git version, the backend posts the commit subjects since the last deploy
(see `src/deployAnnouncer.ts` — this is why commit subjects are written as
user-facing prose).

## Admin Authentication

The `/admin` page is secured with a shared passphrase:

- First visit prompts passphrase creation (min. 4 characters)
- Subsequent visits require login; a session token is stored in the
  browser (up to 20 active tokens; changing the passphrase invalidates
  them all)
- Required for Slack configuration and other admin operations

Admin login also issues an [external access token](setup.md#external-access)
so admins keep full UI access from outside the local network.
