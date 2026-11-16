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

const { bringBack, discard, endPreview, goBack, keep, lastReply, nameFromPrompt, preview, read, restore, runGate, stateDir, summarise, turnLabel, versions } = require('./feature');

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

/**
 * An app like the template, for Keep: package.json's `npm test` and `npm run typecheck` fail while a file named `broken` (or
 * `badtypes`) exists, FEATURES.md has v1's entry, and v1 is an annotated tag pushed with main. STUDIO_HOME is set in
 * this process too, for the in-process calls (keep, discard, runGate are run here, the hooks as Claude Code runs them).
 */
const keepSetup = () => {
  const t = setup();
  const check = (name) => `node -e "process.exit(require('fs').existsSync('${name}') ? 1 : 0)"`;
  fs.writeFileSync(path.join(t.app, 'package.json'), JSON.stringify({ name: 'my-app', private: true, scripts: { test: check('broken'), typecheck: check('badtypes') } }, null, 2) + '\n');
  fs.writeFileSync(path.join(t.app, 'FEATURES.md'), '# Features\n\nWhat each version added.\n\n## v1 Getting Started\n\nA starting point.\n');
  git(t.app, 'add', '-A');
  git(t.app, 'commit', '-q', '--amend', '--no-edit');
  git(t.app, 'tag', '-a', 'v1', '-m', 'v1 Getting Started');
  git(t.app, 'push', '-q', '--force', '--follow-tags', 'origin', 'main');
  const saved = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = t.home;
  const summariser = path.join(t.root, 'summarise.sh');
  fs.writeFileSync(summariser, '#!/bin/sh\necho "A dark page, with a toggle in the corner that remembers your choice."\n', { mode: 0o755 });
  return {
    ...t,
    summariser,
    cleanup: async () => {
      if (saved === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = saved;
      await t.cleanup();
    },
  };
};

const tagObject = (dir, tag) => git(dir, 'rev-parse', `refs/tags/${tag}`);
const entries = (app) => fs.readFileSync(path.join(app, 'FEATURES.md'), 'utf8').match(/^## v\d+ .*/gm);

/** main moved only by a fast-forward: from `before` to a commit whose parent is it. */
const assertFastForward = (app, before) => {
  const after = git(app, 'rev-parse', 'main');
  assert.equal(git(app, 'rev-parse', `${after}^`), before, 'main moved by one commit on top of where it was');
  return after;
};

test('Keep, green: the checkpoints become one commit on main named after the feature, tagged v2, with its summary in FEATURES.md; develop equals main; all reach the remote', async () => {
  const t = keepSetup();
  try {
    const v1 = git(t.app, 'rev-parse', 'main');
    const v1Tag = tagObject(t.app, 'v1');
    t.run(['start', 'dark mode']);
    t.turn('Make the page dark', () => {
      fs.writeFileSync(path.join(t.app, 'page.html'), '<h1 class="dark">Getting started</h1>\n');
      fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 1');
    }, 'Checkpoint: Made the page dark');
    t.turn('And add a toggle', () => fs.writeFileSync(path.join(t.app, 'toggle.js'), 'export const toggle = () => {}\n'), 'Checkpoint: Added a toggle');
    assert.equal(read(t.app).feature.checkpoints.length, 2);

    // Keep is refused until the tests have run for these files.
    assert.throws(() => keep(t.app, { summary: 'x' }), /changed since the tests last ran/);
    const gate = await runGate(t.app);
    assert.equal(gate.ok, true, JSON.stringify(gate.results));
    assert.deepEqual(gate.results.map((result) => [result.name, result.ok]), [['Tests', true], ['Type check', true]]);
    const summary = await summarise(t.app, { command: t.summariser });
    assert.deepEqual(summary, { text: 'A dark page, with a toggle in the corner that remembers your choice.', fallback: false });

    const kept = keep(t.app, { summary: summary.text });
    assert.equal(kept.version, 'v2');
    const v2 = assertFastForward(t.app, v1);
    assert.equal(kept.sha, v2);
    assert.equal(git(t.app, 'log', '-1', '--format=%s', 'main'), 'dark mode');
    assert.equal(git(t.app, 'show', 'main:page.html'), '<h1 class="dark">Getting started</h1>');
    assert.equal(git(t.app, 'show', 'main:toggle.js'), 'export const toggle = () => {}');
    assert.equal(git(t.app, 'cat-file', '-p', 'v2').split('\n\n')[1].trim(), 'v2 dark mode', 'an annotated tag, "vN <name>"');
    assert.equal(git(t.app, 'rev-parse', 'v2^{commit}'), v2);
    assert.equal(tagObject(t.app, 'v1'), v1Tag, 'v1 is untouched');
    assert.deepEqual(versions(t.app).map(({ tag, name, sha }) => ({ tag, name, sha })), [{ tag: 'v1', name: 'Getting Started', sha: v1 }, { tag: 'v2', name: 'dark mode', sha: v2 }]);

    // The FEATURES.md entry is part of the version's one commit.
    assert.deepEqual(entries(t.app), ['## v1 Getting Started', '## v2 dark mode']);
    assert.match(git(t.app, 'show', 'main:FEATURES.md'), /## v1 Getting Started\n\nA starting point.\n\n## v2 dark mode\n\nA dark page, with a toggle in the corner that remembers your choice.$/);

    assert.equal(git(t.app, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(git(t.app, 'rev-parse', 'develop'), v2);
    assert.equal(git(t.app, 'status', '--porcelain'), '', 'nothing left uncommitted');
    assert.equal(fs.readFileSync(path.join(t.app, 'data', 'app.db'), 'utf8'), 'rows: 1', 'the data stays as it is');
    assert.equal(read(t.app).feature, null, 'the feature is closed');
    assert.ok(!fs.existsSync(path.join(stateDir(t.app), 'snapshots')));

    // Pushed as the server does it: develop forced, main plainly with the tags on it.
    const pushed = t.run(['push', t.app, 'main']);
    assert.deepEqual(JSON.parse(pushed.stdout), { pushed: ['develop', 'main'], failed: [] }, pushed.stderr);
    assert.equal(remoteSha(t.origin, 'main'), v2);
    assert.equal(remoteSha(t.origin, 'develop'), v2);
    assert.equal(tagObject(t.origin, 'v2'), tagObject(t.app, 'v2'));
    assert.equal(tagObject(t.origin, 'v1'), v1Tag);
  } finally {
    await t.cleanup();
  }
});

test('Keep with failing tests is refused and moves nothing, then "keep anyway" keeps it; a stale test run or no change is refused', async () => {
  const t = keepSetup();
  try {
    const v1 = git(t.app, 'rev-parse', 'main');
    t.run(['start', 'nothing yet']);
    await runGate(t.app);
    assert.throws(() => keep(t.app, {}), /Nothing has changed since v1, so there is nothing to keep\. Discard "nothing yet" instead\./);
    assert.throws(() => keep(t.app, { anyway: true }), /Nothing has changed/);
    discard(t.app);

    t.run(['start', 'search box']);
    t.turn('Add a search box', () => {
      fs.writeFileSync(path.join(t.app, 'search.js'), 'export const search = 1\n');
      fs.writeFileSync(path.join(t.app, 'broken'), '');
      fs.writeFileSync(path.join(t.app, 'badtypes'), '');
    }, 'Added a search box. It filters as you type.');
    const gate = await runGate(t.app);
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.results.map((result) => [result.name, result.ok]), [['Tests', false], ['Type check', false]]);
    assert.ok(gate.results.every((result) => typeof result.output === 'string'));

    const features = fs.readFileSync(path.join(t.app, 'FEATURES.md'), 'utf8');
    const develop = git(t.app, 'rev-parse', 'develop');
    assert.throws(() => keep(t.app, { summary: 'A search box.' }), /Tests and Type check failed, so "search box" can't be kept yet\./);
    assert.equal(git(t.app, 'rev-parse', 'main'), v1, 'main has not moved');
    assert.equal(git(t.app, 'rev-parse', 'develop'), develop);
    assert.equal(fs.readFileSync(path.join(t.app, 'FEATURES.md'), 'utf8'), features);
    assert.deepEqual(versions(t.app).map((version) => version.tag), ['v1']);
    assert.equal(read(t.app).feature.name, 'search box', 'still open');

    // A green run for other files doesn't count: here, the tests pass once the files are fixed, then a file changes.
    fs.rmSync(path.join(t.app, 'broken'));
    fs.rmSync(path.join(t.app, 'badtypes'));
    assert.equal((await runGate(t.app)).ok, true);
    fs.writeFileSync(path.join(t.app, 'broken'), '');
    assert.throws(() => keep(t.app, {}), /changed since the tests last ran/);

    // Keep anyway, with no summary (it failed): the checkpoint labels stand in, and the uncommitted file comes along.
    const kept = keep(t.app, { anyway: true });
    assert.equal(kept.version, 'v2');
    assert.equal(kept.summary, 'Added a search box.');
    const v2 = assertFastForward(t.app, v1);
    assert.equal(git(t.app, 'ls-tree', '--name-only', 'main', 'broken'), 'broken');
    assert.deepEqual(entries(t.app), ['## v1 Getting Started', '## v2 search box']);
    assert.equal(git(t.app, 'rev-parse', 'develop'), v2);

    // The next feature is v3, on top of v2; v2 stays as it was.
    const v2Tag = tagObject(t.app, 'v2');
    t.run(['start', 'fix the tests']);
    t.turn('Fix the tests', () => fs.rmSync(path.join(t.app, 'broken')), 'Checkpoint: Fixed the tests');
    assert.equal((await runGate(t.app)).ok, true);
    assert.equal(keep(t.app, { summary: 'The tests pass again.' }).version, 'v3');
    assertFastForward(t.app, v2);
    assert.equal(tagObject(t.app, 'v2'), v2Tag);
    assert.deepEqual(entries(t.app), ['## v1 Getting Started', '## v2 search box', '## v3 fix the tests']);
  } finally {
    await t.cleanup();
  }
});

test('Discard: develop back to main, new files gone, data/ as it was at the start (logs kept), develop force-pushed; main and tags untouched', async () => {
  const t = keepSetup();
  try {
    const v1 = git(t.app, 'rev-parse', 'main');
    const v1Tag = tagObject(t.app, 'v1');
    fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 5');
    t.run(['start', 'oops']);
    t.turn('Rewrite the page', () => {
      fs.writeFileSync(path.join(t.app, 'page.html'), '<h1>Oops</h1>\n');
      fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 99');
      fs.writeFileSync(path.join(t.app, 'data', 'extra.db'), 'new');
    }, 'Checkpoint: Rewrote the page');
    assert.ok(await until(() => remoteSha(t.origin, 'develop') === read(t.app).feature.checkpoints[0].sha), 'the checkpoint reached the remote');
    fs.writeFileSync(path.join(t.app, 'stray.js'), 'not committed\n');
    fs.writeFileSync(path.join(t.app, 'data', 'logs', 'dev.log'), 'log after');

    assert.deepEqual(discard(t.app), { name: 'oops', checkpoints: 1 });
    assert.equal(git(t.app, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(git(t.app, 'rev-parse', 'develop'), v1);
    assert.equal(git(t.app, 'rev-parse', 'main'), v1);
    assert.equal(tagObject(t.app, 'v1'), v1Tag);
    assert.equal(git(t.app, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(t.app, 'page.html'), 'utf8'), '<h1>Getting started</h1>\n');
    assert.ok(!fs.existsSync(path.join(t.app, 'stray.js')));
    assert.deepEqual(fs.readdirSync(path.join(t.app, 'data')).sort(), ['app.db', 'logs']);
    assert.equal(fs.readFileSync(path.join(t.app, 'data', 'app.db'), 'utf8'), 'rows: 5');
    assert.equal(fs.readFileSync(path.join(t.app, 'data', 'logs', 'dev.log'), 'utf8'), 'log after');
    assert.equal(read(t.app).feature, null);
    assert.throws(() => discard(t.app), /no feature is being built/);

    const pushed = t.run(['push']);
    assert.deepEqual(JSON.parse(pushed.stdout), { pushed: ['develop'], failed: [] }, pushed.stderr);
    assert.equal(remoteSha(t.origin, 'develop'), v1);
    assert.equal(remoteSha(t.origin, 'main'), v1);
    assert.equal(tagObject(t.origin, 'v1'), v1Tag);
  } finally {
    await t.cleanup();
  }
});

/** Every file in the app but .git and node_modules, with its contents, so two states can be compared exactly. */
const allFiles = (dir, base = dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !['.git', 'node_modules'].includes(entry.name))
      .flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? Object.entries(allFiles(file, base)) : [[path.relative(base, file), fs.readFileSync(file, 'utf8')]];
      })
  );

test('Go back to here: develop and data/ back to the checkpoint; Bring them back restores everything exactly until her next message, which tells Claude once', async () => {
  const t = keepSetup();
  try {
    const write = (file, text) => fs.writeFileSync(path.join(t.app, file), text);
    t.run(['start', 'dark mode']);
    t.turn('Make it dark', () => (write('page.html', 'dark\n'), write('data/app.db', 'rows: 1')), 'Checkpoint: Made the page dark');
    t.turn('Add a toggle', () => (write('toggle.js', 'toggle\n'), write('data/app.db', 'rows: 2')), 'Checkpoint: Added a toggle');
    t.turn('Remember it', () => (write('page.html', 'dark, remembered\n'), write('data/prefs.db', 'dark')), 'Checkpoint: Remembered the choice');
    const [first, second, third] = read(t.app).feature.checkpoints;
    // Since the last checkpoint: a change not committed, a new file, a deleted one, and the app used (data changed, logs too).
    write('page.html', 'not yet a checkpoint\n');
    write('stray.js', 'new\n');
    fs.rmSync(path.join(t.app, 'toggle.js'));
    write('data/app.db', 'rows: 7');
    assert.equal((await runGate(t.app)).ok, true);
    const head = git(t.app, 'rev-parse', 'HEAD');
    const status = git(t.app, 'status', '--porcelain');
    const before = allFiles(t.app);

    assert.deepEqual(goBack(t.app, second.sha), { to: { sha: second.sha, label: 'Added a toggle' }, discarded: ['Remembered the choice'] });
    assert.equal(git(t.app, 'rev-parse', 'develop'), second.sha);
    assert.equal(git(t.app, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(t.app, 'page.html'), 'utf8'), 'dark\n');
    assert.ok(fs.existsSync(path.join(t.app, 'toggle.js')) && !fs.existsSync(path.join(t.app, 'stray.js')));
    assert.deepEqual(fs.readdirSync(path.join(t.app, 'data')).sort(), ['app.db', 'logs']);
    assert.equal(fs.readFileSync(path.join(t.app, 'data', 'app.db'), 'utf8'), 'rows: 2');
    assert.deepEqual(read(t.app).feature.checkpoints.map((checkpoint) => checkpoint.sha), [first.sha, second.sha]);
    // The test run was for the files as they were, so Keep needs them run again.
    assert.throws(() => keep(t.app, {}), /changed since the tests last ran/);

    // Going back further before her next message: Bring them back still brings back everything there was before the first.
    assert.deepEqual(goBack(t.app, first.sha).discarded, ['Added a toggle', 'Remembered the choice']);
    assert.equal(fs.readFileSync(path.join(t.app, 'data', 'app.db'), 'utf8'), 'rows: 1');
    assert.throws(() => goBack(t.app, third.sha), /isn't one of this feature's/);

    assert.deepEqual(bringBack(t.app), { checkpoints: 3 });
    assert.equal(git(t.app, 'rev-parse', 'develop'), head);
    assert.equal(git(t.app, 'status', '--porcelain'), status);
    assert.deepEqual(allFiles(t.app), before, 'code, uncommitted changes and data exactly as before');
    assert.deepEqual(read(t.app).feature.checkpoints, [first, second, third]);
    assert.equal(read(t.app).wentBack, null);
    assert.throws(() => bringBack(t.app), /nothing to bring back/);

    // Back to the second again; develop is force-pushed.
    goBack(t.app, second.sha);
    const pushed = t.run(['push']);
    assert.deepEqual(JSON.parse(pushed.stdout), { pushed: ['develop'], failed: [] }, pushed.stderr);
    assert.equal(remoteSha(t.origin, 'develop'), second.sha);

    // Her next message lets the later checkpoint go and tells Claude, once.
    const sent = t.hook('prompt-submit', { prompt: 'Make the toggle blue' });
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(
      sent.stdout,
      `[studio] She went back to the checkpoint "Added a toggle": the app's code and data are as they were then. The change after it was discarded: "Remembered the choice". Don't assume anything from them is still there.`
    );
    assert.equal(read(t.app).wentBack, null);
    assert.throws(() => bringBack(t.app), /nothing to bring back/);
    assert.deepEqual(fs.readdirSync(path.join(stateDir(t.app), 'snapshots')).sort(), [read(t.app).feature.base, first.sha, second.sha].sort());
    assert.equal(t.hook('prompt-submit', { prompt: 'And bigger' }).stdout, '');

    // Work goes on from there; and a feature closed while she has gone back leaves nothing to bring back.
    t.turn('Make it bigger', () => write('toggle.js', 'big toggle\n'), 'Checkpoint: Made the toggle bigger');
    assert.deepEqual(read(t.app).feature.checkpoints.map((checkpoint) => checkpoint.label), ['Made the page dark', 'Added a toggle', 'Made the toggle bigger']);
    goBack(t.app, first.sha);
    discard(t.app);
    assert.equal(read(t.app).wentBack, null);
  } finally {
    await t.cleanup();
  }
});

test('A change holding a value from .env is never committed: Claude is told to move it (once per turn), Keep refuses it, short values are ignored', async () => {
  const t = keepSetup();
  try {
    const write = (file, text) => fs.writeFileSync(path.join(t.app, file), text);
    const KEY = 'sk-live-0123456789abcdef';
    const QUOTED = 'a quoted secret';
    t.run(['start', 'ai helper']);
    const head = git(t.app, 'rev-parse', 'HEAD');
    const stop = (active) => t.hook('stop', { last_assistant_message: 'Checkpoint: Added the AI helper', stop_hook_active: active });
    // .env not yet ignored by git: committing it would publish every value in it.
    write('.env', `# keys\nOPENAI_KEY=${KEY}\nexport QUOTED="${QUOTED}"\nSHORT=abc1234\n`);
    t.hook('prompt-submit', { prompt: 'Add an AI helper' });
    write('page.html', '<h1>AI</h1>\n');
    let stopped = stop(false);
    assert.equal(stopped.status, 0);
    const blocked = JSON.parse(stopped.stdout);
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason, /^Nothing was saved as a checkpoint, because the changes contain values from \.env: \.env has the value of OPENAI_KEY; \.env has the value of QUOTED\. \.env itself must never be committed/);
    assert.equal(git(t.app, 'rev-parse', 'HEAD'), head, 'nothing committed');
    assert.equal(git(t.app, 'diff', '--cached', '--name-only'), '', 'nothing left staged');

    // Claude ignores .env but puts the key in the code. A second refusal in the same turn doesn't keep it going again.
    write('.gitignore', 'data/\n.env\n');
    write('ai.js', `const key = '${KEY}'\nconst pin = 'abc1234'\n`);
    stopped = stop(true);
    assert.equal(stopped.stdout, '');
    assert.match(stopped.stderr, /ai\.js has the value of OPENAI_KEY\. Secrets belong in \.env only\. Take the value out of the code and read it with process\.env\.OPENAI_KEY instead/);
    assert.equal(git(t.app, 'rev-parse', 'HEAD'), head);
    for (const output of [blocked.reason, stopped.stdout, stopped.stderr]) assert.ok(!output.includes(KEY) && !output.includes(QUOTED), 'no value in what is said');

    // Moved to process.env: the checkpoint is made, with the prompt of the turn; a value shorter than 8 characters doesn't count.
    write('ai.js', `const key = process.env.OPENAI_KEY\nconst pin = 'abc1234'\n`);
    stopped = stop(true);
    assert.equal(stopped.stdout, '', stopped.stderr);
    const [made] = read(t.app).feature.checkpoints;
    assert.equal(made.label, 'Added the AI helper');
    assert.equal(made.prompt, 'Add an AI helper');
    assert.equal(git(t.app, 'rev-parse', 'HEAD'), made.sha);

    // Keep checks everything it would put on main, uncommitted files too, and says which (never the value).
    write('leak.js', `export const q = "${QUOTED}"\n`);
    assert.equal((await runGate(t.app)).ok, true);
    assert.throws(
      () => keep(t.app, { summary: 'An AI helper.' }),
      (error) => /"ai helper" can't be kept, because it contains secrets from \.env \(leak\.js has the value of QUOTED\)\. Ask Claude to move them into \.env\./.test(error.message) && !error.message.includes(QUOTED)
    );
    assert.equal(versions(t.app).length, 1);
    fs.rmSync(path.join(t.app, 'leak.js'));
    assert.equal((await runGate(t.app)).ok, true);
    assert.equal(keep(t.app, { summary: 'An AI helper.' }).version, 'v2');

    // No value is written anywhere in the studio's state, the pushes' errors included.
    await until(() => spawnSync('pgrep', ['-f', `push ${t.app}`]).status !== 0);
    const found = spawnSync('grep', ['-rlF', '-e', KEY, '-e', QUOTED, t.home], { encoding: 'utf8' });
    assert.equal(found.status, 1, `found in ${found.stdout}`);
  } finally {
    await t.cleanup();
  }
});

/** keepSetup, then v2 "dark mode" kept from a turn (in session s1) that changed page.html and package.json and added dark.css. */
const versionsSetup = () => {
  const t = keepSetup();
  t.run(['start', 'dark mode']);
  t.turn('Make the page dark', () => {
    fs.writeFileSync(path.join(t.app, 'page.html'), '<h1 class="dark">Getting started</h1>\n');
    fs.writeFileSync(path.join(t.app, 'dark.css'), 'body { background: black }\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(t.app, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(t.app, 'package.json'), JSON.stringify({ ...pkg, dependencies: { colour: '1.0.0' } }, null, 2) + '\n');
  }, 'Checkpoint: Made the page dark');
  keep(t.app, { summary: 'A dark page.', anyway: true });
  return t;
};

const refs = (dir) => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)');

test('Preview an old version and back: the code (uncommitted changes too) and data/ are exactly as before; no branch or tag moves; no feature starts meanwhile', async () => {
  const t = versionsSetup();
  try {
    const [v1, v2] = versions(t.app);
    assert.deepEqual(v2.sessions, ['s1'], 'the Claude session v2 was built in');
    assert.deepEqual(v1.sessions, [], "the template's versions have none");

    // Things in no version: an edited file, a new file, and data/ changed since.
    fs.writeFileSync(path.join(t.app, 'page.html'), '<h1 class="dark">Hello</h1>\n');
    fs.writeFileSync(path.join(t.app, 'notes.txt'), 'mine\n');
    fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 7');
    const before = { files: allFiles(t.app), status: git(t.app, 'status', '--porcelain'), head: git(t.app, 'rev-parse', 'HEAD'), refs: refs(t.app) };

    const shown = preview(t.app, 'v1');
    assert.equal(shown.tag, 'v1');
    assert.equal(shown.name, 'Getting Started');
    assert.equal(shown.packagesDiffer, true, "v2 changed package.json, so v1's packages differ");
    assert.equal(git(t.app, 'rev-parse', 'HEAD'), v1.sha);
    assert.throws(() => git(t.app, 'symbolic-ref', '-q', 'HEAD'), undefined, 'detached: no branch is checked out');
    assert.equal(git(t.app, 'status', '--porcelain'), '', "exactly v1's code");
    assert.equal(fs.readFileSync(path.join(t.app, 'page.html'), 'utf8'), '<h1>Getting started</h1>\n');
    assert.ok(!fs.existsSync(path.join(t.app, 'dark.css')) && !fs.existsSync(path.join(t.app, 'notes.txt')));
    assert.equal(fs.readFileSync(path.join(t.app, 'data', 'app.db'), 'utf8'), 'rows: 7', "the app's data meanwhile");
    assert.equal(read(t.app).preview.tag, 'v1');
    assert.equal(refs(t.app), before.refs, 'no branch or tag moved');

    // No feature starts: not from the cockpit, nor from a prompt, which tells Claude not to change anything.
    assert.match(t.run(['start', 'oops']).stderr, /previewing v1/);
    assert.match(t.hook('prompt-submit', { prompt: 'Make it blue' }).stdout, /previewing v1 \("Getting Started"\).*Don't change any files/);
    assert.equal(read(t.app).feature, null);
    // A turn that changes files anyway makes no checkpoint, and what it changed goes at the end of the preview.
    t.turn('Make it blue', () => fs.writeFileSync(path.join(t.app, 'page.html'), 'blue'), 'Checkpoint: Blue');
    assert.equal(read(t.app).feature, null);
    fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 8 (used while previewing)');

    // Another version on top, then back to the latest: everything as before the first.
    assert.equal(preview(t.app, 'v2').packagesDiffer, false);
    assert.equal(git(t.app, 'rev-parse', 'HEAD'), v2.sha);
    assert.deepEqual(endPreview(t.app), { tag: 'v2' });
    assert.equal(git(t.app, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(git(t.app, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(t.app, 'status', '--porcelain'), before.status, 'uncommitted changes show as uncommitted again');
    assert.deepEqual(allFiles(t.app), before.files, 'every file, code and data/, as it was');
    assert.equal(refs(t.app), before.refs);
    assert.equal(read(t.app).preview, null);
    assert.ok(!fs.existsSync(path.join(stateDir(t.app), 'snapshots', 'preview')));
    assert.throws(() => endPreview(t.app), /aren't previewing/);
    assert.equal(t.hook('prompt-submit', { prompt: 'hello' }).stdout.includes('previewing'), false);
  } finally {
    await t.cleanup();
  }
});

test('Restore: a new commit on main with the old version’s code, tagged as the next version, with a FEATURES.md entry; no version is rewritten; data/ stays; pushed', async () => {
  const t = versionsSetup();
  try {
    const [v1, v2] = versions(t.app);
    const tags = { v1: tagObject(t.app, 'v1'), v2: tagObject(t.app, 'v2') };
    fs.writeFileSync(path.join(t.app, 'data', 'app.db'), 'rows: 9');
    // Restoring from a preview ends it first.
    preview(t.app, 'v1');

    const restored = restore(t.app, 'v1');
    assert.equal(restored.version, 'v3');
    assert.equal(restored.restored, 'v1');
    const v3 = assertFastForward(t.app, v2.sha);
    assert.equal(restored.sha, v3);
    assert.equal(read(t.app).preview, null);
    assert.equal(git(t.app, 'cat-file', '-p', 'v3').split('\n\n')[1].trim(), 'v3 restore v1');
    assert.equal(git(t.app, 'log', '-1', '--format=%s', 'main'), 'Restore v1');
    assert.equal(git(t.app, 'diff', '--stat', v1.sha, v3, '--', '.', ':(exclude)FEATURES.md'), '', "v1's code exactly");
    assert.deepEqual(entries(t.app), ['## v1 Getting Started', '## v2 dark mode', '## v3 restore v1']);
    assert.match(git(t.app, 'show', 'main:FEATURES.md'), /## v3 restore v1\n\nBrought back v1 \("Getting Started"\): the app's code is as it was then, and its data as it is now\.$/);
    assert.deepEqual(tags, { v1: tagObject(t.app, 'v1'), v2: tagObject(t.app, 'v2') }, 'no tag rewritten');
    assert.deepEqual(versions(t.app).map(({ tag, name, sessions }) => [tag, name, sessions.length]), [['v1', 'Getting Started', 0], ['v2', 'dark mode', 1], ['v3', 'restore v1', 0]]);
    assert.equal(git(t.app, 'symbolic-ref', '--short', 'HEAD'), 'develop');
    assert.equal(git(t.app, 'rev-parse', 'develop'), v3);
    assert.equal(git(t.app, 'status', '--porcelain'), '');
    assert.ok(!fs.existsSync(path.join(t.app, 'dark.css')));
    assert.equal(fs.readFileSync(path.join(t.app, 'data', 'app.db'), 'utf8'), 'rows: 9', 'the data stays as it is');

    // Nothing to restore when the code is that version's already; restoring v2 is v4.
    assert.throws(() => restore(t.app, 'v1'), /already as it was in v1/);
    assert.throws(() => restore(t.app, 'v9'), /there is no version v9/);
    assert.equal(restore(t.app, 'v2').version, 'v4');
    assertFastForward(t.app, v3);
    assert.equal(fs.readFileSync(path.join(t.app, 'dark.css'), 'utf8'), 'body { background: black }\n');

    // Changes in no version aren't thrown away by a restore.
    fs.writeFileSync(path.join(t.app, 'page.html'), 'mine');
    assert.throws(() => restore(t.app, 'v1'), /changes that are in no version/);
    git(t.app, 'checkout', '--', 'page.html');

    const pushed = t.run(['push', t.app, 'main']);
    assert.deepEqual(JSON.parse(pushed.stdout), { pushed: ['develop', 'main'], failed: [] }, pushed.stderr);
    for (const tag of ['v1', 'v2', 'v3', 'v4']) assert.equal(tagObject(t.origin, tag), tagObject(t.app, tag));
    assert.equal(remoteSha(t.origin, 'main'), git(t.app, 'rev-parse', 'main'));
  } finally {
    await t.cleanup();
  }
});

test('Preview and Restore are refused while a feature is open, and change nothing', async () => {
  const t = versionsSetup();
  try {
    t.run(['start', 'search box']);
    t.turn('Add search', () => fs.writeFileSync(path.join(t.app, 'search.js'), 'x\n'), 'Checkpoint: Added search');
    const before = { files: allFiles(t.app), refs: refs(t.app) };
    assert.throws(() => preview(t.app, 'v1'), /"search box" is being built\. Keep it or discard it before you preview a version\./);
    assert.throws(() => restore(t.app, 'v1'), /"search box" is being built\. Keep it or discard it before you restore a version\./);
    assert.deepEqual({ files: allFiles(t.app), refs: refs(t.app) }, before);
    assert.equal(read(t.app).preview, null);
  } finally {
    await t.cleanup();
  }
});

test('summarise falls back to the checkpoint labels when the summariser fails, prints nothing or is too slow', async () => {
  const t = keepSetup();
  try {
    t.run(['start', 'dark mode']);
    t.turn('Make it dark', () => fs.writeFileSync(path.join(t.app, 'page.html'), 'dark\n'), 'Checkpoint: Made the page dark');
    t.turn('Add a toggle', () => fs.writeFileSync(path.join(t.app, 'toggle.js'), 'toggle\n'), 'Added a toggle.');
    const stub = (name, body) => {
      const file = path.join(t.root, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    };
    const fallback = { text: 'Made the page dark. Added a toggle.', fallback: true };
    assert.deepEqual(await summarise(t.app, { command: stub('fails.sh', 'echo half; exit 1') }), fallback);
    assert.deepEqual(await summarise(t.app, { command: stub('silent.sh', 'true') }), fallback);
    assert.deepEqual(await summarise(t.app, { command: path.join(t.root, 'missing.sh') }), fallback);
    const started = Date.now();
    assert.deepEqual(await summarise(t.app, { command: stub('slow.sh', 'sleep 30; echo late'), timeoutMs: 300 }), fallback);
    assert.ok(Date.now() - started < 5000, 'a slow summariser is given up on');
    // The summariser gets the app's folder, and the digest lists the checkpoints and the changes.
    const digest = t.run(['digest', t.app]);
    assert.equal(digest.status, 0, digest.stderr);
    const text = fs.readFileSync(digest.stdout.trim(), 'utf8');
    assert.match(text, /# The feature: dark mode/);
    assert.match(text, /1\. Made the page dark\n   She asked: Make it dark/);
    assert.match(text, /toggle\.js/);
    assert.match(text, /## v1 Getting Started/);
  } finally {
    await t.cleanup();
  }
});
