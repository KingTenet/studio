import type { SessionMessage } from './types'

/** A message as the chat shows it: a queued one says whether Claude has read it yet. */
export type ChatMessage = SessionMessage & { delivery?: 'queued' | 'mid-turn' }

/**
 * Pairs the queue events in a transcript with the messages you sent while Claude was working.
 * Absorbed mid-turn: shown as read. Dequeued (it became the next prompt, recorded as usual) or pulled
 * back into the input box: hidden, since it shows up there instead. Still waiting: shown as queued.
 * Claude Code's own queued items (task notifications) take part in the order but are never shown.
 */
export const resolveQueue = (messages: SessionMessage[]): ChatMessage[] => {
  const out: (ChatMessage | null)[] = []
  const pending: { at: number | null; text: string }[] = []
  for (const message of messages) {
    if (message.kind === 'you' && message.queued) {
      pending.push({ at: out.length, text: message.text })
      out.push({ ...message, delivery: 'queued' })
      continue
    }
    if (message.kind !== 'queue') {
      out.push(message)
      continue
    }
    if (message.op === 'enqueue') {
      pending.push({ at: null, text: '' })
    } else if (message.op === 'absorbed' || message.op === 'removed') {
      const found = pending.findIndex((item) => (message.text ? item.at !== null && item.text === message.text : item.at === null))
      if (found < 0) continue
      const [item] = pending.splice(found, 1)
      if (item.at !== null) out[item.at] = message.op === 'absorbed' ? { ...out[item.at]!, delivery: 'mid-turn' } : null
    } else if (message.op === 'dequeue') {
      const item = pending.shift()
      if (item?.at != null) out[item.at] = null
    } else if (message.op === 'popAll') {
      for (const item of pending.splice(0)) if (item.at !== null) out[item.at] = null
    }
  }
  return out.filter((message): message is ChatMessage => message !== null)
}
