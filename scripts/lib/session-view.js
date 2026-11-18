'use strict';

/**
 * Helpers behind the single-worktree cockpit (renderCockpit in studio-worktree-hosts.js, served by studio-server.js at
 * http://<label>.localhost/_env/wt): a Claude session's transcript cut down to what the chat column
 * shows, and what a herdr pane's screen says about the session (text typed but not sent, an open
 * prompt's options).
 *
 * Run tests: node --test lib/session-view.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeProjectsDir = () => process.env.STUDIO_REAPER_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude', 'projects');

const transcriptPaths = new Map();

const transcriptPath = (sessionId, dir = claudeProjectsDir()) => {
  const cached = transcriptPaths.get(sessionId);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }
  let projects = [];
  try {
    projects = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = path.join(dir, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      transcriptPaths.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
};

const oneLine = (text, max = 200) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const toolSummary = (name, input = {}) => {
  if (name === 'AskUserQuestion') {
    return oneLine(input.questions?.[0]?.question);
  }
  return oneLine(input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? input.action ?? input.prompt ?? '');
};

const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/;
// Claude Code wraps pasted text in these; the paste is still what the user sent.
const PASTE_TAG = /<\/?pasted_content id="[^"]*">/g;

// What the user typed, or null for harness-injected text (reminders, command output, skill bodies).
const typedText = (text) => {
  const command = COMMAND_NAME.exec(text);
  if (command) {
    // The studio types /effort itself when the mode changes (syncEffort): not something to show as a message.
    if (command[1] === '/effort') return null;
    return `${command[1]} ${COMMAND_ARGS.exec(text)?.[1] ?? ''}`.trim();
  }
  if (text.trimStart().startsWith('<') && !text.trimStart().startsWith('<pasted_content ')) {
    return null;
  }
  return text.replace(PASTE_TAG, '');
};

/**
 * A message sent while Claude works is queued rather than recorded as a user message. Its queue
 * operations become chat events the cockpit resolves (resolveQueue in web/): `enqueue` is shown as
 * your message, queued; `remove` (absorbed_mid_turn) means Claude read it mid-turn; `dequeue` takes
 * the oldest queued item, yours or Claude Code's own (a task notification), as the next prompt, which
 * is then recorded as usual; `popAll` puts the queue back into the input box.
 */
const queueMessages = (record) => {
  const text = typeof record.content === 'string' ? typedText(record.content) : null;
  switch (record.operation) {
    case 'enqueue':
      return [text ? { kind: 'you', text, queued: true } : { kind: 'queue', op: 'enqueue' }];
    case 'remove':
      return [{ kind: 'queue', op: record.reason === 'absorbed_mid_turn' ? 'absorbed' : 'removed', text: text ?? '' }];
    case 'dequeue':
      return [{ kind: 'queue', op: 'dequeue' }];
    case 'popAll':
      return [{ kind: 'queue', op: 'popAll' }];
    default:
      return [];
  }
};

/** One transcript record -> the chat messages it shows: { kind: you|claude|tool|note|queue, text, detail?, queued?, op? }. */
const recordMessages = (record) => {
  if (record.isSidechain || record.isMeta) {
    return [];
  }
  if (record.type === 'queue-operation') {
    return queueMessages(record);
  }
  const content = record.message?.content;
  if (record.type === 'user') {
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text) : [];
    return texts.flatMap((text) => {
      if (/^\[Request interrupted by user/.test(text)) {
        return [{ kind: 'note', text: 'Interrupted' }];
      }
      const typed = typedText(text);
      return typed ? [{ kind: 'you', text: typed }] : [];
    });
  }
  if (record.type === 'assistant' && Array.isArray(content)) {
    return content.flatMap((part) => {
      if (part.type === 'text' && part.text.trim()) {
        return [{ kind: 'claude', text: part.text }];
      }
      if (part.type === 'tool_use') {
        const detail = part.name === 'Bash' ? oneLine(part.input?.command, 400) : undefined;
        return [{ kind: 'tool', text: `${part.name} ${toolSummary(part.name, part.input)}`.trim(), ...(detail ? { detail } : {}) }];
      }
      return [];
    });
  }
  return [];
};

const TAIL_MESSAGES = 200;

/**
 * The messages in a transcript from byte `after` on, and the offset to ask from next time. Without
 * `after` it reads the whole file and keeps the last TAIL_MESSAGES. A line still being written (no
 * newline yet) is left for the next read. A file shorter than `after` (rewritten) is read afresh.
 */
const readTranscript = (file, after) => {
  const size = fs.statSync(file).size;
  const start = after !== undefined && after <= size ? after : 0;
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const messages = complete
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return recordMessages(JSON.parse(line));
      } catch {
        return [];
      }
    });
  return {
    offset: start + Buffer.byteLength(complete, 'utf8'),
    reset: start !== after,
    messages: start === 0 ? messages.slice(-TAIL_MESSAGES) : messages,
  };
};

const titleCache = new Map();

/**
 * The name Claude Code gives a session: its /rename title (custom-title records), else the title it
 * generated (ai-title), else null. Both are re-appended as the session goes on, so the latest wins.
 * Each call reads only what was appended since the last one.
 */
const sessionTitle = (sessionId, dir = claudeProjectsDir()) => {
  const file = sessionId && transcriptPath(sessionId, dir);
  if (!file) {
    return null;
  }
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  const cached = titleCache.get(file);
  const titles = cached && cached.size <= size ? { ...cached } : { size: 0, custom: null, ai: null };
  if (size > titles.size) {
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(size - titles.size);
      fs.readSync(fd, buffer, 0, buffer.length, titles.size);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    for (const line of complete.split('\n')) {
      if (!line.includes('"customTitle"') && !line.includes('"aiTitle"')) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (record.type === 'custom-title' && record.customTitle) {
          titles.custom = record.customTitle;
        } else if (record.type === 'ai-title' && record.aiTitle) {
          titles.ai = record.aiTitle;
        }
      } catch {}
    }
    titles.size += Buffer.byteLength(complete, 'utf8');
  }
  titleCache.set(file, titles);
  return titles.custom ?? titles.ai ?? null;
};

// CSI and OSC escape sequences.
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const stripAnsi = (text) => text.replace(ESCAPES, '');

/**
 * The characters of a screen line drawn in the terminal's default colour and not dimmed. Text you
 * type into Claude's input box is drawn like that; its borders, the ❯ and a suggestion are not.
 */
const unstyledText = (line) => {
  let plain = true;
  let out = '';
  let last = 0;
  for (const match of line.matchAll(ESCAPES)) {
    if (plain) {
      out += line.slice(last, match.index);
    }
    last = match.index + match[0].length;
    if (match[0].endsWith('m') && match[0].startsWith('\x1b[')) {
      const codes = match[0].slice(2, -1).split(';').map((code) => Number(code || 0));
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0 || code === 39) {
          plain = true;
        } else if (code === 2 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          plain = false;
        } else if (code === 38) {
          plain = false;
          i += codes[i + 1] === 5 ? 2 : 4;
        } else if (code === 48) {
          i += codes[i + 1] === 5 ? 2 : 4;
        }
      }
    }
  }
  return plain ? out + line.slice(last) : out;
};

const RULE = /^─{10,}\s*$/;
const INPUT_START = /^❯[\s ](?!\s*\d+\.\s)/;

/** Whether Claude's input box is drawn on a pane's screen yet (it isn't while Claude Code starts or resumes). */
const hasInputBox = (screen) => {
  const plain = stripAnsi(screen).replace(/\r/g, '').split('\n');
  return plain.some((line, i) => i > 0 && INPUT_START.test(line) && RULE.test(plain[i - 1]));
};

/** Text typed into Claude's input box but not sent, from a pane's ANSI screen ('' when empty). */
const paneInput = (ansiScreen) => {
  const lines = ansiScreen.replace(/\r/g, '').split('\n');
  const plain = lines.map(stripAnsi);
  for (let i = plain.length - 1; i > 0; i--) {
    if (INPUT_START.test(plain[i]) && RULE.test(plain[i - 1])) {
      const typed = [];
      for (let j = i; j < plain.length && !RULE.test(plain[j]); j++) {
        const text = unstyledText(lines[j]).replace(/ /g, ' ');
        typed.push(j === i ? text.replace(/^❯\s?/, '') : text.replace(/^ {2}/, ''));
      }
      return typed.join('\n').trim();
    }
  }
  return '';
};

const USAGE_LIMIT = /You(?:'|’)ve hit your\b.*?\blimit\b.*$/;
// Claude's own replies start with ⏺: one below the limit line means Claude has carried on since.
const REPLY = /^\s*⏺/;

/**
 * Claude Code's own line saying a usage limit was hit (`You've hit your session limit · resets 3:45pm`), from a pane's
 * screen; null when there is none, or when Claude has replied again below it (the limit has reset and it carried on).
 */
const usageLimit = (screenText) => {
  const lines = stripAnsi(screenText).replace(/\r/g, '').split('\n');
  const at = lines.findLastIndex((line) => USAGE_LIMIT.test(line));
  if (at < 0 || lines.slice(at + 1).some((line) => REPLY.test(line))) return null;
  return USAGE_LIMIT.exec(lines[at])[0].replace(/[\s│]+$/, '');
};

const OPTION = /^\s*(?:❯\s*)?(\d)\.\s+(.+?)\s*$/;
const CHECKBOX = /^\[([ ✔x])\]\s*/;
// A multi-select question ends its checkboxes with an unnumbered button: Next, or Submit on the last question.
const SUBMIT = /^\s*(?:❯\s*)?(Next|Submit)\s*$/;
const FOCUSED = /^\s*❯/;
const FREE_PLACEHOLDER = 'Type something.';
const MAX_OPTION_GAP = 8;
// A prompt sits at the bottom of the screen; a numbered list further up is Claude's own reply.
const MAX_LINES_BELOW_PROMPT = 8;

/**
 * The prompt a blocked session shows (a permission request or a question) as { question, options:
 * [{ key, label, checked?, free?, typed? }], focused, submit? }: the run of options numbered 1..n at the
 * bottom of the screen, and the line above option 1. A multi-select's options carry `checked`, and
 * `submit` is its button's label (Next or Submit). `focused` is the option the ❯ is on. A question's
 * option before "Chat about this" is a text field (`free`), showing "Type something." until something
 * is typed into it, which `typed` holds. Null when there is none.
 */
const panePrompt = (screenText) => {
  const lines = stripAnsi(screenText)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, ''));
  while (lines.length && !lines.at(-1).trim()) {
    lines.pop();
  }
  let end = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 1 - MAX_LINES_BELOW_PROMPT) && end < 0; i--) {
    if (OPTION.test(lines[i])) {
      end = i;
    }
  }
  if (end < 0) {
    return null;
  }
  // The pane's width: a rule spans it; else the longest line. A line the terminal wrapped was full, so the word that
  // starts the next one didn't fit on it.
  const width = Math.max(...lines.filter((line) => RULE.test(line.trim())).map((line) => line.trim().length), 0) || Math.max(...lines.map((line) => line.length));
  // The text goes on where the option's own text starts (`  2. ` → column 5), never as a border or a rule.
  const textColumn = (line) => line.length - OPTION.exec(line)[2].length - (line.length - line.trimEnd().length);
  const wrappedInto = (start, line, next) =>
    next !== undefined && next.trim() && !OPTION.test(next) && !RULE.test(next.trim()) && !/^[╰╭└┌─]/.test(next.trim()) &&
    next.length - next.trimStart().length >= start && line.length + 1 + next.trim().split(/\s+/)[0].length > width;
  const options = [];
  let focused = null;
  let want = Number(OPTION.exec(lines[end])[1]);
  let at = end;
  for (let i = end; i >= 0 && want >= 1 && at - i <= MAX_OPTION_GAP; i--) {
    const match = OPTION.exec(lines[i]);
    if (match && Number(match[1]) === want) {
      // An option too long for the pane goes on over the next lines.
      let label = match[2];
      const start = textColumn(lines[i]);
      for (let j = i; wrappedInto(start, lines[j], lines[j + 1]); j++) label += ` ${lines[j + 1].trim()}`;
      const box = CHECKBOX.exec(label);
      options.unshift(box ? { key: match[1], label: label.slice(box[0].length), checked: box[1] !== ' ' } : { key: match[1], label });
      if (FOCUSED.test(lines[i])) {
        focused = match[1];
      }
      want -= 1;
      at = i;
    }
  }
  if (want !== 0) {
    return null;
  }
  // The paragraph above option 1, whose lines the terminal wrapped: back to a blank line or a rule.
  const above = lines.slice(0, at).map((line) => line.trim());
  let last = above.length - 1;
  while (last >= 0 && (!above[last] || RULE.test(above[last]))) {
    last -= 1;
  }
  let first = last;
  while (first > 0 && above[first - 1] && !RULE.test(above[first - 1])) {
    first -= 1;
  }
  const question = last >= 0 ? above.slice(first, last + 1).join(' ') : null;
  const submit = lines.slice(at).map((line) => SUBMIT.exec(line)?.[1]).find(Boolean);
  const free = options.at(-1).label === 'Chat about this' && options.length > 1 ? options.at(-2) : null;
  if (free && free.checked === undefined) {
    Object.assign(free, { free: true, typed: free.label === FREE_PLACEHOLDER ? '' : free.label });
  }
  return { question: question ?? '', options, focused, ...(submit && { submit }) };
};

module.exports = { hasInputBox, paneInput, panePrompt, readTranscript, recordMessages, sessionTitle, stripAnsi, transcriptPath, unstyledText, usageLimit };
