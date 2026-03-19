"""SQLite database models for Slack archive."""

import sqlite3
import os
import json
from datetime import datetime

# Default fallback — overridden by workspace_config at runtime
_DEFAULT_DB = os.path.join(os.path.dirname(__file__), "data", "slack_archive.db")


def _get_db_path():
    """Get the DB path for the active workspace."""
    try:
        from workspace_config import get_db_path_for_workspace
        return get_db_path_for_workspace()
    except Exception:
        return _DEFAULT_DB


def get_db(db_path=None):
    """Get a database connection. Uses active workspace DB by default."""
    path = db_path or _get_db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=OFF")
    return conn


def init_db(db_path=None):
    """Initialize the database schema."""
    conn = get_db(db_path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY,
            name TEXT,
            domain TEXT,
            icon_url TEXT,
            synced_at TEXT
        );

        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            team_id TEXT,
            name TEXT,
            real_name TEXT,
            display_name TEXT,
            email TEXT,
            avatar_url TEXT,
            avatar_local TEXT,
            is_bot INTEGER DEFAULT 0,
            is_admin INTEGER DEFAULT 0,
            status_text TEXT,
            status_emoji TEXT,
            title TEXT,
            color TEXT,
            deleted INTEGER DEFAULT 0,
            raw_json TEXT
        );

        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            name TEXT,
            topic TEXT,
            purpose TEXT,
            is_private INTEGER DEFAULT 0,
            is_dm INTEGER DEFAULT 0,
            is_group_dm INTEGER DEFAULT 0,
            is_archived INTEGER DEFAULT 0,
            created INTEGER,
            creator TEXT,
            num_members INTEGER DEFAULT 0,
            members TEXT,
            raw_json TEXT,
            FOREIGN KEY (creator) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            ts TEXT,
            channel_id TEXT,
            user_id TEXT,
            text TEXT,
            thread_ts TEXT,
            reply_count INTEGER DEFAULT 0,
            reply_users TEXT,
            subtype TEXT,
            edited_ts TEXT,
            reactions TEXT,
            attachments TEXT,
            blocks TEXT,
            files TEXT,
            raw_json TEXT,
            PRIMARY KEY (ts, channel_id),
            FOREIGN KEY (channel_id) REFERENCES channels(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            name TEXT,
            title TEXT,
            mimetype TEXT,
            filetype TEXT,
            size INTEGER,
            url_private TEXT,
            thumb_url TEXT,
            local_path TEXT,
            thumb_local TEXT,
            user_id TEXT,
            channel_id TEXT,
            message_ts TEXT,
            created INTEGER,
            raw_json TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS sync_state (
            channel_id TEXT PRIMARY KEY,
            oldest_ts TEXT,
            latest_ts TEXT,
            last_synced TEXT,
            fully_synced INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, ts);
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_ts, channel_id);
        CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
        CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel_id);
        CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_ts, channel_id);
    """)
    conn.commit()
    conn.close()


# ── Query helpers ──

def get_all_channels(include_dms=True):
    """Get all channels ordered by name."""
    conn = get_db()
    if include_dms:
        rows = conn.execute(
            "SELECT * FROM channels ORDER BY is_dm, is_group_dm, name"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM channels WHERE is_dm=0 AND is_group_dm=0 ORDER BY name"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_channel(channel_id):
    """Get a single channel."""
    conn = get_db()
    row = conn.execute("SELECT * FROM channels WHERE id=?", (channel_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_messages(channel_id, limit=50, before_ts=None, after_ts=None):
    """Get messages for a channel, paginated."""
    conn = get_db()
    query = "SELECT * FROM messages WHERE channel_id=? AND (thread_ts IS NULL OR thread_ts=ts)"
    params = [channel_id]

    if before_ts:
        query += " AND ts < ?"
        params.append(before_ts)
    if after_ts:
        query += " AND ts > ?"
        params.append(after_ts)

    query += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in reversed(rows)]


def get_thread_messages(channel_id, thread_ts):
    """Get all messages in a thread."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM messages WHERE channel_id=? AND thread_ts=? ORDER BY ts",
        (channel_id, thread_ts)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_user(user_id):
    """Get a single user."""
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_all_users():
    """Get all users."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM users WHERE deleted=0 ORDER BY display_name, real_name"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_messages(query, channel_id=None, limit=50):
    """Full-text search across messages."""
    conn = get_db()
    sql = "SELECT m.*, c.name as channel_name FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.text LIKE ?"
    params = [f"%{query}%"]

    if channel_id:
        sql += " AND m.channel_id=?"
        params.append(channel_id)

    sql += " ORDER BY m.ts DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_channel_stats():
    """Get message counts per channel."""
    conn = get_db()
    rows = conn.execute("""
        SELECT c.id, c.name, c.is_dm, c.is_group_dm,
               COUNT(m.ts) as message_count,
               MIN(m.ts) as oldest_message,
               MAX(m.ts) as newest_message
        FROM channels c
        LEFT JOIN messages m ON c.id = m.channel_id
        GROUP BY c.id
        ORDER BY message_count DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_workspace():
    """Get workspace info."""
    conn = get_db()
    row = conn.execute("SELECT * FROM workspace LIMIT 1").fetchone()
    conn.close()
    return dict(row) if row else None
