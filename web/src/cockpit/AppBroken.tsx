import { LoaderCircle, Wrench, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useControls } from '@/components/controls/ControlsProvider'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { getAppLog, setMode, startFeature } from '@/lib/api'
import { FIX_FEATURE, fixBlocked, fixMessage, type AppError } from '@/lib/appError'
import type { App } from '@/lib/types'

type AppBrokenProps = {
  error: AppError
  w: App
  /** Sends Claude a message through the chat, as [Build this] does. */
  onSend: (message: string) => void
  /** Hides a page's error (it stays hidden until the page reports another). */
  onDismiss?: () => void
}

/**
 * What the App tab shows when the app breaks: its server crashed (with the end of its log) or the page threw (with the error),
 * and [Ask Claude to fix this], which sends Claude the last 50 lines of data/logs/dev.log in Build mode, starting a feature for
 * the fix when none is open. While an old version is previewed it says that version may not suit today's data instead.
 */
export const AppBroken = ({ error, w, onSend, onDismiss }: AppBrokenProps) => {
  const tip = useTip()
  const { refresh } = useControls()
  const [tail, setTail] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState('')
  const blocked = fixBlocked(w)
  const shown = useRef<HTMLPreElement>(null)

  // The server's log is shown while it is down, and read again as it changes.
  useEffect(() => {
    if (error.kind !== 'server') return
    const read = () => void getAppLog().then(setTail)
    read()
    const timer = setInterval(read, 3000)
    return () => clearInterval(timer)
  }, [error.kind])

  const fix = async () => {
    setSending(true)
    setMessage('')
    const failed = w.feature ? null : await startFeature(FIX_FEATURE)
    const moved = failed || w.mode === 'build' ? null : await setMode('build')
    const log = failed || (moved && 'error' in moved) ? '' : await getAppLog()
    setSending(false)
    if (failed) return setMessage(failed)
    if (moved && 'error' in moved) return setMessage(moved.error)
    await refresh()
    onSend(fixMessage(error, log))
    setMessage('Sent to Claude. The app comes back here once it is fixed.')
  }

  // A crash is at the end of the log, so that is where the log opens; a page's error starts with what went wrong.
  const detail = error.kind === 'server' ? tail : error.message
  useLayoutEffect(() => {
    if (shown.current && error.kind === 'server') shown.current.scrollTop = shown.current.scrollHeight
  }, [detail, error.kind])

  const title = error.kind === 'server' ? "The app's server stopped with an error" : 'This page hit an error'
  return (
    <div role="alert" className="grid w-full max-w-3xl gap-2 rounded-lg border border-destructive/40 bg-background p-3 text-sm shadow-sm">
      <div className="flex items-start gap-2">
        <b className="text-destructive">{title}</b>
        {onDismiss && (
          <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label="Hide this error" title={tip('Hide this error')} onClick={onDismiss}>
            <X />
          </Button>
        )}
      </div>
      {w.preview ? (
        <p className="text-muted-foreground">
          You're previewing {w.preview.tag}, an old version. It may not work with the app's data{w.preview.packagesDiffer ? ' or packages' : ''} as they are now. Go back to the latest version above to use the app again.
        </p>
      ) : (
        <p className="text-muted-foreground">Claude can usually fix this. It gets what went wrong and the end of the app's log.</p>
      )}
      {detail && <pre ref={shown} className="max-h-48 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">{detail}</pre>}
      {!w.preview && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={Boolean(blocked) || sending} title={tip(blocked ?? "Switch the chat to Build and send Claude the error and the last 50 lines of the app's log")} onClick={() => void fix()}>
            {sending ? <LoaderCircle className="animate-spin" /> : <Wrench />} Ask Claude to fix this
          </Button>
          {(message || blocked) && <span className="text-xs text-muted-foreground">{message || blocked}</span>}
        </div>
      )}
    </div>
  )
}
