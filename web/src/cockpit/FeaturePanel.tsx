import { Check, LoaderCircle, Play, Trash2, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useControls } from '@/components/controls/ControlsProvider'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { checkFeature, discardFeature, keepFeature, sendToSession, startFeature } from '@/lib/api'
import { plural } from '@/lib/format'
import type { App, Feature, FeatureCheck } from '@/lib/types'

type StartFeatureProps = {
  /** Shown above the box. */
  hint?: string
  /** Called once the feature has started. */
  onStarted?: () => void
  onCancel?: () => void
  autoFocus?: boolean
}

/** A box to name a feature, and Start: develop is reset to the latest version and the chat starts afresh. */
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

/**
 * Keep and Discard. Keep first runs the tests and writes the summary; when the tests pass it shows the summary and asks
 * to confirm. When they fail, Keep is greyed out until the next checkpoint, with what failed, [Ask Claude to fix the
 * tests], [Run them again] and "keep anyway". Both wait while Claude is working.
 */
const KeepOrDiscard = ({ w, feature }: { w: App; feature: Feature }) => {
  const tip = useTip()
  const { confirm, refresh } = useControls()
  const chat = w.agents.find((agent) => agent.tab !== 'Artifacts')
  const claudeBusy = chat?.status === 'working' || chat?.status === 'blocked'
  // A test run counts until the next checkpoint: then Keep runs them again.
  const runFor = feature.checkpoints.at(-1)?.sha ?? feature.base
  const [run, setRun] = useState<{ for: string; check: FeatureCheck } | null>(null)
  const check = run?.for === runFor ? run.check : null
  const [doing, setDoing] = useState<'checking' | 'keeping' | 'discarding' | null>(null)
  const [message, setMessage] = useState('')
  const failed = check && !check.ok ? check.results.filter((result) => !result.ok) : []
  const disabled = claudeBusy || doing !== null
  const why = claudeBusy ? (chat?.status === 'working' ? 'Claude is working…' : 'Claude is waiting on a question') : ''

  const keep = async (found: FeatureCheck, anyway: boolean) => {
    const ok = await confirm(
      `Keep "${feature.name}" as ${found.version}?\n${anyway ? 'Its tests fail, and it will be kept as it is. ' : ''}This goes into the app's list of features:\n\n${found.summary}`
    )
    if (!ok) return
    setDoing('keeping')
    const kept = await keepFeature(found.summary, anyway)
    setDoing(null)
    if ('error' in kept) return setMessage(kept.error)
    setMessage('')
    setRun(null)
    await refresh()
  }
  const runTests = async () => {
    setDoing('checking')
    setMessage('')
    const found = await checkFeature()
    setDoing(null)
    if ('error' in found) return setMessage(found.error)
    setRun({ for: runFor, check: found })
    if (found.ok) await keep(found, false)
  }
  const discard = async () => {
    const latest = w.versions.at(-1)?.tag ?? 'the latest version'
    const ok = await confirm(
      `Discard "${feature.name}" and its ${plural(feature.checkpoints.length, 'checkpoint')}?\nThe app goes back to ${latest}, and its data back to how it was when you started "${feature.name}". This can't be undone.`
    )
    if (!ok) return
    setDoing('discarding')
    const discarded = await discardFeature()
    setDoing(null)
    if ('error' in discarded) return setMessage(discarded.error)
    setMessage('')
    setRun(null)
    await refresh()
  }
  const askClaude = async () => {
    if (!chat) return setMessage("Claude isn't running. Start it from the chat, then ask again.")
    const output = failed.map((result) => `${result.name}: …${result.output.slice(-Math.floor(MAX_FAILURE / failed.length))}`).join(' ')
    const error = await sendToSession({
      paneId: chat.paneId,
      text: `The tests fail, so "${feature.name}" can't be kept yet. Please run \`npm test\` and \`npm run typecheck\` and fix what fails. The end of what failed: ${output}`,
    })
    setMessage(error ?? 'Sent to Claude. Keep runs the tests again after its next change.')
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={disabled || failed.length > 0}
          title={tip(why || (failed.length ? 'The tests fail: fix them, or keep it anyway' : `Run the tests, then keep "${feature.name}" as the next version`))}
          onClick={() => void runTests()}
        >
          {doing === 'checking' || doing === 'keeping' ? <LoaderCircle className="animate-spin" /> : <Check />} Keep
        </Button>
        <Button size="sm" variant="destructive" disabled={disabled} title={tip(why || `Throw "${feature.name}" away and go back to the latest version`)} onClick={() => void discard()}>
          {doing === 'discarding' ? <LoaderCircle className="animate-spin" /> : <Trash2 />} Discard
        </Button>
      </div>
      {claudeBusy && <p className="text-xs text-muted-foreground">{why}</p>}
      {doing === 'checking' && <p className="text-xs text-muted-foreground">Running the tests and writing the summary…</p>}
      {failed.length > 0 && (
        <div className="grid gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-2">
          <p className="text-sm">The tests fail, so this can't be kept yet.</p>
          {failed.map((result) => (
            <details key={result.name} className="text-xs">
              <summary className="cursor-pointer text-destructive">{result.name} failed</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-1.5 text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">{result.output || '(no output)'}</pre>
            </details>
          ))}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => void askClaude()}>
              <Wrench /> Ask Claude to fix the tests
            </Button>
            <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void runTests()}>
              Run them again
            </Button>
            <Button size="xs" variant="link" className="ml-auto px-0 text-muted-foreground" disabled={disabled} onClick={() => void keep(check!, true)}>
              keep anyway
            </Button>
          </div>
        </div>
      )}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}

/** The Feature section's body: the feature being built and its checkpoints (each with what she asked for), Keep and Discard; or a way to start one. */
export const FeaturePanel = ({ w }: { w: App | null }) => {
  const feature = w?.feature
  if (!w || !feature) return <StartFeature hint="No feature in progress. Name one to start building it." />
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={feature.name}>
          {feature.name}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{plural(feature.checkpoints.length, 'checkpoint')}</span>
      </div>
      {feature.checkpoints.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ask Claude for the first change. Each change it makes is saved here as a checkpoint.</p>
      ) : (
        <ol className="grid gap-2 border-l pl-3">
          {feature.checkpoints.map((checkpoint) => (
            <li key={checkpoint.sha} className="relative grid gap-0.5">
              <span aria-hidden className="absolute top-1.5 -left-[17px] size-2 rounded-full bg-sky-600" />
              <span className="text-sm [overflow-wrap:anywhere]">{checkpoint.label}</span>
              {checkpoint.prompt && (
                <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={checkpoint.prompt}>
                  you asked: {checkpoint.prompt}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <KeepOrDiscard w={w} feature={feature} />
    </div>
  )
}
