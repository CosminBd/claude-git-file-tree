import type { ChangedFile } from '../types'

type Node = {
  name: string
  /** Root-relative; a folder's ends in `/`. */
  path: string
  isDir: boolean
  children: Map<string, Node>
  file?: ChangedFile
  /** Changed files at or below this node. */
  changes: number
}

export type Row = {
  key: string
  path: string
  /** What the row shows: a name, or a compacted folder chain (`app/Http/`). */
  label: string
  depth: number
  isDir: boolean
  isOpen: boolean
  changes: number
  file?: ChangedFile
}

export type FlattenOptions = {
  /** Whether a folder (path ending in `/`, holding `changes` changed files) shows its children. */
  isOpen: (path: string, changes: number) => boolean
  /** Folds a chain of single-folder folders into one row, as editors do. */
  isCompact: boolean
}

const newNode = (name: string, path: string, isDir: boolean): Node => ({
  name, path, isDir, children: new Map(), changes: 0,
})

/** Builds the folder tree over `paths`, marking each changed file. */
export const buildTree = (paths: Iterable<string>, changes: ReadonlyMap<string, ChangedFile>): Node => {
  const root = newNode('', '', true)

  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    let prefix = ''
    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1
      prefix += isLast ? part : `${part}/`
      let child = node.children.get(part + (isLast ? '' : '/'))
      if (child === undefined) {
        child = newNode(part, prefix, !isLast)
        node.children.set(part + (isLast ? '' : '/'), child)
      }
      node = child
    })
    const file = changes.get(path)
    if (file !== undefined) node.file = file
  }

  const count = (node: Node): number => {
    node.changes = node.isDir ? [...node.children.values()].reduce((sum, child) => sum + count(child), 0) : node.file ? 1 : 0

    return node.changes
  }
  count(root)

  return root
}

const sorted = (node: Node): Node[] =>
  [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1

    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })

/** Lays the tree out as the rows the pane draws, top to bottom. */
export const flatten = (root: Node, options: FlattenOptions): Row[] => {
  const rows: Row[] = []

  const walk = (node: Node, depth: number): void => {
    for (const child of sorted(node)) {
      if (!child.isDir) {
        rows.push({
          key: `row:${child.path}`, path: child.path, label: child.name, depth,
          isDir: false, isOpen: false, changes: child.changes, ...(child.file ? { file: child.file } : {}),
        })
        continue
      }
      let shown = child
      let label = `${child.name}/`
      while (options.isCompact && shown.children.size === 1) {
        const only = [...shown.children.values()][0]
        if (only === undefined || !only.isDir) break
        shown = only
        label += `${only.name}/`
      }
      const isOpen = options.isOpen(shown.path, shown.changes)
      rows.push({ key: `row:${shown.path}`, path: shown.path, label, depth, isDir: true, isOpen, changes: shown.changes })
      if (isOpen) walk(shown, depth + 1)
    }
  }
  walk(root, 0)

  return rows
}

/** Case-insensitive subsequence match, so `lancon` finds `LandingController.php`. */
export const matches = (path: string, filter: string): boolean => {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return true
  const hay = path.toLowerCase()
  if (hay.includes(needle)) return true
  let at = 0
  for (const char of needle) {
    if (char === ' ') continue
    at = hay.indexOf(char, at)
    if (at < 0) return false
    at += 1
  }

  return true
}

/** The changed files in the order the changes view lists them (for next and previous). */
export const reviewOrder = (files: readonly ChangedFile[]): string[] => {
  const tree = buildTree(files.map(f => f.path), new Map(files.map(f => [f.path, f])))

  return flatten(tree, { isOpen: () => true, isCompact: false }).filter(row => !row.isDir).map(row => row.path)
}
