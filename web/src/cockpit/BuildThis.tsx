import { Hammer, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useControls } from '@/components/controls/ControlsProvider'
import { Tip, useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setMode, startFeature } from '@/lib/api'
import { buildBlocked, buildMessage } from '@/lib/plan'

type BuildThisProps = {
  /** The plan: the feature it is for (its studio-plan meta), its title, where it is published and its local copy's file. */
  plan: { name: string; title: string; url: string; page: string | null }
  /** Sends Claude the plan, once the feature has started and the chat is in Build. */
  onSend: (message: string) => void
}

/**
 * A plan's [Build this], in the artifact's toolbar. With no feature open it asks for the feature's name (the plan's, to change if
 * she likes), starts it, switches the chat to Build and sends Claude the plan. With one open, the plan is built in it: the chat
 * switches to Build and Claude is sent the plan. Waits while Claude works or waits on a question, and while an old version is
 * previewed.
 */
export const BuildThis = ({ plan, onSend }: BuildThisProps) => {
  const tip = useTip()
  const { state, refresh } = useControls()
  const w = state?.app ?? null
  const [name, setName] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState('')
  const blocked = buildBlocked(w)

  const build = async (feature: string | null) => {
    setBuilding(true)
    setError('')
    const failed = feature === null ? null : await startFeature(feature)
    const moved = failed ? null : await setMode('build')
    setBuilding(false)
    if (failed) return setError(failed)
    if (moved && 'error' in moved) return setError(moved.error)
    setName(null)
    await refresh()
    onSend(buildMessage(plan))
  }

  if (name !== null)
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim() && !blocked && !building) void build(name.trim())
        }}
      >
        <Input aria-label="Name of the feature" className="h-7 w-48 text-xs" maxLength={80} autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && setName(null)} />
        <Button type="submit" size="sm" disabled={!name.trim() || Boolean(blocked) || building} title={tip(blocked ?? 'Start this feature from the latest version, switch the chat to Build and send Claude the plan')}>
          {building ? <LoaderCircle className="animate-spin" /> : <Hammer />} Build
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setName(null)}>
          Cancel
        </Button>
        {error && <span className="max-w-64 truncate text-xs text-destructive" title={error}>{error}</span>}
      </form>
    )

  return (
    <>
      <Tip title={blocked ?? (w?.feature ? 'Build this plan as part of “' + w.feature.name + '”: the chat switches to Build and Claude is sent the plan' : 'Start a feature for this plan, switch the chat to Build and send Claude the plan')}>
        <Button size="sm" disabled={Boolean(blocked) || building} onClick={() => (w?.feature ? void build(null) : setName(plan.name))}>
          {building ? <LoaderCircle className="animate-spin" /> : <Hammer />} Build this
        </Button>
      </Tip>
      {error && <span className="max-w-64 truncate text-xs text-destructive" title={error}>{error}</span>}
    </>
  )
}
