<p align="center">
  <h1 align="center">SlackForever</h1>
  <p align="center">
    <strong>Your Slack messages, forever. Even on the free plan.</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python">
    <img src="https://img.shields.io/badge/Flask-3.1-000000?style=flat-square&logo=flask&logoColor=white" alt="Flask">
    <img src="https://img.shields.io/badge/SQLite-Local_DB-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
    <img src="https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript">
    <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
  </p>
</p>

---

Slack's free plan hides messages older than 90 days. **SlackForever** is a local web app that connects to your Slack workspace, archives every message before it disappears, and lets you browse them in a pixel-perfect Slack clone UI — complete with sending messages, reactions, file sharing, notifications, and more.

**No data leaves your computer. No paid plan required. No admin access needed.**

---

## Features

### Core
- **Archive & Preserve** — Save all messages before the 90-day wall. Once synced, they're yours forever
- **Pixel-Perfect Slack UI** — Dark sidebar, message grouping, hover actions, threads, emoji picker — looks and feels like Slack
- **No Admin Access Needed** — Browser token extraction works for any workspace member
- **100% Local Storage** — SQLite database on your machine. Nothing sent to external servers

### Messaging
- **Send & Receive Live** — Real-time polling (3s), send messages, reply in threads
- **Message Edit & Delete** — Edit or delete your own messages
- **Emoji Reactions** — Add/remove reactions with 1,400+ searchable emojis
- **@Mention Autocomplete** — Type `@` to search and mention teammates
- **Formatting Toolbar** — Bold, italic, strikethrough, code, links, lists
- **File Upload** — Drag-and-drop or paperclip button with preview before sending
- **Huddle Link** — Start a Slack huddle directly from the channel header

### Media & Files
- **File Proxy & Caching** — All files served through local proxy with auth; cached to disk on first view
- **Download All Media** — One-click button to batch-download all files for full offline access
- **PDF Viewer** — Click PDFs to preview inline in an iframe
- **Image Lightbox** — Click images to view full-size with download button
- **Inline Video & Audio** — Videos and audio play directly in the message

### Organization
- **Multi-Workspace Support** — Connect multiple workspaces, switch from the dropdown
- **Channel Picker** — Select which channels/DMs to sync
- **Channel Details Panel** — View topic, purpose, members, and files
- **Pinned Messages** — View and manage pinned messages
- **Full-Text Search** — Search across all archived messages instantly
- **Archive Statistics** — Dashboard with message counts, date ranges, and per-channel breakdown

### Notifications & Status
- **Desktop Notifications** — Native browser notifications for new messages
- **In-App Toast Notifications** — Animated toast cards with sender avatar and preview
- **Notification Sound** — Subtle audio beep via Web Audio API
- **Online/Offline Presence** — Green/gray dots on DM avatars, "Active"/"Away" in header
- **Stale Sync Warnings** — Reminds you when it's been too long since last sync

### Context & Actions
- **Right-Click Context Menu** — Copy, reply, react, pin, edit, delete
- **Message Hover Action Bar** — Quick access to thread, emoji, bookmark, more
- **User Profile Popovers** — Click avatars for profile, status, and "Message" button
- **Keyboard Shortcuts** — `Ctrl+K` search, `Ctrl+B/I` formatting, `Esc` close, `↑` edit last

---

## Quick Start

```bash
git clone https://github.com/user/SlackForever.git
cd SlackForever
./setup.sh
./run.sh          # Opens http://localhost:5001
```

The setup wizard will guide you through connecting your workspace.

```bash
./run.sh web      # Start the web viewer (default)
./run.sh sync     # Download/update messages from Slack (CLI)
./run.sh both     # Sync first, then start the viewer
```

---

## How It Works

1. **Extract your browser token** from Slack (no admin access required)
2. **Select channels to sync** using the built-in channel picker
3. **Browse your archived messages** in the Slack-like web interface
4. **Media auto-downloads** after sync for full offline access

> **Important:** The app can only archive messages still visible at the time of sync. Once messages pass the 90-day window, Slack's API won't return them. Sync early and sync regularly.

---

## Setup Guide

### Option A: Browser Token (Recommended)

Works for **any workspace member** — no admin approval needed.

1. Open Slack in a **web browser** → [app.slack.com](https://app.slack.com)
2. Open DevTools (`F12`) → **Console** tab
3. Paste: `JSON.parse(localStorage.localConfig_v2).teams`
4. Find your workspace → copy the `token` value (starts with `xoxc-`)
5. Go to **Application** tab → **Cookies** → `app.slack.com` → copy the `d` cookie value
6. Paste both into the SlackForever setup wizard

### Option B: Slack App Token (Requires Admin)

1. Create a new app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add User Token Scopes: `channels:history`, `channels:read`, `files:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `users:read`, `users:read.email`, `chat:write`, `reactions:write`, `pins:read`, `pins:write`
3. Install to workspace → copy the User OAuth Token (`xoxp-...`)

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python 3.10+ / Flask |
| Database | SQLite (local, per-workspace) |
| Frontend | Vanilla JavaScript (no frameworks) |
| Slack API | slack-sdk for Python |
| Emojis | 1,400+ built-in emoji dataset |

---

## Project Structure

```
SlackForever/
├── app.py                  # Flask web server + 25+ API endpoints
├── models.py               # SQLite database models
├── slack_archiver.py        # Slack API sync engine
├── workspace_config.py      # Multi-workspace config manager
├── requirements.txt
├── setup.sh / run.sh        # Setup and run scripts
├── .env.example             # Token configuration template
├── data/                    # SQLite databases + workspace config
├── static/
│   ├── css/style.css        # Slack-clone stylesheet (2,600+ lines)
│   ├── js/app.js            # Main app logic (3,200+ lines, 120+ functions)
│   ├── js/emoji-data.js     # Emoji dataset (1,400+ emojis)
│   ├── avatars/             # Cached user avatars
│   └── files/               # Cached media files
└── templates/index.html     # Single-page app template
```

---

## API Endpoints (25+)

| Category | Endpoints |
|----------|-----------|
| **Setup** | `GET /api/setup/status`, `POST /api/setup/save-token`, `GET /api/me` |
| **Workspaces** | `GET /api/workspaces`, `POST /api/workspaces/switch`, `POST /api/workspaces/remove` |
| **Channels** | `GET /api/channels`, `GET /api/channels/:id`, `GET /api/channels/:id/messages` |
| **Messaging** | `POST /api/channels/:id/send`, `GET /api/channels/:id/poll` |
| **Threads** | `GET /api/channels/:id/threads/:ts` |
| **Reactions** | `POST /api/channels/:id/react` |
| **Pins** | `GET /api/channels/:id/pins`, `POST /api/channels/:id/pin` |
| **Edit/Delete** | `PUT /api/messages/:ch/:ts/edit`, `DELETE /api/messages/:ch/:ts` |
| **Files** | `POST /api/channels/:id/upload`, `GET /api/file/:id`, `GET /api/file/:id/thumb` |
| **Media** | `POST /api/files/download-all`, `GET /api/files/download-status` |
| **Users** | `GET /api/users`, `GET /api/users/:id`, `GET /api/users/:id/presence` |
| **Sync** | `GET /api/sync/channels`, `POST /api/sync`, `GET /api/sync/status` |
| **Search** | `GET /api/search?q=` |
| **Stats** | `GET /api/stats` |

---

## FAQ

**Can I see messages older than 90 days?**
Only if you synced them before they expired. The app archives what Slack's API returns at sync time.

**Is my data sent anywhere?**
No. Everything stays in local SQLite. The app only talks to Slack's official API.

**Do I need admin access?**
No. Browser token method works for any member.

**Multiple workspaces?**
Yes. Each workspace gets its own database. Switch from the dropdown.

**How often should I sync?**
Weekly is recommended. At minimum, before 90 days pass. You can sync from the UI or CLI.

**Can I export my data?**
Yes. Data is in standard SQLite files in `data/`. Query with any SQLite tool.

---

## Contributing

1. Fork the repo
2. Create a branch (`git checkout -b feature/my-feature`)
3. Make changes and test locally
4. Push and open a Pull Request

```bash
git clone https://github.com/user/SlackForever.git
cd SlackForever
./setup.sh && source venv/bin/activate
python3 app.py  # Dev server on port 5001
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Disclaimer

This is an **unofficial, community-built tool**. Not affiliated with Slack Technologies, Inc. or Salesforce. "Slack" is a registered trademark of Slack Technologies, Inc. Use responsibly per your workspace policies and Slack's [Terms of Service](https://slack.com/terms-of-service).
