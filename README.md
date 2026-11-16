# Studio

A harness for building one web app with Claude Code, a feature at a time, without needing to know git.

Studio runs in the browser at http://localhost:4000. The page has three columns:

- **Feature and versions** (left): the feature being built, and the versions kept so far.
- **The app, its artifacts and a drawing board** (middle): the app runs live from its dev server on http://localhost:4001.
- **The chat with Claude** (right): type or dictate. Claude works in a [herdr](https://github.com/herdr) pane you never have to look at.

The app lives in its own repo, next to this one (`~/Studio/<app>`). Studio keeps its own state in `~/.studio`:

- `config.json`: the app's folder and name, and the cockpit's settings.
- `features/<app>/`: the feature being built, its checkpoints, a snapshot of the app's `data/` for each, and pushes still to retry (`scripts/lib/feature.js`).
- Logs, drawings, uploads and the artifact registry. Dictated clips are kept only with `"keepDictationClips": true` in `config.json`, for looking into text that came out wrong.

## Start it

```sh
studio up
```

This updates Studio, starts its herdr workspace (Claude, the cockpit's server, the app's dev server and whisper-server for dictation, one tab each) and opens the cockpit. Running it again reuses the workspace that's already running. `studio up --dry-run` prints what each tab would run.

## Layout

- `bin/studio`: the `studio up` command.
- `scripts/lib/studio-server.js`: the local server behind the page. It serves the cockpit and the API for chat, artifacts, drawing, uploads, dictation and jobs.
- `scripts/lib/feature.js`: features and checkpoints. The app's repo has `main` (the versions kept) and `develop` (the feature being built). Starting a feature resets `develop` to `main`; after every turn that changed files, the Stop hook commits a checkpoint on `develop`, labelled from the reply's `Checkpoint:` line, snapshots `data/` and pushes in the background (a failed push is retried with the next one and by `studio up`).
- `scripts/`: the jobs the cockpit's buttons run (start or resume Claude, rebuild the artifact index, write the summary) and `cc-command.sh` (slash commands queued for the pane).
- `web/`: the cockpit page (React, built into a single `web/dist/cockpit.html`).
- `hooks/studio-hook.py`: Claude Code hooks that tell the cockpit which session a pane runs and pass on what the page showed.
- `claude/settings.json`: the settings Claude runs with inside the studio (`claude --settings`).
- `skills/`: the skills Claude has here: artifact-index, debrief, diagnose, grill-me, handoff, look (a screenshot of a page of the app, by `scripts/look.sh`), prototype, seed-data (runs the app's `scripts/seed-data.ts`), tdd, worktree-summary. Claude loads them with this folder as a plugin (`claude --plugin-dir`, named in `.claude-plugin/plugin.json`), so each can also be called as `/studio:<name>`.

## Develop

```sh
cd web && pnpm install && pnpm build             # the cockpit page
node scripts/lib/studio-server.js                # http://localhost:4000 (STUDIO_HOME, STUDIO_PORT)
node --test scripts/lib/*.test.js                # server and script tests
cd web && pnpm test && pnpm lint                 # page tests
```

`studio up` sets `STUDIO_DIR` to this folder in the environment Claude runs in, because the hooks and skills find their scripts through it. To try it without touching a real app or session: `STUDIO_HOME=<a temp folder with a config.json> STUDIO_PORT=<free port> STUDIO_WORKSPACE=studio-test STUDIO_CLAUDE_CMD='sleep 86400' STUDIO_NO_OPEN=1 bin/studio up`.
