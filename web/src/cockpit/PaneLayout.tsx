import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useDefaultLayout, usePanelCallbackRef } from 'react-resizable-panels'
import { useSharedPref } from '@/components/controls/useSharedPref'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { layoutStorage, store } from '@/lib/store'
import { cn } from 'cn'
import { useAutoHide, type AutoHidePanel } from './useAutoHide'

const COLLAPSED_PX = 44

type Side = 'rail' | 'chat'

// Until its docked column has been given a width, the floating chat opens at 70% of the window (sessions list and chat), the floating rail at the width of its cards.
const OPEN_WIDTH: Record<Side, () => number> = {
  rail: () => 320,
  chat: () => Math.max(280, Math.round(innerWidth * 0.7)),
}

// ⌘⇧→ / Ctrl+Shift+→ pins the chat open, or unpins and collapses it; ⌘⇧← / Ctrl+Shift+← is the page's own (the cockpit's Index overlay). A frame keeps its keys, except an artifact the cockpit serves, which posts them as studio-pane-key.
// In a box with text in it the arrows keep their usual job (selecting to the start or end of the line), so the chat's empty message box is the only one they work in.
const shortcutSide = (event: KeyboardEvent): Side | null => {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return null
  const field = document.activeElement
  if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.value !== '') return null
  if (field?.matches('[contenteditable="true"]')) return null
  return event.key === 'ArrowLeft' ? 'rail' : event.key === 'ArrowRight' ? 'chat' : null
}
const MOD = /Mac/.test(navigator.platform) ? '⌘⇧' : 'Ctrl+Shift+'
// The rail has no shortcut of its own: ⌘⇧← is the page's (onLeftKey).
const SHORTCUT: Record<Side, string> = { rail: '', chat: MOD + '→' }
export const LEFT_SHORTCUT = MOD + '←'

/** A pane floating over the page, driven like a collapsible panel so useAutoHide can open and close it. It has no handle to drag: it takes the docked column's width (useAutoHide shares the same one), or `openWidth()` until that has one. */
const useOverlayPanel = (openWidth: () => number) => {
  // null while collapsed to its strip.
  const [width, setWidth] = useState<number | null>(null)
  const current = useRef(width)
  const panel = useMemo<AutoHidePanel>(() => {
    const set = (next: number | null) => {
      current.current = next
      setWidth(next)
    }
    return {
      isCollapsed: () => current.current === null,
      collapse: () => set(null),
      expand: () => current.current === null && set(openWidth()),
      // useAutoHide asks for the docked column's width, in pixels.
      resize: (size) => set(typeof size === 'number' ? size : openWidth()),
      getSize: () => ({ inPixels: current.current ?? COLLAPSED_PX, asPercentage: 0 }),
    }
  }, [])
  return { panel, width }
}

/** What a side pane's content needs to draw its strip, pin and overlay buttons. */
export type SidePane = {
  collapsed: boolean
  pinned: boolean
  togglePin: () => void
  /** Opens it from its strip. */
  expand: () => void
  /** Closes it to its strip: an overlay's close button, which it has instead of the pin. */
  close: () => void
  overlay: boolean
  toggleOverlay: () => void
  /** The keyboard shortcut that pins or collapses it, for its pin's tooltip; empty if it has none. */
  shortcut: string
}

/** One side pane: docked, a resizable column; overlay, it floats over the middle pane, which keeps its width, while its column stays at the strip's width beneath it. Pin, overlay and width are shared by every page. */
const useSide = (side: Side) => {
  const [docked, setDocked] = usePanelCallbackRef()
  const [overlay, setOverlay] = useSharedPref<boolean>('wt:' + side + 'Overlay', false)
  const floating = useOverlayPanel(OPEN_WIDTH[side])
  const panel = overlay ? floating.panel : docked
  const auto = useAutoHide(panel, side, overlay)
  // Switched to an overlay from its own button, it opens floating rather than vanishing to the strip; on load, it opens if it was open when this page was last here.
  const openKey = 'wt:overlayOpen:' + side
  const openFloating = useRef(store.get(openKey, false))
  useEffect(() => {
    if (!overlay) {
      floating.panel.collapse()
      return
    }
    docked?.collapse()
    if (openFloating.current) auto.expand()
    openFloating.current = false
  }, [overlay, docked])
  useEffect(() => {
    if (!overlay) return
    auto.onResize()
    store.set(openKey, floating.width !== null)
  }, [overlay, floating.width])
  const pane: SidePane = {
    collapsed: auto.collapsed,
    pinned: auto.pinned,
    togglePin: auto.togglePin,
    expand: auto.expand,
    close: auto.close,
    overlay,
    toggleOverlay: () => {
      openFloating.current = !overlay
      setOverlay(!overlay)
    },
    shortcut: SHORTCUT[side],
  }
  return {
    setDocked,
    floatingWidth: floating.width,
    auto,
    pane,
    // The shortcut unpinning collapses at once, even with the mouse over the pane or a message half typed in it. An overlay it just opens or closes.
    toggleFromShortcut: () => {
      if (overlay) {
        if (panel?.isCollapsed()) auto.expand()
        else panel?.collapse()
        return
      }
      auto.togglePin()
      if (auto.pinned) panel?.collapse()
    },
  }
}

type PaneLayoutProps = {
  /** Where the docked columns' sizes are saved. */
  id: string
  rail: (pane: SidePane) => ReactNode
  middle: ReactNode
  chat: (pane: SidePane) => ReactNode
  /** What ⌘⇧← does (the cockpit opens or closes its Index overlay); nothing without it. */
  onLeftKey?: () => void
}

/** The cockpit's layout, which the index shares: a rail on the left, the page in the middle, the chat on the right; each side docked or floating, pinned or collapsed to a strip. */
export const PaneLayout = ({ id, rail, middle, chat, onLeftKey }: PaneLayoutProps) => {
  const left = useSide('rail')
  const right = useSide('chat')
  // Where the two floating panes overlap, the one last clicked is on top. (Not on focus: the chat's sticky focus would pull it back up.)
  const [front, setFront] = useState<Side>('chat')
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id, storage: layoutStorage })

  const sides = useRef({ left, right, onLeftKey })
  sides.current = { left, right, onLeftKey }
  useEffect(() => {
    const toggle = (side: Side) => (side === 'rail' ? sides.current.onLeftKey?.() : sides.current.right.toggleFromShortcut())
    const onKey = (event: KeyboardEvent) => {
      const side = shortcutSide(event)
      if (!side) return
      event.preventDefault()
      toggle(side)
    }
    // From one of this page's own frames only.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'studio-pane-key' || ![...document.querySelectorAll('iframe')].some((frame) => frame.contentWindow === event.source)) return
      if (event.data.key === 'ArrowLeft') toggle('rail')
      if (event.data.key === 'ArrowRight') toggle('chat')
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMessage)
    }
  }, [])

  const railElement = rail(left.pane)
  const chatElement = chat(right.pane)

  // Open, a card like the index's chat: inset from the edges, rounded, bordered; collapsed, the strip flush against the edge.
  // Open, the inset around the card lets presses through to the page, so they close it like any press outside.
  // Collapsed, it sits under the dim (z-19) like the page, so the other pane opening dims it too; the dim lets the mouse through to open it.
  const floating = (side: Side, s: typeof left, element: ReactNode) => (
    <div
      ref={s.auto.box}
      {...s.auto.handlers}
      onPointerDownCapture={() => setFront(side)}
      className={cn('absolute inset-y-0 max-w-full', side === 'rail' ? 'left-0' : 'right-0', s.floatingWidth === null ? 'z-18' : front === side ? 'z-21' : 'z-20', s.floatingWidth !== null && 'pointer-events-none p-4')}
      style={{ width: s.floatingWidth === null ? COLLAPSED_PX : s.floatingWidth + 32 }}
    >
      <div className={cn('pointer-events-auto h-full bg-background', s.floatingWidth === null ? (side === 'rail' ? 'border-r' : 'border-l') : 'overflow-hidden rounded-xl border shadow-2xl')}>{element}</div>
    </div>
  )

  return (
    <div className="relative h-full w-full">
      <ResizablePanelGroup orientation="horizontal" id={id} defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <ResizablePanel
          id="rail"
          panelRef={left.setDocked}
          defaultSize="20"
          minSize="240px"
          maxSize="35"
          collapsible
          collapsedSize={COLLAPSED_PX + 'px'}
          disabled={left.pane.overlay}
          onResize={left.pane.overlay ? undefined : left.auto.onResize}
          className="border-r"
        >
          {!left.pane.overlay && (
            <div ref={left.auto.box} className="h-full" {...left.auto.handlers}>
              {railElement}
            </div>
          )}
        </ResizablePanel>
        <ResizableHandle id="rail-handle" disabled={left.pane.overlay} {...(!left.pane.overlay && left.auto.handlers)} />
        <ResizablePanel id="app" defaultSize="50" minSize="20">
          {middle}
        </ResizablePanel>
        <ResizableHandle id="chat-handle" disabled={right.pane.overlay} {...(!right.pane.overlay && right.auto.handlers)} />
        <ResizablePanel
          id="chat"
          panelRef={right.setDocked}
          defaultSize="30"
          minSize="280px"
          collapsible
          collapsedSize={COLLAPSED_PX + 'px'}
          disabled={right.pane.overlay}
          onResize={right.pane.overlay ? undefined : right.auto.onResize}
          className="border-l"
        >
          {!right.pane.overlay && (
            <div ref={right.auto.box} className="h-full" {...right.auto.handlers}>
              {chatElement}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* An open floating pane (either, or both) dims the page beneath it. Clicks still reach the page. */}
      <div
        aria-hidden
        className={cn('pointer-events-none absolute inset-0 z-19 bg-black/20 transition-opacity', [left, right].some((s) => s.pane.overlay && s.floatingWidth !== null) ? 'opacity-100' : 'opacity-0')}
      />
      {right.pane.overlay && floating('chat', right, chatElement)}
      {left.pane.overlay && floating('rail', left, railElement)}
    </div>
  )
}
