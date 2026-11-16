import { ArrowLeft, Crosshair, Diff, ExternalLink, Layers, LoaderCircle, Pencil, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { SmartLink } from '@/components/controls/ArtifactLink'
import { useControls } from '@/components/controls/ControlsProvider'
import { Tip, useTip } from '@/components/controls/Tip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { artifactShot, getArtifact, getArtifacts, removeArtifact, unnoteArtifact } from '@/lib/api'
import { focusChat, localArtifactUrl, type ArtifactPick } from '@/lib/artifacts'
import { ago, plural } from '@/lib/format'
import { pendingFor } from '@/lib/pending'
import type { ArtifactInfo, ArtifactNote, ArtifactsView } from '@/lib/types'
import { cn } from 'cn'
import { BuildThis } from './BuildThis'
import { DrawPane, type DrawingHandle } from './DrawPane'

// What a sandboxed artifact may do: run its scripts and open links, but as an opaque origin, never as the cockpit.
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals'

const isPickShortcut = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b'
const PICK_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘B' : 'Ctrl+B'

// What the index posts (see the artifact-index skill) when one of its artifact links is clicked.
const PREVIEW_MESSAGE = 'studio-artifact-preview'

const Frame = ({ src, title, ref, onLoad }: { src: string; title: string; ref?: Ref<HTMLIFrameElement>; onLoad?: () => void }) => (
  <iframe ref={ref} title={title} src={src} sandbox={SANDBOX} onLoad={onLoad} className="h-full w-full border-0 bg-white" />
)

type View = 'index' | 'list'

type ArtifactCardProps = { artifact: ArtifactInfo; replacement: ArtifactInfo | undefined; onRemove: () => void; failed: boolean }

const ArtifactCard = ({ artifact, replacement, onRemove, failed }: ArtifactCardProps) => {
  const tip = useTip()
  return (
    <article className={cn('relative grid grid-rows-[auto_1fr_auto] gap-2 rounded-xl border bg-card p-3 shadow-xs hover:border-foreground/30 has-[a:focus-visible]:ring-2', artifact.supersededBy && 'opacity-60', failed && 'border-destructive')}>
      <header className="flex items-start gap-2">
        <h3 className="text-sm leading-snug font-medium">
          {/* Its ::after covers the whole card, so a click anywhere but the buttons opens the local copy. */}
          <SmartLink href={artifact.url} className="outline-none after:absolute after:inset-0 after:rounded-xl hover:underline">
            {artifact.name}
          </SmartLink>
        </h3>
        {artifact.supersededBy && (
          <Badge variant="outline" className="ml-auto shrink-0">
            superseded
          </Badge>
        )}
      </header>
      <p className="line-clamp-3 text-xs text-muted-foreground">{artifact.description ?? 'No description recorded.'}</p>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span title={tip(new Date(artifact.latest.ts).toLocaleString())}>{ago(artifact.latest.ts)}</span>
        <span>{plural(artifact.versions.length, 'version')}</span>
        {artifact.sessions.length > 1 && <span>{plural(artifact.sessions.length, 'session')}</span>}
        {replacement && <span>→ {replacement.name}</span>}
        <span className="relative z-10 ml-auto flex gap-1">
          <Button size="xs" variant="ghost" asChild>
            <a href={artifact.url} target="_blank" rel="noopener" title={tip('The published artifact on claude.ai')}>
              claude.ai
            </a>
          </Button>
          <Button size="xs" variant="outline" asChild>
            <a href={localArtifactUrl(artifact.id)} target="_blank" rel="noopener" title={tip("Its local copy in a tab (claude.ai when there's no local copy)")}>
              open <ExternalLink />
            </a>
          </Button>
          <Tip title="Remove from this list: the page stays on claude.ai, and publishing it again brings it back">
            <Button size="icon-xs" variant="ghost" aria-label={'Remove ' + artifact.name} onClick={onRemove} className="text-destructive hover:text-destructive">
              <Trash2 />
            </Button>
          </Tip>
        </span>
      </footer>
    </article>
  )
}

type ArtifactsPaneProps = {
  label: string
  /** The App | Artifacts switch, shown at the start of the toolbar. */
  switcher: ReactNode
  /** The artifact being previewed, by id; null shows the index or the cards. */
  previewId: string | null
  /** Previews an artifact (any id), or goes back with null. */
  onPreview: (id: string | null) => void
  /** A publish seen after the first load: a new artifact, or a new version of one. */
  onPublished: (artifact: ArtifactInfo) => void
  /** A plan's [Build this] has started its feature and switched to Build: the chat sends Claude this. */
  onBuildPlan: (message: string) => void
  /** Told what the pane shows whenever that changes, for the chat to pass on with each message. */
  onShowing: (text: string) => void
  /** An element clicked in the shown artifact with the pick tool. */
  onPick: (pick: ArtifactPick) => void
  /** Esc pressed in the shown artifact (its keys don't reach the cockpit's window). */
  onEscape: () => void
  /** The drawing on the previewed artifact, for the chat to send: the page as rendered with the ink on top (`shot` false: the ink alone). */
  drawingRef?: Ref<ArtifactDrawingHandle>
  /** Whether that drawing goes with the next message. */
  drawingAttached: boolean
  /** It changed; `inked` says whether anything is left on it. A new artifact or version starts a blank one. */
  onDrawingChange: (inked: boolean) => void
}

export type ArtifactDrawingHandle = { toPng: () => Promise<{ png: Blob; shot: boolean } | null> }

type Version = { version: number; ts: string; local: boolean }
type PreviewInfo = { id: string; name: string; url: string; local: boolean; filePath: string | null; history: Version[]; notes: ArtifactNote[]; plan: string | null; page: string | null }

/** What the shown version's page found changed since an earlier one (studio-diff-result). */
type DiffResult = { against: number; added: number; changed: number; removed: number; error?: boolean }

type VersionsOverlayProps = {
  history: Version[]
  shown: number
  latest: number
  onShow: (version: number) => void
  /** The version the shown one is compared with, or null when there's none before it. */
  previous: number | null
  diffing: boolean
  onDiff: (on: boolean) => void
  diff: DiffResult | null
}

/** Every version of the previewed artifact, floating over it: the one shown highlighted, the newest marked latest; and a switch that marks what changed since the version before. */
const VersionsOverlay = ({ history, shown, latest, onShow, previous, diffing, onDiff, diff }: VersionsOverlayProps) => {
  const tip = useTip()
  return (
    <div className="absolute right-3 bottom-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-full border bg-background/90 p-1 text-xs shadow-md backdrop-blur">
      {previous !== null && (
        <button
          type="button"
          aria-pressed={diffing}
          onClick={() => onDiff(!diffing)}
          aria-label={'Changes since v' + previous}
          title={tip(
            'Changes since v' + previous + ': green added, amber changed, red dashed removed' +
              (diffing && diff?.against === previous ? (diff.error ? '\nCouldn’t load v' + previous : `\n${diff.added} added, ${diff.changed} changed, ${diff.removed} removed`) : '')
          )}
          className={cn('shrink-0 rounded-full p-1', diffing ? 'bg-primary text-primary-foreground' : 'hover:bg-muted', diffing && diff?.against === previous && diff.error && 'bg-destructive text-white')}
        >
          <Diff className="size-3.5" />
        </button>
      )}
      {shown !== latest && (
        <button type="button" onClick={() => onShow(latest)} className="shrink-0 rounded-full px-2 py-0.5 font-medium text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-950">
          not the latest · go to v{latest}
        </button>
      )}
      <div className="flex min-w-0 gap-0.5 overflow-x-auto">
        {history.map((v) => (
          <button
            key={v.version}
            type="button"
            disabled={!v.local}
            aria-pressed={v.version === shown}
            onClick={() => onShow(v.version)}
            title={tip('Published ' + new Date(v.ts).toLocaleString() + ' (' + ago(v.ts) + ')' + (v.local ? '' : ': no local copy'))}
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 tabular-nums',
              v.version === shown ? 'bg-primary font-medium text-primary-foreground' : 'hover:bg-muted',
              !v.local && 'cursor-not-allowed opacity-40 hover:bg-transparent'
            )}
          >
            v{v.version}
            {v.version === latest && ' · latest'}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The app's artifact index (Claude-written, sandboxed), or every recorded artifact as cards; with the buttons that rebuild or consolidate it. */
export const ArtifactsPane = ({ label, switcher, previewId, onPreview, onPublished, onBuildPlan, onShowing, onPick, onEscape, drawingRef, drawingAttached, onDrawingChange }: ArtifactsPaneProps) => {
  const tip = useTip()
  const { perform, isBusy, state, confirm, act, pendingOf, failedOf } = useControls()
  // undefined until the first answer; null when the studio server couldn't list them (it may predate this page).
  const [data, setData] = useState<ArtifactsView | null | undefined>(undefined)
  const [view, setView] = useState<View>('index')
  const [preview, setPreview] = useState<PreviewInfo | null>(null)
  const w = state?.app ?? null
  const busy = isBusy(label, w)
  const artifactsTab = w?.tabs?.artifacts
  // Only a live Claude session in the Artifacts tab blocks a new run; a tab left at its shell (finished or reaped) is reused.
  const running = Boolean(artifactsTab && w?.agents?.some((agent) => agent.tabId === artifactsTab.tabId))
  const working = w?.tabs?.artifacts?.state === 'claude-working' || w?.tabs?.artifacts?.state === 'running'

  // A publish seen after the first load (a new artifact, or a new version of one) is passed on, for the cockpit to preview.
  const onPublishedRef = useRef(onPublished)
  onPublishedRef.current = onPublished
  useEffect(() => {
    let seen: Map<string, string> | null = null
    const load = async () => {
      const next = await getArtifacts()
      setData(next)
      if (!next) return
      const published = next.artifacts.filter((a) => seen?.get(a.id) !== a.latest.ts)
      if (seen && published.length) onPublishedRef.current(published.reduce((a, b) => (b.latest.ts > a.latest.ts ? b : a)))
      seen = new Map(next.artifacts.map((a) => [a.id, a.latest.ts]))
    }
    void load()
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 1000)
    return () => clearInterval(timer)
  }, [])

  const remove = async (artifact: ArtifactInfo) => {
    if (!(await confirm('Remove ' + artifact.name + '?\n\nIt disappears from the artifact list. The published page on claude.ai is not deleted, and publishing it again brings it back.'))) return
    await act(label, 'artifact:' + artifact.id, pendingFor('remove-artifact'), async () => {
      const removed = (await removeArtifact(artifact.id)).ok
      setData(await getArtifacts())
      return removed
    })
  }

  // The version picked in the overlay; null follows the latest, so a new publish shows up by itself.
  const [pinned, setPinned] = useState<number | null>(null)
  // Where the previewed page was last scrolled to (it posts studio-scroll), so another version opens at the same place.
  const previewScroll = useRef(0)
  useEffect(() => {
    setPinned(null)
    previewScroll.current = 0
    if (!previewId) return setPreview(null)
    let current = true
    setPreview({ id: previewId, name: previewId, url: 'https://claude.ai/artifact/' + previewId, local: true, filePath: null, history: [], notes: [], plan: null, page: null })
    // Asked again every second, for new versions.
    const load = () =>
      void getArtifact(previewId).then(
        (found) =>
          current &&
          setPreview(
            found
              ? { id: found.id, name: found.name, url: found.url, local: found.local, filePath: found.filePath ?? null, history: found.history ?? [], notes: found.notes ?? [], plan: found.plan ?? null, page: found.page ?? null }
              : { id: previewId, name: previewId, url: 'https://claude.ai/artifact/' + previewId, local: false, filePath: null, history: [], notes: [], plan: null, page: null }
          )
      )
    load()
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 1000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [previewId])
  const latestVersion = preview?.history.findLast((v) => v.local)?.version ?? null
  const shownVersion = pinned ?? latestVersion
  const previousVersion = preview?.history.findLast((v) => v.local && shownVersion !== null && v.version < shownVersion)?.version ?? null
  // Marking what changed stays on across versions until switched off; the page reports what it found.
  const [diffing, setDiffing] = useState(false)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  // × on a note: gone from the page at once, and from the store.
  const closeNote = useRef((_nid: string) => {})
  closeNote.current = (nid) => {
    if (!preview) return
    setPreview({ ...preview, notes: preview.notes.filter((note) => note.nid !== nid) })
    void unnoteArtifact(preview.id, nid)
  }
  // The sandboxed frame can't fetch the older version itself (it has no origin), so the cockpit sends it the page.
  // Claude's notes on the shown version, sent to its page whenever they change (and on each load, below).
  const notesJson = JSON.stringify((preview?.notes ?? []).filter((note) => note.version === shownVersion))
  const sendNotes = () => previewFrame.current?.contentWindow?.postMessage({ type: 'studio-notes', notes: JSON.parse(notesJson) }, '*')
  useEffect(sendNotes, [notesJson])
  const askDiff = async (on: boolean) => {
    const frame = previewFrame.current?.contentWindow
    if (!frame || !preview) return
    if (!on || previousVersion === null) return frame.postMessage({ type: 'studio-diff' }, '*')
    const against = previousVersion
    try {
      const res = await fetch('/_env/artifact/' + preview.id + '/v' + against + '/')
      if (!res.ok) throw new Error(res.statusText)
      frame.postMessage({ type: 'studio-diff', against, html: await res.text() }, '*')
    } catch {
      setDiff({ against, added: 0, changed: 0, removed: 0, error: true })
    }
  }

  const indexFrame = useRef<HTMLIFrameElement>(null)
  const previewFrame = useRef<HTMLIFrameElement>(null)
  const index = data?.index ?? null
  const shown: View = index ? view : 'list'
  // The frame the pick tool works in: the previewed artifact's local copy, else the index.
  const pickFrame = preview ? (preview.local ? previewFrame : null) : shown === 'index' && index ? indexFrame : null
  const pickedFrom = preview ? 'artifact “' + preview.name + '”' : 'the artifact index'
  const [picking, setPicking] = useState(false)
  const setPick = (on: boolean) => {
    setPicking(on)
    pickFrame?.current?.contentWindow?.postMessage({ type: 'studio-pick', on }, '*')
  }
  // ⌘B / Ctrl+B toggles it: pressed in the cockpit (while this pane is on screen), or in the artifact, which posts studio-pick-toggle.
  const togglePick = useRef(() => {})
  togglePick.current = () => pickFrame?.current?.offsetParent && setPick(!picking)
  // Esc in the cockpit ends picking too.
  const stopPick = useRef(() => {})
  stopPick.current = () => picking && setPick(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopPick.current()
      if (!isPickShortcut(event)) return
      event.preventDefault()
      togglePick.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Showing something else (or the frame reloading) ends picking.
  useEffect(() => setPicking(false), [preview?.id, shownVersion, shown])

  // Drawing over the previewed page: a transparent sheet over the frame, which holds it still while it's up. Closed, the ink is kept
  // (and still goes with the next message); it belongs to the page it was drawn on, so another artifact or version starts a blank one.
  const [drawing, setDrawing] = useState(false)
  const sketch = useRef<DrawingHandle>(null)
  const sheet = preview?.id + ':' + shownVersion
  useEffect(() => {
    setDrawing(false)
    onDrawingChange(false)
  }, [sheet])
  useImperativeHandle(drawingRef, () => ({
    toPng: async () => {
      if (!sketch.current) return null
      const { width, height } = sketch.current.size()
      const shot =
        preview && shownVersion !== null && width && height
          ? await artifactShot({ id: preview.id, v: shownVersion, y: previewScroll.current, w: width, h: height, scale: Math.min(4, Math.max(1, devicePixelRatio || 1)), dark: document.documentElement.classList.contains('dark') })
          : null
      const background = shot ? await createImageBitmap(shot).catch(() => undefined) : undefined
      const png = await sketch.current.toPng(background)
      return png && { png, shot: Boolean(background) }
    },
  }))

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (event.source === indexFrame.current?.contentWindow && data?.type === PREVIEW_MESSAGE && typeof data.id === 'string') onPreview(data.id)
      const fromFrame = event.source && (event.source === indexFrame.current?.contentWindow || event.source === previewFrame.current?.contentWindow)
      if (fromFrame && data?.type === 'studio-clicked') focusChat()
      if (fromFrame && data?.type === 'studio-escape') onEscape()
      // Space and Esc pressed in the frame never reach the cockpit; replayed here, dictation (MicButton) records, sends or drops as usual.
      if (fromFrame && data?.type === 'studio-space') window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: data.repeat === true }))
      if (fromFrame && data?.type === 'studio-escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      if (event.source === previewFrame.current?.contentWindow && data?.type === 'studio-scroll' && typeof data.y === 'number') previewScroll.current = data.y
      if (event.source === previewFrame.current?.contentWindow && data?.type === 'studio-diff-result' && typeof data.against === 'number') setDiff(data as DiffResult)
      if (event.source === previewFrame.current?.contentWindow && data?.type === 'studio-note-close' && typeof data.nid === 'string') closeNote.current(data.nid)
      if (!pickFrame || event.source !== pickFrame.current?.contentWindow) return
      if (data?.type === 'studio-pick-off') setPicking(false)
      if (data?.type === 'studio-pick-toggle') togglePick.current()
      if (data?.type === 'studio-picked' && typeof data.selector === 'string') {
        setPicking(false)
        const text = (value: unknown, n: number) => (typeof value === 'string' ? value.slice(0, n) : null)
        onPick({ from: pickedFrom, selector: data.selector.slice(0, 300), text: text(data.text, 200) ?? '', heading: text(data.heading, 120), tag: text(data.tag, 30) ?? 'element' })
        focusChat()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onPreview, onPick, onEscape, pickFrame, pickedFrom])

  useEffect(() => {
    onShowing(
      preview
        ? 'Artifact “' + preview.name + '”' + (shownVersion ? ', version ' + shownVersion + (shownVersion === latestVersion ? ' (the latest)' : ' of ' + preview.history.length) : '') + ' (published ' + preview.url + (preview.local ? ', local copy ' + localArtifactUrl(preview.id, shownVersion ?? undefined) : ', no local copy') + (preview.filePath ? ', written from ' + preview.filePath : '') + ').'
        : shown === 'index' && index
          ? "The app's artifact index (" + location.origin + '/_env/artifacts/index.html' + (index.url ? ', published ' + index.url : '') + ').'
          : "The cards of the app's " + plural(data?.artifacts.length ?? 0, 'artifact') + ' (GET ' + location.origin + '/_env/api/artifacts lists them as JSON).'
    )
  }, [preview, shownVersion, latestVersion, shown, index, data?.artifacts.length])
  const byId = new Map((data?.artifacts ?? []).map((artifact) => [artifact.id, artifact]))
  // Ones being removed are gone from the cards at once.
  const listed = (data?.artifacts ?? []).filter((artifact) => !pendingOf(label, 'artifact:' + artifact.id))
  const live = listed.filter((artifact) => !artifact.supersededBy)
  const superseded = listed.filter((artifact) => artifact.supersededBy)

  let body: ReactNode
  if (preview) {
    body = preview.local ? (
      <div className="relative min-h-0">
        <Frame ref={previewFrame} title={preview.name} src={localArtifactUrl(preview.id, shownVersion ?? undefined)}
          onLoad={() => {
            if (previewScroll.current) previewFrame.current?.contentWindow?.postMessage({ type: 'studio-scroll-to', y: previewScroll.current }, '*')
            if (diffing) void askDiff(true)
            sendNotes()
          }}
        />
        {shownVersion && latestVersion && preview.history.length > 1 && (
          <VersionsOverlay
            history={preview.history}
            shown={shownVersion}
            latest={latestVersion}
            onShow={(version) => setPinned(version === latestVersion ? null : version)}
            previous={previousVersion}
            diffing={diffing}
            onDiff={(on) => {
              setDiffing(on)
              void askDiff(on)
            }}
            diff={diff}
          />
        )}
        <div key={sheet} className={drawing ? 'contents' : 'hidden'}>
          <DrawPane
            overlay
            ref={sketch}
            active={drawing}
            attached={drawingAttached}
            onChange={onDrawingChange}
            switcher={
              <Button size="icon-sm" variant="ghost" aria-label="Stop drawing" title={tip('Stop drawing: the page scrolls and clicks again, and what you drew is kept')} onClick={() => setDrawing(false)}>
                <X />
              </Button>
            }
          />
        </div>
      </div>
    ) : (
      <div className="grid place-items-center p-6 text-center text-sm text-muted-foreground">
        <span>
          No local copy of this artifact.{' '}
          <a href={preview.url} target="_blank" rel="noopener" className="text-sky-700 hover:underline dark:text-sky-400">
            Open it on claude.ai
          </a>
        </span>
      </div>
    )
  } else if (shown === 'index' && index) {
    body = <Frame ref={indexFrame} title="Artifact index" src={'/_env/artifacts/index.html?built=' + encodeURIComponent(index.builtAt)} />
  } else if (!listed.length) {
    body = (
      <div className="grid place-items-center p-6 text-center text-sm text-muted-foreground">
        <div className="grid max-w-sm gap-1">
          <b className="text-foreground">No artifacts yet</b>
          <span>Every artifact Claude publishes for the app is recorded here, and Rebuild index has Claude write an overview of them.</span>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="min-h-0 overflow-x-hidden overflow-y-auto p-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {live.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} replacement={undefined} onRemove={() => void remove(artifact)} failed={failedOf(label, 'artifact:' + artifact.id)} />
          ))}
        </div>
        {superseded.length > 0 && (
          <>
            <h2 className="mt-6 mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">Superseded</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {superseded.map((artifact) => (
                <ArtifactCard key={artifact.id} artifact={artifact} replacement={byId.get(artifact.supersededBy!)} onRemove={() => void remove(artifact)} failed={failedOf(label, 'artifact:' + artifact.id)} />
              ))}
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="grid h-full grid-rows-[auto_1fr] bg-muted/50">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-1.5">
        {switcher}
        {pickFrame && (
          <Tip title={picking ? 'Picking: click something in the page to point Claude at it, or Esc (or ' + PICK_KEYS + ') to stop' : 'Pick something in the page (' + PICK_KEYS + '): it goes with your next chat message, so “this” means it'}>
            <Button size="icon-sm" variant={picking ? 'default' : 'outline'} aria-label="Pick an element" aria-pressed={picking} onClick={() => setPick(!picking)}>
              <Crosshair />
            </Button>
          </Tip>
        )}
        {preview?.local && (
          <Tip title={drawing ? 'Stop drawing (what you drew is kept)' : 'Draw on the page: it goes with your next chat message, drawn over the page as it shows here'}>
            <Button
              size="icon-sm"
              variant={drawing ? 'default' : 'outline'}
              aria-label="Draw on the page"
              aria-pressed={drawing}
              onClick={() => {
                if (picking) setPick(false)
                setDrawing(!drawing)
              }}
            >
              <Pencil />
            </Button>
          </Tip>
        )}
        {preview ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => onPreview(null)}>
              <ArrowLeft /> back
            </Button>
            <span className="min-w-16 flex-1 basis-0 truncate text-xs font-medium">{preview.name}</span>
            {preview.plan && <BuildThis key={preview.id} plan={{ name: preview.plan, title: preview.name, url: preview.url, page: preview.page }} onSend={onBuildPlan} />}
            <Button size="sm" variant="ghost" asChild>
              <a href={preview.url} target="_blank" rel="noopener" title={tip('The published artifact on claude.ai')}>
                claude.ai
              </a>
            </Button>
            {preview.local && (
              <Button size="sm" variant="outline" asChild>
                <a href={localArtifactUrl(preview.id)} target="_blank" rel="noopener" title={tip('This local copy in its own tab')}>
                  open in tab <ExternalLink />
                </a>
              </Button>
            )}
          </>
        ) : (
          <>
            {index && (
              <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={shown} onValueChange={(value) => value && setView(value as View)} aria-label="Artifacts view">
                <ToggleGroupItem value="index" className="h-7 px-2 text-xs">
                  index
                </ToggleGroupItem>
                <ToggleGroupItem value="list" className="h-7 px-2 text-xs">
                  all {data?.artifacts.length ?? 0}
                </ToggleGroupItem>
              </ToggleGroup>
            )}
            <span className={cn('min-w-16 flex-1 basis-0 truncate text-xs', index?.newSince ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
              {data === undefined
                ? 'Loading…'
                : data === null
                  ? "Can't list artifacts: the studio server isn't answering. Restart the studio (studio up)."
                  : index
                  ? 'Index written ' + ago(index.builtAt) + (index.newSince ? ' · ' + index.newSince + ' new publish' + (index.newSince === 1 ? '' : 'es') + ' since' : ' · up to date')
                  : plural(data.artifacts.length, 'artifact') + ' · no index yet'}
            </span>
            {index?.url && (
              <Button size="sm" variant="ghost" asChild>
                <a href={index.url} target="_blank" rel="noopener" title={tip('The published index on claude.ai')}>
                  <ExternalLink />
                </a>
              </Button>
            )}
            <Tip title={running ? 'Claude is already running in the Artifacts tab (its chip is in the sessions above); stop it there to start a fresh run' : 'Have Claude rewrite the index from every artifact made here, then publish it'}>
              <Button size="sm" variant={index?.newSince || !index ? 'default' : 'outline'} disabled={busy || running || !data?.artifacts.length} onClick={() => perform(label, { type: 'run', action: 'artifact-index' }, 'artifact-index')}>
                <RefreshCw className={cn(pendingOf(label, 'artifact-index') && 'animate-spin')} /> {index ? 'Rebuild index' : 'Build index'}
              </Button>
            </Tip>
            <Tip title={running ? 'Claude is already running in the Artifacts tab (its chip is in the sessions above); stop it there to start a fresh run' : (data?.artifacts.length ?? 0) < 2 ? 'Consolidating needs at least two artifacts' : 'Have Claude propose merging overlapping or out-of-date artifacts into fewer, current ones; it asks before changing anything and marks the originals superseded'}>
              <Button size="sm" variant="outline" disabled={busy || running || (data?.artifacts.length ?? 0) < 2} onClick={() => perform(label, { type: 'run', action: 'artifact-consolidate' }, 'artifact-consolidate')}>
                {pendingOf(label, 'artifact-consolidate') ? <LoaderCircle className="animate-spin" /> : <Layers />} Consolidate
              </Button>
            </Tip>
          </>
        )}
      </div>
      {working && !preview ? (
        <div className="relative min-h-0">
          <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-sky-600/90 px-3 py-1.5 text-xs text-white">
            <Sparkles className="size-3.5" /> Claude is working on the index in the Artifacts tab; its chip is in the sessions above.
          </div>
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  )
}
