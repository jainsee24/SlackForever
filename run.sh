#!/bin/bash
set -e

cd "$(dirname "$0")"

# Activate virtual environment
if [ -d "venv" ]; then
    source venv/bin/activate
else
    echo "Virtual environment not found. Run ./setup.sh first."
    exit 1
fi

# Check for .env
if [ ! -f ".env" ]; then
    echo "No .env file found. Run ./setup.sh first."
    exit 1
fi

MODE="${1:-web}"

case "$MODE" in
    sync)
        echo "Starting Slack data sync..."
        echo "(This may take a while depending on workspace size)"
        echo ""
        python3 slack_archiver.py
        ;;
    web)
        echo "============================================"
        echo "  Slack Archive Viewer"
        echo "============================================"
        echo ""
        echo "  Open in browser: http://localhost:5000"
        echo ""
        echo "  You can also sync from the web UI."
        echo "  Press Ctrl+C to stop."
        echo ""
        python3 app.py
        ;;
    both)
        echo "Syncing data first, then starting web server..."
        python3 slack_archiver.py
        echo ""
        echo "Starting web server..."
        echo "  Open: http://localhost:5000"
        python3 app.py
        ;;
    *)
        echo "Usage: ./run.sh [web|sync|both]"
        echo ""
        echo "  web   — Start the web viewer (default)"
        echo "  sync  — Download/update messages from Slack"
        echo "  both  — Sync first, then start viewer"
        ;;
esac
