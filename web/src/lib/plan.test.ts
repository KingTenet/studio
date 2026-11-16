import { describe, expect, it } from 'vitest'
import { afterBuild, buildBlocked, buildMessage, chatAgentOf, onPublish, watchTurn, type TurnWatch } from './plan'
import type { Agent, App, AgentStatus } from './types'

const agent = (status: AgentStatus, tab = 'claude', paneId = 'w:p1'): Agent => ({ paneId, tabId: 'w:t1', tab, status, commands: [], sessionId: 's1', title: null })
const app = (over: Partial<App> = {}): App =>
  ({ dir: '/app', name: 'app', url: 'http://localhost:4001', running: true, busy: false, tabs: {}, agents: [], paused: [], feature: null, unpushed: [], wentBack: null, versions: [], preview: null, mode: 'plan', ...over }) as App

describe('chatAgentOf / buildBlocked', () => {
  it("finds the chat's Claude, never the Artifacts tab's", () => {
    expect(chatAgentOf(app({ agents: [agent('working', 'Artifacts', 'w:p9'), agent('idle')] }))?.paneId).toBe('w:p1')
    expect(chatAgentOf(app({ agents: [agent('idle', 'Artifacts')] }))).toBeNull()
  })

  it('refuses while Claude works or waits, or while an old version is previewed', () => {
    expect(buildBlocked(app({ agents: [agent('idle')] }))).toBeNull()
    expect(buildBlocked(app({ agents: [agent('done')] }))).toBeNull()
    // No session running: the chat resumes or starts one with the message.
    expect(buildBlocked(app())).toBeNull()
    // The Artifacts tab working doesn't hold it up.
    expect(buildBlocked(app({ agents: [agent('working', 'Artifacts', 'w:p9'), agent('idle')] }))).toBeNull()
    expect(buildBlocked(app({ agents: [agent('working')] }))).toMatch(/Claude is working/)
    expect(buildBlocked(app({ agents: [agent('blocked')] }))).toMatch(/waiting on a question/)
    expect(buildBlocked(app({ preview: { tag: 'v1', name: 'Start', at: '', packagesDiffer: false } }))).toMatch(/previewing v1/)
    expect(buildBlocked(null)).not.toBeNull()
  })
})

describe('buildMessage', () => {
  it("points Claude at the plan's local copy, with the published page beside it", () => {
    expect(buildMessage({ title: 'Plan: dark mode', url: 'https://claude.ai/artifact/a1', page: '/h/.studio/artifacts/x/snapshots/a1/v2/index.html' })).toBe(
      'Build the plan “Plan: dark mode”: read it at /h/.studio/artifacts/x/snapshots/a1/v2/index.html (published at https://claude.ai/artifact/a1), then build it step by step.'
    )
    expect(buildMessage({ title: 'P', url: 'https://claude.ai/artifact/a1', page: null })).toContain('read it at https://claude.ai/artifact/a1,')
  })
})

describe('watchTurn', () => {
  const run = (steps: [AgentStatus | null, 'ask' | 'plan' | 'build'][]) => {
    let watch: TurnWatch = null
    return steps.map(([status, mode]) => {
      const next = watchTurn(watch, status ? agent(status) : null, mode)
      watch = next.watch
      return next.buildEnded
    })
  }

  it('says a Build turn ended once, when Claude goes from working to idle or done', () => {
    expect(run([['idle', 'build'], ['working', 'build'], ['working', 'build'], ['idle', 'build'], ['idle', 'build']])).toEqual([false, false, false, true, false])
    expect(run([['working', 'build'], ['done', 'build']])).toEqual([false, true])
  })

  it('a question in the middle of the turn does not end it', () => {
    expect(run([['working', 'build'], ['blocked', 'build'], ['working', 'build'], ['idle', 'build']])).toEqual([false, false, false, true])
  })

  it('goes by the mode the turn started in, not the switch when it ends', () => {
    expect(run([['working', 'build'], ['idle', 'ask']])).toEqual([false, true])
    expect(run([['working', 'plan'], ['working', 'build'], ['idle', 'build']])).toEqual([false, false, false])
    expect(run([['working', 'ask'], ['idle', 'ask']])).toEqual([false, false])
  })

  it('a session that went away or a turn never seen working ends nothing', () => {
    expect(run([['working', 'build'], [null, 'build'], ['idle', 'build']])).toEqual([false, false, false])
    expect(run([['idle', 'build'], ['done', 'build']])).toEqual([false, false])
  })

  it("a turn in another pane is a new one", () => {
    let watch: TurnWatch = watchTurn(null, agent('working', 'claude', 'w:p1'), 'build').watch
    watch = watchTurn(watch, agent('working', 'claude', 'w:p2'), 'ask').watch
    expect(watchTurn(watch, agent('idle', 'claude', 'w:p2'), 'build').buildEnded).toBe(false)
  })
})

describe('onPublish / afterBuild', () => {
  const pane = (source: 'app' | 'artifacts' | 'draw', drawInk = false, artifactInk = false) => ({ source, drawInk, artifactInk })

  it("switches to Artifacts for the chat's publish, from the app or a blank Draw tab", () => {
    expect(onPublish(pane('app'), true)).toEqual({ preview: true, show: 'artifacts' })
    expect(onPublish(pane('draw'), true)).toEqual({ preview: true, show: 'artifacts' })
    expect(onPublish(pane('artifacts'), true)).toEqual({ preview: true, show: null })
  })

  it("previews the Artifacts tab's own publishes without switching to them", () => {
    expect(onPublish(pane('app'), false)).toEqual({ preview: true, show: null })
  })

  it('leaves a drawing she has not sent where it is', () => {
    expect(onPublish(pane('draw', true), true)).toEqual({ preview: true, show: null })
    expect(onPublish(pane('artifacts', false, true), true)).toEqual({ preview: false, show: null })
    // Ink on the Draw tab doesn't hold her on the app.
    expect(onPublish(pane('app', true), true)).toEqual({ preview: true, show: 'artifacts' })
  })

  it('goes back to the app after a Build turn, unless a drawing she has not sent is showing', () => {
    expect(afterBuild(pane('artifacts'))).toBe('app')
    expect(afterBuild(pane('draw'))).toBe('app')
    expect(afterBuild(pane('app'))).toBeNull()
    expect(afterBuild(pane('draw', true))).toBeNull()
    expect(afterBuild(pane('artifacts', false, true))).toBeNull()
    expect(afterBuild(pane('artifacts', true))).toBe('app')
  })
})
