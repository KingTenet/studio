import { describe, expect, it } from 'vitest'
import { resolveQueue } from './queue'
import type { SessionMessage } from './types'

const you = (text: string): SessionMessage => ({ kind: 'you', text, queued: true })
const claude = (text: string): SessionMessage => ({ kind: 'claude', text })
const event = (op: SessionMessage['op'], text = ''): SessionMessage => ({ kind: 'queue', op, text })

describe('resolveQueue', () => {
  it('shows a message sent while Claude works as queued until Claude reads it mid-turn', () => {
    expect(resolveQueue([claude('working on it'), you('also the alert log')])).toEqual([claude('working on it'), { ...you('also the alert log'), delivery: 'queued' }])
    expect(resolveQueue([you('also the alert log'), event('absorbed', 'also the alert log'), claude('done')])).toEqual([{ ...you('also the alert log'), delivery: 'mid-turn' }, claude('done')])
  })

  it('hides a queued message once it becomes the next prompt, since it is recorded again as one', () => {
    expect(resolveQueue([you('next thing'), event('dequeue'), { kind: 'you', text: 'next thing' }])).toEqual([{ kind: 'you', text: 'next thing' }])
  })

  it('pairs a dequeue with the oldest queued item, even when that is one of Claude Code’s own', () => {
    expect(resolveQueue([event('enqueue'), you('mine'), event('dequeue')])).toEqual([{ ...you('mine'), delivery: 'queued' }])
  })

  it('hides messages pulled back into the input box', () => {
    expect(resolveQueue([you('a'), you('b'), event('popAll')])).toEqual([])
  })

  it('never shows the queue events themselves', () => {
    expect(resolveQueue([event('enqueue'), event('removed'), claude('ok')])).toEqual([claude('ok')])
  })
})
