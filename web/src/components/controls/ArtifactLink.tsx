import { createContext, useContext, type ReactNode } from 'react'
import { useTip } from '@/components/controls/Tip'
import { artifactIdOf, isPlainClick, localArtifactUrl } from '@/lib/artifacts'

/** Set by a page that can preview an artifact itself (the cockpit's Artifacts pane); null where it can't. */
export const ArtifactPreviewContext = createContext<((id: string) => void) | null>(null)

type SmartLinkProps = {
  href: string
  className?: string
  title?: string
  children: ReactNode
}

/**
 * A link that treats claude.ai artifact URLs the same way everywhere: it points at the artifact's
 * local URL, so a modified or middle click opens that in a tab, while a plain click previews it in
 * the page when the page can. Any other URL opens in a new tab.
 */
export const SmartLink = ({ href, className, title, children }: SmartLinkProps) => {
  const tip = useTip()
  const preview = useContext(ArtifactPreviewContext)
  const id = artifactIdOf(href)
  return (
    <a
      href={id ? localArtifactUrl(id) : href}
      target="_blank"
      rel="noopener"
      className={className}
      title={tip(title ?? (id ? (preview ? 'Preview here · ⌘/Ctrl-click opens it in a tab' : 'The local copy of this artifact') : href))}
      onClick={(event) => {
        if (!id || !preview || !isPlainClick(event)) return
        event.preventDefault()
        preview(id)
      }}
    >
      {children}
    </a>
  )
}
