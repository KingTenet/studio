import type { Agent, ControlState } from './types'

/**
 * What an action that succeeded should lead to in the control state: the job ends before herdr shows
 * what it started (a new Claude takes seconds to come up), so its control stays pending until a fresh
 * state shows this, or `within` ms pass. `met` returns the session it brought up, when there is one.
 */
export type Expectation = { what: string; within: number; met: (state: ControlState) => Agent | boolean }

const agentsOf = (state: ControlState) => state.app.agents

// "Started Claude in <pane>" / "Resumed <session> in <pane>" (claude-reaper.sh).
const startedPane = (output: string) => /(?:Started Claude|Resumed \S+) in (\S+)/.exec(output)?.[1] ?? null

export const expectationFor = (action: string, extra: Record<string, unknown>, output = ''): Expectation | null => {
  switch (action) {
    case 'claude-start':
    case 'resume': {
      const pane = startedPane(output)
      return pane ? { what: 'a Claude session in ' + pane, within: 45_000, met: (state) => agentsOf(state).find((agent) => agent.paneId === pane) ?? false } : null
    }
    case 'stop-session':
      return { what: 'the session in ' + String(extra.paneId) + ' stopped', within: 15_000, met: (state) => !agentsOf(state).some((agent) => agent.paneId === extra.paneId) }
    case 'dismiss-session':
      return { what: 'session ' + String(extra.sessionId) + ' dismissed', within: 15_000, met: (state) => !state.app.paused.some((session) => session.sessionId === extra.sessionId) }
    case 'close-tab':
      return {
        what: 'tab ' + String(extra.tabId) + ' closed',
        within: 15_000,
        met: (state) => !Object.values(state.app.tabs).some((tab) => tab.tabId === extra.tabId) && !state.app.agents.some((agent) => agent.tabId === extra.tabId),
      }
    default:
      return null
  }
}
