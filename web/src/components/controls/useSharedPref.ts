import { useEffect, useRef, useState } from 'react'
import { setUiPref } from '@/lib/api'
import { store } from '@/lib/store'
import { useControls } from './ControlsProvider'

// For this long after a change here, what the server sends may predate it, so it's ignored.
const SETTLE_MS = 5000

/**
 * A UI setting shared by every cockpit and the index. Each <label>.localhost keeps its own browser
 * storage, so the studio server holds the setting, and open pages pick up a change at their next
 * state poll. This browser's copy is used until the server's arrives, so a page doesn't flash its
 * default first. With `debounceMs`, a run of changes (a drag) reaches the server once it stops.
 */
export const useSharedPref = <T>(key: string, fallback: T, debounceMs = 0): [T, (value: T) => void] => {
  const { state } = useControls()
  const [value, setValue] = useState<T>(() => store.get(key, fallback))
  const changedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const remote = state?.prefs?.ui?.[key]
  const remoteJson = remote === undefined ? undefined : JSON.stringify(remote)

  useEffect(() => {
    if (remoteJson === undefined || Date.now() - changedAt.current < SETTLE_MS) return
    const next = JSON.parse(remoteJson) as T
    store.set(key, next)
    setValue(next)
  }, [remoteJson])
  useEffect(() => () => clearTimeout(timer.current), [])

  const set = (next: T) => {
    changedAt.current = Date.now()
    setValue(next)
    store.set(key, next)
    clearTimeout(timer.current)
    const send = () => {
      changedAt.current = Date.now()
      void setUiPref(key, next)
    }
    if (debounceMs) timer.current = setTimeout(send, debounceMs)
    else send()
  }
  return [value, set]
}
