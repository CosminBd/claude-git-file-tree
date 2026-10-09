import type { Activity, ActivityKind } from '../types'

/** Activity kept at most: the oldest goes first. */
const MAX_ACTIVITY = 300

/** Files one search marks at most, so a broad `grep -r` does not light up the whole tree. */
const MAX_PER_CALL = 40

/** Output lines looked through for paths. */
const MAX_LINES = 3000

/** A shell command that makes a commit: `git commit`, `git -c k=v commit`, after `&&` or `;`. */
export const isCommit = (command: string): boolean =>
  /(^|[\s;&|(])git(\s+-[cC]\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+commit(\s|$)/.test(command) && !/\s--dry-run\b/.test(command)

/** `a/b/c.ts` → `a/`, `a/b/`: the folders a row sits in, as the tree names them. */
export const ancestors = (path: string): string[] => {
  const parts = path.split('/').slice(0, -1)

  return parts.map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)
}

/** Resolves `.` and `..` in a slash path. */
const normalize = (path: string): string => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return out.join('/')
}

/** `path` root-relative, or null when it lies outside `root`; `base` is the root-relative folder a relative path starts from. */
export const toRelative = (path: string, root: string, base = ''): string | null => {
  if (path.startsWith('/')) return path.startsWith(`${root}/`) ? normalize(path.slice(root.length + 1)) : null
  if (path.startsWith('~')) return null

  return normalize(base + path)
}

/**
 * The repository files a read-only shell command named or printed: the command's own words,
 * and each output line whole or before its first `:` (grep's `path:line:`). Only paths in `known` count.
 */
export const pathsIn = (command: string, output: string, known: ReadonlySet<string>, root: string, base: string): string[] => {
  const found: string[] = []
  const consider = (raw: string) => {
    if (found.length >= MAX_PER_CALL) return
    const word = raw.trim().replace(/^['"]+|['"]+$/g, '')
    if (word === '' || word.startsWith('-')) return
    const path = toRelative(word, root, base)
    if (path !== null && known.has(path) && !found.includes(path)) found.push(path)
  }

  for (const word of command.split(/[\s'"=;|&()<>]+/)) consider(word)
  for (const line of output.split('\n').slice(0, MAX_LINES)) {
    consider(line)
    const colon = line.indexOf(':')
    if (colon > 0) consider(line.slice(0, colon))
  }

  return found
}

/**
 * Adds what Claude just did to the list, latest last. A read never hides a write or a commit
 * of the same file; a write and a commit replace each other.
 */
export const mergeActivity = (activity: readonly Activity[], kind: ActivityKind, paths: readonly string[]): Activity[] => {
  let seq = activity.reduce((max, entry) => Math.max(max, entry.seq), 0)
  const byPath = new Map(activity.map(entry => [entry.path, entry]))
  for (const path of paths) {
    const before = byPath.get(path)
    seq += 1
    byPath.set(path, { path, kind: kind === 'read' && before !== undefined ? before.kind : kind, seq })
  }

  return [...byPath.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_ACTIVITY)
}
