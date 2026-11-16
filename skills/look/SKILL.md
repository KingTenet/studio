---
name: look
description: >
  Take a screenshot of a page of the app and look at it, to check how a UI change came out. Use after
  changing anything in web/, on "/look <path>" (such as /look /todo), "look at the page", "how does it look".
argument-hint: <path>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/look.sh *), Read
---

# Look at a page of the app

1. Take the screenshot (the path is the page to look at, `/` when none was given):

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/look.sh $ARGUMENTS
   ```

   It prints the PNG's path. If it fails, say what it printed, in plain words, and stop.

2. Read the PNG with the Read tool, so you see the page as it is now.

3. Say in a sentence or two what the page shows. When you were checking a change, say whether it
   came out as intended; fix what's wrong and look again.
