'use strict';

/**
 * The studio's logs: every command's output in commands.log, big logs cut down, the session log from the reaper and
 * the hook, and `studio logs`, which zips them onto the Desktop. Against a temp HOME and STUDIO_HOME.
 *
 * Run tests: node --test lib/logs.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO = path.resolve(__dirname, '..', '..', 'bin', 'studio');
const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'studio-hook.py');

const setup = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-logs-')));
  const home = path.join(root, 'home');
  const studioHome = path.join(home, '.studio');
  const app = path.join(home, 'Studio', 'my-app');
  fs.mkdirSync(path.join(studioHome, 'logs', 'dictation'), { recursive: true });
  fs.mkdirSync(path.join(app, 'data', 'logs'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', app]);
  fs.writeFileSync(path.join(studioHome, 'config.json'), JSON.stringify({ appDir: app, name: 'my-app', appPort: 4001 }));
  fs.writeFileSync(path.join(studioHome, 'logs', 'actions.jsonl'), '{"endpoint":"/keep"}\n');
  fs.writeFileSync(path.join(studioHome, 'logs', 'dictation', 'clip.wav'), 'a voice');
  fs.writeFileSync(path.join(app, 'data', 'logs', 'dev.log'), 'App running at http://localhost:4001\n');
  const env = { ...process.env, HOME: home, STUDIO_HOME: studioHome };
  delete env.STUDIO_LOGGING;
  const run = (...args) => spawnSync(STUDIO, args, { encoding: 'utf8', env });
  return { root, home, studioHome, app, env, run, log: (name) => fs.readFileSync(path.join(studioHome, 'logs', name), 'utf8'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test('studio logs zips the logs, the app\'s dev.log, the config and a description of the Mac onto the Desktop, without dictation clips', () => {
  const t = setup();
  try {
    const result = t.run('logs');
    assert.equal(result.status, 0, result.stderr);
    const zip = result.stdout.match(/Saved (\S+\.zip)/)[1];
    assert.equal(path.dirname(zip), path.join(t.home, 'Desktop'));
    const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').map((line) => line.replace(/^studio-logs-\d{8}-\d{6}\//, ''));
    for (const name of ['logs/actions.jsonl', 'logs/commands.log', 'config.json', 'app-dev.log', 'info.txt']) assert.ok(listing.includes(name), `${name} in ${listing.join(', ')}`);
    assert.ok(!listing.some((name) => name.includes('dictation')), 'no recordings of a voice');
    const info = execFileSync('unzip', ['-p', zip, '*/info.txt'], { encoding: 'utf8' });
    assert.match(info, /ProductVersion/);
    assert.match(info, /App .*my-app, on main/);
    assert.match(info, /port 4000: (in use|free)/);
  } finally {
    t.cleanup();
  }
});

test('every studio command and what it printed go to commands.log; a log past 5 MB is cut to its last 1 MB', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.studioHome, 'logs', 'actions.jsonl'), 'x'.repeat(6 * 1024 * 1024));
    const result = t.run('switch', 'nope');
    assert.equal(result.status, 1);
    const log = t.log('commands.log');
    assert.match(log, /^--- \d{4}-\d\d-\d\d \d\d:\d\d:\d\d studio switch nope$/m);
    assert.match(log, /There's no app at .*nope/, 'what it printed, errors too');
    assert.equal(fs.statSync(path.join(t.studioHome, 'logs', 'actions.jsonl')).size, 1024 * 1024);
  } finally {
    t.cleanup();
  }
});

test('the session log: the hook notes each new session of a pane, once', () => {
  const t = setup();
  try {
    const hook = (session, source) =>
      execFileSync('python3', ['-I', HOOK, 'session-start'], { input: JSON.stringify({ session_id: session, source }), env: { ...t.env, HERDR_PANE_ID: 'w1:p1' } });
    hook('s1', 'startup');
    hook('s1', 'resume');
    hook('s2', 'clear');
    const lines = t.log('sessions.jsonl').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map(({ event, pane, session, source }) => [event, pane, session, source]), [['session', 'w1:p1', 's1', 'startup'], ['session', 'w1:p1', 's2', 'clear']]);
    assert.match(lines[0].ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  } finally {
    t.cleanup();
  }
});

test("the session log: the pane's record and herdr disagreeing is logged once, until it changes", () => {
  const t = setup();
  const saved = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = t.studioHome;
  try {
    const { withRealSessions } = require('./claude-reaper');
    const panes = path.join(t.root, 'panes');
    fs.mkdirSync(panes);
    fs.writeFileSync(path.join(panes, 'w1_p1.json'), JSON.stringify({ pane_id: 'w1:p1', session_id: 'old' }));
    const items = [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: 'new' } }];
    assert.equal(withRealSessions(items, panes)[0].agent_session.value, 'old', 'the record still wins');
    withRealSessions(items, panes);
    withRealSessions([{ ...items[0], agent_session: { value: 'newer' } }], panes);
    const lines = t.log('sessions.jsonl').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map(({ event, record, herdr }) => [event, record, herdr]), [['disagree', 'old', 'new'], ['disagree', 'old', 'newer']]);
  } finally {
    if (saved === undefined) delete process.env.STUDIO_HOME;
    else process.env.STUDIO_HOME = saved;
    t.cleanup();
  }
});
