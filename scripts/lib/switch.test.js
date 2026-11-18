'use strict';

/**
 * `studio switch <app>` end to end, against a temp HOME with a stand-in herdr that keeps its workspace's tabs in a
 * JSON file, so we can see which tabs the switch closes and in which folder `studio up` then starts them again.
 *
 * Run tests: node --test lib/switch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const STUDIO = path.resolve(__dirname, '..', '..', 'bin', 'studio');

/** herdr over a state file: { tabs: [{ tab_id, label, cwd, status }], runs: [[pane, command]], closed: [label] }. */
const HERDR = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.HERDR_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const [a, b, ...rest] = process.argv.slice(2);
const flag = (name) => rest[rest.indexOf(name) + 1];
const pane = (tab) => ({ pane_id: tab.tab_id + ':p', tab_id: tab.tab_id, agent: tab.label === 'claude' ? 'claude' : undefined, agent_status: tab.status ?? 'unknown', cwd: tab.cwd });
let out = {};
switch (a + ' ' + b) {
  case 'workspace list': out = { workspaces: [{ workspace_id: 'w1', label: 'studio' }] }; break;
  case 'tab list': out = { tabs: state.tabs }; break;
  case 'pane list': out = { panes: state.tabs.map(pane) }; break;
  case 'tab close': state.closed.push(state.tabs.find((t) => t.tab_id === rest[0]).label); state.tabs = state.tabs.filter((t) => t.tab_id !== rest[0]); break;
  case 'tab create': { const tab = { tab_id: 't' + Math.random().toString(36).slice(2, 8), label: flag('--label'), cwd: flag('--cwd'), atPrompt: true }; state.tabs.push(tab); out = { root_pane: pane(tab) }; break; }
  case 'pane process-info': { const tab = state.tabs.find((t) => t.tab_id + ':p' === flag('--pane')); out = { process_info: tab.atPrompt ? { foreground_process_group_id: 1, shell_pid: 1 } : { foreground_process_group_id: 2, shell_pid: 1 } }; break; }
  case 'pane run': state.runs.push([rest[0], rest[1]]); break;
}
fs.writeFileSync(file, JSON.stringify(state));
console.log(JSON.stringify({ result: out }));
`;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });

/** A temp HOME with two apps in ~/Studio (old-app configured), herdr's workspace running in old-app, and something answering as the cockpit. */
const setup = async (t, { claudeStatus = 'idle' } = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-switch-')));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['old-app', 'new-app']) {
    const dir = path.join(home, 'Studio', name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'v1');
  }
  fs.writeFileSync(path.join(bin, 'herdr'), HERDR, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\n', { mode: 0o755 });

  const cockpit = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => cockpit.listen(0, '127.0.0.1', resolve));
  t.after(() => cockpit.close());

  const studioHome = path.join(home, '.studio');
  fs.mkdirSync(studioHome, { recursive: true });
  const oldApp = path.join(home, 'Studio', 'old-app');
  fs.writeFileSync(path.join(studioHome, 'config.json'), JSON.stringify({ appDir: oldApp, name: 'old-app', appPort: 45999, prefs: { kept: true } }));

  const state = path.join(root, 'herdr.json');
  const tab = (label, cwd, extra = {}) => ({ tab_id: 't-' + label, label, cwd, atPrompt: false, ...extra });
  fs.writeFileSync(state, JSON.stringify({
    tabs: [tab('claude', oldApp, { status: claudeStatus }), tab('studio', root), tab('app', oldApp), tab('whisper', oldApp), tab('reaper', oldApp)],
    runs: [],
    closed: [],
  }));

  // Not spawnSync: the stand-in cockpit answers from this process, so its event loop has to keep running.
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(STUDIO, args, { env: {
      ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, HERDR_STATE: state,
      STUDIO_HOME: studioHome, STUDIO_PORT: String(cockpit.address().port), STUDIO_WORKSPACE: 'studio',
      STUDIO_NO_OPEN: '1', STUDIO_UPDATED: '1', STUDIO_WHISPER_PORT: '45998',
    } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return {
    home, run,
    config: () => JSON.parse(fs.readFileSync(path.join(studioHome, 'config.json'), 'utf8')),
    herdr: () => JSON.parse(fs.readFileSync(state, 'utf8')),
  };
};

test('switch points the config at the new app and restarts only the tabs that run in the app', async (t) => {
  const s = await setup(t);
  const result = await s.run('switch', 'new-app');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /now works on new-app/);

  const newApp = path.join(s.home, 'Studio', 'new-app');
  assert.deepEqual(s.config(), { appDir: newApp, name: 'new-app', appPort: 45999, prefs: { kept: true } });

  const herdr = s.herdr();
  assert.deepEqual(herdr.closed, ['reaper', 'claude', 'app']);
  for (const label of ['claude', 'app', 'reaper']) {
    const tab = herdr.tabs.find((candidate) => candidate.label === label);
    assert.equal(tab.cwd, newApp, `${label} starts in the new app`);
    assert.ok(herdr.runs.some(([pane]) => pane === tab.tab_id + ':p'), `${label} is started`);
  }
  assert.ok(herdr.tabs.some((tab) => tab.tab_id === 't-studio'), 'the studio server keeps running');
  const reaper = herdr.tabs.find((tab) => tab.label === 'reaper');
  assert.match(herdr.runs.find(([pane]) => pane === reaper.tab_id + ':p')[1], /keep 'studio' '.*new-app'/, 'the reaper keeps Claude going in the new app');
});

test('switch takes a folder as well as a name', async (t) => {
  const s = await setup(t);
  const result = await s.run('switch', path.join(s.home, 'Studio', 'new-app') + '/');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.config().name, 'new-app');
});

test('switch waits while Claude is working or waiting for an answer, and changes nothing', async (t) => {
  for (const [status, words] of [['working', /still working/], ['blocked', /waiting for an answer/]]) {
    const s = await setup(t, { claudeStatus: status });
    const result = await s.run('switch', 'new-app');
    assert.equal(result.status, 1);
    assert.match(result.stderr, words);
    assert.equal(s.config().name, 'old-app');
    assert.deepEqual(s.herdr().closed, []);
  }
});

test('switch to an app that does not exist names the ones that do', async (t) => {
  const s = await setup(t);
  const result = await s.run('switch', 'nope');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no app at .*nope.*new-app old-app/);
  assert.equal(s.config().name, 'old-app');
});

test('switch to the app it already works on just runs up', async (t) => {
  const s = await setup(t);
  const result = await s.run('switch', 'old-app');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already working on old-app/);
  assert.deepEqual(s.herdr().closed, []);
});

/** Someone else's Studio app, outside ~/Studio: main tagged v1 and v2, and develop a checkpoint ahead (work they haven't kept). */
const theirApp = (root, { branch = 'main' } = {}) => {
  const dir = path.join(root, 'their-app');
  fs.mkdirSync(dir);
  const commit = (message) => git(dir, '-c', 'user.name=her', '-c', 'user.email=her@example.com', 'commit', '-q', '--allow-empty', '-m', message);
  git(dir, 'init', '-q', '-b', branch);
  commit('Getting Started');
  git(dir, '-c', 'user.name=her', '-c', 'user.email=her@example.com', 'tag', '-a', 'v1', '-m', 'v1 Getting Started');
  commit('Writing hub');
  git(dir, '-c', 'user.name=her', '-c', 'user.email=her@example.com', 'tag', '-a', 'v2', '-m', 'v2 Writing hub');
  git(dir, 'checkout', '-q', '-b', 'develop');
  commit('Checkpoint: half-built calendar');
  return dir;
};

test('studio clone copies their app into ~/Studio from their latest version, keeps it from pushing back, and switches to it', async (t) => {
  const s = await setup(t);
  const theirs = theirApp(path.dirname(s.home));
  const result = await s.run('clone', theirs, 'writing-hub');
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(s.home, 'Studio', 'writing-hub');
  assert.match(result.stdout, /Made writing-hub from v2\./);
  assert.match(result.stdout, /work in progress \(not kept yet\) is on upstream\/develop/);
  assert.match(result.stdout, /Nothing is pushed back/);
  assert.equal(s.config().appDir, dir, 'switched to it');
  assert.equal(execFileSync('git', ['-C', dir, 'remote'], { encoding: 'utf8' }).trim(), 'upstream', 'no origin, so the studio pushes nothing');
  const sha = (ref) => execFileSync('git', ['-C', dir, 'rev-parse', ref], { encoding: 'utf8' }).trim();
  assert.equal(sha('develop'), sha('v2^{}'), 'from their latest kept version');
  assert.equal(sha('main'), sha('v2^{}'));
  assert.equal(execFileSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'develop');
});

test('studio clone names the app after the repo, and refuses a name in use or a repo that is not a Studio app', async (t) => {
  const s = await setup(t);
  const root = path.dirname(s.home);
  const theirs = theirApp(root);
  let result = await s.run('clone', theirs);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(s.home, 'Studio', 'their-app')));
  result = await s.run('clone', theirs);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already there\. Switch to it with: studio switch their-app/);

  const other = path.join(root, 'not-studio');
  fs.mkdirSync(other);
  git(other, 'init', '-q', '-b', 'master');
  git(other, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'x');
  result = await s.run('clone', other);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has no main branch, so it isn't a Studio app/);
  assert.ok(!fs.existsSync(path.join(s.home, 'Studio', 'not-studio')), 'nothing left behind');

  result = await s.run('clone', path.join(root, 'nowhere'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /There's no app at/);
});
