'use strict';

/**
 * The studio's local server, at http://localhost:4000: it serves the cockpit page and the API behind it,
 * for one app (config.appDir) and the Claude session working on it in a herdr pane.
 *
 * The API: /_env/api/state (the app, its Claude pane, the feature being built, its versions, the chat's mode and the shared prefs),
 * the end of the app's dev server log (app/log),
 * the chat's Ask / Plan / Build switch (mode),
 * the feature (feature/start, feature/check, feature/keep, feature/discard, feature/go-back, feature/bring-back),
 * the versions (version/preview, version/end-preview, version/restore),
 * the chat (session, session/send),
 * artifacts (list, serve, remove, unnote, artifact-shot), Draw and dropped files (drawing, upload),
 * dictation (listener, transcribe, dictation-log, vad/) and jobs (run: start or resume Claude, rebuild the artifact index).
 *
 * Listens on 127.0.0.1 only. Every request must name a localhost host (no DNS rebinding), and anything that acts
 * needs an X-Studio header plus a localhost origin, so no other site open in the browser can: the custom
 * header forces a CORS preflight this server never answers.
 *
 * State lives in ~/.studio (STUDIO_HOME): config.json ({ appDir, name, prefs }), logs, drawings, uploads, artifacts.
 *
 * Usage: node lib/studio-server.js
 * Run tests: node --test lib/studio-server.test.js
 */

const { execFile, execFileSync, spawn } = require('node:child_process');
const { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { COMMAND_SHELL_MARKER, pausedSessions, processTree, readClosed, logSession, readReconnected, runningCommands, withRealSessions } = require('./claude-reaper');
const { describe: describeArtifacts, folderFor: artifactFolder, locate: locateArtifact, remove: removeArtifacts, removeNote: removeArtifactNote } = require('./artifacts');
const { paneInput, panePrompt, readTranscript, sessionTitle, stripAnsi, transcriptPath, usageLimit } = require('./session-view');
const { EFFORT, bringBack, discard: discardFeature, endPreview, goBack, keep: keepFeature, nextVersion, preview, pushInBackground, read: readFeature, readMode, restore, runGate, setMode, start: startFeature, summarise, versions } = require('./feature');

const SCRIPTS = path.resolve(__dirname, '..');
const WEB_DIST = path.resolve(SCRIPTS, '..', 'web', 'dist');
const CONTROL_PORT = Number(process.env.STUDIO_PORT ?? 4000);
const STUDIO_HOME = process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio');
const CONFIG_FILE = path.join(STUDIO_HOME, 'config.json');
const LOCAL_HOST = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
// The app's label in pending keys, logs and the folders for drawings and uploads: there's only the one.
const LABEL = 'app';

const isLocalHost = (host) => LOCAL_HOST.test(host ?? '');

const mayRunJobs = (headers) => headers['x-studio'] === '1' && (!headers.origin || LOCAL_ORIGIN.test(headers.origin));

const readConfig = () => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
};

const writeConfig = (config) => {
  mkdirSync(STUDIO_HOME, { recursive: true });
  writeFileSync(CONFIG_FILE + '.tmp', `${JSON.stringify(config, null, 2)}\n`);
  renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE);
};

/** The app being built: its folder (config.appDir, default ~/Studio/my-app), name and where its dev server answers. */
const appInfo = (config = readConfig()) => {
  const dir = path.resolve(config.appDir ?? path.join(os.homedir(), 'Studio', 'my-app'));
  return { dir, name: config.name ?? path.basename(dir), url: `http://localhost:${config.appPort ?? 4001}` };
};

/** Whether a directory is the app's folder or inside it. */
const inApp = (dir, appDir = appInfo().dir) => Boolean(dir) && (dir === appDir || dir.startsWith(appDir + path.sep));

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;

const shellQuote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

// --- I/O ---------------------------------------------------------------------------------

const jobs = new Set();

const lastActive = (sessionId) => {
  const file = transcriptPath(sessionId);
  try {
    return file ? statSync(file).mtime.toISOString() : null;
  } catch {
    return null;
  }
};

const readBody = (req, limit = 10_000) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      req.studioBody = body;
      resolve(body);
    });
    req.on('error', reject);
  });

// Every POST from the index or the cockpit is an action: a line per action in actions.jsonl, beside the job logs.
const ACTIONS_LOG = path.join(STUDIO_HOME, 'logs', 'actions.jsonl');
// The body fields that say what an action acted on; the rest (a message to a session, say) stays out of the log.
const ACTION_FIELDS = ['label', 'action', 'key', 'tab', 'tabId', 'paneId', 'sessionId', 'env', 'service', 'on', 'branch', 'name', 'from', 'base', 'ticket', 'then', 'id', 'claim', 'stop', 'release'];

/**
 * An action's line: who sent it (the page's id and source headers), what it was (endpoint and body
 * fields), and how it went: a job's exit code, else the HTTP status; `aborted` when the page went away first.
 */
const actionRecord = (req, res, startedAt, now = Date.now()) => {
  let body = {};
  try {
    body = JSON.parse(req.studioBody || '{}');
  } catch {}
  const fields = Object.fromEntries(ACTION_FIELDS.filter((field) => typeof body[field] === 'string' || typeof body[field] === 'boolean').map((field) => [field, body[field]]));
  return {
    ts: new Date(startedAt).toISOString(),
    id: res.studioActionId || null,
    source: req.headers['x-studio-source'] ?? null,
    endpoint: new URL(req.url, 'http://localhost').pathname.replace('/_env/api', ''),
    ...fields,
    ...(res.studioJob ? { job: res.studioJob } : {}),
    status: res.statusCode,
    ...(res.studioExit !== undefined ? { exit: res.studioExit } : {}),
    ...(res.writableFinished ? {} : { aborted: true }),
    ms: now - startedAt,
  };
};

const streamJob = (res, key, script, cwd) => {
  jobs.add(key);
  res.studioJob = key;
  dropSharedState();
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.write(`$ ${script}\n`);
  // The server itself runs in the infra workspace, whose HERDR_WORKSPACE would send new tabs there.
  const { HERDR_WORKSPACE, ...inherited } = process.env;
  // Every job's output also goes to a log file, logs/job-<key>.log.
  mkdirSync(path.dirname(ACTIONS_LOG), { recursive: true });
  const log = path.join(path.dirname(ACTIONS_LOG), `job-${key}.log`);
  appendFileSync(log, `\n[${new Date().toISOString()}] $ ${script}\n`);
  const child = spawn('bash', ['-c', script], {
    cwd,
    env: { ...inherited, PATH: `${SCRIPTS}:${process.env.PATH}`, STUDIO_ACTION_ID: res.studioActionId ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => appendFileSync(log, chunk));
  child.stderr.on('data', (chunk) => appendFileSync(log, chunk));
  child.stdin.end();
  child.stdout.on('data', (chunk) => res.write(chunk));
  child.stderr.on('data', (chunk) => res.write(chunk));
  // A daemon the job starts (op daemon, ssh -f) inherits its output pipes, so 'close' would wait on it forever.
  child.on('exit', () => setTimeout(() => (child.stdout.destroy(), child.stderr.destroy()), 500));
  child.on('close', (code) => {
    jobs.delete(key);
    dropSharedState();
    res.studioExit = code;
    res.end(`\n[${code === 0 ? 'done' : `exit ${code}`}]\n`);
  });
};

const herdrJson = (args) => {
  try {
    return JSON.parse(execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })).result;
  } catch {
    return null;
  }
};

const SHELLS = ['zsh', 'bash', 'sh', 'fish', 'login'];

// herdr's agent statuses, most urgent first: blocked means a permission prompt or question.
const AGENT_STATUSES = ['blocked', 'done', 'working', 'idle', 'unknown'];

/**
 * Where a tab has got to: its agent's own status when Claude runs in it (claude-blocked,
 * claude-done, claude-working, claude-idle), else running while anything but a shell is in the
 * foreground, else idle.
 */
const tabState = (tab, pane, foreground) => {
  if (pane?.agent) {
    return `claude-${AGENT_STATUSES.includes(pane.agent_status) && pane.agent_status !== 'unknown' ? pane.agent_status : 'idle'}`;
  }
  return foreground.some((name) => !SHELLS.includes(name)) ? 'running' : 'idle';
};

/**
 * pane -> the commands its Claude session is running (a /watch-mr poller, a test run), so an idle
 * session waiting on one doesn't read as idle. Skips the per-pane lookups when nothing runs anywhere.
 */
const agentCommands = (snapshot) => {
  const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (!ps.includes(COMMAND_SHELL_MARKER)) {
    return new Map();
  }
  const tree = processTree(ps);
  const byPane = new Map();
  for (const pane of snapshot.panes.filter((candidate) => candidate.agent)) {
    const claude = herdrJson(['pane', 'process-info', '--pane', pane.pane_id])?.process_info?.foreground_processes?.find((proc) => proc.argv0 === 'claude' || proc.argv?.[0] === 'claude');
    const running = claude ? runningCommands(claude.pid, tree) : [];
    if (running.length) {
      byPane.set(pane.pane_id, running);
    }
  }
  return byPane;
};

const herdrSnapshot = () => ({
  tabs: herdrJson(['tab', 'list'])?.tabs ?? [],
  panes: withRealSessions(herdrJson(['pane', 'list'])?.panes ?? []),
  workspaces: herdrJson(['workspace', 'list'])?.workspaces ?? [],
});

const paneForeground = (pane) => (pane && !pane.agent ? (herdrJson(['pane', 'process-info', '--pane', pane.pane_id])?.process_info?.foreground_processes ?? []).map((proc) => proc.name) : []);

// whisper-server, which `studio up` runs in the workspace's whisper tab (STUDIO_WHISPER_PORT, default 8178).
const WHISPER_URL = process.env.STUDIO_WHISPER_URL || `http://127.0.0.1:${process.env.STUDIO_WHISPER_PORT || 8178}/inference`;
const WHISPER_DOWN = "Dictation isn't working because Whisper, which turns speech into text, isn't running. Run studio up again to start it, or type your message instead.";
const MAX_AUDIO = 25 * 1024 * 1024;
// Whisper's initial prompt: words it would otherwise mishear, spelled as we write them. It's a sentence, as
// Whisper copies its prompt's style: a bare list of words had it answer a 26s clip of speech with just "-".
const WHISPER_HINT = () => {
  const { name } = appInfo();
  return `I'm talking to Claude Code about my app, ${name}: a feature, a page, a button, the database, a checkpoint, a version, an artifact, the plan.`;
};

// Which page listens for speech: one at a time, so twenty cockpits with listening on don't all open the mic.
// The page you last clicked or typed in claims it, unless the owner is mid-recording: the page that
// started a recording keeps the mic wherever you look meanwhile. Every open cockpit shows that recording
// and can stop it; a stop names the page it came from, and the recording's text is left here for that
// page, which sends it to its own chat's session. The owner checks in while listening; one silent for
// LISTENER_STALE_MS has gone, and a result nobody collects within RESULT_TTL_MS is dropped.
const LISTENER_STALE_MS = 90_000;
const RESULT_TTL_MS = 60_000;
const STOPS = ['send', 'edit', 'discard'];
const noListener = { id: null, seen: 0, recording: null, stop: null };
let listener = noListener;
let result = null;
const isFresh = (now) => Boolean(listener.id) && now - listener.seen <= LISTENER_STALE_MS;
/** What page `id` is told: who owns the mic, the recording (where it is, since when), a stop for the owner to act on, and text for this page. */
const listenerView = (id, now = Date.now()) => {
  const fresh = isFresh(now);
  const mine = result && result.to === id && now - result.at <= RESULT_TTL_MS ? result : null;
  if (mine) result = null;
  return {
    id: listener.id,
    stale: !fresh,
    recording: fresh ? listener.recording : null,
    stop: fresh && id && id === listener.id ? listener.stop : null,
    result: mine && { text: mine.text, send: mine.send, error: mine.error },
  };
};
const updateListener = ({ id, claim, recording, stop, result: done, release }, now = Date.now()) => {
  const owner = isFresh(now) && listener.id === id;
  if (claim && listener.id !== id && !(isFresh(now) && listener.recording)) listener = { ...noListener, id, seen: now };
  // (a bare true/false comes from a page still on the version before recordings had a place and a start: ignored)
  else if (owner && (recording === null || typeof recording === 'object') && recording !== undefined) listener = { ...listener, seen: now, stop: null, recording: recording && { startedAt: Number(recording.startedAt) || now, where: String(recording.where ?? '').slice(0, 80), url: String(recording.url ?? '').slice(0, 300) } };
  else if (STOPS.includes(stop) && isFresh(now) && listener.recording) listener = { ...listener, stop: { how: stop, to: id } };
  else if (owner && done && typeof done.to === 'string') {
    result = { to: done.to, text: String(done.text ?? ''), send: Boolean(done.send), error: done.error ? String(done.error) : null, at: now };
    listener = { ...listener, seen: now, recording: null, stop: null };
  } else if (owner && release) listener = noListener;
  return listenerView(id, now);
};
const checkInListener = (id, now = Date.now()) => {
  if (id && listener.id === id) listener = { ...listener, seen: now };
  return listenerView(id, now);
};

/** Brings forward the Chrome tab that is recording (the page's own links can't reach a tab they didn't open). */
const revealRecording = (url) =>
  new Promise((resolve) => {
    const page = url.replace(/[?#].*$/, '');
    // The recording tab's title starts with ● (useDictation puts it there): two tabs can have the same address.
    const script = `if application "Google Chrome" is running then
  tell application "Google Chrome"
    set fallback to missing value
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t starts with ${JSON.stringify(page)} then
          if title of t starts with "●" then
            set active tab index of w to i
            set index of w to 1
            activate
            return "shown"
          end if
          if fallback is missing value then set fallback to {w, i}
        end if
      end repeat
    end repeat
    if fallback is not missing value then
      set active tab index of (item 1 of fallback) to (item 2 of fallback)
      set index of (item 1 of fallback) to 1
      activate
      return "shown"
    end if
  end tell
end if
return "missing"`;
    execFile('osascript', ['-e', script], { timeout: 5000 }, (error, stdout) => resolve(!error && stdout.trim() === 'shown'));
  });

// The files the mic's speech detector (@ricky0123/vad-web, in web/) fetches at run time, which the single-file page can't inline.
// pnpm keeps a package's dependencies beside it, so onnxruntime-web is found next to vad-web's real folder.
const VAD_DIR = (() => {
  try {
    return realpathSync(path.join(__dirname, '../../web/node_modules/@ricky0123/vad-web/dist'));
  } catch {
    return null;
  }
})();
const VAD_FILES = {
  'vad.worklet.bundle.min.js': ['', 'text/javascript'],
  'silero_vad_v5.onnx': ['', 'application/octet-stream'],
  'ort-wasm-simd-threaded.mjs': ['../../../onnxruntime-web/dist', 'text/javascript'],
  'ort-wasm-simd-threaded.wasm': ['../../../onnxruntime-web/dist', 'application/wasm'],
};
const serveVadFile = (res, name) => {
  const [dir, type] = VAD_FILES[name] ?? [];
  const file = VAD_DIR && type && path.join(VAD_DIR, dir, name);
  if (!file || !existsSync(file)) {
    res.writeHead(404).end(VAD_DIR ? `no speech-detector file ${name}\n` : 'web/node_modules has no @ricky0123/vad-web: run pnpm install in web/\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
  res.end(readFileSync(file));
};

/** Passes a recording (the request body, as the browser's MediaRecorder made it) to whisper-server and answers { text } or { error }. */
const transcribe = async (req, res) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_AUDIO) {
      sendJson(res, 413, { error: 'the recording is over 25 MB' });
      return;
    }
    chunks.push(chunk);
  }
  const type = (req.headers['content-type'] ?? 'audio/webm').split(';')[0];
  const audio = Buffer.concat(chunks);
  const ask = async (prompt) => {
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), `speech.${type.split('/')[1] ?? 'webm'}`);
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);
    const response = await fetch(WHISPER_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
    const json = await response.json().catch(() => ({}));
    return response.ok && typeof json.text === 'string' ? { raw: json.text, text: cleanTranscript(json.text) } : { error: json.error ?? `whisper-server answered ${response.status}` };
  };
  const startedAt = Date.now();
  let answer;
  try {
    answer = await ask(WHISPER_HINT());
    // The hint can still tip Whisper into answering speech with nothing readable: then it's asked once more without one.
    if (suspectTranscript(answer.text ?? '')) {
      const again = await ask(null);
      if (again.text) answer = { ...again, hinted: answer.raw };
    }
  } catch {
    sendJson(res, 502, { error: WHISPER_DOWN });
    return;
  }
  if (answer.error) {
    sendJson(res, 502, { error: `Whisper couldn't turn that into text (${answer.error}). Try again, or type your message instead.` });
    return;
  }
  if (keepsClips()) keepClip(req, audio, answer, Date.now() - startedAt);
  else if (suspectTranscript(answer.text)) console.error(`transcribe: suspect text ${JSON.stringify(answer.text)} (raw ${JSON.stringify(answer.raw)})`);
  sendJson(res, 200, { text: answer.text });
};

/**
 * Whisper's text as one line: it breaks its text into a line per segment, may start a segment with "- " as if
 * a line of dialogue (or with a stray "."), and marks silence and noise as [BLANK_AUDIO] or [SOUND].
 */
const cleanTranscript = (raw) =>
  raw
    .replace(/^\s*- /gm, '')
    .replace(/\[[A-Z_ ]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,;:]+\s*(?=[\p{L}\p{N}])/u, '');

/** Text with nothing to read in it (a lone "-", say), which is sent all the same. */
const suspectTranscript = (text) => text !== '' && !/[\p{L}\p{N}]/u.test(text);

// With keepDictationClips: true in config.json, every dictated clip and what's known about it, to look into text that came
// out wrong or cut short: a folder per recording, its clips, and summary.json once it's stopped. A week's worth is kept
// (about 2 MB a minute of speech). Off by default, so nothing said is written to disk.
const DICTATION_DIR = path.join(path.dirname(ACTIONS_LOG), 'dictation');
const DICTATION_KEEP_MS = 7 * 24 * 60 * 60_000;
const keepsClips = (config = readConfig()) => config.keepDictationClips === true;

/** The facts about a 16 kHz 16-bit mono WAV (as the cockpit sends): how long, and how loud (0-1, peak and RMS). */
const wavStats = (audio) => {
  const samples = Math.max(0, Math.floor((audio.length - 44) / 2));
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = audio.readInt16LE(44 + i * 2) / 0x7fff;
    peak = Math.max(peak, Math.abs(sample));
    sum += sample * sample;
  }
  return { seconds: samples / 16000, peak: Number(peak.toFixed(4)), rms: Number(Math.sqrt(sum / (samples || 1)).toFixed(4)) };
};

/** Saves a suspect clip as <ts>-<action id>.wav with a .json beside it, and says so in the server's log. */
/** Where a recording's clips go: a folder named by when it started. */
const recordingDir = (startedAt) => path.join(DICTATION_DIR, Number.isSafeInteger(startedAt) && startedAt > 0 ? new Date(startedAt).toISOString().replace(/[:.]/g, '-') : 'unknown');

const writeDictation = (dir, files) => {
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  } catch (error) {
    console.error(`dictation: not kept in ${dir}: ${error.message}`);
  }
};

/** Keeps a clip as NN.wav and NN.json (NN its stretch of speech) in its recording's folder; a suspect one, or one asked again without the hint, is also said in the server's log. */
const keepClip = (req, audio, { raw, text, hinted }, whisperMs) => {
  let recording = {};
  try {
    recording = JSON.parse(req.headers['x-studio-recording'] ?? '{}') ?? {};
  } catch {}
  const dir = recordingDir(recording.startedAt);
  const name = Number.isSafeInteger(recording.segment) ? String(recording.segment).padStart(2, '0') : new Date().toISOString().replace(/[:.]/g, '-');
  const suspect = suspectTranscript(text);
  const meta = {
    ts: new Date().toISOString(),
    actionId: req.headers['x-studio-action-id'] ?? null,
    source: req.headers['x-studio-source'] ?? null,
    page: req.headers.referer ?? null,
    // From the cockpit: segment 0 is the first stretch of speech, sinceStartMs when it ended, phase 'finishing' the tail cut off by stopping.
    recording,
    type: req.headers['content-type'] ?? null,
    bytes: audio.length,
    ...(String(req.headers['content-type']).startsWith('audio/wav') ? wavStats(audio) : {}),
    whisperMs,
    raw,
    text,
    suspect,
    // Set when the hinted answer had nothing readable and `raw` is from asking again without the hint.
    ...(hinted !== undefined ? { hintedRaw: hinted } : {}),
  };
  writeDictation(dir, { [`${name}.wav`]: audio, [`${name}.json`]: JSON.stringify(meta, null, 2) + '\n' });
  if (hinted !== undefined) console.error(`transcribe: hinted text ${JSON.stringify(hinted)}, asked again without the hint: ${JSON.stringify(text)} (${path.join(dir, name)}.wav)`);
  if (suspect) console.error(`transcribe: suspect text ${JSON.stringify(text)} (raw ${JSON.stringify(raw)}), kept as ${path.join(dir, name)}.wav`);
};

/** Drops recording folders not written to for DICTATION_KEEP_MS. */
const pruneDictation = (now = Date.now()) => {
  try {
    for (const name of readdirSync(DICTATION_DIR)) {
      const dir = path.join(DICTATION_DIR, name);
      if (now - statSync(dir).mtimeMs > DICTATION_KEEP_MS) rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
};

/** Keeps how a recording ended (the cockpit's summary: how it was stopped, its misfires, the text it gave) as summary.json beside its clips. */
const keepDictationSummary = (summary) => {
  writeDictation(recordingDir(summary.startedAt), { 'summary.json': JSON.stringify({ ts: new Date().toISOString(), ...summary }, null, 2) + '\n' });
  pruneDictation();
};

/**
 * The UI settings every page shares (the cockpits' chat and pane layout, which each <label>.localhost
 * would otherwise keep to itself), with `ui`'s keys set over `current`'s; null when `ui` isn't a plain
 * object of short names to small JSON values. No `ui` leaves them as they are.
 */
const mergeUiPrefs = (current, ui) => {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  if (ui === undefined) return base;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null;
  const fits = Object.entries(ui).every(([key, value]) => key.length <= 64 && JSON.stringify(value ?? null).length <= 1024);
  return fits ? { ...base, ...ui } : null;
};

// --- the cockpit's chat: reading the app's Claude pane and typing into it ------------------

const SEND_KEYS = ['esc', 'enter', 'submit', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
// A message reaches the pane as an argument to `herdr pane run`, so the OS argument limit (ARG_MAX, 1 MiB on macOS) is the only real bound.
const MAX_MESSAGE = 500_000;
// What the page a message was sent from shows, for the prompt-submit hook (hooks/studio-hook.py) to give that one prompt: <pane>.json, taken once.
const PAGE_CONTEXT_DIR = path.join(os.homedir(), '.claude', 'state', 'page-context');
const MAX_PAGE_CONTEXT = 4000;

/** Leaves the page's context for the prompt this message becomes (hooks/studio-hook.py reads and removes it). */
const notePageContext = (paneId, context, dir = PAGE_CONTEXT_DIR) => {
  const file = path.join(dir, `${paneId.replace(/:/g, '_')}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify({ context: String(context).slice(0, MAX_PAGE_CONTEXT), at: Date.now() }));
  renameSync(file + '.tmp', file);
};

// A drawing from the cockpit's Draw tab, sent with a message: kept as <label>/<time>.png for the session to Read, the newest KEEP_DRAWINGS kept.
const DRAWINGS_DIR = path.join(path.dirname(ACTIONS_LOG), 'drawings');
const MAX_DRAWING = 20 * 1024 * 1024;
const KEEP_DRAWINGS = 50;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Writes a drawing's PNG and drops the oldest past KEEP_DRAWINGS; returns its path, or null for a bad label or a body that isn't a PNG. */
const keepDrawing = (label, png, dir = DRAWINGS_DIR, now = Date.now()) => {
  if (!/^[A-Za-z0-9_-]+$/.test(label ?? '') || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const folder = path.join(dir, label);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, new Date(now).toISOString().replace(/[:.]/g, '-') + '.png');
  writeFileSync(file, png);
  const old = readdirSync(folder).filter((name) => name.endsWith('.png')).sort().slice(0, -KEEP_DRAWINGS);
  for (const name of old) rmSync(path.join(folder, name), { force: true });
  return file;
};

const receiveDrawing = async (req, res) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DRAWING) {
      sendJson(res, 413, { error: 'the drawing is over 20 MB' });
      return;
    }
    chunks.push(chunk);
  }
  const file = keepDrawing(LABEL, Buffer.concat(chunks));
  if (file) sendJson(res, 200, { path: file });
  else sendJson(res, 400, { error: 'a drawing must be a PNG' });
};

// What a drawing on an artifact is drawn over: the artifact as headless Chrome renders it at the pane's size, scroll and theme.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Chrome's arguments for a screenshot of a local artifact version at w×h CSS pixels (scale pixels each), scrolled to y; null when a value is out of range. */
const artifactShotArgs = ({ id, v, y, w, h, scale, dark }, out, profile) => {
  const n = (value, max) => (/^\d+$/.test(value ?? '') && Number(value) <= max ? Number(value) : null);
  const [version, top, width, height] = [n(v, 1e6), n(y, 1e7), n(w, 8000), n(h, 8000)];
  const dpr = Number(scale);
  if (!/^[A-Za-z0-9_-]+$/.test(id ?? '') || version === null || top === null || !width || !height || !(dpr >= 1 && dpr <= 4)) return null;
  return [
    '--headless', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + profile,
    `--window-size=${width},${height}`, `--force-device-scale-factor=${dpr}`, '--virtual-time-budget=3000',
    ...(dark === '1' ? ['--force-dark-mode'] : []), '--screenshot=' + out,
    `http://localhost:${CONTROL_PORT}/_env/artifact/${id}/v${version}/#studio-y=${top}`,
  ];
};

const artifactShot = (url, res) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-shot-'));
  const out = path.join(dir, 'shot.png');
  const args = artifactShotArgs(Object.fromEntries(url.searchParams), out, path.join(dir, 'profile'));
  if (!args) {
    rmSync(dir, { recursive: true, force: true });
    sendJson(res, 400, { error: 'needs id, v, y, w, h and scale (1-4)' });
    return;
  }
  execFile(CHROME, args, { timeout: 20_000 }, (error) => {
    const png = existsSync(out) ? readFileSync(out) : null;
    rmSync(dir, { recursive: true, force: true });
    if (png) res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(png);
    else sendJson(res, 502, { error: 'Chrome took no screenshot' + (error ? ': ' + error.message.split('\n')[0] : '') });
  });
};

// A file dropped on a chat (a screenshot, anything from Finder), sent with a message: the page can't know where it lives, so a copy
// is kept as <label>/<time>-<name> for the session to Read, the newest KEEP_UPLOADS kept.
const UPLOADS_DIR = path.join(path.dirname(ACTIONS_LOG), 'uploads');
const MAX_UPLOAD = 50 * 1024 * 1024;
const KEEP_UPLOADS = 50;

/** Writes a dropped file and drops the oldest past KEEP_UPLOADS; returns its path, or null for a bad label or no name. */
const keepUpload = (label, name, bytes, dir = UPLOADS_DIR, now = Date.now()) => {
  const safe = path.basename(name ?? '').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[._ ]+/, '').slice(-120);
  if (!/^[A-Za-z0-9_-]+$/.test(label ?? '') || !safe) return null;
  const folder = path.join(dir, label);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, new Date(now).toISOString().replace(/[:.]/g, '-') + '-' + safe);
  writeFileSync(file, bytes);
  const old = readdirSync(folder).sort().slice(0, -KEEP_UPLOADS);
  for (const stale of old) rmSync(path.join(folder, stale), { force: true });
  return file;
};

const receiveUpload = async (req, res, url) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD) {
      sendJson(res, 413, { error: 'the file is over 50 MB' });
      return;
    }
    chunks.push(chunk);
  }
  const file = keepUpload(LABEL, url.searchParams.get('name'), Buffer.concat(chunks));
  if (file) sendJson(res, 200, { path: file });
  else sendJson(res, 400, { error: 'an upload needs a file name' });
};

// The Claude pane with this id when it works in the app's folder, else null: the cockpit only reads and types into the app's sessions.
const appPane = (paneId, appDir = appInfo().dir, panes = withRealSessions(herdrJson(['pane', 'list'])?.panes ?? [])) => {
  const pane = panes.find((candidate) => candidate.agent && candidate.pane_id === paneId);
  return pane && inApp(pane.foreground_cwd ?? pane.cwd ?? '', appDir) ? pane : null;
};

const paneScreen = (paneId) => execFileSync('herdr', ['pane', 'read', paneId, '--source', 'visible', '--format', 'ansi'], { encoding: 'utf8', timeout: 5000 });

/**
 * What the cockpit's chat column shows for a pane: the transcript's messages from byte `after` on
 * (the whole tail when `after` is undefined), text typed into the pane but not sent, the prompt a
 * blocked session waits on, Claude Code's line saying a usage limit was hit, and the raw screen for the Terminal view.
 */
const sessionView = (pane, after, withScreen) => {
  const sessionId = pane.agent_session?.value ?? null;
  const file = sessionId && transcriptPath(sessionId);
  const transcript = file ? readTranscript(file, after) : { offset: 0, reset: true, messages: [] };
  const screen = paneScreen(pane.pane_id);
  const status = AGENT_STATUSES.includes(pane.agent_status) ? pane.agent_status : 'unknown';
  return { sessionId, status, ...transcript, input: paneInput(screen), prompt: status === 'blocked' ? panePrompt(screen) : null, limit: usageLimit(screen), ...(withScreen ? { screen } : {}) };
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
};

// Screen text with its whitespace and box sides gone, so text the terminal wrapped still matches.
const compactText = (text) => stripAnsi(text).replace(/[\s│]/g, '');

/**
 * Types `text` into a question's free-text option `key` and picks it: arrows from the focused option to it, backspaces
 * until it's empty, the text, then Enter. Each step waits (up to `wait` ms) for the screen from `read` to show it landed,
 * since a busy session takes keys in late: an Enter that arrives while the text is still coming in is typed into the
 * field as a line break instead of answering. The error to show, or null once Enter is pressed.
 */
const answerFreeText = async (key, text, read, keys, type, wait = 3000) => {
  const until = async (done) => {
    for (let waited = 0; ; waited += 100) {
      const screen = read();
      if (done(panePrompt(screen), screen)) return true;
      if (waited >= wait) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const free = (prompt) => prompt?.options.find((option) => option.key === key && option.free);
  const prompt = panePrompt(read());
  const order = prompt?.options.map((option) => option.key) ?? [];
  if (!free(prompt) || !order.includes(prompt.focused)) return 'The question on screen has no such text option any more. Answer it in herdr.';
  const steps = order.indexOf(key) - order.indexOf(prompt.focused);
  if (steps) keys(...Array(Math.abs(steps)).fill(steps > 0 ? 'down' : 'up'));
  if (!(await until((now) => now?.focused === key))) return 'The text option never took focus. Answer it in herdr.';
  // Ctrl-E puts the cursor at the end (an arrow can leave it at the start); the screen shows only the first line of a
  // long answer, and not a stray line break, so clear in rounds with spares.
  for (let round = 0; free(panePrompt(read()))?.typed && round < 5; round++) {
    keys('ctrl+e', ...Array(free(panePrompt(read())).typed.length + 10).fill('backspace'));
    await until((now) => !free(now)?.typed);
  }
  if (free(panePrompt(read()))?.typed !== '') return 'The text option could not be cleared. Answer it in herdr.';
  type(text);
  const tail = compactText(text).slice(-24);
  if (!(await until((now, screen) => now?.focused === key && compactText(screen).includes(tail)))) return 'The answer never showed in the text option. Check it in herdr.';
  keys('enter');
  return null;
};

/**
 * The message an interrupt put back in the pane's input box, cleared from it so the cockpit can hold it instead; '' when none
 * shows within `wait` ms. Backspaces from the end clear it; a few spare ones cover wrapped lines read back without their space.
 */
const takeRestoredInput = async (paneId, wait = 2000, read = () => paneInput(paneScreen(paneId)), keys = (...k) => execFileSync('herdr', ['pane', 'send-keys', paneId, ...k], { stdio: 'ignore', timeout: 5000 })) => {
  for (let waited = 0; waited < wait; waited += 150) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const restored = read();
    if (restored) {
      keys(...Array(restored.length + 20).fill('backspace'));
      return restored;
    }
  }
  return '';
};

/**
 * Types into a session from the cockpit: { key } presses one of SEND_KEYS ('submit' presses a multi-select's Next or Submit); { answer: { key, text } }
 * types text into a question's free-text option and picks it; { text } sends a message
 * with Enter. Newlines become spaces, since one would send the message early. A message is refused
 * while the session waits on a prompt or its input box holds text typed in herdr, so the two never mix.
 */
const sendToSession = async (req, res) => {
  const { paneId, text, key, answer, context } = JSON.parse(await readBody(req, MAX_MESSAGE * 2));
  const pane = appPane(paneId);
  if (!pane) {
    sendJson(res, 404, { error: `no Claude session of the app's in pane ${paneId}` });
    return;
  }
  if (key !== undefined) {
    if (!SEND_KEYS.includes(key)) {
      sendJson(res, 400, { error: `key must be one of ${SEND_KEYS.join(' ')}` });
      return;
    }
    // A multi-select's button sits below its options and only Tab reaches it; Tab on the button stays there, so nine always land on it.
    const keys = key === 'submit' ? [...Array(9).fill('tab'), 'enter'] : [key];
    // Esc interrupting Claude puts its last message back in the input box, which would then block the next message sent from here.
    const interrupting = key === 'esc' && pane.agent_status === 'working' && !paneInput(paneScreen(paneId));
    execFileSync('herdr', ['pane', 'send-keys', paneId, ...keys], { stdio: 'ignore', timeout: 5000 });
    if (!interrupting) {
      res.writeHead(204).end();
      return;
    }
    sendJson(res, 200, { restored: await takeRestoredInput(paneId) });
    return;
  }
  if (answer !== undefined) {
    const typed = String(answer?.text ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!typed) {
      sendJson(res, 409, { error: 'Type an answer first.' });
      return;
    }
    const error = await answerFreeText(
      String(answer?.key),
      typed,
      () => paneScreen(paneId),
      (...keys) => execFileSync('herdr', ['pane', 'send-keys', paneId, ...keys], { stdio: 'ignore', timeout: 5000 }),
      (text) => execFileSync('herdr', ['pane', 'send-text', paneId, text], { stdio: 'ignore', timeout: 5000 })
    );
    if (error) {
      sendJson(res, 409, { error });
      return;
    }
    res.writeHead(204).end();
    return;
  }
  const message = String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  if (!message) {
    sendJson(res, 400, { error: 'the message is empty' });
    return;
  }
  if (message.length > MAX_MESSAGE) {
    sendJson(res, 400, { error: `the message is ${message.length.toLocaleString()} characters; one passed to the pane can be at most ${MAX_MESSAGE.toLocaleString()} (the OS limit on a command's arguments)` });
    return;
  }
  if (pane.agent_status === 'blocked') {
    sendJson(res, 409, { error: 'The session is waiting on a prompt. Answer it first.' });
    return;
  }
  const pending = paneInput(paneScreen(paneId));
  if (pending) {
    sendJson(res, 409, { error: 'The herdr pane has text typed but not sent. Send or clear it there first.', pending });
    return;
  }
  if (context) notePageContext(paneId, context);
  // The effort for the chat's mode first, so this message runs at it; time for /effort to run before the message is typed.
  if (syncEffort(appInfo().dir)) await new Promise((resolve) => setTimeout(resolve, 700));
  execFileSync('herdr', ['pane', 'run', paneId, message], { stdio: 'ignore', timeout: 5000 });
  res.writeHead(204).end();
};

// --- the app's artifacts (artifacts.js), for the cockpit's Artifacts view ------------------

const ARTIFACT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
// Artifacts run their own scripts: as an opaque origin they can't call /_env/api as the cockpit, which runs jobs.
const ARTIFACT_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals';

// Most sites refuse to be framed, so a link to another site opens in a new tab rather than
// in the cockpit's artifact pane. Links the page handles itself (the index's previews) are left alone.
const EXTERNAL_LINKS_SCRIPT = `<script>
document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[href]');
  if (!link || event.defaultPrevented || link.getAttribute('target')) return;
  const href = new URL(link.getAttribute('href'), location.href);
  if (/^https?:$/.test(href.protocol) && href.origin !== location.origin) link.setAttribute('target', '_blank');
});
</script>
`;

// The cockpit's pick tool: sent {type: 'studio-pick', on}, the page outlines the element under the mouse, and a click
// posts {type: 'studio-picked', selector, text, heading} back instead of doing what it would (Esc posts studio-pick-off).
// Every Esc also posts studio-escape, for the cockpit to drop what was picked.
// Cmd/Ctrl+B in the page posts studio-pick-toggle, since keys pressed in the frame never reach the cockpit, and Space
// (outside the page's own fields) posts studio-space, for the cockpit's dictation. Any other
// click posts studio-clicked, for the cockpit to put the cursor back in its chat, unless it went to something you type
// into or selected text.
// The cockpit only reads these from its own artifact frame, and they reach Claude as text describing the page.
const PICKER_SCRIPT = `<script>
(() => {
  let on = false;
  let box = null;
  // Where the mouse last was, so turning picking on outlines what is already under it.
  let mouse = null;
  const post = (data) => parent.postMessage(data, '*');
  const clip = (text, n) => { text = (text || '').replace(/\\s+/g, ' ').trim(); return text.length > n ? text.slice(0, n - 1) + '…' : text; };
  const selectorOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement && parts.length < 5; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.localName;
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === node.localName) : [];
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const headingOf = (el) => {
    let found = null;
    for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
      if (h === el || h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h; else break;
    }
    return found && found !== el ? clip(found.textContent, 120) : null;
  };
  const outline = (el) => {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #0ea5e9;background:rgba(14,165,233,.12);border-radius:3px';
      document.documentElement.appendChild(box);
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const set = (value) => {
    on = value;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on && box) box.style.display = 'none';
    const under = on && mouse && document.elementFromPoint(mouse.x, mouse.y);
    if (under) outline(under);
  };
  addEventListener('mousemove', (event) => { mouse = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
  addEventListener('message', (event) => { if (event.source === parent && event.data && event.data.type === 'studio-pick') set(Boolean(event.data.on)); });
  addEventListener('mouseover', (event) => { if (on && event.target.nodeType === 1) outline(event.target); }, true);
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) addEventListener(type, (event) => { if (on) { event.preventDefault(); event.stopPropagation(); } }, true);
  addEventListener('click', (event) => {
    if (!on) return;
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    set(false);
    post({ type: 'studio-picked', selector: selectorOf(el), text: clip(el.innerText || el.textContent || el.getAttribute('aria-label') || '', 200), heading: headingOf(el), tag: el.localName });
  }, true);
  addEventListener('click', (event) => {
    if (on || !event.isTrusted) return;
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    if (target && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (!getSelection().isCollapsed) return;
    post({ type: 'studio-clicked' });
  });
  addEventListener('keydown', (event) => {
    if (on && event.key === 'Escape') { set(false); post({ type: 'studio-pick-off' }); }
    if (event.key === 'Escape') post({ type: 'studio-escape' });
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); post({ type: 'studio-pick-toggle' }); }
    // ⌘⇧← opens or closes the cockpit's Index overlay and ⌘⇧→ pins or collapses its chat, as they do in the cockpit itself; in a box with text in it they keep their usual job.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const field = document.activeElement;
      const typing = field && ((field.matches('input, textarea') && field.value !== '') || field.isContentEditable);
      if (!typing) { event.preventDefault(); post({ type: 'studio-pane-key', key: event.key }); }
    }
    // Space dictates in the cockpit, as it does anywhere on the cockpit's own page; in a field of the page it stays a space.
    if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      const field = document.activeElement;
      if (!(field && (field.isContentEditable || field.closest('input, textarea, select')))) { event.preventDefault(); post({ type: 'studio-space', repeat: event.repeat }); }
    }
  }, true);
})();
</script>
`;

// The page posts where it is scrolled to ({type: 'studio-scroll', y}), and scrolls there when sent {type: 'studio-scroll-to', y},
// so the cockpit can keep your place when it shows another version of the artifact. Opened at #studio-y=<y> (artifactShot), it shows
// itself as if scrolled to y by moving up instead: headless Chrome's --screenshot captures the first screenful whatever the scroll.
const SCROLL_SCRIPT = `<script>
(() => {
  const start = /^#studio-y=(\\d+)$/.exec(location.hash);
  if (start) addEventListener('load', () => { document.documentElement.style.translate = '0 -' + start[1] + 'px'; });
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; parent.postMessage({ type: 'studio-scroll', y: scrollY }, '*'); });
  }, { passive: true });
  addEventListener('message', (event) => {
    if (event.source === parent && event.data && event.data.type === 'studio-scroll-to' && typeof event.data.y === 'number') scrollTo({ top: event.data.y, behavior: 'instant' });
  });
})();
</script>
`;

// Marks what changed since an earlier version, only when the cockpit asks (studio-diff, against: n, html: that
// version's page, which the cockpit fetches: this sandboxed frame has no origin to fetch it with), lines up the two pages' text blocks (paragraphs, headings, list items, rows) and
// outlines new blocks, outlines changed ones and puts removed ones back, faded, where they were. studio-diff with
// no version clears the marks. Until asked it does nothing, so the page renders as it always did.
const DIFF_SCRIPT = `<script>
(() => {
  const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,tr,pre,blockquote,figcaption,dt,dd,summary,caption';
  const style = document.createElement('style');
  style.textContent = '[data-studio-diff]{outline:2px solid;outline-offset:2px;border-radius:2px}' +
    '[data-studio-diff=added]{outline-color:#1f9d55;background:rgba(31,157,85,.10)}' +
    '[data-studio-diff=changed]{outline-color:#d69e2e;background:rgba(214,158,46,.12)}' +
    '[data-studio-diff=removed]{outline-color:#e53e3e;outline-style:dashed;opacity:.5;text-decoration:line-through}';
  const text = (el) => el.textContent.replace(/\\s+/g, ' ').trim();
  // Innermost blocks only (an li holding a p counts once, as the p), and not the cockpit's own clones.
  const blocks = (root) => [...root.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS) && text(el));
  const clear = () => {
    document.querySelectorAll('[data-studio-diff=removed]').forEach((el) => el.remove());
    document.querySelectorAll('[data-studio-diff]').forEach((el) => el.removeAttribute('data-studio-diff'));
  };
  // Longest common subsequence of the two pages' block texts: the blocks left in place.
  const anchors = (a, b) => {
    const n = a.length, m = b.length, t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const pairs = [];
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
    }
    return pairs;
  };
  const diff = (against, html) => {
    const old = blocks(new DOMParser().parseFromString(html, 'text/html'));
    clear();
    if (!document.head.contains(style)) document.head.append(style);
    const now = blocks(document);
    const pairs = anchors(old.map(text), now.map(text));
    const counts = { added: 0, changed: 0, removed: 0 };
    let i = 0, j = 0;
    // Between two anchors: blocks at the same spot with the same tag changed, extra new ones were added, extra old ones removed.
    for (const [ai, aj] of [...pairs, [old.length, now.length]]) {
      const gone = old.slice(i, ai), fresh = now.slice(j, aj);
      fresh.forEach((el, k) => {
        const kind = gone[k] && gone[k].tagName === el.tagName ? 'changed' : 'added';
        el.dataset.studioDiff = kind;
        counts[kind]++;
      });
      const removed = gone.filter((el, k) => !(fresh[k] && fresh[k].tagName === el.tagName));
      const before = now[aj] || null, after = now[aj - 1] || null;
      for (const el of removed) {
        const ghost = document.importNode(el, true);
        ghost.dataset.studioDiff = 'removed';
        if (before) before.before(ghost); else if (after) after.after(ghost); else document.body.append(ghost);
        counts.removed++;
      }
      i = ai + 1; j = aj + 1;
    }
    parent.postMessage({ type: 'studio-diff-result', against, ...counts }, '*');
  };
  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || event.data.type !== 'studio-diff') return;
    if (typeof event.data.against !== 'number' || typeof event.data.html !== 'string') return clear();
    try { diff(event.data.against, event.data.html); } catch { parent.postMessage({ type: 'studio-diff-result', against: event.data.against, error: true }, '*'); }
  });
})();
</script>
`;

// Claude's notes on this version (studio-notes, notes: [{ nid, selector, text }]): each floats beside the page's content,
// level with the element it answers about (which gets an outline), or under it when there's no gutter, without
// moving the page's own layout. × posts studio-note-close.
// A note whose element is gone shows at the top. studio-notes with none clears them.
const NOTES_SCRIPT = `<script>
(() => {
  const style = document.createElement('style');
  style.textContent = '.studio-note{position:absolute;z-index:2147483646;max-width:min(360px,calc(100vw - 32px));box-sizing:border-box;' +
    'padding:10px 30px 10px 12px;border-radius:8px;background:#fffbea;color:#3d3200;border:1px solid #e5c74a;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.18);font:13px/1.5 system-ui,sans-serif;white-space:pre-wrap;text-align:left}' +
    '.studio-note button{position:absolute;top:4px;right:6px;border:0;background:none;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.6}' +
    '.studio-note button:hover{opacity:1}[data-studio-noted]{outline:2px solid #e5c74a;outline-offset:2px}' +
    '@media (prefers-color-scheme: dark){.studio-note{background:#2e2709;color:#f6e7a8;border-color:#8a7420}}';
  let notes = [];
  const find = (selector) => { try { return document.querySelector(selector); } catch { return null; } };
  // The content column: the outermost box around the element that leaves room beside it (about 240px of gutter).
  const columnOf = (el) => {
    let column = null;
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (node.getBoundingClientRect().width <= innerWidth - 240) column = node;
    }
    return column;
  };
  const place = () => {
    document.querySelectorAll('.studio-note').forEach((el) => el.remove());
    document.querySelectorAll('[data-studio-noted]').forEach((el) => el.removeAttribute('data-studio-noted'));
    // Beside the content where there's a gutter (right first, then left), each level with its element and stacked
    // below the note before it on that side; with no gutter, just under the element.
    const next = { right: 0, left: 0, top: 8 };
    const placed = notes.map((note) => ({ note, target: find(note.selector) }));
    placed.sort((a, b) => (a.target ? a.target.getBoundingClientRect().top : -1) - (b.target ? b.target.getBoundingClientRect().top : -1));
    for (const { note, target } of placed) {
      const box = document.createElement('div');
      box.className = 'studio-note';
      box.textContent = target ? note.text : note.text + '\\n(The element this answers about is no longer on the page.)';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.title = 'Close this note';
      close.onclick = () => parent.postMessage({ type: 'studio-note-close', nid: note.nid }, '*');
      box.append(close);
      document.body.append(box);
      if (!target) {
        box.style.top = scrollY + next.top + 'px';
        box.style.left = '16px';
        next.top += box.offsetHeight + 8;
        continue;
      }
      target.setAttribute('data-studio-noted', '');
      const r = target.getBoundingClientRect();
      const column = columnOf(target);
      const c = column ? column.getBoundingClientRect() : null;
      const side = c && innerWidth - c.right >= 236 ? 'right' : c && c.left >= 236 ? 'left' : null;
      if (side) {
        const room = side === 'right' ? innerWidth - c.right : c.left;
        box.style.width = Math.min(340, room - 32) + 'px';
        box.style.left = scrollX + (side === 'right' ? c.right + 16 : c.left - 16 - box.offsetWidth) + 'px';
        const top = Math.max(r.top + scrollY, next[side]);
        box.style.top = top + 'px';
        next[side] = top + box.offsetHeight + 8;
      } else {
        box.style.top = r.bottom + scrollY + 8 + 'px';
        box.style.left = Math.max(16, Math.min(r.left + scrollX, scrollX + innerWidth - box.offsetWidth - 16)) + 'px';
      }
    }
  };
  addEventListener('resize', () => notes.length && place());
  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || event.data.type !== 'studio-notes') return;
    notes = Array.isArray(event.data.notes) ? event.data.notes.filter((n) => n && typeof n.selector === 'string' && typeof n.text === 'string') : [];
    if (notes.length && !document.head.contains(style)) document.head.append(style);
    place();
  });
})();
</script>
`;

// A stylesheet <link> blocks the first paint until it loads, so offline (or on wifi with no internet) a page
// that asks Google Fonts stays blank until that request times out. Loaded as print-only and switched to all
// once it arrives, it no longer blocks: the page shows at once in its fallback fonts. A link that already
// names its media is left alone.
const GOOGLE_FONTS_LINK = /<link\b(?=[^>]*\brel=["']?stylesheet)(?=[^>]*\bhref=["']?https:\/\/fonts\.googleapis\.com\/)(?![^>]*\bmedia=)([^>]*?)\s*\/?>/gi;

/** An artifact file as the cockpit serves it: an HTML page with its Google Fonts made non-blocking and EXTERNAL_LINKS_SCRIPT, PICKER_SCRIPT, SCROLL_SCRIPT, DIFF_SCRIPT and NOTES_SCRIPT appended. */
const servedArtifact = (content, file) =>
  /\.html?$/i.test(file)
    ? Buffer.concat([Buffer.from(content.toString('utf8').replace(GOOGLE_FONTS_LINK, `<link$1 media="print" onload="this.media='all'">`)), Buffer.from('\n' + EXTERNAL_LINKS_SCRIPT + PICKER_SCRIPT + SCROLL_SCRIPT + DIFF_SCRIPT + NOTES_SCRIPT)])
    : content;


/** A file from the app's artifact folder (its index, or a snapshot), or null when it is outside it or missing. */
const artifactFile = (folder, relative) => {
  const file = path.resolve(folder, relative.replace(/^\/+/, '') || 'index.html');
  return file.startsWith(folder + path.sep) && existsSync(file) && statSync(file).isFile() ? file : null;
};

const API_START_TIMEOUT_MS = 90_000;

// --- state: the app, its Claude session, prefs ----------------------------------------------

/** Whether something is listening on the app's port: its dev server is up. */
const appRunning = (url) => {
  try {
    execFileSync('lsof', ['-nP', `-iTCP:${new URL(url).port}`, '-sTCP:LISTEN'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const DEV_LOG_LINES = 50;
const MAX_LOG_LINE = 300;
// What a crash leaves in the log: an error's name or stack, npm's ERR!, or the Node.js version line Node prints under an uncaught one.
const CRASH = /\b\w*Error\b|\bException\b|npm ERR!|^Node\.js v\d/m;

/** The last lines of the app's dev server output (data/logs/dev.log, which `studio up` writes), without colours; '' when there is none. */
const devLogTail = (appDir, lines = DEV_LOG_LINES) => {
  let text;
  try {
    const file = path.join(appDir, 'data', 'logs', 'dev.log');
    const { size } = statSync(file);
    // The end of the file is enough for 50 lines.
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString('utf8');
  } catch {
    return '';
  }
  // A line redrawn in place (a progress counter) keeps only what was drawn last.
  return stripAnsi(text)
    .trimEnd()
    .split('\n')
    .map((line) => line.replace(/^.*\r(?=.)/, '').replace(/\r$/, '').slice(0, MAX_LOG_LINE))
    .slice(-lines)
    .join('\n');
};

// How long the chat says "Reconnected" after the reaper started Claude again.
const RECONNECTED_SHOWN_MS = 10 * 60_000;

/** When the reaper last started the chat's Claude again ({ at, paneId }), if that was in the last 10 minutes; else null. */
const recentReconnect = (reconnected, now = Date.now()) => (reconnected && now - Date.parse(reconnected.at) < RECONNECTED_SHOWN_MS ? reconnected : null);

/** Whether the end of the dev server's log shows a crash; with the app not listening, it has crashed rather than not started yet. */
const looksCrashed = (tail) => CRASH.test(tail);

/** The Claude panes working in the app's folder, most urgent first. */
const appAgents = (snapshot, appDir, commands = new Map()) => {
  const tabLabels = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab.label]));
  return snapshot.panes
    .filter((pane) => pane.agent && inApp(pane.foreground_cwd ?? pane.cwd ?? '', appDir))
    .map((pane) => {
      const sessionId = pane.agent_session?.value ?? null;
      return { paneId: pane.pane_id, tabId: pane.tab_id, tab: tabLabels.get(pane.tab_id) ?? '', status: AGENT_STATUSES.includes(pane.agent_status) ? pane.agent_status : 'unknown', commands: commands.get(pane.pane_id) ?? [], sessionId };
    })
    .sort((a, b) => AGENT_STATUSES.indexOf(a.status) - AGENT_STATUSES.indexOf(b.status));
};

/** The herdr tab the Artifacts buttons run the artifact-index skill in, if it is open: { tabId, state }. */
const artifactsTab = (snapshot, appDir) => {
  const tab = snapshot.tabs.find((candidate) => candidate.label === 'Artifacts' && snapshot.panes.some((pane) => pane.tab_id === candidate.tab_id && inApp(pane.cwd, appDir)));
  if (!tab) return null;
  const pane = snapshot.panes.find((candidate) => candidate.tab_id === tab.tab_id);
  return { tabId: tab.tab_id, state: tabState(tab, pane, paneForeground(pane)) };
};

/** The app's stopped Claude sessions, offered to resume; one in a pane since closed is dropped unless the reaper closed it. */
const pausedOffers = (closed, appDir, runningSessions, livePanes, now = Date.now()) =>
  pausedSessions(
    closed.filter((record) => inApp(record.cwd, appDir) && (record.how === 'closed' || record.how === 'dismissed' || livePanes.has(record.pane_id))),
    appDir,
    runningSessions,
    now
  ).map((record) => ({ sessionId: record.session_id, ts: record.ts, how: record.how, by: record.by ?? null, paneId: record.pane_id, tabId: record.tab_id }));

const state = () => {
  const config = readConfig();
  const app = appInfo(config);
  const snapshot = herdrSnapshot();
  const runningSessions = new Set(snapshot.panes.map((pane) => pane.agent_session?.value).filter(Boolean));
  const livePanes = new Set(snapshot.panes.map((pane) => pane.pane_id));
  const artifacts = artifactsTab(snapshot, app.dir);
  const running = appRunning(app.url);
  return {
    app: {
      ...app,
      running,
      crashed: !running && looksCrashed(devLogTail(app.dir)),
      reconnected: recentReconnect(readReconnected()),
      busy: jobs.has(LABEL),
      tabs: artifacts ? { artifacts } : {},
      agents: appAgents(snapshot, app.dir, agentCommands(snapshot)).map((agent) => ({ ...agent, title: sessionTitle(agent.sessionId), active: lastActive(agent.sessionId) })),
      paused: pausedOffers(readClosed(), app.dir, runningSessions, livePanes).map((record) => ({ ...record, title: sessionTitle(record.sessionId), active: lastActive(record.sessionId) })),
      ...readFeature(app.dir),
      versions: versions(app.dir),
      mode: readMode(app.dir),
    },
    prefs: { tooltips: config.prefs?.tooltips !== false, ui: mergeUiPrefs(config.prefs?.ui) },
  };
};

// Every open page polls /state, so one build a second serves them all; anything that changes it (a POST, a job starting or ending) drops it.
const SHARED_STATE_MS = 1000;
let sharedState = null;
const dropSharedState = () => {
  sharedState = null;
};
const currentState = () => {
  if (!sharedState || Date.now() - sharedState.at >= SHARED_STATE_MS) sharedState = { at: Date.now(), value: state() };
  return sharedState.value;
};

// --- jobs: the scripts the cockpit's buttons run, streamed back ---------------------------

const jobScript = (action, { sessionId, paneId, message, appDir }) => {
  const oneLine = (text) => shellQuote(String(text).replace(/\s*\n\s*/g, ' ').trim());
  switch (action) {
    case 'claude-start':
      // A message sent with no session to take it starts one with the message as its first prompt.
      return `claude-reaper.sh start ${shellQuote(appDir)}${message !== undefined ? ` --message ${oneLine(message)}` : ''}`;
    case 'resume':
      if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
        throw new Error('sessionId must be a Claude session id');
      }
      // A message sent to a stopped session resumes it with the message as its first prompt.
      return `claude-reaper.sh resume ${shellQuote(appDir)}${sessionId ? ` ${sessionId}` : ''}${message !== undefined ? ` --message ${oneLine(message)}` : ''}`;
    case 'dismiss-session':
      if (!SESSION_ID.test(sessionId ?? '')) {
        throw new Error('sessionId must be a Claude session id');
      }
      return `claude-reaper.sh dismiss ${sessionId}`;
    case 'stop-session':
      if (!PANE_ID.test(paneId ?? '')) {
        throw new Error('paneId must be a herdr pane id');
      }
      return `claude-reaper.sh stop ${paneId} --dismiss`;
    case 'artifact-index':
      return `artifact-index-in-herdr.sh ${shellQuote(appDir)}`;
    case 'artifact-consolidate':
      return `artifact-index-in-herdr.sh --consolidate ${shellQuote(appDir)}`;
    default:
      throw new Error(`unknown action ${action}`);
  }
};

const runJob = async (req, res) => {
  const { action, sessionId, paneId, message } = JSON.parse(await readBody(req, MAX_MESSAGE * 2));
  if (jobs.has(LABEL)) {
    res.writeHead(409).end('a job is already running\n');
    return;
  }
  let script;
  try {
    script = jobScript(action, { sessionId, paneId, message, appDir: appInfo().dir });
  } catch (error) {
    res.writeHead(400).end(`${error.message}\n`);
    return;
  }
  streamJob(res, LABEL, script, appInfo().dir);
};

/** The chat's Claude pane: the app's agent not in the Artifacts tab. */
const chatAgent = (appDir) => appAgents(herdrSnapshot(), appDir).find((agent) => agent.tab !== 'Artifacts');

/** Answers 409 while the chat's Claude is working or waiting on a question, when `what` (e.g. "Keep it") must wait; true if it did. */
const refuseWhileBusy = (res, chat, what) => {
  if (!chat || (chat.status !== 'working' && chat.status !== 'blocked')) return false;
  sendJson(res, 409, { error: chat.status === 'working' ? `Claude is working. ${what} once it has finished.` : 'Claude is waiting on a question. Answer it first.' });
  return true;
};

// The effort level last typed into each Claude session ("<pane> <session>" -> level), so it is typed again only for a new
// session or a new mode. Kept in memory: after the server restarts it is typed once more, which does no harm.
const effortTyped = new Map();

/**
 * Types `/effort <level>` for the chat's mode (Ask low, Plan high, Build medium) into the chat's Claude, when its session hasn't
 * had that level yet: a new session (started, resumed or /clear-ed) or a new mode. Only while it sits idle at an empty prompt,
 * since typed into a turn it would wait in Claude's queue: while Claude works, a later call does it (the server tries every few
 * seconds, and before each message the chat sends). /effort also saves the level as the user's default; the next mode change or
 * session sets it again. True when it typed; false too when herdr couldn't be reached.
 */
const syncEffort = (appDir) => {
  try {
    const chat = chatAgent(appDir);
    if (!chat?.sessionId || (chat.status !== 'idle' && chat.status !== 'done')) return false;
    const level = EFFORT[readMode(appDir)];
    const key = `${chat.paneId} ${chat.sessionId}`;
    if (effortTyped.get(key) === level || paneInput(paneScreen(chat.paneId))) return false;
    execFileSync('herdr', ['pane', 'run', chat.paneId, `/effort ${level}`], { stdio: 'ignore', timeout: 5000 });
    logSession({ event: 'typed', pane: chat.paneId, session: chat.sessionId, text: `/effort ${level}` });
    effortTyped.set(key, level);
    return true;
  } catch {
    return false;
  }
};
const EFFORT_SYNC_MS = 3000;
const PUSH_RETRY_MS = 60_000;

/**
 * Sets the chat's switch ({ mode }: ask, plan or build) and the effort for it. Allowed while Claude works: the turn under way
 * keeps its mode, and the next message runs in the new one.
 */
const setModeNow = async (req, res) => {
  const { mode } = JSON.parse(await readBody(req));
  const appDir = appInfo().dir;
  try {
    setMode(appDir, mode);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  sendJson(res, 200, { mode, effortTyped: syncEffort(appDir) });
};

/**
 * Runs /clear in the chat's Claude pane when a feature ends (Keep or Discard), so the next one's conversation starts afresh.
 * Not when one starts: what was asked or planned before naming it is part of it. Callers refuse first while Claude is busy,
 * since /clear would be typed into a question.
 */
const clearChat = async (chat) => {
  if (!chat) return;
  execFileSync('herdr', ['pane', 'run', chat.paneId, '/clear'], { stdio: 'ignore', timeout: 5000 });
  logSession({ event: 'typed', pane: chat.paneId, session: chat.sessionId ?? null, text: '/clear' });
  // Time for /clear to run, so a message sent next goes to the cleared conversation and not into the input box beside it.
  await new Promise((resolve) => setTimeout(resolve, 1000));
};

/**
 * Starts a feature by name (feature.js start: develop reset to main, data/ snapshotted) and pushes develop. The chat's
 * conversation carries on into it. Refused while Claude is working or waiting on a prompt.
 */
const startFeatureNow = async (req, res) => {
  const { name } = JSON.parse(await readBody(req));
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /\n/.test(name)) {
    sendJson(res, 400, { error: 'Give the feature a short name, on one line.' });
    return;
  }
  const appDir = appInfo().dir;
  const chat = chatAgent(appDir);
  if (refuseWhileBusy(res, chat, 'Start the feature')) return;
  let feature;
  try {
    feature = startFeature(appDir, name);
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  pushInBackground(appDir);
  sendJson(res, 200, feature);
};

/**
 * The first step of Keep: runs the tests it is gated on and writes the feature summary, side by side. Answers
 * { ok, results, version, summary, summaryFallback }; Keep itself (keepFeatureNow) refuses unless these passed for the same files.
 */
const checkFeatureNow = async (req, res) => {
  const appDir = appInfo().dir;
  if (refuseWhileBusy(res, chatAgent(appDir), 'Keep it')) return;
  if (!readFeature(appDir).feature) {
    sendJson(res, 409, { error: 'No feature is being built.' });
    return;
  }
  const [gate, summary] = await Promise.all([runGate(appDir), summarise(appDir)]);
  sendJson(res, 200, { ...gate, version: nextVersion(appDir), summary: summary.text, summaryFallback: summary.fallback });
};

/**
 * Keeps the feature as the next version ({ summary, anyway }: the summary the user saw, and whether they chose to keep it although
 * its tests fail), then pushes main, its tag and develop in the background, and clears the chat for the next feature.
 */
const keepFeatureNow = async (req, res) => {
  const { summary, anyway } = JSON.parse(await readBody(req, MAX_MESSAGE * 2));
  const appDir = appInfo().dir;
  const chat = chatAgent(appDir);
  if (refuseWhileBusy(res, chat, 'Keep it')) return;
  let kept;
  try {
    kept = keepFeature(appDir, { summary: typeof summary === 'string' ? summary : '', anyway: anyway === true });
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  pushInBackground(appDir, ['main']);
  await clearChat(chat);
  sendJson(res, 200, kept);
};

/** Discards the feature: develop back to main, data/ back to how it was at the feature's start; develop is pushed and the chat cleared. */
const discardFeatureNow = async (req, res) => {
  const appDir = appInfo().dir;
  const chat = chatAgent(appDir);
  if (refuseWhileBusy(res, chat, 'Discard it')) return;
  let discarded;
  try {
    discarded = discardFeature(appDir);
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  pushInBackground(appDir);
  await clearChat(chat);
  sendJson(res, 200, discarded);
};

/** Goes back to a checkpoint ({ sha }): develop and data/ as they were then, the later checkpoints dropped; develop is pushed. */
const goBackNow = async (req, res) => {
  const { sha } = JSON.parse(await readBody(req));
  const appDir = appInfo().dir;
  if (refuseWhileBusy(res, chatAgent(appDir), 'Go back')) return;
  let wentBack;
  try {
    wentBack = goBack(appDir, String(sha ?? ''));
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  pushInBackground(appDir);
  sendJson(res, 200, wentBack);
};

/** Brings back what going back dropped, until the next message is sent; develop is pushed. */
const bringBackNow = async (req, res) => {
  const appDir = appInfo().dir;
  if (refuseWhileBusy(res, chatAgent(appDir), 'Bring them back')) return;
  let brought;
  try {
    brought = bringBack(appDir);
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  pushInBackground(appDir);
  sendJson(res, 200, brought);
};

/** Previews an old version ({ tag }) in the app pane: its code checked out, no branch moved, data/ kept to put back. */
const previewVersionNow = async (req, res) => {
  const { tag } = JSON.parse(await readBody(req));
  const appDir = appInfo().dir;
  if (refuseWhileBusy(res, chatAgent(appDir), 'Preview it')) return;
  let shown;
  try {
    shown = preview(appDir, String(tag ?? ''));
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  sendJson(res, 200, shown);
};

/** Back to the latest from a preview: the code and data/ exactly as they were before it. */
const endPreviewNow = async (req, res) => {
  const appDir = appInfo().dir;
  if (refuseWhileBusy(res, chatAgent(appDir), 'Go back to the latest')) return;
  let ended;
  try {
    ended = endPreview(appDir);
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  sendJson(res, 200, ended);
};

/** Restores an old version ({ tag }) as the next one: a new commit on main with its code, tagged; main, its tags and develop are pushed. */
const restoreVersionNow = async (req, res) => {
  const { tag } = JSON.parse(await readBody(req));
  const appDir = appInfo().dir;
  if (refuseWhileBusy(res, chatAgent(appDir), 'Restore it')) return;
  let restored;
  try {
    restored = restore(appDir, String(tag ?? ''));
  } catch (error) {
    sendJson(res, 409, { error: error.message });
    return;
  }
  pushInBackground(appDir, ['main']);
  sendJson(res, 200, restored);
};

// --- the cockpit page and the API --------------------------------------------------------

const cockpitPage = () => {
  const file = path.join(WEB_DIST, 'cockpit.html');
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: build it with \`npm --prefix ${path.dirname(WEB_DIST)} run build\``);
  }
  return readFileSync(file, 'utf8');
};

const needsJobHeader = (req, res) => {
  if (mayRunJobs(req.headers)) return false;
  res.writeHead(403).end('needs X-Studio: 1 from a localhost page\n');
  return true;
};

const handle = async (req, res) => {
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/_env/wt')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(cockpitPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_env/api/state') {
    sendJson(res, 200, currentState());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_env/api/app/log') {
    sendJson(res, 200, { tail: devLogTail(appInfo().dir) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_env/api/artifacts') {
    sendJson(res, 200, describeArtifacts(appInfo().dir));
    return;
  }
  const artifactRoute = /^\/_env\/(api\/)?artifact\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
  if (req.method === 'GET' && artifactRoute?.[1]) {
    const found = locateArtifact(artifactRoute[2]);
    const history = found?.history.map(({ version, ts, snapshot }) => ({ version, ts, local: Boolean(snapshot) }));
    // page: the latest local copy's file, for Claude to read (a plan's [Build this] hands it over).
    const page = found?.snapshot ? path.join(found.snapshot, 'index.html') : null;
    sendJson(res, found ? 200 : 404, found ? { ...found, folder: undefined, snapshot: undefined, history, local: Boolean(found.snapshot), page, label: LABEL } : { error: `no artifact ${artifactRoute[2]} is recorded` });
    return;
  }
  if (req.method === 'GET' && artifactRoute) {
    const [, , id, rest] = artifactRoute;
    if (!rest) {
      res.writeHead(301, { Location: `/_env/artifact/${id}/` }).end();
      return;
    }
    const found = locateArtifact(id);
    if (!found?.snapshot) {
      res.writeHead(302, { Location: found?.url ?? `https://claude.ai/artifact/${id}` }).end();
      return;
    }
    // /v<n>/… is that version's snapshot; anything else the latest one copied locally.
    const pinned = /^\/v(\d+)(\/.*)?$/.exec(rest);
    if (pinned && !pinned[2]) {
      res.writeHead(301, { Location: `/_env/artifact/${id}/v${pinned[1]}/` }).end();
      return;
    }
    const folder = pinned ? found.history.find((v) => v.version === Number(pinned[1]))?.snapshot : found.snapshot;
    const file = folder && artifactFile(folder, decodeURIComponent((pinned ? pinned[2] : rest).slice(1)));
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': ARTIFACT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': ARTIFACT_CSP, 'Cache-Control': 'no-cache' });
    res.end(servedArtifact(readFileSync(file), file));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/_env/artifacts/')) {
    const file = artifactFile(artifactFolder(appInfo().dir), decodeURIComponent(url.pathname.slice('/_env/artifacts/'.length)));
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': ARTIFACT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': ARTIFACT_CSP, 'Cache-Control': 'no-cache' });
    res.end(servedArtifact(readFileSync(file), file));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_env/api/session' && url.searchParams.has('stopped')) {
    // A stopped (reaped) session: its transcript as it was left, for reading before resuming it.
    const sessionId = url.searchParams.get('stopped');
    const file = SESSION_ID.test(sessionId) && transcriptPath(sessionId);
    if (!file) {
      sendJson(res, 404, { error: 'no saved Claude session ' + sessionId });
      return;
    }
    const after = url.searchParams.get('session') === sessionId && url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
    sendJson(res, 200, { sessionId, status: null, ...readTranscript(file, after), input: '', prompt: null });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_env/api/session') {
    const pane = appPane(url.searchParams.get('paneId'));
    if (!pane) {
      sendJson(res, 404, { error: "no Claude session of the app's in that pane" });
      return;
    }
    const after = url.searchParams.get('session') === pane.agent_session?.value && url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
    sendJson(res, 200, sessionView(pane, after, url.searchParams.get('screen') === '1'));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/session/send') {
    if (needsJobHeader(req, res)) return;
    await sendToSession(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_env/api/listener') {
    sendJson(res, 200, checkInListener(url.searchParams.get('id')));
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/_env/api/listener' || url.pathname === '/_env/api/listener/reveal')) {
    if (needsJobHeader(req, res)) return;
    const body = JSON.parse(await readBody(req, 100_000));
    if (typeof body.id !== 'string' || !/^[a-z0-9]{6,32}$/.test(body.id)) {
      sendJson(res, 400, { error: 'id must be a page id' });
      return;
    }
    if (url.pathname.endsWith('/reveal')) {
      const recording = listenerView(null).recording;
      sendJson(res, 200, { shown: Boolean(recording?.url && (await revealRecording(recording.url))), url: recording?.url ?? null });
      return;
    }
    sendJson(res, 200, updateListener(body));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/_env/vad/')) {
    serveVadFile(res, url.pathname.slice('/_env/vad/'.length));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/dictation-log') {
    if (needsJobHeader(req, res)) return;
    const body = JSON.parse(await readBody(req, 200_000));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'a summary must be an object' });
      return;
    }
    if (keepsClips()) keepDictationSummary(body);
    sendJson(res, 200, {});
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/transcribe') {
    if (needsJobHeader(req, res)) return;
    await transcribe(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/drawing') {
    if (needsJobHeader(req, res)) return;
    await receiveDrawing(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_env/api/artifact-shot') {
    if (needsJobHeader(req, res)) return;
    artifactShot(url, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/upload') {
    if (needsJobHeader(req, res)) return;
    await receiveUpload(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/focus-agent') {
    if (needsJobHeader(req, res)) return;
    const { paneId } = JSON.parse(await readBody(req));
    if (!appPane(paneId)) {
      res.writeHead(404).end(`no Claude session of the app's in pane ${paneId}\n`);
      return;
    }
    execFileSync('herdr', ['agent', 'focus', paneId], { stdio: 'ignore' });
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/focus-tab') {
    if (needsJobHeader(req, res)) return;
    const { tabId } = JSON.parse(await readBody(req));
    if (artifactsTab(herdrSnapshot(), appInfo().dir)?.tabId !== tabId) {
      res.writeHead(404).end(`no Artifacts tab ${tabId}\n`);
      return;
    }
    execFileSync('herdr', ['tab', 'focus', tabId], { stdio: 'ignore' });
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/close-tab') {
    if (needsJobHeader(req, res)) return;
    const { tabId } = JSON.parse(await readBody(req));
    if (artifactsTab(herdrSnapshot(), appInfo().dir)?.tabId !== tabId) {
      res.writeHead(404).end(`no Artifacts tab ${tabId}\n`);
      return;
    }
    execFileSync('herdr', ['tab', 'close', tabId], { stdio: 'ignore' });
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/artifacts/remove') {
    if (needsJobHeader(req, res)) return;
    const { id } = JSON.parse(await readBody(req));
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
      res.writeHead(400).end('remove needs an artifact id\n');
      return;
    }
    removeArtifacts(appInfo().dir, [id]);
    res.writeHead(204).end();
    return;
  }
  // The cockpit's × on a note Claude pinned beside an element of an artifact.
  if (req.method === 'POST' && url.pathname === '/_env/api/artifacts/unnote') {
    if (needsJobHeader(req, res)) return;
    const { id, nid } = JSON.parse(await readBody(req));
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || typeof nid !== 'string') {
      res.writeHead(400).end('unnote needs an artifact id and a note id\n');
      return;
    }
    removeArtifactNote(id, nid);
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/prefs') {
    if (needsJobHeader(req, res)) return;
    const { tooltips, ui } = JSON.parse(await readBody(req));
    if (tooltips !== undefined && typeof tooltips !== 'boolean') {
      res.writeHead(400).end('tooltips must be true or false\n');
      return;
    }
    const config = readConfig();
    const prefs = mergeUiPrefs(config.prefs?.ui, ui);
    if (!prefs) {
      res.writeHead(400).end('ui must be an object of short setting names to JSON values\n');
      return;
    }
    writeConfig({ ...config, prefs: { ...config.prefs, ...(tooltips === undefined ? {} : { tooltips }), ui: prefs } });
    dropSharedState();
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/action-outcome') {
    if (needsJobHeader(req, res)) return;
    // Whether what an action should lead to (web/src/lib/expect.ts) showed up in time, by the action's id.
    const { id, what, met, ms } = JSON.parse(await readBody(req));
    mkdirSync(path.dirname(ACTIONS_LOG), { recursive: true });
    appendFileSync(ACTIONS_LOG, JSON.stringify({ ts: new Date().toISOString(), id: String(id), outcome: met ? 'met' : 'timeout', what: String(what).slice(0, 200), ms: Number(ms) }) + '\n');
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/mode') {
    if (needsJobHeader(req, res)) return;
    await setModeNow(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/feature/start') {
    if (needsJobHeader(req, res)) return;
    await startFeatureNow(req, res);
    return;
  }
  const featureAction = { '/_env/api/feature/check': checkFeatureNow, '/_env/api/feature/keep': keepFeatureNow, '/_env/api/feature/discard': discardFeatureNow, '/_env/api/feature/go-back': goBackNow, '/_env/api/feature/bring-back': bringBackNow, '/_env/api/version/preview': previewVersionNow, '/_env/api/version/end-preview': endPreviewNow, '/_env/api/version/restore': restoreVersionNow }[url.pathname];
  if (req.method === 'POST' && featureAction) {
    if (needsJobHeader(req, res)) return;
    await featureAction(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_env/api/run') {
    if (needsJobHeader(req, res)) return;
    await runJob(req, res);
    return;
  }
  res.writeHead(404).end();
};

if (require.main === module) {
  http
    .createServer((req, res) => {
      if (req.method === 'POST' && req.url !== '/_env/api/action-outcome') {
        dropSharedState();
        const startedAt = Date.now();
        res.studioActionId = /^[A-Za-z0-9]{1,32}$/.test(req.headers['x-studio-action-id'] ?? '') ? req.headers['x-studio-action-id'] : '';
        res.on('close', () => {
          try {
            mkdirSync(path.dirname(ACTIONS_LOG), { recursive: true });
            appendFileSync(ACTIONS_LOG, JSON.stringify(actionRecord(req, res, startedAt)) + '\n');
          } catch {}
        });
      }
      return handle(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end(`${error.message}\n`);
      });
    })
    .listen(CONTROL_PORT, '127.0.0.1', () => process.stderr.write(`studio server on http://localhost:${CONTROL_PORT}\n`));
  // A new session (or one /clear-ed) gets the effort for the mode once it is idle, and so does a mode changed while Claude worked.
  setInterval(() => syncEffort(appInfo().dir), EFFORT_SYNC_MS);
  // A push that failed (offline, say) is tried again every minute too, so "not backed up" goes once it can.
  setInterval(() => {
    const appDir = appInfo().dir;
    if (readFeature(appDir).unpushed.length) pushInBackground(appDir);
  }, PUSH_RETRY_MS);
}

module.exports = { serveVadFile, appAgents, appInfo, devLogTail, looksCrashed, artifactFile, artifactShotArgs, actionRecord, checkInListener, cleanTranscript, answerFreeText, inApp, isLocalHost, jobScript, keepDrawing, keepUpload, mayRunJobs, mergeUiPrefs, notePageContext, pausedOffers, recordingDir, servedArtifact, shellQuote, streamJob, suspectTranscript, takeRestoredInput, tabState, updateListener, wavStats };
