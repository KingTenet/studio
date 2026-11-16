import { describe, expect, it } from 'vitest'
import { blockedTitle, latestSessionPane, sessionControls, tabLook } from './controls'
import type { Agent, App } from './types'

const app = (fields: Partial<App> = {}): App => ({ dir: '/code/app', name: 'app', url: 'http://localhost:4001', running: false, busy: false, tabs: {}, agents: [], paused: [], feature: null, unpushed: [], versions: [], ...fields })

const agent = (fields: Partial<Agent> = {}): Agent => ({ paneId: 'w1:p1', tabId: 'w1:t1', tab: '1', status: 'idle', commands: [], sessionId: 'abcdef1234', title: null, ...fields })

describe('sessionControls', () => {
  it('offers to start Claude when the app has no session', () => {
    expect(sessionControls(app(), false).map((c) => c.kind + ':' + c.name)).toEqual(['start:claude'])
  })

  it('shows a live session as a chip that opens it, then offers a new one', () => {
    const controls = sessionControls(app({ agents: [agent({ status: 'blocked' })] }), false)
    expect(controls).toMatchObject([
      { kind: 'chip', name: 'claude', look: { name: 'blocked' }, onClick: { type: 'open-agent' }, pane: 'w1:p1' },
      { kind: 'start', name: '+ claude', onClick: { type: 'run', action: 'claude-start' } },
    ])
  })

  it('reads an idle session running a command as busy', () => {
    const [chip] = sessionControls(app({ agents: [agent({ commands: ['pnpm test'] })] }), false)
    expect(chip).toMatchObject({ look: { dot: '⧗' } })
  })

  it('shows a reaped session as the idle session it was, marked paused, whose click resumes it', () => {
    const controls = sessionControls(app({ paused: [{ sessionId: 'abcdef1234', ts: '2026-01-01T10:00:00Z', how: 'stopped', by: 'reaper', paneId: 'w1:p1', tabId: 'w1:t1', title: 'Fix the target line' }] }), false)
    expect(controls).toMatchObject([
      {
        kind: 'chip',
        name: 'claude',
        short: 'Fix the target line',
        look: { name: 'idle' },
        paused: { sessionId: 'abcdef1234' },
        onClick: { type: 'run', action: 'resume', extra: { sessionId: 'abcdef1234' } },
        onClose: { type: 'run', action: 'dismiss-session', extra: { sessionId: 'abcdef1234' } },
      },
      { kind: 'start', name: '+ claude' },
    ])
  })
})

describe('latestSessionPane', () => {
  const paused = (paneId: string, active: string | null, ts = '2026-01-01T09:00:00Z') => ({ sessionId: 's-' + paneId, ts, how: 'stopped', by: 'reaper' as const, paneId, tabId: 't', title: null, active })

  it('is the pane of the most recently active session, live or paused', () => {
    const w = app({ agents: [agent({ paneId: 'w1:p1', active: '2026-01-01T10:00:00Z' })], paused: [paused('w1:p2', '2026-01-01T11:00:00Z')] })
    expect(latestSessionPane(w)).toBe('w1:p2')
    expect(latestSessionPane({ ...w, paused: [paused('w1:p2', '2026-01-01T08:00:00Z')] })).toBe('w1:p1')
  })

  it('falls back to when a paused session was stopped, and is null with no sessions', () => {
    expect(latestSessionPane(app({ paused: [paused('w1:p3', null, '2026-01-01T12:00:00Z')] }))).toBe('w1:p3')
    expect(latestSessionPane(app())).toBeNull()
  })

  it('leaves out the session in the Artifacts tab, which the chat never shows', () => {
    const w = app({ tabs: { artifacts: { tabId: 'w1:t2', state: 'claude-working' } }, agents: [agent({ paneId: 'w1:p1', active: '2026-01-01T10:00:00Z' }), agent({ paneId: 'w1:p2', tabId: 'w1:t2', active: '2026-01-01T11:00:00Z' })] })
    expect(latestSessionPane(w)).toBe('w1:p1')
  })
})

describe('tab session chips', () => {
  it('shows the Artifacts tab’s Claude session as its own chip, not hidden among the others', () => {
    const w = app({ tabs: { artifacts: { tabId: 'w1:t5', state: 'claude-working' } }, agents: [agent({ paneId: 'w1:p5', tabId: 'w1:t5', status: 'working' })] })
    expect(sessionControls(w, false).map((c) => c.kind + ':' + c.name)).toEqual(['chip:artifacts', 'start:claude'])
  })
})

describe('tabLook', () => {
  it('maps tab states onto the session looks', () => {
    expect(tabLook('claude-working').name).toBe('working')
    expect(tabLook('idle').name).toBe('finished')
    expect(tabLook('running').name).toBe('running')
  })
})

describe('blockedTitle', () => {
  it('counts blocked sessions into the title', () => {
    expect(blockedTitle('App', [app({ agents: [agent({ status: 'blocked' }), agent({ status: 'blocked' })] }), null])).toBe('(⚑2) App')
    expect(blockedTitle('App', [app()])).toBe('App')
  })
})
