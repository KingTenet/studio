import type { Agent, App, ButtonTab, PausedSession } from './types'

/** What a control does when clicked; the page's ControlsProvider carries it out. */
export type Action =
  | { type: 'run'; action: string; extra?: Record<string, unknown>; confirm?: string }
  | { type: 'open-agent'; agent: Agent }
  | { type: 'open-tab'; tab: ButtonTab }
  | { type: 'focus-tab'; tabId: string }
  | { type: 'close-tab'; tabId: string; confirm: string }
  | { type: 'url'; url: string }
  | { type: 'call'; call: () => void }

export type LookName = 'blocked' | 'working' | 'done' | 'idle' | 'unknown' | 'running' | 'finished' | 'paused' | 'on' | 'exited' | 'command'

export type Look = { name: LookName; dot: string; title: string }

export const LOOKS: Record<LookName, Look> = {
  blocked: { name: 'blocked', dot: '⚑', title: 'needs you: a permission prompt or a question' },
  working: { name: 'working', dot: '✦', title: 'working' },
  done: { name: 'done', dot: '●', title: 'finished; not looked at since' },
  idle: { name: 'idle', dot: '✓', title: 'waiting for you' },
  unknown: { name: 'idle', dot: '✓', title: 'status unknown' },
  running: { name: 'running', dot: '…', title: 'running' },
  finished: { name: 'finished', dot: '○', title: 'nothing running; the tab is still open' },
  paused: { name: 'paused', dot: '⏸', title: 'stopped by the idle reaper; click to resume it' },
  on: { name: 'on', dot: '●', title: 'running' },
  exited: { name: 'exited', dot: '!', title: 'exited; its tab is still open' },
  command: { name: 'running', dot: '⧗', title: 'waiting on a command it started' },
}

/** A status's chip colours and pulse; shared by the chips and the cockpit's session cards. */
export const LOOK_CLASS: Record<LookName, string> = {
  blocked: 'border-red-600 bg-red-600 text-white animate-pulse',
  working: 'border-sky-600 bg-sky-600 text-white animate-pulse',
  done: 'border-teal-500/70 text-teal-700 dark:text-teal-400',
  idle: 'border-lime-600/50 text-lime-700 dark:text-lime-400',
  unknown: 'border-lime-600/50 text-lime-700 dark:text-lime-400',
  running: 'border-amber-500 text-amber-700 dark:text-amber-400 animate-pulse',
  finished: 'border-border text-muted-foreground',
  paused: 'border-dashed border-border text-muted-foreground',
  on: 'border-emerald-600 bg-emerald-600 text-white',
  exited: 'border-red-500 text-red-600 dark:text-red-400',
  command: 'border-amber-500 text-amber-700 dark:text-amber-400 animate-pulse',
}

/** A herdr tab, Claude session or dev server: click goes to it, × stops it. */
export type ChipModel = {
  kind: 'chip'
  key: string
  name: string
  look: Look
  title: string
  onClick?: Action
  onClose?: Action
  closeTitle?: string
  disabled: boolean
  closeDisabled: boolean
  /** The pane the chip stands for, so the cockpit can mark the one it shows. */
  pane?: string
  /** The live session whose ◇ modes control sits in the chip. */
  agent?: Agent
  /** The stopped session a ⏸ chip resumes. */
  paused?: PausedSession
  /** What the chip shows in place of its name: a plain Claude session's title, shortened. */
  short?: string
}

/** Something not running yet: ▶ starts it. */
export type StartModel = { kind: 'start'; key: string; name: string; title: string; onClick: Action; disabled: boolean }

export type ControlModel = ChipModel | StartModel

// A session herdr calls idle while it waits on a command it started (a poller, a test run) is busy, not idle.
export const waitingOn = (agent: Agent | undefined) => (agent?.commands?.length && !['working', 'blocked'].includes(agent.status) ? agent.commands : null)

export const commandsTitle = (commands: string[]) =>
  '\nRunning: ' +
  commands
    .map((command) => {
      const first = command.split('\n')[0]
      return first.length > 80 || first !== command ? first.slice(0, 77) + '…' : first
    })
    .join('\n         ')

export const agentLook = (agent: Agent) => (waitingOn(agent) ? LOOKS.command : (LOOKS[agent.status as LookName] ?? LOOKS.unknown))

// Tab states from the server (tabState) in the same vocabulary as agent statuses.
export const tabLook = (state: string) => LOOKS[(state === 'idle' ? 'finished' : state.replace(/^claude-/, '')) as LookName] ?? LOOKS.unknown

export const tabChipLook = (w: App, tab: ButtonTab): Look => {
  const commands = waitingOn(w.agents?.find((agent) => agent.tabId === tab.tabId))
  return commands ? { ...LOOKS.command, title: LOOKS.command.title + commandsTitle(commands) } : tabLook(tab.state)
}

export const agentInTab = (w: App | null, tabId: string) => w?.agents?.find((agent) => agent.tabId === tabId)
const paneInTab = (w: App, tabId: string) => agentInTab(w, tabId)?.paneId
// A session the reaper (or ×) stopped in this tab, now sitting at the tab's shell prompt.
const pausedInTab = (w: App, tabId: string) => (paneInTab(w, tabId) ? undefined : w.paused?.find((session) => session.tabId === tabId))

export const agentName = (agent: Agent) => (agent.tab && !/^\d+$/.test(agent.tab) ? agent.tab.toLowerCase() : 'claude')

/** The name a session's chip shows: the button tab's name (artifacts), else the pane's tab. */
export const sessionName = (w: App | null, agent: Agent) => {
  const key = Object.entries(w?.tabs ?? {}).find(([, tab]) => tab.tabId === agent.tabId)?.[0]
  return key ?? agentName(agent)
}

const chip = (fields: Omit<ChipModel, 'kind' | 'disabled' | 'closeDisabled'> & { disabled?: boolean; closeDisabled?: boolean }): ChipModel => ({
  kind: 'chip',
  ...fields,
  disabled: (fields.disabled ?? false) || !fields.onClick,
  closeDisabled: fields.closeDisabled ?? fields.disabled ?? false,
})

// A session's title cut to fit a chip.
const shortTitle = (title: string | null | undefined) => (title ? (title.length > 24 ? title.slice(0, 23).trimEnd() + '…' : title) : undefined)

const pausedChip = (w: App, busy: boolean, name: string, session: PausedSession): ChipModel =>
  chip({
    key: 'paused:' + session.sessionId,
    name,
    paused: session,
    // Only a session waiting on you is reaped, so it keeps that look; the chip adds a ⏸ for the difference.
    look: LOOKS.idle,
    onClick: { type: 'run', action: 'resume', extra: { sessionId: session.sessionId } },
    onClose: { type: 'run', action: 'dismiss-session', extra: { sessionId: session.sessionId } },
    closeTitle: 'Dismiss: stop offering to resume it (its transcript stays, so claude --resume ' + session.sessionId.slice(0, 8) + '… still brings it back)',
    title: 'Claude: ' + LOOKS.idle.title + '. Paused at ' + new Date(session.ts).toLocaleTimeString() + ' to free memory; click to bring it back and go to it',
    disabled: busy || w.busy,
  })

const stopSession = (paneId: string): Action => ({ type: 'run', action: 'stop-session', extra: { paneId } })

/** The pane of the app's most recently active Claude session, live or paused (by its last transcript write, else when it was stopped); null with none. */
export const latestSessionPane = (w: App): string | null =>
  [...w.agents.map((agent) => ({ pane: agent.paneId, at: agent.active ?? '' })), ...w.paused.map((session) => ({ pane: session.paneId, at: session.active ?? session.ts }))].sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.pane ?? null

/** The jobs that bring up a session, which the chat then shows. */
export const SESSION_ACTIONS = ['claude-start', 'resume']

// The app's Claude sessions not already shown by a tab chip, then the ones the reaper stopped.
const agentChips = (w: App, busy: boolean): ControlModel[] => {
  const shown = new Set(Object.values(w.tabs ?? {}).map((tab) => tab.tabId))
  const live = (w.agents ?? [])
    .filter((agent) => !shown.has(agent.tabId))
    .map((agent) => {
      const look = agentLook(agent)
      const commands = waitingOn(agent)
      return chip({
        key: agent.paneId,
        name: agentName(agent),
        short: shortTitle(agent.title),
        look,
        onClick: { type: 'open-agent', agent },
        onClose: stopSession(agent.paneId),
        title: 'Claude in ' + (agent.tab ? 'tab ' + agent.tab : 'a pane') + ': ' + look.title + '. Click to go to it' + (commands ? commandsTitle(commands) : ''),
        closeTitle: 'Remove this session (stops it; claude --resume still brings it back)',
        disabled: busy || w.busy,
        pane: agent.paneId,
        agent,
      })
    })
  const paused = (w.paused ?? []).filter((session) => !shown.has(session.tabId)).map((session) => ({ ...pausedChip(w, busy, 'claude', session), short: shortTitle(session.title) }))
  // A fresh session can always be started, alongside any already running or paused.
  const others = live.length + paused.length
  const start: StartModel = {
    kind: 'start',
    key: 'claude',
    name: others ? '+ claude' : 'claude',
    onClick: { type: 'run', action: 'claude-start' },
    disabled: busy || w.busy,
    title: 'Start a new Claude session here, in a new claude tab',
  }
  return [...live, ...paused, start]
}

// A tab a button started Claude in (Artifacts, for the artifact index), as a session chip while it is open.
const tabSessionChip = (w: App, busy: boolean, kind: 'artifacts', what: string): ControlModel | null => {
  const tab = w.tabs?.[kind]
  if (!tab) return null
  const paused = pausedInTab(w, tab.tabId)
  if (paused) return pausedChip(w, busy, kind, paused)
  const look = tabChipLook(w, tab)
  const pane = paneInTab(w, tab.tabId)
  return chip({
    key: kind,
    name: kind,
    look,
    onClick: { type: 'open-tab', tab },
    onClose: pane ? stopSession(pane) : { type: 'close-tab', tabId: tab.tabId, confirm: 'Close the ' + what + ' tab?' },
    title: what + ' tab: ' + look.title + '. Click to open it',
    closeTitle: pane ? 'Remove this session (stops it; claude --resume still brings it back)' : 'Close the ' + what + ' tab',
    disabled: busy || w.busy,
    pane,
    agent: agentInTab(w, tab.tabId),
  })
}

/** The Artifacts tab while open, then the app's other Claude sessions. */
export const sessionControls = (w: App | null, busy: boolean): ControlModel[] =>
  !w ? [] : [tabSessionChip(w, busy, 'artifacts', 'Artifacts (the artifact index)'), ...agentChips(w, busy)].filter((model): model is ControlModel => Boolean(model))

/** The groups the cockpit lists sessions under, most urgent first. */
export const SESSION_GROUPS = ['Needs you', 'Running', 'Idle']

export const sessionGroup = (look: LookName) => (look === 'blocked' ? 'Needs you' : look === 'working' || look === 'running' ? 'Running' : 'Idle')

export const blockedTitle = (base: string, apps: (App | null | undefined)[]) => {
  const blocked = apps.reduce((n, w) => n + (w?.agents ?? []).filter((a) => a.status === 'blocked').length, 0)
  return blocked ? '(⚑' + blocked + ') ' + base : base
}
