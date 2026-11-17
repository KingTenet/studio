import type { Agent, App, Mode } from './types'

/** The chat's Claude: the app's session that isn't in the Artifacts tab (as the server's chatAgent finds it). */
export const chatAgentOf = (w: App | null): Agent | null => w?.agents?.find((agent) => agent.tab !== 'Artifacts') ?? null

/** Why a plan's [Build this] can't run now, or null when it can: not while Claude works or waits on a question, nor while an old version is previewed. */
export const buildBlocked = (w: App | null): string | null => {
  if (!w) return "The studio isn't answering."
  if (w.preview) return "You're previewing " + w.preview.tag + '. Go back to the latest version first.'
  const chat = chatAgentOf(w)
  if (chat?.status === 'working') return 'Claude is working. Build it once it has finished.'
  if (chat?.status === 'blocked') return 'Claude is waiting on a question. Answer it first.'
  return null
}

/** What Claude is sent to build a plan: where to read it (its local copy, else the published page). */
export const buildMessage = (plan: { title: string; url: string; page: string | null }) =>
  'Build the plan “' + plan.title + '”: read it at ' + (plan.page ? plan.page + ' (published at ' + plan.url + ')' : plan.url) + ', then build it step by step.'

/** A Build turn being watched: the chat's pane, and the mode it was in when Claude started working. */
export type TurnWatch = { paneId: string; mode: Mode } | null

/**
 * Follows the chat's Claude from one state to the next: a turn starts when it works, and ends when it is idle again (a question
 * in between doesn't end it). `buildEnded` is true once, when a turn that started in Build mode ends.
 */
export const watchTurn = (watch: TurnWatch, chat: Agent | null, mode: Mode): { watch: TurnWatch; buildEnded: boolean } => {
  if (!chat) return { watch: null, buildEnded: false }
  if (chat.status === 'working') return { watch: watch?.paneId === chat.paneId ? watch : { paneId: chat.paneId, mode }, buildEnded: false }
  if (chat.status === 'idle' || chat.status === 'done') return { watch: null, buildEnded: watch?.paneId === chat.paneId && watch.mode === 'build' }
  return { watch, buildEnded: false }
}

/** What the middle pane shows, and whether there is an unsent drawing: on the Draw tab, or over the previewed artifact. */
export type MiddlePane = { source: 'app' | 'artifacts' | 'draw'; drawInk: boolean; artifactInk: boolean }

/**
 * What a new publish (an artifact, or a new version of one) does to the middle pane: previewed in the Artifacts tab, which it
 * switches to when the chat's Claude published it (a plan or an explainer). An unsent drawing holds it: one over the
 * previewed artifact keeps that artifact, one on the Draw tab keeps the Draw tab.
 */
export const onPublish = (pane: MiddlePane, fromChat: boolean): { preview: boolean; show: 'artifacts' | null } => {
  if (pane.artifactInk) return { preview: false, show: null }
  return { preview: true, show: fromChat && !(pane.source === 'draw' && pane.drawInk) && pane.source !== 'artifacts' ? 'artifacts' : null }
}

/** Where the middle pane goes when a Build turn ends: back to the app, unless an unsent drawing is on the tab showing. */
export const afterBuild = (pane: MiddlePane): 'app' | null => {
  if (pane.source === 'app') return null
  if (pane.source === 'draw' && pane.drawInk) return null
  if (pane.source === 'artifacts' && pane.artifactInk) return null
  return 'app'
}
