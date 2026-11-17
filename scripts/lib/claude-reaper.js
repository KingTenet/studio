'use strict';

/**
 * Stops Claude Code sessions that have sat idle in herdr, so they stop holding memory (a session plus
 * its LSP's tsserver is often 1–2 GB), while keeping them one keypress from coming back.
 *
 * Usage: claude-reaper.sh keep <workspace> <app>   # keeps the chat's Claude running: `studio up` runs this in its reaper tab
 *        claude-reaper.sh watch [--dry-run]   # every 60s, stopping idle sessions (not run by `studio up`: one chat has nothing to free)
 *        claude-reaper.sh once [--dry-run] [--only <pane>]   # one pass, ignoring idle time
 *        claude-reaper.sh list [n]            # the last n stopped/closed sessions
 *        claude-reaper.sh resume <worktree> [session] [--watch | --message <text>]   # bring back a stopped session (the index's ⏸ chips); --watch restarts /watch-mr in it, --message sends it text
 *        claude-reaper.sh stop <pane> [--dismiss]       # stop that pane's session now; --dismiss also drops it from the ⏸ chips and closes its pane (× on a session chip)
 *        claude-reaper.sh dismiss <session>             # stop offering a stopped session (× on a ⏸ chip); its transcript stays
 *
 * A pane is stopped once all of these hold:
 *   - it has been idle for STUDIO_REAPER_IDLE_MIN minutes (default 10), counted from when you looked at
 *     it: herdr's 'done' (finished, not looked at since) isn't idle, so a result you haven't read stays live;
 *   - it isn't the focused pane;
 *   - Claude isn't running a command (a /watch-mr poller, a long test run);
 *   - nothing is typed in its input box.
 * Stopping is Ctrl-C twice, leaving the shell prompt with `claude --resume <id>` typed but not
 * run. A pane with no shell under Claude would close with it, so it is closed outright instead.
 * Either way the session is appended to ~/.studio/reaper/closed.jsonl, which the cockpit's Resume button
 * reads.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IDLE_STATUSES = ['idle'];
const SAMPLE_MS = 60_000;
const idleThresholdMs = () => Number(process.env.STUDIO_REAPER_IDLE_MIN ?? 10) * 60_000;
const reaperDir = () => process.env.STUDIO_REAPER_DIR ?? path.join(process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio'), 'reaper');
const closedLogPath = () => path.join(reaperDir(), 'closed.jsonl');

/** Claude Code runs every Bash command through one of these, so one under a session means a command is running. */
const COMMAND_SHELL_MARKER = '/.claude/shell-snapshots/';

/** The command a Claude Code command shell is running: the `eval '…'` part of its command line. */
const commandText = (cmdline) => {
  const match = /eval '((?:[^']|'"'"'|'\\'')*)'/.exec(cmdline);
  return (match ? match[1].replace(/'"'"'|'\\''/g, "'") : cmdline).replace(/\\012/g, '\n');
};

/** What Claude is running under this pid right now (a /watch-mr poller, a test run), one entry per command shell. */
const runningCommands = (pid, tree) =>
  tree
    .descendants(pid)
    .filter((child) => tree.command(child).includes(COMMAND_SHELL_MARKER))
    .map((child) => commandText(tree.command(child)));

/** When each idle Claude pane went idle: kept across samples, restarted when its session changes, dropped once it isn't idle. */
const trackIdle = (previous, agents, now) =>
  Object.fromEntries(
    agents
      .filter((agent) => agent.agent === 'claude' && IDLE_STATUSES.includes(agent.agent_status))
      .map((agent) => {
        const sessionId = agent.agent_session?.value ?? null;
        const before = previous[agent.pane_id];
        return [agent.pane_id, { since: before && before.sessionId === sessionId ? before.since : now, sessionId }];
      })
  );

/**
 * What is typed in Claude's input box, from the pane's visible text with ANSI codes: the lines between
 * the last two horizontal rules, without the leading prompt. null when no input box is on screen.
 * Claude Code shows a suggested next prompt as dim text in an empty box, so dim text doesn't count.
 */
const typedInput = (ansiText) => {
  const plain = ansiText.replace(/\x1b\[2m[^\x1b]*(?:\x1b\[(?:0|22)?m)?/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = plain.split('\n').map((line) => line.replace(/\r$/, ''));
  const rules = lines.flatMap((line, index) => (/^─{10,}/.test(line.trim()) ? [index] : []));
  if (rules.length < 2) {
    return null;
  }
  const [open, close] = rules.slice(-2);
  const box = lines.slice(open + 1, close);
  if (box.some((line) => /^─+$/.test(line.trim()))) {
    return null;
  }
  return box
    .join('\n')
    .replace(/^\s*❯\s?/, '')
    .trim();
};

/** 'wait' (not idle long enough yet), 'skip' (idle, but leave it), 'stop' or 'close', with why. */
const reapAction = ({ agent, idleSince, now, thresholdMs, facts }) => {
  if (idleSince === undefined || now - idleSince < thresholdMs) {
    return { action: 'wait', reason: 'not idle long enough' };
  }
  if (agent.focused) {
    return { action: 'skip', reason: 'focused' };
  }
  if (facts.runningCommand) {
    return { action: 'skip', reason: 'running a command' };
  }
  if (facts.input === null) {
    return { action: 'skip', reason: "can't see its input box" };
  }
  if (facts.input !== '') {
    return { action: 'skip', reason: "input box isn't empty" };
  }
  return facts.hasShell ? { action: 'stop', reason: `idle ${Math.round((now - idleSince) / 60_000)} min` } : { action: 'close', reason: 'no shell under Claude' };
};

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** The folder this harness lives in, which Claude's hooks find their scripts through ($STUDIO_DIR). */
const STUDIO_DIR = path.resolve(__dirname, '..', '..');

/** How Claude starts in the studio: in auto mode, with the studio's settings (hooks and the allowlist) and its skills (this harness as a plugin). Kept in step with bin/studio. */
const claudeCommand = () => `claude --permission-mode auto --settings ${shellQuote(path.join(STUDIO_DIR, 'claude', 'settings.json'))} --plugin-dir ${shellQuote(STUDIO_DIR)}`;

/**
 * The command to bring a session back, keeping its permission mode, settings file and plugin folder (Claude doesn't restore them), from its directory. A session
 * that never got a message has nothing saved to resume, so it gets a fresh `claude` instead.
 */
const resumeCommand = ({ argv, sessionId, cwd, shellCwd, saved = true }) => {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? ` ${name} ${name === '--permission-mode' ? argv[at + 1] : shellQuote(argv[at + 1])}` : '';
  };
  const flags = flag('--permission-mode') + flag('--settings') + flag('--plugin-dir');
  const command = saved ? `claude${flags} --resume ${sessionId}` : `claude${flags}`;
  return shellCwd === cwd ? command : `cd ${shellQuote(cwd)} && ${command}`;
};

/** How long the chat's Claude must be seen gone before it is restarted, so a start or resume under way is never raced. */
const KEEP_GRACE_MS = 15_000;
const KEEP_SAMPLE_MS = 5_000;

/**
 * What keeping the chat's Claude alive does now: 'ok' (a Claude runs in the workspace), 'wait' (none has run for less than
 * KEEP_GRACE_MS, or the claude tab is busy with something else) or 'restart' (in the claude tab's pane, at its shell prompt) or
 * 'create' (the claude tab is gone), with when it was first seen gone (`since`, null while one runs).
 */
const keepAction = ({ since, now, claudeRunning, tab }) => {
  if (claudeRunning) return { action: 'ok', since: null };
  const goneSince = since ?? now;
  if (now - goneSince < KEEP_GRACE_MS) return { action: 'wait', since: goneSince };
  if (!tab) return { action: 'create', since: goneSince };
  return { action: tab.atPrompt ? 'restart' : 'wait', since: goneSince };
};

/** pid -> child pids, from one `ps` call. */
const processTree = (psOutput) => {
  const children = new Map();
  const commands = new Map();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, pid, ppid, command] = match;
    commands.set(Number(pid), command);
    children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)]);
  }
  const descendants = (pid) => (children.get(pid) ?? []).flatMap((child) => [child, ...descendants(child)]);
  return { descendants, command: (pid) => commands.get(pid) ?? '' };
};

const claudeProjectsDir = () => process.env.STUDIO_REAPER_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude', 'projects');

/** Whether Claude Code saved a transcript for the session (it only does once a message is sent). */
const hasTranscript = (sessionId) => {
  try {
    return fs.readdirSync(claudeProjectsDir()).some((dir) => fs.existsSync(path.join(claudeProjectsDir(), dir, `${sessionId}.jsonl`)));
  } catch {
    return true;
  }
};

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const herdr = (...args) => JSON.parse(run('herdr', args));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PANES_DIR = path.join(os.homedir(), '.claude', 'state', 'panes');

/**
 * ~/.studio/logs/sessions.jsonl: a line whenever something changes which conversation the chat's Claude runs, or the studio
 * types into it (/effort, /clear), so a chat that loses track can be worked out afterwards. The hook (studio-hook.py) adds a
 * line when a session starts. Never fails what it records.
 */
const logSession = (record, now = new Date()) => {
  try {
    const file = path.join(process.env.STUDIO_HOME || path.join(os.homedir(), '.studio'), 'logs', 'sessions.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), ...record })}\n`);
  } catch {
    // logging is best effort
  }
};
// The last disagreement logged for each pane, so one that lasts is logged once.
const disagreements = new Map();

const paneFile = (paneId, dir = PANES_DIR) => path.join(dir, `${paneId.replace(/:/g, '_')}.json`);

/**
 * herdr learns a pane's Claude session only at SessionStart, so after a /branch it keeps the parent's id.
 * The modes hooks and status line record the id the pane's Claude actually runs (hooks/modes); prefer it.
 * A null id is a Claude start/resume began there (notePaneSession) whose SessionStart hasn't run yet:
 * until it does, herdr's id is still the pane's last session, so the pane has none.
 */
const withRealSessions = (items, dir = PANES_DIR) =>
  items.map((item) => {
    try {
      const sessionId = JSON.parse(fs.readFileSync(paneFile(item.pane_id, dir), 'utf8')).session_id;
      if (!item.agent) return item;
      const herdrSays = item.agent_session?.value ?? null;
      const seen = `${sessionId} ${herdrSays}`;
      if (sessionId && herdrSays && sessionId !== herdrSays && disagreements.get(item.pane_id) !== seen) {
        logSession({ event: 'disagree', pane: item.pane_id, record: sessionId, herdr: herdrSays, note: "the pane's record wins; a stale record means the chat follows an old conversation" });
      }
      disagreements.set(item.pane_id, seen);
      if (sessionId) return { ...item, agent_session: { ...item.agent_session, value: sessionId } };
      return sessionId === null ? { ...item, agent_session: null } : item;
    } catch {
      return item;
    }
  });

/**
 * Notes, before Claude starts in a pane, which session it will run: the one resumed, or null for a new
 * one until its SessionStart hook records it. Else, for a second or two, the pane would show its last
 * session (or, with a recycled pane id, another pane's).
 */
const notePaneSession = (paneId, sessionId, dir = PANES_DIR) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${paneFile(paneId, dir)}.tmp`, JSON.stringify({ pane_id: paneId, session_id: sessionId }));
  fs.renameSync(`${paneFile(paneId, dir)}.tmp`, paneFile(paneId, dir));
};

const claudeProcess = (processInfo) => processInfo.foreground_processes?.find((proc) => proc.argv0 === 'claude' || proc.argv?.[0] === 'claude');

const gatherFacts = (agent, tree) => {
  const info = herdr('pane', 'process-info', '--pane', agent.pane_id).result.process_info;
  const claude = claudeProcess(info);
  if (!claude) {
    return null;
  }
  return {
    claude,
    shellPid: info.shell_pid,
    hasShell: Boolean(info.shell_pid) && info.shell_pid !== claude.pid,
    runningCommand: runningCommands(claude.pid, tree).length > 0,
    input: typedInput(run('herdr', ['pane', 'read', agent.pane_id, '--source', 'visible', '--format', 'ansi'])),
  };
};

const appendClosed = (record) => {
  fs.mkdirSync(reaperDir(), { recursive: true });
  fs.appendFileSync(closedLogPath(), `${JSON.stringify(record)}\n`);
};

const stopPane = async (agent, facts) => {
  const alive = () => {
    try {
      process.kill(facts.claude.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  run('herdr', ['pane', 'send-keys', agent.pane_id, 'C-c']);
  await sleep(500);
  run('herdr', ['pane', 'send-keys', agent.pane_id, 'C-c']);
  for (let i = 0; i < 40 && alive(); i += 1) {
    await sleep(250);
  }
  if (alive()) {
    throw new Error(`claude (pid ${facts.claude.pid}) in ${agent.pane_id} didn't exit after Ctrl-C twice`);
  }
  const shellCwd = herdr('pane', 'process-info', '--pane', agent.pane_id).result.process_info.foreground_processes?.[0]?.cwd;
  const command = resumeCommand({ argv: facts.claude.argv ?? [], sessionId: agent.agent_session.value, cwd: facts.claude.cwd, shellCwd, saved: hasTranscript(agent.agent_session.value) });
  run('herdr', ['pane', 'send-text', agent.pane_id, command]);
  return command;
};

/** Stops (or, with no shell under Claude, closes) the pane and logs how to resume it, and who stopped it: 'reaper' or 'you' (×). */
const stopAndLog = async (agent, facts, action, by) => {
  let resume;
  if (action === 'stop') {
    resume = await stopPane(agent, facts);
  } else {
    run('herdr', ['pane', 'close', agent.pane_id]);
    resume = resumeCommand({ argv: facts.claude.argv ?? [], sessionId: agent.agent_session.value, cwd: facts.claude.cwd, shellCwd: null, saved: hasTranscript(agent.agent_session.value) });
  }
  appendClosed({ ts: new Date().toISOString(), how: action === 'stop' ? 'stopped' : 'closed', by, pane_id: agent.pane_id, tab_id: agent.tab_id, workspace_id: agent.workspace_id, cwd: facts.claude.cwd, session_id: agent.agent_session.value, resume });
  return resume;
};

/**
 * Stops one pane's Claude session now, whatever its state: the index's × on a session chip. Dismissed too,
 * nothing will resume it there, so its pane closes rather than staying at a shell prompt.
 */
const stopNow = async (paneId, { dismissToo = false } = {}) => {
  const agent = withRealSessions(herdr('agent', 'list').result.agents).find((candidate) => candidate.pane_id === paneId && candidate.agent === 'claude');
  if (!agent?.agent_session?.value) {
    throw new Error(`no Claude session in pane ${paneId}`);
  }
  const facts = gatherFacts(agent, processTree(run('ps', ['-axo', 'pid=,ppid=,command='])));
  if (!facts) {
    throw new Error(`can't find the claude process in ${paneId}`);
  }
  await stopAndLog(agent, facts, facts.hasShell && !dismissToo ? 'stop' : 'close', 'you');
  if (dismissToo) {
    dismiss(agent.agent_session.value);
    return;
  }
  console.log(`Stopped ${agent.agent_session.value} in ${paneId}; resume it from the index or with Enter in the pane`);
};

const reapOnce = async (idle, { dryRun, now = Date.now(), ignoreIdleTime = false, only = null }) => {
  const agents = withRealSessions(herdr('agent', 'list').result.agents).filter((candidate) => only === null || candidate.pane_id === only);
  const nextIdle = trackIdle(idle, agents, now);
  if (ignoreIdleTime) {
    for (const entry of Object.values(nextIdle)) {
      entry.since = now - idleThresholdMs();
    }
  }
  const tree = processTree(run('ps', ['-axo', 'pid=,ppid=,command=']));
  for (const agent of agents.filter((candidate) => nextIdle[candidate.pane_id])) {
    const idleSince = nextIdle[agent.pane_id].since;
    if (now - idleSince < idleThresholdMs()) {
      continue;
    }
    const facts = gatherFacts(agent, tree);
    if (!facts || !agent.agent_session?.value) {
      continue;
    }
    const { action, reason } = reapAction({ agent, idleSince, now, thresholdMs: idleThresholdMs(), facts });
    const where = `${agent.pane_id} ${path.basename(agent.cwd)}`;
    if (action === 'skip' || action === 'wait') {
      console.error(`${new Date(now).toISOString()} skip ${where}: ${reason}`);
      continue;
    }
    console.error(`${new Date(now).toISOString()} ${dryRun ? 'would ' : ''}${action} ${where}: ${reason}`);
    if (dryRun) {
      continue;
    }
    try {
      await stopAndLog(agent, facts, action, 'reaper');
      delete nextIdle[agent.pane_id];
    } catch (error) {
      console.error(`  failed: ${error.message}`);
    }
  }
  return nextIdle;
};

const readClosed = () =>
  fs.existsSync(closedLogPath())
    ? fs
        .readFileSync(closedLogPath(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

const inWorktree = (cwd, worktreePath) => cwd === worktreePath || cwd.startsWith(`${worktreePath}/`);

const PAUSED_MAX_AGE_MS = 24 * 3_600_000;
const PAUSED_MAX = 3;

/**
 * The worktree's stopped sessions that aren't running again, newest first, one per session: those
 * stopped in the last day, at most three. One stopped before anything was said in it has no transcript,
 * so nothing to resume (its resume command is a fresh `claude`), and is left out, as is one dismissed
 * since it was last stopped.
 */
const pausedSessions = (records, worktreePath, runningSessionIds, now = Date.now()) => {
  const seen = new Set();
  const dismissedAt = new Map(records.filter((record) => record.how === 'dismissed').map((record) => [record.session_id, record.ts]));
  return records
    .filter((record) => record.how !== 'dismissed' && !(dismissedAt.get(record.session_id) >= record.ts))
    .filter((record) => inWorktree(record.cwd, worktreePath) && now - Date.parse(record.ts) < PAUSED_MAX_AGE_MS && record.resume.includes('--resume '))
    .reverse()
    .filter((record) => !seen.has(record.session_id) && seen.add(record.session_id) && !runningSessionIds.has(record.session_id))
    .slice(0, PAUSED_MAX);
};

const SHELLS = ['zsh', 'bash', 'sh', 'fish', '-zsh', '-bash'];

const resumeWorktree = (worktreePath, sessionId = null, { watch = false, message = null } = {}) => {
  const running = new Set(withRealSessions(herdr('agent', 'list').result.agents).map((agent) => agent.agent_session?.value).filter(Boolean));
  const record = pausedSessions(readClosed(), worktreePath, running).find((candidate) => sessionId === null || candidate.session_id === sessionId);
  if (!record) {
    throw new Error(`no stopped Claude session${sessionId ? ` ${sessionId}` : ''} to resume in ${worktreePath}`);
  }
  const reuse = atShellPrompt(record.pane_id) ? { pane: record.pane_id, tab: record.tab_id } : null;
  const prompt = watch ? ' /watch-mr' : message ? ` ${shellQuote(message)}` : '';
  const pane = runInClaudeTab(worktreePath, record.cwd, record.resume + prompt, record.session_id, reuse);
  console.log(`Resumed ${record.session_id} in ${pane}`);
};

const atShellPrompt = (paneId) => {
  try {
    const info = herdr('pane', 'process-info', '--pane', paneId).result.process_info;
    return (info.foreground_processes ?? []).every((proc) => SHELLS.includes(proc.name));
  } catch {
    return false;
  }
};

// Runs command (Claude running sessionId, null for a new one) in reuse's pane (a shell prompt), else in a new 'claude' tab in the worktree's workspace, and focuses it.
const runInClaudeTab = (worktreePath, cwd, command, sessionId, reuse = null) => {
  let pane = reuse?.pane;
  let tab = reuse?.tab;
  if (pane) {
    // herdr's send-keys has no C-u; at a shell prompt C-c discards whatever is typed there.
    run('herdr', ['pane', 'send-keys', pane, 'C-c']);
  } else {
    const workspace = run(path.join(__dirname, '..', 'worktree-workspace.sh'), [worktreePath]).trim();
    // A new pane gets its environment from herdr, not from here, so the hooks' variables are passed on. Its Claude is the chat's
    // (STUDIO_ROLE=chat, see lib/feature.js); a pane reused above keeps the role it was made with.
    const env = [`STUDIO_DIR=${STUDIO_DIR}`, ...(process.env.STUDIO_HOME ? [`STUDIO_HOME=${process.env.STUDIO_HOME}`] : []), 'STUDIO_ROLE=chat'].flatMap((pair) => ['--env', pair]);
    const created = herdr('tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', 'claude', ...env).result;
    pane = created.root_pane.pane_id;
    tab = created.tab.tab_id;
  }
  notePaneSession(pane, sessionId);
  run('herdr', ['pane', 'run', pane, command]);
  run('herdr', ['tab', 'focus', tab]);
  return pane;
};

/**
 * Starts a fresh Claude session in a worktree, alongside any already running, always in a new 'claude' tab:
 * a pane an earlier session ran in would keep its id, so the cockpit would show that session's state there.
 */
const startWorktree = (worktreePath, message = null) => {
  const pane = runInClaudeTab(worktreePath, worktreePath, claudeCommand() + (message ? ` ${shellQuote(message)}` : ''), null);
  console.log(`Started Claude in ${pane}`);
};

const reconnectedPath = () => path.join(reaperDir(), 'reconnected.json');

/** When the keeper last restarted the chat's Claude ({ at, paneId }), for the chat's "Reconnected"; null if it never has. */
const readReconnected = () => {
  try {
    return JSON.parse(fs.readFileSync(reconnectedPath(), 'utf8'));
  } catch {
    return null;
  }
};

/** The app's Claude command, continuing its last conversation when it has one (as `studio up` starts it); STUDIO_CLAUDE_CMD stands in for it. */
const chatCommand = (appDir) => {
  if (process.env.STUDIO_CLAUDE_CMD) return process.env.STUDIO_CLAUDE_CMD;
  const transcripts = path.join(claudeProjectsDir(), appDir.replace(/[^A-Za-z0-9]/g, '-'));
  const hasConversation = fs.existsSync(transcripts) && fs.readdirSync(transcripts).some((name) => name.endsWith('.jsonl'));
  return claudeCommand() + (hasConversation ? ' --continue' : '');
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * A Claude in the chat's pane that wasn't started the studio's way: herdr, restoring panes after a restart, runs a plain
 * `claude --resume <id>`, without the studio's settings and plugin. That Claude has none of the studio's hooks (no
 * checkpoints, no Ask/Plan guard, and a chat that loses track of it at /clear). Once it is idle it is stopped and started
 * again with claudeCommand(), resuming the same session, and the chat shows "Reconnected". Returns whether it did.
 */
const restartWithStudio = (pane, processInfo, now, panesDir = PANES_DIR) => {
  const claude = claudeProcess(processInfo);
  if (!claude || process.env.STUDIO_CLAUDE_CMD || (claude.argv ?? []).includes('--plugin-dir') || !['idle', 'done'].includes(pane.agent_status)) return false;
  const argv = claude.argv ?? [];
  const sessionId = pane.agent_session?.value ?? (argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null);
  run('herdr', ['pane', 'send-keys', pane.pane_id, 'C-c']);
  sleepSync(500);
  run('herdr', ['pane', 'send-keys', pane.pane_id, 'C-c']);
  for (let i = 0; i < 40 && alive(claude.pid); i += 1) sleepSync(250);
  if (alive(claude.pid)) {
    console.error(`${new Date(now).toISOString()} claude (pid ${claude.pid}) in ${pane.pane_id} runs without the studio's settings, and didn't stop to be started again with them`);
    return false;
  }
  const resume = sessionId && hasTranscript(sessionId);
  notePaneSession(pane.pane_id, resume ? sessionId : null, panesDir);
  run('herdr', ['pane', 'run', pane.pane_id, `${claudeCommand()}${resume ? ` --resume ${sessionId}` : ''}`]);
  fs.mkdirSync(reaperDir(), { recursive: true });
  fs.writeFileSync(reconnectedPath(), JSON.stringify({ at: new Date(now).toISOString(), paneId: pane.pane_id }));
  logSession({ event: 'restarted', pane: pane.pane_id, session: resume ? sessionId : null, why: "it ran without the studio's settings" }, new Date(now));
  console.error(`${new Date(now).toISOString()} Claude in ${pane.pane_id} ran without the studio's settings, so it was started again with them`);
  return true;
};

/**
 * One look at the studio's workspace (labelled `workspaceLabel`): when no Claude has run in it for KEEP_GRACE_MS, Claude is started
 * again with --continue in the claude tab's pane, or in a new claude tab if that was closed, marked as the chat's (STUDIO_ROLE=chat),
 * and the restart is noted for the chat to show "Reconnected". Returns the `since` to pass to the next look.
 */
const keepOnce = (since, { workspaceLabel, appDir, now = Date.now(), panesDir = PANES_DIR }) => {
  const workspace = herdr('workspace', 'list').result.workspaces.find((candidate) => candidate.label === workspaceLabel);
  if (!workspace) return null;
  const panes = herdr('pane', 'list', '--workspace', workspace.workspace_id).result.panes;
  const info = (pane) => herdr('pane', 'process-info', '--pane', pane.pane_id).result.process_info;
  const claudeRunning = panes.some((pane) => claudeProcess(info(pane)));
  const tabId = herdr('tab', 'list', '--workspace', workspace.workspace_id).result.tabs.find((candidate) => candidate.label === 'claude')?.tab_id;
  const pane = tabId && panes.find((candidate) => candidate.tab_id === tabId);
  const tab = pane ? { paneId: pane.pane_id, atPrompt: (({ foreground_process_group_id: group, shell_pid: shell }) => Boolean(shell) && group === shell)(info(pane)) } : null;
  if (pane && restartWithStudio(pane, info(pane), now, panesDir)) return null;
  const next = keepAction({ since, now, claudeRunning, tab });
  if (next.action !== 'restart' && next.action !== 'create') return next.since;
  let paneId = tab?.paneId;
  if (next.action === 'restart') {
    // Whatever is typed at the prompt (a stopped session's `claude --resume …`) goes first.
    run('herdr', ['pane', 'send-keys', paneId, 'C-c']);
  } else {
    const env = ['STUDIO_DIR', 'STUDIO_HOME', 'STUDIO_PORT', 'STUDIO_WHISPER_PORT'].filter((name) => process.env[name]).map((name) => `${name}=${process.env[name]}`);
    paneId = herdr('tab', 'create', '--workspace', workspace.workspace_id, '--cwd', appDir, '--label', 'claude', '--no-focus', ...[...env, 'STUDIO_ROLE=chat'].flatMap((pair) => ['--env', pair])).result.root_pane.pane_id;
  }
  run('herdr', ['pane', 'run', paneId, chatCommand(appDir)]);
  fs.mkdirSync(reaperDir(), { recursive: true });
  fs.writeFileSync(reconnectedPath(), JSON.stringify({ at: new Date(now).toISOString(), paneId }));
  logSession({ event: 'restarted', pane: paneId, why: "Claude wasn't running" }, new Date(now));
  console.error(`${new Date(now).toISOString()} Claude wasn't running, so it was started again in ${paneId}`);
  return null;
};

/** Stops offering a stopped session to resume: logs it dismissed, in its worktree. Its transcript stays, so `claude --resume` still finds it. */
const dismiss = (sessionId) => {
  const stopped = readClosed().findLast((record) => record.session_id === sessionId && record.how !== 'dismissed');
  if (!stopped) {
    throw new Error(`no stopped Claude session ${sessionId}`);
  }
  appendClosed({ ts: new Date().toISOString(), how: 'dismissed', cwd: stopped.cwd, session_id: sessionId });
  console.log(`Dismissed ${sessionId}; claude --resume ${sessionId} still brings it back`);
};

const listClosed = (count) => {
  for (const record of readClosed().filter((candidate) => candidate.how !== 'dismissed').slice(-count)) {
    console.log(`${record.ts}  ${record.how.padEnd(7)} ${path.basename(record.cwd)}\n    ${record.resume}`);
  }
};

const main = async () => {
  const [mode = 'watch', ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run');
  if (mode === 'list') {
    listClosed(Number(rest[0] ?? 20));
    return;
  }
  if (mode === 'resume') {
    const messageAt = rest.indexOf('--message');
    const message = messageAt >= 0 ? rest[messageAt + 1] : null;
    const [worktree, session] = rest.filter((arg, i) => arg !== '--watch' && (messageAt < 0 || (i !== messageAt && i !== messageAt + 1)));
    resumeWorktree(worktree ?? process.cwd(), session ?? null, { watch: rest.includes('--watch'), message });
    return;
  }
  if (mode === 'start') {
    const messageAt = rest.indexOf('--message');
    const message = messageAt >= 0 ? rest[messageAt + 1] : null;
    const [worktree] = rest.filter((_, i) => messageAt < 0 || (i !== messageAt && i !== messageAt + 1));
    startWorktree(worktree ?? process.cwd(), message);
    return;
  }
  if (mode === 'stop') {
    await stopNow(rest.find((arg) => arg !== '--dismiss'), { dismissToo: rest.includes('--dismiss') });
    return;
  }
  if (mode === 'dismiss') {
    dismiss(rest[0]);
    return;
  }
  if (mode === 'keep') {
    const [workspaceLabel, appDir] = rest;
    if (!workspaceLabel || !appDir) throw new Error('usage: claude-reaper.sh keep <workspace> <app>');
    console.error(`Keeping the chat's Claude running in workspace ${workspaceLabel}, for ${appDir}`);
    let since = null;
    for (;;) {
      try {
        since = keepOnce(since, { workspaceLabel, appDir: path.resolve(appDir) });
      } catch (error) {
        console.error(`${new Date().toISOString()} look failed: ${error.message}`);
      }
      await sleep(KEEP_SAMPLE_MS);
    }
  }
  if (mode === 'once') {
    const onlyAt = rest.indexOf('--only');
    await reapOnce({}, { dryRun, ignoreIdleTime: true, only: onlyAt >= 0 ? rest[onlyAt + 1] : null });
    return;
  }
  if (mode !== 'watch') {
    throw new Error('usage: claude-reaper.sh keep <workspace> <app> | watch|once [--dry-run] | list [n]');
  }
  console.error(`Reaper: stopping Claude panes idle ${idleThresholdMs() / 60_000} min, checking every ${SAMPLE_MS / 1000}s${dryRun ? ' (dry run)' : ''}`);
  let idle = {};
  for (;;) {
    try {
      idle = await reapOnce(idle, { dryRun });
    } catch (error) {
      console.error(`${new Date().toISOString()} pass failed: ${error.message}`);
    }
    await sleep(SAMPLE_MS);
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { COMMAND_SHELL_MARKER, KEEP_GRACE_MS, keepAction, keepOnce, readReconnected, notePaneSession, logSession, withRealSessions, claudeCommand, closedLogPath, commandText, pausedSessions, processTree, runningCommands, readClosed, reapAction, resumeCommand, trackIdle, typedInput };
