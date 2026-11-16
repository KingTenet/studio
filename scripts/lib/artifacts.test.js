'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addNote, describe, folderFor, locate, markBuilt, pageTitle, planName, publishesIn, readRegistry, record, remove, removeNote, supersede, worktreeOf } = require('./artifacts');

let repo;
let scratch;

beforeEach(() => {
  process.env.STUDIO_ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-artifacts-store-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-artifacts-repo-')));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'app'));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-artifacts-scratch-'));
});

const page = (name, title, extra = '') => {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, `<!doctype html><html><head><title>${title}</title></head><body>${extra}</body></html>`);
  return file;
};

const URL_A = 'https://claude.ai/code/artifact/aaaa-1111';
const URL_B = 'https://claude.ai/code/artifact/bbbb-2222';

test('worktreeOf: a directory inside a git worktree belongs to its top level', () => {
  assert.equal(worktreeOf(path.join(repo, 'app')), repo);
});

test('record: files a publish under its worktree with the page title, a version and a snapshot', () => {
  const file = page('recording.html', 'Throughput recording');
  fs.writeFileSync(path.join(scratch, 'data.json'), '{"rows":[]}');
  const entry = record({ sessionId: 's1', cwd: path.join(repo, 'app'), ts: '2026-01-01T10:00:00Z', input: { file_path: file, description: 'A recording', files: { 'data.json': path.join(scratch, 'data.json') } }, response: `Published ${URL_A}` });

  assert.deepEqual({ ...entry, filePath: undefined }, {
    ts: '2026-01-01T10:00:00Z',
    sessionId: 's1',
    toolUseId: null,
    worktree: repo,
    id: 'aaaa-1111',
    url: URL_A,
    version: 1,
    title: 'Throughput recording',
    plan: null,
    description: 'A recording',
    filePath: undefined,
    snapshot: path.join('snapshots', 'aaaa-1111', 'v1'),
    files: ['index.html', 'data.json'],
  });
  const snap = path.join(folderFor(repo), entry.snapshot);
  assert.match(fs.readFileSync(path.join(snap, 'index.html'), 'utf8'), /Throughput recording/);
  assert.equal(fs.readFileSync(path.join(snap, 'data.json'), 'utf8'), '{"rows":[]}');
});

test('record: a republish of the same artifact is its next version', () => {
  const file = page('a.html', 'A');
  record({ sessionId: 's1', cwd: repo, ts: 't1', input: { file_path: file }, response: URL_A });
  const second = record({ sessionId: 's2', cwd: repo, ts: 't2', input: { file_path: file }, response: URL_A });
  assert.equal(second.version, 2);
  assert.equal(second.sessionId, 's2');
});

test('record: leaves out reads, asset uploads, results without a url, repeats and the index itself', () => {
  const file = page('a.html', 'A');
  assert.equal(record({ sessionId: 's', cwd: repo, input: { action: 'read', url: URL_A } }), null);
  assert.equal(record({ sessionId: 's', cwd: repo, input: { file_path: file, asset: true, url: URL_A }, response: URL_A }), null);
  assert.equal(record({ sessionId: 's', cwd: repo, input: { file_path: file }, response: 'refused' }), null);
  record({ sessionId: 's', cwd: repo, ts: 't1', input: { file_path: file }, response: URL_A });
  assert.equal(record({ sessionId: 's', cwd: repo, ts: 't1', input: { file_path: file }, response: URL_A }), null);
  fs.mkdirSync(folderFor(repo), { recursive: true });
  const index = path.join(folderFor(repo), 'index.html');
  fs.writeFileSync(index, '<title>Index</title>');
  assert.equal(record({ sessionId: 's', cwd: repo, input: { file_path: index }, response: URL_B }), null);
  assert.equal(readRegistry(folderFor(repo)).length, 1);
});

test('record: the hook and the backfill recording the same call file it once', () => {
  const file = page('a.html', 'A');
  record({ sessionId: 's', toolUseId: 'toolu_1', cwd: repo, ts: '2026-01-01T10:00:05Z', input: { file_path: file }, response: URL_A });
  assert.equal(record({ sessionId: 's', toolUseId: 'toolu_1', cwd: repo, ts: '2026-01-01T10:00:00Z', input: { file_path: file }, response: URL_A }), null);
});

test('record: a supporting file that would land outside the snapshot is not copied', () => {
  const file = page('a.html', 'A');
  const entry = record({ sessionId: 's', cwd: scratch, ts: 't1', input: { file_path: file, files: { '../../escape.txt': file } }, response: URL_A });
  assert.deepEqual(entry.files, ['index.html']);
});

test('publishesIn: pairs each publish in a transcript with the result carrying its url', () => {
  const transcript = path.join(scratch, 's.jsonl');
  const lines = [
    { sessionId: 's1', cwd: repo, timestamp: 't1', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Artifact', input: { file_path: '/x/a.html' } }] } },
    { sessionId: 's1', cwd: repo, timestamp: 't1', message: { content: [{ type: 'tool_use', id: 'u2', name: 'Artifact', input: { action: 'list' } }] } },
    { sessionId: 's1', cwd: repo, timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'Published ' + URL_A }] }] } },
    { sessionId: 's1', cwd: repo, timestamp: 't3', message: { content: [{ type: 'tool_use', id: 'u3', name: 'Artifact', input: { file_path: '/x/b.html' } }] } },
    { sessionId: 's1', cwd: repo, timestamp: 't3', message: { content: [{ type: 'tool_result', tool_use_id: 'u3', is_error: true, content: 'refused' }] } },
  ];
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const found = publishesIn(transcript);
  assert.equal(found.length, 1);
  assert.equal(found[0].input.file_path, '/x/a.html');
  assert.match(JSON.stringify(found[0].response), /aaaa-1111/);
});

test('publishesIn: a call kept only as a copy without a cwd takes it from its result', () => {
  const transcript = path.join(scratch, 'blob.jsonl');
  const lines = [
    { type: 'api-request-blob', sessionId: 's1', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Artifact', input: { file_path: '/x/a.html' } }] } },
    { type: 'user', sessionId: 's1', cwd: repo, timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: URL_A }] } },
  ];
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  assert.deepEqual(publishesIn(transcript).map((publish) => [publish.cwd, publish.ts]), [[repo, 't2']]);
});

test('publishesIn: a copy of a call and its result after the real pair is not a second publish', () => {
  const transcript = path.join(scratch, 'dupe.jsonl');
  const use = { type: 'tool_use', id: 'u1', name: 'Artifact', input: { file_path: '/x/a.html' } };
  const result = { type: 'tool_result', tool_use_id: 'u1', content: URL_A };
  const lines = [
    { type: 'assistant', sessionId: 's1', cwd: repo, timestamp: 't1', message: { content: [use] } },
    { type: 'user', sessionId: 's1', cwd: repo, timestamp: 't2', message: { content: [result] } },
    { type: 'api-request-blob', sessionId: 's1', message: { content: [use] } },
    { type: 'api-request-blob', sessionId: 's1', message: { content: [result] } },
  ];
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  assert.deepEqual(publishesIn(transcript).map((publish) => publish.cwd), [repo]);
});

test('describe: groups versions per artifact, names each by its title, and counts publishes since the index', () => {
  const a = page('a.html', 'Alert replay');
  const b = page('b.html', '');
  record({ sessionId: 's1', cwd: repo, ts: '2026-01-01T10:00:00Z', input: { file_path: a }, response: URL_A });
  record({ sessionId: 's1', cwd: repo, ts: '2026-01-01T11:00:00Z', input: { file_path: b, description: 'Untitled notes' }, response: URL_B });
  fs.writeFileSync(path.join(folderFor(repo), 'index.html'), '<title>Index</title>');
  markBuilt(repo, 'https://claude.ai/code/artifact/index-9999');
  record({ sessionId: 's2', cwd: repo, ts: '2026-01-01T12:00:00Z', input: { file_path: a }, response: URL_A });
  supersede(repo, 'aaaa-1111', ['bbbb-2222']);

  const view = describe(repo);
  assert.deepEqual(
    view.artifacts.map((artifact) => [artifact.name, artifact.versions.length, artifact.sessions, artifact.supersededBy]),
    [
      ['Alert replay', 2, ['s1', 's2'], null],
      ['Untitled notes', 1, ['s1'], 'aaaa-1111'],
    ]
  );
  assert.equal(view.index.url, 'https://claude.ai/code/artifact/index-9999');
  assert.equal(view.index.newSince, 1);
});

test('remove: hides an artifact from describe, and a later backfill of the same publish does not bring it back', () => {
  const a = page('a.html', 'Alert replay');
  const b = page('b.html', 'Notes');
  record({ sessionId: 's1', toolUseId: 't1', cwd: repo, ts: '2026-01-01T10:00:00Z', input: { file_path: a }, response: URL_A });
  record({ sessionId: 's1', toolUseId: 't2', cwd: repo, ts: '2026-01-01T11:00:00Z', input: { file_path: b }, response: URL_B });

  remove(repo, ['bbbb-2222']);
  record({ sessionId: 's1', toolUseId: 't2', cwd: repo, ts: '2026-01-01T11:00:00Z', input: { file_path: b }, response: URL_B });

  assert.deepEqual(describe(repo).artifacts.map((artifact) => artifact.id), ['aaaa-1111']);
});

test('pageTitle: the page title, collapsed, or null without one', () => {
  assert.equal(pageTitle('<html><head><title>\n  KPI  drift\n</title>'), 'KPI drift');
  assert.equal(pageTitle('<html>'), null);
});

test('locate: finds an artifact in any worktree by id, with its newest local copy', () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-artifacts-other-')));
  execFileSync('git', ['init', '-q', other]);
  const file = page('a.html', 'Alert replay');
  record({ sessionId: 's1', cwd: other, ts: 't1', input: { file_path: file }, response: URL_A });
  record({ sessionId: 's1', cwd: other, ts: 't2', input: { file_path: path.join(scratch, 'gone.html') }, response: URL_A });
  const found = locate('aaaa-1111');
  const relative = (dir) => dir && path.relative(folderFor(other), dir);
  assert.deepEqual(
    { ...found, folder: relative(found.folder), snapshot: relative(found.snapshot), history: found.history.map((v) => ({ ...v, snapshot: relative(v.snapshot) })) },
    {
      id: 'aaaa-1111',
      folder: '',
      url: URL_A,
      worktree: other,
      name: 'Alert replay',
      versions: 2,
      snapshot: path.join('snapshots', 'aaaa-1111', 'v1'),
      history: [
        { version: 1, ts: 't1', snapshot: path.join('snapshots', 'aaaa-1111', 'v1') },
        { version: 2, ts: 't2', snapshot: null },
      ],
      filePath: path.join(scratch, 'gone.html'),
      plan: null,
      notes: [],
    }
  );
  assert.equal(locate('nope'), null);
});

test('addNote / removeNote: a note is pinned to the latest version, comes back with locate, and can be taken away', () => {
  record({ sessionId: 's1', cwd: repo, ts: 't1', input: { file_path: page('a.html', 'Alert replay') }, response: URL_A });
  record({ sessionId: 's1', cwd: repo, ts: 't2', input: { file_path: page('a.html', 'Alert replay') }, response: URL_A });
  const note = addNote('aaaa-1111', '#tiles > div', 'Weighted by tonnes.', new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(note, { nid: new Date('2026-01-01T00:00:00Z').getTime().toString(36), selector: '#tiles > div', text: 'Weighted by tonnes.', version: 2, at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(locate('aaaa-1111').notes, [note]);
  assert.equal(removeNote('aaaa-1111', 'nope'), false);
  assert.equal(removeNote('aaaa-1111', note.nid), true);
  assert.deepEqual(locate('aaaa-1111').notes, []);
  assert.equal(addNote('nope', 'p', 'x'), null);
});

test('locate: an artifact never copied locally has no snapshot', () => {
  record({ sessionId: 's1', cwd: repo, ts: 't1', input: { file_path: path.join(scratch, 'missing.html'), description: 'Gone' }, response: URL_B });
  assert.equal(locate('bbbb-2222').snapshot, null);
  assert.equal(locate('bbbb-2222').name, 'Gone');
});

test('planName: the feature a plan page is for, from its studio-plan meta, plain and short; null for any other page', () => {
  assert.equal(planName('<head><meta name="studio-plan" content="  Dark   mode &amp; themes "></head>'), 'Dark mode & themes');
  assert.equal(planName("<META content='Recipe search' NAME='studio-plan'/>"), 'Recipe search');
  assert.equal(planName('<meta name="studio-plan" content="' + 'x'.repeat(100) + '">'), 'x'.repeat(80));
  assert.equal(planName('<meta name="studio-plan" content="">'), null);
  assert.equal(planName('<meta name="description" content="A plan">'), null);
  assert.equal(planName(null), null);
});

test("record / locate: a plan's feature name is kept per version, and locate gives the latest local copy's", () => {
  const cwd = path.join(repo, 'app');
  const plan = page('plan.html', 'Plan: dark mode', '');
  fs.writeFileSync(plan, '<html><head><title>Plan</title><meta name="studio-plan" content="Dark mode"></head></html>');
  assert.equal(record({ sessionId: 's1', cwd, ts: '2026-01-01T10:00:00Z', input: { file_path: plan }, response: URL_A }).plan, 'Dark mode');
  assert.equal(locate('aaaa-1111').plan, 'Dark mode');
  // A later version that is no longer a plan isn't one.
  fs.writeFileSync(plan, '<html><head><title>Notes</title></head></html>');
  record({ sessionId: 's1', cwd, ts: '2026-01-01T11:00:00Z', input: { file_path: plan, url: URL_A }, response: URL_A });
  assert.equal(locate('aaaa-1111').plan, null);
});
