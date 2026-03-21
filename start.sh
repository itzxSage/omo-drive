#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="omo-drive"
PROJECT_DIR="/Users/jrsgagne/Development/omo-drive"

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo "Error: tmux is not installed."
    exit 1
fi

stop_session() {
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        tmux kill-session -t "$SESSION_NAME"
        echo "✓ tmux session '$SESSION_NAME' killed."
    else
        echo "! tmux session '$SESSION_NAME' not found."
    fi
}

show_status() {
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "✓ tmux session '$SESSION_NAME' is running."
        tmux list-windows -t "$SESSION_NAME"
    else
        echo "! tmux session '$SESSION_NAME' is not running."
    fi
}

# Handle arguments
if [[ $# -gt 0 ]]; then
    case "$1" in
        --stop)
            stop_session
            exit 0
            ;;
        --status)
            show_status
            exit 0
            ;;
        *)
            echo "Usage: $0 [--stop|--status]"
            exit 1
            ;;
    esac
fi

# Create session if it doesn't exist
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    # Start session with window 1 named 'opencode'
    tmux new-session -d -s "$SESSION_NAME" -n "opencode" -c "$PROJECT_DIR"
    # Create window 2 named 'server'
    tmux new-window -t "$SESSION_NAME":2 -n "server" -c "$PROJECT_DIR"
else
    # Check for window 1
    if ! tmux list-windows -t "$SESSION_NAME" | grep -q "^1:"; then
        tmux new-window -t "$SESSION_NAME":1 -n "opencode" -c "$PROJECT_DIR"
    fi
    # Check for window 2
    if ! tmux list-windows -t "$SESSION_NAME" | grep -q "^2:"; then
        tmux new-window -t "$SESSION_NAME":2 -n "server" -c "$PROJECT_DIR"
    fi
fi

# Ensure opencode serve is running in window 1
tmux send-keys -t "$SESSION_NAME":1 "opencode serve" Enter

# Ensure bun run start is running in window 2
tmux send-keys -t "$SESSION_NAME":2 "bun run start" Enter

echo "✓ opencode serve running in tmux:$SESSION_NAME:1"
echo "✓ omo-drive server running in tmux:$SESSION_NAME:2"
echo "Use 'tmux attach -t $SESSION_NAME' to view."
