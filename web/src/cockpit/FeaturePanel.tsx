import { cn } from 'cn'
import { Check, Hourglass, KeyRound, LoaderCircle, Play, RotateCcw, Trash2, Undo2, Wrench, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { useControls } from '@/components/controls/ControlsProvider'
import { Markdown } from './Markdown'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { bringBack, checkFeaturePart, discardFeature, goBackTo, keepFeature, sendToSession, startFeature } from '@/lib/api'
import { plural } from '@/lib/format'
import type { App, Checkpoint, Feature, FeatureCheck } from '@/lib/types'

type StartFeatureProps = {
  /** Shown above the box. */
  hint?: string
  /** Called once the feature has started. */
  onStarted?: () => void
  onCancel?: () => void
  autoFocus?: boolean
}

/** A box to name a feature, and Start: develop is reset to the latest version; the chat carries on into it. */
export const StartFeature = ({ hint, onStarted, onCancel, autoFocus }: StartFeatureProps) => {
  const tip = useTip()
  const { refresh } = useControls()
  const [name, setName] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!name.trim() || starting) return
    setStarting(true)
    const failed = await startFeature(name.trim())
    setStarting(false)
    if (failed) return setError(failed)
    setName('')
    setError('')
    await refresh()
    onStarted?.()
  }
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="Name of the feature"
          placeholder="e.g. dark mode"
          maxLength={80}
          autoFocus={autoFocus}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onCancel?.()}
        />
        <Button type="submit" size="sm" disabled={!name.trim() || starting} title={tip('Start building this feature from the latest version, with a fresh conversation')}>
          {starting ? <LoaderCircle className="animate-spin" /> : <Play />} Start
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  )
}

// What Claude is sent by [Ask Claude to fix the tests]: the end of each failing run's output, on one line.
const MAX_FAILURE = 1500

type GatePart = Pick<FeatureCheck, 'ok' | 'results' | 'version'>
type SummaryPart = Pick<FeatureCheck, 'summary' | 'summaryFallback' | 'version'>
type Step<T> = { state: 'running' } | { state: 'done'; value: T } | { state: 'failed'; error: string }

/** A step of Keep's check, as a line: a spinner while it runs, then a tick, a cross or what went wrong. */
const StepLine = ({ step, running, done, failed }: { step: Step<unknown>; running: string; done: string; failed?: string | null }) => (
  <li className="flex items-start gap-2 text-sm">
    {step.state === 'running' ? (
      <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
    ) : step.state === 'done' && !failed ? (
      <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
    ) : (
      <X className="mt-0.5 size-4 shrink-0 text-destructive" />
    )}
    <span className={cn(step.state === 'running' && 'text-muted-foreground')}>{step.state === 'running' ? running : step.state === 'failed' ? step.error : (failed ?? done)}</span>
  </li>
)

/**
 * Keep, as one dialog that opens at once: it runs the app's checks and writes the summary side by side, showing each as it
 * finishes, with room kept for the summary so nothing moves when it arrives. Clicking outside does nothing; Cancel (or Esc)
 * closes it, and a check still running is then ignored. When the checks pass: [Keep as vN]. When they fail: what failed,
 * [Ask Claude to fix it] and [Keep anyway]. While it's open the rest of the cockpit is covered, and the studio refuses
 * messages to Claude, so nothing changes the app while it's kept. A passing check is reused until the next checkpoint.
 */
const KeepDialog = ({ open, feature, runFor, nextVersion, onClose, onKept, onAskClaude }: { open: boolean; feature: Feature; runFor: string; nextVersion: string; onClose: () => void; onKept: () => void; onAskClaude: (failed: GatePart['results']) => void }) => {
  const [gate, setGate] = useState<Step<GatePart>>({ state: 'running' })
  const [summary, setSummary] = useState<Step<SummaryPart>>({ state: 'running' })
  const [keeping, setKeeping] = useState(false)
  const [error, setError] = useState('')
  // Claude busy when Keep began: not a failure. Working: the checks start once it's done. A question: it needs answering first.
  const [waiting, setWaiting] = useState<'working' | 'question' | null>(null)
  // Which opening a result belongs to: one that arrives after Cancel (or for an older opening) is dropped.
  const opening = useRef(0)
  const passed = useRef<{ for: string; gate: GatePart; summary: SummaryPart } | null>(null)

  useEffect(() => {
    if (!open) return
    const id = ++opening.current
    setError('')
    setKeeping(false)
    const reuse = passed.current?.for === runFor ? passed.current : null
    if (reuse) {
      setGate({ state: 'done', value: reuse.gate })
      setSummary({ state: 'done', value: reuse.summary })
      return
    }
    setGate({ state: 'running' })
    setSummary({ state: 'running' })
    setWaiting(null)
    const run = <T,>(part: 'gate' | 'summary', set: (step: Step<T>) => void) =>
      void checkFeaturePart(part).then((found) => {
        if (opening.current !== id) return
        const error = 'error' in found ? found.error : null
        const busy = error?.startsWith('Claude is working') ? 'working' : error?.startsWith('Claude is waiting on a question') ? 'question' : null
        if (busy) {
          setWaiting(busy)
          // Asked again until Claude is free; a question can't be answered behind the dialog, so it's left to Cancel.
          if (busy === 'working') setTimeout(() => opening.current === id && run(part, set), 2000)
          return
        }
        setWaiting(null)
        set(error ? { state: 'failed', error } : { state: 'done', value: found as T })
      })
    run<GatePart>('gate', setGate)
    run<SummaryPart>('summary', setSummary)
  }, [open, runFor])

  const gateDone = gate.state === 'done' ? gate.value : null
  const summaryDone = summary.state === 'done' ? summary.value : null
  useEffect(() => {
    if (gateDone?.ok && summaryDone) passed.current = { for: runFor, gate: gateDone, summary: summaryDone }
  }, [gateDone, summaryDone, runFor])
  const failed = gateDone && !gateDone.ok ? gateDone.results.filter((result) => !result.ok) : []
  // Known before the server answers (the next number after the last version), so the title and button never change width.
  const version = gateDone?.version ?? summaryDone?.version ?? nextVersion

  const cancel = () => {
    opening.current += 1
    onClose()
  }
  const keep = async (anyway: boolean) => {
    if (!summaryDone) return
    setKeeping(true)
    setError('')
    const kept = await keepFeature(summaryDone.summary, anyway)
    setKeeping(false)
    if ('error' in kept) {
      // Refused (the app changed since the checks ran, say): the next Keep runs them again.
      passed.current = null
      return setError(kept.error)
    }
    passed.current = null
    onKept()
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !keeping && cancel()}>
      <AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Keep “{feature.name}” as {version}?
          </AlertDialogTitle>
        </AlertDialogHeader>
        {/* Two lines whatever they say, so nothing below moves. */}
        <ul className="grid min-h-12 gap-1.5">
          {waiting ? (
            <li className="flex items-start gap-2 text-sm text-muted-foreground">
              {waiting === 'working' ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" /> : <Hourglass className="mt-0.5 size-4 shrink-0" />}
              <span>{waiting === 'working' ? 'Waiting for Claude to finish what it’s doing… The checks start as soon as it has.' : 'Claude is waiting for an answer in the chat. Cancel, answer it, then press Keep again.'}</span>
            </li>
          ) : (
            <>
              <StepLine step={gate} running="Running the app's checks…" done="The app's checks pass" failed={failed.length ? "The app's checks fail" : null} />
              <StepLine step={summary} running="Writing a summary of what this feature does…" done="Summary written" />
            </>
          )}
        </ul>
        {/* A fixed-size box for the summary (and what failed), scrolling inside, so the dialog never changes size. */}
        <div className="h-56 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2.5 text-sm leading-relaxed">
          {failed.length > 0 && (
            <div className="mb-2 grid gap-1 border-b pb-2">
              {failed.map((result) => (
                <details key={result.name} className="text-xs">
                  <summary className="cursor-pointer text-destructive">{result.name} failed</summary>
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-1.5 text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">{result.output || '(no output)'}</pre>
                </details>
              ))}
            </div>
          )}
          {summaryDone ? (
            <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              <Markdown text={summaryDone.summary} />
            </div>
          ) : (
            <div className="grid animate-pulse gap-2 pt-1" aria-label="Writing the summary">
              <div className="h-3 w-11/12 rounded bg-muted-foreground/15" />
              <div className="h-3 w-4/5 rounded bg-muted-foreground/15" />
              <div className="h-3 w-3/5 rounded bg-muted-foreground/15" />
            </div>
          )}
        </div>
        {/* Its line is always there, so an error doesn't push the buttons down. */}
        <p className="min-h-5 text-sm text-destructive">{error}</p>
        <AlertDialogFooter>
          {/* Always there (at the far left), so the buttons don't move: offered only when the checks fail. */}
          <Button variant="ghost" className={cn('sm:mr-auto', failed.length === 0 && 'invisible')} disabled={keeping || !summaryDone || failed.length === 0} onClick={() => void keep(true)}>
            Keep anyway
          </Button>
          <Button variant="outline" disabled={keeping} onClick={cancel}>
            Cancel
          </Button>
          {/* One width for both of its jobs, so swapping them doesn't move anything. */}
          {failed.length > 0 ? (
            <Button
              className="w-44"
              disabled={keeping}
              onClick={() => {
                cancel()
                onAskClaude(failed)
              }}
            >
              <Wrench /> Ask Claude to fix it
            </Button>
          ) : (
            <Button className="w-44" disabled={keeping || !gateDone?.ok || !summaryDone} onClick={() => void keep(false)}>
              {keeping ? <LoaderCircle className="animate-spin" /> : <Check />} Keep as {version}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Keep (the KeepDialog) and Discard. Both wait while Claude is working. */
const KeepOrDiscard = ({ w, feature }: { w: App; feature: Feature }) => {
  const tip = useTip()
  const { confirm, refresh } = useControls()
  const chat = w.agents.find((agent) => agent.tab !== 'Artifacts')
  const claudeBusy = chat?.status === 'working' || chat?.status === 'blocked'
  // A passing check counts until the next checkpoint.
  const runFor = feature.checkpoints.at(-1)?.sha ?? feature.base
  const [keepOpen, setKeepOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [message, setMessage] = useState('')
  const disabled = claudeBusy || discarding || keepOpen
  const why = claudeBusy ? (chat?.status === 'working' ? 'Claude is working…' : 'Claude is waiting on a question') : ''

  const discard = async () => {
    const latest = w.versions.at(-1)?.tag ?? 'the latest version'
    const ok = await confirm(
      `Discard "${feature.name}" and its ${plural(feature.checkpoints.length, 'checkpoint')}?\nThe app goes back to ${latest}, and its data back to how it was when you started "${feature.name}". This can't be undone.`
    )
    if (!ok) return
    setDiscarding(true)
    const discarded = await discardFeature()
    setDiscarding(false)
    if ('error' in discarded) return setMessage(discarded.error)
    setMessage('')
    await refresh()
  }
  const askClaude = async (failed: GatePart['results']) => {
    if (!chat) return setMessage("Claude isn't running. Start it from the chat, then ask again.")
    const output = failed.map((result) => `${result.name}: …${result.output.slice(-Math.floor(MAX_FAILURE / failed.length))}`).join(' ')
    const error = await sendToSession({
      paneId: chat.paneId,
      text: `The app's checks fail, so "${feature.name}" can't be kept yet. Please run \`npm test\` and \`npm run typecheck\` and fix what fails. The end of what failed: ${output}`,
    })
    setMessage(error ?? 'Sent to Claude. Press Keep again once it has fixed them.')
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={disabled}
          title={tip(why || `Check the app, then keep "${feature.name}" as the next version`)}
          onClick={() => {
            setMessage('')
            setKeepOpen(true)
          }}
        >
          <Check /> Keep
        </Button>
        <Button size="sm" variant="destructive" disabled={disabled} title={tip(why || `Throw "${feature.name}" away and go back to the latest version`)} onClick={() => void discard()}>
          {discarding ? <LoaderCircle className="animate-spin" /> : <Trash2 />} Discard
        </Button>
      </div>
      {claudeBusy && <p className="text-xs text-muted-foreground">{why}</p>}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      <KeepDialog
        open={keepOpen}
        feature={feature}
        runFor={runFor}
        nextVersion={`v${Math.max(0, ...w.versions.map((version) => Number(version.tag.slice(1)) || 0)) + 1}`}
        onClose={() => setKeepOpen(false)}
        onKept={() => {
          setKeepOpen(false)
          void refresh()
        }}
        onAskClaude={(failed) => void askClaude(failed)}
      />
    </div>
  )
}

/**
 * The checkpoints, oldest first, each with what the user asked for and (but the newest) [Go back to here], which asks first, naming
 * the later checkpoints it discards. After going back, [Bring them back] restores them until the next message.
 */
const Checkpoints = ({ w, feature }: { w: App; feature: Feature }) => {
  const tip = useTip()
  const { confirm, refresh } = useControls()
  const chat = w.agents.find((agent) => agent.tab !== 'Artifacts')
  const claudeBusy = chat?.status === 'working' || chat?.status === 'blocked'
  const [doing, setDoing] = useState(false)
  const [message, setMessage] = useState('')
  const disabled = claudeBusy || doing
  const why = claudeBusy ? (chat?.status === 'working' ? 'Claude is working…' : 'Claude is waiting on a question') : ''

  const act = async (action: () => Promise<object | { error: string }>) => {
    setDoing(true)
    const done = await action()
    setDoing(false)
    setMessage('error' in done ? done.error : '')
    await refresh()
  }
  const goBack = async (checkpoint: Checkpoint, later: Checkpoint[]) => {
    const ok = await confirm(
      `Go back to "${checkpoint.label}"?\nThe app's code and data go back to how they were at this checkpoint, and ${later.length === 1 ? 'this later checkpoint is' : `these ${later.length} later checkpoints are`} discarded:\n\n${later.map((c) => `• ${c.label}`).join('\n')}\n\nYou can bring them back until you send your next message.`
    )
    if (ok) await act(() => goBackTo(checkpoint.sha))
  }

  return (
    <>
      <ol className="grid gap-2 border-l pl-3">
        {feature.checkpoints.map((checkpoint, i) => (
          <li key={checkpoint.sha} className="relative grid gap-0.5">
            <span aria-hidden className="absolute top-1.5 -left-[17px] size-2 rounded-full bg-sky-600" />
            <span className="text-sm [overflow-wrap:anywhere]">{checkpoint.label}</span>
            {checkpoint.prompt && (
              <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={checkpoint.prompt}>
                you asked: {checkpoint.prompt}
              </span>
            )}
            {i < feature.checkpoints.length - 1 && (
              <Button
                size="xs"
                variant="link"
                className="justify-self-start px-0 text-muted-foreground"
                disabled={disabled}
                title={tip(why || 'Put the code and data back to how they were at this checkpoint, discarding the later ones')}
                onClick={() => void goBack(checkpoint, feature.checkpoints.slice(i + 1))}
              >
                <RotateCcw /> Go back to here
              </Button>
            )}
          </li>
        ))}
      </ol>
      {w.wentBack && (
        <div className="grid gap-1 rounded-lg border bg-muted/40 p-2 text-sm">
          <p>
            Went back to "{w.wentBack.to.label}". {plural(w.wentBack.discarded.length, 'later checkpoint')} discarded.
          </p>
          <Button size="xs" variant="outline" className="justify-self-start" disabled={disabled} title={tip(why || 'Undo going back: until you send your next message')} onClick={() => void act(bringBack)}>
            <Undo2 /> Bring them back
          </Button>
        </div>
      )}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </>
  )
}

/** The Feature section's body: the feature being built and its checkpoints (each with what the user asked for), Keep and Discard; or a way to start one. */
export const FeaturePanel = ({ w }: { w: App | null }) => {
  const feature = w?.feature
  if (w?.preview && !feature) return <p className="text-sm text-muted-foreground">You're previewing {w.preview.tag}. Go back to the latest version to start a feature.</p>
  if (!w || !feature) return <StartFeature hint="No feature in progress. Name one to start building it." />
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={feature.name}>
          {feature.name}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{plural(feature.checkpoints.length, 'checkpoint')}</span>
      </div>
      {w.refused && (
        <div className="grid gap-1 rounded-lg border border-amber-600/40 bg-amber-500/10 p-2 text-sm" role="status">
          <span className="flex items-center gap-1.5 font-medium">
            <KeyRound className="size-3.5 shrink-0" /> The last change wasn't saved as a checkpoint
          </span>
          <span className="text-xs [overflow-wrap:anywhere]">
            It contains a secret from the app's .env file ({w.refused.leaks}), and secrets never go into the app's history. Claude was asked to move it into .env; if it hasn't, ask it to.
          </span>
        </div>
      )}
      {feature.checkpoints.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ask Claude for the first change. Each change it makes is saved here as a checkpoint.</p>
      ) : (
        <Checkpoints w={w} feature={feature} />
      )}
      <KeepOrDiscard w={w} feature={feature} />
    </div>
  )
}
