# Studio

A harness for building one web app with Claude Code, a feature at a time, without needing to know git.

Studio runs in the browser at http://localhost:4000. The page has three columns:

- **Feature and versions** (left): the feature being built, and the versions kept so far.
- **The app, its artifacts and a drawing board** (middle): the app runs live from its dev server on http://localhost:4001.
- **The chat with Claude** (right): type or dictate. Claude works in a [herdr](https://github.com/herdr) pane you never have to look at.

The app lives in its own repo, next to this one (`~/Studio/<app>`). Studio keeps its own state in `~/.studio`:

- `config.json`: the app's folder and name, and the cockpit's settings.
- Logs, drawings, uploads and the artifact registry.

## Layout

- `scripts/lib/studio-server.js`: the local server behind the page. It serves the cockpit and the API for chat, artifacts, drawing, uploads, dictation and jobs.
- `scripts/`: the jobs the cockpit's buttons run (start or resume Claude, rebuild the artifact index, write the summary) and `cc-command.sh` (slash commands queued for the pane).
- `web/`: the cockpit page (React, built into a single `web/dist/cockpit.html`).
- `hooks/studio-hook.py`: Claude Code hooks that tell the cockpit which session a pane runs and pass on what the page showed.
- `claude/settings.json`: the settings Claude runs with inside the studio (`claude --settings`).
- `skills/`: the skills Claude has here: artifact-index, debrief, diagnose, grill-me, handoff, prototype, tdd, worktree-summary.

## Develop

```sh
cd web && pnpm install && pnpm build             # the cockpit page
node scripts/lib/studio-server.js                # http://localhost:4000 (STUDIO_HOME, STUDIO_PORT)
node --test scripts/lib/*.test.js                # server and script tests
cd web && pnpm test && pnpm lint                 # page tests
```

Set `STUDIO_DIR` to this folder in the environment Claude runs in, because the hooks and skills find their scripts through it.
