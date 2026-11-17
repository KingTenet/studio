import { ArchiveRestore, Eye, LoaderCircle, MessageSquareText, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useControls } from '@/components/controls/ControlsProvider'
import { useTip } from '@/components/controls/Tip'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { endPreview, getSession, previewVersion, restoreVersion } from '@/lib/api'
import { resolveQueue, type ChatMessage } from '@/lib/queue'
import type { App, Version } from '@/lib/types'
import { cn } from 'cn'
import { Message } from './Chat'

/** Why the versions can't be previewed or restored just now, or '' when they can. */
const blockedBy = (w: App) => {
  const chat = w.agents.find((agent) => agent.tab !== 'Artifacts')
  if (chat?.status === 'working') return 'Claude is working…'
  if (chat?.status === 'blocked') return 'Claude is waiting on a question'
  if (w.feature) return `Keep or discard "${w.feature.name}" first`
  return ''
}

/** The conversation a version was built in, read-only: what the user asked and what Claude said and did. */
const Transcript = ({ version, sessionId, onClose }: { version: Version; sessionId: string; onClose: () => void }) => {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    void getSession(new URLSearchParams({ stopped: sessionId })).then((view) => (view ? setMessages(resolveQueue(view.messages)) : setMissing(true)))
  }, [sessionId])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            How {version.tag} was built: {version.name}
          </DialogTitle>
          <DialogDescription>The conversation with Claude, as it was. It can't be changed from here.</DialogDescription>
        </DialogHeader>
        <div className="grid content-start gap-3 overflow-y-auto pr-1">
          {missing ? (
            <p className="text-sm text-muted-foreground">This conversation isn't on this computer any more.</p>
          ) : messages === null ? (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          ) : (
            messages.map((message, i) => <Message key={i} message={message} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The Versions section's body: the versions kept, newest first, each with how it was built (the Claude conversations, read-only),
 * and for the older ones Preview (shown in the app pane until [back to latest]) and Restore (made the next version). Both wait
 * while a feature is open or Claude is working, saying why.
 */
export const VersionsPanel = ({ w }: { w: App | null }) => {
  const tip = useTip()
  const { confirm, refresh } = useControls()
  const [doing, setDoing] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [reading, setReading] = useState<{ version: Version; sessionId: string } | null>(null)
  if (!w || w.versions.length === 0) return <p className="text-sm text-muted-foreground">The versions you keep will be listed here.</p>
  const latest = w.versions.at(-1)!
  const next = 'v' + (Math.max(...w.versions.map((version) => Number(version.tag.slice(1)))) + 1)
  const why = blockedBy(w)

  const act = async (key: string, action: () => Promise<object | { error: string }>) => {
    setDoing(key)
    const done = await action()
    setDoing(null)
    setMessage('error' in done ? done.error : '')
    await refresh()
  }
  const restore = async (version: Version) => {
    const later = w.versions.filter((other) => Number(other.tag.slice(1)) > Number(version.tag.slice(1))).map((other) => other.tag)
    const ok = await confirm(
      `Restore ${version.tag}, "${version.name}"?\nThe app's code goes back to how it was in ${version.tag}, saved as a new version, ${next}. Nothing is lost: ${later.join(', ')} stay in the list, and the app's data stays as it is now.`
    )
    if (ok) await act('restore:' + version.tag, () => restoreVersion(version.tag))
  }

  return (
    <div className="grid gap-2">
      {why && w.versions.length > 1 && <p className="text-xs text-muted-foreground">{why}</p>}
      <ol className="grid gap-2.5">
        {[...w.versions].reverse().map((version) => {
          const previewing = w.preview?.tag === version.tag
          return (
            <li key={version.tag} className={cn('grid gap-1', previewing && '-mx-1.5 rounded-lg bg-amber-500/10 px-1.5 py-1 ring-1 ring-amber-500/40')}>
              <div className="flex items-baseline gap-1.5">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{version.tag}</span>
                <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{version.name}</span>
                {version === latest && <span className="ml-auto shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">latest</span>}
                {previewing && <span className="ml-auto shrink-0 text-[10px] tracking-wide text-amber-700 uppercase dark:text-amber-400">previewing</span>}
              </div>
              {version.sessions.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3">
                  {version.sessions.map((sessionId, i) => (
                    <Button key={sessionId} size="xs" variant="link" className="h-5 px-0 text-muted-foreground" title={tip('Read the conversation with Claude that built this version')} onClick={() => setReading({ version, sessionId })}>
                      <MessageSquareText /> how this was built{version.sessions.length > 1 ? ` (part ${i + 1})` : ''}
                    </Button>
                  ))}
                </div>
              )}
              {version !== latest && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {previewing ? (
                    <Button size="xs" variant="outline" disabled={Boolean(why) || doing !== null} title={tip(why || 'Go back to the latest version: the code and data as they were')} onClick={() => void act('end', endPreview)}>
                      {doing === 'end' ? <LoaderCircle className="animate-spin" /> : <Undo2 />} back to latest
                    </Button>
                  ) : (
                    <Button size="xs" variant="outline" disabled={Boolean(why) || doing !== null} title={tip(why || `Look at ${version.tag} in the app pane; the data is put back as it is now when you go back`)} onClick={() => void act('preview:' + version.tag, () => previewVersion(version.tag))}>
                      {doing === 'preview:' + version.tag ? <LoaderCircle className="animate-spin" /> : <Eye />} Preview
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" disabled={Boolean(why) || doing !== null} title={tip(why || `Make ${version.tag}'s code the next version, ${next}`)} onClick={() => void restore(version)}>
                    {doing === 'restore:' + version.tag ? <LoaderCircle className="animate-spin" /> : <ArchiveRestore />} Restore
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      {reading && <Transcript version={reading.version} sessionId={reading.sessionId} onClose={() => setReading(null)} />}
    </div>
  )
}

/** The banner over the app while an old version is previewed: which, and [back to latest]. */
export const PreviewBanner = ({ w }: { w: App }) => {
  const tip = useTip()
  const { refresh } = useControls()
  const [going, setGoing] = useState(false)
  const [message, setMessage] = useState('')
  if (!w.preview) return null
  const why = blockedBy(w)
  const back = async () => {
    setGoing(true)
    const done = await endPreview()
    setGoing(false)
    setMessage('error' in done ? done.error : '')
    await refresh()
  }
  return (
    <div role="status" className="grid gap-0.5 border-b border-amber-500/40 bg-amber-100 px-3 py-1.5 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Eye className="size-4 shrink-0" />
        <span className="min-w-0">
          Previewing <b>{w.preview.tag}</b> · {w.preview.name}
        </span>
        <Button size="xs" variant="outline" className="ml-auto bg-background" disabled={Boolean(why) || going} title={tip(why || 'Go back to the latest version: the code and data as they were')} onClick={() => void back()}>
          {going ? <LoaderCircle className="animate-spin" /> : <Undo2 />} back to latest
        </Button>
      </div>
      <span className="text-xs opacity-80">
        {w.preview.packagesDiffer ? 'This version uses different packages from the latest, so parts of it may not work here. ' : ''}
        Claude won't change anything while you look. Changes to the data are undone when you go back.
      </span>
      {message && <span className="text-xs">{message}</span>}
    </div>
  )
}
