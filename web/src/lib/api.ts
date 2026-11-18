import type { ArtifactNote, ArtifactsView, ControlState, FeatureCheck, Mode, Preview, SessionView, WentBack } from './types'

const API = '/_env/api'
const HEADERS = { 'Content-Type': 'application/json', 'X-Studio': '1' }

// Where actions come from (the page, and its part), for the server's action log.
let actionSource = 'unknown'
export const setActionSource = (source: string) => {
  actionSource = source
}

export const newActionId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// Each POST is one action: its id ties its line in actions.jsonl to its job's log, and to how its expectation (lib/expect) turned out.
const post = (path: string, body: unknown, id = newActionId()) =>
  fetch(API + path, { method: 'POST', headers: { ...HEADERS, 'X-Studio-Action-Id': id, 'X-Studio-Source': actionSource }, body: JSON.stringify(body) })

/** The server's view of the app and its Claude sessions, or null while it isn't answering. */
export const getState = async (query = ''): Promise<ControlState | null> => {
  try {
    const res = await fetch(API + '/state' + query)
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as ControlState
  } catch {
    return null
  }
}

/** Streams a job's output to onText as it arrives. Resolves to whether it ended with the server's [done] line. */
export const streamJob = async (path: string, body: unknown, onText: (text: string) => void, id?: string): Promise<boolean> => {
  let all = ''
  try {
    const res = await post(path, body, id)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      all += decoder.decode(value, { stream: true })
      onText(all)
    }
  } catch (error) {
    all += '\n' + String(error)
    onText(all)
  }
  return all.trimEnd().endsWith('[done]')
}

export const focusTab = (tabId: string) => post('/focus-tab', { tabId })
export const focusAgent = (paneId: string) => post('/focus-agent', { paneId })
export const closeTab = (tabId: string, id?: string) => post('/close-tab', { tabId }, id)
/** Logs whether an action's expectation (lib/expect) showed up in time, beside its line in actions.jsonl. */
export const reportOutcome = (id: string, what: string, met: boolean, ms: number) => post('/action-outcome', { id, what, met, ms }).catch(() => undefined)

/** Hides an artifact from the app's list until it is published again; the claude.ai page is untouched. */
export const removeArtifact = (id: string) => post('/artifacts/remove', { id })
/** Takes away a note Claude pinned beside an element of an artifact. */
export const unnoteArtifact = (id: string, nid: string) => post('/artifacts/unnote', { id, nid })
/** Starts a feature by name (and clears the chat's conversation). Resolves to an error to show, or null. */
export const startFeature = async (name: string): Promise<string | null> => {
  try {
    const res = await post('/feature/start', { name })
    return res.ok ? null : (((await res.json()) as { error?: string }).error ?? 'The feature could not be started.')
  } catch {
    return "The studio isn't answering, so the feature could not be started."
  }
}
/** Posts a feature action, resolving to the server's answer or { error } to show. */
const featureAction = async <T>(path: string, body: unknown, failed: string): Promise<T | { error: string }> => {
  try {
    const res = await post(path, body)
    const json = (await res.json().catch(() => ({}))) as T & { error?: string }
    return res.ok ? json : { error: json.error ?? failed }
  } catch {
    return { error: "The studio isn't answering. " + failed }
  }
}
/** Keep's first step: runs the app's tests and type check and writes the feature's summary (slow: tens of seconds). */
export const checkFeature = () => featureAction<FeatureCheck>('/feature/check', {}, 'The tests could not be run.')
/** Keeps the feature as the next version, with the summary the user saw; `anyway` keeps it although its tests fail. */
export const keepFeature = (summary: string, anyway: boolean) => featureAction<{ version: string; sha: string; summary: string }>('/feature/keep', { summary, anyway }, 'The feature could not be kept.')
/** Throws the feature away: the code back to the latest version, the data back to how it was when the feature started. */
export const discardFeature = () => featureAction<{ name: string; checkpoints: number }>('/feature/discard', {}, 'The feature could not be discarded.')
/** Goes back to a checkpoint: the code and data as they were then, the later checkpoints dropped (until the next message). */
export const goBackTo = (sha: string) => featureAction<WentBack>('/feature/go-back', { sha }, 'The app could not go back to that checkpoint.')
/** Brings back the checkpoints going back dropped, and the code and data as they were. */
export const bringBack = () => featureAction<{ checkpoints: number }>('/feature/bring-back', {}, 'They could not be brought back.')
/** Previews an old version in the app pane: its code, with the data as it is (put back on the way out). */
export const previewVersion = (tag: string) => featureAction<Preview>('/version/preview', { tag }, 'That version could not be previewed.')
/** Back to the latest version from a preview: the code and data exactly as they were. */
export const endPreview = () => featureAction<{ tag: string }>('/version/end-preview', {}, 'The app could not go back to the latest version.')
/** Restores an old version as a new one: its code, on top of the latest, tagged as the next version. */
export const restoreVersion = (tag: string) => featureAction<{ version: string; sha: string; restored: string }>('/version/restore', { tag }, 'That version could not be restored.')
/** Sets the chat's Ask / Plan / Build switch, from the next message on (and Claude's effort for it). */
export const setMode = (mode: Mode) => featureAction<{ mode: Mode }>('/mode', { mode }, 'The mode could not be changed.')
export const setTooltips = (tooltips: boolean) => post('/prefs', { tooltips })
/** The last 50 lines of the app's dev server output (data/logs/dev.log), '' when there are none or the server isn't answering. */
export const getAppLog = async (): Promise<string> => {
  try {
    const res = await fetch(API + '/app/log')
    return res.ok ? ((await res.json()) as { tail: string }).tail : ''
  } catch {
    return ''
  }
}
/** Saves one UI setting every page shares (useSharedPref). */
export const setUiPref = (key: string, value: unknown) => post('/prefs', { ui: { [key]: value } })
export const getSession = async (params: URLSearchParams): Promise<SessionView | null> => {
  const res = await fetch(API + '/session?' + params)
  return res.ok ? ((await res.json()) as SessionView) : null
}

/**
 * Types into a session: `{ key }` presses one key, `{ text }` sends a message (with `context`, what the page shows, for that prompt only).
 * `label` names the worktree where the page's host doesn't (the index). Resolves to the server's error, if any.
 */
export const sendToSession = async (body: { paneId: string; label?: string; key?: string; text?: string; answer?: { key: string; text: string }; context?: string; clear?: boolean }): Promise<string | null> => {
  const res = await post('/session/send', body)
  if (res.ok) return null
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  return json.error ?? res.statusText
}

/** Transcribes a recording with whisper-server: its text, or the server's error. */
/** `recording` says which stretch of speech of which recording this is; the server keeps it beside a clip whose text looks wrong. */
export const transcribe = async (audio: Blob, recording?: Record<string, string | number>): Promise<{ text: string } | { error: string }> => {
  try {
    const res = await fetch(API + '/transcribe', { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm', 'X-Studio': '1', 'X-Studio-Action-Id': newActionId(), 'X-Studio-Source': actionSource, ...(recording ? { 'X-Studio-Recording': JSON.stringify(recording) } : {}) }, body: audio })
    const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
    return res.ok && typeof json.text === 'string' ? { text: json.text } : { error: json.error ?? res.statusText }
  } catch (error) {
    return { error: String(error) }
  }
}

/** Saves a drawing from the Draw tab on the studio server: the path a session can Read it at, or the server's error. */
export const uploadDrawing = async (png: Blob): Promise<{ path: string } | { error: string }> => {
  try {
    const res = await fetch(API + '/drawing', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Studio': '1', 'X-Studio-Action-Id': newActionId(), 'X-Studio-Source': actionSource }, body: png })
    const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string }
    return res.ok && typeof json.path === 'string' ? { path: json.path } : { error: json.error ?? res.statusText }
  } catch (error) {
    return { error: String(error) }
  }
}

/** A local artifact version as headless Chrome renders it at w×h CSS pixels (scale pixels each), scrolled to y, in the cockpit's theme; null when it couldn't. */
export const artifactShot = async (params: { id: string; v: number; y: number; w: number; h: number; scale: number; dark: boolean }): Promise<Blob | null> => {
  try {
    const { id, v, y, w, h, scale, dark } = params
    const query = new URLSearchParams({ id, v: String(v), y: String(Math.round(y)), w: String(Math.round(w)), h: String(Math.round(h)), scale: String(scale), dark: dark ? '1' : '0' })
    const res = await fetch(API + '/artifact-shot?' + query, { headers: { 'X-Studio': '1' } })
    return res.ok ? await res.blob() : null
  } catch {
    return null
  }
}

/** Keeps a copy of a file dropped on a chat on the studio server, under worktree `label`: the path a session can Read it at, or the server's error. */
export const uploadFile = async (file: File, label: string): Promise<{ path: string } | { error: string }> => {
  try {
    const query = new URLSearchParams({ name: file.name, label })
    const res = await fetch(API + '/upload?' + query, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Studio': '1', 'X-Studio-Action-Id': newActionId(), 'X-Studio-Source': actionSource }, body: file })
    const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string }
    return res.ok && typeof json.path === 'string' ? { path: json.path } : { error: json.error ?? res.statusText }
  } catch (error) {
    return { error: String(error) }
  }
}

/** How a recording ended, kept beside its clips by the server (logs/dictation) to look into text that came out wrong or cut short. */
export const logDictation = (summary: Record<string, unknown>) => void post('/dictation-log', summary).catch(() => undefined)

/** Which page owns the mic (studio-server.js keeps one at a time), what it's recording, and for page `id`: a stop to act on (if it's the owner) or a recording's text. */
export type Recording = { startedAt: number; where: string; url: string }
export type StopHow = 'send' | 'edit' | 'discard'
export type Listener = { id: string | null; stale: boolean; recording: Recording | null; stop: { how: StopHow; to: string } | null; result: { text: string; send: boolean; error: string | null } | null }
/** Checks page `id` in (keeping the mic, if it's the owner) and collects what's for it. */
export const getListener = async (id: string): Promise<Listener | null> => {
  try {
    const res = await fetch(API + '/listener?id=' + id)
    return res.ok ? ((await res.json()) as Listener) : null
  } catch {
    return null
  }
}
type ListenerUpdate = { id: string; claim?: true; recording?: Recording | null; stop?: StopHow; result?: { to: string; text: string; send: boolean; error: string | null }; release?: true }
/** Claims the mic, says what the owner is recording, stops a recording from any page, hands its text to the page that stopped it, or lets the mic go. */
export const updateListener = async (body: ListenerUpdate, keepalive = false): Promise<Listener | null> => {
  try {
    const res = await fetch(API + '/listener', { method: 'POST', keepalive, headers: { ...HEADERS, 'X-Studio-Action-Id': newActionId(), 'X-Studio-Source': actionSource }, body: JSON.stringify(body) })
    return res.ok ? ((await res.json()) as Listener) : null
  } catch {
    return null
  }
}
/** Has the server bring the recording page's Chrome tab forward: false when it couldn't. */
export const revealRecording = async (id: string): Promise<boolean> => {
  const res = await post('/listener/reveal', { id }).catch(() => null)
  const json = res?.ok ? ((await res.json()) as { shown: boolean }) : null
  return Boolean(json?.shown)
}

/** Presses Esc in a session: `restored` is the message an interrupt put back in herdr's input box, which the server cleared from it. */
export const pressEsc = async (body: { paneId: string; label?: string }): Promise<{ error?: string; restored?: string }> => {
  const res = await post('/session/send', { ...body, key: 'esc' })
  const json = (await res.json().catch(() => ({}))) as { error?: string; restored?: string }
  return res.ok ? { restored: json.restored || undefined } : { error: json.error ?? res.statusText }
}

/** The app's artifacts, or null while the studio server isn't answering. */
export const getArtifacts = async (): Promise<ArtifactsView | null> => {
  try {
    const res = await fetch(API + '/artifacts')
    return res.ok ? ((await res.json()) as ArtifactsView) : null
  } catch {
    return null
  }
}

/** Where an artifact lives and whether a local copy exists, from the registry; null when none recorded it. */
export const getArtifact = async (id: string): Promise<{ id: string; url: string; worktree: string; name: string; versions: number; history: { version: number; ts: string; local: boolean }[]; local: boolean; filePath: string | null; notes?: ArtifactNote[]; plan?: string | null; page?: string | null } | null> => {
  try {
    const res = await fetch(API + '/artifact/' + encodeURIComponent(id))
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
