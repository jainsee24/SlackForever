"""
SlackForever Desktop App
Opens the app in a native window — no browser, no visible localhost.
"""

import sys
import os
import threading
import time
import socket

# Ensure we're running from the project directory
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from app import app
from models import init_db
from workspace_config import migrate_from_env


def find_free_port():
    """Find a free port on localhost."""
    for port in range(5000, 5020):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', port))
            s.close()
            return port
        except OSError:
            continue
    return 5099


def start_server(port):
    """Start Flask in a background thread."""
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)  # Suppress Flask logs in native app
    app.run(host='127.0.0.1', port=port, debug=False, use_reloader=False)


def main():
    migrate_from_env()
    init_db()

    port = find_free_port()
    url = f'http://127.0.0.1:{port}'

    # Start Flask server in background thread
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # Wait for server to be ready
    for _ in range(50):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.connect(('127.0.0.1', port))
            s.close()
            break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.1)

    # Try to open in native window via pywebview
    try:
        import webview

        window = webview.create_window(
            'SlackForever',
            url,
            width=1280,
            height=800,
            min_size=(900, 600),
            text_select=True,
            zoomable=True,
        )
        webview.start(
            gui='cef' if sys.platform == 'win32' else None,
            debug=False,
        )
    except ImportError:
        # pywebview not installed — fall back to browser
        print(f'pywebview not installed. Install it with: pip install pywebview')
        print(f'Falling back to browser...')
        import webbrowser
        webbrowser.open(url)
        # Keep the process alive
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    except Exception as e:
        # Any webview error — fall back to browser
        print(f'Native window failed ({e}). Opening in browser...')
        import webbrowser
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
