import { describe, expect, it } from 'vitest'
import { expectationFor } from './expect'
import type { Agent, App, ControlState } from './types'

const state = (app: Partial<App>) => ({ app: { agents: [], paused: [], tabs: {}, ...app } }) as unknown as ControlState
const agent = (paneId: string, tabId = 't1') => ({ paneId, tabId }) as Agent

describe('expectationFor', () => {
  it('waits for the pane a start or resume printed to show up as a session, and hands that session back', () => {
    const start = expectationFor('claude-start', {}, '$ claude-reaper.sh start /w\nStarted Claude in w1:p3\n[done]\n')!
    expect(start.met(state({ agents: [agent('w1:p1')] }))).toBe(false)
    expect(start.met(state({ agents: [agent('w1:p1'), agent('w1:p3')] }))).toEqual(agent('w1:p3'))
    expect(expectationFor('resume', {}, 'Resumed 1234-abcd in w2:p1\n')!.met(state({ agents: [agent('w2:p1')] }))).toEqual(agent('w2:p1'))
    // Output without a pane (an older script): nothing to wait for.
    expect(expectationFor('claude-start', {}, 'something else')).toBeNull()
  })

  it('waits for a stopped session, a dismissed one and a closed tab to be gone', () => {
    const stop = expectationFor('stop-session', { paneId: 'p1' })!
    expect(stop.met(state({ agents: [agent('p1')] }))).toBe(false)
    expect(stop.met(state({}))).toBe(true)
    const dismiss = expectationFor('dismiss-session', { sessionId: 's1' })!
    expect(dismiss.met(state({ paused: [{ sessionId: 's1' }] as App['paused'] }))).toBe(false)
    expect(dismiss.met(state({}))).toBe(true)
    const close = expectationFor('close-tab', { tabId: 't9' })!
    expect(close.met(state({ tabs: { artifacts: { tabId: 't9' } } as unknown as App['tabs'] }))).toBe(false)
    expect(close.met(state({ agents: [agent('p2', 't9')] }))).toBe(false)
    expect(close.met(state({}))).toBe(true)
  })

  it('expects nothing of other actions', () => {
    expect(expectationFor('artifact-index', {}, '[done]')).toBeNull()
  })
})
