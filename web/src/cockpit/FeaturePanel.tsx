import { LoaderCircle, Play } from 'lucide-react'
import { useState } from 'react'
import { useControls } from '@/components/controls/ControlsProvider'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { startFeature } from '@/lib/api'
import { plural } from '@/lib/format'
import type { Feature } from '@/lib/types'

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

/** The Feature section's body: the feature being built and its checkpoints (each with what she asked for), or a way to start one. */
export const FeaturePanel = ({ feature }: { feature: Feature | null | undefined }) => {
  if (!feature) return <StartFeature hint="No feature in progress. Name one to start building it." />
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
    </div>
  )
}
