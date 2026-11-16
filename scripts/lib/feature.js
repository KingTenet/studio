'use strict';

/**
 * The feature being built in the app, and its checkpoints: the version control she never has to think about.
 *
 * The app's repo has two branches: main (the versions kept) and develop (the feature being built). Starting a
 * feature resets develop to main and checks it out. After every Build turn that changed files, the Stop hook
 * commits a checkpoint on develop, labelled from the reply's `Checkpoint: …` line (else its first sentence),
 * and snapshots data/. Every commit is pushed in the background; a push that fails is noted and tried again
 * with the next one (and by `studio up`), and never holds up work. With no origin remote nothing is pushed.
 *
 * Its state lives outside the app's git, in STUDIO_HOME/features/<app folder, named the way Claude names project folders>/:
 *   feature.json      the open feature, absent when none is: { name, startedAt, base (main's sha it started from),
 *                     checkpoints: [{ sha, label, prompt, at }] }
 *   turn.json         the prompt of the turn under way ({ prompt, at }), from the UserPromptSubmit hook
 *   push.json         { pending: { <branch>: { at, error } } }: the branches whose last push failed
 *   snapshots/<sha>/  the app's data/ (without logs/) as it was at that commit: the feature's start (base) and
 *                     each checkpoint. Starting a feature drops the previous feature's.
 *
 * Usage: node lib/feature.js prompt-submit         UserPromptSubmit hook: notes the prompt; starts a feature if none is open
 *        node lib/feature.js stop                  Stop hook: commits a checkpoint if the turn changed files
 *        node lib/feature.js start <name> [app]    start a feature (the cockpit's server does this, and runs /clear)
 *        node lib/feature.js push [app]            push develop and every branch whose push failed
 *        node lib/feature.js show [app]            the open feature and pending pushes, as JSON
 * The hooks do nothing outside the app's folder, or without the app's repo.
 *
 * Run tests: node --test lib/feature.test.js
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const studioHome = () => process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(file + '.tmp', file);
};

/** The app's folder from STUDIO_HOME/config.json (default ~/Studio/my-app), as the server reads it. */
const configuredApp = () => path.resolve(readJson(path.join(studioHome(), 'config.json'), {}).appDir ?? path.join(os.homedir(), 'Studio', 'my-app'));

/** The folder holding an app's feature state. */
const stateDir = (appDir) => path.join(studioHome(), 'features', path.resolve(appDir).replace(/[^A-Za-z0-9]/g, '-'));
const files = (appDir) => {
  const dir = stateDir(appDir);
  return { dir, feature: path.join(dir, 'feature.json'), turn: path.join(dir, 'turn.json'), push: path.join(dir, 'push.json'), snapshots: path.join(dir, 'snapshots') };
};

const git = (appDir, ...args) => execFileSync('git', ['-C', appDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;

/**
 * Runs fn holding one of the app's locks: `lock` so the hooks and the cockpit's server never move its branches at
 * the same time, `push.lock` so two pushes never race each other for the remote's refs.
 */
const withLock = (appDir, fn, name = 'lock', wait = LOCK_WAIT_MS) => {
  const lock = path.join(files(appDir).dir, name);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let waited = 0; ; waited += 50) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > Math.max(wait, LOCK_STALE_MS)) fs.rmSync(lock, { recursive: true, force: true });
      else if (waited >= wait) throw new Error('the app is busy with another change; try again in a moment');
      else sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

/** The open feature ({ name, startedAt, base, checkpoints }) or null, and the branches whose push failed. */
const read = (appDir) => ({ feature: readJson(files(appDir).feature, null), unpushed: Object.keys(readJson(files(appDir).push, {}).pending ?? {}) });

/** Copies the app's data/ (without logs/) to the snapshot for a commit; an app with no data/ gets an empty one. */
const snapshotData = (appDir, sha) => {
  const from = path.join(appDir, 'data');
  const to = path.join(files(appDir).snapshots, sha);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  if (fs.existsSync(from)) {
    // A copy-on-write clone on APFS, so a snapshot is quick and costs no space until the data changes.
    fs.cpSync(from, to, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: (source) => source !== path.join(from, 'logs') });
  }
  return to;
};

/**
 * Starts a feature: develop is reset to main and checked out (changes not yet committed come along), data/ is
 * snapshotted as the feature's start, and develop is pushed. Refused while a feature is open.
 */
const start = (appDir, name, now = new Date()) => {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) throw new Error('a feature needs a name');
  return withLock(appDir, () => {
    const open = read(appDir).feature;
    if (open) throw new Error(`"${open.name}" is still being built: keep it or discard it first`);
    const base = git(appDir, 'rev-parse', 'main');
    git(appDir, 'checkout', '-q', '-B', 'develop', 'main');
    fs.rmSync(files(appDir).snapshots, { recursive: true, force: true });
    snapshotData(appDir, base);
    const feature = { name: clean, startedAt: now.toISOString(), base, checkpoints: [] };
    writeJson(files(appDir).feature, feature);
    return feature;
  });
};

/** Notes the prompt of the turn under way, for the checkpoint it may become. */
const notePrompt = (appDir, prompt, now = new Date()) => writeJson(files(appDir).turn, { prompt: String(prompt ?? ''), at: now.toISOString() });

/**
 * Commits what the turn changed as a checkpoint on develop, snapshots data/ for it and adds it to the feature.
 * Null, and nothing committed, when no feature is open, develop isn't checked out or no file changed.
 */
const checkpoint = (appDir, { label, prompt = '' }, now = new Date()) =>
  withLock(appDir, () => {
    const feature = read(appDir).feature;
    if (!feature) return null;
    if (git(appDir, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'develop') return null;
    if (!git(appDir, 'status', '--porcelain')) return null;
    git(appDir, 'add', '-A');
    git(appDir, 'commit', '-q', '-m', label);
    const sha = git(appDir, 'rev-parse', 'HEAD');
    snapshotData(appDir, sha);
    const made = { sha, label, prompt, at: now.toISOString() };
    writeJson(files(appDir).feature, { ...feature, checkpoints: [...feature.checkpoints, made] });
    return made;
  });

const hasOrigin = (appDir) => {
  try {
    return Boolean(git(appDir, 'remote', 'get-url', 'origin'));
  } catch {
    return false;
  }
};

const hasBranch = (appDir, branch) => {
  try {
    return Boolean(git(appDir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`));
  } catch {
    return false;
  }
};

/** The `git push` arguments for a branch: develop is rewritten (start, discard, go back), so it is always forced. */
const pushArgs = (branch) => (branch === 'develop' ? ['push', '--force', 'origin', 'develop'] : ['push', 'origin', branch]);

/**
 * Pushes develop (once there is one) and every branch whose last push failed, noting each failure in push.json for the next try
 * and clearing it on success. Nothing happens without an origin remote. Returns { pushed, failed }.
 */
const push = (appDir) => {
  if (!hasOrigin(appDir)) return { pushed: [], failed: [] };
  const { push: file } = files(appDir);
  return withLock(
    appDir,
    () => {
      const branches = [...new Set(['develop', ...Object.keys(readJson(file, {}).pending ?? {})])].filter((branch) => hasBranch(appDir, branch));
      const outcome = branches.map((branch) => {
        try {
          execFileSync('git', ['-C', appDir, ...pushArgs(branch)], { stdio: ['ignore', 'ignore', 'pipe'], timeout: PUSH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
          return { branch, error: null };
        } catch (error) {
          return { branch, error: String(error.stderr || error.message).trim().split('\n')[0] };
        }
      });
      const pending = readJson(file, {}).pending ?? {};
      for (const { branch, error } of outcome) {
        if (error) pending[branch] = { at: new Date().toISOString(), error };
        else delete pending[branch];
      }
      writeJson(file, { pending });
      return { pushed: outcome.filter((o) => !o.error).map((o) => o.branch), failed: outcome.filter((o) => o.error).map((o) => o.branch) };
    },
    'push.lock',
    PUSH_TIMEOUT_MS * 2
  );
};

/** Pushes in a process of its own, so a hook or the server returns at once however slow (or stuck) the network is. */
const pushInBackground = (appDir) => spawn(process.execPath, [__filename, 'push', appDir], { detached: true, stdio: 'ignore' }).unref();

const CHECKPOINT_LINE = /^[\s>*_`-]*checkpoint[*_`]*\s*:\s*(.+?)\s*$/gim;
const MAX_LABEL = 200;

/** Markdown taken out of a line, so the label reads as plain words. */
const plain = (text) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A checkpoint's label from Claude's reply: its last `Checkpoint: …` line, else its first sentence (or line). */
const turnLabel = (reply) => {
  const text = String(reply ?? '');
  const marked = [...text.matchAll(CHECKPOINT_LINE)].at(-1)?.[1];
  const label = marked ? plain(marked).replace(/^["“]|["”]$/g, '') : plain(/^[\s\S]*?(?:[.!?](?=\s|$)|\n|$)/.exec(text.trim())[0]);
  return (label || 'Made some changes').slice(0, MAX_LABEL);
};

/** A real prompt in a transcript record: a user message with text (not a tool result). */
const isPrompt = (record) => record.type === 'user' && !record.isMeta && (typeof record.message?.content === 'string' || (Array.isArray(record.message?.content) && record.message.content.some((part) => part.type === 'text')));

/** The text of Claude's last reply in the turn a transcript ends with, '' when there is none. */
const lastReply = (transcriptPath) => {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return '';
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (record.isSidechain) continue;
    if (isPrompt(record)) return '';
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      const text = record.message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
};

/** A name for a feature started without one, from the start of the prompt that started it. */
const nameFromPrompt = (prompt) => {
  const words = plain(String(prompt ?? '')).split(' ').slice(0, 6).join(' ');
  return (words.length > 40 ? words.slice(0, 40).trimEnd() + '…' : words) || 'Untitled feature';
};

/**
 * The mode the turn runs in. Every turn is a Build turn for now; Ask and Plan (ISSUE-018) will read the cockpit's
 * switch here, and the hooks then skip checkpoints, and starting a feature, for them.
 */
const turnMode = () => 'build';

/** The app's folder when a hook event comes from inside it and it is a git repo, else null. */
const appFor = (event, appDir = configuredApp()) => {
  const cwd = path.resolve(event.cwd ?? process.cwd());
  if (cwd !== appDir && !cwd.startsWith(appDir + path.sep)) return null;
  return fs.existsSync(path.join(appDir, '.git')) ? appDir : null;
};

/**
 * UserPromptSubmit: notes the prompt. A Build turn with no feature open starts one, named from the prompt (the
 * cockpit asks for a name first, so this only happens for a prompt typed straight into the pane). Returns the
 * text to add to Claude's prompt, if any.
 */
const onPromptSubmit = (event, appDir = appFor(event)) => {
  if (!appDir || event.agent_id) return '';
  notePrompt(appDir, event.prompt);
  if (turnMode(appDir) !== 'build' || read(appDir).feature) return '';
  const feature = start(appDir, nameFromPrompt(event.prompt));
  pushInBackground(appDir);
  return `[studio] No feature was open, so a new one was started for this work, called "${feature.name}".`;
};

/** Stop: a Build turn that changed files becomes a checkpoint, which is then pushed. Returns the checkpoint, or null. */
const onStop = (event, appDir = appFor(event)) => {
  if (!appDir || event.agent_id || turnMode(appDir) !== 'build') return null;
  const reply = event.last_assistant_message || lastReply(event.transcript_path);
  const made = checkpoint(appDir, { label: turnLabel(reply), prompt: readJson(files(appDir).turn, {}).prompt ?? '' });
  if (made) {
    fs.rmSync(files(appDir).turn, { force: true });
    pushInBackground(appDir);
  }
  return made;
};

const readStdin = () => {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
};

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (command === 'prompt-submit' || command === 'stop') {
    // A hook must never fail the turn: what goes wrong is logged to stderr, which Claude Code shows in its transcript view only.
    try {
      const event = readStdin();
      if (command === 'stop') onStop(event);
      else process.stdout.write(onPromptSubmit(event));
    } catch (error) {
      process.stderr.write(`studio: ${error.message}\n`);
    }
    process.exit(0);
  } else if (command === 'start' && args[0]) {
    const appDir = path.resolve(args[1] ?? configuredApp());
    print(start(appDir, args[0]));
    pushInBackground(appDir);
  } else if (command === 'push') {
    print(push(path.resolve(args[0] ?? configuredApp())));
  } else if (command === 'show') {
    print(read(path.resolve(args[0] ?? configuredApp())));
  } else {
    process.stderr.write('usage: feature.js prompt-submit|stop|start <name> [app dir]|push [app dir]|show [app dir]\n');
    process.exit(1);
  }
}

module.exports = { checkpoint, lastReply, nameFromPrompt, notePrompt, onPromptSubmit, onStop, push, pushInBackground, read, snapshotData, start, stateDir, turnLabel, turnMode };
