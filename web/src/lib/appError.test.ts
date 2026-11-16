import { describe, expect, it } from 'vitest'
import { fixBlocked, fixMessage, ignoredPageError } from './appError'
import type { Agent, App } from './types'

const app = (over: Partial<App> = {}, status: Agent['status'] = 'idle') =>
  ({ agents: [{ paneId: 'w1:p1', tabId: 'w1:t1', tab: 'claude', status, commands: [], sessionId: 's1', title: null }], feature: null, preview: null, mode: 'build', ...over }) as unknown as App

describe('fixMessage', () => {
  it('says the server crashed and sends the log tail, a line per ⏎', () => {
    expect(fixMessage({ kind: 'server' }, 'Error: boom\n    at app.ts:3\nNode.js v24')).toBe(
      'The app is broken: its server stopped with an error. Please find out why and fix it. The last 50 lines of its dev server log (data/logs/dev.log), with ⏎ between lines: Error: boom ⏎     at app.ts:3 ⏎ Node.js v24'
    )
  })

  it("quotes the page's error, and says when the log is empty", () => {
    expect(fixMessage({ kind: 'page', message: 'TypeError: x is undefined\n  at Todo.tsx:4' }, '')).toBe(
      'The app is broken: the page in the App tab showed this error: TypeError: x is undefined ⏎ at Todo.tsx:4 Please find out why and fix it. Its dev server log (data/logs/dev.log) is empty.'
    )
  })
})

describe('fixBlocked and ignoredPageError', () => {
  it('waits while Claude works or asks, and while an old version is previewed', () => {
    expect(fixBlocked(app())).toBeNull()
    expect(fixBlocked(app({}, 'working'))).toBe('Claude is working…')
    expect(fixBlocked(app({}, 'blocked'))).toMatch(/waiting on a question/)
    expect(fixBlocked(app({ preview: { tag: 'v1', name: 'Getting Started', at: '', packagesDiffer: false } }))).toMatch(/previewing v1/)
  })

  it("ignores the browser's ResizeObserver notice", () => {
    expect(ignoredPageError('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
    expect(ignoredPageError('TypeError: x is undefined')).toBe(false)
  })
})
