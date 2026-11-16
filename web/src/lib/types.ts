export type AgentStatus = 'blocked' | 'working' | 'done' | 'idle' | 'unknown'

export type Agent = {
  paneId: string
  tabId: string
  tab: string
  status: AgentStatus
  commands: string[]
  sessionId: string
  title: string | null
  /** When the session last wrote to its transcript. */
  active?: string | null
}

/** A stopped session the cockpit offers to resume; `by` is who stopped it (null in entries logged before that was recorded). */
export type PausedSession = { sessionId: string; ts: string; how: string; by: 'reaper' | 'you' | null; paneId: string; tabId: string; title: string | null; active?: string | null }

/** A herdr tab a button started: its state is `idle`, `running` or `claude-<status>` (tabState in studio-server.js). */
export type ButtonTab = { tabId: string; state: string }

/** The app being built, its Claude sessions and what its buttons started, as /_env/api/state reports them. */
export type App = {
  /** Its folder. */
  dir: string
  name: string
  /** Where its dev server answers, e.g. http://localhost:4001. */
  url: string
  /** Whether its dev server is up. */
  running: boolean
  /** Whether a job is running for it on the server. */
  busy: boolean
  tabs: Record<string, ButtonTab>
  agents: Agent[]
  paused: PausedSession[]
}

export type ControlState = {
  app: App
  /** Settings shared by every page. */
  prefs?: { tooltips: boolean; ui?: Record<string, unknown> }
}

export type SessionMessage = {
  kind: 'you' | 'claude' | 'tool' | 'note' | 'queue'
  text: string
  detail?: string
  /** A message you sent while Claude was working, held in Claude Code's queue. */
  queued?: boolean
  /** For a queue event: what happened to a queued item (resolveQueue pairs them up). */
  op?: 'enqueue' | 'absorbed' | 'removed' | 'dequeue' | 'popAll'
}

export type SessionPrompt = {
  question: string
  /**
   * `checked` is set on a multi-select question's options, whose number key ticks or unticks them.
   * `free` marks a question's text field ("Type something."), with what has been typed into it in `typed`.
   */
  options: { key: string; label: string; checked?: boolean; free?: boolean; typed?: string }[]
  /** The option the ❯ is on. */
  focused: string | null
  /** A multi-select question's button: Next, or Submit on the last question. */
  submit?: string
}

export type SessionView = {
  sessionId: string | null
  status: AgentStatus
  offset: number
  reset: boolean
  messages: SessionMessage[]
  input: string
  prompt: SessionPrompt | null
  screen?: string
}

export type ArtifactVersion = { ts: string; sessionId: string; version: number; snapshot: string | null; description: string | null }

/** Claude's answer about one element of an artifact, shown beside it in the preview of the version it was made on. */
export type ArtifactNote = { nid: string; selector: string; text: string; version: number; at: string }

/** One artifact made for the app, as artifacts.js describes it. */
export type ArtifactInfo = {
  id: string
  url: string
  name: string
  title: string | null
  description: string | null
  versions: ArtifactVersion[]
  sessions: string[]
  latest: ArtifactVersion
  /** The id of the artifact that replaced this one in a consolidation. */
  supersededBy: string | null
}

export type ArtifactsView = {
  worktree: string
  artifacts: ArtifactInfo[]
  publishes: number
  /** The index Claude last wrote, or null before the first one. */
  index: { builtAt: string; publishes: number; url: string | null; newSince: number } | null
}
