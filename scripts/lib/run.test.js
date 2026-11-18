'use strict';

/**
 * `studio run`: the newest kept version, from its own copy and on its own data, moving only forward. Against a temp HOME
 * with a small app whose server says which version it is and logs each start to its database, and stand-ins for npm
 * (ci makes node_modules/.bin/tsx, which runs node) so nothing is downloaded.
 *
 * Run tests: node --test lib/run.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const STUDIO = path.resolve(__dirname, '..', '..', 'bin', 'studio');
const IDENTITY = { GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'user@example.com', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'user@example.com' };

const NPM = `#!/bin/sh
echo "npm $*" >>"$NPM_LOG"
case "$1" in
  ci) mkdir -p node_modules/.bin && printf '#!/bin/sh\\nexec node "$@"\\n' >node_modules/.bin/tsx && chmod +x node_modules/.bin/tsx ;;
  run) echo built >dist.txt ;;
esac
`;

const server = (version) => `import fs from 'node:fs'
import http from 'node:http'
const db = process.env.DATA_DIR + '/app.db'
fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
fs.appendFileSync(db, 'started ${version}\\n')
http.createServer((_req, res) => res.end('${version}|' + fs.readFileSync(db, 'utf8'))).listen(Number(process.env.PORT))
`;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const setup = async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-run-')));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const app = path.join(home, 'Studio', 'my-app');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(app, 'server'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), NPM, { mode: 0o755 });
  const git = (...args) => execFileSync('git', ['-C', app, ...args], { encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, '.gitignore'), 'node_modules/\ndata/\ndist.txt\n');
  fs.writeFileSync(path.join(app, 'package.json'), '{ "type": "module" }\n');
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{ "lock": 1 }\n');
  /** A version: the server says `version`, committed on main and tagged. */
  const version = (tag, { lock } = {}) => {
    fs.writeFileSync(path.join(app, 'server', 'index.ts'), server(tag));
    if (lock) fs.writeFileSync(path.join(app, 'package-lock.json'), lock);
    git('add', '-A');
    git('commit', '-q', '-m', tag);
    git('tag', '-a', tag, '-m', tag);
  };
  const port = await freePort();
  const live = path.join(home, 'Studio', '.live', 'my-app');
  const npmLog = path.join(root, 'npm.log');
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NPM_LOG: npmLog, STUDIO_HOME: path.join(home, '.studio'), STUDIO_LIVE_PORT: String(port), STUDIO_NO_OPEN: '1' };
  // spawnSync returns only once every holder of its pipes is gone, so this also shows the app doesn't hold them.
  const run = (...args) => spawnSync(STUDIO, ['run', ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const fetchApp = async () => (await fetch(`http://localhost:${port}/`)).text();
  const pid = () => fs.readFileSync(path.join(live, 'app.pid'), 'utf8').trim();
  const npmCalls = () => (fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').trim().split('\n') : []);
  t.after(() => {
    try {
      process.kill(Number(pid()));
    } catch {
      // never started
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, live, port, env, git, version, run, fetchApp, pid, npmCalls };
};

test('studio run: the newest version from its own copy and data, upgraded forward with a backup, the app itself untouched', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.app, 'server', 'index.ts'), server('unkept'));
  s.git('add', '-A');
  s.git('commit', '-q', '-m', 'Getting started');
  let result = s.run('my-app');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no versions yet/);

  s.version('v1');
  s.version('v2');
  // The app is mid-feature: its files are ahead of every version, and the run must not care.
  fs.writeFileSync(path.join(s.app, 'server', 'index.ts'), server('half-built'));

  result = s.run('my-app');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /my-app v2 is running/);
  assert.equal(await s.fetchApp(), 'v2|started v2\n');
  assert.equal(s.git('-C', path.join(s.live, 'code'), 'describe', '--tags', '--exact-match'), 'v2');
  assert.deepEqual(s.npmCalls(), ['npm ci --no-audit --no-fund --loglevel=error', 'npm run --silent build']);
  assert.equal(fs.readFileSync(path.join(s.live, 'data', 'app.db'), 'utf8'), 'started v2\n', 'its own data folder');
  assert.ok(!fs.existsSync(path.join(s.app, 'data')), "the workshop's data is not used");

  // Again: it's running, so it is left alone.
  const first = s.pid();
  result = s.run('my-app');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.pid(), first);
  assert.equal(s.npmCalls().length, 2);

  // A newer version kept since: stopped, backed up, moved forward, started; packages unchanged, so no install.
  s.git('checkout', '-q', '--', '.');
  s.version('v3');
  result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /moved from v2 to v3/);
  assert.notEqual(s.pid(), first);
  assert.equal(await s.fetchApp(), 'v3|started v2\nstarted v3\n', 'the same data, carried forward');
  const backups = fs.readdirSync(path.join(s.live, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^app-v2-\d{8}-\d{6}\.db$/);
  assert.equal(fs.readFileSync(path.join(s.live, 'backups', backups[0]), 'utf8'), 'started v2\n');
  assert.deepEqual(s.npmCalls().slice(2), ['npm run --silent build']);

  // New packages: installed again.
  s.version('v4', { lock: '{ "lock": 2 }\n' });
  result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(s.npmCalls().slice(3).includes('npm ci --no-audit --no-fund --loglevel=error'));
  assert.match(await s.fetchApp(), /^v4\|/);

  // The workshop's checkout is untouched: still main, nothing changed.
  assert.equal(s.git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(s.git('status', '--porcelain'), '');
});

test('studio run --if-running moves only a running app forward; studio stop stops it', async (t) => {
  const s = await setup(t);
  s.version('v1');
  // Not running: nothing is started.
  let result = s.run('my-app', '--if-running');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /isn't running for real, so there's nothing to update/);
  assert.deepEqual(s.npmCalls(), []);

  result = s.run('my-app');
  assert.equal(result.status, 0, result.stderr);
  assert.match(await s.fetchApp(), /^v1\|/);

  // A version kept while it runs: --if-running moves it there, data backed up.
  s.version('v2');
  result = s.run('my-app', '--if-running');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /moved from v1 to v2/);
  assert.match(await s.fetchApp(), /^v2\|started v1\nstarted v2\n$/);

  // studio stop: stopped, and its port free.
  const pid = Number(s.pid());
  result = spawnSync(STUDIO, ['stop', 'my-app'], { encoding: 'utf8', env: s.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /my-app has stopped/);
  assert.throws(() => process.kill(pid, 0), 'the server is gone');
  await assert.rejects(s.fetchApp());
  assert.match(spawnSync(STUDIO, ['stop', 'my-app'], { encoding: 'utf8', env: s.env }).stdout, /isn't running/);
});

test('studio run says when something else holds its port, and starts nothing', async (t) => {
  const s = await setup(t);
  s.version('v1');
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(s.port, resolve));
  t.after(() => blocker.close());
  const result = s.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`Something else \\(not one of your apps\\) is using port ${s.port}, so my-app can't start`));
  assert.ok(!fs.existsSync(path.join(s.live, 'app.pid')));
  // The port's holder is another app running for real (this process, recorded as its server): it's named, with the way to swap.
  const other = path.join(path.dirname(s.live), 'other-app');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'app.pid'), String(process.pid));
  const named = s.run();
  assert.equal(named.status, 1);
  assert.match(named.stderr, new RegExp(`other-app is running for real on port ${s.port}, and only one app can at a time\\.\\nTo open my-app instead: studio stop other-app, then studio run my-app`));
});

test('a step that fails says which, instead of studio stopping without a word', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fails-')));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // Logged in, but asking who it is fails and says nothing.
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth status" ] && exit 0\nexit 1\n', { mode: 0o755 });
    const result = spawnSync(STUDIO, ['new', 'test-app'], { encoding: 'utf8', env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin`, STUDIO_HOME: path.join(root, '.studio') } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /studio stopped: this failed \(line \d+ of .*studio\): owner=\$\(gh api user --jq \.login\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("studio finds Homebrew's tools itself, in a Terminal window opened before the installer put Homebrew on the PATH", { skip: !['/opt/homebrew', '/usr/local'].some((dir) => fs.existsSync(`${dir}/bin/brew`) && fs.existsSync(`${dir}/bin/gh`)) && 'no Homebrew gh on this Mac' }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-brewpath-')));
  try {
    // Only the system's own folders, and a home with no GitHub login, so gh can't do anything.
    const result = spawnSync(STUDIO, ['new', 'test-app'], { encoding: 'utf8', env: { HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', STUDIO_HOME: path.join(root, '.studio') } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub isn't logged in/, 'gh was found, and says it has no login');
    assert.doesNotMatch(result.stderr, /can't find gh/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
