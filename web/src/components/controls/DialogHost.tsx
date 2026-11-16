import { useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** A confirm resolves to '' when accepted; a prompt to the trimmed text; a choice to the option picked; any to null when cancelled. */
export type DialogRequest = { kind: 'confirm' | 'prompt' | 'choose'; message: string; options?: string[]; resolve: (value: string | null) => void }

type DialogHostProps = {
  /** The open request, or null when no dialog is showing. */
  request: DialogRequest | null
  /** Called once the request has been answered either way. */
  onDone: () => void
}

/** The page's single confirm/prompt/choice dialog: a message's first line is its title, the rest its body. */
export const DialogHost = ({ request, onDone }: DialogHostProps) => {
  const [text, setText] = useState('')
  const [title, ...rest] = (request?.message ?? '').split('\n')
  const body = rest.join('\n').trim()
  const answer = (value: string | null) => {
    request?.resolve(value)
    setText('')
    onDone()
  }
  const accept = () => {
    if (request?.kind === 'prompt' && !text.trim()) return
    answer(request?.kind === 'prompt' ? text.trim() : '')
  }
  return (
    <AlertDialog open={Boolean(request)} onOpenChange={(open) => !open && answer(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {body && <AlertDialogDescription className="whitespace-pre-line">{body}</AlertDialogDescription>}
        </AlertDialogHeader>
        {request?.kind === 'prompt' && (
          <Input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                accept()
              }
            }}
          />
        )}
        {request?.kind === 'choose' && (
          <div className="grid gap-1.5">
            {request.options?.map((option) => (
              <Button key={option} variant="outline" className="justify-start font-mono" onClick={() => answer(option)}>
                {option}
              </Button>
            ))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {request?.kind !== 'choose' && (
            <AlertDialogAction disabled={request?.kind === 'prompt' && !text.trim()} onClick={accept}>
              {request?.kind === 'prompt' ? 'Create' : 'Continue'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
