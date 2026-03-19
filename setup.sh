#!/bin/bash
set -e

echo "============================================"
echo "  Slack Archive Viewer — Setup"
echo "============================================"
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 is not installed."
    exit 1
fi

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

echo "Activating virtual environment..."
source venv/bin/activate

echo "Installing dependencies..."
pip install -r requirements.txt -q

# Create .env if missing
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo ""
    echo "Created .env file. Please add your Slack token:"
    echo "  1. Go to https://api.slack.com/apps"
    echo "  2. Click 'Create New App' → 'From scratch'"
    echo "  3. Name it anything (e.g. 'Archive Bot')"
    echo "  4. Pick your workspace"
    echo "  5. Go to 'OAuth & Permissions'"
    echo "  6. Add these User Token Scopes:"
    echo "       - channels:history"
    echo "       - channels:read"
    echo "       - files:read"
    echo "       - groups:history"
    echo "       - groups:read"
    echo "       - im:history"
    echo "       - im:read"
    echo "       - mpim:history"
    echo "       - mpim:read"
    echo "       - users:read"
    echo "       - users:read.email"
    echo "  7. Click 'Install to Workspace' and authorize"
    echo "  8. Copy the 'User OAuth Token' (starts with xoxp-)"
    echo "  9. Paste it in .env: SLACK_TOKEN=xoxp-..."
    echo ""
fi

echo "Creating data directories..."
mkdir -p data static/avatars static/files

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit .env and add your SLACK_TOKEN"
echo "  2. Run: ./run.sh"
echo ""
