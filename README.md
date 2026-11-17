# Studio

A harness for building one web app with Claude Code, a feature at a time, without needing to know git.

Studio runs in the browser at http://localhost:4000. The page has three columns:

- **Feature and versions** (left): the feature being built, and the versions kept so far.
- **The app, its artifacts and a drawing board** (middle): the app runs live from its dev server on http://localhost:4001.
- **The chat with Claude** (right): type or dictate. Claude works in a [herdr](https://github.com/herdr) pane you never have to look at.

The app lives in its own repo, next to this one (`~/Studio/<app>`). Studio keeps its own state in `~/.studio`:

- `config.json`: the app's folder and name, and the cockpit's settings.
- `features/<app>/`: the feature being built, its checkpoints, a snapshot of the app's `data/` for each, pushes still to retry, and the chat's Ask / Plan / Build mode (`scripts/lib/feature.js`).
- Logs, drawings, uploads and the artifact registry. Dictated clips are kept only with `"keepDictationClips": true` in `config.json`, for looking into text that came out wrong.

## Set it up

Once per Mac, paste this into Terminal (no git or GitHub account needed beforehand):

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/KingTenet/studio/main/bootstrap.sh)" -- --app my-app --collaborator <your GitHub user>
```

`bootstrap.sh` gets git if the Mac has none (Homebrew's installer brings Apple's command-line tools), clones this repo into `~/Studio/studio` (or updates it), and runs `install.sh` with the arguments after `--`. Use the `bash -c "$(curl …)"` form, not `curl … | bash`: through a pipe, `install.sh`'s questions would read the script instead of your answers. From an existing checkout, `./install.sh …` does the same without the first two steps.

It installs Homebrew if needed, then herdr, Node, pnpm, `gh`, whisper-cpp (and its model, in `~/.whisper`), Claude Code and Chrome; logs into GitHub and Claude with your accounts; lets herdr see Claude's sessions (`herdr integration install claude`); asks for your name and email for git if they aren't set; links `studio` into `~/.local/bin` (added to the PATH in `~/.zprofile`); and builds the cockpit. With `--app` it then runs `studio new` for that app (below); without it, no app is made. Running it again is safe: finished steps are skipped and your apps and `config.json` are never written over.

Each app, the first included, is made with:

```sh
studio new <app> [--collaborator <GitHub user>]
```

It creates the app in `~/Studio/<app>` from `template/app.bundle` (versions v1 and v2, with `develop` = `main`), or clones it if your GitHub account already has that repo (a new Mac); makes it a private GitHub repo with everything pushed and invites the collaborator; puts `~/Applications/<app>.app` there, which runs `studio run <app>` with one click; and makes it the studio's app (writing `~/.studio/config.json` for the first one, `studio switch <app>` after that). Running it again skips what's done.

`template/app.bundle` is the starter app, made from the template repo by `scripts/update-template-bundle.sh <template repo>`. Run that again after changing the template, and commit the new bundle.

## Start it

```sh
studio up
```

This updates Studio, starts its herdr workspace (Claude, the cockpit's server, the app's dev server, whisper-server for dictation and the reaper, one tab each) and opens the cockpit. The reaper (`claude-reaper.sh keep`) starts Claude again with `--continue` when it has died, and the chat then says "Reconnected". The app's dev server output also goes to the app's `data/logs/dev.log`.

When something breaks, the cockpit says so: a crashed server or a page that throws shows in the App tab with **Ask Claude to fix this** (it sends the error and the last 50 lines of `dev.log` in Build mode, starting a feature for the fix when none is open; not while an old version is previewed); "not backed up" sits by the app's name while a push is waiting to be retried (the server retries every minute); Claude Code's own usage-limit line (`You've hit your … limit · resets …`) shows in the chat; a checkpoint refused for holding a value from `.env` shows in the Feature panel; and Keep, Discard, Go back, Bring them back, Preview and Restore wait while Claude works or waits on a question. Running it again reuses the workspace that's already running. `studio up --dry-run` prints what each tab would run.

## Layout

- `bin/studio`: the `studio up` command.
- `scripts/lib/studio-server.js`: the local server behind the page. It serves the cockpit and the API for chat, artifacts, drawing, uploads, dictation and jobs.
- `scripts/lib/feature.js`: features and checkpoints. The app's repo has `main` (the versions kept) and `develop` (the feature being built). A feature is planned and built in one Claude conversation: starting one (the chat asks for a name when a Plan or Build message is sent with none open) resets `develop` to `main` and leaves the conversation as it is, and Keep or Discard ends it with `/clear`, so the next feature starts afresh; after every turn that changed files, the Stop hook commits a checkpoint on `develop`, labelled from the reply's `Checkpoint:` line, snapshots `data/` and pushes in the background (a failed push is retried with the next one and by `studio up`). Keep runs the app's `npm test` and `npm run typecheck`, then squashes the checkpoints into one commit on `main` named after the feature (with its summary added to the app's `FEATURES.md`), tags it v(N+1) and pushes; Discard resets `develop` to `main` and puts `data/` back as it was when the feature started. Go back to here resets `develop` and `data/` to a checkpoint and drops the later ones; Bring them back undoes that until the next message, which tells Claude about going back. A checkpoint (and Keep) is refused while the changes contain any value of 8 or more characters from the app's `.env`; the Stop hook then tells Claude to move it to `.env`. With no feature open, Preview checks out an old version detached (no branch moves; `data/` and any uncommitted changes are put back exactly on [back to latest]; no feature can start meanwhile), and Restore makes a new commit on `main` with an old version's code (FEATURES.md keeps its entries and gains one for the restore), tagged v(N+1) "restore vN", and pushes. Each kept version links to the Claude sessions its checkpoints were made in. The chat's switch sets the mode of the next message: in Ask (an answer) and Plan (a few questions for the user, one at a time with a recommended answer, then a plan published as an artifact), the PreToolUse hook refuses edits to the app's files and the Stop hook puts back whatever a command changed in the turn (files git ignores, like `data/`, are left alone), so nothing is checkpointed and an open feature stays open; Build works as above. A plan's page carries `<meta name="studio-plan" content="<feature name>">`, which gives it a **Build this** button in the cockpit's artifact toolbar: it starts a feature under that name (which can be changed; with a feature already open it builds in that one), switches to Build and sends Claude the plan's local copy. The middle pane switches by itself to Artifacts when the chat's Claude publishes, and back to the app when a Build turn ends, but not away from an unsent drawing. The server types `/effort` for the mode (Ask low, Plan high, Build medium) into Claude when it sits idle in a new session or after the mode changes. These hooks are the chat's alone: the Artifacts tab's Claude and the feature summariser run with `STUDIO_ROLE=artifacts` and `summary`, and start no feature, make no checkpoint and put nothing back (the chat's is started with `STUDIO_ROLE=chat`).
- `scripts/`: the jobs the cockpit's buttons run (start or resume Claude, rebuild the artifact index), `feature-summary.sh` (what a feature does, for Keep and `FEATURES.md`; `STUDIO_SUMMARY_CMD` stands in for it) and `cc-command.sh` (slash commands queued for the pane).
- `web/`: the cockpit page (React, built into a single `web/dist/cockpit.html`).
- `hooks/studio-hook.py`: Claude Code hooks that tell the cockpit which session a pane runs and pass on what the page showed.
- `claude/settings.json`: the settings Claude runs with inside the studio (`claude --settings`).
- `skills/`: the skills Claude has here: artifact-index, debrief, diagnose, grill-me, handoff, look (a screenshot of a page of the app, by `scripts/look.sh`), prototype, seed-data (runs the app's `scripts/seed-data.ts`), tdd, feature-summary (run headless by `scripts/feature-summary.sh`). Claude loads them with this folder as a plugin (`claude --plugin-dir`, named in `.claude-plugin/plugin.json`), so each can also be called as `/studio:<name>`.

## Develop

```sh
cd web && pnpm install && pnpm build             # the cockpit page
node scripts/lib/studio-server.js                # http://localhost:4000 (STUDIO_HOME, STUDIO_PORT)
node --test scripts/lib/*.test.js                # server and script tests
cd web && pnpm test && pnpm lint                 # page tests
```

`studio up` sets `STUDIO_DIR` to this folder in the environment Claude runs in, because the hooks and skills find their scripts through it. To try it without touching a real app or session: `STUDIO_HOME=<a temp folder with a config.json> STUDIO_PORT=<free port> STUDIO_WORKSPACE=studio-test STUDIO_CLAUDE_CMD='sleep 86400' STUDIO_NO_OPEN=1 bin/studio up`.
