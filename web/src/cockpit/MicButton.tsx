import type { MicVAD } from '@ricky0123/vad-web'
import { Check, Ear, EarOff, ExternalLink, LoaderCircle, Mic, Pin, PinOff, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTip } from '@/components/controls/Tip'
import { useSharedPref } from '@/components/controls/useSharedPref'
import { Button } from '@/components/ui/button'
import { getListener, logDictation, revealRecording, transcribe, updateListener, type Recording, type StopHow } from '@/lib/api'
import { cn } from 'cn'

type Phase = 'idle' | 'recording' | 'paused' | 'finishing'

// The speech detector's model, worklet and onnxruntime files, served by studio-server.js from web/node_modules.
const VAD_ASSETS = '/_env/vad/'
// How often a page checks the server: quickly while a recording is live anywhere, else once a second while it holds the mic or is in view.
const FAST_MS = 300
const SLOW_MS = 1000
// A stop sent to another page's recording waits this long for its text before giving up.
const RESULT_WAIT_MS = 20_000
// A recording this long asks whether you're still there (one started by noise could run for hours); unanswered, it pauses.
const ASK_AFTER_MS = 2 * 60_000
const ASK_FOR_MS = 10_000

/** 16 kHz mono samples (as the speech detector hands them over) as a 16-bit WAV file, for whisper-server. */
const wav = (samples: Float32Array) => {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true))
  return new Blob([view], { type: 'audio/wav' })
}

// Put before the recording tab's title.
const REC_MARK = '● '

// What the pill says this page is.
const where = () => 'the studio'

type Options = { box: RefObject<HTMLTextAreaElement | null>; disabled?: boolean; onText: (text: string, send: boolean, pin: boolean) => void; onError: (error: string) => void }

/**
 * Dictation for a chat, running whether the chat is open or collapsed. With listening on (the ear),
 * speaking starts a recording by itself; it never ends by itself. One page records at a time: the
 * cockpit you last clicked or typed in, which keeps recording wherever you look meanwhile.
 *
 * Every two minutes a recording asks whether you're still talking: Space within ten seconds keeps it
 * recording, else it pauses, mic closed and nothing sent, until you come back to send, drop or resume it.
 *
 * Every open cockpit shows the recording's pill and can stop it: Space or Send sends, the mic puts the
 * text in the box to edit, Esc or the bin drops it. With pin-on-send on (the pill's pin), sending also pins the
 * chat open, to watch the message being worked on. The text goes to the page it was stopped from, into
 * its chat's session (studio-server.js passes the stop to the recording page and its text back).
 *
 * Silero VAD (@ricky0123/vad-web) runs in the recording page to tell speech from noise. Each stretch
 * of speech is transcribed by whisper-server (the studio's Whisper tab) as soon as you pause, so on
 * stopping only the last one is left to wait for.
 */
export const useDictation = ({ box, disabled, onText, onError }: Options): { buttons: ReactNode; pill: ReactNode } => {
  const tip = useTip()
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [listen, setListen] = useSharedPref('cockpit:listen', false)
  const [pinOnSend, setPinOnSend] = useSharedPref('cockpit:pinOnSend', false)
  const [startedAt, setStartedAt] = useState(0)
  const [pageId] = useState(() => Math.random().toString(36).slice(2, 12).padEnd(6, '0'))
  const [owner, setOwner] = useState(false)
  // Another page's recording, shown here; and since when this page has waited for the text of one it stopped.
  const [remote, setRemote] = useState<Recording | null>(null)
  const [waitingSince, setWaitingSince] = useState(0)
  // When this page's recording next asks whether you're still talking, and (while it asks) when it pauses.
  const [askAt, setAskAt] = useState(0)
  const [pauseAt, setPauseAt] = useState(0)

  // The detector's callbacks and the poll are made once, so they read the current state from refs.
  const phaseRef = useRef<Phase>('idle')
  const setPhase = (next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }
  const latest = useRef({ onText, onError, hears: false, listen, pinOnSend, owner, remote, waitingSince, finish: (_how: StopHow, _to: string) => {} })
  // The recording's stretches of speech, each its transcript to come; a new generation drops the old ones.
  const segments = useRef<Promise<{ text: string } | { error: string }>[]>([])
  const generation = useRef(0)
  const recordingStart = useRef(0)
  // When (ms into the recording) the detector dropped a stretch as too short to be speech: it's never transcribed.
  const misfires = useRef<number[]>([])
  const level = useRef(0)
  const vad = useRef<Promise<MicVAD> | null>(null)
  // start and pause in turn: the detector warns and does nothing on a start while it's still starting.
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const begin = () => {
    segments.current = []
    misfires.current = []
    const now = Date.now()
    recordingStart.current = now
    setStartedAt(now)
    setAskAt(now + ASK_AFTER_MS)
    setPauseAt(0)
    setPhase('recording')
    // A page in the background checks in rarely, so it can still think it holds the mic after another
    // page took it: the server has the say, and a recording it doesn't take is dropped here unheard.
    const mine = generation.current
    void updateListener({ id: pageId, recording: { startedAt: now, where: where(), url: location.href } }).then((view) => {
      if (view?.id === pageId && view.recording?.startedAt === now) return
      if (view) setOwner(false)
      if (generation.current === mine && phaseRef.current === 'recording') {
        generation.current++
        segments.current = []
        setPhase('idle')
      }
    })
  }

  const detector = () =>
    (vad.current ??= import('@ricky0123/vad-web').then(({ MicVAD }) =>
      MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_ASSETS,
        onnxWASMBasePath: VAD_ASSETS,
        startOnLoad: false,
        // Stopping mid-sentence still hands over what was said so far.
        submitUserSpeechOnPause: true,
        ortConfig: (ort) => {
          ort.env.logLevel = 'error'
          ort.env.wasm.numThreads = 1
        },
        onSpeechStart: () => {
          if (phaseRef.current === 'idle' && latest.current.hears) begin()
        },
        // Too short to be speech (a cough, a knock): the recording it began never started.
        onVADMisfire: () => {
          if (phaseRef.current === 'recording' && !segments.current.length && latest.current.hears) {
            setPhase('idle')
            void updateListener({ id: pageId, recording: null })
          } else if (phaseRef.current !== 'idle') misfires.current.push(Date.now() - recordingStart.current)
        },
        onSpeechEnd: (audio) => {
          // phase 'paused' or 'finishing' is the tail cut off by pausing or stopping (submitUserSpeechOnPause).
          if (phaseRef.current !== 'idle')
            segments.current.push(
              transcribe(wav(audio), { startedAt: recordingStart.current, segment: segments.current.length, sinceStartMs: Date.now() - recordingStart.current, phase: phaseRef.current, listening: String(latest.current.hears), misfiresSoFar: misfires.current.length })
            )
        },
        onFrameProcessed: (_probabilities, frame) => {
          let sum = 0
          for (const sample of frame) sum += sample * sample
          level.current = Math.sqrt(sum / frame.length)
        },
      })
    ))
  const run = (step: (detector: MicVAD) => Promise<void>) =>
    (queue.current = queue.current.then(() => detector().then(step)).catch((error: unknown) => {
      vad.current = null
      setPhase('idle')
      setListen(false)
      latest.current.onError('The speech detector failed: ' + (error instanceof Error ? error.message : String(error)))
    }))

  // The mic is open while recording here, or listening here (the owner) with a session to talk to. The
  // owner listens while you're in another tab or app too. A paused recording closes it.
  const open = phase === 'recording' || phase === 'finishing' || (phase === 'idle' && listen && owner && !disabled)
  useEffect(() => {
    if (phase === 'finishing') return
    if (open) void run((detector) => detector.start())
    else if (vad.current) void run((detector) => detector.pause())
  }, [open, phase])
  // A detector left closed for 10 minutes is unloaded, to give back its memory; opening loads it again (about half a second).
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => {
      if (!vad.current) return
      const unloading = vad.current
      vad.current = null
      queue.current = queue.current.then(() => unloading.then((detector) => detector.destroy())).catch(() => undefined)
    }, 10 * 60_000)
    return () => clearTimeout(timer)
  }, [open])
  useEffect(() => () => void vad.current?.then((detector) => detector.destroy()), [])
  // Recording long enough: ask whether you're still talking, and pause if no one answers.
  useEffect(() => {
    if (phase !== 'recording') return
    if (!pauseAt) {
      const timer = setTimeout(() => setPauseAt(Date.now() + ASK_FOR_MS), Math.max(0, askAt - Date.now()))
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      setPauseAt(0)
      setPhase('paused')
    }, Math.max(0, pauseAt - Date.now()))
    return () => clearTimeout(timer)
  }, [phase, askAt, pauseAt])
  /** Keeps recording: answers the question, or resumes a paused recording. */
  const keepRecording = () => {
    setPauseAt(0)
    setAskAt(Date.now() + ASK_AFTER_MS)
    setPhase('recording')
  }
  // The recording tab's title starts with ●: it shows in the tab strip, and studio-server.js's reveal looks for it
  // (two tabs can have the same address). The page sets its own title as things change, so it's put back each time.
  useEffect(() => {
    if (phase === 'idle') return
    const mark = () => !document.title.startsWith(REC_MARK) && (document.title = REC_MARK + document.title)
    mark()
    const title = document.querySelector('title')
    const observer = new MutationObserver(mark)
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      if (document.title.startsWith(REC_MARK)) document.title = document.title.slice(REC_MARK.length)
    }
  }, [phase])

  /** Ends this page's recording as the page `to` asked: its text goes to `to`'s chat, here or (through the server) there. */
  const finish = async (how: StopHow, to: string) => {
    if (phaseRef.current !== 'recording' && phaseRef.current !== 'paused') return
    if (how === 'discard') {
      discard()
      return
    }
    const stoppedAt = Date.now()
    setPhase('finishing')
    const mine = generation.current
    await run((detector) => detector.pause())
    const results = await Promise.all(segments.current)
    if (mine !== generation.current) return
    const failed = results.find((result): result is { error: string } => 'error' in result)
    const text = results
      .map((result) => ('text' in result ? result.text : ''))
      .filter(Boolean)
      .join(' ')
    const error = failed?.error ?? (text ? null : 'Nothing was heard')
    logDictation({ startedAt: recordingStart.current, stoppedAfterMs: stoppedAt - recordingStart.current, how, here: to === pageId, segments: results.length, misfires: misfires.current, segmentTexts: results.map((result) => ('text' in result ? result.text : { error: result.error })), text, error })
    setPhase('idle')
    if (to !== pageId) {
      void updateListener({ id: pageId, result: { to, text, send: how === 'send', error } })
      return
    }
    void updateListener({ id: pageId, recording: null })
    if (error) latest.current.onError(error)
    if (text) latest.current.onText(text, how === 'send' && !failed, latest.current.pinOnSend)
  }
  const discard = () => {
    if (phaseRef.current !== 'idle') logDictation({ startedAt: recordingStart.current, stoppedAfterMs: Date.now() - recordingStart.current, how: 'discard', segments: segments.current.length, misfires: misfires.current })
    generation.current++
    segments.current = []
    setPhase('idle')
    void updateListener({ id: pageId, recording: null })
  }
  useEffect(() => {
    latest.current = { onText, onError, hears: listen && owner, listen, pinOnSend, owner, remote, waitingSince, finish }
  })

  // The poll: who owns the mic, the recording to show, a stop for this page's recording, and text for this page.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      const now = latest.current
      const live = phaseRef.current !== 'idle' || now.remote || now.waitingSince
      // A page in the background that neither holds the mic nor waits for anything has nothing to check.
      if (live || (now.listen && now.owner) || document.visibilityState === 'visible') {
        let view = await getListener(pageId)
        if (view && now.listen && view.stale && document.visibilityState === 'visible' && document.hasFocus()) view = await updateListener({ id: pageId, claim: true })
        if (!alive) return
        if (view) {
          setOwner(view.id === pageId)
          // Once this page has stopped it, the recording shows as transcribing here until its text comes back.
          const shown = view.recording && view.id !== pageId && !now.waitingSince ? view.recording : null
          setRemote((current) => (JSON.stringify(current) === JSON.stringify(shown) ? current : shown))
          if (view.stop && (phaseRef.current === 'recording' || phaseRef.current === 'paused')) void latest.current.finish(view.stop.how, view.stop.to)
          if (view.result) {
            setWaitingSince(0)
            if (view.result.error) latest.current.onError(view.result.error)
            if (view.result.text) latest.current.onText(view.result.text, view.result.send && !view.result.error, latest.current.pinOnSend)
          } else if (now.waitingSince && Date.now() - now.waitingSince > RESULT_WAIT_MS) {
            setWaitingSince(0)
            latest.current.onError('The recording page never sent its text back (closed, or Controls restarted?)')
          }
        }
      }
      if (alive) timer = setTimeout(() => void check(), phaseRef.current !== 'idle' || latest.current.remote || latest.current.waitingSince ? FAST_MS : SLOW_MS)
    }
    void check()
    // Closing the page lets the mic go at once, rather than after the server's 90s.
    const release = () => void updateListener({ id: pageId, release: true }, true)
    const onShow = () => document.visibilityState === 'visible' && (clearTimeout(timer), void check())
    window.addEventListener('pagehide', release)
    document.addEventListener('visibilitychange', onShow)
    return () => {
      alive = false
      clearTimeout(timer)
      window.removeEventListener('pagehide', release)
      document.removeEventListener('visibilitychange', onShow)
      release()
    }
  }, [pageId])
  // With listening on, a click or a key here takes the mic from another cockpit (unless that one is mid-recording).
  useEffect(() => {
    if (!listen || owner) return
    const claim = () => void updateListener({ id: pageId, claim: true }).then((view) => view && setOwner(view.id === pageId))
    window.addEventListener('pointerdown', claim, true)
    window.addEventListener('keydown', claim, true)
    return () => {
      window.removeEventListener('pointerdown', claim, true)
      window.removeEventListener('keydown', claim, true)
    }
  }, [listen, owner, pageId])

  /** Records here, by hand: takes the mic first, which fails only while another page records. */
  const start = async () => {
    if (phaseRef.current !== 'idle' || remote) return
    const view = await updateListener({ id: pageId, claim: true })
    if (view?.id !== pageId) {
      onError(view ? 'Another cockpit is recording' : 'The studio server is not answering')
      return
    }
    setOwner(true)
    begin()
  }
  /** Stops the recording, wherever it is, with its text for this page. */
  const stop = (how: StopHow) => {
    if (phaseRef.current === 'recording' || phaseRef.current === 'paused') void finish(how, pageId)
    else if (remote) {
      void updateListener({ id: pageId, stop: how })
      setRemote(null)
      if (how !== 'discard') setWaitingSince(Date.now())
    }
  }
  const recording = phase === 'recording' || phase === 'paused' || Boolean(remote)
  const asking = phase === 'recording' && Boolean(pauseAt)
  const transcribing = phase === 'finishing' || Boolean(waitingSince)

  // Captured before the chat sees it, so Esc here drops the recording rather than interrupting Claude.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return
      const space = event.key === ' '
      const active = document.activeElement
      const inBox = Boolean(box.current) && active === box.current
      // Space is left alone in anything you type in or pick from (another box, a menu, a dialog); anywhere else on the page it records.
      const typingElsewhere = !inBox && active instanceof HTMLElement && (active.isContentEditable || Boolean(active.closest('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"]')))
      if (recording && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        stop('discard')
        return
      }
      if (!space || typingElsewhere) return
      // Asked whether you're still talking, or paused: Space keeps recording rather than sending.
      if (asking || phase === 'paused') {
        event.preventDefault()
        if (!event.repeat) keepRecording()
        return
      }
      if (recording) {
        event.preventDefault()
        if (!event.repeat) stop('send')
        return
      }
      // In the box, only while it's empty: with text in it Space is a space. Elsewhere (a button, the page, the chat collapsed) it records.
      if (inBox && box.current?.value) return
      if (transcribing) {
        event.preventDefault()
        return
      }
      if (!disabled && !event.repeat) {
        event.preventDefault()
        void start()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const toggleListen = () => {
    setListen(!listen)
    if (!listen) void updateListener({ id: pageId, claim: true }).then((view) => view && setOwner(view.id === pageId))
  }
  const hearing = listen && owner && open
  const listenTitle = !listen
    ? 'Listen: start speaking and it records by itself, and keeps recording until you press Space to send (Esc drops it). One cockpit listens at a time: the one you last clicked or typed in'
    : hearing
      ? 'Listening here, even while you are in another tab or app: start speaking and it records. Stop it from any cockpit; the text goes to the one you stop it from. Click to stop listening everywhere'
      : owner
        ? 'Listening is on, but this chat has no session to send to'
        : 'Listening is on in another cockpit (the one you last clicked or typed in). Click or type here to listen here instead. Click this to stop listening everywhere'

  const buttons = (
    <>
      <Button
        size="icon-sm"
        variant={listen ? 'secondary' : 'ghost'}
        aria-label={listen ? 'Stop listening' : 'Listen'}
        aria-pressed={listen}
        title={tip(listenTitle)}
        disabled={disabled && !listen}
        onClick={toggleListen}
        className={cn(hearing && 'text-emerald-600 dark:text-emerald-400', listen && !hearing && 'opacity-60')}
      >
        {listen ? <Ear /> : <EarOff className="opacity-60" />}
      </Button>
      <Button
        size="icon-sm"
        variant={recording ? 'destructive' : 'ghost'}
        aria-label={recording ? 'Stop and put the text in the box' : transcribing ? 'Transcribing' : 'Dictate a message'}
        aria-pressed={recording}
        title={tip(
          recording
            ? 'Click to put what you said in this box to edit (Space sends it, Esc drops it)'
            : transcribing
              ? 'Transcribing'
              : 'Dictate. Space records (in the empty box, or anywhere on the page but another box), Space again sends it (Esc drops it). Or click, speak, and click again to get the text in the box to edit'
        )}
        disabled={transcribing || (disabled && !recording)}
        onClick={() => (recording ? stop('edit') : void start())}
      >
        {recording ? <Square className="animate-pulse fill-current" /> : transcribing ? <LoaderCircle className="animate-spin" /> : <Mic />}
      </Button>
    </>
  )
  // With listening on the pill stays up between recordings, its ear the switch to turn listening off.
  const pill =
    (recording || transcribing || listen) &&
    createPortal(
      <RecordingPill
        recording={recording}
        transcribing={transcribing}
        startedAt={phase !== 'idle' ? startedAt : (remote?.startedAt ?? 0)}
        pausesAt={asking ? pauseAt : 0}
        paused={phase === 'paused'}
        onKeepRecording={keepRecording}
        level={phase === 'recording' ? level : null}
        elsewhere={remote}
        listening={listen ? { hearing, owner, title: listenTitle } : null}
        onStopListening={toggleListen}
        pinOnSend={pinOnSend}
        onTogglePinOnSend={() => setPinOnSend(!pinOnSend)}
        onReveal={() =>
          void revealRecording(pageId).then((shown) => {
            if (!shown && remote?.url) window.open(remote.url, '_blank')
          })
        }
        onSend={() => stop('send')}
        onDiscard={() => stop('discard')}
      />,
      document.body
    )
  return { buttons, pill }
}

const BAR_WEIGHTS = [0.45, 0.75, 1, 0.75, 0.45]

/**
 * The floating recording control, as in Loom: how long, how loud (on the page recording), where it's
 * recording if not here (a link that brings that tab forward), and Send or Discard: a tab on the bottom
 * edge. With listening on it stays up between recordings, showing it's listening, and its ear turns listening off.
 * Its pin says whether sending also pins the chat open.
 */
const RecordingPill = ({
  recording,
  transcribing,
  startedAt,
  pausesAt,
  paused,
  onKeepRecording,
  level,
  elsewhere,
  listening,
  onStopListening,
  pinOnSend,
  onTogglePinOnSend,
  onReveal,
  onSend,
  onDiscard,
}: {
  recording: boolean
  transcribing: boolean
  startedAt: number
  /** While this page's recording asks whether you're still talking: when it pauses. */
  pausesAt: number
  /** This page's recording is paused, its mic closed, after no one answered. */
  paused: boolean
  onKeepRecording: () => void
  level: RefObject<number> | null
  elsewhere: Recording | null
  /** Listening is on: whether this page hears (is the cockpit listening, with a session to send to), and what the ear says. */
  listening: { hearing: boolean; owner: boolean; title: string } | null
  onStopListening: () => void
  /** Whether sending also pins the chat open; the pill's pin turns it on and off. */
  pinOnSend: boolean
  onTogglePinOnSend: () => void
  onReveal: () => void
  onSend: () => void
  onDiscard: () => void
}) => {
  const [now, setNow] = useState(() => Date.now())
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    let frame = requestAnimationFrame(function draw() {
      const loud = level ? Math.min(1, level.current * 12) : 0
      bars.current.forEach((bar, i) => bar && (bar.style.height = `${4 + 16 * loud * BAR_WEIGHTS[i]}px`))
      frame = requestAnimationFrame(draw)
    })
    return () => {
      clearInterval(timer)
      cancelAnimationFrame(frame)
    }
  }, [level])
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  // One layout in every state, a fixed-width tab on the bottom edge, so starting a recording only changes what's in it.
  return (
    <div
      role="status"
      aria-label={recording ? 'Recording' : transcribing ? 'Transcribing' : 'Listening'}
      className="fixed bottom-0 left-1/2 z-[100] flex w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-t-lg bg-neutral-900/95 py-1 pr-1 pl-2 text-white shadow-lg ring-1 ring-white/10 backdrop-blur"
    >
      {listening && (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Stop listening"
          title={listening.title}
          onClick={onStopListening}
          className={cn('hover:bg-white/10', listening.hearing ? 'text-emerald-400 hover:text-emerald-300' : 'text-neutral-400 hover:text-white')}
        >
          <Ear />
        </Button>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Pin the chat open on send"
        aria-pressed={pinOnSend}
        title={pinOnSend ? 'Sending pins the chat open, to watch the message being worked on. Click to just send' : 'Sending leaves the chat as it is. Click to also pin it open on send, to watch the message being worked on'}
        onClick={onTogglePinOnSend}
        className={cn('hover:bg-white/10', pinOnSend ? 'text-white' : 'text-neutral-400 hover:text-white')}
      >
        {pinOnSend ? <Pin className="fill-current" /> : <PinOff />}
      </Button>
      <span className="flex h-6 min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-neutral-400">
        {paused ? (
          <>
            <span className="size-2 shrink-0 rounded-full bg-amber-400" />
            <button type="button" onClick={onKeepRecording} className="truncate text-white underline decoration-neutral-500 underline-offset-2 hover:decoration-white">
              Paused, no one answered · Space resumes · Esc discards
            </button>
          </>
        ) : recording ? (
          <>
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />
            <span className="font-mono text-sm text-white tabular-nums">
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </span>
            {level && (
              <span className="flex h-5 shrink-0 items-center gap-0.5" aria-hidden>
                {BAR_WEIGHTS.map((_, i) => (
                  <span key={i} ref={(bar) => void (bars.current[i] = bar)} className="w-1 rounded-full bg-red-400 transition-[height] duration-75" style={{ height: 4 }} />
                ))}
              </span>
            )}
            {elsewhere && (
              <button type="button" onClick={onReveal} title={'Go to the tab recording, ' + elsewhere.url} className="inline-flex items-center gap-1 text-neutral-300 underline decoration-neutral-500 underline-offset-2 hover:text-white">
                in {elsewhere.where} <ExternalLink className="size-3" />
              </button>
            )}
            {pausesAt ? (
              <button type="button" onClick={onKeepRecording} className="truncate font-medium text-amber-300 underline decoration-amber-300/50 underline-offset-2 hover:text-amber-200">
                Still talking? Space keeps recording · pausing in {Math.max(0, Math.ceil((pausesAt - now) / 1000))}s
              </button>
            ) : (
              <span className="truncate">Space sends here · Esc discards</span>
            )}
          </>
        ) : transcribing ? (
          <>
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-neutral-300" />
            <span className="truncate">Transcribing…</span>
          </>
        ) : (
          <span className="truncate">{listening?.hearing ? 'Listening · speak to record' : listening?.owner ? 'Listening · no session to send to' : 'Listening in another cockpit'}</span>
        )}
      </span>
      {/* Always there, so the tab keeps its shape; hidden while only listening. */}
      <span className={cn('flex shrink-0 items-center gap-1', !recording && !transcribing && 'invisible')}>
        <Button size="icon-xs" variant="ghost" aria-label="Discard the recording" title="Discard (Esc)" disabled={!recording} onClick={onDiscard} className="text-neutral-300 hover:bg-white/10 hover:text-white">
          <Trash2 />
        </Button>
        <Button size="xs" disabled={!recording} onClick={onSend} className="bg-white px-2.5 text-neutral-900 hover:bg-neutral-200">
          <Check /> Send
        </Button>
      </span>
    </div>
  )
}
