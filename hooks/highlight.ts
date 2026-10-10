import type { ColoredSpan } from '../types'
import { extensionOf } from './git'
import { createHighlighter } from './vendor/shiki.js'
import type { Highlighter, ShikiLanguage, ShikiTheme } from './vendor/shiki.js'

/**
 * The files Claude Code's highlighter has no grammar for, which the pane colors with its own copy of Shiki:
 * the same grammars as VS Code, so a Vue template's attributes, directives and expressions are colored too.
 */
const LANGUAGES: Record<string, ShikiLanguage> = { vue: 'vue', svelte: 'svelte' }

/** Monokai is the palette Claude Code's own dark syntax colors come from. */
const themeFor = (theme: string): ShikiTheme => (theme.startsWith('light') ? 'github-light' : 'monokai')

/** Larger files keep Claude Code's highlighting: a grammar takes a while over them. */
const MAX_CHARS = 400_000

export const shikiLanguageOf = (path: string): ShikiLanguage | null => LANGUAGES[extensionOf(path)] ?? null

/** Made on first use, as the grammars compile then (about half a second). */
let highlighter: Highlighter | null = null

/** The last two texts colored: the pane redraws the open file every few seconds, and a diff colors both its sides. */
const cache = new Map<string, ColoredSpan[][]>()
const CACHED = 2

/**
 * Each line of `text` as runs of one color; the theme's own foreground is left as the terminal's text color. Null
 * when the file is too large or the grammar fails on it.
 */
export const colorLines = (text: string, language: ShikiLanguage, theme: string): ColoredSpan[][] | null => {
  if (text.length > MAX_CHARS) return null
  const shikiTheme = themeFor(theme)
  const key = `${language}\0${shikiTheme}\0${text}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let lines: ColoredSpan[][]
  try {
    highlighter ??= createHighlighter()
    const fg = highlighter.getTheme(shikiTheme).fg.toLowerCase()
    lines = highlighter.codeToTokensBase(text.replace(/\n$/, ''), { lang: language, theme: shikiTheme }).map(tokens => {
      const spans: ColoredSpan[] = []
      for (const token of tokens) {
        const color = token.color === undefined || token.color.toLowerCase() === fg ? null : token.color.toLowerCase()
        const last = spans.at(-1)
        if (last !== undefined && last[1] === color) last[0] += token.content
        else spans.push([token.content, color])
      }

      return spans
    })
  } catch {
    return null
  }
  cache.set(key, lines)
  if (cache.size > CACHED) cache.delete(cache.keys().next().value ?? '')

  return lines
}

/** A page of the file colored: lines `start` to `end`. */
export const colorPage = (text: string, language: ShikiLanguage, theme: string, start: number, end: number): ColoredSpan[][] | undefined =>
  colorLines(text, language, theme)?.slice(start, end)

/**
 * A diff's lines colored: a removed line as the old file colors it, a kept or added one as the new file does, so a
 * line keeps what its file had open around it (a tag over several lines, a template string). Null for a hunk's
 * header and git's no-newline note; the colors leave out the line's sign.
 */
export const colorDiff = (diff: string, language: ShikiLanguage, theme: string, before: string | null, after: string | null): (ColoredSpan[] | null)[] | undefined => {
  const older = before === null ? null : colorLines(before, language, theme)
  const newer = after === null ? null : colorLines(after, language, theme)
  if (older === null && newer === null) return undefined
  const lines: (ColoredSpan[] | null)[] = []
  let oldLine = 1
  let newLine = 1
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
    const plain: ColoredSpan[] = [[line.slice(1), null]]
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      lines.push(null)
    } else if (line.startsWith('\\')) {
      lines.push(null)
    } else if (line.startsWith('-')) {
      lines.push(older?.[oldLine - 1] ?? plain)
      oldLine += 1
    } else {
      lines.push(newer?.[newLine - 1] ?? plain)
      if (!line.startsWith('+')) oldLine += 1
      newLine += 1
    }
  }

  return lines
}
