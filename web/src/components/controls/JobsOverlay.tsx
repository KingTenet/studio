import { Check, ChevronDown, ChevronRight, CircleHelp, LoaderCircle, SquareTerminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { clock } from '@/lib/format'
import type { Job } from '@/lib/jobs'
import { cn } from 'cn'
import { useControls } from './ControlsProvider'
import { useTip } from './Tip'

const STATUS: Record<Job['status'], { icon: typeof Check; className: string; title: string }> = {
  running: { icon: LoaderCircle, className: 'animate-spin text-sky-600', title: 'running' },
  ok: { icon: Check, className: 'text-emerald-600', title: 'finished' },
  failed: { icon: X, className: 'text-red-600', title: 'failed' },
  lost: { icon: CircleHelp, className: 'text-muted-foreground', title: 'the page was reloaded while it ran, so how it ended is unknown' },
}

// A job's output, kept scrolled to its end while it streams.
const Output = ({ text }: { text: string }) => {
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [text])
  return (
    <pre ref={pre} className="max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
      {text || '…'}
    </pre>
  )
}

const JobEntry = ({ job, open, onToggle }: { job: Job; open: boolean; onToggle: () => void }) => {
  const tip = useTip()
  const { removeJob } = useControls()
  const status = STATUS[job.status]
  return (
    <li className="grid gap-2 border-b py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} className="grid min-w-0 flex-1 grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-1.5 text-left">
          {open ? <ChevronDown className="mt-0.5 size-3.5 text-muted-foreground" /> : <ChevronRight className="mt-0.5 size-3.5 text-muted-foreground" />}
          <status.icon aria-label={status.title} className={cn('mt-0.5 size-3.5', status.className)} />
          <span className="truncate font-mono text-xs font-medium" title={tip(job.title)}>
            {job.title}
          </span>
          <span className="col-start-3 text-[11px] text-muted-foreground">
            {(job.worktree ? job.worktree + ' · ' : '') + job.source + ' · ' + clock(job.startedAt)}
          </span>
        </button>
        <Button size="icon-xs" variant="ghost" aria-label="Remove from the history" title={tip('Remove from the history')} disabled={job.status === 'running'} onClick={() => removeJob(job.id)}>
          <X />
        </Button>
      </div>
      {open && <Output text={job.text} />}
    </li>
  )
}

/** Opens the Output overlay: spinning while a command runs, red after one failed. In the page's corner unless a toolbar holds it. */
export const OutputButton = ({ corner = false }: { corner?: boolean }) => {
  const tip = useTip()
  const { jobs, outputOpen, setOutputOpen } = useControls()
  const running = jobs.some((job) => job.status === 'running')
  const failed = jobs.find((job) => job.status !== 'running')?.status === 'failed'
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label="Command output"
      title={tip('The output of the last ' + jobs.length + ' commands run from this page')}
      onClick={() => setOutputOpen(!outputOpen)}
      className={cn(corner ? 'fixed right-4 bottom-4 z-40 rounded-full shadow-md' : 'h-7 text-xs', failed && !running && 'border-red-500 text-red-700 dark:text-red-400')}
    >
      {running ? <LoaderCircle className="animate-spin" /> : <SquareTerminal />}
      Output{jobs.length ? ' (' + jobs.length + ')' : ''}
    </Button>
  )
}

/**
 * The output of the last commands this page ran, in an overlay, newest first, each with the worktree and
 * page it came from; `corner` puts its OutputButton in the page's corner.
 */
export const JobsOverlay = ({ corner }: { corner: boolean }) => {
  const tip = useTip()
  const { jobs, clearJobs, outputOpen, setOutputOpen } = useControls()
  // Entries you've opened or closed; the rest show expanded only when newest.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const isOpen = (job: Job) => toggled[job.id] ?? job.id === jobs[0]?.id
  useEffect(() => {
    if (!outputOpen) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOutputOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [outputOpen])
  const toggle = (job: Job) => setToggled((current) => ({ ...current, [job.id]: !isOpen(job) }))

  return (
    <>
      {corner && <OutputButton corner />}
      {outputOpen && (
        <section aria-label="Command output" className={cn('fixed top-4 right-4 z-50 grid w-[min(640px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] rounded-xl border bg-background shadow-2xl', corner ? 'bottom-16' : 'bottom-4')}>
          <header className="flex items-center gap-2 border-b px-4 py-2">
            <h2 className="flex-1 text-sm font-semibold">Output · last {jobs.length} commands</h2>
            <Button size="xs" variant="ghost" disabled={!jobs.some((job) => job.status !== 'running')} onClick={clearJobs}>
              Clear
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Close" title={tip('Close (Esc)')} onClick={() => setOutputOpen(false)}>
              <X />
            </Button>
          </header>
          <ol className="overflow-y-auto px-4">
            {jobs.map((job) => (
              <JobEntry key={job.id} job={job} open={isOpen(job)} onToggle={() => toggle(job)} />
            ))}
            {!jobs.length && <li className="py-4 text-sm text-muted-foreground">Nothing run from this page yet.</li>}
          </ol>
        </section>
      )}
    </>
  )
}
