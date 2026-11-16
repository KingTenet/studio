import { useEffect, useRef, useState, type RefObject } from 'react'
import { useControls } from '@/components/controls/ControlsProvider'
import { inChat, latestSessionPane } from '@/lib/controls'
import { store } from '@/lib/store'
import type { Agent, App } from '@/lib/types'

/**
 * Which of the app's sessions the chat shows (remembered in this browser), and a count that moves when one is
 * opened, to put the cursor in its box. Used outside the ControlsProvider: `provider` is its onOpenAgent and onRan.
 */
export const useChatSelection = (label: string, opened: string | null = null) => {
  const [selected, setSelectedState] = useState<string | null>(() => opened ?? store.get('wt:' + label + ':session', null))
  // Set when a job this page started has finished, so the session it started or resumed is selected.
  const adopt = useRef(false)
  // Opened on a session, the cursor goes to its message box.
  const [focusMessage, setFocusMessage] = useState(opened ? 1 : 0)
  const setSelected = (paneId: string | null) => {
    setSelectedState(paneId)
    store.set('wt:' + label + ':session', paneId)
  }
  const open = (paneId: string) => {
    setSelected(paneId)
    setFocusMessage((n) => n + 1)
  }
  const provider = {
    onOpenAgent: (agent: Agent) => open(agent.paneId),
    onRan: () => {
      adopt.current = true
    },
  }
  return { selected, setSelected, focusMessage, open, adopt, provider }
}

/** Inside the provider: keeps the selection on a chat session that exists, moving to one a job of this page just brought up. */
export const useFollowSessions = (label: string, w: App | null, selected: string | null, setSelected: (paneId: string | null) => void, adopt: RefObject<boolean>) => {
  const { state, isBusy } = useControls()
  const known = useRef(new Set<string>())
  // Only on a fresh state: the render that clears the busy flag comes before the refresh that shows the new session.
  useEffect(() => {
    if (!w) return
    const panes = w.agents.filter((agent) => inChat(w, agent)).map((agent) => agent.paneId)
    let next = selected
    if (adopt.current) {
      next = panes.find((pane) => !known.current.has(pane)) ?? next
      adopt.current = false
    }
    if (!isBusy(label, w)) known.current = new Set(panes)
    // The chat shown last stays selected, reaped or not; once it's gone, the most recently active session is.
    const stopped = w.paused.filter((session) => inChat(w, session)).map((session) => session.paneId)
    if (!next || !(panes.includes(next) || stopped.includes(next))) next = latestSessionPane(w)
    if (next !== selected) setSelected(next)
  }, [state, selected])
}
