'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { claudeCommand, commandText, notePaneSession, pausedSessions, processTree, runningCommands, reapAction, resumeCommand, trackIdle, typedInput, withRealSessions } = require('./claude-reaper');

const MIN = 60_000;
const THRESHOLD = 10 * MIN;
const agent = (pane, status, session = `s-${pane}`, extra = {}) => ({ agent: 'claude', pane_id: pane, agent_status: status, agent_session: { value: session }, focused: false, ...extra });
const QUIET = { hasShell: true, runningCommand: false, input: '' };
const decide = (overrides = {}) => reapAction({ agent: agent('w1:p1', 'idle'), idleSince: 0, now: 11 * MIN, thresholdMs: THRESHOLD, facts: QUIET, ...overrides });

const RULE = '─'.repeat(40);
const screen = (...box) => ['✻ Baked for 37s', '', RULE, ...box, RULE, '  ⏵⏵ auto mode on'].join('\n');

test('trackIdle: an idle pane keeps the time it first went idle across samples', () => {
  const first = trackIdle({}, [agent('w1:p1', 'idle')], 1000);
  const second = trackIdle(first, [agent('w1:p1', 'idle')], 61_000);

  assert.deepEqual(second, { 'w1:p1': { since: 1000, sessionId: 's-w1:p1' } });
});

test('trackIdle: a pane that goes back to working starts its idle clock again next time', () => {
  const idle = trackIdle({}, [agent('w1:p1', 'idle')], 1000);
  const working = trackIdle(idle, [agent('w1:p1', 'working')], 61_000);
  const idleAgain = trackIdle(working, [agent('w1:p1', 'idle')], 121_000);

  assert.deepEqual(working, {});
  assert.equal(idleAgain['w1:p1'].since, 121_000);
});

test('trackIdle: a new session in the same pane starts a new idle clock', () => {
  const before = trackIdle({}, [agent('w1:p1', 'idle', 'old')], 1000);

  assert.equal(trackIdle(before, [agent('w1:p1', 'idle', 'new')], 61_000)['w1:p1'].since, 61_000);
});

test('trackIdle: only idle counts; done (not looked at yet), blocked, working, other agents and vanished panes do not', () => {
  const tracked = trackIdle(
    { 'w9:p9': { since: 1, sessionId: 'gone' } },
    [agent('w1:p1', 'idle'), agent('w1:p5', 'done'), agent('w1:p2', 'blocked'), agent('w1:p3', 'working'), { ...agent('w1:p4', 'idle'), agent: 'codex' }],
    1000
  );

  assert.deepEqual(Object.keys(tracked), ['w1:p1']);
});

test('reapAction: a quiet pane idle past the threshold is stopped', () => {
  assert.equal(decide().action, 'stop');
});

test('reapAction: under the threshold it waits', () => {
  assert.equal(decide({ now: 9 * MIN }).action, 'wait');
  assert.equal(decide({ idleSince: undefined }).action, 'wait');
});

test('reapAction: the focused pane is never stopped', () => {
  assert.deepEqual(decide({ agent: agent('w1:p1', 'idle', 's', { focused: true }) }), { action: 'skip', reason: 'focused' });
});

test('reapAction: a session running a command (a watcher poller, a test run) is left alone', () => {
  assert.deepEqual(decide({ facts: { ...QUIET, runningCommand: true } }), { action: 'skip', reason: 'running a command' });
});

test('reapAction: typed but unsent text, or no visible input box, keeps a pane alive', () => {
  assert.equal(decide({ facts: { ...QUIET, input: 'half a thought' } }).action, 'skip');
  assert.equal(decide({ facts: { ...QUIET, input: null } }).action, 'skip');
});

test('reapAction: with no shell under Claude the pane is closed rather than stopped', () => {
  assert.equal(decide({ facts: { ...QUIET, hasShell: false } }).action, 'close');
});

test('typedInput: an empty prompt reads as empty', () => {
  assert.equal(typedInput(screen('❯ ')), '');
  assert.equal(typedInput(screen('❯')), '');
});

test('typedInput: typed text, over several lines, is returned without the prompt', () => {
  assert.equal(typedInput(screen('❯ first line', '  second line')), 'first line\n  second line');
});

test("typedInput: Claude's dim suggested prompt is not typed text, and styling around real text is dropped", () => {
  assert.equal(typedInput(screen('❯ \x1b[0m\x1b[2mrebase onto the release branch and push\x1b[0m')), '');
  assert.equal(typedInput(screen('❯ \x1b[1mmy real draft\x1b[0m\r')), 'my real draft');
});

test('typedInput: only the last box on screen counts, and no box reads as null', () => {
  assert.equal(typedInput([RULE, '❯ old', RULE, 'output', RULE, '❯ ', RULE].join('\n')), '');
  assert.equal(typedInput('just some shell output\n$ '), null);
});

test('resumeCommand: keeps the permission mode, and changes directory only when the shell is elsewhere', () => {
  const argv = ['claude', '--permission-mode', 'auto', 'Do the thing'];

  assert.equal(resumeCommand({ argv, sessionId: 'abc', cwd: '/code/repo', shellCwd: '/code/repo' }), 'claude --permission-mode auto --resume abc');
  assert.equal(resumeCommand({ argv: ['claude'], sessionId: 'abc', cwd: "/code/it's", shellCwd: '/tmp' }), "cd '/code/it'\\''s' && claude --resume abc");
});

test('resumeCommand: keeps the studio settings file, so the hooks and allowlist come back with the session', () => {
  const argv = ['claude', '--permission-mode', 'auto', '--settings', '/Studio/studio/claude/settings.json'];

  assert.equal(resumeCommand({ argv, sessionId: 'abc', cwd: '/r', shellCwd: '/r' }), "claude --permission-mode auto --settings '/Studio/studio/claude/settings.json' --resume abc");
});

test('resumeCommand: keeps the plugin folder, so the studio skills come back with the session', () => {
  const argv = ['claude', '--permission-mode', 'auto', '--settings', '/S/claude/settings.json', '--plugin-dir', '/S'];
  assert.equal(resumeCommand({ argv, sessionId: 'abc', cwd: '/r', shellCwd: '/r' }), "claude --permission-mode auto --settings '/S/claude/settings.json' --plugin-dir '/S' --resume abc");
});

test('claudeCommand: auto mode with the settings file in this harness, and the harness as a plugin for its skills', () => {
  assert.equal(claudeCommand(), `claude --permission-mode auto --settings '${path.resolve(__dirname, '..', '..', 'claude', 'settings.json')}' --plugin-dir '${path.resolve(__dirname, '..', '..')}'`);
});

test('resumeCommand: a session with nothing saved starts afresh in the same mode', () => {
  assert.equal(resumeCommand({ argv: ['claude', '--permission-mode', 'auto'], sessionId: 'abc', cwd: '/r', shellCwd: '/r', saved: false }), 'claude --permission-mode auto');
});

test('processTree: descendants at any depth, and their commands', () => {
  const tree = processTree(['  10     1 claude --permission-mode auto', '  11    10 /bin/zsh -c source /home/x/.claude/shell-snapshots/s.sh', '  12    11 node poller.js', '  20     1 other'].join('\n'));

  assert.deepEqual(tree.descendants(10), [11, 12]);
  assert.match(tree.command(11), /shell-snapshots/);
  assert.deepEqual(tree.descendants(20), []);
});

test('pausedSessions: the worktree\'s stopped sessions, newest first, once each, including subdirectories', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const at = (hour) => `2026-01-02T${String(hour).padStart(2, '0')}:00:00Z`;
  const records = [
    { cwd: '/code/app', session_id: 'a', ts: at(8), resume: 'claude --resume a' },
    { cwd: '/code/app/api', session_id: 'b', ts: at(9), resume: 'claude --resume b' },
    { cwd: '/code/app-two', session_id: 'c', ts: at(10), resume: 'claude --resume c' },
    { cwd: '/code/app', session_id: 'a', ts: at(11), resume: 'claude --resume a' },
  ];

  assert.deepEqual(pausedSessions(records, '/code/app', new Set(), now).map((r) => [r.session_id, r.ts]), [['a', at(11)], ['b', at(9)]]);
  assert.deepEqual(pausedSessions(records, '/code/app-two', new Set(), now).map((r) => r.session_id), ['c']);
});

test('pausedSessions: not once running again, not older than a day, at most three', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const record = (id, ts) => ({ cwd: '/r', session_id: id, ts, resume: `claude --resume ${id}` });
  const records = [record('old', '2026-01-01T11:00:00Z'), record('a', '2026-01-02T08:00:00Z'), record('b', '2026-01-02T09:00:00Z'), record('c', '2026-01-02T10:00:00Z'), record('d', '2026-01-02T11:00:00Z')];

  assert.deepEqual(pausedSessions(records, '/r', new Set(['d']), now).map((r) => r.session_id), ['c', 'b', 'a']);
  assert.deepEqual(pausedSessions(records, '/r', new Set(), now).map((r) => r.session_id), ['d', 'c', 'b']);
  assert.deepEqual(pausedSessions([], '/r', new Set(), now), []);
});

test('pausedSessions: not a session dismissed since it was last stopped; stopped again later, it is back', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const stop = (id, ts) => ({ cwd: '/r', session_id: id, ts, how: 'stopped', resume: `claude --resume ${id}` });
  const dismiss = (id, ts) => ({ cwd: '/r', session_id: id, ts, how: 'dismissed' });
  const records = [stop('a', '2026-01-02T08:00:00Z'), stop('b', '2026-01-02T08:30:00Z'), dismiss('a', '2026-01-02T09:00:00Z'), dismiss('b', '2026-01-02T09:00:00Z'), stop('b', '2026-01-02T10:00:00Z')];

  assert.deepEqual(pausedSessions(records, '/r', new Set(), now).map((r) => [r.session_id, r.ts]), [['b', '2026-01-02T10:00:00Z']]);
});

test('pausedSessions: not a session stopped before anything was said in it, which has nothing to resume', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const records = [
    { cwd: '/r', session_id: 'said', ts: '2026-01-02T10:00:00Z', resume: 'claude --permission-mode auto --resume said' },
    { cwd: '/r', session_id: 'empty', ts: '2026-01-02T11:00:00Z', resume: 'claude --permission-mode auto' },
  ];

  assert.deepEqual(pausedSessions(records, '/r', new Set(), now).map((r) => r.session_id), ['said']);
});

test("commandText: the command inside Claude Code's command shell, quotes restored", () => {
  const shell = (command) => `/bin/zsh -c source /home/x/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| /tmp/claude-cwd`;

  assert.equal(commandText(shell('sleep 45')), 'sleep 45');
  assert.equal(commandText(shell("studio-mr-wait-comment.sh 4066 --since 1")), 'studio-mr-wait-comment.sh 4066 --since 1');
  assert.equal(commandText(shell("echo '\\''hi'\\''")), "echo 'hi'");
  assert.equal(commandText(shell(`curl -H '"'"'X-Studio: 1'"'"' http://localhost`)), "curl -H 'X-Studio: 1' http://localhost");
  assert.equal(commandText('node something.js'), 'node something.js');
  assert.equal(commandText(shell('cd x\\012npm test')), 'cd x\nnpm test');
});

test('runningCommands: only the command shells under that pid, at any depth', () => {
  const tree = processTree(
    [
      '  10     1 claude',
      "  11    10 /bin/zsh -c source /h/.claude/shell-snapshots/a.sh && eval 'npx vitest run' < /dev/null",
      '  12    11 node vitest',
      '  13    10 node typescript-language-server --stdio',
      "  20     1 /bin/zsh -c source /h/.claude/shell-snapshots/b.sh && eval 'other' < /dev/null",
    ].join('\n')
  );

  assert.deepEqual(runningCommands(10, tree), ['npx vitest run']);
  assert.deepEqual(runningCommands(13, tree), []);
});

test("withRealSessions: a pane's recorded session wins over herdr's; one noted as starting has none until its SessionStart records it", () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-panes-'));
  const pane = (id) => ({ pane_id: id, agent: 'claude', agent_session: { value: 'old' } });
  fs.writeFileSync(path.join(dir, 'w1_p1.json'), JSON.stringify({ pane_id: 'w1:p1', session_id: 'branched' }));
  notePaneSession('w1:p2', null, dir);
  notePaneSession('w1:p3', 'resumed', dir);
  const [recorded, starting, resumed, unknown] = withRealSessions([pane('w1:p1'), pane('w1:p2'), pane('w1:p3'), pane('w1:p4')], dir);
  assert.equal(recorded.agent_session.value, 'branched');
  assert.equal(starting.agent_session, null);
  assert.equal(resumed.agent_session.value, 'resumed');
  assert.equal(unknown.agent_session.value, 'old');
  // A pane with no Claude in it is left as herdr has it.
  assert.deepEqual(withRealSessions([{ pane_id: 'w1:p2', agent: null }], dir), [{ pane_id: 'w1:p2', agent: null }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
