'use strict';

/**
 * `studio down`: closes the studio's herdr workspace, unless Claude is mid-turn. Against a stand-in herdr that logs what it is
 * asked, and a temp HOME and STUDIO_HOME.
 *
 * Run tests: node --test lib/down.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO = path.resolve(__dirname, '..', '..', 'bin', 'studio');

const setup = ({ running = true, claudeStatus = 'idle' } = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-down-')));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'herdr.log');
  fs.mkdirSync(bin);
  const workspaces = running ? [{ workspace_id: 'w1', label: 'studio' }] : [];
  fs.writeFileSync(
    path.join(bin, 'herdr'),
    `#!/bin/sh
echo "$*" >>"${calls}"
case "$1 $2" in
  "workspace list") echo '${JSON.stringify({ result: { workspaces } })}' ;;
  "tab list") echo '{"result":{"tabs":[{"tab_id":"t1","label":"claude"},{"tab_id":"t2","label":"studio"}]}}' ;;
  "pane list") echo '{"result":{"panes":[{"pane_id":"p1","tab_id":"t1","agent_status":"${claudeStatus}"}]}}' ;;
esac
`,
    { mode: 0o755 }
  );
  const home = path.join(root, 'home');
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, STUDIO_HOME: path.join(home, '.studio'), STUDIO_PORT: '45991', STUDIO_WHISPER_PORT: '45992', STUDIO_WORKSPACE: 'studio' };
  delete env.STUDIO_LOGGING;
  return {
    env,
    run: (command = 'down') => spawnSync(STUDIO, [command], { encoding: 'utf8', env }),
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};

test('studio down closes the studio workspace, so studio up starts everything afresh', () => {
  const t = setup();
  try {
    const result = t.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /The studio has stopped\. To start it again \(on the newest version\): studio up/);
    assert.match(t.calls(), /^workspace close w1$/m);
  } finally {
    t.cleanup();
  }
});

test('studio down waits while Claude is working or waiting for an answer, and closes nothing', () => {
  for (const [claudeStatus, words] of [['working', /still working/], ['blocked', /waiting for an answer/]]) {
    const t = setup({ claudeStatus });
    try {
      const result = t.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, words);
      assert.doesNotMatch(t.calls(), /workspace close/);
    } finally {
      t.cleanup();
    }
  }
});

test("studio down when the studio isn't running says so", () => {
  const t = setup({ running: false });
  try {
    const result = t.run();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /The studio isn't running/);
    assert.doesNotMatch(t.calls(), /workspace close/);
  } finally {
    t.cleanup();
  }
});

test('studio restart stops nothing while Claude is working, and starts nothing either', () => {
  const t = setup({ claudeStatus: 'working' });
  try {
    const result = t.run('restart');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /still working/);
    assert.doesNotMatch(t.calls(), /workspace close|workspace create|tab create/);
  } finally {
    t.cleanup();
  }
});

test('studio status: the services in the studio workspace, the app it works on, and the apps in ~/Studio', () => {
  const t = setup();
  try {
    const result = spawnSync(STUDIO, ['status'], { encoding: 'utf8', env: t.env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Studio \w+, /m);
    assert.match(result.stdout, /Services \(herdr workspace "studio"\):/);
    assert.match(result.stdout, /^ {2}claude {3}running, idle$/m);
    assert.match(result.stdout, /^ {2}studio {3}running, nothing on port 45991$/m);
    assert.match(result.stdout, /^ {2}app {6}not there \(studio up starts it\)/m);
    assert.match(result.stdout, /Apps in ~\/Studio:\n {2}none yet/);
  } finally {
    t.cleanup();
  }
  const off = setup({ running: false });
  try {
    assert.match(spawnSync(STUDIO, ['status'], { encoding: 'utf8', env: off.env }).stdout, /Services: not running\. Start them with: studio up/);
  } finally {
    off.cleanup();
  }
});

test('studio on its own, or help, shows the help page; a wrong command or wrong arguments say what to do instead', () => {
  const t = setup();
  try {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const result = spawnSync(STUDIO, args, { encoding: 'utf8', env: t.env });
      assert.equal(result.status, 0, args.join(' '));
      assert.match(result.stdout, /^Studio: build your app with Claude/);
      assert.match(result.stdout, /^ {2}studio restart {13}Start it afresh/m);
      assert.doesNotMatch(result.stdout, /\x1b\[/, 'no bold codes when not in a terminal');
    }
    const bogus = spawnSync(STUDIO, ['bogus'], { encoding: 'utf8', env: t.env });
    assert.equal(bogus.status, 2);
    assert.equal(bogus.stderr.trim(), 'studio doesn\'t know "bogus". Type studio help for what it can do.');
    // A command without what it needs, or asked for help, shows its own help; switch lists the apps to choose from.
    fs.mkdirSync(path.join(t.env.HOME, 'Studio', 'recipe-box', '.git'), { recursive: true });
    const lone = spawnSync(STUDIO, ['switch'], { encoding: 'utf8', env: t.env });
    assert.equal(lone.status, 2);
    assert.match(lone.stderr, /^studio switch <name>\n/);
    assert.match(lone.stderr, /Your apps:\n {4}recipe-box/);
    for (const args of [['help', 'clone'], ['clone', '--help'], ['clone', '-h']]) {
      const help = spawnSync(STUDIO, args, { encoding: 'utf8', env: t.env });
      assert.equal(help.status, 0, args.join(' '));
      assert.match(help.stdout, /^studio clone <source> \[<name>\] \[--yes\]\n/);
    }
  } finally {
    t.cleanup();
  }
});
