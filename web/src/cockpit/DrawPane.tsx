import { Eraser, Pencil, Redo2, SquareDashed, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

// What goes to Claude is on white paper in either theme; in dark mode the board shows it with its lightness inverted (shade).
const PAPER = '#ffffff'
// A stroke's colour when it rubs out: paper on the board, a hole in the ink over an artifact.
const ERASER = 'eraser'
const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a']
const SIZES = { S: 2, M: 4, L: 10 } as const
type Size = keyof typeof SIZES
// Around the ink in what's sent, in CSS pixels.
const MARGIN = 24
// The longest side of what's sent from the board, in image pixels: ink spread far across it is sent smaller.
const MAX_SIDE = 4096
// The board's dot grid, in CSS pixels: shown so panning is seen on blank paper, never sent.
const GRID = 24
// How far the board zooms out and in.
const ZOOM = { min: 0.1, max: 8 }

type Point = { x: number; y: number; w: number }
type Rect = { x: number; y: number; w: number; h: number }
type Ink = { color: string; points: Point[] }
// A stroke, a clear, or a cut (a selected rectangle rubbed out, like the eraser does).
type Stroke = Ink | { clear: true } | { cut: Rect }
type Mark = Exclude<Stroke, { clear: true }>
type Tool = 'pen' | 'eraser' | 'select'

/**
 * What the cockpit asks of the drawing: a PNG of the ink, or null when there's none. On paper it is cropped to the ink; over an
 * artifact it is the whole pane, drawn over `background` (the artifact as rendered) when given.
 */
export type DrawingHandle = {
  toPng: (background?: CanvasImageSource) => Promise<Blob | null>
  /** The sheet's size in CSS pixels, as last laid out (it keeps it while hidden). */
  size: () => { width: number; height: number }
}

type DrawPaneProps = {
  ref?: Ref<DrawingHandle>
  /** Whether the pane is showing: its keys (undo, redo) only work then. */
  active: boolean
  /** Shown at the start of the toolbar: the App | Artifacts | Draw switch, or what closes the overlay. */
  switcher?: ReactNode
  /** Whether the drawing goes with the next message (it changed since the last one, and its chip wasn't removed). */
  attached: boolean
  /** The drawing changed (a stroke, undo, redo or clear); `inked` says whether anything is left on it. */
  onChange: (inked: boolean) => void
  /** Drawn on a transparent sheet laid over what's beneath (an artifact), its toolbar floating at the top, instead of on paper. */
  overlay?: boolean
}

// Strokes and cuts since the last clear: what's on the paper.
const visible = (history: Stroke[]) => {
  const from = history.findLastIndex((stroke) => 'clear' in stroke)
  return history.slice(from + 1) as Mark[]
}

/** How strokes look on a canvas: on `paper` (its colour, which the eraser paints) or, with null, on a transparent sheet; `color` maps each ink's colour. */
type Look = { paper: string | null; color: (color: string) => string }
const AS_DRAWN: Look = { paper: PAPER, color: (color) => color }

const pen = (ctx: CanvasRenderingContext2D, look: Look, color: string) => {
  const erasing = color === ERASER && !look.paper
  ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'
  ctx.strokeStyle = ctx.fillStyle = erasing ? '#000' : color === ERASER ? look.paper! : look.color(color)
}

// The same hue with its lightness flipped: dark ink on white becomes light ink on black.
const shade = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d && d / (1 - Math.abs(2 * l - 1))
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return `hsl(${Math.round(h * 60)} ${Math.round(s * 100)}% ${Math.round((1 - l) * 100)}%)`
}

const segment = (ctx: CanvasRenderingContext2D, look: Look, color: string, a: Point, b: Point) => {
  pen(ctx, look, color)
  ctx.lineWidth = (a.w + b.w) / 2
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}

const dot = (ctx: CanvasRenderingContext2D, look: Look, color: string, p: Point) => {
  pen(ctx, look, color)
  ctx.beginPath()
  ctx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2)
  ctx.fill()
}

type Offset = { x: number; y: number }
const ORIGIN: Offset = { x: 0, y: 0 }

/** Paints the paper (if any) and every stroke on a canvas `scale` pixels per CSS pixel, the board magnified by `zoom` and moved by `offset` CSS pixels. */
const paint = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, look: Look, strokes: Mark[], scale: number, offset: Offset = ORIGIN, zoom = 1) => {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  if (look.paper) {
    ctx.fillStyle = look.paper
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  } else ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale * zoom, 0, 0, scale * zoom, offset.x * scale, offset.y * scale)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if ('cut' in stroke) {
      pen(ctx, look, ERASER)
      ctx.fillRect(stroke.cut.x, stroke.cut.y, stroke.cut.w, stroke.cut.h)
      continue
    }
    if (stroke.points.length === 1) dot(ctx, look, stroke.color, stroke.points[0])
    for (let i = 1; i < stroke.points.length; i++) segment(ctx, look, stroke.color, stroke.points[i - 1], stroke.points[i])
  }
}

// Whether the cockpit is in dark mode (theme.ts sets .dark on <html>).
const isDark = () => document.documentElement.classList.contains('dark')
const useDark = () => {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/**
 * A whiteboard (or, as an overlay, a transparent sheet over an artifact) whose drawing goes to Claude with the next chat message.
 * Built for latency: ink is drawn on a desynchronized canvas straight from each pointer event (every coalesced sample, as soon as
 * it arrives), outside React; the browser's predicted next samples are drawn on a layer above and replaced by the real ones.
 * In dark mode the ink's lightness is inverted (and the paper black), drawn so rather than filtered, which would cost the low-latency path.
 * The board (not the overlay) is infinite: strokes are kept in board coordinates, holding ⌘ and dragging pans it,
 * and a pinch or ⌘-scroll zooms it about the pointer; the pen keeps its width on screen, so zooming in draws finer.
 * The select tool drags out a rectangle; Delete (or its button) cuts everything inside it, and undo brings it back.
 */
export const DrawPane = ({ ref, active, switcher, attached, onChange, overlay = false }: DrawPaneProps) => {
  const dark = useDark()
  const look = useRef<Look>(AS_DRAWN)
  look.current = overlay ? { paper: null, color: dark ? shade : AS_DRAWN.color } : dark ? { paper: '#000000', color: shade } : AS_DRAWN
  const tip = useTip()
  const [color, setColor] = useState(COLORS[0])
  const [size, setSize] = useState<Size>('M')
  const [tool, setTool] = useState<Tool>('pen')
  const [counts, setCounts] = useState({ undo: 0, redo: 0, inked: false })
  const stage = useRef<HTMLDivElement>(null)
  const inkCanvas = useRef<HTMLCanvasElement>(null)
  const guessCanvas = useRef<HTMLCanvasElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const history = useRef<Stroke[]>([])
  const redo = useRef<Stroke[]>([])
  // Canvas pixels per CSS pixel, as last sized (a hidden pane measures nothing).
  const scale = useRef(1)
  // Where the board's origin is in the pane, in CSS pixels: moved by panning (an overlay stays put over its page).
  const pan = useRef<Offset>({ ...ORIGIN })
  // Screen pixels per board pixel (1 for an overlay); the state is only for the toolbar's percentage.
  const zoom = useRef(1)
  const [shownZoom, setShownZoom] = useState(1)
  // The selected rectangle, in board coordinates, until it's cut or dropped; the state is only for the toolbar's button.
  const selection = useRef<Rect | null>(null)
  const [selected, setSelected] = useState(false)
  // ⌘ held over the board (a hand to drag it), or a drag under way.
  const [hand, setHand] = useState<'off' | 'ready' | 'dragging'>('off')
  // The pen settings, read by the pointer handlers without rebinding them.
  const settings = useRef({ color, width: SIZES[size], tool })
  const onChangeRef = useRef(onChange)
  useLayoutEffect(() => {
    settings.current = { color, width: SIZES[size], tool }
    onChangeRef.current = onChange
  })

  const contexts = () => {
    const ink = inkCanvas.current?.getContext('2d', { alpha: overlay, desynchronized: true }) ?? null
    const guess = guessCanvas.current?.getContext('2d') ?? null
    return { ink, guess }
  }

  // Clears the guess layer and draws the selection (if any) on it, dashed, its lines a pixel wide at any zoom.
  const showSelection = () => {
    const { guess } = contexts()
    const canvas = guessCanvas.current
    if (!guess || !canvas) return
    guess.save()
    guess.setTransform(1, 0, 0, 1, 0, 0)
    guess.clearRect(0, 0, canvas.width, canvas.height)
    guess.restore()
    const rect = selection.current
    if (!rect) return
    guess.save()
    guess.globalCompositeOperation = 'source-over'
    guess.strokeStyle = '#3b82f6'
    guess.lineWidth = 1 / zoom.current
    guess.setLineDash([4 / zoom.current, 4 / zoom.current])
    guess.strokeRect(rect.x, rect.y, rect.w, rect.h)
    guess.restore()
  }
  const select = (rect: Rect | null) => {
    selection.current = rect
    setSelected(!!rect)
    showSelection()
  }
  const cut = () => {
    const rect = selection.current
    if (!rect) return
    select(null)
    push({ cut: rect })
    redraw()
  }

  const redraw = () => {
    const { ink } = contexts()
    const canvas = inkCanvas.current
    if (!ink || !canvas) return
    paint(canvas, ink, look.current, visible(history.current), scale.current, pan.current, zoom.current)
    if (grid.current) {
      // Its dots halve or double their spacing to stay between 12 and 48 pixels apart at any zoom.
      let gap = GRID * zoom.current
      while (gap < 12) gap *= 2
      while (gap > 48) gap /= 2
      grid.current.style.backgroundSize = `${gap}px ${gap}px`
      grid.current.style.backgroundPosition = `${pan.current.x}px ${pan.current.y}px`
    }
    const { guess } = contexts()
    if (guess) {
      const dpr = scale.current
      guess.setTransform(dpr * zoom.current, 0, 0, dpr * zoom.current, pan.current.x * dpr, pan.current.y * dpr)
      guess.lineCap = 'round'
      guess.lineJoin = 'round'
    }
    showSelection()
  }
  // Switching theme redraws the board in the other one.
  useLayoutEffect(redraw, [dark])

  const changed = () => {
    const inked = visible(history.current).length > 0
    setCounts({ undo: history.current.length, redo: redo.current.length, inked })
    onChangeRef.current(inked)
  }

  const push = (stroke: Stroke) => {
    history.current.push(stroke)
    redo.current = []
    changed()
  }
  const undo = () => {
    const last = history.current.pop()
    if (!last) return
    redo.current.push(last)
    redraw()
    changed()
  }
  const again = () => {
    const next = redo.current.pop()
    if (!next) return
    history.current.push(next)
    redraw()
    changed()
  }
  const clear = () => {
    if (!visible(history.current).length) return
    push({ clear: true })
    redraw()
  }

  // Sizes both canvases to the pane at the screen's pixel density; the ink is redrawn from its strokes.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (!width || !height) return
      const dpr = window.devicePixelRatio || 1
      scale.current = dpr
      for (const canvas of [inkCanvas.current, guessCanvas.current]) {
        if (!canvas) continue
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      redraw()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The pointer handlers: bound once, natively, so nothing between the event and the ink goes through React.
  useEffect(() => {
    const canvas = guessCanvas.current
    if (!canvas) return
    let stroke: { color: string; points: Point[] } | null = null
    let pointerId: number | null = null
    // A selection being dragged out: where it started, in board coordinates.
    let picking: Point | null = null
    // A pan under way: where the pointer and the board were when it started.
    let drag: { x: number; y: number; from: Offset } | null = null
    let frame = 0
    const later = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0
        redraw()
      })
    }

    // A trackpad pinch (a wheel event with ctrlKey) or ⌘-scroll zooms about the pointer, not while a stroke is under way.
    const wheel = (event: WheelEvent) => {
      if (overlay || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      if (stroke) return
      const rect = canvas.getBoundingClientRect()
      const [x, y] = [event.clientX - rect.left, event.clientY - rect.top]
      const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY
      const next = Math.min(ZOOM.max, Math.max(ZOOM.min, zoom.current * Math.exp(-step * 0.01)))
      const k = next / zoom.current
      pan.current = { x: x - (x - pan.current.x) * k, y: y - (y - pan.current.y) * k }
      zoom.current = next
      setShownZoom(next)
      later()
    }

    const point = (event: PointerEvent): Point => {
      const rect = canvas.getBoundingClientRect()
      const { width } = settings.current
      // A pen's pressure sets the width (0.5 is a mouse or a pen reporting none); the eraser is wide and even.
      const pressure = event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : 0.5
      const w = (stroke?.color === ERASER ? width * 5 : width * (0.4 + pressure * 1.2)) / zoom.current
      return { x: (event.clientX - rect.left - pan.current.x) / zoom.current, y: (event.clientY - rect.top - pan.current.y) / zoom.current, w }
    }

    const clearGuess = () => {
      const { guess } = contexts()
      if (!guess) return
      guess.save()
      guess.setTransform(1, 0, 0, 1, 0, 0)
      guess.clearRect(0, 0, canvas.width, canvas.height)
      guess.restore()
    }

    const down = (event: PointerEvent) => {
      if (pointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return
      event.preventDefault()
      canvas.setPointerCapture(event.pointerId)
      pointerId = event.pointerId
      if (!overlay && event.metaKey) {
        drag = { x: event.clientX, y: event.clientY, from: pan.current }
        setHand('dragging')
        return
      }
      // A pen's eraser end (or its eraser button) rubs out whatever tool is picked.
      const penEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0)
      if (settings.current.tool === 'select' && !penEraser) {
        picking = point(event)
        select(null)
        return
      }
      if (selection.current) select(null)
      const erasing = settings.current.tool === 'eraser' || penEraser
      stroke = { color: erasing ? ERASER : settings.current.color, points: [] }
      stroke.points.push(point(event))
      const { ink } = contexts()
      if (ink) dot(ink, look.current, stroke.color, stroke.points[0])
    }

    const move = (event: PointerEvent) => {
      if (drag && event.pointerId === pointerId) {
        pan.current = { x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y }
        later()
        return
      }
      if (picking && event.pointerId === pointerId) {
        const p = point(event)
        selection.current = { x: Math.min(picking.x, p.x), y: Math.min(picking.y, p.y), w: Math.abs(p.x - picking.x), h: Math.abs(p.y - picking.y) }
        showSelection()
        return
      }
      if (!stroke || event.pointerId !== pointerId) return
      const { ink, guess } = contexts()
      if (!ink) return
      const samples = event.getCoalescedEvents?.() ?? []
      for (const sample of samples.length ? samples : [event]) {
        const p = point(sample)
        const last = stroke.points[stroke.points.length - 1]
        if (p.x === last.x && p.y === last.y) continue
        segment(ink, look.current, stroke.color, last, p)
        stroke.points.push(p)
      }
      clearGuess()
      const predicted = event.getPredictedEvents?.() ?? []
      // An eraser's guess isn't shown: on the transparent guess layer it would rub out nothing.
      if (!guess || !predicted.length || stroke.color === ERASER) return
      let from = stroke.points[stroke.points.length - 1]
      for (const sample of predicted) {
        const p = point(sample)
        segment(guess, look.current, stroke.color, from, p)
        from = p
      }
    }

    const up = (event: PointerEvent) => {
      if (drag && event.pointerId === pointerId) {
        drag = null
        pointerId = null
        setHand(event.metaKey ? 'ready' : 'off')
        return
      }
      if (picking && event.pointerId === pointerId) {
        picking = null
        pointerId = null
        const rect = selection.current
        // A click, or a box under 3 screen pixels across, selects nothing.
        select(rect && Math.max(rect.w, rect.h) * zoom.current >= 3 ? rect : null)
        return
      }
      if (!stroke || event.pointerId !== pointerId) return
      clearGuess()
      const done = stroke
      stroke = null
      pointerId = null
      push(done)
    }

    // pointerrawupdate fires as each sample arrives instead of once a frame, where the browser has it.
    const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove'
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener(moveEvent, move as EventListener)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener(moveEvent, move as EventListener)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      cancelAnimationFrame(frame)
    }
  }, [])

  // Holding ⌘ over the board shows a hand to drag it by; letting go (or leaving the window) puts the pen back, unless a drag is under way.
  useEffect(() => {
    if (!active || overlay) return
    const onKey = (event: KeyboardEvent) => setHand((current) => (current === 'dragging' ? current : event.metaKey ? 'ready' : 'off'))
    const onBlur = () => setHand((current) => (current === 'dragging' ? current : 'off'))
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', onBlur)
      setHand('off')
    }
  }, [active, overlay])

  // Picking another tool drops the selection.
  useEffect(() => {
    if (tool !== 'select' && selection.current) select(null)
  }, [tool])

  // Delete or Backspace cuts the selection and Esc drops it, unless the chat box (which keeps the keyboard) has text in it.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (!selection.current || !['Delete', 'Backspace', 'Escape'].includes(event.key)) return
      const el = document.activeElement
      if (el instanceof HTMLElement && el.isContentEditable) return
      if ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.value) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') select(null)
      else cut()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  // ⌘Z / ⇧⌘Z while the pane shows, unless they'd undo typing (the chat box keeps the keyboard, so an empty box lets them through).
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.altKey) return
      const el = document.activeElement
      if (el instanceof HTMLElement && el.isContentEditable) return
      if ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.value) return
      event.preventDefault()
      if (event.shiftKey) again()
      else undo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  useImperativeHandle(ref, () => ({
    toPng: async (background) => {
      const canvas = inkCanvas.current
      const strokes = visible(history.current)
      const inks = strokes.filter((stroke): stroke is Ink => 'points' in stroke && stroke.color !== ERASER)
      if (!canvas || !inks.length) return null
      const png = (out: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
      if (overlay) {
        // On a sheet of its own, so the eraser only rubs out ink; ink over an artifact keeps the colours shown, since the page under it is captured in the same theme.
        const sheet = document.createElement('canvas')
        sheet.width = canvas.width
        sheet.height = canvas.height
        paint(sheet, sheet.getContext('2d')!, look.current, strokes, scale.current)
        if (!background) return png(sheet)
        const out = document.createElement('canvas')
        out.width = sheet.width
        out.height = sheet.height
        const ctx = out.getContext('2d')!
        ctx.drawImage(background, 0, 0, out.width, out.height)
        ctx.drawImage(sheet, 0, 0)
        return png(out)
      }
      // The ink and a margin, wherever it is on the board (in or out of view), repainted as drawn (white, the colours picked) whatever the board shows.
      let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]
      for (const { points } of inks)
        for (const p of points) {
          left = Math.min(left, p.x - p.w)
          top = Math.min(top, p.y - p.w)
          right = Math.max(right, p.x + p.w)
          bottom = Math.max(bottom, p.y + p.w)
        }
      left -= MARGIN
      top -= MARGIN
      const [width, height] = [right + MARGIN - left, bottom + MARGIN - top]
      // At the screen's density, unless that would make an image wider or taller than MAX_SIDE pixels.
      const dpr = Math.min(scale.current, MAX_SIDE / Math.max(width, height))
      const out = document.createElement('canvas')
      out.width = Math.ceil(width * dpr)
      out.height = Math.ceil(height * dpr)
      paint(out, out.getContext('2d')!, AS_DRAWN, strokes, dpr, { x: -left, y: -top })
      return png(out)
    },
    size: () => ({ width: (inkCanvas.current?.width ?? 0) / scale.current, height: (inkCanvas.current?.height ?? 0) / scale.current }),
  }))

  return (
    <div className={overlay ? 'absolute inset-0 z-10' : 'grid h-full grid-rows-[auto_1fr] bg-muted/50'}>
      <div className={overlay ? 'absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-xl border bg-background/90 px-2 py-1 shadow-md backdrop-blur' : 'flex flex-wrap items-center gap-2 border-b bg-background px-3 py-1.5'}>
        {switcher}
        <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={tool} aria-label="Tool" onValueChange={(value) => value && setTool(value as Tool)}>
          <ToggleGroupItem value="pen" className="h-7 px-2" aria-label="Pen" title={tip('Pen')}>
            <Pencil />
          </ToggleGroupItem>
          <ToggleGroupItem value="eraser" className="h-7 px-2" aria-label="Eraser" title={tip("Eraser (a pen's eraser end rubs out too)")}>
            <Eraser />
          </ToggleGroupItem>
          <ToggleGroupItem value="select" className="h-7 px-2" aria-label="Select" title={tip('Select an area to cut (Delete cuts it, Esc lets go)')}>
            <SquareDashed />
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
          {COLORS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={color === value && tool === 'pen'}
              aria-label={'Colour ' + value}
              className={'size-5 rounded-full ring-offset-2 ring-offset-background ' + (color === value && tool === 'pen' ? 'ring-2 ring-ring' : '')}
              style={{ background: dark ? shade(value) : value }}
              onClick={() => {
                setColor(value)
                setTool('pen')
              }}
            />
          ))}
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={size} aria-label="Size" onValueChange={(value) => value && setSize(value as Size)}>
          {(Object.keys(SIZES) as Size[]).map((value) => (
            <ToggleGroupItem key={value} value={value} className="h-7 px-2 text-xs">
              {value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="min-w-16 flex-1 basis-0 truncate text-xs text-muted-foreground">{attached ? (overlay ? 'Goes with your next message, over the page' : 'Goes with your next message') : counts.inked ? 'Not going with the next message: draw more to attach it again' : overlay ? 'Draw on the page to send it with your next message' : 'Draw something to send with your next message'}</span>
        {!overlay && (
          <Button
            size="sm"
            variant="ghost"
            className="w-14 tabular-nums"
            title={tip('Back to 100% and where you started (pinch or ⌘-scroll zooms, ⌘-drag pans)')}
            onClick={() => {
              pan.current = { ...ORIGIN }
              zoom.current = 1
              setShownZoom(1)
              redraw()
            }}
          >
            {Math.round(shownZoom * 100)}%
          </Button>
        )}
        {selected && (
          <Button size="sm" variant="outline" title={tip('Cut what is in the box (Delete; undo brings it back)')} onClick={cut}>
            <Eraser /> cut
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Undo" title={tip('Undo (⌘Z)')} disabled={!counts.undo} onClick={undo}>
          <Undo2 />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Redo" title={tip('Redo (⇧⌘Z)')} disabled={!counts.redo} onClick={again}>
          <Redo2 />
        </Button>
        <Button size="sm" variant="outline" title={tip((overlay ? 'Clear the drawing' : 'Clear the paper') + ' (undo brings it back)')} disabled={!counts.inked} onClick={clear}>
          <Trash2 /> clear
        </Button>
      </div>
      <div ref={stage} className={overlay ? 'absolute inset-0 overflow-hidden' : 'relative min-h-0 min-w-0 overflow-hidden'}>
        <canvas ref={inkCanvas} className="absolute inset-0 size-full" />
        {!overlay && (
          <div
            ref={grid}
            className="pointer-events-none absolute inset-0"
            style={{ backgroundImage: `radial-gradient(circle, ${dark ? 'rgb(255 255 255 / 0.16)' : 'rgb(0 0 0 / 0.14)'} 1px, transparent 1.5px)` }}
          />
        )}
        <canvas ref={guessCanvas} className={'absolute inset-0 size-full touch-none select-none ' + (hand === 'dragging' ? 'cursor-grabbing' : hand === 'ready' ? 'cursor-grab' : 'cursor-crosshair')} />
      </div>
    </div>
  )
}
