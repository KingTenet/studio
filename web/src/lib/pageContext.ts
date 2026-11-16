import { useEffect } from 'react'

// What parts of the page show, sent with each message from its chat so "this" means something.
const parts = new Map<string, string>()

/** Adds `text` to what the page's chat tells Claude about the page while the caller is mounted (null: nothing). */
export const usePageContext = (part: string, text: string | null) => {
  useEffect(() => {
    if (text === null) return
    parts.set(part, text)
    return () => {
      parts.delete(part)
    }
  }, [part, text])
}

export const pageParts = () => [...parts.values()]
