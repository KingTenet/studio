export type Inline = { kind: 'text' | 'code' | 'bold'; text: string } | { kind: 'link'; text: string; href: string; code?: boolean }

export type Block = { kind: 'code'; text: string } | { kind: 'para'; parts: Inline[] } | { kind: 'table'; head: Inline[][]; rows: Inline[][][] } | { kind: 'list'; ordered: boolean; items: Inline[][] }

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"'`]+)/
const MARKDOWN_LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/
const URL_ONLY = /^https?:\/\/\S+$/
// Sentence punctuation after a bare URL ("see https://…/x.") isn't part of it.
const TRAILING = /[.,;:!?)\]]+$/

const inlinePart = (part: string): Inline[] => {
  if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
    const code = part.slice(1, -1)
    return [URL_ONLY.test(code) ? { kind: 'link', text: code, href: code, code: true } : { kind: 'code', text: code }]
  }
  if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return [{ kind: 'bold', text: part.slice(2, -2) }]
  const markdown = MARKDOWN_LINK.exec(part)
  if (markdown) return [{ kind: 'link', text: markdown[1], href: markdown[2] }]
  if (/^https?:\/\//.test(part)) {
    const tail = TRAILING.exec(part)?.[0] ?? ''
    const href = part.slice(0, part.length - tail.length)
    return [{ kind: 'link', text: href, href }, ...(tail ? [{ kind: 'text' as const, text: tail }] : [])]
  }
  return [{ kind: 'text', text: part }]
}

export const parseInline = (text: string): Inline[] => text.split(INLINE).filter(Boolean).flatMap(inlinePart)

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/

const cells = (line: string) => line.trim().slice(1, -1).split('|').map((cell) => parseInline(cell.trim()))

const LIST_ITEM = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/

const plainPara = (text: string): Block[] => {
  const parts = parseInline(text.replace(/^\n+|\n+$/g, ''))
  return parts.length ? [{ kind: 'para', parts }] : []
}

// Text, with its runs of `- item` or `1. item` lines as lists.
const para = (text: string): Block[] => {
  const blocks: Block[] = []
  let plain: string[] = []
  let list: { ordered: boolean; items: Inline[][] } | null = null
  const flush = () => {
    if (plain.length) blocks.push(...plainPara(plain.join('\n')))
    plain = []
    if (list) blocks.push({ kind: 'list', ...list })
    list = null
  }
  for (const line of text.split('\n')) {
    const item = LIST_ITEM.exec(line)
    if (item) {
      const ordered = Boolean(item[2])
      if (plain.length || (list && list.ordered !== ordered)) flush()
      list ??= { ordered, items: [] }
      list.items.push(parseInline(item[3]))
    } else if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped item's next line.
      list.items[list.items.length - 1].push({ kind: 'text', text: ' ' }, ...parseInline(line.trim()))
    } else {
      if (list) flush()
      plain.push(line)
    }
  }
  flush()
  return blocks
}

// A table is a header row, a |---| rule, then the rows that follow it.
const paraAndTables = (text: string): Block[] => {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let start = 0
  for (let i = 0; i < lines.length - 1; i++) {
    if (!TABLE_ROW.test(lines[i]) || !TABLE_RULE.test(lines[i + 1])) continue
    let end = i + 2
    while (end < lines.length && TABLE_ROW.test(lines[end])) end++
    blocks.push(...para(lines.slice(start, i).join('\n')), { kind: 'table', head: cells(lines[i]), rows: lines.slice(i + 2, end).map(cells) })
    start = end
    i = end - 1
  }
  return [...blocks, ...para(lines.slice(start).join('\n'))]
}

/** The little markdown Claude's replies lean on: fenced code blocks, tables, lists, `inline code`, **bold** and links. */
export const parseMarkdown = (text: string): Block[] =>
  text
    .trim()
    .split(/```[^\n]*\n?/)
    .flatMap((part, i): Block[] => (i % 2 ? [{ kind: 'code', text: part.replace(/\n$/, '') }] : paraAndTables(part)))
