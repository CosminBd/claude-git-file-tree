import { describe, expect, test } from 'claude-code/testing'

import { blockPageRanges, columnWidths, displayWidth, layoutTable, parseBlocks, parseInline, splitRow, wrapSpans } from '../hooks/markdown'
import type { Block, Line } from '../hooks/markdown'

const text = (line: Line): string => line.map(span => span.text).join('')

describe('inline', () => {
  test('markers become styles', () => {
    expect(parseInline('a **b** *c* `d` ~~e~~ [f](https://x.y)')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', code: true },
      { text: ' ' },
      { text: 'e', strike: true },
      { text: ' ' },
      { text: 'f', link: true },
    ])
  })

  test('nesting, escapes and snake_case words', () => {
    expect(parseInline('***both***')).toEqual([{ text: 'both', bold: true, italic: true }])
    expect(parseInline('\\*not\\* snake_case_name')).toEqual([{ text: '*not* snake_case_name' }])
    expect(parseInline('**bold `code`**')).toEqual([{ text: 'bold ', bold: true }, { text: 'code', bold: true, code: true }])
  })
})

describe('blocks', () => {
  test('headings, tables, fences and prose, each with its lines', () => {
    const blocks = parseBlocks(['# One', '', 'text', '', '| a | b |', '|---|--:|', '| 1 | 2 |', '', '```php', '<?php', '```', 'Two', '---'].join('\n'))
    expect(blocks.map(b => [b.kind, b.start, b.end])).toEqual([
      ['heading', 0, 1],
      ['prose', 1, 4],
      ['table', 4, 7],
      ['code', 8, 11],
      ['heading', 11, 13],
    ])
    const table = blocks[2] as Extract<Block, { kind: 'table' }>
    expect(table.align).toEqual(['left', 'right'])
    expect(blocks[3]).toMatchObject({ language: 'php', source: '<?php' })
    expect(blocks[4]).toMatchObject({ level: 2, spans: [{ text: 'Two' }] })
  })

  test('a horizontal rule after a list item stays prose', () => {
    expect(parseBlocks('- item\n---').map(b => b.kind)).toEqual(['prose'])
  })

  test('pipes inside code and escaped pipes stay in their cell', () => {
    expect(splitRow('| `a|b` | c\\|d |')).toEqual(['`a|b`', 'c|d'])
  })

  test('front matter reads as yaml', () => {
    expect(parseBlocks('---\ntitle: x\n---\n# H')[0]).toMatchObject({ kind: 'code', language: 'yaml', source: 'title: x' })
  })

  test('pages never start inside a table or a fence', () => {
    const lines = ['intro', '', '| a |', '|---|', '| 1 |', '| 2 |', '', 'outro']
    const ranges = blockPageRanges(lines, 25)
    expect(ranges.length).toBeGreaterThan(1)
    for (const [start] of ranges) expect([3, 4, 5]).not.toContain(start)
  })
})

describe('tables', () => {
  const table = (rows: string[][]): Extract<Block, { kind: 'table' }> => {
    const [head = [], ...body] = rows

    return { kind: 'table', align: head.map(() => 'left'), header: head.map(c => parseInline(c)), rows: body.map(r => r.map(c => parseInline(c))), start: 0, end: 0 }
  }

  test('a table that fits keeps its natural widths, every line as wide as the grid', () => {
    const lines = layoutTable(table([['Name', 'Lines'], ['app.php', '12']]), 60)
    expect(lines.map(text)).toEqual([
      '┌─────────┬───────┐',
      '│  Name   │ Lines │',
      '├─────────┼───────┤',
      '│ app.php │ 12    │',
      '└─────────┴───────┘',
    ])
  })

  test('a wide table wraps its cells to the width, keeping words whole', () => {
    const long = 'a sentence long enough that it has to wrap inside its column'
    const lines = layoutTable(table([['File', 'Notes'], ['hooks/register.tsx', long]]), 40)
    for (const line of lines) expect(displayWidth(text(line))).toBe(40)
    expect(lines.some(line => text(line).includes('hooks/register.tsx'))).toBe(true)
  })

  test('a table too wide for a grid stacks into cards', () => {
    const header = ['File', 'What changed', 'Why it changed', 'Risk', 'Owner', 'Follow-up']
    const row = ['hooks/register.tsx', 'footer button moved', 'the band cost a row', 'low', 'Cosmin', 'check desktop']
    expect(columnWidths(header.map(c => parseInline(c)), [row.map(c => parseInline(c))], 40)).toBeNull()
    const lines = layoutTable(table([header, row]), 40).map(text)
    expect(lines[0]).toMatch(/^File +hooks\/register\.tsx$/)
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40)
  })

  test('wide characters count twice', () => {
    expect(displayWidth('日本')).toBe(4)
    expect(wrapSpans([{ text: 'one two three' }], 7).map(text)).toEqual(['one two', 'three'])
  })
})
