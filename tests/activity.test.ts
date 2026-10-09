import { describe, expect, test } from 'claude-code/testing'

import { ancestors, isCommit, mergeActivity, pathsIn, toRelative } from '../hooks/activity'
import { parseAheadBehind } from '../hooks/git'

describe('activity', () => {
  test('commits are told apart from other git commands', () => {
    expect(isCommit('git commit -m "x"')).toBe(true)
    expect(isCommit('git add . && git commit -m x')).toBe(true)
    expect(isCommit('git -c user.name=x commit --amend')).toBe(true)
    expect(isCommit('git log --grep commit')).toBe(false)
    expect(isCommit('git commit --dry-run')).toBe(false)
  })

  test('paths resolve against the root and the session folder', () => {
    expect(toRelative('/repo/a/../b/c.ts', '/repo')).toBe('b/c.ts')
    expect(toRelative('/elsewhere/x', '/repo')).toBeNull()
    expect(toRelative('./c.ts', '/repo', 'sub/')).toBe('sub/c.ts')
  })

  test('a search marks the known files it named or printed', () => {
    const known = new Set(['app/a.php', 'app/b.php', 'README.md'])
    const output = 'app/a.php:12:  match\napp/b.php\nnot/a/file.txt:3:x\n'
    expect(pathsIn('grep -rn match app README.md', output, known, '/repo', '')).toEqual(['README.md', 'app/a.php', 'app/b.php'])
  })

  test('a read never hides a write; a commit replaces a write', () => {
    let list = mergeActivity([], 'write', ['a.ts'])
    list = mergeActivity(list, 'read', ['a.ts', 'b.ts'])
    expect(list.map(e => [e.path, e.kind, e.seq])).toEqual([['a.ts', 'write', 2], ['b.ts', 'read', 3]])
    list = mergeActivity(list, 'commit', ['a.ts'])
    expect(list.find(e => e.path === 'a.ts')?.kind).toBe('commit')
  })

  test('folders of a path, as the tree names them', () => {
    expect(ancestors('a/b/c.ts')).toEqual(['a/', 'a/b/'])
    expect(ancestors('c.ts')).toEqual([])
  })

  test('ahead and behind counts', () => {
    expect(parseAheadBehind('2\t1\n')).toEqual({ ahead: 2, behind: 1 })
    expect(parseAheadBehind('')).toBeNull()
  })
})
