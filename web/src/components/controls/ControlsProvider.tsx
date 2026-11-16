import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { closeTab, focusAgent, focusTab, getState, newActionId, reportOutcome, setActionSource, streamJob } from '@/lib/api'
import type { Action } from '@/lib/controls'
import { expectationFor, type Expectation } from '@/lib/expect'
import { jobTitle, type Job } from '@/lib/jobs'
import { latestOnly, pendingFor, pendingKey, type Pending } from '@/lib/pending'
import { store } from '@/lib/store'
import type { Agent, App, ButtonTab, ControlState } from '@/lib/types'
import { DialogHost, type DialogRequest } from './DialogHost'
import { JobsOverlay } from './JobsOverlay'

const JOBS_KEY = 'studio-jobs'
const MAX_JOBS = 10
// A job's output is kept to its last this-many characters, so ten of them fit in localStorage.
const MAX_TEXT = 50_000

type Controls = {
  /** The last /state, or null while the studio server isn't answering. */
  state: ControlState | null
  /** Whether a job this page started, or one the server reports, is running for the app. */
  isBusy: (label: string, w?: App | null) => boolean
  busyCount: number
  /** Fetches a fresh state, applies it (unless a later one already was) and returns it. */
  refresh: (query?: string) => Promise<ControlState | null>
  /** Carries out a control's action; `target` names what it acts on, so that control shows it in flight (pendingOf). */
  perform: (label: string, action: Action, target?: string) => void
  run: (label: string, action: string, extra?: Record<string, unknown>, target?: string) => Promise<boolean>
  /** Runs work that isn't a /run job with target shown as `pending` until it ends and a fresh state is in. */
  act: (label: string, target: string, pending: Pending, work: () => Promise<boolean>) => Promise<boolean>
  /** What a control's target is doing, while its action runs. */
  pendingOf: (label: string, target: string) => Pending | undefined
  /** Whether a control's last action failed, for a few seconds after. */
  failedOf: (label: string, target: string) => boolean
  /** Streams a non-/run job; `worktree` names what it runs for, if anything. */
  stream: (path: string, body: unknown, worktree?: string | null) => Promise<boolean>
  /** The last MAX_JOBS jobs this page ran, newest first, for the Output overlay. */
  jobs: Job[]
  removeJob: (id: string) => void
  clearJobs: () => void
  outputOpen: boolean
  setOutputOpen: (open: boolean) => void
  /** Names where jobs are started from, for their context in the overlay. */
  setSource: (source: string) => void
  confirm: (message: string) => Promise<boolean>
  prompt: (message: string) => Promise<string | null>
  /** Asks to pick one of options; resolves to it, or null when cancelled. */
  choose: (message: string, options: string[]) => Promise<string | null>
}

const ControlsContext = createContext<Controls | null>(null)

export const useControls = () => {
  const controls = useContext(ControlsContext)
  if (!controls) throw new Error('useControls needs a ControlsProvider')
  return controls
}

type ControlsProviderProps = {
  children: ReactNode
  /** Shows one of the app's sessions in the chat column, after it's focused in herdr. */
  onOpenAgent?: (agent: Agent) => void
  /** Called once a job a control started has finished, before the refresh that follows it. */
  onRan?: (label: string, action: string) => void
  /** Whether the Output button sits in the page's corner; the cockpit puts an OutputButton in its toolbar instead. */
  outputInCorner?: boolean
}

export const ControlsProvider = ({ children, onOpenAgent, onRan, outputInCorner = true }: ControlsProviderProps) => {
  const [state, setState] = useState<ControlState | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // A job still running when the page was left can't be followed any more.
  const [jobs, setJobs] = useState<Job[]>(() => store.get<Job[]>(JOBS_KEY, []).map((job) => (job.status === 'running' ? { ...job, status: 'lost' } : job)))
  const [outputOpen, setOutputOpen] = useState(false)
  const source = useRef('cockpit')
  const page = 'cockpit'
  // Set once while rendering, not in an effect: a child's setSource effect runs before this one's would and must win.
  useState(() => setActionSource(page))
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [failed, setFailed] = useState<Record<string, true>>({})
  const hooks = useRef({ onOpenAgent, onRan })
  hooks.current = { onOpenAgent, onRan }

  const [refresh] = useState(() => latestOnly(getState, setState))

  const without = <T,>(record: Record<string, T>, key: string) => Object.fromEntries(Object.entries(record).filter(([other]) => other !== key))
  const begin = (key: string, entry: Pending) => setPending((current) => ({ ...current, [key]: entry }))
  // Called once a state fetched after the work is in, so a hidden item doesn't flash back first.
  const end = (key: string, succeeded: boolean) => {
    setPending((current) => without(current, key))
    if (succeeded) return
    setFailed((current) => ({ ...current, [key]: true }))
    setTimeout(() => setFailed((current) => without(current, key)), 6000)
  }
  const act = async (label: string, target: string, entry: Pending, work: () => Promise<boolean>) => {
    const key = pendingKey(label, target)
    begin(key, entry)
    const succeeded = await work().catch(() => false)
    await refresh()
    end(key, succeeded)
    return succeeded
  }

  useEffect(() => {
    void refresh()
    // A hidden tab doesn't poll; it catches up the moment it's shown.
    const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), 3000)
    const onVisible = () => document.visibilityState === 'visible' && void refresh()
    const onFocus = () => void refresh()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => store.set(JOBS_KEY, jobs), [jobs])

  // Runs a job into the history, newest first; a failed one opens the overlay so it isn't missed.
  const track = async (title: string, worktree: string | null, start: (onText: (text: string) => void) => Promise<boolean>) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const update = (patch: Partial<Job>) => setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)))
    const job: Job = { id, title, worktree, source: source.current, startedAt: new Date().toISOString(), text: '', status: 'running' }
    setJobs((current) => [job, ...current].slice(0, MAX_JOBS))
    const succeeded = await start((text) => update({ text: text.slice(-MAX_TEXT) }))
    update({ status: succeeded ? 'ok' : 'failed' })
    if (!succeeded) setOutputOpen(true)
    return { succeeded }
  }

  const stream = async (path: string, body: unknown, worktree: string | null = null) =>
    (await track(jobTitle(path, (body ?? {}) as Record<string, unknown>), worktree, (onText) => streamJob(path, body, onText))).succeeded

  // Polls the state until what an action should lead to shows up, or its time runs out; logs which. onMet runs
  // straight after the state that shows it is applied, so whatever it changes (a placeholder gone, a session
  // selected) renders together with it, not a fetch later.
  const settle = async (id: string, expectation: Expectation, onMet?: (met: Agent | true) => void) => {
    const startedAt = Date.now()
    for (;;) {
      const fresh = await refresh()
      const met = fresh ? expectation.met(fresh) : false
      if (met) onMet?.(met)
      if (met || Date.now() - startedAt > expectation.within) {
        void reportOutcome(id, expectation.what, Boolean(met), Date.now() - startedAt)
        return met
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
  }

  // A job counts as done once what it should lead to (lib/expect) shows up, not when its script exits; a session it brings up here is then shown.
  const run = async (label: string, action: string, extra: Record<string, unknown> = {}, target?: string) => {
    const key = target === undefined ? null : pendingKey(label, target)
    if (key) begin(key, pendingFor(action))
    setBusy((current) => new Set(current).add(label))
    const id = newActionId()
    const { succeeded } = await track(jobTitle(action, extra), label, async (onText) => {
      let text = ''
      if (!(await streamJob('/run', { label, action, ...extra }, (all) => onText((text = all)), id))) return false
      const expectation = expectationFor(action, extra, text)
      if (!expectation) return true
      const met = await settle(id, expectation, (met) => {
        if (typeof met === 'object') hooks.current.onOpenAgent?.(met)
        if (key) end(key, true)
      })
      if (!met) onText(text + '\n[' + expectation.what + ' did not show up within ' + expectation.within / 1000 + 's]')
      return Boolean(met)
    })
    setBusy((current) => {
      const next = new Set(current)
      next.delete(label)
      return next
    })
    hooks.current.onRan?.(label, action)
    await refresh()
    if (key) end(key, succeeded)
    return succeeded
  }

  const confirm = (message: string) => new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', message, resolve: (value) => resolve(value !== null) }))
  const prompt = (message: string) => new Promise<string | null>((resolve) => setDialog({ kind: 'prompt', message, resolve }))
  const choose = (message: string, options: string[]) => new Promise<string | null>((resolve) => setDialog({ kind: 'choose', message, options, resolve }))

  const openAgent = (agent: Agent) => {
    void focusAgent(agent.paneId)
    hooks.current.onOpenAgent?.(agent)
  }

  const openTab = (w: App | null, tab: ButtonTab) => {
    const agent = w?.agents?.find((candidate) => candidate.tabId === tab.tabId)
    if (agent) openAgent(agent)
    else void focusTab(tab.tabId)
  }

  const perform = (label: string, action: Action, target?: string) => {
    const w = state?.app ?? null
    switch (action.type) {
      case 'run':
        if (action.confirm) {
          void confirm(action.confirm).then((yes) => yes && run(label, action.action, action.extra, target))
        } else {
          void run(label, action.action, action.extra, target)
        }
        return
      case 'open-agent':
        openAgent(action.agent)
        return
      case 'open-tab':
        openTab(w, action.tab)
        return
      case 'focus-tab':
        void focusTab(action.tabId)
        return
      case 'close-tab':
        void confirm(action.confirm).then(async (yes) => {
          if (!yes) return
          const close = async () => {
            const id = newActionId()
            return (await closeTab(action.tabId, id)).ok && Boolean(await settle(id, expectationFor('close-tab', { tabId: action.tabId })!, () => target !== undefined && end(pendingKey(label, target), true)))
          }
          if (target === undefined) {
            await close()
            await refresh()
          } else {
            await act(label, target, pendingFor('close-tab'), close)
          }
        })
        return
      case 'url':
        window.open(action.url, '_blank', 'noopener')
        return
      case 'call':
        action.call()
    }
  }

  const controls: Controls = {
    state,
    isBusy: (label, w) => busy.has(label) || Boolean(w?.busy),
    busyCount: busy.size,
    refresh,
    perform,
    run,
    act,
    pendingOf: (label, target) => pending[pendingKey(label, target)],
    failedOf: (label, target) => Boolean(failed[pendingKey(label, target)]),
    stream,
    jobs,
    removeJob: (id) => setJobs((current) => current.filter((job) => job.id !== id)),
    clearJobs: () => setJobs((current) => current.filter((job) => job.status === 'running')),
    outputOpen,
    setOutputOpen,
    setSource: (next) => {
      source.current = next
      setActionSource(page + ' / ' + next)
    },
    confirm,
    prompt,
    choose,
  }

  return (
    <ControlsContext.Provider value={controls}>
      {children}
      <JobsOverlay corner={outputInCorner} />
      <DialogHost request={dialog} onDone={() => setDialog(null)} />
    </ControlsContext.Provider>
  )
}
