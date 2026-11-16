'use strict';

/**
 * The feature lifecycle against a temporary app repo with a local bare repo as its origin, driving the hooks the
 * way Claude Code does: their JSON on stdin, with a transcript written the way Claude writes one.
 *
 * Run tests: node --test lib/feature.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lastReply, nameFromPrompt, read, stateDir, turnLabel } = require('./feature');

const SCRIPT = path.join(__dirname, 'feature.js');
const IDENTITY = { GIT_AUTHOR_NAME: 'Her', GIT_AUTHOR_EMAIL: 'her@example.com', GIT_COMMITTER_NAME: 'Her', GIT_COMMITTER_EMAIL: 'her@example.com' };

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();

/** A temp STUDIO_HOME, an app repo on main (v1) with data/ ignored, and a bare origin it has been pushed to. */
const setup = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-feature-')));
  const home = path.join(root, 'studio-home');
  const app = path.join(root, 'my-app');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ appDir: app }));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', app]);
  fs.writeFileSync(path.join(app, '.gitignore'), 'data/\n');
  fs.writeFileSync(path.join(app, 'page.html'), '<h1>Getting started</h1>\n');
  fs.mkdirSync(path.join(app, 'data', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(app, 'data', 'app.db'), 'rows: 0');
  fs.writeFileSync(path.join(app, 'data', 'logs', 'dev.log'), 'log');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'Getting Started');
  git(app, 'remote', 'add', 'origin', origin);
  git(app, 'push', '-q', 'origin', 'main');
  const env = { ...process.env, ...IDENTITY, STUDIO_HOME: home };
  const run = (args, input = '') => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: app, env, input, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const hook = (name, event) => run([name], JSON.stringify({ session_id: 's1', cwd: app, ...event }));
  const transcript = path.join(root, 'transcript.jsonl');
  /** One turn: her prompt, the edits, Claude's reply in the transcript, then the Stop hook. */
  const turn = (prompt, edit, reply) => {
    hook('prompt-submit', { prompt });
    edit();
    const records = [
      { type: 'user', message: { role: 'user', content: prompt } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
    ];
    fs.appendFileSync(transcript, records.map((record) => JSON.stringify(record) + '\n').join(''));
    return hook('stop', { transcript_path: transcript, stop_hook_active: false });
  };
  const withEnv = (fn) => {
    const saved = process.env.STUDIO_HOME;
    process.env.STUDIO_HOME = home;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = saved;
    }
  };
  // The pushes run in the background: wait for them to end before the folders go.
  const cleanup = async () => {
    await until(() => spawnSync('pgrep', ['-f', `${SCRIPT} push ${app}`]).status !== 0);
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, home, app, origin, run, hook, turn, withEnv, cleanup };
};

/** Waits for the background push to get somewhere. */
const until = async (check, ms = 10_000) => {
  for (let waited = 0; waited < ms; waited += 50) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

const remoteSha = (origin, branch) => {
  try {
    return git(origin, 'rev-parse', branch);
  } catch {
    return null;
  }
};

test('turnLabel: the last Checkpoint line, in plain words; else the first sentence of the reply', () => {
  assert.equal(turnLabel('I added it.\n\nCheckpoint: Added a dark-mode switch to the header'), 'Added a dark-mode switch to the header');
  assert.equal(turnLabel('Done.\n**Checkpoint:** "Made the `Save` button green"'), 'Made the Save button green');
  assert.equal(turnLabel('Checkpoint: first\nmore\ncheckpoint: second'), 'second');
  assert.equal(turnLabel('I made the list sortable by date. It also remembers your choice.'), 'I made the list sortable by date.');
  assert.equal(turnLabel('## Done\nThe header is blue now.'), 'Done');
  assert.equal(turnLabel(''), 'Made some changes');
  assert.equal(turnLabel('x'.repeat(300)).length, 200);
});

test('lastReply: the text of the turn the transcript ends with, skipping tool results and side chains', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-reply-')), 't.jsonl');
  const lines = [
    { type: 'user', message: { content: 'first' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Old reply.' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', name: 'Edit' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nCheckpoint: New' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n{"partial');
  assert.equal(lastReply(file), 'Done.\nCheckpoint: New');
  fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'user', message: { content: 'third' } }) + '\n');
  assert.equal(lastReply(file), '');
  assert.equal(lastReply(path.join(path.dirname(file), 'missing.jsonl')), '');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('nameFromPrompt: the first few words, plain and short', () => {
  assert.equal(nameFromPrompt('Add a **dark mode** switch to the header please'), 'Add a dark mode switch to');
  assert.equal(nameFromPrompt(''), 'Untitled feature');
});

test('start, two edit turns and one with no changes: two checkpoints with labels, prompts and data snapshots, all on the remote', async () => {
  const t = setup();
  try {
    const main = git(t.app, 'rev-parse', 'main');
    // Before any feature there is no develop, and so nothing to push (and nothing is noted as not backed up).
    assert.deepEqual(JSON.parse(t.run(['push']).stdout), { pushed: [], failed: [] });
    const started = t.run(['start', 'dark mode']);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(git(t.app, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(git(t.app, 'rev-parse', 'develop'), main);

    const first = t.turn(
      'Make the page dark',
      () => {
        fs.writeFileSync(path.join(t.app, 'page.html'), '<h1 class="dark">Getting started</h1>\n');
        fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 1');
      },
      'I made the page dark.\n\nCheckpoint: Made the page dark'
    );
    assert.equal(first.status, 0, first.stderr);
    const second = t.turn(
      'And add a toggle',
      () => {
        fs.writeFileSync(path.join(t.app, 'toggle.js'), 'export const toggle = () => {}\n');
        fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 2');
      },
      'Added a toggle in the corner. It remembers your choice.'
    );
    assert.equal(second.status, 0, second.stderr);
    const third = t.turn('What colour is it?', () => {}, "It's #111.");
    assert.equal(third.status, 0, third.stderr);

    const { feature } = t.withEnv(() => read(t.app));
    assert.equal(feature.name, 'dark mode');
    assert.equal(feature.base, main);
    assert.deepEqual(
      feature.checkpoints.map(({ label, prompt }) => ({ label, prompt })),
      [
        { label: 'Made the page dark', prompt: 'Make the page dark' },
        { label: 'Added a toggle in the corner.', prompt: 'And add a toggle' },
      ]
    );
    const [one, two] = feature.checkpoints;
    assert.equal(git(t.app, 'log', '--format=%s', 'main..develop'), 'Added a toggle in the corner.\nMade the page dark');
    assert.equal(git(t.app, 'rev-parse', 'develop'), two.sha);
    assert.equal(git(t.app, 'rev-parse', `${two.sha}^`), one.sha);

    const snapshots = path.join(t.withEnv(() => stateDir(t.app)), 'snapshots');
    assert.deepEqual(fs.readdirSync(snapshots).sort(), [main, one.sha, two.sha].sort());
    assert.equal(fs.readFileSync(path.join(snapshots, main, 'app.db'), 'utf8'), 'rows: 0');
    assert.equal(fs.readFileSync(path.join(snapshots, one.sha, 'app.db'), 'utf8'), 'rows: 1');
    assert.equal(fs.readFileSync(path.join(snapshots, two.sha, 'app.db'), 'utf8'), 'rows: 2');
    assert.ok(!fs.existsSync(path.join(snapshots, one.sha, 'logs')), 'logs are not snapshotted');

    assert.ok(await until(() => remoteSha(t.origin, 'develop') === two.sha), 'develop reaches the remote');
    assert.deepEqual(t.withEnv(() => read(t.app)).unpushed, []);
  } finally {
    await t.cleanup();
  }
});

test('a failed push is noted for the next try and never fails the turn; the next push sends it', async () => {
  const t = setup();
  try {
    t.run(['start', 'offline']);
    git(t.app, 'remote', 'set-url', 'origin', path.join(t.root, 'nowhere.git'));
    const result = t.turn(
      'Add a footer',
      () => fs.writeFileSync(path.join(t.app, 'footer.html'), '<footer></footer>\n'),
      'Checkpoint: Added a footer'
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    const sha = t.withEnv(() => read(t.app)).feature.checkpoints[0].sha;
    assert.ok(await until(() => t.withEnv(() => read(t.app)).unpushed.includes('develop')), 'the failure is recorded');

    git(t.app, 'remote', 'set-url', 'origin', t.origin);
    const retried = t.run(['push']);
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(JSON.parse(retried.stdout), { pushed: ['develop'], failed: [] }, fs.readFileSync(path.join(t.withEnv(() => stateDir(t.app)), 'push.json'), 'utf8'));
    assert.equal(remoteSha(t.origin, 'develop'), sha);
    assert.deepEqual(t.withEnv(() => read(t.app)).unpushed, []);
  } finally {
    await t.cleanup();
  }
});

test('a prompt with no feature open starts one named from it, and tells Claude', async () => {
  const t = setup();
  try {
    const result = t.hook('prompt-submit', { prompt: 'Add a list of my favourite books' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /a new one was started for this work, called "Add a list of my favourite"/);
    assert.equal(git(t.app, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(t.withEnv(() => read(t.app)).feature.name, "Add a list of my favourite");
    // With the feature open, the next prompt is only noted.
    assert.equal(t.hook('prompt-submit', { prompt: 'and their authors' }).stdout, '');
  } finally {
    await t.cleanup();
  }
});

test('starting a feature is refused while one is open', async () => {
  const t = setup();
  try {
    assert.equal(t.run(['start', 'one']).status, 0);
    const again = t.run(['start', 'two']);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /"one" is still being built/);
  } finally {
    await t.cleanup();
  }
});

test('the hooks do nothing outside the app, or for a subagent', async () => {
  const t = setup();
  try {
    const elsewhere = spawnSync(process.execPath, [SCRIPT, 'prompt-submit'], { cwd: t.root, env: { ...process.env, STUDIO_HOME: t.home }, input: JSON.stringify({ cwd: t.root, prompt: 'hi' }), encoding: 'utf8' });
    assert.equal(elsewhere.status, 0);
    assert.equal(elsewhere.stdout, '');
    assert.equal(t.hook('prompt-submit', { prompt: 'hi', agent_id: 'a1' }).stdout, '');
    assert.equal(t.withEnv(() => read(t.app)).feature, null);
    assert.ok(!fs.existsSync(t.withEnv(() => stateDir(t.app))));
    // No STUDIO_HOME config at all: the default app folder isn't this one, so nothing happens either.
    const unconfigured = spawnSync(process.execPath, [SCRIPT, 'stop'], { cwd: t.app, env: { ...process.env, STUDIO_HOME: path.join(t.root, 'empty') }, input: '{}', encoding: 'utf8' });
    assert.equal(unconfigured.status, 0);
    assert.equal(git(t.app, 'symbolic-ref', '--short', 'HEAD'), 'main');
  } finally {
    await t.cleanup();
  }
});
