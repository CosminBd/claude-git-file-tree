import { describe, expect, test } from 'claude-code/testing'

import type { Preview } from '../types'
import { mentionOf, pick } from '../hooks/mention'

const source = (text: string, firstLine = 1): Preview => ({ path: 'a.ts', mode: 'source', modes: ['source'], kind: 'code', text, page: 0, pages: 1, firstLine })
const diff = (text: string): Preview => ({ path: 'a.ts', mode: 'diff', modes: ['diff'], kind: 'diff', text, page: 0, pages: 1 })

const PAGE = ['export class Cart {', '  clear(): void {', '    this.lines = []', '  }', '}'].join('\n')

describe('a selection as lines', () => {
  test('whole lines, as Claude Code draws code: numbered on from the page', () => {
    expect(pick(source(PAGE, 40), '  clear(): void {\n    this.lines = []\n  }')).toEqual({ from: 41, to: 43, text: '  clear(): void {\n    this.lines = []\n  }' })
  })

  test('cut lines with the pane\'s own numbers, as the Vue view draws them', () => {
    expect(pick(source(PAGE), 'ear(): void {\n  3     this.lines = []\n  4   }')).toMatchObject({ from: 2, to: 4 })
  })

  test('a wrapped line comes back joined; tabs and spaces count alike', () => {
    expect(pick(source('a\n\tconst x = "long text"\nb'), '    const x = "long\ntext"'.replace('\n', ' '))).toMatchObject({ from: 2, to: 2 })
  })

  test('a long line the pane wrapped mid-word comes back in pieces', () => {
    const page = source('a()\n    if (x) y = y + z // merge the quantities\nb()', 7)
    expect(pick(page, '    if (x) y = y + z // merge th\ne quantities')).toMatchObject({ from: 8, to: 8 })
    expect(pick(page, 'z // merge th\ne quantities\nb(')).toMatchObject({ from: 8, to: 9 })
  })

  test('part of one line', () => {
    expect(pick(source(PAGE), 'this.lines')).toMatchObject({ from: 3, to: 3 })
  })

  test('a selection the page does not have', () => {
    expect(pick(source(PAGE), 'something else\nentirely')).toBeNull()
    expect(pick(source(PAGE), '   ')).toBeNull()
  })

  const HUNKS = ['@@ -1,3 +1,3 @@', ' a', '-d', '+b', ' c', '@@ -20,1 +20,2 @@', ' x', '+y'].join('\n')

  test('in a diff: kept and added lines by their number in the file now, across the gap between hunks', () => {
    expect(pick(diff(HUNKS), 'b\nc')).toMatchObject({ from: 2, to: 3 })
    expect(pick(diff(HUNKS), 'c\n...\nx\ny')).toMatchObject({ from: 3, to: 21 })
  })

  test('in a diff: removed lines go as the diff itself', () => {
    expect(pick(diff(HUNKS), 'a\nd')).toEqual({ diff: ' a\n-d' })
  })

  test('the rendered Markdown has no lines to name', () => {
    expect(pick({ ...source(PAGE), kind: 'markdown' }, 'clear')).toBeNull()
  })
})

describe('the mention', () => {
  test('relative to the session, with its lines', () => {
    expect(mentionOf('/repo/src/a.ts', '/repo')).toBe('@src/a.ts')
    expect(mentionOf('/repo/src/a.ts', '/repo', { from: 3, to: 9 })).toBe('@src/a.ts#L3-9')
    expect(mentionOf('/repo/src/a.ts', '/repo', { from: 3, to: 3 })).toBe('@src/a.ts#L3')
  })

  test('absolute outside the session (a subagent\'s worktree), quoted with a space', () => {
    expect(mentionOf('/wt/agent-1/a.ts', '/repo')).toBe('@/wt/agent-1/a.ts')
    expect(mentionOf('/repo/my docs/a.md', '/repo')).toBe('@"my docs/a.md"')
  })
})
