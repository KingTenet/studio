import { Check, ChevronRight, ChevronsLeft, Clock, Crosshair, Keyboard, Layers, LoaderCircle, Paperclip, Pause, Play, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { SmartLink } from '@/components/controls/ArtifactLink'
import { useControls } from '@/components/controls/ControlsProvider'
import { useTip } from '@/components/controls/Tip'
import { useSharedPref } from '@/components/controls/useSharedPref'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { parseAnsi, type AnsiStyle } from '@/lib/ansi'
import { FOCUS_CHAT_EVENT } from '@/lib/artifacts'
import { focusAgent, pressEsc, sendToSession, uploadFile } from '@/lib/api'
import { agentLook, sessionControls, sessionName, waitingOn, type ChipModel, type LookName, type StartModel } from '@/lib/controls'
import { parseMarkdown, type Inline as InlinePart } from '@/lib/markdown'
import { resolveQueue, type ChatMessage } from '@/lib/queue'
import type { Agent, AgentStatus, App, SessionPrompt } from '@/lib/types'
import { cn } from 'cn'
import { useDictation } from './MicButton'
import { CloseButton, PinButton } from './useAutoHide'
import { useSession, type ChatView } from './useSession'

const Parts = ({ parts }: { parts: InlinePart[] }) => (
  <>
    {parts.map((part, i) =>
      part.kind === 'link' ? (
        <SmartLink key={i} href={part.href} className={cn('text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-current dark:text-sky-400 dark:decoration-sky-400/30', part.code && 'rounded bg-muted px-1 font-mono text-[0.85em]')}>
          {part.text}
        </SmartLink>
      ) : part.kind === 'code' ? (
        <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em]">
          {part.text}
        </code>
      ) : part.kind === 'bold' ? (
        <b key={i}>{part.text}</b>
      ) : (
        part.text
      )
    )}
  </>
)

export const Markdown = ({ text }: { text: string }) => (
  <>
    {parseMarkdown(text).map((block, i) =>
      block.kind === 'code' ? (
        <pre key={i} className="my-1 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {block.text}
        </pre>
      ) : block.kind === 'table' ? (
        <div key={i} className="my-1 overflow-x-auto whitespace-normal">
          <table className="text-xs">
            <thead>
              <tr>
                {block.head.map((cell, j) => (
                  <th key={j} className="border px-2 py-1 text-left font-medium">
                    <Parts parts={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell, k) => (
                    <td key={k} className="border px-2 py-1 align-top">
                      <Parts parts={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Parts key={i} parts={block.parts} />
      )
    )}
  </>
)

// `index` marks one of your messages (data-you) so the transcript can pin it once it scrolls above the top.
const Message = ({ message, index }: { message: ChatMessage; index?: number }) => {
  const tip = useTip()
  if (message.kind === 'tool') {
    return (
      <div className="truncate border-l-2 pl-2 font-mono text-[11px] text-muted-foreground" title={tip(message.detail ?? message.text)}>
        {message.text}
      </div>
    )
  }
  if (message.kind === 'note') return <div className="text-xs text-muted-foreground italic">{message.text}</div>
  return (
    <div data-you={message.kind === 'you' ? index : undefined} className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)] gap-0.5">
      <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
        {message.kind === 'you' ? 'you' : 'claude'}
        {message.delivery === 'queued' && (
          <span className="inline-flex items-center gap-1 tracking-normal text-sky-700 normal-case dark:text-sky-400" title={tip("Sent while Claude was working; it waits in Claude Code's queue")}>
            <Clock className="size-3" /> queued: Claude reads it at its next step
          </span>
        )}
        {message.delivery === 'mid-turn' && (
          <span className="inline-flex items-center gap-1 tracking-normal normal-case" title={tip('Sent while Claude was working; Claude read it mid-turn')}>
            <Check className="size-3" /> read mid-turn
          </span>
        )}
      </span>
      <div className={cn('text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', message.kind === 'you' && 'rounded-lg bg-sky-50 px-3 py-2 dark:bg-sky-950/60')}>
        {message.kind === 'claude' ? <Markdown text={message.text} /> : message.text.trim()}
      </div>
    </div>
  )
}

// A question's "Type something." option: what you type here goes into it and answers the question.
const FreeOption = ({ option, onAnswer }: { option: SessionPrompt['options'][number]; onAnswer: (text: string) => void }) => {
  const [text, setText] = useState(option.typed ?? '')
  const send = () => text.trim() && onAnswer(text.trim())
  return (
    <div className="flex items-center gap-1.5 rounded-md border px-2 py-1">
      <kbd className="font-mono text-[10px] text-muted-foreground">{option.key}</kbd>
      <Input
        aria-label="Your own answer"
        value={text}
        placeholder="Type something."
        className="h-7 flex-1 text-sm"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          }
        }}
      />
      <Button size="sm" disabled={!text.trim()} onClick={send}>
        Answer
      </Button>
    </div>
  )
}

const Prompt = ({ prompt, onKey, onAnswer }: { prompt: SessionPrompt; onKey: (key: string) => void; onAnswer: (key: string, text: string) => void }) => {
  const tip = useTip()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-red-500/70 p-3">
      <span className="text-sm font-semibold">⚑ {prompt.question || 'Claude is waiting on you'}</span>
      <div className="grid gap-1">
        {prompt.options.map((option) =>
          option.free ? (
            <FreeOption key={prompt.question + option.key} option={option} onAnswer={(text) => onAnswer(option.key, text)} />
          ) : (
            <Button
              key={option.key}
              variant="outline"
              size="sm"
              aria-pressed={option.checked}
              className="h-auto justify-start py-1 text-left whitespace-normal"
              onClick={() => onKey(option.key)}
            >
              <kbd className="mr-1 font-mono text-[10px] text-muted-foreground">{option.key}</kbd>
              {option.checked !== undefined && <span className="font-mono">{option.checked ? '☑' : '☐'}</span>}
              {option.label}
            </Button>
          )
        )}
        {prompt.submit && (
          <Button size="sm" className="justify-self-end" title={tip(prompt.submit === 'Submit' ? 'Sends the ticked answers' : 'Moves on to the next question')} onClick={() => onKey('submit')}>
            {prompt.submit} <ChevronRight />
          </Button>
        )}
      </div>
    </div>
  )
}

const elapsed = (since: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
}

// Counts up while Claude works, so a long step still visibly moves.
const useWorkingSince = (status: AgentStatus | null | undefined, paneId: string | null) => {
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const working = status === 'working'
  useEffect(() => setSince(working ? Date.now() : null), [working, paneId])
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [working])
  return since === null ? null : elapsed(since, now)
}

/** The live last line of the chat while Claude works: how long, and its latest step or the command it waits on. */
const WorkingRow = ({ agent, messages, duration }: { agent: Agent; messages: ChatMessage[]; duration: string | null }) => {
  const tip = useTip()
  const commands = waitingOn(agent)
  const since = messages.findLastIndex((message) => message.kind === 'claude')
  const tool = messages.slice(since + 1).findLast((message) => message.kind === 'tool')
  const step = commands ? 'waiting on ' + commands[0].split('\n')[0] : (tool?.text ?? null)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-sky-600/30 bg-sky-600/5 px-3 py-2 text-sm text-sky-800 dark:text-sky-300" role="status" aria-live="polite">
      <LoaderCircle className="size-4 shrink-0 animate-spin" />
      <span className="shrink-0 font-medium">Claude is working{duration ? ' · ' + duration : ''}</span>
      {step && (
        <span className="min-w-0 truncate font-mono text-[11px] text-sky-800/70 dark:text-sky-300/70" title={tip(step)}>
          {step}
        </span>
      )}
    </div>
  )
}

const STATUS_PILL: Record<string, { text: string; className: string }> = {
  working: { text: 'working', className: 'border-sky-600/40 bg-sky-600/10 text-sky-700 dark:text-sky-400' },
  blocked: { text: 'needs you', className: 'border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-400' },
  idle: { text: 'waiting for you', className: 'border-border text-muted-foreground' },
  done: { text: 'finished', className: 'border-teal-600/40 text-teal-700 dark:text-teal-400' },
}

const ansiStyle = (style: AnsiStyle) => ({
  color: style.fg ?? undefined,
  background: style.bg ?? undefined,
  fontWeight: style.bold ? 700 : undefined,
  opacity: style.dim ? 0.6 : undefined,
  fontStyle: style.italic ? 'italic' : undefined,
  textDecoration: style.underline ? 'underline' : undefined,
  filter: style.inverse ? 'invert(1)' : undefined,
})

// Keeps a scroll box pinned to the bottom while it was already there, so a new message follows but reading back doesn't jump.
// A new box (the pane expanded from its strip, or the view switched) starts at the bottom.
const usePinnedScroll = (deps: unknown[]) => {
  const [box, setBox] = useState<HTMLElement | null>(null)
  const pinned = useRef(true)
  // Bumped by follow, so the box goes to the bottom once what was just sent is on screen.
  const [follows, setFollows] = useState(0)
  const toBottom = () => {
    if (!box) return
    pinned.current = true
    box.scrollTop = box.scrollHeight
  }
  useLayoutEffect(() => {
    pinned.current = true
  }, [box])
  useLayoutEffect(() => {
    if (box && pinned.current) box.scrollTop = box.scrollHeight
  }, [box, follows, ...deps])
  // The box resizing (the pane widening, the message input growing) keeps a pinned box at the bottom.
  useEffect(() => {
    if (!box) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) box.scrollTop = box.scrollHeight
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])
  // Coming back to the page jumps to the bottom and pins there, so what arrived meanwhile follows too.
  useEffect(() => {
    const onReturn = () => document.visibilityState === 'visible' && toBottom()
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [box])
  const onScroll = () => {
    if (box) pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  }
  // Focus moving into the pane from outside it jumps to the bottom too, unless it lands in the transcript you're reading.
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null) || box?.contains(event.target)) return
    toBottom()
  }
  // A message you send goes to the bottom and pins there, wherever you'd scrolled to.
  const follow = () => {
    pinned.current = true
    setFollows((n) => n + 1)
  }
  return { box: setBox, el: box, onScroll, onFocus, follow }
}

// The last of your messages (data-you) whose top has scrolled above the box's padding: its index, pinned over the transcript.
// Runs after usePinnedScroll's effects, so it sees the box already scrolled to the bottom.
const usePinnedYou = (box: HTMLElement | null, deps: unknown[]) => {
  const [pinned, setPinned] = useState<number | null>(null)
  const update = () => {
    if (!box) return
    const rect = box.getBoundingClientRect()
    const top = rect.top + parseFloat(getComputedStyle(box).paddingTop) - 1
    let last: number | null = null
    for (const el of box.querySelectorAll<HTMLElement>('[data-you]')) {
      const elTop = el.getBoundingClientRect().top
      // One of yours already in view: nothing needs pinning.
      if (elTop >= top) return setPinned(elTop < rect.bottom ? null : last)
      last = Number(el.dataset.you)
    }
    setPinned(last)
  }
  useLayoutEffect(update, [box, ...deps])
  useEffect(() => {
    if (!box) return
    const observer = new ResizeObserver(update)
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])
  const show = (index: number) => box?.querySelector(`[data-you="${index}"]`)?.scrollIntoView({ block: 'start' })
  return { pinned, update, show }
}

const STRIP_DOT: Partial<Record<LookName, string>> = {
  blocked: 'bg-red-600 animate-pulse',
  working: 'bg-sky-600 animate-pulse',
  running: 'bg-amber-500 animate-pulse',
  done: 'bg-teal-500',
}

/** The collapsed chat: a dot per Claude session, coloured by its status; a paused one, a pause sign in the idle colour. */
const ChatStrip = ({ w, onExpand, overlay }: { w: App | null; onExpand: () => void; overlay: boolean }) => {
  const tip = useTip()
  return (
    <div className="flex h-full flex-col items-center gap-3 py-3">
      <Button size="icon-xs" variant="ghost" aria-label="Show Claude" title={tip('Show Claude' + (overlay ? '' : ' (hovering opens it too)'))} onClick={onExpand}>
        <ChevronsLeft />
      </Button>
      {(w?.agents ?? []).map((agent) => {
        const look = agentLook(agent)
        return <span key={agent.paneId} title={tip(sessionName(w, agent) + ': ' + look.title)} className={cn('size-2.5 rounded-full', STRIP_DOT[look.name] ?? 'bg-lime-600/70')} />
      })}
      {(w?.paused ?? []).map((session) => (
        <Pause key={session.sessionId} aria-label={(session.title ?? 'claude') + ': paused'} className="size-2.5 fill-current text-lime-600/70" />
      ))}
    </div>
  )
}

type Dropped = { key: string; name: string; preview?: string; path?: string; error?: string }
let dropCount = 0
const newDropKey = () => 'drop' + ++dropCount

type ChatProps = {
  label: string
  w: App | null
  /** The pane the chat column shows: a live session's, or one a stopped session was left in. */
  selected: string | null
  /** Selects a pane, to show its session. */
  onSelect: (paneId: string) => void
  /** Shows the narrow column of session dots instead of the chat. */
  collapsed: boolean
  /** Whether the chat stays open; unpinned it collapses when the mouse leaves and nothing in it has focus. */
  pinned?: boolean
  onTogglePin?: () => void
  /** The pin's keyboard shortcut, for its tooltip. */
  pinShortcut?: string
  /** Whether the chat floats over the page beside it instead of taking a column of its own. */
  overlay?: boolean
  onToggleOverlay?: () => void
  /** Opens the collapsed chat (the strip's button; docked and unpinned, hovering opens it too). */
  onExpand: () => void
  /** Closes it to its strip: floating over the page, it has this close button instead of the pin. */
  onClose?: () => void
  /** Changes when a session is opened here: the chat opens and the cursor goes to its message box. */
  focusMessage: number
  /** What the page shows as each message is sent, given to Claude with that message . */
  pageContext?: () => string | null | Promise<string | null>
  /** Things attached to the next message (picks in an artifact), shown as chips above the box; their text goes in pageContext. */
  attachments?: { key: string; label: string; title: string }[]
  onRemoveAttachment?: (key: string) => void
  /** A message reached a live session (with whatever was attached). */
  onSent?: () => void
  /** The box keeps the keyboard (the cockpit): it takes focus back when asked (FOCUS_CHAT_EVENT), and typing with nothing editable focused goes to it. */
  stickyFocus?: boolean
}

export const Chat = ({ label, w, selected, onSelect, collapsed, pinned = true, onTogglePin, pinShortcut, overlay = false, onToggleOverlay, onExpand, onClose, focusMessage, pageContext, attachments = [], onRemoveAttachment, onSent, stickyFocus = false }: ChatProps) => {
  const tip = useTip()
  const { perform, isBusy, pendingOf } = useControls()
  const [view, setView] = useSharedPref<ChatView>('wt:chatView', 'chat')
  const agent = w?.agents?.find((candidate) => candidate.paneId === selected) ?? null
  // With no live session in the selected pane, the paused one left there (the one picked, if two were): shown as the idle session it was.
  const [picked, setPicked] = useState<string | null>(null)
  const inPane = agent ? [] : (w?.paused ?? []).filter((candidate) => candidate.paneId === selected)
  const stopped = inPane.find((candidate) => candidate.sessionId === picked) ?? inPane[0] ?? null
  const resumeChip = stopped ? sessionControls(w, isBusy(label, w)).find((model): model is ChipModel => model.kind === 'chip' && model.paused?.sessionId === stopped.sessionId) : undefined
  const resume = () => resumeChip?.onClick && !resumeChip.disabled && perform(label, resumeChip.onClick, resumeChip.key)
  // Coming back to the cockpit resumes the chat it was showing, if the idle reaper stopped it meanwhile (not if you did).
  const resumeOnReturn = useRef(resume)
  resumeOnReturn.current = () => stopped?.by === 'reaper' && resume()
  useEffect(() => {
    const onReturn = () => document.visibilityState === 'visible' && resumeOnReturn.current()
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [])
  // The chat in view is herdr's focused pane too: on coming back to this tab or window, and on showing another session while it has focus.
  const shownPane = collapsed ? null : (agent?.paneId ?? null)
  useEffect(() => {
    if (!shownPane) return
    const focusInHerdr = () => void focusAgent(shownPane).catch(() => undefined)
    const onReturn = () => document.visibilityState === 'visible' && focusInHerdr()
    if (document.hasFocus()) focusInHerdr()
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [shownPane])
  const { session, poll } = useSession(label, agent?.paneId ?? stopped?.paneId ?? null, view, stopped?.sessionId ?? null)
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  // A message on its way: shown faded until the transcript has more messages than when it was sent.
  const [sending, setSending] = useState<{ paneId: string; text: string; count: number } | null>(null)
  // Files dropped on the chat (a screenshot's thumbnail, anything from Finder): copied to the studio server as they land, since
  // the page can't know where they live, and their copies' paths go with the next message.
  const [dropped, setDropped] = useState<Dropped[]>([])
  const [dragging, setDragging] = useState(false)
  const dropFiles = (items: DataTransferItemList) => {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (!file) continue
      if (item.webkitGetAsEntry()?.isDirectory) {
        setNotice({ text: file.name + ' is a folder: drop the files in it instead.', error: true })
        continue
      }
      const key = newDropKey()
      setDropped((current) => [...current, { key, name: file.name, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }])
      void uploadFile(file, label).then((saved) => setDropped((current) => current.map((entry) => (entry.key === key ? { ...entry, ...saved } : entry))))
    }
  }
  const forgetDropped = (keys: string[]) =>
    setDropped((current) => {
      for (const entry of current) if (keys.includes(entry.key) && entry.preview) URL.revokeObjectURL(entry.preview)
      return current.filter((entry) => !keys.includes(entry.key))
    })
  const droppedLines = dropped.flatMap((entry) => (entry.path ? ['The user attached ' + entry.name + ': ' + entry.path + ' (Read it to see it).'] : []))
  const uploading = dropped.some((entry) => !entry.path && !entry.error)
  // A session started or resumed with a message gets no page context, so the files go in the message itself.
  const withDropped = (message: string) => (droppedLines.length ? message + '\n\n' + droppedLines.join('\n') : message)
  // A file dropped anywhere else on the page does nothing, rather than Chrome opening it in place of the page.
  useEffect(() => {
    const guard = (event: DragEvent) => event.dataTransfer?.types.includes('Files') && event.preventDefault()
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])

  useEffect(() => setNotice(null), [selected])

  // A session coming up: a new one (pending on the start chip, 'claude') or a paused one being resumed (on its chip).
  const startingNew = pendingOf(label, 'claude')
  const resuming = (w?.paused ?? []).find((candidate) => pendingOf(label, 'paused:' + candidate.sessionId))
  const comingUp = startingNew ? 'new' : (resuming?.sessionId ?? null)
  // What was selected when it began: picking another session meanwhile leaves the new one's placeholder.
  const [began, setBegan] = useState<{ key: string; selected: string | null } | null>(null)
  if (comingUp && began?.key !== comingUp) setBegan({ key: comingUp, selected })
  if (!comingUp && began) setBegan(null)
  const placeholder = Boolean(startingNew && began?.key === 'new' && began.selected === selected)
  // Shown and typed into while it comes up: the new session's placeholder, or the resumed session's transcript.
  const bringing = placeholder || Boolean(resuming && stopped?.sessionId === resuming.sessionId)

  // Once the box is there and enabled (the chat opened, the session's state in), the cursor goes to it: on a session opened here, or one starting.
  const messageBox = useRef<HTMLTextAreaElement>(null)
  const wantsFocus = useRef(false)
  useEffect(() => {
    if (!focusMessage && !comingUp) return
    wantsFocus.current = true
    if (collapsed) onExpand()
  }, [focusMessage, comingUp])
  // A session being resumed is shown, wherever it was started from.
  useEffect(() => {
    if (!resuming) return
    setPicked(resuming.sessionId)
    onSelect(resuming.paneId)
  }, [resuming?.sessionId])
  useEffect(() => {
    if (!wantsFocus.current || !messageBox.current || messageBox.current.disabled) return
    messageBox.current.focus()
    wantsFocus.current = false
  })
  // The toggle by Send: with it on, the box takes the keyboard back whenever it can; off, focus stays where you put it.
  const [keepFocus, setKeepFocus] = useSharedPref('cockpit:keepFocus', true)
  const sticky = stickyFocus && keepFocus
  useEffect(() => {
    if (!sticky) return
    const take = () => {
      const box = messageBox.current
      if (box && !box.disabled) box.focus({ preventScroll: true })
    }
    // A character typed with nothing editable focused (after clicking a button, say): focused before the key lands, so it goes in the box.
    const onKey = (event: KeyboardEvent) => {
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      const active = document.activeElement
      if (active instanceof HTMLElement && (active.isContentEditable || active.closest('input, textarea, select, iframe, [role="dialog"], [role="menu"], [role="listbox"]'))) return
      take()
    }
    // Coming back to the tab or window (from a link an artifact opened, say), the box has it, not the frame last clicked.
    const onReturn = () => document.visibilityState === 'visible' && take()
    window.addEventListener(FOCUS_CHAT_EVENT, take)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener(FOCUS_CHAT_EVENT, take)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [sticky])

  // Only a session waiting on you is reaped, so a paused one reads as idle.
  const status = session.status ?? agent?.status ?? (stopped ? 'idle' : undefined)
  const blocked = status === 'blocked'
  const working = status === 'working' || Boolean(agent && waitingOn(agent))
  const duration = useWorkingSince(working ? 'working' : status, agent?.paneId ?? null)
  const messages = resolveQueue(session.messages)
  const pill = working ? STATUS_PILL.working : status ? STATUS_PILL[status] : undefined
  const { box, el: boxEl, onScroll, onFocus, follow } = usePinnedScroll([session.messages.length, session.prompt, session.screen, view, selected, working])
  const pinnedYou = usePinnedYou(boxEl, [session.messages.length, view, selected])
  const pressKey = async (key: string) => {
    if (!agent) return
    const error = await sendToSession({ paneId: agent.paneId, label, key })
    if (error) setNotice({ text: error, error: true })
    void poll()
  }
  // Interrupting puts Claude's last message back in its input: it lands in this box instead, to edit and send again.
  const interrupt = async () => {
    if (!agent) return
    const { error, restored } = await pressEsc({ paneId: agent.paneId, label })
    if (error) setNotice({ text: error, error: true })
    if (restored) setText((current) => current || restored)
    void poll()
  }
  const answer = async (key: string, typed: string) => {
    if (!agent) return
    const error = await sendToSession({ paneId: agent.paneId, label, answer: { key, text: typed } })
    if (error) setNotice({ text: error, error: true })
    void poll()
  }
  // Sends a message to a live session, faded in the chat until its transcript has it.
  const deliver = async (paneId: string, message: string, count = session.messages.length) => {
    setSending({ paneId, text: message, count })
    const sent = dropped.map((entry) => entry.key)
    const context = [await pageContext?.(), ...droppedLines].filter(Boolean).join(' ')
    const error = await sendToSession({ paneId, label, text: message, context: context || undefined })
    if (error) {
      setSending(null)
      setText(message)
      setNotice({ text: error, error: true })
    } else {
      setNotice(null)
      forgetDropped(sent)
      onSent?.()
    }
    void poll()
  }

  // Typed while a session comes up: sent once it's up and shown here (focusMessage moves), else put back in the box.
  const [queued, setQueued] = useState<{ text: string; focus: number } | null>(null)
  useEffect(() => {
    if (!queued || bringing) return
    setQueued(null)
    if (focusMessage !== queued.focus && agent) void deliver(agent.paneId, queued.text, 0)
    else setText((current) => (current ? queued.text + '\n' + current : queued.text))
  }, [bringing, focusMessage])

  // A message sent from here shows in herdr's input box for a moment before Claude takes it: only text that stays there is someone else's.
  const [stuckInput, setStuckInput] = useState('')
  useEffect(() => {
    setStuckInput('')
    if (!session.input) return
    const timer = setTimeout(() => setStuckInput(session.input), 1500)
    return () => clearTimeout(timer)
  }, [session.input])

  const sendable = (message: string) => Boolean(message.trim() && !uploading && (bringing ? !queued : agent ? !stuckInput && !blocked : resumeChip && !resumeChip.disabled))
  const canSend = sendable(text)
  // Sends the box, or what was dictated with Space.
  const send = async (typed = text) => {
    if (!sendable(typed)) return
    const message = typed.trim()
    follow()
    if (bringing) {
      setQueued({ text: message, focus: focusMessage })
      setText('')
      return
    }
    // A paused session is brought back with the message as its first prompt.
    if (stopped) {
      perform(label, { type: 'run', action: 'resume', extra: { sessionId: stopped.sessionId, message: withDropped(message) } }, resumeChip?.key)
      forgetDropped(dropped.map((entry) => entry.key))
      setText('')
      return
    }
    if (!agent) return
    setText('')
    await deliver(agent.paneId, message)
  }
  // Arrived once the transcript has more messages than when it was sent, or (as a long transcript re-read keeps only its
  // last 200, which can be fewer than that) once it shows this message.
  const arrived = (pending: { text: string; count: number }) =>
    session.messages.length > pending.count || session.messages.some((message) => message.kind === 'you' && message.text.includes(pending.text.slice(0, 200)))
  const unsent = sending && agent?.paneId === sending.paneId && !arrived(sending) ? sending.text : null

  const pending = stuckInput ? `Typed in herdr, not sent: “${stuckInput}”. Send or clear it there first.` : ''
  const shown =
    notice?.text || pending || (blocked ? 'Answer the prompt above first, or Esc to cancel it.' : working ? 'Claude is working: a message sent now waits in its queue and reaches it at its next step. Esc interrupts it instead.' : '')
  const name = placeholder ? 'Claude' : agent ? (agent.title ?? sessionName(w, agent)) : (stopped?.title ?? 'claude')
  const queuedRow = queued && (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 opacity-60">
      <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
        you
        <span className="inline-flex items-center gap-1 tracking-normal normal-case">
          <LoaderCircle className="size-3 animate-spin" /> sent once the session is up
        </span>
      </span>
      <div className="rounded-lg bg-sky-50 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] dark:bg-sky-950/60">{queued.text}</div>
    </div>
  )

  // With no session in the chat: Start Claude, and dictating starts it too, with what was said as its first prompt.
  const newStart = agent || stopped || placeholder ? undefined : sessionControls(w, isBusy(label, w)).find((model): model is StartModel => model.kind === 'start' && model.key === 'claude')
  const canStartNew = Boolean(newStart && !newStart.disabled && !startingNew)

  let body: ReactNode
  if (placeholder) {
    body = (
      <div className="row-start-3 grid min-h-0 auto-rows-max grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto px-8 py-4">
        <p className="text-sm text-muted-foreground">Claude is starting. Type your first message now: it's sent as soon as the session is up.</p>
        {queuedRow}
      </div>
    )
  } else if (agent && view === 'terminal') {
    body = (
      <pre ref={box} onScroll={onScroll} aria-label={'Screen of ' + agent.paneId} className="row-start-3 min-h-0 overflow-auto bg-[#0f141a] px-8 py-3 font-mono text-[11.5px] leading-snug whitespace-pre text-[#d6dee6]">
        {parseAnsi(session.screen).map((segment, i) => (
          <span key={i} style={ansiStyle(segment.style)}>
            {segment.text}
          </span>
        ))}
      </pre>
    )
  } else if (agent || stopped) {
    const youIndex = pinnedYou.pinned
    const youPinned = youIndex === null ? undefined : messages[youIndex]
    body = (
      <div className="relative row-start-3 grid min-h-0">
        {youPinned && youIndex !== null && (
          <button
            type="button"
            title={tip('Your message this reply answers; click to scroll to it')}
            onClick={() => pinnedYou.show(youIndex)}
            className="absolute inset-x-0 top-0 z-10 grid grid-cols-[minmax(0,1fr)] gap-0.5 bg-background px-8 pt-4 pb-2 text-left"
          >
            <span className="text-[10px] font-medium tracking-widest text-muted-foreground uppercase">you</span>
            <span className="line-clamp-3 rounded-lg bg-sky-50 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] dark:bg-sky-950/60">{youPinned.text.trim()}</span>
            {/* The transcript fades out under the pin, so it reads as scrolling beneath it. */}
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-8 bg-linear-to-b from-background to-transparent" />
          </button>
        )}
        <div
          ref={box}
          onScroll={() => {
            onScroll()
            pinnedYou.update()
          }}
          className="scrollbar-subtle grid min-h-0 auto-rows-max grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-x-hidden overflow-y-auto px-8 py-4"
        >
          {messages.length ? messages.map((message, i) => <Message key={i} message={message} index={i} />) : !unsent && <p className="text-sm text-muted-foreground">Nothing said yet.</p>}
          {unsent && (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5 opacity-60">
              <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
                you
                <span className="inline-flex items-center gap-1 tracking-normal normal-case">
                  <LoaderCircle className="size-3 animate-spin" /> sending
                </span>
              </span>
              <div className="rounded-lg bg-sky-50 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] dark:bg-sky-950/60">{unsent}</div>
            </div>
          )}
          {queuedRow}
          {working && agent && <WorkingRow agent={agent} messages={messages} duration={duration} />}
          {session.prompt && <Prompt prompt={session.prompt} onKey={(key) => void pressKey(key)} onAnswer={(key, text) => void answer(key, text)} />}
        </div>
      </div>
    )
  } else {
    body = (
      <div className="row-start-3 grid content-start justify-items-start gap-3 px-8 py-4">
        <p className="text-sm text-muted-foreground">Claude isn't running.</p>
        {newStart && (
          <Button size="sm" variant="outline" title={tip(newStart.title)} disabled={!canStartNew} onClick={() => perform(label, newStart.onClick, newStart.key)}>
            <Play /> Start Claude
          </Button>
        )}
      </div>
    )
  }

  // Runs with the chat collapsed too: a recording stopped from this page sends to its session, or opens the chat to edit.
  const dictation = useDictation({
    box: messageBox,
    disabled: !agent && !stopped && !placeholder && !canStartNew,
    onError: (error) => setNotice({ text: error, error: true }),
    onText: (spoken, andSend, pin) => {
      const message = text.trim() ? text.trimEnd() + ' ' + spoken : spoken
      setNotice(null)
      // No session: a new one starts. Sent, it's the session's first prompt; to edit, it waits in the box, sent once the session is up.
      if (newStart && newStart.onClick.type === 'run') {
        if (!canStartNew) return setText(message)
        perform(label, andSend ? { ...newStart.onClick, extra: { message: withDropped(message.trim()) } } : newStart.onClick, newStart.key)
        if (andSend) {
          forgetDropped(dropped.map((entry) => entry.key))
          if (pin && overlay) onExpand()
          else if (pin && !pinned) onTogglePin?.()
          return
        }
        setText(message)
        wantsFocus.current = true
        if (collapsed) onExpand()
        return
      }
      // Dictated with Space: sent, unless the session can't take it now (a prompt waiting, say), when it waits in the box.
      if (andSend && sendable(message)) {
        void send(message)
        // Pin-on-send (the pill's pin): the chat stays open to show the message being worked on. An overlay has no pin, so it just opens.
        if (pin && overlay) onExpand()
        else if (pin && !pinned) onTogglePin?.()
        return
      }
      setText(message)
      wantsFocus.current = true
      if (collapsed) onExpand()
    },
  })

  if (collapsed)
    return (
      <>
        <ChatStrip w={w} onExpand={onExpand} overlay={overlay} />
        {dictation.pill}
      </>
    )

  // Every row is placed explicitly, so the modes panel rendering nothing doesn't shift the rest up a row.
  return (
    // Esc anywhere in the chat goes to the pane, as in herdr: it interrupts Claude, or cancels the prompt it waits on.
    <div
      className={cn('flex h-full min-w-0', dragging && 'outline-2 -outline-offset-2 outline-sky-500 outline-dashed')}
      onFocus={onFocus}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(false)
        dropFiles(event.dataTransfer.items)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !(status === 'working' || blocked)) return
        event.preventDefault()
        void interrupt()
      }}
    >
      <div className="grid h-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)_auto]">
        <div className="row-start-1 flex min-h-10 items-center gap-2 border-b px-8 py-1.5">
          {placeholder ? (
            <>
              <span className="min-w-0 truncate text-sm font-medium">{name}</span>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" />
                {startingNew?.text}
              </span>
              <span className="flex-1" />
            </>
          ) : agent || stopped ? (
            <>
              <span className="min-w-0 truncate text-sm font-medium" title={tip(name)}>
                {name}
              </span>
              {pill && (
                <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', pill.className)}>
                  {working && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
                  {pill.text}
                </span>
              )}
              {stopped && <Pause aria-label="paused" className="size-3 shrink-0 fill-current text-muted-foreground/60" />}
              <span className="flex-1" />
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={view}
                aria-label="Rendering"
                onValueChange={(value) => {
                  if (!value) return
                  setView(value as ChatView)
                }}
              >
                <ToggleGroupItem value="chat" className="h-6 px-2 text-xs">
                  chat
                </ToggleGroupItem>
                <ToggleGroupItem value="terminal" className="h-6 px-2 text-xs">
                  terminal
                </ToggleGroupItem>
              </ToggleGroup>
            </>
          ) : (
            <span className="flex-1 text-sm text-muted-foreground">No Claude session yet.</span>
          )}
          {onToggleOverlay && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-pressed={overlay}
              aria-label={overlay ? 'Dock Claude beside the page' : 'Float Claude over the page'}
              title={tip(overlay ? 'Dock: give the chat its own column beside the page' : 'Overlay: float the chat over the page, which keeps its full width')}
              onClick={onToggleOverlay}
              className={cn('shrink-0', overlay ? 'text-foreground' : 'text-muted-foreground')}
            >
              <Layers className={cn(overlay && 'fill-current')} />
            </Button>
          )}
          {overlay && onClose ? (
            <CloseButton onClose={onClose} name="Claude" shortcut={pinShortcut} className="shrink-0" />
          ) : (
            onTogglePin && <PinButton pinned={pinned} onToggle={onTogglePin} name="Claude" shortcut={pinShortcut} className="shrink-0" />
          )}
        </div>
        {body}
        {dictation.pill}
        <div className="row-start-4 grid gap-2 border-t px-8 py-3">
          {attachments.length + dropped.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <span key={attachment.key} title={tip(attachment.title)} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-sky-50 py-0.5 pr-0.5 pl-2 text-xs dark:bg-sky-950/60">
                  <Crosshair className="size-3 shrink-0 text-sky-600" />
                  <span className="truncate">{attachment.label}</span>
                  {onRemoveAttachment && (
                    <Button size="icon-xs" variant="ghost" aria-label={'Remove ' + attachment.label} className="size-5" onClick={() => onRemoveAttachment(attachment.key)}>
                      <X />
                    </Button>
                  )}
                </span>
              ))}
              {dropped.map((entry) => (
                <span
                  key={entry.key}
                  title={tip(entry.error ? 'Not attached: ' + entry.error : entry.path ? 'A copy of ' + entry.name + ', sent with your next message: ' + entry.path : 'Copying ' + entry.name + '…')}
                  className={cn('inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-0.5 pl-1.5 text-xs', entry.error ? 'border-destructive/50 text-destructive' : 'bg-sky-50 dark:bg-sky-950/60')}
                >
                  {!entry.path && !entry.error ? (
                    <LoaderCircle className="size-3 shrink-0 animate-spin" />
                  ) : entry.preview ? (
                    <img src={entry.preview} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
                  ) : (
                    <Paperclip className="size-3 shrink-0 text-sky-600" />
                  )}
                  <span className="truncate">{entry.name}</span>
                  <Button size="icon-xs" variant="ghost" aria-label={'Remove ' + entry.name} className="size-5" onClick={() => forgetDropped([entry.key])}>
                    <X />
                  </Button>
                </span>
              ))}
            </div>
          )}
          <Textarea
            ref={messageBox}
            aria-label="Message the selected session"
            disabled={!agent && !stopped && !placeholder}
            value={text}
            placeholder={
              bringing
                ? 'Message ' + name + ' (sent once it is up)'
                : working ? 'Claude is working; a message now reaches it at its next step' : agent || stopped ? 'Message ' + name + ' (Enter sends, Shift+Enter for a new line)' : 'Start Claude to message it'
            }
            className="max-h-[33vh] min-h-16 resize-none text-sm"
            onChange={(event) => {
              setText(event.target.value)
              if (notice) setNotice(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 text-xs break-words', notice?.error || pending ? 'text-destructive' : 'text-muted-foreground')}>{shown}</span>
            {stickyFocus && (
              <Button
                size="icon-sm"
                variant={keepFocus ? 'secondary' : 'ghost'}
                aria-label="Keep the keyboard in the chat"
                aria-pressed={keepFocus}
                title={tip(
                  keepFocus
                    ? 'Keeping the keyboard here: after a click or pick in an artifact, typing elsewhere, or coming back to this tab, the cursor returns to this box (not when you click into a field or select text). Click to stop'
                    : 'Focus stays where you click. Click to have the cursor keep coming back to this box'
                )}
                onClick={() => setKeepFocus(!keepFocus)}
              >
                <Keyboard className={cn(!keepFocus && 'opacity-50')} />
              </Button>
            )}
            {dictation.buttons}
            <Button size="sm" disabled={!canSend} title={tip('Send (Enter; Shift+Enter for a new line)')} onClick={() => void send()}>
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

