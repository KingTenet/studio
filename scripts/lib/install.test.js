'use strict';

/**
 * install.sh end to end, against a temp HOME with stand-ins for brew, gh, claude, herdr and pnpm on the PATH and
 * local bare repos standing in for GitHub, so nothing is installed and no account is touched. Run twice, it must
 * change nothing the second time.
 *
 * Run tests: node --test lib/install.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_DIR = path.resolve(__dirname, '..', '..');
const INSTALL = path.join(STUDIO_DIR, 'install.sh');

const script = (body) => `#!/bin/bash\necho "$(basename "$0") $*" >>"$LOG"\n${body}\n`;

/** Commands brew "installs" by copying them from cellar/ into bin/, which is on the PATH. */
const CELLAR = {
  herdr: script(`case "$1 $2" in
  "integration status") [ -f "$HOME/.claude/hooks/herdr-agent-state.sh" ] && echo "claude: current (v10)" || echo "claude: not installed" ;;
  "integration install") [ -d "$HOME/.claude" ] || { echo "claude directory not found" >&2; exit 1; }
    mkdir -p "$HOME/.claude/hooks"; echo '# installed by herdr' >"$HOME/.claude/hooks/herdr-agent-state.sh" ;;
esac`),
  gh: script(`case "$1 $2" in
  "auth status") [ -f "$STATE/gh-authed" ] ;;
  "auth login") touch "$STATE/gh-authed" ;;
  "auth setup-git") ;;
  "api user") echo user-gh ;;
  "api --method") [ "$3" = PUT ] && echo "$4" >>"$STATE/collaborators" ;;
  "repo view") name=\${3#user-gh/}; [ -d "$REMOTES/$name.git" ] || exit 1; [ "$4" = --json ] && echo "$REMOTES/$name" || true ;;
  "repo create") case " $* " in *" --private "*) ;; *) echo "not private" >&2; exit 1 ;; esac
    git init -q --bare -b main "$REMOTES/$3.git" ;;
  *) exit 1 ;;
esac`),
  'whisper-server': script(''),
  claude: script(`case "$1 $2" in
  "auth status") [ -f "$STATE/claude-authed" ] && echo '{"loggedIn": true}' || echo '{"loggedIn": false}' ;;
  "auth login") touch "$STATE/claude-authed"; mkdir -p "$HOME/.claude" ;;
esac`),
  // The real build is checked elsewhere; this one only records that it was asked for.
  pnpm: script(''),
};
const FORMULA_COMMANDS = { 'whisper-cpp': 'whisper-server' };

const BREW = script(`[ "$1" = install ] || exit 1
for arg in "$@"; do case "$arg" in install|--*) ;; *) formula=$arg ;; esac; done
case "$formula" in
  whisper-cpp) cmd=whisper-server ;; claude-code) cmd=claude ;; google-chrome) exit 0 ;; *) cmd=$formula ;;
esac
if [ -f "$CELLAR/$cmd" ]; then cp "$CELLAR/$cmd" "$BIN/$cmd"; else ln -sf "$(PATH=$REAL_PATH command -v "$cmd")" "$BIN/$cmd"; fi`);

/** A temp HOME with nothing installed, the stand-ins, and an empty folder of "GitHub" repos. */
const setup = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-install-')));
  const dirs = Object.fromEntries(['home', 'stubs', 'cellar', 'bin', 'state', 'remotes'].map((d) => [d, path.join(root, d)]));
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.stubs, 'brew'), BREW, { mode: 0o755 });
  for (const [name, body] of Object.entries(CELLAR)) fs.writeFileSync(path.join(dirs.cellar, name), body, { mode: 0o755 });
  // Anthropic's installer, served from a file: it puts the claude stand-in in ~/.local/bin.
  const claudeInstaller = path.join(root, 'claude-install.sh');
  fs.writeFileSync(claudeInstaller, `echo "claude-installer" >>"$LOG"; mkdir -p "$HOME/.local/bin"; cp "$CELLAR/claude" "$HOME/.local/bin/claude"\n`);
  const model = path.join(root, 'ggml-small.en.bin');
  fs.writeFileSync(model, 'a whisper model');
  const env = {
    HOME: dirs.home,
    PATH: `${dirs.bin}:${dirs.stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
    REAL_PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    LOG: path.join(root, 'log'),
    STATE: dirs.state,
    REMOTES: dirs.remotes,
    CELLAR: dirs.cellar,
    BIN: dirs.bin,
    STUDIO_WHISPER_MODEL_URL: `file://${model}`,
    STUDIO_CLAUDE_INSTALL_URL: `file://${claudeInstaller}`,
    TMPDIR: os.tmpdir(),
  };
  const install = (args = [], input = '') => spawnSync('bash', [INSTALL, ...args], { env, input, encoding: 'utf8' });
  const log = () => (fs.existsSync(env.LOG) ? fs.readFileSync(env.LOG, 'utf8') : '');
  const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...env, PATH: process.env.PATH } }).trim();
  return { root, dirs, env, install, log, git, app: path.join(dirs.home, 'Studio', 'my-app') };
};

test('install.sh sets everything up once, and a second run changes nothing', () => {
  const { dirs, env, install, log, git, app } = setup();
  const first = install(['--app', 'my-app', '--collaborator', 'helper-gh'], 'Test User\nuser@example.com\n');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /studio up/);

  // Tools, the model and the logins.
  for (const f of ['herdr', 'node', 'pnpm', 'gh', 'whisper-cpp', 'ffmpeg']) assert.match(log(), new RegExp(`^brew install --quiet ${f}$`, 'm'));
  assert.match(log(), /^claude-installer$/m);
  assert.doesNotMatch(log(), /claude-code/);
  assert.ok(fs.existsSync(path.join(dirs.home, '.local', 'bin', 'claude')));
  assert.equal(fs.readFileSync(path.join(dirs.home, '.whisper', 'ggml-small.en.bin'), 'utf8'), 'a whisper model');
  assert.match(log(), /^gh auth login /m);
  assert.match(log(), /^gh auth setup-git$/m);
  assert.match(log(), /^claude auth login --claudeai$/m);
  assert.ok(fs.existsSync(path.join(dirs.home, '.claude', 'hooks', 'herdr-agent-state.sh')));
  const gitconfig = fs.readFileSync(path.join(dirs.home, '.gitconfig'), 'utf8');
  assert.match(gitconfig, /name = Test User/);
  assert.match(gitconfig, /email = user@example.com/);

  // The app: the template's two versions with their annotated tags, develop = main, and origin its GitHub repo.
  assert.deepEqual(git(app, 'log', '--format=%s', 'main').split('\n'), ['Add an example todo list', 'Getting Started']);
  assert.equal(git(app, 'cat-file', '-t', 'v1'), 'tag');
  assert.equal(git(app, 'tag', '-l', '--format=%(contents:subject)', 'v2'), 'v2 Add an example todo list');
  assert.equal(git(app, 'rev-parse', 'develop'), git(app, 'rev-parse', 'main'));
  assert.equal(git(app, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  const remote = path.join(dirs.remotes, 'my-app.git');
  assert.equal(git(app, 'remote', 'get-url', 'origin'), remote);
  assert.deepEqual(git(remote, 'for-each-ref', '--format=%(refname)').split('\n').sort(), ['refs/heads/develop', 'refs/heads/main', 'refs/tags/v1', 'refs/tags/v2']);
  assert.equal(git(remote, 'cat-file', '-t', 'v2'), 'tag');
  assert.equal(fs.readFileSync(path.join(dirs.state, 'collaborators'), 'utf8'), 'repos/user-gh/my-app/collaborators/helper-gh\n');

  // The studio: config.json, `studio` on the PATH and the cockpit built.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.home, '.studio', 'config.json'), 'utf8')), { appDir: app, name: 'my-app', appPort: 4001 });
  assert.equal(fs.realpathSync(path.join(dirs.home, '.local', 'bin', 'studio')), path.join(STUDIO_DIR, 'bin', 'studio'));
  assert.match(fs.readFileSync(path.join(dirs.home, '.zprofile'), 'utf8'), /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  // Homebrew was there already, and new Terminal windows still find what it installs.
  assert.match(fs.readFileSync(path.join(dirs.home, '.zprofile'), 'utf8'), /^eval "\$\(.*\/brew shellenv\)"$/m);
  assert.match(log(), /^pnpm --dir .*\/web install --frozen-lockfile --silent$/m);
  assert.match(log(), /^pnpm --dir .*\/web --silent build$/m);
  const upEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('STUDIO_')));
  const up = execFileSync(path.join(dirs.home, '.local', 'bin', 'studio'), ['up', '--dry-run'], { encoding: 'utf8', env: { ...upEnv, HOME: dirs.home } });
  assert.match(up, new RegExp(`app \\(in ${app}\\)`));
  assert.match(up, new RegExp(`whisper-server -m '${dirs.home}/\\.whisper/ggml-small\\.en\\.bin'`));

  // An app to double-click, which runs `studio run my-app` with the studio and Homebrew on its PATH.
  const launcher = path.join(dirs.home, 'Applications', 'my-app.app');
  const script = execFileSync('osadecompile', [launcher], { encoding: 'utf8' });
  assert.match(script, new RegExp(`do shell script "export PATH=${dirs.home}/\\.local/bin:/opt/homebrew/bin:/usr/local/bin:\\$PATH; studio run my-app"`));
  assert.match(script, /display dialog message/);

  // The user's own changes since, which a second run must leave alone.
  fs.writeFileSync(path.join(dirs.home, '.studio', 'config.json'), JSON.stringify({ appDir: app, name: 'My App', appPort: 4001 }));
  fs.writeFileSync(path.join(app, 'notes.txt'), 'work in progress');
  const zprofile = fs.readFileSync(path.join(dirs.home, '.zprofile'), 'utf8');
  fs.writeFileSync(env.LOG, '');

  const second = install(['--app', 'my-app', '--collaborator', 'helper-gh']); // no input: it must not ask anything
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.doesNotMatch(log(), /^brew /m);
  assert.doesNotMatch(log(), /^claude-installer$/m);
  assert.doesNotMatch(log(), /auth login|repo create/);
  assert.doesNotMatch(log(), /^herdr integration install/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.home, '.studio', 'config.json'), 'utf8')).name, 'My App');
  assert.equal(fs.readFileSync(path.join(app, 'notes.txt'), 'utf8'), 'work in progress');
  assert.equal(fs.readFileSync(path.join(dirs.home, '.zprofile'), 'utf8'), zprofile);
  assert.match(second.stdout, /already there \(left as it is\)/);
});

test('on a new Mac, the app is copied from its GitHub repo rather than made again from the template', () => {
  const { install, git, app } = setup();
  assert.equal(install(['--app', 'my-app'], 'Test User\nuser@example.com\n').status, 0);
  git(app, 'checkout', '-q', 'develop');
  fs.writeFileSync(path.join(app, 'page.txt'), 'a checkpoint');
  git(app, 'add', '-A');
  execFileSync('git', ['-C', app, 'commit', '-q', '-m', 'A checkpoint'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'u@e', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'u@e' } });
  git(app, 'push', '-q', 'origin', 'develop');
  const develop = git(app, 'rev-parse', 'develop');
  fs.rmSync(app, { recursive: true });

  const again = install(['--app', 'my-app']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /already on GitHub, so it's copied from there/);
  assert.equal(git(app, 'rev-parse', 'develop'), develop);
  assert.equal(git(app, 'cat-file', '-t', 'v1'), 'tag');
});

test('without --app it sets up the Mac but makes no app, and `studio new` makes one afterwards', () => {
  const { dirs, env, install, log, git, app } = setup();
  const run = install([], 'Test User\nuser@example.com\n');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /studio new my-app/);
  assert.ok(!fs.existsSync(path.join(dirs.home, 'Studio')));
  assert.ok(!fs.existsSync(path.join(dirs.home, '.studio', 'config.json')));
  assert.ok(!fs.existsSync(path.join(dirs.home, 'Applications')));
  assert.doesNotMatch(log(), /repo create/);

  const studio = path.join(dirs.home, '.local', 'bin', 'studio');
  const made = spawnSync(studio, ['new', 'my-app', '--collaborator', 'helper-gh'], { env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /studio up/);
  assert.equal(git(app, 'tag', '-l', '--format=%(contents:subject)', 'v2'), 'v2 Add an example todo list');
  assert.equal(git(app, 'rev-parse', 'develop'), git(app, 'rev-parse', 'main'));
  const remote = path.join(dirs.remotes, 'my-app.git');
  assert.deepEqual(git(remote, 'for-each-ref', '--format=%(refname)').split('\n').sort(), ['refs/heads/develop', 'refs/heads/main', 'refs/tags/v1', 'refs/tags/v2']);
  assert.equal(fs.readFileSync(path.join(dirs.state, 'collaborators'), 'utf8'), 'repos/user-gh/my-app/collaborators/helper-gh\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.home, '.studio', 'config.json'), 'utf8')), { appDir: app, name: 'my-app', appPort: 4001 });
  assert.ok(fs.existsSync(path.join(dirs.home, 'Applications', 'my-app.app')));

  // Run again, it skips what's done and leaves the config alone.
  const again = spawnSync(studio, ['new', 'my-app'], { env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /already works on my-app/);
});

test('`studio new` before the installer has run says to run it', () => {
  const { env } = setup();
  const run = spawnSync(path.join(STUDIO_DIR, 'bin', 'studio'), ['new', 'my-app'], { env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^Studio can't find gh, GitHub's command\. Run \.\/install\.sh/m);
});

test('--collaborator without --app is refused', () => {
  const { install } = setup();
  const run = install(['--collaborator', 'helper-gh']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /needs --app/);
});

test('a failed step stops with a plain message naming it', () => {
  const { install, env } = setup();
  fs.writeFileSync(path.join(env.CELLAR, 'gh'), script('exit 1'), { mode: 0o755 }); // GitHub's login fails
  const run = install([], 'Test User\nuser@example.com\n');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Setup stopped while: Logging into GitHub \(your account\)\./);
  assert.match(run.stderr, /run \.\/install\.sh again/);
});

test('an app name that would make a bad folder or repo name is refused', () => {
  const { install } = setup();
  const run = install(['--app', 'My App']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /lowercase letters, numbers and dashes/);
});

test("on a Mac whose Homebrew belongs to another account, it says so instead of failing inside brew", () => {
  const { install, env, root } = setup();
  const prefix = path.join(root, 'homebrew');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.chmodSync(path.join(prefix, 'bin'), 0o555);
  const brew = fs.readFileSync(path.join(env.BIN, '..', 'stubs', 'brew'), 'utf8');
  fs.writeFileSync(path.join(env.BIN, '..', 'stubs', 'brew'), brew.replace('[ "$1" = install ] || exit 1', `[ "$1" = --prefix ] && { echo "${prefix}"; exit 0; }\n[ "$1" = install ] || exit 1`), { mode: 0o755 });
  const run = install([], 'Test User\nuser@example.com\n');
  fs.chmodSync(path.join(prefix, 'bin'), 0o755);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Homebrew on this Mac belongs to another account \(.+\), so this one can't add herdr\. Ask that account to run: brew install herdr/);
  assert.match(run.stderr, /Setup stopped while: The tools the studio uses\./);
});

test("a Claude Code download that drops over HTTP/2 is tried again over HTTP/1.1, the installer's own downloads included", () => {
  const { install, env, log } = setup();
  // curl that fails like the dropped download (exit 92) unless its .curlrc (CURL_HOME) asks for HTTP/1.1.
  fs.writeFileSync(path.join(env.BIN, '..', 'stubs', 'curl'), `#!/bin/bash
case "$*" in *claude-install.sh*) grep -qs '^http1.1$' "$CURL_HOME/.curlrc" || { echo "curl: (92) HTTP/2 stream 1 was not closed cleanly" >&2; exit 92; } ;; esac
exec /usr/bin/curl "$@"
`, { mode: 0o755 });
  const run = install([], 'Test User\nuser@example.com\n');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /trying again over HTTP\/1\.1/);
  assert.equal(log().match(/^claude-installer$/gm)?.length, 1);
});
