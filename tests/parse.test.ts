import { describe, expect, test } from 'claude-code/testing'

import { hunksOnly, parseLineCounts, parseLog, parseNameStatus, parseNumstat, parseStatus } from '../hooks/git'
import { defaultMode, diffPages, modesFor, pageRanges, splitHunk } from '../hooks/preview'
import { buildTree, flatten, matches, reviewOrder } from '../hooks/tree'

describe('git output', () => {
  test('porcelain status: each kind of change, renames carrying their source', () => {
    const files = parseStatus(
      ' M app/a.php\0?? new.txt\0 D gone.txt\0R  b.php\0old-b.php\0A  added.ts\0UU both.ts\0AD ghost.ts\0',
    )
    expect(files).toEqual([
      { path: 'app/a.php', status: 'modified', unstaged: true },
      { path: 'new.txt', status: 'untracked', unstaged: true },
      { path: 'gone.txt', status: 'deleted', unstaged: true },
      { path: 'b.php', status: 'renamed', from: 'old-b.php', staged: true },
      { path: 'added.ts', status: 'added', staged: true },
      { path: 'both.ts', status: 'conflict', unstaged: true },
    ])
  })

  test('a file changed after staging is in both halves', () => {
    expect(parseStatus('MM app/a.php\0')).toEqual([{ path: 'app/a.php', status: 'modified', staged: true, unstaged: true }])
  })

  test('name-status against a merge base', () => {
    expect(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0D\0x.md\0')).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'new.ts', status: 'renamed', from: 'old.ts' },
      { path: 'x.md', status: 'deleted' },
    ])
  })

  test('numstat: counts, binaries and renames', () => {
    const stats = parseNumstat('12\t3\ta.ts\0-\t-\tlogo.png\0' + '4\t1\t\0old.ts\0new.ts\0')
    expect(stats.get('a.ts')).toEqual({ added: 12, removed: 3, isBinary: false })
    expect(stats.get('logo.png')).toEqual({ added: 0, removed: 0, isBinary: true })
    expect(stats.get('new.ts')).toEqual({ added: 4, removed: 1, isBinary: false })
  })

  test('wc -l counts, the total skipped', () => {
    const counts = parseLineCounts('      7 docs/a b.md\n     12 x.ts\n     19 total\n')
    expect(counts.get('docs/a b.md')).toBe(7)
    expect(counts.has('total')).toBe(false)
  })

  test('log lines: hash, short hash, age, subject', () => {
    expect(parseLog('aaa\x1fa\x1f1 hour ago\x1fFix: x\nbad line\n')).toEqual([{ sha: 'aaa', short: 'a', when: '1 hour ago', subject: 'Fix: x' }])
  })

  test('a diff keeps its hunks only', () => {
    expect(hunksOnly('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toBe('@@ -1 +1 @@\n-a\n+b\n')
    expect(hunksOnly('Binary files differ\n')).toBe('')
  })
})

describe('paging', () => {
  test('lines page by characters', () => {
    const lines = Array.from({ length: 10 }, () => 'x'.repeat(9))
    expect(pageRanges(lines, 30)).toEqual([[0, 3], [3, 6], [6, 9], [9, 10]])
    expect(pageRanges([], 30)).toEqual([[0, 0]])
  })

  test('a long hunk splits into hunks whose headers still add up', () => {
    const body = ['@@ -10,6 +10,7 @@ fn', ' a', '-b', '+B', '+C', ' d', ' e', ' f'].join('\n')
    const pieces = splitHunk(body, 30)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces[0]?.startsWith('@@ -10,')).toBe(true)
    for (const piece of pieces) expect(piece).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@ fn\n/)
    const last = pieces[pieces.length - 1] ?? ''
    expect(last).toMatch(/^@@ -1[1-6],\d+ \+1[1-7],\d+ @@/)
  })

  test('diff pages hold whole hunks', () => {
    const hunk = (n: number) => `@@ -${n},1 +${n},1 @@\n-old ${n}\n+new ${n}`
    const pages = diffPages([hunk(1), hunk(20), hunk(40)].join('\n'), 40)
    expect(pages).toHaveLength(3)
    expect(pages.every(p => p.startsWith('@@ '))).toBe(true)
  })
})

describe('modes', () => {
  test('a changed file opens on its diff, a new one on its content', () => {
    expect(defaultMode('a.php', { path: 'a.php', status: 'modified' })).toBe('diff')
    expect(defaultMode('n.md', { path: 'n.md', status: 'untracked' })).toBe('rendered')
    expect(defaultMode('n.ts', { path: 'n.ts', status: 'added' })).toBe('source')
    expect(defaultMode('same.ts', undefined)).toBe('source')
  })

  test('markdown offers a rendered view, unchanged files no diff', () => {
    expect(modesFor('README.md', { path: 'README.md', status: 'modified' })).toEqual(['diff', 'source', 'rendered'])
    expect(modesFor('a.ts', undefined)).toEqual(['source'])
    expect(modesFor('logo.png', { path: 'logo.png', status: 'modified', isBinary: true })).toEqual(['source'])
  })
})

describe('tree', () => {
  const files = [
    { path: 'app/Http/Controllers/Landing.php', status: 'modified' as const },
    { path: 'app/Models/User.php', status: 'added' as const },
    { path: 'README.md', status: 'modified' as const },
  ]
  const changes = new Map(files.map(f => [f.path, f]))

  test('folders first, single-folder chains folded into one row', () => {
    const rows = flatten(buildTree(files.map(f => f.path), changes), { isOpen: () => true, isCompact: true })
    expect(rows.map(r => `${'  '.repeat(r.depth)}${r.label}`)).toEqual([
      'app/',
      '  Http/Controllers/',
      '    Landing.php',
      '  Models/',
      '    User.php',
      'README.md',
    ])
    expect(rows[0]?.changes).toBe(2)
  })

  test('a closed folder hides its children', () => {
    const rows = flatten(buildTree(files.map(f => f.path), changes), { isOpen: p => p !== 'app/', isCompact: true })
    expect(rows.map(r => r.label)).toEqual(['app/', 'README.md'])
  })

  test('the filter matches substrings and subsequences', () => {
    expect(matches('app/Http/Controllers/LandingController.php', 'lancon')).toBe(true)
    expect(matches('app/Models/User.php', 'landing')).toBe(false)
    expect(matches('anything', '  ')).toBe(true)
  })

  test('review order follows the tree', () => {
    expect(reviewOrder(files)).toEqual(['app/Http/Controllers/Landing.php', 'app/Models/User.php', 'README.md'])
  })
})
