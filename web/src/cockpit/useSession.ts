import { useEffect, useRef, useState } from 'react'
import { getSession } from '@/lib/api'
import type { AgentStatus, SessionMessage, SessionPrompt } from '@/lib/types'

export type ChatView = 'chat' | 'terminal'

export type SessionState = {
  /** The pane this state was read from (or `stopped:<session>` for a stopped one); anything else is stale. */
  paneId: string | null
  sessionId: string | null
  offset: number | undefined
  messages: SessionMessage[]
  status: AgentStatus | null
  prompt: SessionPrompt | null
  /** Text typed into the pane in herdr but not sent. */
  input: string
  /** Claude Code's line saying a usage limit was hit, while it shows. */
  limit: string | null
  screen: string
}

const empty = (paneId: string | null): SessionState => ({ paneId, sessionId: null, offset: undefined, messages: [], status: null, prompt: null, input: '', limit: null, screen: '' })

/**
 * The selected pane's transcript, read incrementally every second while the page is visible (only
 * what was appended since the last read), plus its screen in the terminal view. With `stopped` (a
 * reaped session's id) it reads that session's saved transcript instead, as it was left.
 */
export const useSession = (label: string, paneId: string | null, view: ChatView, stopped: string | null = null) => {
  // Which read this state belongs to: the pane, or the stopped session shown in it.
  const target = stopped ? 'stopped:' + stopped : paneId
  const [session, setSession] = useState<SessionState>(() => empty(target))
  const current = useRef(session)
  current.current = session.paneId === target ? session : empty(target)
  const polling = useRef(false)

  const poll = async () => {
    if (!target || polling.current || document.visibilityState !== 'visible') return
    polling.current = true
    const was = current.current
    try {
      const params = new URLSearchParams(stopped ? { stopped } : { paneId: paneId!, label })
      if (was.sessionId && was.offset !== undefined) {
        params.set('session', was.sessionId)
        params.set('after', String(was.offset))
      }
      if (view === 'terminal' && !stopped) params.set('screen', '1')
      const read = await getSession(params)
      if (!read || current.current.paneId !== target) return
      const messages = read.reset || read.sessionId !== was.sessionId ? read.messages : [...was.messages, ...read.messages]
      setSession({ paneId: target, sessionId: read.sessionId, offset: read.offset, messages, status: read.status, prompt: read.prompt, input: read.input, limit: read.limit ?? null, screen: read.screen ?? '' })
    } catch {
    } finally {
      polling.current = false
    }
  }

  useEffect(() => {
    void poll()
    const timer = setInterval(() => document.visibilityState === 'visible' && void poll(), 1000)
    const onVisible = () => document.visibilityState === 'visible' && void poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [target, view])

  return { session: current.current, poll }
}
