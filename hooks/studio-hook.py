#!/usr/bin/env python3
"""Claude Code hooks for the studio, run from claude/settings.json.

  session-start   notes which session this herdr pane's Claude runs (herdr only learns it at SessionStart,
                  so a /branch would leave it stale); the cockpit's chat and the reaper read it.
  prompt-submit   the same, then gives Claude what the cockpit page showed when the message was sent
                  (studio-server.js notePageContext), once: only for the prompt that message became.

Reads the hook's JSON event on stdin; whatever it prints to stdout on prompt-submit is added to the prompt.
"""
import json
import os
import sys
import time

STATE = os.path.expanduser("~/.claude/state")
PANES_DIR = os.path.join(STATE, "panes")
PAGE_CONTEXT_DIR = os.path.join(STATE, "page-context")
PAGE_CONTEXT_FRESH_S = 60


def pane_file(directory, pane):
    return os.path.join(directory, pane.replace(":", "_") + ".json")


def record_pane(event):
    pane, session_id = os.environ.get("HERDR_PANE_ID"), event.get("session_id")
    if not pane or not session_id or event.get("agent_id"):
        return
    path = pane_file(PANES_DIR, pane)
    try:
        with open(path) as f:
            if json.load(f).get("session_id") == session_id:
                return
    except (OSError, ValueError):
        pass
    os.makedirs(PANES_DIR, exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump({"pane_id": pane, "session_id": session_id, "transcript_path": event.get("transcript_path")}, f)
    os.replace(path + ".tmp", path)


def take_page_context():
    pane = os.environ.get("HERDR_PANE_ID")
    if not pane:
        return None
    path = pane_file(PAGE_CONTEXT_DIR, pane)
    try:
        with open(path) as f:
            note = json.load(f)
        os.remove(path)
    except (OSError, ValueError):
        return None
    if time.time() * 1000 - note.get("at", 0) > PAGE_CONTEXT_FRESH_S * 1000:
        return None
    return note.get("context") or None


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        event = json.load(sys.stdin)
    except ValueError:
        event = {}
    record_pane(event)
    if command == "prompt-submit":
        page = take_page_context()
        if page:
            print(f"[page] Sent from a page showing: {page}")


if __name__ == "__main__":
    main()
