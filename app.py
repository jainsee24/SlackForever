"""Flask web application — serves the Slack-like UI."""

import os
import json
import threading
import webbrowser
from datetime import datetime
from flask import Flask, render_template, jsonify, request, send_from_directory
from dotenv import load_dotenv

from models import (
    init_db, get_db, get_all_channels, get_channel, get_messages,
    get_thread_messages, get_user, get_all_users, search_messages,
    get_channel_stats, get_workspace
)
from workspace_config import (
    list_workspaces, get_active_workspace, set_active_workspace,
    add_workspace, remove_workspace, migrate_from_env
)

ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(ENV_PATH)
app = Flask(__name__)
app.config["SECRET_KEY"] = os.urandom(24)

# Sync state tracking
sync_status = {
    "running": False,
    "progress": "",
    "error": None,
    "percent": 0,
    "phase": "",
    "current": 0,
    "total": 0,
    "channel_name": "",
    "messages_synced": 0,
    "started_at": None,
    "finished_at": None,
}


def get_token():
    """Get the Slack token from active workspace."""
    ws = get_active_workspace()
    return ws["token"] if ws else None


def get_cookie():
    """Get the Slack cookie from active workspace."""
    ws = get_active_workspace()
    return ws.get("cookie") if ws else None


@app.before_request
def ensure_db():
    init_db()


# ── Pages ──

@app.route("/")
def index():
    return render_template("index.html")


# ── API Routes ──

@app.route("/api/workspace")
def api_workspace():
    ws = get_workspace()
    return jsonify(ws or {"name": "Slack Archive", "domain": "local"})


@app.route("/api/channels")
def api_channels():
    channels = get_all_channels()
    # Resolve DM names
    for ch in channels:
        if ch["is_dm"]:
            user = get_user(ch["name"])
            if user:
                ch["display_name"] = user.get("display_name") or user.get("real_name") or user.get("name")
                ch["avatar"] = user.get("avatar_local") or user.get("avatar_url") or ""
            else:
                ch["display_name"] = ch["name"]
                ch["avatar"] = ""
        else:
            ch["display_name"] = ch["name"]
            ch["avatar"] = ""
    return jsonify(channels)


@app.route("/api/channels/<channel_id>")
def api_channel(channel_id):
    ch = get_channel(channel_id)
    if not ch:
        return jsonify({"error": "Not found"}), 404
    return jsonify(ch)


@app.route("/api/channels/<channel_id>/messages")
def api_messages(channel_id):
    limit = request.args.get("limit", 50, type=int)
    before = request.args.get("before")
    after = request.args.get("after")
    msgs = get_messages(channel_id, limit=limit, before_ts=before, after_ts=after)

    # Enrich messages with user info
    user_cache = {}
    for msg in msgs:
        uid = msg.get("user_id", "")
        if uid and uid not in user_cache:
            user_cache[uid] = get_user(uid)
        user = user_cache.get(uid)
        if user:
            msg["user_display_name"] = user.get("display_name") or user.get("real_name") or user.get("name") or uid
            msg["user_avatar"] = user.get("avatar_local") or user.get("avatar_url") or ""
            msg["user_color"] = user.get("color") or "4A154B"
        else:
            msg["user_display_name"] = uid or "Unknown"
            msg["user_avatar"] = ""
            msg["user_color"] = "999999"

        # Parse JSON fields
        for field in ["reactions", "attachments", "files", "blocks", "reply_users"]:
            val = msg.get(field)
            if isinstance(val, str):
                try:
                    msg[field] = json.loads(val)
                except (json.JSONDecodeError, TypeError):
                    msg[field] = []

    return jsonify(msgs)


@app.route("/api/channels/<channel_id>/threads/<thread_ts>")
def api_thread(channel_id, thread_ts):
    msgs = get_thread_messages(channel_id, thread_ts)
    user_cache = {}
    for msg in msgs:
        uid = msg.get("user_id", "")
        if uid and uid not in user_cache:
            user_cache[uid] = get_user(uid)
        user = user_cache.get(uid)
        if user:
            msg["user_display_name"] = user.get("display_name") or user.get("real_name") or user.get("name") or uid
            msg["user_avatar"] = user.get("avatar_local") or user.get("avatar_url") or ""
        else:
            msg["user_display_name"] = uid or "Unknown"
            msg["user_avatar"] = ""

        for field in ["reactions", "attachments", "files", "blocks", "reply_users"]:
            val = msg.get(field)
            if isinstance(val, str):
                try:
                    msg[field] = json.loads(val)
                except (json.JSONDecodeError, TypeError):
                    msg[field] = []

    return jsonify(msgs)


@app.route("/api/users")
def api_users():
    users = get_all_users()
    return jsonify(users)


@app.route("/api/users/<user_id>")
def api_user(user_id):
    user = get_user(user_id)
    if not user:
        return jsonify({"error": "Not found"}), 404
    return jsonify(user)


@app.route("/api/search")
def api_search():
    q = request.args.get("q", "")
    channel_id = request.args.get("channel")
    if not q:
        return jsonify([])
    results = search_messages(q, channel_id=channel_id)
    # Enrich with user info
    user_cache = {}
    for msg in results:
        uid = msg.get("user_id", "")
        if uid and uid not in user_cache:
            user_cache[uid] = get_user(uid)
        user = user_cache.get(uid)
        if user:
            msg["user_display_name"] = user.get("display_name") or user.get("real_name") or user.get("name") or uid
            msg["user_avatar"] = user.get("avatar_local") or user.get("avatar_url") or ""
        else:
            msg["user_display_name"] = uid or "Unknown"
            msg["user_avatar"] = ""
    return jsonify(results)


@app.route("/api/stats")
def api_stats():
    stats = get_channel_stats()
    conn = get_db()
    total_msgs = conn.execute("SELECT COUNT(*) as c FROM messages").fetchone()["c"]
    total_users = conn.execute("SELECT COUNT(*) as c FROM users WHERE deleted=0").fetchone()["c"]
    total_channels = conn.execute("SELECT COUNT(*) as c FROM channels").fetchone()["c"]
    total_files = conn.execute("SELECT COUNT(*) as c FROM files").fetchone()["c"]
    oldest = conn.execute("SELECT MIN(ts) as ts FROM messages").fetchone()["ts"]
    conn.close()

    oldest_date = ""
    if oldest:
        try:
            oldest_date = datetime.fromtimestamp(float(oldest)).strftime("%Y-%m-%d")
        except (ValueError, OSError):
            pass

    return jsonify({
        "total_messages": total_msgs,
        "total_users": total_users,
        "total_channels": total_channels,
        "total_files": total_files,
        "oldest_message_date": oldest_date,
        "channels": stats
    })


@app.route("/api/setup/status")
def api_setup_status():
    """Check if the app is configured."""
    token = get_token()
    ws = get_active_workspace()
    workspaces, active_id = list_workspaces()

    conn = get_db()
    has_data = conn.execute("SELECT COUNT(*) as c FROM channels").fetchone()["c"] > 0
    msg_count = conn.execute("SELECT COUNT(*) as c FROM messages").fetchone()["c"]
    last_sync = conn.execute(
        "SELECT MAX(last_synced) as ls FROM sync_state"
    ).fetchone()["ls"]
    conn.close()
    return jsonify({
        "has_token": bool(token),
        "has_data": has_data,
        "sync_running": sync_status["running"],
        "message_count": msg_count,
        "last_synced": last_sync,
        "token_preview": f"{token[:8]}...{token[-4:]}" if token and len(token) > 12 else None,
        "workspace_count": len(workspaces),
        "active_workspace": active_id,
    })


# ── Workspace management ──

@app.route("/api/workspaces")
def api_workspaces():
    """List all configured workspaces."""
    workspaces, active_id = list_workspaces()
    return jsonify({"workspaces": workspaces, "active": active_id})


@app.route("/api/workspaces/switch", methods=["POST"])
def api_switch_workspace():
    """Switch to a different workspace."""
    data = request.get_json()
    team_id = data.get("id")
    if not team_id:
        return jsonify({"error": "Workspace ID required"}), 400
    if set_active_workspace(team_id):
        init_db()  # Re-init for the new workspace DB
        return jsonify({"success": True, "active": team_id})
    return jsonify({"error": "Workspace not found"}), 404


@app.route("/api/workspaces/remove", methods=["POST"])
def api_remove_workspace():
    """Remove a workspace."""
    data = request.get_json()
    team_id = data.get("id")
    if not team_id:
        return jsonify({"error": "Workspace ID required"}), 400
    remove_workspace(team_id)
    return jsonify({"success": True})


@app.route("/api/setup/save-token", methods=["POST"])
def api_save_token():
    """Validate a Slack token and add workspace to config."""
    data = request.get_json()
    token = (data.get("token") or "").strip()
    cookie = (data.get("cookie") or "").strip()

    if not token:
        return jsonify({"error": "Token is required"}), 400

    valid_prefixes = ("xoxp-", "xoxb-", "xoxc-")
    if not any(token.startswith(p) for p in valid_prefixes):
        return jsonify({"error": "Invalid token format. Must start with xoxp-, xoxb-, or xoxc-."}), 400

    if token.startswith("xoxc-") and not cookie:
        return jsonify({"error": "Browser tokens (xoxc-) require the 'd' cookie. Please paste it in the cookie field."}), 400

    # Validate by calling Slack API
    try:
        from slack_sdk import WebClient
        from slack_sdk.errors import SlackApiError
        headers = {}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie
        client = WebClient(token=token, headers=headers)
        resp = client.auth_test()
        team = resp.get("team", "Unknown")
        team_id = resp.get("team_id", "unknown")
        user = resp.get("user", "Unknown")
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack rejected this token: {err}"}), 400
    except Exception as e:
        return jsonify({"error": f"Could not connect to Slack: {str(e)}"}), 400

    # Add/update workspace in multi-workspace config
    add_workspace(team_id, team, "", user, token, cookie)
    init_db()  # Init DB for the newly active workspace

    return jsonify({
        "success": True,
        "team": team,
        "team_id": team_id,
        "user": user,
        "message": f"Connected to {team} as {user}"
    })


def _save_env_vars(vars_dict):
    """Update or insert multiple variables in .env file (legacy, kept for compat)."""
    env_lines = []
    written = set()

    if os.path.exists(ENV_PATH):
        with open(ENV_PATH) as f:
            for line in f:
                key = line.strip().split("=", 1)[0] if "=" in line else ""
                if key in vars_dict:
                    env_lines.append(f"{key}={vars_dict[key]}\n")
                    written.add(key)
                else:
                    env_lines.append(line)

    for key, val in vars_dict.items():
        if key not in written:
            env_lines.append(f"{key}={val}\n")

    with open(ENV_PATH, "w") as f:
        f.writelines(env_lines)


@app.route("/api/sync/channels", methods=["GET"])
def api_sync_channels():
    """Fetch channels the user is a member of from Slack for the picker."""
    token = get_token()
    cookie = get_cookie()
    if not token:
        return jsonify({"error": "No token configured"}), 400

    try:
        from slack_sdk import WebClient
        from slack_sdk.errors import SlackApiError
        headers = {}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie
        client = WebClient(token=token, headers=headers)

        # First, bulk-fetch all users so we can resolve DM names without per-DM API calls
        user_map = {}
        ucursor = None
        while True:
            ukwargs = {"limit": 200}
            if ucursor:
                ukwargs["cursor"] = ucursor
            uresp = client.users_list(**ukwargs)
            for u in uresp.get("members", []):
                profile = u.get("profile", {})
                user_map[u["id"]] = profile.get("display_name") or profile.get("real_name") or u.get("name", u["id"])
            ucursor = uresp.get("response_metadata", {}).get("next_cursor", "")
            if not ucursor:
                break

        # Use users_conversations — only returns channels the user is IN
        channels = []
        cursor = None
        while True:
            kwargs = {"types": "public_channel,private_channel,mpim,im", "limit": 200}
            if cursor:
                kwargs["cursor"] = cursor
            resp = client.users_conversations(**kwargs)

            for ch in resp.get("channels", []):
                is_dm = ch.get("is_im", False)
                is_group = ch.get("is_mpim", False)
                name = ch.get("name", ch.get("user", ""))

                # Resolve DM display name from pre-fetched user map
                display = name
                if is_dm:
                    dm_user_id = ch.get("user", "")
                    display = user_map.get(dm_user_id, dm_user_id)

                channels.append({
                    "id": ch["id"],
                    "name": name,
                    "display_name": display,
                    "is_dm": is_dm,
                    "is_group_dm": is_group,
                    "is_private": ch.get("is_private", False),
                    "is_archived": ch.get("is_archived", False),
                    "num_members": ch.get("num_members", 0),
                })

            cursor = resp.get("response_metadata", {}).get("next_cursor", "")
            if not cursor:
                break

        return jsonify(channels)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/sync", methods=["POST"])
def api_sync():
    """Trigger a sync from the UI. Optionally accepts channel_ids to sync only specific channels."""
    global sync_status
    if sync_status["running"]:
        return jsonify({"status": "already_running", "progress": sync_status["progress"]})

    token = get_token()
    cookie = get_cookie()
    if not token:
        return jsonify({"error": "No Slack token configured. Complete the setup first."}), 400

    # Get optional channel selection
    data = request.get_json(silent=True) or {}
    selected_ids = data.get("channel_ids")  # None = sync all, list = sync selected

    def run_sync():
        global sync_status
        sync_status = {
            "running": True, "progress": "Starting...", "error": None,
            "percent": 0, "phase": "starting", "current": 0, "total": 0,
            "channel_name": "", "messages_synced": 0,
            "started_at": datetime.now().isoformat(), "finished_at": None,
        }
        try:
            from slack_archiver import SlackArchiver
            archiver = SlackArchiver(token, cookie=cookie)

            sync_status.update(phase="workspace", progress="Syncing workspace info...", percent=5)
            archiver.sync_workspace()

            sync_status.update(phase="users", progress="Syncing users...", percent=10)
            archiver.sync_users()

            sync_status.update(phase="channels", progress="Syncing channel list...", percent=20)
            archiver.sync_channels()

            conn = get_db()
            if selected_ids:
                # Only sync selected channels
                placeholders = ",".join("?" * len(selected_ids))
                channels = conn.execute(
                    f"SELECT id, name, is_dm FROM channels WHERE id IN ({placeholders})",
                    selected_ids
                ).fetchall()
            else:
                channels = conn.execute("SELECT id, name, is_dm FROM channels").fetchall()
            conn.close()
            total_channels = len(channels)
            total_msgs = 0

            for i, ch in enumerate(channels):
                ch = dict(ch)
                pct = 20 + int((i / max(total_channels, 1)) * 75)  # 20% → 95%
                sync_status.update(
                    phase="messages",
                    current=i + 1,
                    total=total_channels,
                    channel_name=ch["name"],
                    percent=min(pct, 95),
                    progress=f"Syncing messages ({i+1}/{total_channels}): #{ch['name']}",
                )
                count = archiver.sync_messages(ch["id"], ch["name"])
                total_msgs += count
                sync_status["messages_synced"] = total_msgs

            sync_status.update(
                phase="done", percent=100, current=total_channels, total=total_channels,
                progress=f"Sync complete! {total_msgs} messages archived.",
                finished_at=datetime.now().isoformat(),
            )
        except Exception as e:
            sync_status["error"] = str(e)
            sync_status["progress"] = f"Error: {e}"
            sync_status["finished_at"] = datetime.now().isoformat()
        finally:
            sync_status["running"] = False

    thread = threading.Thread(target=run_sync, daemon=True)
    thread.start()
    return jsonify({"status": "started"})


@app.route("/api/sync/status")
def api_sync_status():
    return jsonify(sync_status)


# ── Live messaging ──

@app.route("/api/channels/<channel_id>/send", methods=["POST"])
def api_send_message(channel_id):
    """Send a message to a Slack channel and save to local DB."""
    token = get_token()
    cookie = get_cookie()
    if not token:
        return jsonify({"error": "No token configured"}), 400

    data = request.get_json()
    text = (data.get("text") or "").strip()
    thread_ts = data.get("thread_ts")

    if not text:
        return jsonify({"error": "Message text is required"}), 400

    try:
        from slack_sdk import WebClient
        from slack_sdk.errors import SlackApiError
        headers = {}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie
        client = WebClient(token=token, headers=headers)

        kwargs = {"channel": channel_id, "text": text}
        if thread_ts:
            kwargs["thread_ts"] = thread_ts

        resp = client.chat_postMessage(**kwargs)
        msg = resp.get("message", {})

        # Store in local DB
        conn = get_db()
        conn.execute("""
            INSERT OR REPLACE INTO messages
            (ts, channel_id, user_id, text, thread_ts, reply_count, reply_users,
             subtype, edited_ts, reactions, attachments, blocks, files, raw_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            msg.get("ts", ""),
            channel_id,
            msg.get("user", ""),
            msg.get("text", text),
            msg.get("thread_ts"),
            0, "[]", "", None, "[]", "[]", "[]", "[]",
            json.dumps(msg)
        ))
        conn.commit()
        conn.close()

        return jsonify({"success": True, "ts": msg.get("ts"), "message": msg})
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/channels/<channel_id>/poll")
def api_poll_messages(channel_id):
    """Fetch new messages from Slack since a given timestamp and save to DB."""
    token = get_token()
    cookie = get_cookie()
    since_ts = request.args.get("since")

    if not token or not since_ts:
        return jsonify([])

    try:
        from slack_sdk import WebClient
        from slack_sdk.errors import SlackApiError
        headers = {}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie
        client = WebClient(token=token, headers=headers)

        resp = client.conversations_history(
            channel=channel_id, oldest=since_ts, limit=50, inclusive=False
        )
        new_msgs = resp.get("messages", [])

        if not new_msgs:
            return jsonify([])

        # Store new messages in DB
        conn = get_db()
        for msg in new_msgs:
            conn.execute("""
                INSERT OR REPLACE INTO messages
                (ts, channel_id, user_id, text, thread_ts, reply_count, reply_users,
                 subtype, edited_ts, reactions, attachments, blocks, files, raw_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                msg.get("ts", ""),
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
        conn.commit()
        conn.close()

        # Enrich with user info for the frontend
        enriched = []
        for msg in reversed(new_msgs):  # reverse to chronological order
            user = get_user(msg.get("user", ""))
            enriched.append({
                **msg,
                "channel_id": channel_id,
                "user_id": msg.get("user", ""),
                "user_display_name": (user.get("display_name") or user.get("real_name") or user.get("name") or msg.get("user", "Unknown")) if user else msg.get("user", "Unknown"),
                "user_avatar": (user.get("avatar_local") or user.get("avatar_url") or "") if user else "",
                "user_color": (user.get("color") or "4A154B") if user else "999999",
                "reactions": msg.get("reactions", []),
                "attachments": msg.get("attachments", []),
                "files": msg.get("files", []),
                "blocks": msg.get("blocks", []),
                "reply_users": msg.get("reply_users", []),
            })

        return jsonify(enriched)
    except Exception:
        return jsonify([])


# ── Helper ──

def _get_slack_client():
    token = get_token()
    cookie = get_cookie()
    if not token:
        return None
    from slack_sdk import WebClient
    headers = {}
    if cookie:
        headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie
    return WebClient(token=token, headers=headers)


# ── Reactions, Editing, Deletion, Pins, Upload, Presence, Identity ──

@app.route("/api/channels/<channel_id>/react", methods=["POST"])
def api_react(channel_id):
    """Add or remove a reaction on a message."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    data = request.get_json()
    name = (data.get("name") or "").strip()
    ts = (data.get("ts") or "").strip()
    action = (data.get("action") or "add").strip()

    if not name or not ts:
        return jsonify({"error": "name and ts are required"}), 400
    if action not in ("add", "remove"):
        return jsonify({"error": "action must be 'add' or 'remove'"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        if action == "add":
            client.reactions_add(channel=channel_id, name=name, timestamp=ts)
        else:
            client.reactions_remove(channel=channel_id, name=name, timestamp=ts)

        # Update local DB reactions
        conn = get_db()
        row = conn.execute(
            "SELECT reactions FROM messages WHERE channel_id=? AND ts=?",
            (channel_id, ts)
        ).fetchone()
        if row:
            try:
                reactions = json.loads(row["reactions"]) if isinstance(row["reactions"], str) else (row["reactions"] or [])
            except (json.JSONDecodeError, TypeError):
                reactions = []

            if action == "add":
                found = False
                for r in reactions:
                    if r.get("name") == name:
                        r["count"] = r.get("count", 0) + 1
                        found = True
                        break
                if not found:
                    reactions.append({"name": name, "count": 1, "users": []})
            else:
                for r in reactions:
                    if r.get("name") == name:
                        r["count"] = max(r.get("count", 1) - 1, 0)
                        break
                reactions = [r for r in reactions if r.get("count", 0) > 0]

            conn.execute(
                "UPDATE messages SET reactions=? WHERE channel_id=? AND ts=?",
                (json.dumps(reactions), channel_id, ts)
            )
            conn.commit()
        conn.close()

        return jsonify({"success": True})
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/messages/<channel_id>/<ts>/edit", methods=["PUT"])
def api_edit_message(channel_id, ts):
    """Edit a message in a Slack channel."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    data = request.get_json()
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        resp = client.chat_update(channel=channel_id, ts=ts, text=text)
        msg = resp.get("message", {})

        # Update local DB
        edited_ts = msg.get("edited", {}).get("ts") if msg.get("edited") else None
        conn = get_db()
        conn.execute(
            "UPDATE messages SET text=?, edited_ts=?, raw_json=? WHERE channel_id=? AND ts=?",
            (msg.get("text", text), edited_ts, json.dumps(msg), channel_id, ts)
        )
        conn.commit()
        conn.close()

        return jsonify({"success": True, "message": msg})
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/messages/<channel_id>/<ts>", methods=["DELETE"])
def api_delete_message(channel_id, ts):
    """Delete a message from a Slack channel."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        client.chat_delete(channel=channel_id, ts=ts)

        # Remove from local DB
        conn = get_db()
        conn.execute(
            "DELETE FROM messages WHERE channel_id=? AND ts=?",
            (channel_id, ts)
        )
        conn.commit()
        conn.close()

        return jsonify({"success": True})
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/channels/<channel_id>/pins")
def api_pins(channel_id):
    """Get pinned messages in a channel."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        resp = client.pins_list(channel=channel_id)
        items = resp.get("items", [])

        pinned = []
        user_cache = {}
        for item in items:
            msg = item.get("message", {})
            uid = msg.get("user", "")
            if uid and uid not in user_cache:
                user_cache[uid] = get_user(uid)
            user = user_cache.get(uid)
            pinned.append({
                "ts": msg.get("ts", ""),
                "text": msg.get("text", ""),
                "user_id": uid,
                "user_display_name": (
                    user.get("display_name") or user.get("real_name") or user.get("name") or uid
                ) if user else uid,
                "user_avatar": (
                    user.get("avatar_local") or user.get("avatar_url") or ""
                ) if user else "",
                "created": item.get("created", ""),
                "type": item.get("type", "message"),
            })

        return jsonify(pinned)
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/channels/<channel_id>/pin", methods=["POST"])
def api_pin_message(channel_id):
    """Pin or unpin a message in a channel."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    data = request.get_json()
    ts = (data.get("ts") or "").strip()
    action = (data.get("action") or "pin").strip()

    if not ts:
        return jsonify({"error": "ts is required"}), 400
    if action not in ("pin", "unpin"):
        return jsonify({"error": "action must be 'pin' or 'unpin'"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        if action == "pin":
            client.pins_add(channel=channel_id, timestamp=ts)
        else:
            client.pins_remove(channel=channel_id, timestamp=ts)

        return jsonify({"success": True})
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/channels/<channel_id>/upload", methods=["POST"])
def api_upload_file(channel_id):
    """Upload a file to a Slack channel."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    uploaded = request.files["file"]
    if not uploaded.filename:
        return jsonify({"error": "Empty filename"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        import io
        file_content = uploaded.read()
        filename = uploaded.filename
        content_type = uploaded.content_type or "application/octet-stream"

        # Try files_upload_v2 first, fall back to files_upload
        file_info = {}
        try:
            resp = client.files_upload_v2(
                channel=channel_id,
                content=file_content,
                filename=filename,
                title=request.form.get("title", filename),
            )
            # v2 returns files in a list
            files_list = resp.get("files", [])
            file_info = files_list[0] if files_list else resp.get("file", {})
        except (SlackApiError, Exception):
            # Fallback to v1
            resp = client.files_upload(
                channels=channel_id,
                content=file_content,
                filename=filename,
                title=request.form.get("title", filename),
            )
            file_info = resp.get("file", {})

        if not file_info:
            return jsonify({"error": "Upload succeeded but no file info returned"}), 500

        # Save file metadata to local DB (matching the files table schema)
        file_id = file_info.get("id", "")
        if file_id:
            conn = get_db()
            conn.execute("""
                INSERT OR REPLACE INTO files
                (id, name, title, mimetype, filetype, size, url_private, thumb_url,
                 local_path, thumb_local, user_id, channel_id, message_ts, created, raw_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                file_id,
                file_info.get("name", filename),
                file_info.get("title", filename),
                file_info.get("mimetype", content_type),
                file_info.get("filetype", ""),
                file_info.get("size", len(file_content)),
                file_info.get("url_private", ""),
                file_info.get("thumb_360", file_info.get("thumb_160", "")),
                file_info.get("url_private", ""),
                file_info.get("thumb_360", ""),
                file_info.get("user", ""),
                channel_id,
                "",
                file_info.get("created", 0),
                json.dumps(file_info)
            ))
            conn.commit()
            conn.close()

        return jsonify({"success": True, "file": file_info})
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/users/<user_id>/presence")
def api_user_presence(user_id):
    """Get a user's presence status."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        resp = client.users_getPresence(user=user_id)
        presence = resp.get("presence", "away")
        return jsonify({
            "presence": presence,
            "online": presence == "active",
        })
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/file/<file_id>")
def api_proxy_file(file_id):
    """Proxy a Slack file through our server with auth + cache locally."""
    import requests as http_requests

    FILES_DIR = os.path.join(os.path.dirname(__file__), "static", "files")
    os.makedirs(FILES_DIR, exist_ok=True)

    # 1. Check if we already have it cached locally
    conn = get_db()
    row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    conn.close()

    if not row:
        return jsonify({"error": "File not found"}), 404

    file_row = dict(row)
    name = file_row.get("name", f"file_{file_id}")
    mimetype = file_row.get("mimetype", "application/octet-stream")
    safe_name = f"{file_id}_{name}"
    local_path = os.path.join(FILES_DIR, safe_name)

    # 2. If cached locally, serve directly
    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        from flask import send_file
        return send_file(local_path, mimetype=mimetype, download_name=name)

    # 3. Download from Slack with auth
    url = file_row.get("url_private", "")
    if not url:
        return jsonify({"error": "No URL for this file"}), 404

    token = get_token()
    cookie = get_cookie()
    if not token:
        return jsonify({"error": "No token configured"}), 400

    try:
        headers = {"Authorization": f"Bearer {token}"}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie

        resp = http_requests.get(url, headers=headers, timeout=60, stream=True)
        if resp.status_code != 200:
            return jsonify({"error": f"Slack returned {resp.status_code}"}), 502

        # Save to local cache
        with open(local_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)

        # Update DB with local path
        conn = get_db()
        conn.execute(
            "UPDATE files SET local_path=? WHERE id=?",
            (f"/static/files/{safe_name}", file_id)
        )
        conn.commit()
        conn.close()

        from flask import send_file
        return send_file(local_path, mimetype=mimetype, download_name=name)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/file/<file_id>/thumb")
def api_proxy_thumb(file_id):
    """Proxy a file thumbnail."""
    import requests as http_requests

    FILES_DIR = os.path.join(os.path.dirname(__file__), "static", "files")
    os.makedirs(FILES_DIR, exist_ok=True)

    conn = get_db()
    row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    conn.close()

    if not row:
        return jsonify({"error": "File not found"}), 404

    file_row = dict(row)
    thumb_url = file_row.get("thumb_url", "")
    if not thumb_url:
        return jsonify({"error": "No thumbnail"}), 404

    safe_name = f"{file_id}_thumb.jpg"
    local_path = os.path.join(FILES_DIR, safe_name)

    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        from flask import send_file
        return send_file(local_path, mimetype="image/jpeg")

    token = get_token()
    cookie = get_cookie()
    if not token:
        return jsonify({"error": "No token configured"}), 400

    try:
        headers = {"Authorization": f"Bearer {token}"}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie

        resp = http_requests.get(thumb_url, headers=headers, timeout=30)
        if resp.status_code == 200:
            with open(local_path, "wb") as f:
                f.write(resp.content)
            conn = get_db()
            conn.execute(
                "UPDATE files SET thumb_local=? WHERE id=?",
                (f"/static/files/{safe_name}", file_id)
            )
            conn.commit()
            conn.close()

        from flask import send_file
        return send_file(local_path, mimetype="image/jpeg")
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Batch file download ──

media_download_status = {
    "running": False, "downloaded": 0, "total": 0, "failed": 0,
    "current_file": "", "error": None
}

@app.route("/api/files/download-all", methods=["POST"])
def api_download_all_files():
    """Background-download all files that haven't been cached locally yet."""
    global media_download_status
    if media_download_status["running"]:
        return jsonify({"status": "already_running", **media_download_status})

    token = get_token()
    cookie = get_cookie()
    if not token:
        return jsonify({"error": "No token configured"}), 400

    def run_download():
        global media_download_status
        import requests as http_requests

        FILES_DIR = os.path.join(os.path.dirname(__file__), "static", "files")
        os.makedirs(FILES_DIR, exist_ok=True)

        conn = get_db()
        all_files = conn.execute(
            "SELECT id, name, url_private, thumb_url, mimetype FROM files WHERE url_private IS NOT NULL AND url_private != ''"
        ).fetchall()
        conn.close()

        total = len(all_files)
        downloaded = 0
        failed = 0
        skipped = 0

        media_download_status = {
            "running": True, "downloaded": 0, "total": total,
            "failed": 0, "skipped": 0, "current_file": "", "error": None
        }

        headers = {"Authorization": f"Bearer {token}"}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie

        for row in all_files:
            f = dict(row)
            file_id = f["id"]
            name = f.get("name", f"file_{file_id}")
            url = f.get("url_private", "")
            safe_name = f"{file_id}_{name}"
            local_path = os.path.join(FILES_DIR, safe_name)

            media_download_status["current_file"] = name

            # Skip if already cached
            if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
                skipped += 1
                downloaded += 1
                media_download_status.update(downloaded=downloaded, skipped=skipped)
                continue

            if not url or url.startswith('/static/'):
                skipped += 1
                downloaded += 1
                media_download_status.update(downloaded=downloaded, skipped=skipped)
                continue

            try:
                resp = http_requests.get(url, headers=headers, timeout=60, stream=True)
                if resp.status_code == 200:
                    with open(local_path, "wb") as out:
                        for chunk in resp.iter_content(chunk_size=8192):
                            out.write(chunk)
                    # Update DB
                    conn2 = get_db()
                    conn2.execute(
                        "UPDATE files SET local_path=? WHERE id=?",
                        (f"/static/files/{safe_name}", file_id)
                    )
                    conn2.commit()
                    conn2.close()
                    downloaded += 1
                else:
                    failed += 1
            except Exception:
                failed += 1

            media_download_status.update(downloaded=downloaded, failed=failed)

            # Also download thumbnail
            thumb_url = f.get("thumb_url", "")
            if thumb_url and not thumb_url.startswith('/static/'):
                thumb_name = f"{file_id}_thumb.jpg"
                thumb_path = os.path.join(FILES_DIR, thumb_name)
                if not os.path.exists(thumb_path):
                    try:
                        tresp = http_requests.get(thumb_url, headers=headers, timeout=30)
                        if tresp.status_code == 200:
                            with open(thumb_path, "wb") as out:
                                out.write(tresp.content)
                            conn3 = get_db()
                            conn3.execute(
                                "UPDATE files SET thumb_local=? WHERE id=?",
                                (f"/static/files/{thumb_name}", file_id)
                            )
                            conn3.commit()
                            conn3.close()
                    except Exception:
                        pass

        media_download_status.update(
            running=False, downloaded=downloaded,
            current_file="Done!", error=None
        )

    thread = threading.Thread(target=run_download, daemon=True)
    thread.start()
    return jsonify({"status": "started", "total": 0})


@app.route("/api/files/download-status")
def api_download_status():
    """Get the status of the batch file download."""
    return jsonify(media_download_status)


@app.route("/api/token-health")
def api_token_health():
    """Check if the current token is still valid."""
    client = _get_slack_client()
    if not client:
        return jsonify({"valid": False, "error": "no_token", "message": "No token configured"})

    try:
        from slack_sdk.errors import SlackApiError
        resp = client.auth_test()
        return jsonify({
            "valid": True,
            "user": resp.get("user", ""),
            "team": resp.get("team", ""),
        })
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({
            "valid": False,
            "error": err,
            "message": f"Token expired or revoked: {err}",
        })
    except Exception as e:
        return jsonify({
            "valid": False,
            "error": "connection_error",
            "message": f"Could not reach Slack: {str(e)}",
        })


@app.route("/api/me")
def api_me():
    """Get the current authenticated user's identity."""
    client = _get_slack_client()
    if not client:
        return jsonify({"error": "No token configured"}), 400

    try:
        from slack_sdk.errors import SlackApiError
        resp = client.auth_test()
        return jsonify({
            "user_id": resp.get("user_id", ""),
            "user": resp.get("user", ""),
            "team": resp.get("team", ""),
        })
    except SlackApiError as e:
        err = e.response.get("error", str(e)) if hasattr(e, "response") else str(e)
        return jsonify({"error": f"Slack error: {err}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # Migrate from old .env single-workspace to multi-workspace config
    migrate_from_env()
    init_db()
    app.run(debug=True, host="0.0.0.0", port=5001)
