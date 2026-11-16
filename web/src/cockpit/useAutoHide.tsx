import { Pin, X } from 'lucide-react'
import { useEffect, useRef, useState, type FocusEvent } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { useControls } from '@/components/controls/ControlsProvider'
import { useTip } from '@/components/controls/Tip'
import { useSharedPref } from '@/components/controls/useSharedPref'
import { Button } from '@/components/ui/button'
import { cn } from 'cn'

const COLLAPSE_DELAY_MS = 100

// Something half typed holds a pane open; an empty box the cursor just sits in (the chat keeps it there) doesn't, nor does a focused button (the pin just clicked, an env switch).
const isTyping = (element: Element | null) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value !== ''
  return Boolean(element?.matches('select, [contenteditable="true"]'))
}

/** What the hook drives: a resizable panel, or anything that collapses and opens like one (the floating chat). */
export type AutoHidePanel = Pick<PanelImperativeHandle, 'collapse' | 'expand' | 'getSize' | 'isCollapsed' | 'resize'>

/**
 * A side pane that is either pinned open, or collapsed to a narrow column that expands while the
 * mouse is over it. It only collapses once the mouse has left and nothing in it has focus, so a half
 * typed message isn't snapped shut. Its pin and width are shared by every cockpit (useSharedPref).
 * As an overlay the mouse and the pin play no part: it opens from its strip and closes from its close
 * button or a click anywhere outside it.
 */
export const useAutoHide = (panel: AutoHidePanel | null, key: string, overlay = false) => {
  const [pinned, setPinned] = useSharedPref<boolean>('wt:pin:' + key, true)
  // A drag resizes it many times a second; the other cockpits get where it ends up.
  const [width, setWidth] = useSharedPref<number | null>('wt:width:' + key, null, 400)
  // Until the panel has taken the shared width, its size is this page's own saved layout, which mustn't overwrite it.
  const loaded = Boolean(useControls().state)
  const synced = useRef(false)
  const [collapsed, setCollapsed] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Set by a press inside the pane, portals (the recording pill) included, before the document hears it.
  const pressedInside = useRef(false)

  // Dragging its resize handle (id key + '-handle', which takes `handlers` too) holds it open, though the pointer leaves the handle mid-drag.
  const dragging = () => document.getElementById(key + '-handle')?.dataset.separator === 'active'
  const inUse = () => hovered.current || (Boolean(box.current?.contains(document.activeElement)) && isTyping(document.activeElement))
  // Back to the width it had, which the panel library forgets once a collapsed layout has been saved.
  const open = () => {
    if (!panel?.isCollapsed()) return
    synced.current = loaded
    if (width) panel.resize(width)
    else panel.expand()
  }
  const collapseSoon = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (dragging()) collapseSoon()
      else if (!pinned && !inUse()) panel?.collapse()
    }, COLLAPSE_DELAY_MS)
  }

  useEffect(() => {
    if (!panel || overlay) return
    if (pinned) {
      open()
    } else if (!inUse()) {
      panel.collapse()
    }
  }, [panel, pinned, overlay])

  // An open overlay closes on a press outside it, or a click into a frame (the app, an artifact), which the page only hears as its window losing focus.
  useEffect(() => {
    if (!panel || !overlay) return
    const onPointerDown = (event: PointerEvent) => {
      // A confirm the pane asked for renders outside it, so answering it would read as a press outside; so would using the ticket panel, which floats above it.
      const modalOpen = document.querySelector('[role="alertdialog"], [role="dialog"][aria-modal="true"]')
      const overOverlays = event.target instanceof Element && event.target.closest('[data-over-overlays]')
      if (!pressedInside.current && !modalOpen && !overOverlays) panel.collapse()
      pressedInside.current = false
    }
    const onBlur = () =>
      setTimeout(() => {
        const frame = document.activeElement
        if (frame instanceof HTMLIFrameElement && !box.current?.contains(frame)) panel.collapse()
      })
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [panel, overlay])

  // Open, it takes the width another cockpit gave it (or this one's, once the panel is there).
  useEffect(() => {
    if (!panel || panel.isCollapsed()) return
    if (width && Math.abs(panel.getSize().inPixels - width) > 1) panel.resize(width)
    synced.current = loaded
  }, [panel, width, loaded])

  useEffect(() => () => clearTimeout(timer.current), [])

  return {
    pinned,
    collapsed,
    box,
    /** Pass to the panel's onResize so `collapsed` follows the panel. */
    onResize: () => {
      const isCollapsed = Boolean(panel?.isCollapsed())
      setCollapsed(isCollapsed)
      if (panel && !isCollapsed && synced.current && Math.round(panel.getSize().inPixels) !== width) setWidth(Math.round(panel.getSize().inPixels))
    },
    togglePin: () => {
      setPinned(!pinned)
    },
    expand: open,
    close: () => panel?.collapse(),
    handlers: {
      onPointerDown: () => {
        pressedInside.current = true
      },
      onMouseEnter: () => {
        hovered.current = true
        clearTimeout(timer.current)
        if (!pinned && !overlay) open()
      },
      onMouseLeave: () => {
        hovered.current = false
        if (!pinned && !overlay) collapseSoon()
      },
      onBlur: (event: FocusEvent<HTMLDivElement>) => {
        if (!pinned && !overlay && !hovered.current && !box.current?.contains(event.relatedTarget as Node | null)) collapseSoon()
      },
    },
  }
}

type PinButtonProps = {
  pinned: boolean
  onToggle: () => void
  /** What the pane is called in the button's tooltip ("status", "Claude"). */
  name: string
  /** Its keyboard shortcut, shown in the tooltip. */
  shortcut?: string
  className?: string
}

/** Pins a pane open, or unpins it to a narrow column that expands on hover. */
export const PinButton = ({ pinned, onToggle, name, shortcut, className }: PinButtonProps) => {
  const tip = useTip()
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-pressed={pinned}
      aria-label={pinned ? 'Unpin ' + name : 'Pin ' + name + ' open'}
      title={tip((pinned ? 'Unpin: collapse ' + name + ' to a narrow column that opens when you hover it' : 'Pin ' + name + ' open') + (shortcut ? ' (' + shortcut + ')' : ''))}
      onClick={onToggle}
      className={cn(pinned ? 'text-foreground' : 'text-muted-foreground', className)}
    >
      <Pin className={cn(pinned && 'fill-current')} />
    </Button>
  )
}

/** Closes a pane floating over the page (which has no pin: it stays open until closed or clicked out of). */
export const CloseButton = ({ onClose, name, shortcut, className }: { onClose: () => void; name: string; shortcut?: string; className?: string }) => {
  const tip = useTip()
  return (
    <Button size="icon-xs" variant="ghost" aria-label={'Close ' + name} title={tip('Close ' + name + (shortcut ? ' (' + shortcut + ')' : ''))} onClick={onClose} className={cn('text-muted-foreground', className)}>
      <X />
    </Button>
  )
}
