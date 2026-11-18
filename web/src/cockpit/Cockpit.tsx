import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ArtifactPreviewContext } from '@/components/controls/ArtifactLink'
import { ControlsProvider, useControls } from '@/components/controls/ControlsProvider'
import { OutputButton } from '@/components/controls/JobsOverlay'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { describePick, PICK_NOTE_HINT, pickLabel, type ArtifactPick } from '@/lib/artifacts'
import { uploadDrawing } from '@/lib/api'
import { blockedTitle } from '@/lib/controls'
import { afterBuild, chatAgentOf, onPublish, watchTurn, type TurnWatch } from '@/lib/plan'
import { store } from '@/lib/store'
import type { ArtifactInfo } from '@/lib/types'
import { AppBroken } from './AppBroken'
import { AppFrame } from './AppFrame'
import { ArtifactsPane, type ArtifactDrawingHandle } from './ArtifactsPane'
import { Chat } from './Chat'
import { DrawPane, type DrawingHandle } from './DrawPane'
import { PaneLayout, type SidePane } from './PaneLayout'
import { Rail } from './Rail'
import { useChatSelection, useFollowSessions } from './useChatSelection'
import { PreviewBanner } from './VersionsPanel'

// The label the cockpit's controls, pending states and saved settings go by: there is only the one app.
const LABEL = 'app'
const SOURCES = ['app', 'artifacts', 'draw'] as const
type Source = (typeof SOURCES)[number]

/** A drawing goes with the next message once it has changed since the last one, unless its chip was removed. */
const useInk = () => {
  const [ink, setInk] = useState({ version: 0, inked: false, sent: 0 })
  const onChange = useCallback((inked: boolean) => setInk((current) => ({ ...current, version: current.version + 1, inked })), [])
  const drop = () => setInk((current) => ({ ...current, sent: current.version }))
  return { attached: ink.inked && ink.version !== ink.sent, onChange, drop }
}

type LayoutProps = {
  selected: string | null
  setSelected: (paneId: string | null) => void
  /** Set when a job this page started has finished, so the session it started or resumed is selected. */
  adopt: RefObject<boolean>
  /** Changes when a session is opened here, to put the cursor in its message box. */
  focusMessage: number
}

const Layout = ({ selected, setSelected, adopt, focusMessage }: LayoutProps) => {
  const { state } = useControls()
  const w = state?.app ?? null
  const [source, setSource] = useState<Source>(() => {
    const saved = store.get<string>('wt:' + LABEL + ':pane', 'app')
    return SOURCES.find((value) => value === saved) ?? 'app'
  })
  const [previewId, setPreviewId] = useState<string | null>(null)
  const showSource = (value: Source) => {
    setSource(value)
    store.set('wt:' + LABEL + ':pane', value)
  }
  const previewArtifact = (id: string) => {
    setPreviewId(id)
    showSource('artifacts')
  }

  useFollowSessions(LABEL, w, selected, setSelected, adopt)

  // What the artifacts pane shows, and what was picked in it, for the chat to send with each message.
  const showing = useRef('')
  const onShowing = useCallback((text: string) => {
    showing.current = text
  }, [])
  const [picks, setPicks] = useState<ArtifactPick[]>([])
  const onPick = useCallback((pick: ArtifactPick) => setPicks((current) => [...current.filter((p) => p.selector !== pick.selector || p.from !== pick.from), pick].slice(-5)), [])
  // Esc anywhere in the cockpit, or in the shown artifact (ArtifactsPane passes it on), drops what was picked.
  const clearPicks = useCallback(() => setPicks([]), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && clearPicks()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearPicks])
  // The Draw tab's drawing, and the one on the previewed artifact.
  const drawing = useRef<DrawingHandle>(null)
  const ink = useInk()
  const artifactDrawing = useRef<ArtifactDrawingHandle>(null)
  const artifactInk = useInk()
  const save = async (png: Blob, about: string) => {
    const saved = await uploadDrawing(png)
    return 'error' in saved ? 'The user drew something for this message, but it could not be saved: ' + saved.error + '.' : about + ': ' + saved.path + ' (Read it to see it).'
  }
  const drawingContext = async () => {
    const png = ink.attached ? await drawing.current?.toPng() : null
    const over = artifactInk.attached ? await artifactDrawing.current?.toPng() : null
    return [
      ...(png ? [await save(png, 'The user drew this for the message')] : []),
      ...(over ? [await save(over.png, over.shot ? 'The user drew on the artifact in the middle pane; this is the page as it shows there, with the drawing on top' : 'The user drew on the artifact in the middle pane (the page itself could not be captured, so this is the ink alone, as laid over the pane)')] : []),
    ]
  }
  const pageContext = async () =>
    [
      'The studio cockpit for the app ' + (w?.name ?? '') + ' (' + location.origin + '), its middle pane showing ' + (source === 'app' ? 'the app (' + (w?.url ?? 'its dev server') + ').' : source === 'draw' ? 'its drawing board.' : showing.current),
      ...(await drawingContext()),
      ...picks.map(describePick),
      ...(picks.length && source === 'artifacts' ? [PICK_NOTE_HINT] : []),
    ].join(' ')

  useEffect(() => {
    document.title = blockedTitle((w?.name ?? 'Studio') + ' · Studio', [w])
  })

  // The middle pane switches by itself on two events only: to Artifacts when the chat's Claude publishes (a plan or an explainer),
  // and back to the app when a Build turn ends. An unsent drawing keeps the pane where it is (lib/plan.ts).
  const middle = () => ({ source, drawInk: ink.attached, artifactInk: artifactInk.attached })
  const onPublished = (artifact: ArtifactInfo) => {
    const fromChat = !w?.agents?.some((agent) => agent.tab === 'Artifacts' && agent.sessionId === artifact.latest.sessionId)
    const { preview, show } = onPublish(middle(), fromChat)
    if (preview) setPreviewId(artifact.id)
    if (show) showSource(show)
  }
  const chat = chatAgentOf(w)
  // Checked on every render: watchTurn only reports the end of a Build turn once.
  const turn = useRef<TurnWatch>(null)
  useEffect(() => {
    if (!w) return
    const next = watchTurn(turn.current, chat, w.mode)
    turn.current = next.watch
    const to = next.buildEnded ? afterBuild(middle()) : null
    if (to) showSource(to)
  })

  // What a plan's [Build this] has the chat send Claude: to the chat's Claude, shown in the chat first if another session was.
  const [outbox, setOutbox] = useState<{ id: number; text: string } | null>(null)
  // The plan published in this conversation, for the chat's [Build this] (it shows only while the chat is in Plan, in that session).
  const [plan, setPlan] = useState<{ name: string; title: string; url: string; page: string | null; sessionId: string | null; at: string } | null>(null)
  const sendForHer = (text: string) => {
    if (chat) setSelected(chat.paneId)
    setOutbox((current) => ({ id: (current?.id ?? 0) + 1, text }))
  }

  // The Output button sits by the switch: in the page's corner it would cover the chat's Send.
  const switcher = (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={source}
        aria-label="Middle pane"
        onValueChange={(value) => value && showSource(value as Source)}
      >
        <ToggleGroupItem value="app" className="h-7 px-2.5 text-xs font-medium">
          App
        </ToggleGroupItem>
        <ToggleGroupItem value="artifacts" className="h-7 px-2.5 text-xs font-medium">
          Artifacts
        </ToggleGroupItem>
        <ToggleGroupItem value="draw" className="h-7 px-2.5 text-xs font-medium">
          Draw
        </ToggleGroupItem>
      </ToggleGroup>
      <OutputButton />
    </>
  )

  const chatElement = (pane: SidePane) => (
    <Chat
      label={LABEL}
      w={w}
      selected={selected}
      onSelect={setSelected}
      focusMessage={focusMessage}
      collapsed={pane.collapsed}
      pinned={pane.pinned}
      onTogglePin={pane.togglePin}
      pinShortcut={pane.shortcut}
      onExpand={pane.expand}
      onClose={pane.close}
      overlay={pane.overlay}
      onToggleOverlay={pane.toggleOverlay}
      pageContext={pageContext}
      stickyFocus
      outbox={outbox}
      plan={plan}
      onBuildPlan={sendForHer}
      attachments={[
        ...(ink.attached ? [{ key: 'drawing', label: 'drawing', title: 'Your drawing from the Draw tab, as it is when you send' }] : []),
        ...(artifactInk.attached ? [{ key: 'artifact-drawing', label: 'drawing on artifact', title: 'What you drew on the artifact, over the page as it shows when you send' }] : []),
        ...picks.map((pick, i) => ({ key: String(i), label: pickLabel(pick), title: describePick(pick) })),
      ]}
      onRemoveAttachment={(key) => (key === 'drawing' ? ink.drop() : key === 'artifact-drawing' ? artifactInk.drop() : setPicks((current) => current.filter((_, i) => String(i) !== key)))}
      onSent={() => {
        setPicks([])
        ink.drop()
        artifactInk.drop()
      }}
    />
  )

  const railElement = (pane: SidePane) => (
    <Rail w={w} pane={pane} />
  )

  return (
    <ArtifactPreviewContext.Provider value={previewArtifact}>
      <PaneLayout
        id="studio-cockpit"
        rail={railElement}
        chat={chatElement}
        middle={
          <div className="relative h-full">
            {/* All stay mounted so switching to the artifacts and back doesn't reload the app, or lose the drawing. */}
            <div className={source === 'app' ? 'h-full' : 'hidden'}>
              <AppFrame
                label={LABEL}
                appUrl={w?.url ?? 'http://localhost:4001'}
                running={Boolean(w?.running)}
                crashed={Boolean(w?.crashed)}
                renderError={(error, dismiss) => w && <AppBroken error={error} w={w} onSend={sendForHer} onDismiss={dismiss} />}
                switcher={switcher}
                banner={w && <PreviewBanner w={w} />}
              />
            </div>
            <div className={source === 'artifacts' ? 'h-full' : 'hidden'}>
              <ArtifactsPane label={LABEL} switcher={switcher} previewId={previewId} onPreview={(id) => (id ? previewArtifact(id) : setPreviewId(null))} onPublished={onPublished} onPlan={(artifact) => setPlan(artifact?.plan ? { name: artifact.plan, title: artifact.name, url: artifact.url, page: artifact.page ?? null, sessionId: artifact.latest.sessionId ?? null, at: artifact.latest.ts } : null)} onBuildPlan={sendForHer} onShowing={onShowing} onPick={onPick} onEscape={clearPicks} drawingRef={artifactDrawing} drawingAttached={artifactInk.attached} onDrawingChange={artifactInk.onChange} />
            </div>
            <div className={source === 'draw' ? 'h-full' : 'hidden'}>
              <DrawPane ref={drawing} active={source === 'draw'} switcher={switcher} attached={ink.attached} onChange={ink.onChange} />
            </div>
          </div>
        }
      />
    </ArtifactPreviewContext.Provider>
  )
}

export const Cockpit = () => {
  const { selected, setSelected, focusMessage, adopt, provider } = useChatSelection(LABEL)
  return (
    <ControlsProvider outputInCorner={false} {...provider}>
      <Layout selected={selected} setSelected={setSelected} adopt={adopt} focusMessage={focusMessage} />
    </ControlsProvider>
  )
}
