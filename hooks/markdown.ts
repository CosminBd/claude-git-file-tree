/**
 * The parts of markdown the pane draws itself: headings (the engine's are bold body text),
 * tables (the engine sizes them to the terminal, not the pane) and code fences.
 * Everything else goes to the engine's `Markdown` as prose.
 */

export type Span = {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  link?: boolean
  /** Table rules and the dim labels of the stacked layout. */
  dim?: boolean
}

type Style = Omit<Span, 'text'>

export type Align = 'left' | 'center' | 'right'

export type Block =
  | { kind: 'heading'; level: number; spans: Span[]; start: number; end: number }
  | { kind: 'table'; align: Align[]; header: Span[][]; rows: Span[][][]; start: number; end: number }
  | { kind: 'code'; language: string; source: string; start: number; end: number }
  | { kind: 'prose'; text: string; start: number; end: number }

/** One drawn row of a table: styled pieces that add up to the width it was laid out for. */
export type Line = Span[]

// Inline ----------------------------------------------------------------------------------

const PUNCTUATION = /[!-/:-@[-`{-~]/
const WORD = /[\p{L}\p{N}]/u

const pushSpan = (out: Span[], span: Span): void => {
  if (span.text === '') return
  const last = out[out.length - 1]
  if (last !== undefined && sameStyle(last, span)) last.text += span.text
  else out.push({ ...span })
}

const styleKeys = ['bold', 'italic', 'strike', 'code', 'link', 'dim'] as const

const sameStyle = (a: Style, b: Style): boolean => styleKeys.every(key => Boolean(a[key]) === Boolean(b[key]))

/** Where the `]` closing the `[` at `open` is, brackets nesting; -1 when none. */
const closingBracket = (src: string, open: number): number => {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '\\') {
      i += 1
      continue
    }
    if (src[i] === '[') depth += 1
    if (src[i] === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

/** Bold, italic, strikethrough, code and links, as styled spans; the markers dropped. */
export const parseInline = (src: string, style: Style = {}): Span[] => {
  const out: Span[] = []
  let buffer = ''
  const flush = () => {
    pushSpan(out, { text: buffer, ...style })
    buffer = ''
  }
  const nest = (inner: string, extra: Style) => {
    flush()
    for (const span of parseInline(inner, { ...style, ...extra })) pushSpan(out, span)
  }
  let i = 0

  while (i < src.length) {
    const char = src[i] ?? ''
    const nextChar = src[i + 1] ?? ''

    if (char === '\\' && PUNCTUATION.test(nextChar)) {
      buffer += nextChar
      i += 2
      continue
    }

    if (char === '`') {
      let ticks = 1
      while (src[i + ticks] === '`') ticks += 1
      const fence = '`'.repeat(ticks)
      const end = src.indexOf(fence, i + ticks)
      if (end > i) {
        flush()
        const inner = src.slice(i + ticks, end)
        pushSpan(out, { text: /^ .* $/.test(inner) ? inner.slice(1, -1) : inner, ...style, code: true })
        i = end + ticks
      } else {
        buffer += fence
        i += ticks
      }
      continue
    }

    const pair = src.slice(i, i + 2)
    if ((pair === '**' || pair === '__' || pair === '~~') && src[i + 2] !== undefined && src[i + 2] !== ' ') {
      let end = src.indexOf(pair, i + 2)
      // `***both***`: the bold closes on the last two stars.
      while (end > 0 && src[end + 2] === pair[0]) end += 1
      const isWordUnderscore = pair === '__' && (WORD.test(src[i - 1] ?? '') || WORD.test(src[end + 2] ?? ''))
      if (end > i + 2 && !isWordUnderscore) {
        nest(src.slice(i + 2, end), pair === '~~' ? { strike: true } : { bold: true })
        i = end + 2
        continue
      }
    }

    if ((char === '*' || char === '_') && nextChar !== '' && nextChar !== ' ' && nextChar !== char) {
      const opensMidWord = char === '_' && WORD.test(src[i - 1] ?? '')
      // The closing mark: not half of a `**` inside, not after a space.
      let end = src.indexOf(char, i + 1)
      while (end > 0 && (src[end + 1] === char || src[end - 1] === ' ')) {
        end = src.indexOf(char, src[end + 1] === char ? end + 2 : end + 1)
      }
      const closesMidWord = char === '_' && end > 0 && WORD.test(src[end + 1] ?? '')
      if (end > i + 1 && src[end - 1] !== ' ' && !opensMidWord && !closesMidWord) {
        nest(src.slice(i + 1, end), { italic: true })
        i = end + 1
        continue
      }
    }

    const isImage = char === '!' && nextChar === '['
    if (char === '[' || isImage) {
      const open = isImage ? i + 1 : i
      const close = closingBracket(src, open)
      if (close > open && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2)
        if (end > close) {
          const label = src.slice(open + 1, close)
          nest(label === '' ? src.slice(close + 2, end) : label, { link: true })
          i = end + 1
          continue
        }
      }
    }

    if (char === '<') {
      const end = src.indexOf('>', i + 1)
      const inner = end > i ? src.slice(i + 1, end) : ''
      if (/^(https?:|mailto:|file:)\S+$/.test(inner)) {
        flush()
        pushSpan(out, { text: inner, ...style, link: true })
        i = end + 1
        continue
      }
    }

    buffer += char
    i += 1
  }
  flush()

  return out
}

// Width -----------------------------------------------------------------------------------

const isZeroWidth = (cp: number): boolean =>
  (cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || cp === 0x200c || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

const charWidth = (char: string): number => {
  const cp = char.codePointAt(0) ?? 0

  return isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1
}

/** Columns `text` takes in a terminal. */
export const displayWidth = (text: string): number => {
  let width = 0
  for (const char of text) width += charWidth(char)

  return width
}

const spansWidth = (spans: readonly Span[]): number => spans.reduce((sum, span) => sum + displayWidth(span.text), 0)

const spansText = (spans: readonly Span[]): string => spans.map(span => span.text).join('')

// Wrapping --------------------------------------------------------------------------------

type Piece = { text: string; style: Style; isSpace: boolean }

const styleOf = (span: Span): Style => {
  const { text: _text, ...style } = span

  return style
}

/** Splits spans into words and runs of spaces, each keeping its span's style. */
const pieces = (spans: readonly Span[]): Piece[] =>
  spans.flatMap(span =>
    (span.text.match(/\s+|\S+/g) ?? []).map(text => ({ text: /^\s/.test(text) ? ' ' : text, style: styleOf(span), isSpace: /^\s/.test(text) })),
  )

/** Cuts `text` into chunks of at most `width` columns. */
const hardBreak = (text: string, width: number): string[] => {
  const chunks: string[] = []
  let chunk = ''
  let used = 0
  for (const char of text) {
    const w = charWidth(char)
    if (used + w > width && chunk !== '') {
      chunks.push(chunk)
      chunk = ''
      used = 0
    }
    chunk += char
    used += w
  }
  if (chunk !== '') chunks.push(chunk)

  return chunks
}

/** Wraps styled spans to lines of at most `width` columns, breaking words only when they cannot fit. */
export const wrapSpans = (spans: readonly Span[], width: number): Line[] => {
  const lines: Line[] = []
  let line: Line = []
  let used = 0
  const breakLine = () => {
    lines.push(line)
    line = []
    used = 0
  }

  for (const piece of pieces(spans)) {
    if (piece.isSpace) {
      if (used > 0 && used < width) {
        pushSpan(line, { text: ' ', ...piece.style })
        used += 1
      }
      continue
    }
    const w = displayWidth(piece.text)
    if (used + w > width && used > 0) {
      // Drop the space the line ended on.
      const last = line[line.length - 1]
      if (last !== undefined && last.text.endsWith(' ')) {
        last.text = last.text.slice(0, -1)
        if (last.text === '') line.pop()
      }
      breakLine()
    }
    if (w <= width) {
      pushSpan(line, { text: piece.text, ...piece.style })
      used += w
      continue
    }
    const chunks = hardBreak(piece.text, width)
    chunks.forEach((chunk, index) => {
      pushSpan(line, { text: chunk, ...piece.style })
      used += displayWidth(chunk)
      if (index < chunks.length - 1) breakLine()
    })
  }
  if (line.length > 0 || lines.length === 0) lines.push(line)

  return lines.map(l => {
    const last = l[l.length - 1]
    if (last !== undefined && last.text.endsWith(' ')) last.text = last.text.replace(/ +$/, '')

    return l.filter(span => span.text !== '')
  })
}

// Blocks ----------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const LIST_OR_QUOTE = /^\s*([-*+]|\d+[.)]|>)(\s|$)/

/** A table row's cells: pipes split them, except escaped ones and ones inside code. */
export const splitRow = (line: string): string[] => {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (char === '\\' && text[i + 1] === '|') {
      cell += '|'
      i += 1
      continue
    }
    if (char === '`') inCode = !inCode
    if (char === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())

  return cells
}

const alignOf = (cell: string): Align => {
  const text = cell.trim()
  if (text.startsWith(':') && text.endsWith(':')) return 'center'
  if (text.endsWith(':')) return 'right'

  return 'left'
}

const isTableStart = (lines: readonly string[], at: number): boolean => {
  const head = lines[at] ?? ''
  const rule = lines[at + 1] ?? ''
  if (!head.includes('|') || !DELIMITER.test(rule) || !rule.includes('-')) return false

  return splitRow(head).length === splitRow(rule).length
}

/** The document as blocks, each knowing its lines `[start, end)`. */
export const parseBlocks = (text: string): Block[] => {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let prose: string[] = []
  let proseStart = 0

  const flushProse = (end: number) => {
    let first = 0
    let last = prose.length
    while (first < last && (prose[first] ?? '').trim() === '') first += 1
    while (last > first && (prose[last - 1] ?? '').trim() === '') last -= 1
    if (first < last) blocks.push({ kind: 'prose', text: prose.slice(first, last).join('\n'), start: proseStart, end })
    prose = []
  }
  const addProse = (line: string, at: number) => {
    if (prose.length === 0) proseStart = at
    prose.push(line)
  }

  let i = 0
  // Front matter reads as YAML.
  if (lines[0] === '---') {
    const close = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'))
    if (close > 0) {
      blocks.push({ kind: 'code', language: 'yaml', source: lines.slice(1, close).join('\n'), start: 0, end: close + 1 })
      i = close + 1
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      let end = i + 1
      while (end < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[end] ?? '')) end += 1
      flushProse(i)
      blocks.push({ kind: 'code', language: fence[2] ?? '', source: lines.slice(i + 1, end).join('\n'), start: i, end: Math.min(end + 1, lines.length) })
      i = end + 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushProse(i)
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, spans: parseInline((heading[2] ?? '').trim()), start: i, end: i + 1 })
      i += 1
      continue
    }

    // Setext: a lone line of text over === or ---.
    const previous = prose[prose.length - 1]
    const beforePrevious = prose.length > 1 ? prose[prose.length - 2] : ''
    const isLoneText =
      previous !== undefined && previous.trim() !== '' && (beforePrevious ?? '').trim() === '' && !LIST_OR_QUOTE.test(previous) && !previous.includes('|')
    if (isLoneText && (/^ {0,3}=+\s*$/.test(line) || /^ {0,3}-{2,}\s*$/.test(line))) {
      prose.pop()
      flushProse(i - 1)
      blocks.push({ kind: 'heading', level: line.trim().startsWith('=') ? 1 : 2, spans: parseInline(previous.trim()), start: i - 1, end: i + 1 })
      i += 1
      continue
    }

    if (isTableStart(lines, i)) {
      flushProse(i)
      const header = splitRow(line)
      const align = splitRow(lines[i + 1] ?? '').map(alignOf)
      const rows: Span[][][] = []
      let end = i + 2
      while (end < lines.length) {
        const row = lines[end] ?? ''
        if (row.trim() === '' || FENCE.test(row) || HEADING.test(row)) break
        const cells = splitRow(row)
        rows.push(header.map((_, column) => parseInline(cells[column] ?? '')))
        end += 1
      }
      blocks.push({ kind: 'table', align, header: header.map(cell => parseInline(cell)), rows, start: i, end })
      i = end
      continue
    }

    addProse(line, i)
    i += 1
  }
  flushProse(lines.length)

  return blocks
}

/**
 * Pages a markdown file on block boundaries, so no page starts inside a table or a fence:
 * `[start, end)` line ranges of at most `budget` characters, a block larger than that cut by lines.
 */
export const blockPageRanges = (lines: readonly string[], budget: number): Array<[number, number]> => {
  const blocks = parseBlocks(lines.join('\n'))
  const ranges: Array<[number, number]> = []
  let start = 0
  let size = 0
  const costOf = (from: number, to: number) => lines.slice(from, to).reduce((sum, line) => sum + line.length + 1, 0)

  // Blank lines between blocks belong to the block after them.
  const edges = blocks.map((block, index) => (index === 0 ? 0 : block.start)).concat(lines.length)
  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index] ?? 0
    const to = edges[index + 1] ?? lines.length
    const cost = costOf(from, to)
    if (size > 0 && size + cost > budget) {
      ranges.push([start, from])
      start = from
      size = 0
    }
    if (cost > budget) {
      // One block too large for a page: cut it by lines.
      let at = from
      let used = 0
      for (let line = from; line < to; line += 1) {
        const lineCost = (lines[line] ?? '').length + 1
        if (line > at && used + lineCost > budget) {
          ranges.push([start, line])
          start = line
          at = line
          used = 0
        }
        used += lineCost
      }
      size = used
      continue
    }
    size += cost
  }
  if (start < lines.length || ranges.length === 0) ranges.push([start, lines.length])

  return ranges
}

// Tables ----------------------------------------------------------------------------------

const BORDER = { top: ['┌', '┬', '┐'], middle: ['├', '┼', '┤'], bottom: ['└', '┴', '┘'] } as const

const rule = (widths: readonly number[], [left, cross, right]: readonly [string, string, string]): Line => [
  { text: left + widths.map(w => '─'.repeat(w + 2)).join(cross) + right, dim: true },
]

const pad = (line: Line, width: number, align: Align): Line => {
  const gap = Math.max(0, width - spansWidth(line))
  const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0
  const after = gap - before
  const out: Line = []
  if (before > 0) out.push({ text: ' '.repeat(before) })
  for (const span of line) pushSpan(out, span)
  if (after > 0) pushSpan(out, { text: ' '.repeat(after) })

  return out
}

/** One table row as drawn lines, each cell wrapped to its column. */
const gridRow = (cells: readonly Span[][], widths: readonly number[], align: readonly Align[], isHeader: boolean): Line[] => {
  const wrapped = widths.map((width, column) => {
    const spans = (cells[column] ?? []).map(span => (isHeader ? { ...span, bold: true } : span))

    return wrapSpans(spans, width)
  })
  const height = Math.max(1, ...wrapped.map(cell => cell.length))
  const lines: Line[] = []
  for (let row = 0; row < height; row += 1) {
    const line: Line = [{ text: '│', dim: true }]
    widths.forEach((width, column) => {
      line.push({ text: ' ' })
      for (const span of pad(wrapped[column]?.[row] ?? [], width, align[column] ?? 'left')) line.push(span)
      line.push({ text: ' ' }, { text: '│', dim: true })
    })
    lines.push(line)
  }

  return lines
}

/** How wide each column is drawn in `width` columns, or null when even the narrowest layout overflows. */
export const columnWidths = (header: readonly Span[][], rows: readonly Span[][][], width: number): number[] | null => {
  const columns = header.length
  const all = [header, ...rows]
  const natural = header.map((_, column) => Math.max(1, ...all.map(row => spansWidth(row[column] ?? []))))
  const room = width - (3 * columns + 1)
  if (natural.reduce((a, b) => a + b, 0) <= room) return natural

  // The narrowest a column goes: its longest word whole when they all fit, else cut at a cap;
  // a grid that would chop short words reads worse than cards.
  const longestWord = header.map((_, column) =>
    Math.max(1, ...all.flatMap(row => spansText(row[column] ?? []).split(/\s+/).map(displayWidth))),
  )
  const leastFor = (cap: number) => natural.map((n, column) => Math.min(n, Math.max(3, Math.min(cap, longestWord[column] ?? 1))))
  const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0)
  const least = [Infinity, 30, 20].map(leastFor).find(list => sum(list) <= room)
  if (least === undefined) return null
  const leastSum = sum(least)

  // Share what is left by how much more each column wants.
  const want = natural.map((n, column) => n - (least[column] ?? 0))
  const wantSum = want.reduce((a, b) => a + b, 0)
  const spare = room - leastSum
  const widths = least.map((l, column) => l + Math.floor(((want[column] ?? 0) * spare) / Math.max(1, wantSum)))
  let left = room - widths.reduce((a, b) => a + b, 0)
  while (left > 0) {
    let best = -1
    widths.forEach((w, column) => {
      if (w < (natural[column] ?? 0) && (best < 0 || (natural[column] ?? 0) - w > (natural[best] ?? 0) - (widths[best] ?? 0))) best = column
    })
    if (best < 0) break
    widths[best] = (widths[best] ?? 0) + 1
    left -= 1
  }

  return widths
}

/** A table that cannot fit as a grid: each row a card of `Header  value` lines. */
const cards = (header: readonly Span[][], rows: readonly Span[][][], width: number): Line[] => {
  const labelWidth = Math.min(Math.max(...header.map(spansWidth), 1), Math.floor(width / 3))
  const lines: Line[] = []
  rows.forEach((row, index) => {
    if (index > 0) lines.push([{ text: '─'.repeat(width), dim: true }])
    header.forEach((label, column) => {
      const labelLines = wrapSpans(label.map(span => ({ ...span, bold: true, dim: true })), labelWidth)
      const valueLines = wrapSpans(row[column] ?? [], Math.max(1, width - labelWidth - 2))
      const height = Math.max(labelLines.length, valueLines.length)
      for (let at = 0; at < height; at += 1) {
        const line = pad(labelLines[at] ?? [], labelWidth, 'left')
        line.push({ text: '  ' })
        for (const span of valueLines[at] ?? []) line.push(span)
        lines.push(line.filter(span => span.text !== ''))
      }
    })
  })

  return lines
}

/** A table laid out in `width` columns: a grid when it fits, else stacked cards. */
export const layoutTable = (table: Extract<Block, { kind: 'table' }>, width: number): Line[] => {
  const widths = columnWidths(table.header, table.rows, width)
  if (widths === null) return cards(table.header, table.rows, width)

  const headerLines = gridRow(table.header, widths, table.header.map((_, column) => (table.align[column] === 'right' ? 'right' : 'center')), true)
  const bodies = table.rows.map(row => gridRow(row, widths, table.align, false))
  // Rules between rows only where some row wraps: one-line rows read fine without.
  const isWrapped = bodies.some(lines => lines.length > 1)
  const lines: Line[] = [rule(widths, BORDER.top), ...headerLines, rule(widths, BORDER.middle)]
  bodies.forEach((body, index) => {
    if (index > 0 && isWrapped) lines.push(rule(widths, BORDER.middle))
    lines.push(...body)
  })
  lines.push(rule(widths, BORDER.bottom))

  return lines
}
