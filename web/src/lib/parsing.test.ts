import { describe, expect, it } from 'vitest'
import { parseAnsi } from './ansi'
import { ago } from './format'
import { parseInline, parseMarkdown } from './markdown'

describe('parseAnsi', () => {
  it('splits text into styled runs and resets', () => {
    expect(parseAnsi('\x1b[1;31mred\x1b[0m plain')).toEqual([
      { text: 'red', style: { bold: true, fg: '#e06c75' } },
      { text: ' plain', style: {} },
    ])
  })

  it('reads 256-colour and truecolour codes', () => {
    expect(parseAnsi('\x1b[38;5;196ma\x1b[48;2;1;2;3mb')).toEqual([
      { text: 'a', style: { fg: 'rgb(255,0,0)' } },
      { text: 'b', style: { fg: 'rgb(255,0,0)', bg: 'rgb(1,2,3)' } },
    ])
  })

  it('drops cursor and OSC escapes', () => {
    expect(parseAnsi('\x1b[2Ka\x1b]0;title\x07b')).toEqual([
      { text: 'a', style: {} },
      { text: 'b', style: {} },
    ])
  })
})

describe('parseMarkdown', () => {
  it('separates fenced code from paragraphs with inline code and bold', () => {
    expect(parseMarkdown('Run **this**:\n```sh\npnpm test\n```\nthen `done`.')).toEqual([
      { kind: 'para', parts: [{ kind: 'text', text: 'Run ' }, { kind: 'bold', text: 'this' }, { kind: 'text', text: ':' }] },
      { kind: 'code', text: 'pnpm test' },
      { kind: 'para', parts: [{ kind: 'text', text: 'then ' }, { kind: 'code', text: 'done' }, { kind: 'text', text: '.' }] },
    ])
  })
})

describe('parseMarkdown lists', () => {
  it('reads runs of - and 1. lines as lists, between paragraphs', () => {
    expect(parseMarkdown('Adds a **dark mode**.\n\n- A switch in the header.\n- Remembered next time.\n\n1. One\n2. Two\nThat is all.')).toEqual([
      { kind: 'para', parts: [{ kind: 'text', text: 'Adds a ' }, { kind: 'bold', text: 'dark mode' }, { kind: 'text', text: '.' }] },
      { kind: 'list', ordered: false, items: [[{ kind: 'text', text: 'A switch in the header.' }], [{ kind: 'text', text: 'Remembered next time.' }]] },
      { kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'One' }], [{ kind: 'text', text: 'Two' }]] },
      { kind: 'para', parts: [{ kind: 'text', text: 'That is all.' }] },
    ])
  })
})

describe('parseMarkdown tables', () => {
  it('reads a table between paragraphs, with inline markdown in its cells', () => {
    expect(parseMarkdown('They stand like this:\n\n| # | Item |\n|---|---|\n| 1 | Renamed (`abc123`) |\n| 2 | **Done** |\n\nThat is all.')).toEqual([
      { kind: 'para', parts: [{ kind: 'text', text: 'They stand like this:' }] },
      {
        kind: 'table',
        head: [[{ kind: 'text', text: '#' }], [{ kind: 'text', text: 'Item' }]],
        rows: [
          [[{ kind: 'text', text: '1' }], [{ kind: 'text', text: 'Renamed (' }, { kind: 'code', text: 'abc123' }, { kind: 'text', text: ')' }]],
          [[{ kind: 'text', text: '2' }], [{ kind: 'bold', text: 'Done' }]],
        ],
      },
      { kind: 'para', parts: [{ kind: 'text', text: 'That is all.' }] },
    ])
  })

  it('leaves pipes without a rule line under them as text', () => {
    expect(parseMarkdown('| not | a table |')).toEqual([{ kind: 'para', parts: [{ kind: 'text', text: '| not | a table |' }] }])
  })

  it('leaves a table inside a code fence as code', () => {
    expect(parseMarkdown('```\n| a |\n|---|\n```')).toEqual([{ kind: 'code', text: '| a |\n|---|' }])
  })
})

describe('parseInline links', () => {
  it('turns bare URLs into links, leaving sentence punctuation after them as text', () => {
    expect(parseInline('see https://example.com/a/b. Then')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/a/b', href: 'https://example.com/a/b' },
      { kind: 'text', text: '.' },
      { kind: 'text', text: ' Then' },
    ])
  })

  it('reads markdown links and inline code that is only a URL', () => {
    expect(parseInline('[the page](https://example.com/x) and `https://example.com/y`')).toEqual([
      { kind: 'link', text: 'the page', href: 'https://example.com/x' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'https://example.com/y', href: 'https://example.com/y', code: true },
    ])
  })

  it('leaves code that merely mentions a URL as code', () => {
    expect(parseInline('`curl https://example.com`')).toEqual([{ kind: 'code', text: 'curl https://example.com' }])
  })
})

describe('format', () => {
  it('says how long ago', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')
    expect(['2026-01-01T12:00:00Z', '2026-01-01T11:30:00Z', '2026-01-01T09:00:00Z', '2025-12-29T12:00:00Z'].map((iso) => ago(iso, now))).toEqual(['just now', '30 min ago', '3 h ago', '3 d ago'])
  })
})
