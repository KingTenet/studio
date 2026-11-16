import { LoaderCircle, Pause, Play, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { LOOK_CLASS, type ChipModel, type ControlModel, type StartModel } from '@/lib/controls'
import { cn } from 'cn'
import { useControls } from './ControlsProvider'
import { Tip } from './Tip'

const segment = 'inline-flex h-full items-center gap-1 px-2 outline-none transition-colors hover:bg-current/10 focus-visible:bg-current/15 disabled:cursor-default disabled:hover:bg-transparent'

type SegmentProps = { title?: string; onClick: () => void; disabled?: boolean; className?: string; label?: string; children: ReactNode }

const Segment = ({ title, onClick, disabled, className, label, children }: SegmentProps) => (
  <Tip title={title}>
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={cn(segment, className)}>
      {children}
    </button>
  </Tip>
)

type ChipProps = {
  /** The worktree the chip's actions run in. */
  label: string
  model: ChipModel
  /** Outlines the chip, for the session the cockpit's chat column shows. */
  selected?: boolean
}

/** A herdr tab, Claude session or dev server: click goes to it, ↻ restarts the app, × stops it; it spins while one of those runs, and goes once it removes it. */
export const Chip = ({ label, model, selected }: ChipProps) => {
  const { perform, pendingOf, failedOf } = useControls()
  const pending = pendingOf(label, model.key)
  if (pending?.treatment === 'hide') return null
  const failed = failedOf(label, model.key)
  return (
    <span
      data-pane={model.pane}
      className={cn(
        'inline-flex h-6 items-stretch overflow-hidden rounded-full border text-xs font-medium [&>*+*]:border-l [&>*+*]:border-current/30',
        LOOK_CLASS[model.look.name],
        selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
        pending && 'opacity-70',
        failed && 'ring-2 ring-destructive ring-offset-1 ring-offset-background'
      )}
    >
      <Segment title={pending?.text ?? model.title} disabled={model.disabled || Boolean(pending)} onClick={() => model.onClick && perform(label, model.onClick, model.key)}>
        {pending ? <LoaderCircle aria-label={pending.text} className="size-3 animate-spin" /> : <span aria-hidden>{model.look.dot}</span>}
        {model.short ?? model.name}
        {model.paused && <Pause aria-label="paused" className="size-2.5 fill-current opacity-60" />}
      </Segment>
      {model.onClose && (
        <Segment title={model.closeTitle} label={model.closeTitle} disabled={model.closeDisabled || Boolean(pending)} onClick={() => perform(label, model.onClose!, model.key)} className="px-1.5 opacity-80">
          <X className="size-3" />
        </Segment>
      )}
    </span>
  )
}

/** Something not running yet: ▶ starts it, spinning until it has. */
export const StartChip = ({ label, model }: { label: string; model: StartModel }) => {
  const { perform, pendingOf, failedOf } = useControls()
  const pending = pendingOf(label, model.key)
  return (
    <Tip title={pending?.text ?? model.title}>
      <button
        type="button"
        disabled={model.disabled || Boolean(pending)}
        onClick={() => perform(label, model.onClick, model.key)}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2 text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-50',
          pending && 'text-foreground disabled:opacity-80',
          failedOf(label, model.key) && 'border-destructive text-destructive'
        )}
      >
        {pending ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3 fill-current" />}
        {model.name}
      </button>
    </Tip>
  )
}

type ControlListProps = {
  label: string
  models: ControlModel[]
  /** The pane whose chip is outlined. */
  selectedPane?: string | null
  className?: string
}

export const ControlList = ({ label, models, selectedPane, className }: ControlListProps) => (
  <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
    {models.map((model) => (model.kind === 'chip' ? <Chip key={model.key} label={label} model={model} selected={Boolean(selectedPane && model.pane === selectedPane)} /> : <StartChip key={model.key} label={label} model={model} />))}
  </div>
)
