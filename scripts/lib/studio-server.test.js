'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { mkdtempSync, rmSync, writeFileSync } = fs;
const os = require('node:os');
const path = require('node:path');

const { appAgents, artifactFile, artifactShotArgs, actionRecord, checkInListener, cleanTranscript, freeTextKeys, inApp, isLocalHost, jobScript, keepDrawing, keepUpload, mayRunJobs, mergeUiPrefs, notePageContext, pausedOffers, recordingDir, servedArtifact, streamJob, suspectTranscript, takeRestoredInput, tabState, updateListener, wavStats } = require('./studio-server');

test('isLocalHost: localhost and 127.0.0.1 only, so a rebound DNS name is refused', () => {
  assert.ok(isLocalHost('localhost'));
  assert.ok(isLocalHost('localhost:4000'));
  assert.ok(isLocalHost('127.0.0.1:4000'));
  assert.ok(!isLocalHost('app.localhost'));
  assert.ok(!isLocalHost('evil.example'));
  assert.ok(!isLocalHost('localhost.evil.example'));
  assert.ok(!isLocalHost(undefined));
});

test('mayRunJobs: needs the custom header and a localhost origin when there is one', () => {
  assert.ok(mayRunJobs({ 'x-studio': '1', origin: 'http://localhost:4000' }));
  assert.ok(mayRunJobs({ 'x-studio': '1' }));
  assert.ok(!mayRunJobs({ origin: 'http://localhost:4000' }));
  assert.ok(!mayRunJobs({ 'x-studio': '1', origin: 'https://evil.example' }));
  assert.ok(!mayRunJobs({ 'x-studio': '1', origin: 'http://localhost.evil.example' }));
});

test('artifactFile: serves the index and snapshots from the worktree folder, nothing outside it', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-artifact-folder-'));
  fs.mkdirSync(path.join(folder, 'snapshots', 'a', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), 'index');
  fs.writeFileSync(path.join(folder, 'snapshots', 'a', 'v1', 'index.html'), 'snap');
  fs.writeFileSync(path.join(path.dirname(folder), 'secret.txt'), 'no');
  assert.equal(artifactFile(folder, ''), path.join(folder, 'index.html'));
  assert.equal(artifactFile(folder, 'snapshots/a/v1/index.html'), path.join(folder, 'snapshots', 'a', 'v1', 'index.html'));
  assert.equal(artifactFile(folder, '../secret.txt'), null);
  assert.equal(artifactFile(folder, '/../../etc/passwd'), null);
  assert.equal(artifactFile(folder, 'snapshots/missing.html'), null);
  assert.equal(artifactFile(folder, 'snapshots'), null);
});

test('freeTextKeys: arrows to the free-text option from the focused one, then clears what it holds', () => {
  const prompt = { options: [{ key: '1' }, { key: '2' }, { key: '3', free: true, typed: '' }, { key: '4' }], focused: '1' };
  assert.deepEqual(freeTextKeys(prompt, '3'), ['down', 'down']);
  assert.deepEqual(freeTextKeys({ ...prompt, focused: '4', options: prompt.options.map((o) => (o.free ? { ...o, typed: 'ab' } : o)) }, '3'), ['up', 'backspace', 'backspace']);
  assert.deepEqual(freeTextKeys({ ...prompt, focused: '3' }, '3'), []);
  assert.equal(freeTextKeys(prompt, '2'), null);
  assert.equal(freeTextKeys({ ...prompt, focused: null }, '3'), null);
});

test('takeRestoredInput: clears the message an interrupt put back and returns it; empty when none shows', async () => {
  const reads = ['', 'hello there'];
  const sent = [];
  assert.equal(await takeRestoredInput('p', 2000, () => reads.shift() ?? '', (...keys) => sent.push(...keys)), 'hello there');
  assert.equal(sent.length, 'hello there'.length + 20);
  assert.ok(sent.every((key) => key === 'backspace'));
  const none = [];
  assert.equal(await takeRestoredInput('p', 300, () => '', (...keys) => none.push(...keys)), '');
  assert.deepEqual(none, []);
});

test('servedArtifact: an HTML page gets the script that opens other sites in a new tab; other files are untouched', () => {
  const page = servedArtifact(Buffer.from('<html><body><a href="https://example.com/x">x</a></body></html>'), 'page.html').toString();
  assert.ok(page.startsWith('<html><body><a href="https://example.com/x">x</a></body></html>'));
  assert.match(page, /<script>[\s\S]*defaultPrevented[\s\S]*_blank[\s\S]*<\/script>\n$/);
  const css = Buffer.from('a { color: red }');
  assert.equal(servedArtifact(css, 'style.css'), css);
});

test('servedArtifact: an HTML page gets the pick tool, which only answers its parent and posts what was clicked', () => {
  const page = servedArtifact(Buffer.from('<p>x</p>'), 'page.html').toString();
  assert.match(page, /event\.source === parent[\s\S]*studio-pick/);
  assert.match(page, /type: 'studio-picked', selector: selectorOf\(el\)/);
  assert.match(page, /type: 'studio-pick-toggle'/);
  assert.match(page, /type: 'studio-pane-key', key: event\.key/);
  assert.match(page, /type: 'studio-diff-result'/);
  assert.match(page, /type: 'studio-space', repeat: event.repeat/);
  assert.match(page, /type: 'studio-note-close', nid: note.nid/);
  assert.match(page, /type: 'studio-clicked'/);
});

test('servedArtifact: an HTML page reports its scroll position to its parent, and scrolls where its parent says', () => {
  const page = servedArtifact(Buffer.from('<p>x</p>'), 'page.html').toString();
  assert.match(page, /postMessage\(\{ type: 'studio-scroll', y: scrollY \}/);
  assert.match(page, /event\.source === parent && event\.data && event\.data\.type === 'studio-scroll-to'/);
});

test("servedArtifact: a Google Fonts stylesheet stops blocking the first paint, so the page shows offline in its fallback fonts", () => {
  const link = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces&display=swap">';
  const page = servedArtifact(Buffer.from(link + '<style>a{}</style>'), 'index.html').toString();
  assert.ok(page.startsWith('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces&display=swap" media="print" onload="this.media=\'all\'">'));
  const own = '<link rel="stylesheet" href="style.css">';
  assert.ok(servedArtifact(Buffer.from(own), 'index.html').toString().startsWith(own));
  const already = '<link rel="stylesheet" media="screen" href="https://fonts.googleapis.com/css2?family=X">';
  assert.ok(servedArtifact(Buffer.from(already), 'index.html').toString().startsWith(already));
});

test('tabState: Claude reports itself; otherwise running while anything but a shell is in the foreground', () => {
  assert.equal(tabState({}, { agent: 'claude', agent_status: 'working' }, []), 'claude-working');
  assert.equal(tabState({}, { agent: 'claude', agent_status: 'idle' }, []), 'claude-idle');
  assert.equal(tabState({}, { agent: 'claude', agent_status: 'blocked' }, []), 'claude-blocked');
  assert.equal(tabState({}, { agent: 'claude', agent_status: 'done' }, []), 'claude-done');
  assert.equal(tabState({}, { agent: 'claude', agent_status: 'unknown' }, []), 'claude-idle');
  assert.equal(tabState({}, {}, ['zsh', 'bash', 'sleep']), 'running');
  assert.equal(tabState({}, {}, ['zsh']), 'idle');
  assert.equal(tabState({}, undefined, []), 'idle');
});

test('pausedOffers: a dismissed session is dropped, even one whose pane the reaper closed', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const closed = [
    { cwd: '/code/app', session_id: 'gone', resume: 'claude --resume gone', ts: '2026-01-01T10:00:00Z', how: 'closed', pane_id: 'w1:p9', tab_id: 'w1:t9' },
    { cwd: '/code/app', session_id: 'gone', ts: '2026-01-01T11:00:00Z', how: 'dismissed' },
  ];
  assert.deepEqual(pausedOffers(closed, '/code/app', new Set(), new Set(), now), []);
});

test("pausedOffers: the app's stopped sessions, not another folder's, and not once running again", () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const closed = [
    { cwd: '/code/app/server', session_id: 'a', resume: 'claude --resume a', ts: '2026-01-01T10:00:00Z', how: 'stopped', by: 'reaper', pane_id: 'w1:p1', tab_id: 'w1:t1' },
    { cwd: '/code/app-other', session_id: 'b', resume: 'claude --resume b', ts: '2026-01-01T11:00:00Z', how: 'stopped', pane_id: 'w2:p1', tab_id: 'w2:t1' },
  ];
  const live = new Set(['w1:p1', 'w2:p1']);

  assert.deepEqual(pausedOffers(closed, '/code/app', new Set(), live, now), [{ sessionId: 'a', ts: '2026-01-01T10:00:00Z', how: 'stopped', by: 'reaper', paneId: 'w1:p1', tabId: 'w1:t1' }]);
  assert.deepEqual(pausedOffers(closed, '/code/app', new Set(['a']), live, now), []);
});

test('pausedOffers: closing the tab a session was stopped in dismisses it, unless the reaper closed that pane itself', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const closed = [
    { cwd: '/code/app', session_id: 'gone', resume: 'claude --resume gone', ts: '2026-01-01T10:00:00Z', how: 'stopped', pane_id: 'w1:p1', tab_id: 'w1:t1' },
    { cwd: '/code/app', session_id: 'reaped', resume: 'claude --resume reaped', ts: '2026-01-01T11:00:00Z', how: 'closed', pane_id: 'w1:p2', tab_id: 'w1:t2' },
  ];

  assert.deepEqual(pausedOffers(closed, '/code/app', new Set(), new Set(), now).map((o) => o.sessionId), ['reaped']);
});

test('inApp: the app folder and anything inside it, not a sibling that shares its prefix', () => {
  assert.ok(inApp('/code/app', '/code/app'));
  assert.ok(inApp('/code/app/web', '/code/app'));
  assert.ok(!inApp('/code/app-other', '/code/app'));
  assert.ok(!inApp('', '/code/app'));
});

test('appAgents: the Claude panes working in the app, most urgent first, with their tab', () => {
  const snapshot = {
    tabs: [{ tab_id: 'w1:t1', label: 'Claude' }, { tab_id: 'w1:t2', label: '2' }],
    panes: [
      { pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', agent_status: 'idle', cwd: '/code/app', agent_session: { value: 's1' } },
      { pane_id: 'w1:p2', tab_id: 'w1:t2', agent: 'claude', agent_status: 'blocked', foreground_cwd: '/code/app/web', agent_session: { value: 's2' } },
      { pane_id: 'w1:p3', tab_id: 'w1:t2', agent: 'claude', agent_status: 'working', cwd: '/elsewhere' },
      { pane_id: 'w1:p4', tab_id: 'w1:t2', cwd: '/code/app' },
    ],
  };
  assert.deepEqual(appAgents(snapshot, '/code/app'), [
    { paneId: 'w1:p2', tabId: 'w1:t2', tab: '2', status: 'blocked', commands: [], sessionId: 's2' },
    { paneId: 'w1:p1', tabId: 'w1:t1', tab: 'Claude', status: 'idle', commands: [], sessionId: 's1' },
  ]);
});

test('jobScript: Claude sessions and the artifact index run in the quoted app folder; ids must have their own shape', () => {
  assert.equal(jobScript('claude-start', { appDir: "/a b/it's" }), "claude-reaper.sh start '/a b/it'\\''s'");
  assert.equal(jobScript('claude-start', { appDir: '/app', message: 'make it\nblue' }), "claude-reaper.sh start /app --message 'make it blue'");
  assert.equal(jobScript('artifact-consolidate', { appDir: '/app' }), "artifact-index-in-herdr.sh --consolidate /app");
  assert.throws(() => jobScript('resume', { appDir: '/app', sessionId: 'x; rm -rf ~' }));
  assert.throws(() => jobScript('stop-session', { appDir: '/app', paneId: 'nope' }));
  assert.throws(() => jobScript('switch', { appDir: '/app' }));
});

test('streamJob: ends once the job exits, even when a process it left running still holds its output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-stream-job-'));
  process.env.STUDIO_LOG_DIR = dir;
  let out = '';
  const ended = new Promise((resolve) => {
    const res = { writeHead: () => {}, write: (chunk) => (out += chunk), end: (chunk) => resolve(out + chunk) };
    streamJob(res, 'stream-job-test', 'echo started; sleep 30 & echo backgrounded', dir);
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('job never ended')), 5000).unref());
  try {
    const text = await Promise.race([ended, timeout]);
    assert.match(text, /started\nbackgrounded\n/);
    assert.match(text, /\[done\]\n$/);
  } finally {
    delete process.env.STUDIO_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('actionRecord: who sent an action, what it acted on (not its message), and how it went', () => {
  const req = { url: '/_env/api/run', headers: { 'x-studio-source': 'cockpit / Artifacts' }, studioBody: JSON.stringify({ label: 'app', action: 'claude-start', message: 'a long prompt', extra: { x: 1 } }) };
  const job = { studioActionId: 'abc123', studioJob: 'app', studioExit: 1, statusCode: 200, writableFinished: true };
  assert.deepEqual(actionRecord(req, job, 1_000, 3_500), {
    ts: new Date(1_000).toISOString(),
    id: 'abc123',
    source: 'cockpit / Artifacts',
    endpoint: '/run',
    label: 'app',
    action: 'claude-start',
    job: 'app',
    status: 200,
    exit: 1,
    ms: 2_500,
  });
  // No id or body (an old page, a request turned away before its body was read), and the page gone before the answer.
  assert.deepEqual(actionRecord({ url: '/_env/api/close-tab', headers: {} }, { statusCode: 403, writableFinished: false }, 0, 10), {
    ts: new Date(0).toISOString(),
    id: null,
    source: null,
    endpoint: '/close-tab',
    status: 403,
    aborted: true,
    ms: 10,
  });
});

test('notePageContext: the page context reaches the next prompt in that pane once (hooks/studio-hook.py prompt-submit)', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'studio-page-context-'));
  try {
    notePageContext('w1:p2', 'The todo page', path.join(home, '.claude', 'state', 'page-context'));
    const prompt = (pane) =>
      execFileSync('python3', ['-I', path.join(__dirname, '../../hooks/studio-hook.py'), 'prompt-submit'], {
        input: JSON.stringify({ session_id: 's-1', prompt: 'make it blue' }),
        env: { ...process.env, HOME: home, HERDR_PANE_ID: pane },
        encoding: 'utf8',
      });
    assert.doesNotMatch(prompt('w1:p3'), /todo/);
    assert.match(prompt('w1:p2'), /\[page\] Sent from a page showing: The todo page/);
    assert.doesNotMatch(prompt('w1:p2'), /todo/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mergeUiPrefs: sets the given UI settings over the saved ones, refusing anything but a small plain object', () => {
  assert.deepEqual(mergeUiPrefs({ 'wt:pin:chat': true, 'wt:chatView': 'chat' }, { 'wt:pin:chat': false }), { 'wt:pin:chat': false, 'wt:chatView': 'chat' });
  assert.deepEqual(mergeUiPrefs(undefined, { 'wt:width:chat': 420 }), { 'wt:width:chat': 420 });
  assert.deepEqual(mergeUiPrefs({ a: 1 }, undefined), { a: 1 });
  assert.deepEqual(mergeUiPrefs('junk', undefined), {});
  assert.equal(mergeUiPrefs({}, [1]), null);
  assert.equal(mergeUiPrefs({}, 'x'), null);
  assert.equal(mergeUiPrefs({}, { ['k'.repeat(65)]: 1 }), null);
  assert.equal(mergeUiPrefs({}, { big: 'x'.repeat(2000) }), null);
});

test('one page listens: the last one clicked, unless the owner is mid-recording', () => {
  assert.deepEqual(checkInListener('nobody1', 0), { id: null, stale: true, recording: null, stop: null, result: null });
  assert.equal(updateListener({ id: 'pagea1', claim: true }, 1000).id, 'pagea1');
  assert.equal(updateListener({ id: 'pageb1', claim: true }, 2000).id, 'pageb1', 'a click elsewhere moves the mic');
  assert.equal(updateListener({ id: 'pagea1', recording: { startedAt: 2500 } }, 2500).recording, null, 'only the owner records');
  const rec = updateListener({ id: 'pageb1', recording: { startedAt: 3000, where: 'shared-main', url: 'http://shared-main.localhost/_env/wt' } }, 3000).recording;
  assert.deepEqual(rec, { startedAt: 3000, where: 'shared-main', url: 'http://shared-main.localhost/_env/wt' });
  assert.equal(updateListener({ id: 'pagea1', claim: true }, 4000).id, 'pageb1', 'a recording keeps the mic while you look at other cockpits');
  assert.deepEqual(updateListener({ id: 'pageb1', recording: false }, 4000).recording, rec, 'a page on the old version can\'t end it');
  assert.deepEqual(checkInListener('pagea1', 4000).recording, rec, 'every page sees the recording');
  assert.equal(checkInListener('pageb1', 60_000).stale, false);
  assert.equal(updateListener({ id: 'pagea1', claim: true }, 60_000 + 90_001).id, 'pagea1', 'an owner silent for 90s has gone, recording or not');
  assert.equal(updateListener({ id: 'pageb1', release: true }, 200_000).id, 'pagea1', 'only the owner can let go');
  assert.equal(updateListener({ id: 'pagea1', release: true }, 200_000).id, null);
});

test('a recording is stopped from any page, and its text goes to that page', () => {
  updateListener({ id: 'recorder', claim: true }, 0);
  updateListener({ id: 'recorder', recording: { startedAt: 0, where: 'a', url: 'http://a.localhost/_env/wt' } }, 0);
  assert.equal(updateListener({ id: 'elsewhere', stop: 'send' }, 1000).stop, null, 'a stop is for the owner to see');
  assert.deepEqual(checkInListener('recorder', 1300).stop, { how: 'send', to: 'elsewhere' });
  updateListener({ id: 'recorder', result: { to: 'elsewhere', text: 'hello', send: true } }, 1600);
  assert.equal(checkInListener('recorder', 1600).result, null, 'the text is only for the page that stopped it');
  assert.deepEqual(checkInListener('elsewhere', 1900).result, { text: 'hello', send: true, error: null });
  assert.equal(checkInListener('elsewhere', 2200).result, null, 'handed over once');
  assert.equal(checkInListener('recorder', 2200).recording, null, 'the recording is over');
  assert.equal(updateListener({ id: 'elsewhere', stop: 'send' }, 2500).stop, null, 'nothing to stop');
  updateListener({ id: 'recorder', recording: { startedAt: 3000 } }, 3000);
  updateListener({ id: 'recorder', result: { to: 'gone', text: 'late' } }, 3000);
  assert.equal(checkInListener('gone', 3000 + 60_001).result, null, 'text nobody collects within a minute is dropped');
  updateListener({ id: 'recorder', release: true }, 70_000);
});

test('suspectTranscript: text with no letters or digits, such as a lone dash, but not an empty one', () => {
  assert.equal(suspectTranscript('-'), true);
  assert.equal(suspectTranscript('...'), true);
  assert.equal(suspectTranscript(''), false);
  assert.equal(suspectTranscript('Hello -'), false);
  assert.equal(suspectTranscript('42'), false);
});

test('wavStats: length and loudness of a 16 kHz 16-bit WAV', () => {
  const audio = Buffer.alloc(44 + 16000 * 2);
  audio.writeInt16LE(0x7fff, 44);
  const stats = wavStats(audio);
  assert.equal(stats.seconds, 1);
  assert.equal(stats.peak, 1);
  assert.ok(stats.rms > 0 && stats.rms < 0.01);
});

test('recordingDir: a folder per recording, named by its start; unknown without one', () => {
  assert.equal(path.basename(recordingDir(1763000000000)), '2025-11-13T02-13-20-000Z');
  assert.equal(path.basename(recordingDir(undefined)), 'unknown');
  assert.equal(path.basename(recordingDir('../x')), 'unknown');
});

test('cleanTranscript: one line, without dialogue dashes, noise marks or a stray leading "."', () => {
  assert.equal(cleanTranscript(' Okay so\n- it works.\n [BLANK_AUDIO]\n'), 'Okay so it works.');
  assert.equal(cleanTranscript('. Alright, let us start.'), 'Alright, let us start.');
  assert.equal(cleanTranscript('-\n'), '-');
  assert.equal(cleanTranscript('...'), '...');
});

test('keepDrawing: a PNG per drawing under its worktree, the newest 50 kept; not a PNG or a bad label is refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-drawings-'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('ink')]);
  try {
    const file = keepDrawing('6108', png, dir, 1763000000000);
    assert.equal(file, path.join(dir, '6108', '2025-11-13T02-13-20-000Z.png'));
    assert.deepEqual(fs.readFileSync(file), png);
    for (let i = 1; i <= 50; i++) keepDrawing('6108', png, dir, 1763000000000 + i * 1000);
    const kept = fs.readdirSync(path.join(dir, '6108'));
    assert.equal(kept.length, 50);
    assert.ok(!kept.includes('2025-11-13T02-13-20-000Z.png'));
    assert.equal(keepDrawing('6108', Buffer.from('<svg/>'), dir), null);
    assert.equal(keepDrawing('../etc', png, dir), null);
    assert.equal(keepDrawing(null, png, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifactShotArgs: headless Chrome at the pane size and scale, scrolled by the page itself, dark when asked; anything out of range is refused', () => {
  const args = artifactShotArgs({ id: 'abc_D-1', v: '3', y: '420', w: '800', h: '600', scale: '2', dark: '1' }, '/tmp/x/shot.png', '/tmp/x/profile');
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes('--window-size=800,600'));
  assert.ok(args.includes('--force-device-scale-factor=2'));
  assert.ok(args.includes('--force-dark-mode'));
  assert.ok(args.includes('--screenshot=/tmp/x/shot.png'));
  assert.ok(args.includes('--user-data-dir=/tmp/x/profile'));
  assert.match(args.at(-1), /^http:\/\/localhost:\d+\/_env\/artifact\/abc_D-1\/v3\/#studio-y=420$/);
  assert.ok(!artifactShotArgs({ id: 'a', v: '1', y: '0', w: '10', h: '10', scale: '1.5' }, 'o', 'p').includes('--force-dark-mode'));
  const ok = { id: 'a', v: '1', y: '0', w: '10', h: '10', scale: '1' };
  for (const bad of [{ id: '../x' }, { v: '-1' }, { y: '1e3' }, { w: '0' }, { h: '9000' }, { scale: '0.5' }, { scale: '5' }, { id: undefined }]) assert.equal(artifactShotArgs({ ...ok, ...bad }, 'o', 'p'), null, JSON.stringify(bad));
});

test('keepUpload: a dropped file under its worktree with a safe name, the newest 50 kept; a bad label or no name is refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-uploads-'));
  const bytes = Buffer.from('shot');
  try {
    const file = keepUpload('6108', 'Screenshot 2026-11-15 at 18.40.12 PM.png', bytes, dir, 1763000000000);
    assert.equal(file, path.join(dir, '6108', '2025-11-13T02-13-20-000Z-Screenshot 2026-11-15 at 18.40.12_PM.png'));
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(path.dirname(keepUpload('6108', '../../etc/passwd', bytes, dir)), path.join(dir, '6108'));
    for (let i = 1; i <= 50; i++) keepUpload('6108', 'a.txt', bytes, dir, 1763000000000 + i * 1000);
    const kept = fs.readdirSync(path.join(dir, '6108'));
    assert.equal(kept.length, 50);
    assert.ok(!kept.some((name) => name.startsWith('2025-11-13T02-13-20-000Z-')));
    assert.equal(keepUpload('../etc', 'a.txt', bytes, dir), null);
    assert.equal(keepUpload(null, 'a.txt', bytes, dir), null);
    assert.equal(keepUpload('6108', '', bytes, dir), null);
    assert.equal(keepUpload('6108', '..', bytes, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A free localhost port, for a server a test starts. */
const freePort = () =>
  new Promise((resolve) => {
    const probe = require('node:net').createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Runs the studio server with `home` as STUDIO_HOME and Whisper on `whisperPort`, until `use(post)` is done. */
const withServer = async (home, whisperPort, use) => {
  const port = await freePort();
  const server = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'studio-server.js')], { env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: String(port), STUDIO_WHISPER_PORT: String(whisperPort), STUDIO_WHISPER_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((resolve) => server.stderr.on('data', (chunk) => String(chunk).includes('studio server on') && resolve()));
    const post = async (endpoint, body, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/_env/api/${endpoint}`, { method: 'POST', headers: { 'X-Studio': '1', ...headers }, body });
      return { status: res.status, json: await res.json() };
    };
    await use(post);
  } finally {
    server.kill();
  }
};

test('transcribe: Whisper on STUDIO_WHISPER_PORT gives the text; no clip is kept unless keepDictationClips is set', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'studio-dictation-'));
  const whisper = require('node:http').createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: ' Add a button.\n' })));
  });
  await new Promise((resolve) => whisper.listen(0, '127.0.0.1', resolve));
  const recording = { 'Content-Type': 'audio/wav', 'X-Studio-Recording': JSON.stringify({ startedAt: 1763000000000, segment: 0 }) };
  const dictation = path.join(home, 'logs', 'dictation');
  try {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ appDir: home }));
    await withServer(home, whisper.address().port, async (post) => {
      assert.deepEqual(await post('transcribe', Buffer.alloc(100), recording), { status: 200, json: { text: 'Add a button.' } });
      assert.equal((await post('dictation-log', JSON.stringify({ startedAt: 1763000000000, text: 'Add a button.' }))).status, 200);
      assert.ok(!fs.existsSync(dictation));
      writeFileSync(path.join(home, 'config.json'), JSON.stringify({ appDir: home, keepDictationClips: true }));
      assert.equal((await post('transcribe', Buffer.alloc(100), recording)).status, 200);
      assert.equal((await post('dictation-log', JSON.stringify({ startedAt: 1763000000000 }))).status, 200);
      assert.deepEqual(fs.readdirSync(path.join(dictation, recordingDir(1763000000000).split(path.sep).at(-1))).sort(), ['00.json', '00.wav', 'summary.json']);
    });
  } finally {
    whisper.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("transcribe: when Whisper isn't running, the chat is told so in plain words", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'studio-dictation-'));
  try {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ appDir: home }));
    await withServer(home, await freePort(), async (post) => {
      const { status, json } = await post('transcribe', Buffer.alloc(100), { 'Content-Type': 'audio/wav' });
      assert.equal(status, 502);
      assert.match(json.error, /Whisper.*isn't running.*studio up/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
