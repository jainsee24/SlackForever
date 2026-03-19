"""Multi-workspace configuration manager.

Stores workspace configs in data/workspaces.json.
Each workspace gets its own SQLite DB: data/{team_id}.db
"""

import os
import json

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
CONFIG_PATH = os.path.join(DATA_DIR, "workspaces.json")


def _load_config():
    """Load workspaces config from JSON file."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {"workspaces": [], "active": None}


def _save_config(config):
    """Save workspaces config to JSON file."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)


def list_workspaces():
    """List all configured workspaces (without exposing tokens)."""
    config = _load_config()
    result = []
    for ws in config["workspaces"]:
        result.append({
            "id": ws["id"],
            "name": ws["name"],
            "domain": ws.get("domain", ""),
            "user": ws.get("user", ""),
            "icon_url": ws.get("icon_url", ""),
            "db_path": ws.get("db_path", ""),
            "added_at": ws.get("added_at", ""),
        })
    return result, config.get("active")


def get_active_workspace():
    """Get the currently active workspace config (with token/cookie)."""
    config = _load_config()
    active_id = config.get("active")
    if not active_id and config["workspaces"]:
        active_id = config["workspaces"][0]["id"]
    for ws in config["workspaces"]:
        if ws["id"] == active_id:
            return ws
    return None


def set_active_workspace(team_id):
    """Switch the active workspace."""
    config = _load_config()
    for ws in config["workspaces"]:
        if ws["id"] == team_id:
            config["active"] = team_id
            _save_config(config)
            return True
    return False


def add_workspace(team_id, name, domain, user, token, cookie=None, icon_url=""):
    """Add or update a workspace."""
    from datetime import datetime
    config = _load_config()

    db_name = f"ws_{team_id}.db"
    db_path = os.path.join(DATA_DIR, db_name)

    # Check if workspace already exists — update it
    for ws in config["workspaces"]:
        if ws["id"] == team_id:
            ws.update({
                "name": name,
                "domain": domain,
                "user": user,
                "token": token,
                "cookie": cookie or "",
                "icon_url": icon_url,
                "db_path": db_path,
            })
            config["active"] = team_id
            _save_config(config)
            return ws

    # New workspace
    ws = {
        "id": team_id,
        "name": name,
        "domain": domain,
        "user": user,
        "token": token,
        "cookie": cookie or "",
        "icon_url": icon_url,
        "db_path": db_path,
        "added_at": datetime.now().isoformat(),
    }
    config["workspaces"].append(ws)
    config["active"] = team_id
    _save_config(config)
    return ws


def remove_workspace(team_id):
    """Remove a workspace config (doesn't delete the DB)."""
    config = _load_config()
    config["workspaces"] = [ws for ws in config["workspaces"] if ws["id"] != team_id]
    if config["active"] == team_id:
        config["active"] = config["workspaces"][0]["id"] if config["workspaces"] else None
    _save_config(config)


def get_db_path_for_workspace(team_id=None):
    """Get the SQLite DB path for a workspace. If no team_id, use active workspace."""
    if team_id:
        config = _load_config()
        for ws in config["workspaces"]:
            if ws["id"] == team_id:
                return ws.get("db_path", os.path.join(DATA_DIR, f"ws_{team_id}.db"))

    ws = get_active_workspace()
    if ws:
        return ws.get("db_path", os.path.join(DATA_DIR, f"ws_{ws['id']}.db"))

    # Fallback to the old single-db path
    return os.path.join(DATA_DIR, "slack_archive.db")


def migrate_from_env():
    """Migrate from old .env single-workspace setup to multi-workspace config."""
    config = _load_config()
    if config["workspaces"]:
        return  # Already has workspaces, skip migration

    # Check if old .env + DB exist
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    old_db = os.path.join(DATA_DIR, "slack_archive.db")

    token = ""
    cookie = ""
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("SLACK_TOKEN=") and not line.startswith("#"):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
                elif line.startswith("SLACK_COOKIE=") and not line.startswith("#"):
                    cookie = line.split("=", 1)[1].strip().strip('"').strip("'")

    if not token:
        return

    # Validate token and get workspace info
    try:
        from slack_sdk import WebClient
        headers = {}
        if cookie:
            headers["cookie"] = f"d={cookie}" if not cookie.startswith("d=") else cookie
        client = WebClient(token=token, headers=headers)
        resp = client.auth_test()
        team_id = resp.get("team_id", "unknown")
        team_name = resp.get("team", "Workspace")
        user = resp.get("user", "")

        # Add workspace
        new_db = os.path.join(DATA_DIR, f"ws_{team_id}.db")

        # If old DB exists, rename it to the new path
        if os.path.exists(old_db) and not os.path.exists(new_db):
            import shutil
            shutil.move(old_db, new_db)
            # Also move WAL/SHM files if they exist
            for ext in ["-wal", "-shm"]:
                old_f = old_db + ext
                if os.path.exists(old_f):
                    shutil.move(old_f, new_db + ext)

        add_workspace(team_id, team_name, "", user, token, cookie)
    except Exception:
        # If validation fails, still add with what we have
        if token:
            add_workspace("migrated", "Workspace", "", "", token, cookie)
