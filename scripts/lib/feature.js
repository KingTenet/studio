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
 *   gate.json         the last run of the tests Keep is gated on: { tree, ok, at, results: [{ name, ok, output }] }, for the
 *                     files as they were (tree), so Keep knows whether they still hold
 *   summary-digest.md what the feature summary (feature-summary.sh) is written from
 *   went-back.json    after going back to a checkpoint, until her next message: { to: { sha, label }, head, tree,
 *                     checkpoints, at }, what develop, the files (tree, uncommitted ones too) and the checkpoints were
 *                     before, so Bring them back can restore them; data/ as it was is in snapshots/went-back/
 *
 * Keeping a feature squashes its checkpoints into one commit on main named after it (main only ever fast-forwards),
 * with its summary added to the app's FEATURES.md, tags it v(N+1) and leaves develop equal to main. Discarding it
 * resets develop to main and puts data/ back as it was when the feature started. Either way the feature closes.
 *
 * Going back to a checkpoint resets develop and data/ to it and drops the later checkpoints; Bring them back undoes that
 * exactly, until her next message, which lets them go for good and tells Claude she went back.
 *
 * Usage: node lib/feature.js prompt-submit         UserPromptSubmit hook: notes the prompt; starts a feature if none is open;
 *                                                  lets go of what going back left, telling Claude
 *        node lib/feature.js stop                  Stop hook: commits a checkpoint if the turn changed files; when the changes
 *                                                  hold a value from the app's .env, commits nothing and tells Claude to move it
 *        node lib/feature.js start <name> [app]    start a feature (the cockpit's server does this, and runs /clear)
 *        node lib/feature.js push [app] [branch…]  push develop, those branches and every branch whose push failed
 *        node lib/feature.js show [app]            the open feature and pending pushes, as JSON
 *        node lib/feature.js digest [app]          write the summary's digest of the open feature; prints its path
 * The hooks do nothing outside the app's folder, or without the app's repo.
 *
 * Run tests: node --test lib/feature.test.js
 */

const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
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
  return { dir, feature: path.join(dir, 'feature.json'), turn: path.join(dir, 'turn.json'), push: path.join(dir, 'push.json'), snapshots: path.join(dir, 'snapshots'), gate: path.join(dir, 'gate.json'), digest: path.join(dir, 'summary-digest.md'), wentBack: path.join(dir, 'went-back.json') };
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

/** What going back to a checkpoint left to bring back, for the cockpit: { to: { sha, label }, discarded: [label] }, or null. */
const wentBackView = (wentBack) => {
  if (!wentBack) return null;
  const at = wentBack.checkpoints.findIndex((checkpoint) => checkpoint.sha === wentBack.to.sha);
  return { to: wentBack.to, discarded: wentBack.checkpoints.slice(at + 1).map((checkpoint) => checkpoint.label) };
};

/**
 * The open feature ({ name, startedAt, base, checkpoints }) or null, the branches whose push failed, and what going back to a
 * checkpoint left to bring back (wentBackView), or null.
 */
const read = (appDir) => ({
  feature: readJson(files(appDir).feature, null),
  unpushed: Object.keys(readJson(files(appDir).push, {}).pending ?? {}),
  wentBack: wentBackView(readJson(files(appDir).wentBack, null)),
});

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

/** Puts the app's data/ back as a snapshot has it: everything in it but logs/ is removed, then the snapshot copied in. */
const restoreData = (appDir, sha) => {
  const from = path.join(files(appDir).snapshots, sha);
  if (!fs.existsSync(from)) throw new Error(`there is no snapshot of the app's data for ${sha.slice(0, 7)}`);
  const to = path.join(appDir, 'data');
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(to)) if (name !== 'logs') fs.rmSync(path.join(to, name), { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
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

// Values in .env shorter than this aren't looked for: they would turn up in ordinary code by chance.
const MIN_SECRET = 8;

/** The values in the app's .env worth looking for, with their names: [{ name, value }]. */
const envSecrets = (appDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(appDir, '.env'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line))
    .filter(Boolean)
    .map(([, name, raw]) => ({ name, value: /^(["'`]).*\1$/.test(raw) ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, '') }))
    .filter(({ value }) => value.length >= MIN_SECRET);
};

/**
 * Where a diff (`git diff <args>`) adds a value from the app's .env: [{ file, name }], the file and the value's name in .env,
 * never the value itself, so it can't end up in a message or a log.
 */
const envLeaks = (appDir, args) => {
  const secrets = envSecrets(appDir);
  if (!secrets.length) return [];
  const diff = execFileSync('git', ['-C', appDir, 'diff', '--text', '--no-color', '--no-ext-diff', '-U0', ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const found = new Map();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^"?b\//, '').replace(/"$/, '');
    else if (line.startsWith('+')) for (const { name } of secrets.filter(({ value }) => line.includes(value))) found.set(`${file}\0${name}`, { file, name });
  }
  return [...found.values()];
};

/** Which files hold which .env values, in words: `server/ai.ts has the value of OPENAI_KEY`. */
const describeLeaks = (leaks) => leaks.map(({ file, name }) => `${file} has the value of ${name}`).join('; ');

/** What Claude is told when a checkpoint is refused for holding values from .env (names only, never the values). */
const leakMessage = (leaks) => {
  const names = [...new Set(leaks.map(({ name }) => name))];
  const envItself = leaks.some(({ file }) => file === '.env');
  return [
    `Nothing was saved as a checkpoint, because the changes contain values from .env: ${describeLeaks(leaks)}.`,
    envItself ? '.env itself must never be committed: make sure .gitignore lists it.' : '',
    `Secrets belong in .env only. Take the value out of the code and read it with ${names.map((name) => `process.env.${name}`).join(', ')} instead (with the name, not the value, in .env.example). The checkpoint is saved when you finish.`,
  ]
    .filter(Boolean)
    .join(' ');
};

/**
 * Commits what the turn changed as a checkpoint on develop, snapshots data/ for it and adds it to the feature.
 * Null, and nothing committed, when no feature is open, develop isn't checked out or no file changed. When the changes add a
 * value from the app's .env, nothing is committed either, and it returns { refused }: what Claude is told to do about it.
 */
const checkpoint = (appDir, { label, prompt = '' }, now = new Date()) =>
  withLock(appDir, () => {
    const feature = read(appDir).feature;
    if (!feature) return null;
    if (git(appDir, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'develop') return null;
    if (!git(appDir, 'status', '--porcelain')) return null;
    git(appDir, 'add', '-A');
    const leaks = envLeaks(appDir, ['--cached']);
    if (leaks.length) {
      git(appDir, 'reset', '-q');
      return { refused: leakMessage(leaks) };
    }
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

/**
 * The `git push` arguments for a branch: develop is rewritten (start, discard, go back), so it is always forced. Any other
 * (main) is pushed plainly with the version tags on it, which are never forced either.
 */
const pushArgs = (branch) => (branch === 'develop' ? ['push', '--force', 'origin', 'develop'] : ['push', '--follow-tags', 'origin', branch]);

/**
 * Pushes develop (once there is one), the branches in `also` and every branch whose last push failed, noting each failure in
 * push.json for the next try and clearing it on success. Nothing happens without an origin remote. Returns { pushed, failed }.
 */
const push = (appDir, also = []) => {
  if (!hasOrigin(appDir)) return { pushed: [], failed: [] };
  const { push: file } = files(appDir);
  return withLock(
    appDir,
    () => {
      const branches = [...new Set(['develop', ...also, ...Object.keys(readJson(file, {}).pending ?? {})])].filter((branch) => hasBranch(appDir, branch));
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
const pushInBackground = (appDir, also = []) => spawn(process.execPath, [__filename, 'push', appDir, ...also], { detached: true, stdio: 'ignore' }).unref();

// --- keeping or discarding the feature -----------------------------------------------------

const GATE = [
  { name: 'Tests', args: ['test'] },
  { name: 'Type check', args: ['run', 'typecheck'] },
];
const GATE_TIMEOUT_MS = 5 * 60_000;
const SUMMARY_TIMEOUT_MS = 90_000;
const MAX_OUTPUT = 4000;
const MAX_SUMMARY = 2000;
const MAX_DIFF = 40_000;

/**
 * Runs a command in a process group of its own, resolving to { code, stdout, output } (output is stdout and stderr together,
 * its last part); after timeoutMs the whole group is killed, so a hung test run or summary never holds Keep up.
 */
const runCommand = (command, args, { cwd, env = process.env, timeoutMs }) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', output: error.message });
      return;
    }
    let stdout = '';
    let output = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      output = (output + chunk).slice(-MAX_OUTPUT * 4);
    });
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-MAX_OUTPUT * 4);
    });
    const timer = setTimeout(() => {
      output += `\n(stopped after ${Math.round(timeoutMs / 1000)} s)`;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, output });
    });
  });

/** The git tree of the app's files as they are now, committed or not (a throwaway index, so the real one is untouched). */
const workTree = (appDir) => {
  const index = path.join(os.tmpdir(), `studio-index-${crypto.randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: '0' };
  try {
    // Starting from the real index lets git skip the files it already knows are unchanged.
    fs.copyFileSync(path.resolve(appDir, git(appDir, 'rev-parse', '--git-path', 'index')), index);
  } catch {}
  try {
    execFileSync('git', ['-C', appDir, 'add', '-A'], { stdio: 'ignore', env });
    return execFileSync('git', ['-C', appDir, 'write-tree'], { encoding: 'utf8', env }).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
};

/** The versions kept so far, oldest first: [{ tag: 'v2', name, sha, at }] from the app's annotated v<N> tags. */
const versions = (appDir) => {
  let out;
  try {
    out = git(appDir, 'for-each-ref', '--sort=version:refname', '--format=%(refname:short)%09%(*objectname)%09%(objectname)%09%(creatordate:iso-strict)%09%(contents:subject)', 'refs/tags/v*');
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([tag]) => /^v\d+$/.test(tag ?? ''))
    .map(([tag, commit, object, at, subject = '']) => ({ tag, name: subject.replace(new RegExp(`^${tag}\\s+`), ''), sha: commit || object, at }));
};

/** The tag the next version kept gets: one past the highest so far. */
const nextVersion = (appDir) => `v${Math.max(0, ...versions(appDir).map((version) => Number(version.tag.slice(1)))) + 1}`;

/** What the feature does when no summary could be written: its checkpoints' labels, as sentences. */
const fallbackSummary = (feature) =>
  feature.checkpoints.map(({ label }) => (/[.!?]$/.test(label) ? label : label + '.')).join(' ') || `${feature.name}.`;

/**
 * Runs the tests Keep is gated on (the app's `npm test` and `npm run typecheck`, side by side) and notes how they went in
 * gate.json, for the files as they are now. Resolves to { ok, results: [{ name, ok, output }] }.
 */
const runGate = async (appDir, now = new Date()) => {
  const tree = workTree(appDir);
  const env = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  const results = await Promise.all(
    GATE.map(async ({ name, args }) => {
      const { code, output } = await runCommand('npm', args, { cwd: appDir, env, timeoutMs: GATE_TIMEOUT_MS });
      return { name, ok: code === 0, output: output.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-MAX_OUTPUT) };
    })
  );
  const gate = { tree, ok: results.every((result) => result.ok), at: now.toISOString(), results };
  writeJson(files(appDir).gate, gate);
  return { ok: gate.ok, results };
};

/**
 * Writes what the feature summary is written from: the feature's name, each checkpoint with what she asked for, the files
 * changed and the changes themselves (cut short when long), and FEATURES.md so far. Returns the file's path.
 */
const writeDigest = (appDir) => {
  const feature = read(appDir).feature;
  if (!feature) throw new Error('no feature is being built');
  const tree = workTree(appDir);
  const diff = git(appDir, 'diff', 'main', tree, '--', '.', ':(exclude)FEATURES.md');
  const features = (() => {
    try {
      return fs.readFileSync(path.join(appDir, 'FEATURES.md'), 'utf8').trim();
    } catch {
      return '(none yet)';
    }
  })();
  const text = [
    `# The feature: ${feature.name}`,
    '## Its checkpoints, oldest first, each with what she asked for',
    feature.checkpoints.map((checkpoint, i) => `${i + 1}. ${checkpoint.label}${checkpoint.prompt ? `\n   She asked: ${checkpoint.prompt.replace(/\s+/g, ' ')}` : ''}`).join('\n') || '(none: the changes below were never checkpointed)',
    '## Files changed',
    git(appDir, 'diff', '--stat', 'main', tree) || '(none)',
    '## The changes',
    '```diff\n' + (diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n[… the rest left out]' : diff) + '\n```',
    '## FEATURES.md so far',
    features,
  ].join('\n\n');
  fs.writeFileSync(files(appDir).digest, text + '\n');
  return files(appDir).digest;
};

/**
 * What the open feature does, in plain words, for FEATURES.md and the Keep card: { text, fallback }. Written by Claude, headless
 * (feature-summary.sh, or STUDIO_SUMMARY_CMD, run with the app's folder); when that fails, says nothing or takes longer than
 * timeoutMs, it falls back to the checkpoints' labels (fallback true).
 */
const summarise = async (appDir, { command = process.env.STUDIO_SUMMARY_CMD || path.join(__dirname, '..', 'feature-summary.sh'), timeoutMs = SUMMARY_TIMEOUT_MS } = {}) => {
  const feature = read(appDir).feature;
  if (!feature) throw new Error('no feature is being built');
  // Not as a herdr pane's process, so the headless Claude never shows as one of the app's sessions.
  const { HERDR_WORKSPACE, HERDR_PANE_ID, ...env } = process.env;
  const { code, stdout } = await runCommand(command, [appDir], { cwd: appDir, env, timeoutMs });
  const text = code === 0 ? stdout.trim().slice(0, MAX_SUMMARY) : '';
  return text ? { text, fallback: false } : { text: fallbackSummary(feature), fallback: true };
};

/** Closes the feature: its state, snapshots, test run, digest and what going back left to bring back go. */
const close = (appDir) => {
  const { feature, snapshots, gate, digest, wentBack } = files(appDir);
  for (const file of [feature, snapshots, gate, digest, wentBack]) fs.rmSync(file, { recursive: true, force: true });
};

/**
 * Keeps the open feature as the next version: the app's files as they are (checkpointed or not) and its summary added to
 * FEATURES.md become one commit on main named after it, main fast-forwards to it, it is tagged v(N+1) ("vN <name>"), and
 * develop (still checked out) is left equal to main. Refused unless the tests passed for exactly these files, or with
 * `anyway`. Nothing moves when it fails part way. Returns { version, sha, summary }; push with pushInBackground(appDir, ['main']).
 */
const keep = (appDir, { summary, anyway = false } = {}) =>
  withLock(appDir, () => {
    const feature = read(appDir).feature;
    if (!feature) throw new Error('no feature is being built');
    if (git(appDir, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'develop') throw new Error('the app is not on develop, so the feature cannot be kept');
    const main = git(appDir, 'rev-parse', 'main');
    try {
      git(appDir, 'merge-base', '--is-ancestor', main, 'HEAD');
    } catch {
      throw new Error("develop doesn't start from the latest version, so keeping it would rewrite one");
    }
    const tree = workTree(appDir);
    const latest = versions(appDir).at(-1)?.tag ?? 'the last version';
    if (tree === git(appDir, 'rev-parse', `${main}^{tree}`)) throw new Error(`Nothing has changed since ${latest}, so there is nothing to keep. Discard "${feature.name}" instead.`);
    const leaks = envLeaks(appDir, [main, tree]);
    if (leaks.length) throw new Error(`"${feature.name}" can't be kept, because it contains secrets from .env (${describeLeaks(leaks)}). Ask Claude to move them into .env.`);
    if (!anyway) {
      const gate = readJson(files(appDir).gate, null);
      if (!gate || gate.tree !== tree) throw new Error('The app has changed since the tests last ran. Run them again first.');
      if (!gate.ok) throw new Error(`${gate.results.filter((result) => !result.ok).map((result) => result.name).join(' and ')} failed, so "${feature.name}" can't be kept yet.`);
    }
    const version = nextVersion(appDir);
    const text = String(summary ?? '').trim().slice(0, MAX_SUMMARY) || fallbackSummary(feature);
    const featuresFile = path.join(appDir, 'FEATURES.md');
    const before = fs.existsSync(featuresFile) ? fs.readFileSync(featuresFile, 'utf8') : null;
    const sha = (() => {
      try {
        fs.writeFileSync(featuresFile, `${before === null ? '# Features\n' : before.replace(/\n*$/, '\n')}\n## ${version} ${feature.name}\n\n${text}\n`);
        // The version's commit, made beside develop so nothing has moved if it can't be made (no git identity, say).
        const made = git(appDir, 'commit-tree', workTree(appDir), '-p', main, '-m', feature.name);
        // From where main was, to a commit whose parent that is: only ever a fast-forward.
        git(appDir, 'update-ref', 'refs/heads/main', made, main);
        return made;
      } catch (error) {
        if (before === null) fs.rmSync(featuresFile, { force: true });
        else fs.writeFileSync(featuresFile, before);
        throw error;
      }
    })();
    git(appDir, 'tag', '-a', version, '-m', `${version} ${feature.name}`, sha);
    // develop to the version too, its index with it; the files on disk are that version's already.
    git(appDir, 'reset', '-q', '--mixed', sha);
    close(appDir);
    return { version, sha, summary: text };
  });

/**
 * Discards the open feature: develop is reset to main (changes not committed, and new files git doesn't ignore, go too) and
 * data/ is put back as it was when the feature started. Returns { name, checkpoints } (how many were lost); push develop after.
 */
const discard = (appDir) =>
  withLock(appDir, () => {
    const feature = read(appDir).feature;
    if (!feature) throw new Error('no feature is being built');
    if (!fs.existsSync(path.join(files(appDir).snapshots, feature.base))) throw new Error("the snapshot of the app's data from the feature's start is missing, so it can't be put back");
    git(appDir, 'checkout', '-q', '-f', '-B', 'develop', 'main');
    git(appDir, 'clean', '-q', '-f', '-d');
    restoreData(appDir, feature.base);
    close(appDir);
    return { name: feature.name, checkpoints: feature.checkpoints.length };
  });

// --- going back to a checkpoint ---------------------------------------------------------------

/** The snapshot data/ was in when she went back, for Bring them back (never a commit's sha). */
const WENT_BACK_DATA = 'went-back';

/**
 * Goes back to one of the open feature's checkpoints: develop is reset to it (changes not committed, and new files git doesn't
 * ignore, go too), data/ is put back as it was then and the later checkpoints are dropped. What there was before is kept, so
 * bringBack can restore it exactly, until forgetWentBack (her next message). Going back again before then still brings back
 * what there was before the first. Returns { to, discarded } (wentBackView); push develop after.
 */
const goBack = (appDir, sha, now = new Date()) =>
  withLock(appDir, () => {
    const feature = read(appDir).feature;
    if (!feature) throw new Error('no feature is being built');
    const at = feature.checkpoints.findIndex((checkpoint) => checkpoint.sha === sha);
    if (at < 0) throw new Error("that checkpoint isn't one of this feature's");
    if (git(appDir, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'develop') throw new Error('the app is not on develop, so it cannot go back');
    if (!fs.existsSync(path.join(files(appDir).snapshots, sha))) throw new Error(`there is no snapshot of the app's data for ${sha.slice(0, 7)}`);
    const before =
      readJson(files(appDir).wentBack, null) ??
      (() => {
        snapshotData(appDir, WENT_BACK_DATA);
        return { head: git(appDir, 'rev-parse', 'HEAD'), tree: workTree(appDir), checkpoints: feature.checkpoints };
      })();
    git(appDir, 'reset', '-q', '--hard', sha);
    git(appDir, 'clean', '-q', '-f', '-d');
    restoreData(appDir, sha);
    const { label } = feature.checkpoints[at];
    const wentBack = { to: { sha, label }, head: before.head, tree: before.tree, checkpoints: before.checkpoints, at: now.toISOString() };
    writeJson(files(appDir).wentBack, wentBack);
    writeJson(files(appDir).feature, { ...feature, checkpoints: feature.checkpoints.slice(0, at + 1) });
    return wentBackView(wentBack);
  });

/**
 * Undoes going back: develop, the files (uncommitted ones too), data/ and the checkpoints are as they were before. Refused once
 * her next message has let them go. Returns { checkpoints } (how many there are again); push develop after.
 */
const bringBack = (appDir) =>
  withLock(appDir, () => {
    const feature = read(appDir).feature;
    const wentBack = readJson(files(appDir).wentBack, null);
    if (!feature || !wentBack) throw new Error('There is nothing to bring back: the later checkpoints went when the next message was sent.');
    if (git(appDir, 'symbolic-ref', '--short', '-q', 'HEAD') !== 'develop') throw new Error('the app is not on develop, so they cannot be brought back');
    git(appDir, 'reset', '-q', '--hard', wentBack.head);
    git(appDir, 'clean', '-q', '-f', '-d');
    // The files as they were, uncommitted changes and new files too; then the index back to the commit, so they show as uncommitted again.
    git(appDir, 'read-tree', '--reset', '-u', wentBack.tree);
    git(appDir, 'reset', '-q');
    restoreData(appDir, WENT_BACK_DATA);
    writeJson(files(appDir).feature, { ...feature, checkpoints: wentBack.checkpoints });
    fs.rmSync(path.join(files(appDir).snapshots, WENT_BACK_DATA), { recursive: true, force: true });
    fs.rmSync(files(appDir).wentBack, { force: true });
    return { checkpoints: wentBack.checkpoints.length };
  });

/**
 * Lets go of what going back left to bring back (the later checkpoints' snapshots and data/ as it was), when her next message is
 * sent. Returns the note for that message's prompt, so Claude knows the later changes are gone, or '' when she hadn't gone back.
 */
const forgetWentBack = (appDir) =>
  withLock(appDir, () => {
    const wentBack = readJson(files(appDir).wentBack, null);
    if (!wentBack) return '';
    const { to, discarded } = wentBackView(wentBack);
    const kept = new Set((read(appDir).feature?.checkpoints ?? []).map((checkpoint) => checkpoint.sha));
    for (const name of [WENT_BACK_DATA, ...wentBack.checkpoints.map((checkpoint) => checkpoint.sha).filter((sha) => !kept.has(sha))]) {
      fs.rmSync(path.join(files(appDir).snapshots, name), { recursive: true, force: true });
    }
    fs.rmSync(files(appDir).wentBack, { force: true });
    const later = discarded.length ? `The ${discarded.length === 1 ? 'change' : `${discarded.length} changes`} after it ${discarded.length === 1 ? 'was' : 'were'} discarded: ${discarded.map((label) => `"${label}"`).join(', ')}.` : 'Changes made after it were discarded.';
    return `[studio] She went back to the checkpoint "${to.label}": the app's code and data are as they were then. ${later} Don't assume anything from them is still there.`;
  });

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
  // Her message lets go of what going back left to bring back, and Claude is told she went back, this once.
  const wentBack = forgetWentBack(appDir);
  notePrompt(appDir, event.prompt);
  if (turnMode(appDir) !== 'build' || read(appDir).feature) return wentBack;
  const feature = start(appDir, nameFromPrompt(event.prompt));
  pushInBackground(appDir);
  return `[studio] No feature was open, so a new one was started for this work, called "${feature.name}".`;
};

/**
 * Stop: a Build turn that changed files becomes a checkpoint, which is then pushed. Returns the checkpoint, or null; or, when
 * the changes hold values from .env, { refused, block }: block (keep Claude going, to fix it) is false when Claude is already
 * going on because of a Stop hook, so a value it can't move never loops. The turn's prompt is kept for the checkpoint to come.
 */
const onStop = (event, appDir = appFor(event)) => {
  if (!appDir || event.agent_id || turnMode(appDir) !== 'build') return null;
  const reply = event.last_assistant_message || lastReply(event.transcript_path);
  const made = checkpoint(appDir, { label: turnLabel(reply), prompt: readJson(files(appDir).turn, {}).prompt ?? '' });
  if (made?.refused) return { ...made, block: !event.stop_hook_active };
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
      if (command === 'stop') {
        const stopped = onStop(event);
        // {"decision":"block"} keeps Claude going, with the reason as what it is told.
        if (stopped?.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: stopped.refused }) + '\n');
        else if (stopped?.refused) process.stderr.write(`studio: ${stopped.refused}\n`);
      } else process.stdout.write(onPromptSubmit(event));
    } catch (error) {
      process.stderr.write(`studio: ${error.message}\n`);
    }
    process.exit(0);
  } else if (command === 'start' && args[0]) {
    const appDir = path.resolve(args[1] ?? configuredApp());
    print(start(appDir, args[0]));
    pushInBackground(appDir);
  } else if (command === 'push') {
    print(push(path.resolve(args[0] ?? configuredApp()), args.slice(1)));
  } else if (command === 'show') {
    print(read(path.resolve(args[0] ?? configuredApp())));
  } else if (command === 'digest') {
    process.stdout.write(writeDigest(path.resolve(args[0] ?? configuredApp())) + '\n');
  } else {
    process.stderr.write('usage: feature.js prompt-submit|stop|start <name> [app dir]|push [app dir] [branch…]|show [app dir]|digest [app dir]\n');
    process.exit(1);
  }
}

module.exports = { bringBack, checkpoint, discard, fallbackSummary, forgetWentBack, goBack, keep, lastReply, nameFromPrompt, nextVersion, notePrompt, onPromptSubmit, onStop, push, pushInBackground, read, restoreData, runGate, snapshotData, start, stateDir, summarise, turnLabel, turnMode, versions, withLock, writeDigest };
