export type AnsiStyle = { fg?: string | null; bg?: string | null; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean }

export type AnsiSegment = { text: string; style: AnsiStyle }

const BASIC = ['#1b1f24', '#e06c75', '#7fd19b', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d6dee6', '#7d8b99', '#ff7b86', '#a5e3b8', '#f0d58c', '#8cc4ff', '#d9a6ff', '#7fd4dd', '#ffffff']

const color256 = (n: number) => {
  if (n < 16) return BASIC[n]
  if (n >= 232) {
    const level = 8 + (n - 232) * 10
    return `rgb(${level},${level},${level})`
  }
  const cube = n - 16
  const step = (value: number) => (value ? 55 + value * 40 : 0)
  return `rgb(${step(Math.floor(cube / 36))},${step(Math.floor(cube / 6) % 6)},${step(cube % 6)})`
}

const ESCAPE = /(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/

/** A herdr `pane read --format ansi` screen as styled text runs; escapes other than SGR colours are dropped. */
export const parseAnsi = (text: string): AnsiSegment[] => {
  let style: AnsiStyle = {}
  const out: AnsiSegment[] = []
  for (const part of text.replace(/\r/g, '').split(ESCAPE)) {
    if (!part.startsWith('\x1b')) {
      if (part) out.push({ text: part, style: { ...style } })
      continue
    }
    if (!/^\x1b\[[0-9;]*m$/.test(part)) continue
    const codes = part.slice(2, -1).split(';').map((code) => Number(code || 0))
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 0) style = {}
      else if (code === 1) style.bold = true
      else if (code === 2) style.dim = true
      else if (code === 3) style.italic = true
      else if (code === 4) style.underline = true
      else if (code === 7) style.inverse = true
      else if (code === 22) style.bold = style.dim = false
      else if (code === 23) style.italic = false
      else if (code === 24) style.underline = false
      else if (code === 27) style.inverse = false
      else if (code >= 30 && code <= 37) style.fg = BASIC[code - 30]
      else if (code >= 90 && code <= 97) style.fg = BASIC[code - 82]
      else if (code === 39) style.fg = null
      else if (code >= 40 && code <= 47) style.bg = BASIC[code - 40]
      else if (code >= 100 && code <= 107) style.bg = BASIC[code - 92]
      else if (code === 49) style.bg = null
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'fg' : 'bg'
        if (codes[i + 1] === 5) {
          style[key] = color256(codes[i + 2])
          i += 2
        } else if (codes[i + 1] === 2) {
          style[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`
          i += 4
        }
      }
    }
  }
  return out
}
