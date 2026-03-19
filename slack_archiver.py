"""Slack API archiver — downloads all data from a Slack workspace."""

import os
import sys
import json
import time
import requests
from datetime import datetime
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from models import get_db, init_db

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
AVATARS_DIR = os.path.join(os.path.dirname(__file__), "static", "avatars")
FILES_DIR = os.path.join(os.path.dirname(__file__), "static", "files")


class SlackArchiver:
    def __init__(self, token, cookie=None):
        """Initialize with a Slack token.

        Supports:
        - xoxp- tokens (User OAuth tokens from Slack apps)
        - xoxb- tokens (Bot tokens)
        - xoxc- tokens (Browser session tokens — require cookie param)
        """
        headers = {}
        if cookie:
            # xoxc- tokens require the browser 'd' cookie
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie

        self.client = WebClient(token=token, headers=headers)
        self.token = token
        self.cookie = cookie
        os.makedirs(DATA_DIR, exist_ok=True)
        os.makedirs(AVATARS_DIR, exist_ok=True)
        os.makedirs(FILES_DIR, exist_ok=True)
        init_db()

    def log(self, msg):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

    def _rate_limit_retry(self, func, *args, **kwargs):
        """Call a Slack API method with rate-limit retry."""
        max_retries = 5
        for attempt in range(max_retries):
            try:
                return func(*args, **kwargs)
            except SlackApiError as e:
                if e.response.status_code == 429:
                    retry_after = int(e.response.headers.get("Retry-After", 5))
                    self.log(f"  Rate limited. Waiting {retry_after}s...")
                    time.sleep(retry_after)
                else:
                    raise
        raise Exception(f"Rate limit exceeded after {max_retries} retries")

    def download_file(self, url, local_path):
        """Download a file from Slack with auth."""
        if os.path.exists(local_path):
            return local_path
        try:
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            dl_headers = {"Authorization": f"Bearer {self.token}"}
            if self.cookie:
                dl_headers["cookie"] = f"d={self.cookie}" if not self.cookie.startswith("d=") else self.cookie
            resp = requests.get(url, headers=dl_headers, timeout=30)
            if resp.status_code == 200:
                with open(local_path, "wb") as f:
                    f.write(resp.content)
                return local_path
        except Exception as e:
            self.log(f"  Failed to download {url}: {e}")
        return None

    def sync_workspace(self):
        """Sync workspace info."""
        self.log("Syncing workspace info...")
        try:
            resp = self._rate_limit_retry(self.client.team_info)
            team = resp["team"]
            conn = get_db()
            conn.execute(
                "INSERT OR REPLACE INTO workspace (id, name, domain, icon_url, synced_at) VALUES (?,?,?,?,?)",
                (team["id"], team["name"], team["domain"],
                 team.get("icon", {}).get("image_132", ""),
                 datetime.now().isoformat())
            )
            conn.commit()
            conn.close()
            self.log(f"  Workspace: {team['name']} ({team['domain']}.slack.com)")
        except SlackApiError as e:
            self.log(f"  Could not fetch workspace info: {e}")

    def sync_users(self):
        """Sync all users."""
        self.log("Syncing users...")
        cursor = None
        total = 0
        conn = get_db()

        while True:
            kwargs = {"limit": 200}
            if cursor:
                kwargs["cursor"] = cursor

            resp = self._rate_limit_retry(self.client.users_list, **kwargs)
            members = resp["members"]

            for user in members:
                profile = user.get("profile", {})
                avatar_url = profile.get("image_192", profile.get("image_72", ""))

                # Use Slack CDN URL directly (avatars are public) — skip slow downloads
                avatar_local = avatar_url  # just use the URL; no local download needed

                conn.execute("""
                    INSERT OR REPLACE INTO users
                    (id, team_id, name, real_name, display_name, email, avatar_url, avatar_local,
                     is_bot, is_admin, status_text, status_emoji, title, color, deleted, raw_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    user["id"],
                    user.get("team_id", ""),
                    user.get("name", ""),
                    user.get("real_name", profile.get("real_name", "")),
                    profile.get("display_name", ""),
                    profile.get("email", ""),
                    avatar_url,
                    avatar_local,
                    1 if user.get("is_bot") else 0,
                    1 if user.get("is_admin") else 0,
                    profile.get("status_text", ""),
                    profile.get("status_emoji", ""),
                    profile.get("title", ""),
                    user.get("color", ""),
                    1 if user.get("deleted") else 0,
                    json.dumps(user)
                ))
                total += 1

            conn.commit()
            cursor = resp.get("response_metadata", {}).get("next_cursor", "")
            if not cursor:
                break

        conn.close()
        self.log(f"  Synced {total} users")

    def sync_channels(self):
        """Sync all channels (public, private, DMs, group DMs)."""
        self.log("Syncing channels...")
        cursor = None
        total = 0
        conn = get_db()

        # Fetch all conversation types
        types = "public_channel,private_channel,mpim,im"

        while True:
            kwargs = {"types": types, "limit": 200}
            if cursor:
                kwargs["cursor"] = cursor

            resp = self._rate_limit_retry(self.client.conversations_list, **kwargs)
            channels = resp["channels"]

            for ch in channels:
                is_dm = ch.get("is_im", False)
                is_group_dm = ch.get("is_mpim", False)
                is_private = ch.get("is_private", False)

                # Get channel name — for DMs use the other user's name
                name = ch.get("name", "")
                if is_dm:
                    name = ch.get("user", name)

                # Use num_members from the API response (skip per-channel member fetch for speed)
                members = []
                num_members = ch.get("num_members", 0)

                conn.execute("""
                    INSERT OR REPLACE INTO channels
                    (id, name, topic, purpose, is_private, is_dm, is_group_dm, is_archived,
                     created, creator, num_members, members, raw_json)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    ch["id"],
                    name,
                    ch.get("topic", {}).get("value", "") if isinstance(ch.get("topic"), dict) else "",
                    ch.get("purpose", {}).get("value", "") if isinstance(ch.get("purpose"), dict) else "",
                    1 if is_private else 0,
                    1 if is_dm else 0,
                    1 if is_group_dm else 0,
                    1 if ch.get("is_archived") else 0,
                    ch.get("created", 0),
                    ch.get("creator", ""),
                    num_members,
                    json.dumps(members),
                    json.dumps(ch)
                ))
                total += 1

            conn.commit()
            cursor = resp.get("response_metadata", {}).get("next_cursor", "")
            if not cursor:
                break

        conn.close()
        self.log(f"  Synced {total} channels")

    def sync_messages(self, channel_id, channel_name=""):
        """Sync all messages from a channel, including threads and files."""
        self.log(f"  Syncing messages for #{channel_name or channel_id}...")
        conn = get_db()
        cursor = None
        total = 0
        threads_fetched = 0

        # Check sync state — get the latest message we have
        state = conn.execute(
            "SELECT * FROM sync_state WHERE channel_id=?", (channel_id,)
        ).fetchone()

        # We always fetch all history to catch anything we might have missed
        while True:
            kwargs = {"channel": channel_id, "limit": 200}
            if cursor:
                kwargs["cursor"] = cursor

            try:
                resp = self._rate_limit_retry(self.client.conversations_history, **kwargs)
            except SlackApiError as e:
                if "not_in_channel" in str(e) or "channel_not_found" in str(e):
                    # Try joining first
                    try:
                        self._rate_limit_retry(self.client.conversations_join, channel=channel_id)
                        resp = self._rate_limit_retry(self.client.conversations_history, **kwargs)
                    except SlackApiError:
                        self.log(f"    Skipping (cannot access)")
                        return 0
                else:
                    self.log(f"    Error: {e}")
                    return 0

            messages = resp.get("messages", [])

            for msg in messages:
                self._store_message(conn, channel_id, msg)
                total += 1

                # Fetch thread replies
                if msg.get("reply_count", 0) > 0:
                    thread_msgs = self._fetch_thread(channel_id, msg["ts"])
                    for tmsg in thread_msgs:
                        if tmsg["ts"] != msg["ts"]:
                            self._store_message(conn, channel_id, tmsg)
                            total += 1
                    threads_fetched += 1

                # Store file metadata (skip slow downloads — files stay on Slack CDN)
                if msg.get("files"):
                    for file_info in msg["files"]:
                        self._store_file_metadata(conn, file_info, channel_id, msg["ts"])

            conn.commit()

            if not resp.get("has_more", False):
                break
            cursor = resp.get("response_metadata", {}).get("next_cursor", "")
            if not cursor:
                break

        # Update sync state
        conn.execute("""
            INSERT OR REPLACE INTO sync_state (channel_id, last_synced, fully_synced)
            VALUES (?, ?, 1)
        """, (channel_id, datetime.now().isoformat()))
        conn.commit()
        conn.close()

        self.log(f"    {total} messages, {threads_fetched} threads")
        return total

    def _store_message(self, conn, channel_id, msg):
        """Store a single message."""
        conn.execute("""
            INSERT OR REPLACE INTO messages
            (ts, channel_id, user_id, text, thread_ts, reply_count, reply_users,
             subtype, edited_ts, reactions, attachments, blocks, files, raw_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            msg["ts"],
            channel_id,
            msg.get("user", msg.get("bot_id", "")),
            msg.get("text", ""),
            msg.get("thread_ts"),
            msg.get("reply_count", 0),
            json.dumps(msg.get("reply_users", [])),
            msg.get("subtype", ""),
            msg.get("edited", {}).get("ts") if msg.get("edited") else None,
            json.dumps(msg.get("reactions", [])),
            json.dumps(msg.get("attachments", [])),
            json.dumps(msg.get("blocks", [])),
            json.dumps(msg.get("files", [])),
            json.dumps(msg)
        ))

    def _fetch_thread(self, channel_id, thread_ts):
        """Fetch all replies in a thread."""
        messages = []
        cursor = None
        while True:
            kwargs = {"channel": channel_id, "ts": thread_ts, "limit": 200}
            if cursor:
                kwargs["cursor"] = cursor
            try:
                resp = self._rate_limit_retry(self.client.conversations_replies, **kwargs)
                messages.extend(resp.get("messages", []))
                if not resp.get("has_more", False):
                    break
                cursor = resp.get("response_metadata", {}).get("next_cursor", "")
                if not cursor:
                    break
            except SlackApiError:
                break
        return messages

    def _store_file_metadata(self, conn, file_info, channel_id, message_ts):
        """Store file metadata only (no downloads — uses Slack CDN URLs directly)."""
        file_id = file_info.get("id", "")
        if not file_id:
            return

        url = file_info.get("url_private", "")
        name = file_info.get("name", f"file_{file_id}")
        filetype = file_info.get("filetype", "")
        thumb_url = file_info.get("thumb_360", file_info.get("thumb_160", ""))

        conn.execute("""
            INSERT OR REPLACE INTO files
            (id, name, title, mimetype, filetype, size, url_private, thumb_url,
             local_path, thumb_local, user_id, channel_id, message_ts, created, raw_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            file_id,
            name,
            file_info.get("title", name),
            file_info.get("mimetype", ""),
            filetype,
            file_info.get("size", 0),
            url,
            thumb_url,
            url,          # local_path = use the Slack URL directly
            thumb_url,    # thumb_local = use the Slack URL directly
            file_info.get("user", ""),
            channel_id,
            message_ts,
            file_info.get("created", 0),
            json.dumps(file_info)
        ))

    def sync_all(self, include_dms=True):
        """Full sync: workspace, users, channels, and all messages."""
        self.log("=" * 60)
        self.log("Starting full Slack archive sync...")
        self.log("=" * 60)

        self.sync_workspace()
        self.sync_users()
        self.sync_channels()

        # Now sync messages for all channels
        conn = get_db()
        if include_dms:
            channels = conn.execute("SELECT id, name, is_dm FROM channels").fetchall()
        else:
            channels = conn.execute(
                "SELECT id, name, is_dm FROM channels WHERE is_dm=0"
            ).fetchall()
        conn.close()

        total_messages = 0
        for i, ch in enumerate(channels):
            ch = dict(ch)
            label = ch["name"]
            if ch["is_dm"]:
                # Resolve DM name to user name
                user = get_user_name(ch["name"])
                label = f"DM: {user}" if user else f"DM: {ch['name']}"
            self.log(f"[{i+1}/{len(channels)}] #{label}")
            count = self.sync_messages(ch["id"], label)
            total_messages += count

        self.log("=" * 60)
        self.log(f"Sync complete! {total_messages} total messages archived.")
        self.log("=" * 60)
        return total_messages


def get_user_name(user_id):
    """Helper to resolve user ID to display name."""
    from models import get_user
    user = get_user(user_id)
    if user:
        return user.get("display_name") or user.get("real_name") or user.get("name") or user_id
    return user_id


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    token = os.environ.get("SLACK_TOKEN")
    cookie = os.environ.get("SLACK_COOKIE", "")
    if not token:
        print("Error: Set SLACK_TOKEN in .env file")
        print("")
        print("Option A — Browser token (no admin needed):")
        print("  1. Open Slack in your browser")
        print("  2. Open DevTools (F12) → Network tab")
        print("  3. Find token (xoxc-...) and cookie (d=...)")
        print("  4. Add to .env:")
        print("     SLACK_TOKEN=xoxc-...")
        print("     SLACK_COOKIE=xoxd-...")
        print("")
        print("Option B — Slack App token (needs admin approval):")
        print("  1. Go to api.slack.com/apps → Create New App")
        print("  2. Add OAuth scopes and install to workspace")
        print("  3. Copy the User OAuth Token (xoxp-...)")
        print("  4. Add to .env: SLACK_TOKEN=xoxp-...")
        sys.exit(1)

    archiver = SlackArchiver(token, cookie=cookie or None)
    archiver.sync_all()
