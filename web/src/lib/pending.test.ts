import { describe, expect, it } from 'vitest'
import { latestOnly, pendingFor } from './pending'

describe('pendingFor', () => {
  it('hides what an action removes, adds a placeholder for what it creates, and spins the rest', () => {
    expect(pendingFor('dismiss-session').treatment).toBe('hide')
    expect(pendingFor('close-tab').treatment).toBe('hide')
    expect(pendingFor('claude-start')).toEqual({ treatment: 'add', text: 'Starting session…' })
    expect(pendingFor('stop-session')).toEqual({ treatment: 'hide', text: 'Removing…' })
    expect(pendingFor('prune')).toEqual({ treatment: 'spin', text: 'Removing…' })
    expect(pendingFor('push').treatment).toBe('spin')
  })
})

describe('latestOnly', () => {
  it('drops an answer that lands after the answer to a later call', async () => {
    const resolvers: ((value: string) => void)[] = []
    const applied: string[] = []
    const fetchLatest = latestOnly(() => new Promise<string>((resolve) => resolvers.push(resolve)), (value) => applied.push(value))
    const first = fetchLatest()
    const second = fetchLatest()
    resolvers[1]('fresh')
    await second
    resolvers[0]('stale')
    await first
    expect(applied).toEqual(['fresh'])
  })

  it('applies answers that arrive in order', async () => {
    const applied: number[] = []
    let n = 0
    const fetchLatest = latestOnly(async () => ++n, (value) => applied.push(value))
    await fetchLatest()
    await fetchLatest()
    expect(applied).toEqual([1, 2])
  })
})
