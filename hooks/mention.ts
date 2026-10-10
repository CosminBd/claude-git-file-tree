import type { Preview } from '../types'

/**
 * What a selection in the open file comes to: its lines in the file as it is now, or, for a diff selection that
 * holds removed lines (which the file no longer has), the diff lines themselves. `text` is the lines, whole.
 */
export type Picked = { from: number; to: number; text: string } | { diff: string }

/** One line the pane shows: its text, and where it is in the file now (null for a removed line). */
type Shown = { text: string; line: number | null; sign: string }

/** The pane's own line numbers (the Vue and Svelte views draw them as text, so a selection takes them along). */
const GUTTER = /^\s*\d+ [+\- ]?/

/** Text with no whitespace: the terminal draws a tab as spaces, and breaks a long line where the pane is narrow. */
const bare = (text: string): string => text.replace(/\s+/g, '')

const shownLines = (preview: Preview): Shown[] => {
  if (preview.kind === 'code') {
    const first = preview.firstLine ?? 1

    return preview.text.split('\n').map((text, i) => ({ text, line: first + i, sign: ' ' }))
  }
  const shown: Shown[] = []
  let newLine = 1
  for (const line of preview.text.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
    if (header) {
      newLine = Number(header[1])
      continue
    }
    if (line.startsWith('\\') || line === '') continue
    const sign = line[0] ?? ' '
    shown.push({ text: line.slice(1), line: sign === '-' ? null : newLine, sign })
    if (sign !== '-') newLine += 1
  }

  return shown
}

/**
 * Finds the selected text among the lines the preview shows: in a source page or a diff page, the first place that
 * holds it. Lines compare without their whitespace, so a selection that starts or ends inside a line, or holds a long
 * line the pane wrapped over several rows, still finds its lines. Null when the page does not have it (a selection in
 * the conversation, or a stale one).
 */
export const pick = (preview: Preview, selected: string): Picked | null => {
  if (preview.kind !== 'code' && preview.kind !== 'diff') return null
  const shown = shownLines(preview)
  // Each character of the page, without whitespace, and the line it is on.
  let page = ''
  const lineOf: number[] = []
  shown.forEach((line, i) => {
    const text = bare(line.text)
    page += text
    for (let n = 0; n < text.length; n++) lineOf.push(i)
  })
  // `...` is the gap the pane draws between hunks.
  const parts = selected.split('\n').filter(part => part.trim() !== '...')
  // As selected, then without the numbers the pane's own views draw.
  for (const wanted of [bare(parts.join('')), bare(parts.map(part => part.replace(GUTTER, '')).join(''))]) {
    const at = wanted === '' ? -1 : page.indexOf(wanted)
    if (at < 0) continue
    const lines = shown.slice(lineOf[at] ?? 0, (lineOf[at + wanted.length - 1] ?? 0) + 1)
    if (lines.some(line => line.line === null)) return { diff: lines.map(line => `${line.sign}${line.text}`).join('\n') }
    const numbers = lines.map(line => line.line ?? 0)

    return { from: Math.min(...numbers), to: Math.max(...numbers), text: lines.map(line => line.text).join('\n') }
  }

  return null
}

/** How the prompt names a path: relative to where the session runs when inside it, quoted when it has a space. */
export const mentionOf = (absolute: string, cwd: string, range?: { from: number; to: number }): string => {
  const path = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute
  const fragment = range === undefined ? '' : range.from === range.to ? `#L${range.from}` : `#L${range.from}-${range.to}`
  const text = `${path}${fragment}`

  return /\s/.test(text) ? `@"${text}"` : `@${text}`
}
