import { ChevronsRight, GitCommitVertical, History, Layers } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { plural } from '@/lib/format'
import type { App } from '@/lib/types'
import { cn } from 'cn'
import { FeaturePanel } from './FeaturePanel'
import type { SidePane } from './PaneLayout'
import { CloseButton, PinButton } from './useAutoHide'
import { VersionsPanel } from './VersionsPanel'

export const DOT = { ok: 'bg-emerald-600', failed: 'bg-red-600', active: 'bg-amber-500', idle: 'bg-muted-foreground/40' }

export const Dot = ({ className, title }: { className: string; title: string }) => (
  <span role="img" aria-label={title} title={title} className={cn('size-2.5 rounded-full', className)} />
)

/** A titled section of the rail. */
const Section = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <section className="grid gap-2 rounded-xl border bg-card p-3">
    <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {icon}
      {title}
    </h3>
    {children}
  </section>
)

type RailProps = {
  w: App | null
  /** Collapsed (the narrow column of status dots), pinned, docked or floating. */
  pane: SidePane
}

/** The left pane: the feature being built and the app's versions. */
export const Rail = ({ w, pane }: RailProps) => {
  const tip = useTip()
  const { collapsed, pinned, togglePin, expand, close, overlay, toggleOverlay, shortcut } = pane
  const hoverHint = overlay ? '' : ' (hovering opens it too)'
  if (collapsed) {
    const agents = w?.agents ?? []
    const blocked = agents.some((agent) => agent.status === 'blocked')
    return (
      <div className="flex flex-col items-center gap-3 py-3">
        <Button size="icon-xs" variant="ghost" aria-label="Show the feature and versions" title={tip('Show the feature and versions' + hoverHint)} onClick={expand}>
          <ChevronsRight />
        </Button>
        <Dot className={w?.running ? DOT.ok : DOT.idle} title={w?.running ? 'App running' : 'App stopped'} />
        <Dot className={blocked ? DOT.failed : agents.length ? 'bg-sky-600' : DOT.idle} title={blocked ? 'Claude needs you' : plural(agents.length, 'Claude session')} />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col gap-3 overflow-x-hidden overflow-y-auto bg-muted/30 p-3">
      <header className="flex items-center gap-1.5">
        {overlay ? <CloseButton onClose={close} name="feature and versions" shortcut={shortcut} /> : <PinButton pinned={pinned} onToggle={togglePin} name="feature and versions" shortcut={shortcut} />}
        <h2 className="min-w-0 truncate text-sm font-medium">{w?.name ?? 'Your app'}</h2>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-pressed={overlay}
          aria-label={overlay ? 'Dock this pane beside the page' : 'Float this pane over the page'}
          title={tip(overlay ? 'Dock: give this pane its own column beside the page' : 'Overlay: float this pane over the page, which keeps its full width')}
          onClick={toggleOverlay}
          className={cn('ml-auto shrink-0', overlay ? 'text-foreground' : 'text-muted-foreground')}
        >
          <Layers className={cn(overlay && 'fill-current')} />
        </Button>
      </header>
      <Section icon={<GitCommitVertical className="size-3.5" />} title="Feature">
        <FeaturePanel w={w} />
      </Section>
      <Section icon={<History className="size-3.5" />} title="Versions">
        <VersionsPanel w={w} />
      </Section>
    </div>
  )
}
