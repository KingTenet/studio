'use strict';

/**
 * The summary the cockpit's ticket panel shows: where a worktree's work stands, written by Claude
 * (the worktree-summary skill, run headless by summary.sh) from the worktree's chats.
 * It lives in the worktree's artifact folder (artifacts.js):
 *   summary.json      { text, at, sessions }: the latest summary, when it was written, from how many chats
 *   summary.running   the pid of the run writing a new one, while it runs
 *   summary-digest.md what that run read: the chats cut down to what was said, plus the previous summary
 *
 * Usage: node lib/summary.js digest [dir]   print the digest of dir's worktree's chats (default: cwd)
 *        node lib/summary.js write [dir]    save stdin as its summary
 *        node lib/summary.js status [dir]   its summary and whether one is being written, as JSON
 *
 * Run tests: node --test lib/summary.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { folderFor, worktreeOf } = require('./artifacts');
const { recordMessages } = require('./session-view');

const projectsDir = () => process.env.STUDIO_REAPER_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude', 'projects');

// The digest must fit one Read (about 25k tokens), so long messages are cut and the oldest chats dropped first.
const MAX_MESSAGE = 1500;
const MAX_DIGEST = 60_000;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const cut = (text) => (text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) + ' […]' : text);

/** One chat as text: what you said and what Claude said, without its tool calls. Null if nothing was said. */
const chatText = (file) => {
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const title = records.findLast((record) => record.type === 'custom-title')?.customTitle ?? records.findLast((record) => record.type === 'ai-title')?.aiTitle;
  const lines = records
    .flatMap(recordMessages)
    .filter((message) => message.kind === 'you' || message.kind === 'claude')
    .map((message) => (message.kind === 'you' ? 'YOU: ' : 'CLAUDE: ') + cut(message.text.trim()));
  if (!lines.length) {
    return null;
  }
  const when = fs.statSync(file).mtime.toISOString().slice(0, 16).replace('T', ' ');
  return `## Chat${title ? ` "${title}"` : ''}, last active ${when}\n\n${lines.join('\n\n')}`;
};

/** The worktree's chats, oldest first, as many of the newest as fit, after its previous summary. */
const digest = (worktree) => {
  const dir = path.join(projectsDir(), worktree.replace(/[^A-Za-z0-9]/g, '-'));
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  } catch {
    // No chats yet.
  }
  const chats = files.map(chatText).filter(Boolean);
  const previous = read(worktree).summary;
  const head = previous ? `# Previous summary (${previous.at})\n\n${previous.text}\n\n` : '';
  const kept = [];
  let length = head.length;
  for (const chat of chats.toReversed()) {
    if (length + chat.length > MAX_DIGEST && kept.length) {
      break;
    }
    kept.unshift(chat.slice(-MAX_DIGEST));
    length += chat.length;
  }
  const dropped = chats.length - kept.length;
  return {
    sessions: chats.length,
    text: `${head}# Chats (${chats.length}${dropped ? `, the oldest ${dropped} left out` : ''})\n\n${kept.join('\n\n') || '(none)'}\n`,
  };
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** The worktree's summary (null until one is written) and whether a run is writing a new one. */
const read = (worktree) => {
  const folder = folderFor(worktree);
  const pid = Number(fs.existsSync(path.join(folder, 'summary.running')) && fs.readFileSync(path.join(folder, 'summary.running'), 'utf8'));
  return { summary: readJson(path.join(folder, 'summary.json'), null), running: pid > 0 && alive(pid) };
};

const write = (worktree, text, sessions) => {
  const folder = folderFor(worktree);
  fs.mkdirSync(folder, { recursive: true });
  const summary = { text: text.trim(), at: new Date().toISOString(), sessions };
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
};

if (require.main === module) {
  const [command, dir = process.cwd()] = process.argv.slice(2);
  const worktree = worktreeOf(dir);
  if (command === 'digest') {
    process.stdout.write(digest(worktree).text);
  } else if (command === 'write') {
    const text = fs.readFileSync(0, 'utf8');
    if (!text.trim()) {
      console.error('no summary on stdin');
      process.exit(1);
    }
    write(worktree, text, digest(worktree).sessions);
  } else if (command === 'status') {
    process.stdout.write(JSON.stringify(read(worktree), null, 2) + '\n');
  } else {
    console.error('usage: summary.js digest|write|status [dir]');
    process.exit(2);
  }
}

module.exports = { digest, read, write };
