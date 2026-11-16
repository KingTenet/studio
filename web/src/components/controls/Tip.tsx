import type { ReactElement } from 'react'
import { useControls } from '@/components/controls/ControlsProvider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Whether tooltips show: the index's tooltip switch, shared by every page through the studio server. */
const useTooltipsOn = () => useControls().state?.prefs?.tooltips !== false

/** For a plain `title` attribute: the text while tooltips are on, else nothing. */
export const useTip = () => {
  const on = useTooltipsOn()
  return (text: string | null | undefined) => (on && text ? text : undefined)
}

type TipProps = {
  /** The tooltip text; line breaks are kept. Without one, or with tooltips switched off, the child renders alone. */
  title?: string | null
  children: ReactElement
}

// The trigger is a span, since a disabled button never fires the pointer events a tooltip opens on.
export const Tip = ({ title, children }: TipProps) =>
  useTooltipsOn() && title ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-line">{title}</TooltipContent>
    </Tooltip>
  ) : (
    children
  )
