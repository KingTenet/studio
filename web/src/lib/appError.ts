import { chatAgentOf } from './plan'
import type { App } from './types'

/** What broke in the app: its dev server crashed (`server`), or the page in the App tab threw or failed to build (`page`). */
export type AppError = { kind: 'server' } | { kind: 'page'; message: string }

/** The feature [Ask Claude to fix this] starts when none is open. */
export const FIX_FEATURE = "Fix the app's error"

const MAX_PAGE_ERROR = 1500

/** Errors a page reports that aren't its own breaking: the browser's ResizeObserver notice. */
export const ignoredPageError = (message: string) => /ResizeObserver loop/.test(message)

/**
 * Why [Ask Claude to fix this] can't send now, or null when it can: as for a plan's Build this, not while Claude works or waits on
 * a question, nor while an old version is previewed (which may just not suit the data and packages of today).
 */
export const fixBlocked = (w: App | null): string | null => {
  if (!w) return "The studio isn't answering."
  if (w.preview) return "You're previewing " + w.preview.tag + ', an old version. Go back to the latest version first.'
  const chat = chatAgentOf(w)
  if (chat?.status === 'working') return 'Claude is working…'
  if (chat?.status === 'blocked') return 'Claude is waiting on a question. Answer it first.'
  return null
}

/**
 * What Claude is sent to fix the app: what broke, then the last 50 lines of the dev server's log. The chat sends a message as one
 * line, so the log's lines are joined with ⏎.
 */
export const fixMessage = (error: AppError, tail: string) =>
  (error.kind === 'server' ? "The app is broken: its server stopped with an error. " : 'The app is broken: the page in the App tab showed this error: ' + error.message.slice(0, MAX_PAGE_ERROR).replace(/\s*\n\s*/g, ' ⏎ ') + ' ') +
  'Please find out why and fix it. ' +
  (tail.trim() ? 'The last 50 lines of its dev server log (data/logs/dev.log), with ⏎ between lines: ' + tail.split('\n').join(' ⏎ ') : 'Its dev server log (data/logs/dev.log) is empty.')
