'use strict';

/**
 * A registry of the Claude artifacts made in each git worktree, so a worktree's artifact index
 * (the artifact-index skill) and the cockpit can list, preview and relate them long after the
 * scratchpad copies under /private/tmp are gone.
 *
 * Every worktree has a folder under STUDIO_ARTIFACTS_DIR (default ~/.studio/artifacts),
 * named after its path the way Claude Code names project folders:
 *   registry.jsonl         one line per publish: session, title, url, description, version, snapshot, and the feature
 *                          name when the page is a plan (planName)
 *   snapshots/<id>/v<n>/   that version's page (as index.html) and its supporting files
 *   relations.json         { superseded: { <id>: <id of what replaced it> }, removed: { <id>: <when> } },
 *                          written by consolidation and the cockpit's remove button
 *   index.html, index.json the index Claude wrote (artifact-index skill) and when, from how many publishes
 *   notes.json             { <id>: [{ nid, selector, text, version, at }] }: Claude's answers to questions about
 *                          a picked element, shown beside it in the cockpit's preview of that version only
 *
 * Usage: node lib/artifacts.js record              PostToolUse hook: one publish, as JSON on stdin
 *        node lib/artifacts.js backfill [--dry-run] every past publish found in Claude's transcripts
 *        node lib/artifacts.js where [dir]          the worktree folder for dir (default: cwd), as JSON
 *        node lib/artifacts.js mark-built <url> [dir]   record that the index was just written and published
 *        node lib/artifacts.js supersede <new-id> <old-id>… [dir]   mark old artifacts replaced by new-id
 *        node lib/artifacts.js remove <id>… [dir]   hide artifacts from the list until they are published again
 *        node lib/artifacts.js note <id|url> <selector> <text>   pin an answer beside an element of the latest version
 *        node lib/artifacts.js unnote <id|url> <nid>   take a note away
 *
 * Run tests: node --test lib/artifacts.test.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const storeRoot = () => process.env.STUDIO_ARTIFACTS_DIR ?? path.join(process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio'), 'artifacts');
const projectsDir = () => process.env.STUDIO_REAPER_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude', 'projects');

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

/** The git worktree a directory belongs to, else the directory itself. */
const worktreeOf = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(dir);
  }
};

const folderName = (worktree) => worktree.replace(/[^A-Za-z0-9]/g, '-');

const folderFor = (worktree) => path.join(storeRoot(), folderName(worktree));

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/** Every publish recorded for a worktree folder, oldest first. */
const readRegistry = (folder) => {
  let text = '';
  try {
    text = fs.readFileSync(path.join(folder, 'registry.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
};

const artifactId = (url) => url.split('/').pop();

const pageTitle = (html) => {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html ?? '');
  return match ? match[1].replace(/\s+/g, ' ').trim() || null : null;
};

/**
 * The feature a plan page is for, from its `<meta name="studio-plan" content="…">` (the Plan mode rules ask Claude for one, in
 * feature.js): a short name on one line, else null for a page that isn't a plan.
 */
const planName = (html) => {
  const tag = /<meta\b[^>]*\bname\s*=\s*["']studio-plan["'][^>]*>/i.exec(html ?? '')?.[0];
  const content = tag && /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const name = content ? (content[1] ?? content[2]).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim() : '';
  return name ? name.slice(0, 80) : null;
};

const isPublish = (input) => Boolean(input?.file_path) && (input.action === undefined || input.action === 'publish') && !input.asset && !input.type_url;

// A `files` source may be a path, { from }, an artifact copy ({ artifact, path }) or null (a removal).
const localSource = (source) => (typeof source === 'string' ? source : source && typeof source === 'object' && typeof source.from === 'string' ? source.from : null);

/**
 * Copies a publish's page and its local supporting files into dest: the page as index.html, each
 * supporting file at its published path. Files that no longer exist, or would land outside dest, are skipped.
 */
const snapshot = (input, cwd, dest) => {
  fs.mkdirSync(dest, { recursive: true });
  const base = input.root ? path.resolve(cwd, input.root) : cwd;
  const copied = [];
  const copy = (from, to) => {
    const target = path.resolve(dest, to);
    if (!target.startsWith(dest + path.sep) || !fs.existsSync(from) || !fs.statSync(from).isFile()) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    copied.push(to);
  };
  copy(path.resolve(cwd, input.file_path), 'index.html');
  const files = input.files ?? {};
  const entries = Array.isArray(files) ? files.map((file) => [file.path, file.path]) : Object.entries(files);
  for (const [published, source] of entries) {
    const from = localSource(source);
    if (from && published !== 'index.html') copy(path.resolve(base, from), published);
  }
  return copied;
};

/**
 * Files one publish under its worktree: a registry line, and a snapshot of what it published.
 * Returns the entry, or null when it isn't one to record (a read, an asset upload, the index itself,
 * or a result without an artifact url).
 */
const record = ({ sessionId, toolUseId = null, cwd, ts = new Date().toISOString(), input, response }) => {
  if (!isPublish(input)) return null;
  const url = (input.url && ARTIFACT_URL.exec(input.url)?.[0]) ?? ARTIFACT_URL.exec(typeof response === 'string' ? response : JSON.stringify(response ?? ''))?.[0];
  if (!url) return null;
  const worktree = worktreeOf(cwd);
  const folder = folderFor(worktree);
  const page = path.resolve(cwd, input.file_path);
  if (page === path.join(folder, 'index.html')) return null;
  const id = artifactId(url);
  const registry = readRegistry(folder);
  if (registry.some((entry) => (toolUseId && entry.toolUseId === toolUseId) || (entry.id === id && entry.ts === ts))) return null;
  const version = registry.filter((entry) => entry.id === id).length + 1;
  const snapshotDir = path.join('snapshots', id, `v${version}`);
  const files = snapshot(input, cwd, path.join(folder, snapshotDir));
  let html = null;
  try {
    html = fs.readFileSync(page, 'utf8');
  } catch {}
  const entry = {
    ts,
    sessionId,
    toolUseId,
    worktree,
    id,
    url,
    version,
    title: pageTitle(html) ?? input.title ?? null,
    plan: planName(html),
    description: input.description ?? null,
    filePath: page,
    snapshot: files.includes('index.html') ? snapshotDir : null,
    files,
  };
  fs.appendFileSync(path.join(folder, 'registry.jsonl'), JSON.stringify(entry) + '\n');
  return entry;
};

/** The publishes in one transcript, paired with the result that carries each one's url. */
const publishesIn = (transcript) => {
  const calls = new Map();
  const paired = new Set();
  const out = [];
  let text = '';
  try {
    text = fs.readFileSync(transcript, 'utf8');
  } catch {
    return out;
  }
  let sessionCwd = null;
  for (const line of text.split('\n')) {
    if (!line.includes('Artifact') && !line.includes('tool_result') && (sessionCwd || !line.includes('"cwd"'))) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    sessionCwd ??= rec.cwd ?? null;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      // Claude Code also keeps copies of messages (api-request-blob records), with no cwd and sometimes after the real pair.
      if (part?.type === 'tool_use' && part.name === 'Artifact' && isPublish(part.input) && !paired.has(part.id) && !calls.get(part.id)?.cwd) {
        calls.set(part.id, { sessionId: rec.sessionId, toolUseId: part.id, cwd: rec.cwd, ts: rec.timestamp, input: part.input });
      } else if (part?.type === 'tool_result' && calls.has(part.tool_use_id) && !part.is_error) {
        const call = calls.get(part.tool_use_id);
        out.push({ ...call, cwd: call.cwd ?? rec.cwd, ts: call.ts ?? rec.timestamp, response: part.content });
        calls.delete(part.tool_use_id);
        paired.add(part.tool_use_id);
      }
    }
  }
  return out.map((publish) => (publish.cwd ? publish : { ...publish, cwd: sessionCwd }));
};

/** Records every past publish found under Claude's projects folder, oldest first; already-recorded ones are skipped. */
const backfill = ({ dryRun = false } = {}) => {
  const publishes = [];
  let projects = [];
  try {
    projects = fs.readdirSync(projectsDir());
  } catch {}
  for (const project of projects) {
    const dir = path.join(projectsDir(), project);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
    } catch {}
    for (const file of files) publishes.push(...publishesIn(path.join(dir, file)));
  }
  publishes.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (dryRun) return publishes.map(({ ts, cwd, input }) => ({ ts, worktree: worktreeOf(cwd ?? '/'), file: input.file_path }));
  return publishes.map((publish) => record(publish)).filter(Boolean);
};

/** What the cockpit and the skill need about a worktree's artifacts: each artifact with its versions, the index, and how stale it is. */
const describe = (worktree) => {
  const folder = folderFor(worktree);
  const registry = readRegistry(folder);
  const relations = readJson(path.join(folder, 'relations.json'), { superseded: {} });
  const index = readJson(path.join(folder, 'index.json'), null);
  const byId = new Map();
  for (const entry of registry) {
    const artifact = byId.get(entry.id) ?? { id: entry.id, url: entry.url, versions: [] };
    artifact.versions.push({ ts: entry.ts, sessionId: entry.sessionId, version: entry.version, snapshot: entry.snapshot, description: entry.description });
    artifact.title = entry.title ?? artifact.title ?? null;
    artifact.description = entry.description ?? artifact.description ?? null;
    byId.set(entry.id, artifact);
  }
  // A removed artifact stays in the registry (so a backfill can't re-add it) and is hidden until it is published again.
  const removed = relations.removed ?? {};
  const artifacts = [...byId.values()].filter((artifact) => !(removed[artifact.id] && artifact.versions.at(-1).ts <= removed[artifact.id])).map((artifact) => ({
    ...artifact,
    name: artifact.title ?? artifact.description ?? artifact.id,
    sessions: [...new Set(artifact.versions.map((version) => version.sessionId))],
    latest: artifact.versions.at(-1),
    supersededBy: relations.superseded?.[artifact.id] ?? null,
  }));
  return {
    worktree,
    folder,
    artifacts: artifacts.sort((a, b) => (a.latest.ts < b.latest.ts ? 1 : -1)),
    publishes: registry.length,
    index: index && fs.existsSync(path.join(folder, 'index.html')) ? { ...index, newSince: Math.max(0, registry.length - (index.publishes ?? 0)) } : null,
  };
};

/**
 * Finds an artifact by id in any worktree's registry, so its local URL works from any host and after
 * its worktree is pruned: the worktree it was made in, its latest version, and that version's snapshot
 * folder when there is one. Null when no registry has it.
 */
const locate = (id) => {
  let folders = [];
  try {
    folders = fs.readdirSync(storeRoot());
  } catch {
    return null;
  }
  let found = null;
  for (const name of folders) {
    const folder = path.join(storeRoot(), name);
    for (const entry of readRegistry(folder)) {
      if (entry.id === id && (!found || entry.ts > found.entry.ts)) found = { folder, entry };
    }
  }
  if (!found) return null;
  const versions = readRegistry(found.folder).filter((entry) => entry.id === id);
  const latest = [...versions].reverse().find((entry) => entry.snapshot) ?? null;
  return {
    id,
    folder: found.folder,
    url: found.entry.url,
    worktree: found.entry.worktree,
    name: [...versions].reverse().find((entry) => entry.title)?.title ?? [...versions].reverse().find((entry) => entry.description)?.description ?? id,
    versions: versions.length,
    snapshot: latest ? path.join(found.folder, latest.snapshot) : null,
    // Every version, oldest first, each with its own snapshot folder (null when it wasn't copied locally).
    history: versions.map((entry) => ({ version: entry.version, ts: entry.ts, snapshot: entry.snapshot ? path.join(found.folder, entry.snapshot) : null })),
    // The page as its session wrote it, where an edit goes (the snapshot is a copy).
    filePath: found.entry.filePath ?? null,
    // The feature its latest local copy is a plan for (planName), or null when that isn't a plan.
    plan: latest?.plan ?? null,
    notes: readJson(path.join(found.folder, 'notes.json'), {})[id] ?? [],
  };
};

/** Pins a note (Claude's answer about one element) to the artifact's latest version; null when no registry has the artifact. */
const addNote = (id, selector, text, now = new Date()) => {
  const found = locate(id);
  if (!found) return null;
  const file = path.join(found.folder, 'notes.json');
  const notes = readJson(file, {});
  const note = { nid: now.getTime().toString(36), selector, text, version: found.history.at(-1).version, at: now.toISOString() };
  notes[id] = [...(notes[id] ?? []), note];
  fs.writeFileSync(file, JSON.stringify(notes, null, 2) + '\n');
  return note;
};

/** Takes a note away; false when there was no such note. */
const removeNote = (id, nid) => {
  const found = locate(id);
  if (!found) return false;
  const file = path.join(found.folder, 'notes.json');
  const notes = readJson(file, {});
  const kept = (notes[id] ?? []).filter((note) => note.nid !== nid);
  if (kept.length === (notes[id] ?? []).length) return false;
  notes[id] = kept;
  fs.writeFileSync(file, JSON.stringify(notes, null, 2) + '\n');
  return true;
};

const markBuilt = (worktree, url) => {
  const folder = folderFor(worktree);
  const meta = { builtAt: new Date().toISOString(), publishes: readRegistry(folder).length, url: ARTIFACT_URL.exec(url ?? '')?.[0] ?? null };
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
};

const supersede = (worktree, byId, oldIds) => {
  const folder = folderFor(worktree);
  const file = path.join(folder, 'relations.json');
  const relations = readJson(file, { superseded: {} });
  relations.superseded = { ...relations.superseded, ...Object.fromEntries(oldIds.map((id) => [id, byId])) };
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(relations, null, 2) + '\n');
  return relations;
};

const remove = (worktree, ids) => {
  const folder = folderFor(worktree);
  const file = path.join(folder, 'relations.json');
  const relations = readJson(file, { superseded: {} });
  const now = new Date().toISOString();
  relations.removed = { ...relations.removed, ...Object.fromEntries(ids.map((id) => [id, now])) };
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(relations, null, 2) + '\n');
  return relations;
};

const readStdin = () => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (command === 'record') {
    // A hook must never fail or slow the publish it follows.
    try {
      const hook = JSON.parse(readStdin());
      if (hook.tool_name === 'Artifact') record({ sessionId: hook.session_id, toolUseId: hook.tool_use_id ?? null, cwd: hook.cwd, input: hook.tool_input, response: hook.tool_response });
    } catch {}
    process.exit(0);
  } else if (command === 'backfill') {
    const recorded = backfill({ dryRun: args.includes('--dry-run') });
    print({ recorded: recorded.length, worktrees: [...new Set(recorded.map((entry) => entry.worktree))] });
  } else if (command === 'where') {
    print(describe(worktreeOf(args[0] ?? process.cwd())));
  } else if (command === 'mark-built') {
    print(markBuilt(worktreeOf(args[1] ?? process.cwd()), args[0]));
  } else if (command === 'supersede') {
    const [byId, ...rest] = args;
    const dirArg = rest.length > 1 && fs.existsSync(rest.at(-1)) && fs.statSync(rest.at(-1)).isDirectory() ? rest.pop() : process.cwd();
    print(supersede(worktreeOf(dirArg), byId, rest));
  } else if (command === 'remove') {
    const dirArg = args.length > 1 && fs.existsSync(args.at(-1)) && fs.statSync(args.at(-1)).isDirectory() ? args.pop() : process.cwd();
    print(remove(worktreeOf(dirArg), args));
  } else if (command === 'note' && args.length === 3) {
    const note = addNote(artifactId(args[0]), args[1], args[2]);
    if (!note) {
      process.stderr.write(`no worktree recorded artifact ${args[0]}\n`);
      process.exit(1);
    }
    print(note);
  } else if (command === 'unnote' && args.length === 2) {
    print({ removed: removeNote(artifactId(args[0]), args[1]) });
  } else {
    process.stderr.write('usage: artifacts.js record|backfill [--dry-run]|where [dir]|mark-built <url> [dir]|supersede <new-id> <old-id>… [dir]|remove <id>… [dir]|note <id|url> <selector> <text>|unnote <id|url> <nid>\n');
    process.exit(1);
  }
}

module.exports = { addNote, backfill, describe, folderFor, locate, markBuilt, pageTitle, planName, publishesIn, readRegistry, record, remove, removeNote, supersede, worktreeOf };
