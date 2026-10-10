import type { ChangedFile, CodeSection, Preview, PreviewMode, Snapshot } from '../types'
import { baseContent, contentAt, extensionOf, fileDiff, looksBinary } from './git'
import type { Git } from './git'
import { blockPageRanges } from './markdown'

/** Characters one page draws: a drawing holds 100,000, and the header needs a little. */
export const PAGE_CHARS = 60_000
const PAGE_LINES = 2_000
/** A rendered markdown page is smaller: table rules and padding add to what it draws. */
const MARKDOWN_PAGE_CHARS = 30_000
const MAX_FILE_BYTES = 3 * 1024 * 1024

export type PreviewDeps = {
  git: Git
  /** The file's size in bytes, or null when it is missing. */
  size: (absolutePath: string) => Promise<number | null>
  readText: (absolutePath: string) => Promise<string>
  /** A PNG's pixel size, or null when it is not one. */
  pngSize: (absolutePath: string) => Promise<{ width: number; height: number } | null>
}

export const isMarkdown = (path: string): boolean => ['md', 'markdown', 'mdx'].includes(extensionOf(path))

/** The highlighter has no grammar for these: each block draws in its own language instead. */
const COMPONENT_EXTENSIONS = new Set(['vue', 'svelte'])

/** A block's language by its `lang` attribute; '' is a block without one. */
const BLOCK_LANGUAGES: Record<string, Record<string, string>> = {
  script: { '': 'javascript', js: 'javascript', ts: 'typescript', jsx: 'jsx', tsx: 'tsx' },
  style: { '': 'css', postcss: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus' },
  template: { '': 'html' },
  i18n: { '': 'json', yml: 'yaml' },
}

/**
 * The blocks of a single-file component, each in its own language: a `<script lang="ts">` body as TypeScript, a
 * `<style lang="scss">` body as SCSS, the template and the block tags as HTML. Undefined for any other file. A block
 * opens and closes at the start of a line, as these files write them.
 */
export const sectionsOf = (path: string, lines: string[]): CodeSection[] | undefined => {
  if (!COMPONENT_EXTENSIONS.has(extensionOf(path))) return undefined
  const sections: CodeSection[] = []
  const add = (line: number, language: string) => {
    if (sections.at(-1)?.language !== language) sections.push({ line, language })
  }
  let open: { name: string; language: string } | null = null
  lines.forEach((text, i) => {
    if (open !== null) {
      const closes = new RegExp(`^</${open.name}\\s*>`, 'i').test(text)
      add(i + 1, closes ? 'html' : open.language)
      if (closes) open = null

      return
    }
    add(i + 1, 'html')
    const tag = /^<([a-z][\w-]*)\b([^>]*)>/i.exec(text)
    const name = tag?.[1]?.toLowerCase() ?? ''
    const languages = BLOCK_LANGUAGES[name]
    if (tag === null || languages === undefined || new RegExp(`</${name}\\s*>`, 'i').test(text)) return
    const lang = /\blang=["']?([\w-]+)/i.exec(tag[2] ?? '')?.[1]?.toLowerCase() ?? ''
    open = { name, language: languages[lang] ?? (lang || languages[''] || 'html') }
  })

  return sections
}

/** The file as the diff's new side has it: the commit's, the deleted file's last, else the one on disk. */
const diffSideText = async (deps: PreviewDeps, snapshot: Snapshot, file: ChangedFile | undefined, path: string): Promise<string | null> => {
  if (snapshot.commit !== undefined) return contentAt(deps.git, snapshot.root, snapshot.commit.sha, path)
  if (file?.status === 'deleted') return baseContent(deps.git, snapshot, path)

  return deps.readText(`${snapshot.root}/${path}`)
}

/** The modes a file offers, in toolbar order. */
export const modesFor = (path: string, file: ChangedFile | undefined): PreviewMode[] => {
  const modes: PreviewMode[] = []
  if (file !== undefined && !file.isBinary && !looksBinary(path)) modes.push('diff')
  modes.push('source')
  if (isMarkdown(path)) modes.push('rendered')

  return modes
}

/** What a file opens in: its changes when it has some, else its content. */
export const defaultMode = (path: string, file: ChangedFile | undefined): PreviewMode => {
  const markdownMode: PreviewMode = isMarkdown(path) ? 'rendered' : 'source'
  if (file === undefined) return markdownMode
  if (file.status === 'added' || file.status === 'untracked') return markdownMode
  if (file.isBinary || looksBinary(path)) return 'source'

  return 'diff'
}

/** Splits lines into pages of at most `budget` characters and `maxLines` lines: [start, end) each. */
export const pageRanges = (lines: readonly string[], budget = PAGE_CHARS, maxLines = PAGE_LINES): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  let start = 0
  let size = 0

  lines.forEach((line, index) => {
    const cost = line.length + 1
    if (index > start && (size + cost > budget || index - start >= maxLines)) {
      ranges.push([start, index])
      start = index
      size = 0
    }
    size += cost
  })
  if (start < lines.length || ranges.length === 0) ranges.push([start, lines.length])

  return ranges
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Cuts a hunk longer than `budget` into hunks of its own, each with a header that parses. */
export const splitHunk = (hunk: string, budget = PAGE_CHARS): string[] => {
  if (hunk.length <= budget) return [hunk]
  const [header = '', ...body] = hunk.split('\n')
  const match = HUNK_HEADER.exec(header)
  if (match === null) return [hunk]
  let oldLine = Number(match[1])
  let newLine = Number(match[3])
  const tail = match[5] ?? ''
  const pieces: string[] = []

  for (const [start, end] of pageRanges(body, budget - header.length - 2)) {
    const lines = body.slice(start, end)
    const oldCount = lines.filter(l => l.startsWith(' ') || l.startsWith('-')).length
    const newCount = lines.filter(l => l.startsWith(' ') || l.startsWith('+')).length
    pieces.push([`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@${tail}`, ...lines].join('\n'))
    oldLine += oldCount
    newLine += newCount
  }

  return pieces
}

/** Pages a diff on hunk boundaries, so every page is hunks that parse. */
export const diffPages = (diff: string, budget = PAGE_CHARS): string[] => {
  const hunks = diff
    .replace(/\n$/, '')
    .split(/\n(?=@@ )/)
    .filter(h => h.startsWith('@@ '))
    .flatMap(h => splitHunk(h, budget))
  const pages: string[] = []
  let page: string[] = []
  let size = 0

  for (const hunk of hunks) {
    if (page.length > 0 && size + hunk.length + 1 > budget) {
      pages.push(page.join('\n'))
      page = []
      size = 0
    }
    page.push(hunk)
    size += hunk.length + 1
  }
  if (page.length > 0) pages.push(page.join('\n'))

  return pages
}

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const clampPage = (page: number, pages: number): number => Math.min(Math.max(0, page), Math.max(0, pages - 1))

/** Loads what the preview screen draws for `path` in `mode`, one page of it. */
export const loadPreview = async (
  deps: PreviewDeps,
  snapshot: Snapshot,
  path: string,
  mode: PreviewMode,
  page = 0,
): Promise<Preview> => {
  const file = snapshot.files.find(f => f.path === path)
  const modes = modesFor(path, file)
  const shownMode = modes.includes(mode) ? mode : defaultMode(path, file)
  const base = { path, mode: shownMode, modes, page: 0, pages: 1 }
  const note = (text: string): Preview => ({ ...base, kind: 'note', text: '', note: text })

  if (shownMode === 'diff') {
    const diff = await fileDiff(deps.git, snapshot, file, path)
    if (diff === '') return note(file?.status === 'renamed' ? `Renamed from ${file.from ?? '?'}, content unchanged.` : 'No line changes (mode or whitespace only).')
    const pages = diffPages(diff)
    const at = clampPage(page, pages.length)
    const sideText = COMPONENT_EXTENSIONS.has(extensionOf(path)) ? await diffSideText(deps, snapshot, file, path).catch(() => null) : null
    const sections = sideText === null ? undefined : sectionsOf(path, sideText.replace(/\n$/, '').split('\n'))

    return { ...base, kind: 'diff', text: pages[at] ?? '', page: at, pages: pages.length, ...(sections ? { sections } : {}) }
  }

  const absolute = `${snapshot.root}/${path}`
  let text: string
  if (file?.status === 'deleted') {
    const old = await baseContent(deps.git, snapshot, path)
    if (old === null) return note('Deleted; its last version could not be read.')
    text = old
  } else if (snapshot.commit !== undefined) {
    // A past commit: the file as that commit has it.
    if (looksBinary(path) || file?.isBinary) return note('Binary file.')
    const old = await contentAt(deps.git, snapshot.root, snapshot.commit.sha, path)
    if (old === null) return note(`Not in commit ${snapshot.commit.short}.`)
    if (old.length > MAX_FILE_BYTES) return note('Too large to preview.')
    if (old === '') return note('Empty file.')
    text = old
  } else {
    const size = await deps.size(absolute)
    if (size === null) return note('File not found on disk.')
    if (extensionOf(path) === 'png') {
      const dimensions = await deps.pngSize(absolute)
      if (dimensions !== null) {
        return { ...base, kind: 'image', text: '', image: { file: absolute, ...dimensions }, note: `${dimensions.width}×${dimensions.height} PNG, ${formatBytes(size)}` }
      }
    }
    if (looksBinary(path) || file?.isBinary) return note(`Binary file, ${formatBytes(size)}.`)
    if (size > MAX_FILE_BYTES) return note(`Too large to preview (${formatBytes(size)}).`)
    if (size === 0) return note('Empty file.')
    text = await deps.readText(absolute)
  }
  if (text.includes('\0')) return note('Binary file.')

  const lines = text.replace(/\n$/, '').split('\n')
  const ranges = shownMode === 'rendered' ? blockPageRanges(lines, MARKDOWN_PAGE_CHARS) : pageRanges(lines)
  const at = clampPage(page, ranges.length)
  const [start, end] = ranges[at] ?? [0, lines.length]
  const sections = shownMode === 'rendered' ? undefined : sectionsOf(path, lines)

  return {
    ...base,
    kind: shownMode === 'rendered' ? 'markdown' : 'code',
    text: lines.slice(start, end).join('\n'),
    page: at,
    pages: ranges.length,
    firstLine: start + 1,
    totalLines: lines.length,
    ...(sections ? { sections } : {}),
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const decodeBase64 = (text: string): number[] => {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = BASE64.indexOf(char)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }

  return bytes
}

/** Reads a PNG's width and height from its header bytes (base64 of the file). */
export const pngDimensions = (base64Head: string): { width: number; height: number } | null => {
  const bytes = decodeBase64(base64Head)
  const signature = [0x89, 0x50, 0x4e, 0x47]
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null
  const read32 = (at: number): number =>
    (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0

  return { width: read32(16), height: read32(20) }
}
