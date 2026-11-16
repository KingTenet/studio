/** A command a page ran (a /run action or a streamed job), kept in the Output overlay's history. */
export type Job = {
  id: string
  /** What ran: the action and its parameters (jobTitle). */
  title: string
  /** The worktree it ran in, when it ran in one. */
  worktree: string | null
  /** Where it was started: the index tab, or the cockpit. */
  source: string
  startedAt: string
  text: string
  /** `lost` when the page was reloaded while it ran, so how it ended isn't known. */
  status: 'running' | 'ok' | 'failed' | 'lost'
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/

const shortValue = (value: string) => (SESSION_ID.test(value) ? value.slice(0, 8) : value.length > 40 ? value.slice(0, 39) + '…' : value)

/** A job's one-line name: its action (a path without its slash) and its plain parameters as key=value. */
export const jobTitle = (action: string, params: Record<string, unknown>) =>
  [
    action.replace(/^\//, ''),
    ...Object.entries(params)
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) && value !== '')
      .map(([key, value]) => key + '=' + shortValue(String(value).replace(/\s+/g, ' '))),
  ].join(' ')
