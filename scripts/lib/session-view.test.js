'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hasInputBox, paneInput, panePrompt, readTranscript, recordMessages, sessionTitle, stripAnsi, transcriptPath, unstyledText, usageLimit } = require('./session-view');

const RULE = '\x1b[0m\x1b[38;2;138;138;138m' + '─'.repeat(40) + '\x1b[0m\r';
const STATUS = '  \x1b[0m\x1b[1m\x1b[38;5;6mdelivery\x1b[0m\x1b[38;2;102;102;102m · \x1b[0m';

test('recordMessages: a message queued while Claude works, and what became of it', () => {
  const queue = (operation, extra = {}) => recordMessages({ type: 'queue-operation', operation, ...extra });
  assert.deepEqual(queue('enqueue', { content: 'also check the alert log' }), [{ kind: 'you', text: 'also check the alert log', queued: true }]);
  assert.deepEqual(queue('enqueue', { content: '<task-notification>\n<task-id>b1</task-id>' }), [{ kind: 'queue', op: 'enqueue' }]);
  assert.deepEqual(queue('remove', { content: 'also check the alert log', reason: 'absorbed_mid_turn' }), [{ kind: 'queue', op: 'absorbed', text: 'also check the alert log' }]);
  assert.deepEqual(queue('remove', { content: '<task-notification>', reason: 'delivered_to_agent' }), [{ kind: 'queue', op: 'removed', text: '' }]);
  assert.deepEqual(queue('dequeue'), [{ kind: 'queue', op: 'dequeue' }]);
  assert.deepEqual(queue('popAll', { content: 'also check the alert log' }), [{ kind: 'queue', op: 'popAll' }]);
});

test('recordMessages: typed text, slash commands and interruptions; harness text and sidechains dropped', () => {
  assert.deepEqual(recordMessages({ type: 'user', message: { content: 'fix the target line' } }), [{ kind: 'you', text: 'fix the target line' }]);
  assert.deepEqual(recordMessages({ type: 'user', message: { content: '<command-name>/ship-it</command-name>\n<command-args>ABC-1</command-args>' } }), [{ kind: 'you', text: '/ship-it ABC-1' }]);
  assert.deepEqual(recordMessages({ type: 'user', message: { content: '<command-name>/effort</command-name>\n<command-args>medium</command-args>' } }), [], "the studio's own /effort isn't a message");
  assert.deepEqual(recordMessages({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }), [{ kind: 'note', text: 'Interrupted' }]);
  assert.deepEqual(recordMessages({ type: 'user', message: { content: '\n\n<pasted_content id="e38f">\nevent,count()\n$pageview,99\n</pasted_content id="e38f">\n' } }), [{ kind: 'you', text: '\n\n\nevent,count()\n$pageview,99\n\n' }]);
  assert.deepEqual(recordMessages({ type: 'user', message: { content: 'see this:\n<pasted_content id="a1">\nlog\n</pasted_content id="a1">' } }), [{ kind: 'you', text: 'see this:\n\nlog\n' }]);
  assert.deepEqual(recordMessages({ type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } }), []);
  assert.deepEqual(recordMessages({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill' }] } }), []);
  assert.deepEqual(recordMessages({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } }), []);
  assert.deepEqual(recordMessages({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }), []);
  assert.deepEqual(recordMessages({ type: 'attachment' }), []);
});

test('recordMessages: assistant text and one-line tool calls, thinking dropped', () => {
  const record = {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Reading the chart.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'git status\n--short', description: 'Show working tree status' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which window?' }] } },
        { type: 'tool_use', name: 'EnterPlanMode', input: {} },
      ],
    },
  };
  assert.deepEqual(recordMessages(record), [
    { kind: 'claude', text: 'Reading the chart.' },
    { kind: 'tool', text: 'Bash Show working tree status', detail: 'git status --short' },
    { kind: 'tool', text: 'Read /repo/a.ts' },
    { kind: 'tool', text: 'AskUserQuestion Which window?' },
    { kind: 'tool', text: 'EnterPlanMode' },
  ]);
});

test('readTranscript: tails the whole file first, then only what was appended, holding back a partial line', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-view-'));
  try {
    const file = path.join(dir, 's.jsonl');
    const line = (text) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
    writeFileSync(file, line('one') + line('two') + '{"type":"user","mess');
    const first = readTranscript(file);
    assert.deepEqual(first.messages.map((m) => m.text), ['one', 'two']);
    assert.equal(first.reset, true);
    appendFileSync(file, 'age":{"content":"three"}}\n' + line('four'));
    const next = readTranscript(file, first.offset);
    assert.deepEqual(next.messages.map((m) => m.text), ['three', 'four']);
    assert.equal(next.reset, false);
    assert.deepEqual(readTranscript(file, next.offset).messages, []);
    writeFileSync(file, line('fresh'));
    const rewritten = readTranscript(file, next.offset);
    assert.equal(rewritten.reset, true);
    assert.deepEqual(rewritten.messages.map((m) => m.text), ['fresh']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTranscript: a first read keeps only the last 200 messages', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-view-'));
  try {
    const file = path.join(dir, 's.jsonl');
    writeFileSync(file, Array.from({ length: 250 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `m${i}` } }) + '\n').join(''));
    const { messages } = readTranscript(file);
    assert.equal(messages.length, 200);
    assert.equal(messages[0].text, 'm50');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcriptPath: finds the session under any project directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-view-'));
  try {
    mkdirSync(path.join(dir, 'proj-a'));
    mkdirSync(path.join(dir, 'proj-b'));
    writeFileSync(path.join(dir, 'proj-b', 'abc.jsonl'), '');
    assert.equal(transcriptPath('abc', dir), path.join(dir, 'proj-b', 'abc.jsonl'));
    assert.equal(transcriptPath('missing', dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unstyledText: keeps default-colour text, drops coloured and dimmed runs', () => {
  assert.equal(unstyledText('❯ fix it\r'), '❯ fix it\r');
  assert.equal(unstyledText('\x1b[2m\x1b[38;2;102;102;102mTry "explain this"\x1b[0m'), '');
  assert.equal(unstyledText('\x1b[38;5;6mhint\x1b[0m typed'), ' typed');
  assert.equal(unstyledText('\x1b[7mx\x1b[0m'), 'x');
});

test('paneInput: the text between the rules after ❯, ignoring suggestions and the status line', () => {
  const screen = ['done', RULE, '❯ walk me\r', RULE, STATUS].join('\n');
  assert.equal(paneInput(screen), 'walk me');
  assert.equal(paneInput(['done', RULE, '❯ \r', RULE, STATUS].join('\n')), '');
  assert.equal(paneInput(['done', RULE, '❯ \x1b[2mTry "fix lint errors"\x1b[0m', RULE].join('\n')), '');
  assert.equal(paneInput(['done', RULE, '❯ first line', '  second line', RULE].join('\n')), 'first line\nsecond line');
  assert.equal(paneInput('no input box here'), '');
});

test('paneInput: a prompt option after a rule is not input', () => {
  assert.equal(paneInput([RULE, '❯ 1. Yes', '  2. No', RULE].join('\n')), '');
  assert.equal(hasInputBox([RULE, '❯ ', RULE].join('\n')), true, 'an empty box is still a box');
  assert.equal(hasInputBox(['Resuming conversation…', ''].join('\n')), false, 'not drawn yet');
});

test('panePrompt: a question with described options and an option after a rule', () => {
  const screen = [
    '  5. A numbered step in Claude’s own reply',
    '─'.repeat(40),
    '←  ☐ Window  ☐ Scope  ✔ Submit  →',
    '',
    '│ Which window should the check use?',
    '',
    '❯ 1. Seven days (Recommended)',
    '     Uses the cached data.',
    '  2. Fourteen days',
    '     Slower to warm.',
    '  3. Type something.',
    '─'.repeat(40),
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  assert.deepEqual(panePrompt(screen), {
    question: 'Which window should the check use?',
    options: [
      { key: '1', label: 'Seven days (Recommended)' },
      { key: '2', label: 'Fourteen days' },
      { key: '3', label: 'Type something.', free: true, typed: '' },
      { key: '4', label: 'Chat about this' },
    ],
    focused: '1',
  });
});

test('panePrompt: the free-text option holds what has been typed into it, and the ❯ marks the focused option', () => {
  const screen = [
    '│ Which branch should get the prevention fix?',
    '',
    '  1. Main only (Recommended)',
    '     v6.6 replaces the v6.5 ShiftController anyway.',
    '  2. v6.5 then forward-merge',
    '❯ 3. on v6.5, but only the lock',
    '─'.repeat(40),
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in VS Code · Esc to cancel',
  ].join('\n');
  assert.deepEqual(panePrompt(screen), {
    question: 'Which branch should get the prevention fix?',
    options: [
      { key: '1', label: 'Main only (Recommended)' },
      { key: '2', label: 'v6.5 then forward-merge' },
      { key: '3', label: 'on v6.5, but only the lock', free: true, typed: 'on v6.5, but only the lock' },
      { key: '4', label: 'Chat about this' },
    ],
    focused: '3',
  });
});

test('panePrompt: a question wrapped over several lines is read whole', () => {
  const screen = [
    '←  ☒ Ordering  ☒ Setup  ☐ Ticket  ✔ Submit  →',
    '',
    '│ Should I also update the ticket : add the metric-name removal to its In scope list and assign',
    '│ it to you?',
    '',
    '❯ 1. Update scope + assign me',
    '  2. Leave it alone',
    '  3. Type something.',
    '─'.repeat(40),
    '  4. Chat about this',
  ].join('\n');
  assert.equal(panePrompt(screen).question, 'Should I also update the ticket : add the metric-name removal to its In scope list and assign it to you?');
});

test('panePrompt: an option too long for the pane is read whole; a description below a short one is not part of it', () => {
  const width = 50;
  const screen = [
    '─'.repeat(width),
    ' Read file',
    '',
    ' Allow this read outside the working directories?',
    '',
    ' ❯ 1. Yes, but ask again next time',
    '   2. Yes, and keep allowing any reads outside the',
    '      working directories this session',
    '   3. No, and block reads outside the working',
    '      directories',
    '   4. No, and ask again next time',
    '      Claude stops and waits.',
    '',
    ' Esc to cancel',
  ].join('\n');
  assert.ok(screen.split('\n').every((line) => line.length <= width));
  assert.deepEqual(panePrompt(screen).options, [
    { key: '1', label: 'Yes, but ask again next time' },
    { key: '2', label: 'Yes, and keep allowing any reads outside the working directories this session' },
    { key: '3', label: 'No, and block reads outside the working directories' },
    { key: '4', label: 'No, and ask again next time' },
  ]);
});

test('panePrompt: a multi-select question reads its ticks and its Next', () => {
  const screen = [
    '←  ☒ Merge  ☐ Pages  ✔ Submit  →',
    '',
    '│ Which merges should I go ahead with?',
    '',
    '❯ 1. [✔] First merge',
    '         Joins two pages.',
    '  2. [ ] Second merge',
    '  3. [ ] Type something',
    '     Next',
    '─'.repeat(40),
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  assert.deepEqual(panePrompt(screen), {
    question: 'Which merges should I go ahead with?',
    options: [
      { key: '1', label: 'First merge', checked: true },
      { key: '2', label: 'Second merge', checked: false },
      { key: '3', label: 'Type something', checked: false },
      { key: '4', label: 'Chat about this' },
    ],
    focused: '1',
    submit: 'Next',
  });
});

test('panePrompt: a lone multi-select question offers Submit', () => {
  const screen = [
    '│ Which plan should I follow?',
    '',
    '❯ 1. [ ] First plan',
    '  2. [✔] Second plan',
    '  3. [ ] Type something',
    '     Submit',
    '─'.repeat(40),
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  assert.equal(panePrompt(screen).submit, 'Submit');
});

test('panePrompt: a boxed permission request', () => {
  const screen = [
    '╭──────────────────────────────╮',
    '│ Bash command                 │',
    '│                              │',
    '│   pnpm test                  │',
    '│                              │',
    '│ Do you want to proceed?      │',
    '│ ❯ 1. Yes                     │',
    '│   2. No, and tell Claude     │',
    '╰──────────────────────────────╯',
  ].join('\n');
  assert.deepEqual(panePrompt(screen), {
    question: 'Do you want to proceed?',
    options: [
      { key: '1', label: 'Yes' },
      { key: '2', label: 'No, and tell Claude' },
    ],
    focused: '1',
  });
});

test('panePrompt: null without a run of options starting at 1', () => {
  assert.equal(panePrompt('just text\n'), null);
  assert.equal(panePrompt('  3. a step\n  4. another\n'), null);
  assert.equal(panePrompt(['  1. a step in a reply', '  2. another', ...Array(10).fill('more reply'), '❯ ', ''].join('\n')), null);
});

test('stripAnsi: removes colour and OSC sequences', () => {
  assert.equal(stripAnsi('\x1b[0m\x1b[38;2;1;2;3mhi\x1b[0m\x1b]8;;http://x\x07link\x1b]8;;\x07'), 'hilink');
});

test('sessionTitle: the latest /rename title over the generated one, read incrementally', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-view-'));
  try {
    mkdirSync(path.join(dir, 'proj'));
    const file = path.join(dir, 'proj', 'sess-title.jsonl');
    const record = (value) => JSON.stringify(value) + '\n';
    writeFileSync(file, '');
    assert.equal(sessionTitle('sess-title', dir), null);
    appendFileSync(file, record({ type: 'user', message: { content: 'hi' } }) + record({ type: 'ai-title', aiTitle: 'Fix target lines' }));
    assert.equal(sessionTitle('sess-title', dir), 'Fix target lines');
    appendFileSync(file, record({ type: 'ai-title', aiTitle: 'Fix target line units' }) + '{"type":"custom-title","custo');
    assert.equal(sessionTitle('sess-title', dir), 'Fix target line units');
    appendFileSync(file, 'mTitle":"target lines"}\n' + record({ type: 'ai-title', aiTitle: 'Later generated title' }));
    assert.equal(sessionTitle('sess-title', dir), 'target lines');
    assert.equal(sessionTitle('no-such-session', dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usageLimit: Claude Code's limit line from the screen, until Claude replies again below it", () => {
  const limit = ['⏺ Adding the delete button now.', '', '  ⎿  \x1b[31mYou\'ve hit your session limit · resets 3:45pm\x1b[0m', '     /upgrade to increase your usage limit.', '', RULE, '❯ ', RULE, STATUS];
  assert.equal(usageLimit(limit.join('\n')), "You've hit your session limit · resets 3:45pm");
  assert.equal(usageLimit(['│ You’ve hit your weekly limit · resets Nov 20, 9am (Europe/London)   │'].join('\n')), 'You’ve hit your weekly limit · resets Nov 20, 9am (Europe/London)');
  assert.equal(usageLimit([...limit.slice(0, 4), '> carry on', '⏺ Done: the button is there.', RULE, '❯ ', RULE].join('\n')), null);
  assert.equal(usageLimit(['⏺ All done.', RULE, '❯ ', RULE, STATUS].join('\n')), null);
});
