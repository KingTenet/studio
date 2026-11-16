'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { digest, read, write } = require('./summary');
const { folderFor } = require('./artifacts');

let worktree;
let chats;

beforeEach(() => {
  process.env.STUDIO_ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-summary-store-'));
  process.env.STUDIO_REAPER_CLAUDE_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-summary-projects-'));
  worktree = '/Users/me/Coding/wt-one';
  chats = path.join(process.env.STUDIO_REAPER_CLAUDE_PROJECTS, '-Users-me-Coding-wt-one');
  fs.mkdirSync(chats);
});

const chat = (name, records, mtime) => {
  const file = path.join(chats, name + '.jsonl');
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime, mtime);
};
const you = (text) => ({ type: 'user', message: { content: text } });
const claude = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });

test('the digest is what was said in each chat, oldest first, without tool calls', () => {
  chat('b', [you('second ask'), claude('second answer')], new Date('2026-01-02'));
  chat('a', [{ type: 'ai-title', aiTitle: 'Fix the panel' }, you('first ask'), claude('first answer')], new Date('2026-01-01'));
  const { text, sessions } = digest(worktree);
  assert.equal(sessions, 2);
  assert.match(text, /## Chat "Fix the panel"[^]*YOU: first ask\n\nCLAUDE: first answer[^]*YOU: second ask/);
  assert.doesNotMatch(text, /Bash|ls/);
});

test('a chat with nothing said is left out, and no chats says so', () => {
  chat('empty', [{ type: 'permission-mode' }]);
  assert.equal(digest(worktree).sessions, 0);
  assert.match(digest(worktree).text, /\(none\)/);
});

test('the oldest chats are dropped first when they would not fit, and the previous summary leads', () => {
  write(worktree, 'Earlier: shipped the card.', 1);
  chat('old', Array.from({ length: 50 }, () => you('x'.repeat(1400))), new Date('2026-01-01'));
  chat('new', [you('y'.repeat(1400)), you('z'.repeat(1400))], new Date('2026-01-02'));
  const { text } = digest(worktree);
  assert.match(text, /^# Previous summary [^]*Earlier: shipped the card\./);
  assert.match(text, /the oldest 1 left out/);
  assert.doesNotMatch(text, /xxx/);
  assert.match(text, /zzz/);
});

test('long messages are cut', () => {
  chat('a', [you('w'.repeat(5000))]);
  assert.match(digest(worktree).text, /w{1500} \[…\]/);
});

test('read gives the summary written and whether a live run is writing one', () => {
  assert.deepEqual(read(worktree), { summary: null, running: false });
  write(worktree, '  Done: the card.\n', 3);
  assert.equal(read(worktree).summary.text, 'Done: the card.');
  assert.equal(read(worktree).summary.sessions, 3);
  fs.writeFileSync(path.join(folderFor(worktree), 'summary.running'), String(process.pid));
  assert.equal(read(worktree).running, true);
  fs.writeFileSync(path.join(folderFor(worktree), 'summary.running'), '999999999');
  assert.equal(read(worktree).running, false);
});
