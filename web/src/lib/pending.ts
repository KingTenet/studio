/** How a control shows its action in flight: hide the item it removes, spin it, or show a placeholder for what it creates. */
export type Treatment = 'hide' | 'spin' | 'add'

export type Pending = { treatment: Treatment; text: string }

const TREATMENTS: Record<string, Pending> = {
  'dismiss-session': { treatment: 'hide', text: 'Dismissing…' },
  'close-tab': { treatment: 'hide', text: 'Closing…' },
  'remove-artifact': { treatment: 'hide', text: 'Removing…' },
  'stop-session': { treatment: 'hide', text: 'Removing…' },
  resume: { treatment: 'spin', text: 'Resuming…' },
  prune: { treatment: 'spin', text: 'Removing…' },
  'claude-start': { treatment: 'add', text: 'Starting session…' },
}

/** How an action shows while it runs; anything not listed spins its control. */
export const pendingFor = (action: string): Pending => TREATMENTS[action] ?? { treatment: 'spin', text: 'Working…' }

/** The key a control's pending state is filed under: its worktree and the thing it acts on. */
export const pendingKey = (label: string, target: string) => label + '/' + target

/** Wraps a fetch so an answer is dropped when the answer to a later call has already been applied: a slow poll can't undo a fresher state. Each call still returns its own answer. */
export const latestOnly = <T, A extends unknown[]>(fetch: (...args: A) => Promise<T>, apply: (value: T) => void) => {
  let started = 0
  let applied = 0
  return async (...args: A) => {
    const mine = ++started
    const value = await fetch(...args)
    if (mine < applied) return value
    applied = mine
    apply(value)
    return value
  }
}
