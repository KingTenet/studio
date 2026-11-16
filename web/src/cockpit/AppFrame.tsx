import { ExternalLink, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { store } from '@/lib/store'

const VIEWPORTS = [
  ['1920x1080', '1920×1080'],
  ['1440x900', '1440×900'],
  ['1280x800', '1280×800'],
  ['1280x720', '1280×720'],
  ['1200x900', '1200 wide'],
  ['1024x768', '1024×768'],
  ['390x844', '390×844'],
] as const

const ZOOMS = ['fit', '50%', '75%', '100%']

type AppFrameProps = {
  label: string
  /** Where the app's dev server answers, e.g. http://localhost:4001. */
  appUrl: string
  /** Whether the app is running; the frame loads once it is. */
  running: boolean
  /** The App | Artifacts switch, shown at the start of the toolbar. */
  switcher?: ReactNode
}

// about:blank (the frame before it navigates) has pathname "blank", which as a src resolves to /_env/blank.
const isAppPath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !path.startsWith('/_env')

// The app runs on its own port, so the frame's location can't be read from here (another origin): the app posts it
// ({ type: 'studio-location', path }) when it can, and a frame on this origin is still read directly.
const framePath = (frame: HTMLIFrameElement | null) => {
  try {
    const { protocol, pathname, search, hash } = frame!.contentWindow!.location
    const path = pathname + search + hash
    return protocol.startsWith('http') && isAppPath(path) ? path : null
  } catch {
    return null
  }
}

/** The app in a frame at a chosen viewport, scaled to fit the column or to a fixed zoom. */
export const AppFrame = ({ label, appUrl, running, switcher }: AppFrameProps) => {
  const tip = useTip()
  const [viewport, setViewport] = useState(() => store.get('wt:' + label + ':viewport', '1440x900'))
  const [zoom, setZoom] = useState(() => {
    const saved = store.get('wt:' + label + ':zoom', 'fit')
    return ZOOMS.includes(saved) ? saved : 'fit'
  })
  const [path, setPath] = useState<string | null>(null)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const stage = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [src] = useState(() => {
    const saved = store.get<unknown>('wt:' + label + ':path', null)
    return isAppPath(saved) ? saved : null
  })

  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const show = (now: string | null) => {
      if (now && now !== path) {
        setPath(now)
        store.set('wt:' + label + ':path', now)
      }
    }
    const timer = setInterval(() => show(framePath(frame.current)), 1000)
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.origin === new URL(appUrl).origin && event.data?.type === 'studio-location' && isAppPath(event.data.path)) show(event.data.path)
    }
    window.addEventListener('message', onMessage)
    return () => {
      clearInterval(timer)
      window.removeEventListener('message', onMessage)
    }
  }, [label, path, appUrl])

  const [width, height] = viewport.split('x').map(Number)
  const scale = zoom === 'fit' ? Math.min((stageSize.width - 24) / width, (stageSize.height - 24) / height, 1) : parseFloat(zoom) / 100

  return (
    <div className="grid h-full grid-rows-[auto_1fr] bg-muted/50">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-1.5">
        {switcher}
        <Select
          value={viewport}
          onValueChange={(value) => {
            setViewport(value)
            store.set('wt:' + label + ':viewport', value)
          }}
        >
          <SelectTrigger size="sm" className="h-7 text-xs" aria-label="Viewport">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEWPORTS.map(([value, name]) => (
              <SelectItem key={value} value={value} className="text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={zoom}
          aria-label="Zoom"
          onValueChange={(value) => {
            if (!value) return
            setZoom(value)
            store.set('wt:' + label + ':zoom', value)
          }}
        >
          {ZOOMS.map((value) => (
            <ToggleGroupItem key={value} value={value} className="h-7 px-2 text-xs" title={tip(value === 'fit' && running ? 'Fit the viewport in the column (' + Math.round(scale * 100) + '% now)' : undefined)}>
              {value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="min-w-16 flex-1 basis-0 truncate font-mono text-xs text-muted-foreground" title={tip(path ?? undefined)}>
          {path}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="Reload the app" title={tip('Reload the app')} onClick={() => frame.current?.contentWindow?.location.reload()}>
          <RotateCw />
        </Button>
        <Button size="sm" variant="outline" title={tip('Open this page of the app in its own tab')} onClick={() => window.open(appUrl + (path ?? src ?? '/'), '_blank', 'noopener')}>
          open full <ExternalLink />
        </Button>
      </div>
      <div ref={stage} className="grid min-h-0 min-w-0 items-start justify-items-center-safe overflow-auto p-3">
        {running ? (
          <div className="relative overflow-hidden rounded-md shadow-lg ring-1 ring-border" style={{ width: width * scale, height: height * scale }}>
            <iframe ref={frame} title="App" src={appUrl + (src ?? '/')} className="absolute top-0 left-0 origin-top-left border-0 bg-white" style={{ width, height, transform: `scale(${scale})` }} />
          </div>
        ) : (
          <div className="grid gap-1 self-center text-center text-sm text-muted-foreground">
            <b className="text-foreground">The app isn't running</b>
            <span>It loads here as soon as it starts. If it doesn't, restart the studio.</span>
          </div>
        )}
      </div>
    </div>
  )
}
