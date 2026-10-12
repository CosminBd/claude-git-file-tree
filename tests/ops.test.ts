import { describe, expect, test } from 'claude-code/testing'

import { cleanMessage, compareUrl, discardCommands, MESSAGE_DIFF_CHARS, messagePrompt, outcomeOf, parsePrView, prLabel, webUrlOf } from '../hooks/ops'

describe('ops', () => {
  test('git output becomes a status line, the rest kept for a failure', () => {
    expect(outcomeOf(true, '', 'Pushed')).toEqual({ ok: true, text: 'Pushed' })
    expect(outcomeOf(false, "error: failed to push some refs to 'origin'\nhint: Updates were rejected\nhint: Pull first.\n", 'x')).toEqual({
      ok: false,
      text: "failed to push some refs to 'origin'",
      detail: 'Updates were rejected\nPull first.',
    })
  })

  test('discard: a new file is deleted, a rename undone, the rest restored', () => {
    expect(discardCommands({ path: 'n.txt', status: 'untracked' })).toEqual([['clean', '-f', '--', 'n.txt']])
    expect(discardCommands({ path: 'b.php', status: 'renamed', from: 'a.php' })).toEqual([
      ['rm', '-f', '--', 'b.php'],
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'a.php'],
    ])
    expect(discardCommands({ path: 'm.php', status: 'modified' })).toEqual([['restore', '--source=HEAD', '--staged', '--worktree', '--', 'm.php']])
  })

  test('the web page of a remote, and the page that opens a PR', () => {
    expect(webUrlOf('git@github.com:o/r.git')).toBe('https://github.com/o/r')
    expect(webUrlOf('ssh://git@github.com:22/o/r.git')).toBe('https://github.com/o/r')
    expect(webUrlOf('https://github.com/o/r')).toBe('https://github.com/o/r')
    expect(webUrlOf('https://token@git.corp.io:8443/o/r.git/')).toBe('https://git.corp.io:8443/o/r')
    expect(webUrlOf('/srv/git/r.git')).toBeNull()
    expect(compareUrl('https://github.com/o/r', 'feat/a#1')).toBe('https://github.com/o/r/compare/feat/a%231?expand=1')
  })

  test('gh pr view, and the label it gives', () => {
    const pr = parsePrView('{"number":14,"url":"https://github.com/o/r/pull/14","state":"OPEN","isDraft":true}')
    expect(pr).toEqual({ number: 14, url: 'https://github.com/o/r/pull/14', state: 'OPEN', isDraft: true })
    expect(prLabel(pr!)).toBe('PR #14 draft')
    expect(prLabel({ number: 3, url: '', state: 'MERGED', isDraft: false })).toBe('PR #3 merged')
    expect(parsePrView('no pull requests found')).toBeNull()
  })

  test('the message prompt carries the staged changes and the house style', () => {
    const prompt = messagePrompt({ stat: ' a.ts | 2 +-\n', diff: '-old\n+new\n', subjects: ['Add commit history view'], amend: null })
    expect(prompt).toContain('Staged files:\na.ts | 2 +-')
    expect(prompt).toContain('+new')
    expect(prompt).toContain('- Add commit history view')
    expect(prompt).not.toContain('amend')
    expect(messagePrompt({ stat: '', diff: '', subjects: [], amend: 'Fix it' })).toContain('Its message was:\nFix it')
  })

  test('a long diff is cut, and says so', () => {
    const prompt = messagePrompt({ stat: '', diff: 'x'.repeat(MESSAGE_DIFF_CHARS + 10), subjects: [], amend: null })
    expect(prompt).toContain('[… the rest of the diff is left out]')
    expect(prompt.length).toBeLessThan(MESSAGE_DIFF_CHARS + 2000)
  })

  test('a reply loses its code fence or quotes', () => {
    expect(cleanMessage('```\nFix the landing\n\nBecause.\n```')).toBe('Fix the landing\n\nBecause.')
    expect(cleanMessage('"Fix the landing"')).toBe('Fix the landing')
    expect(cleanMessage('  Fix the landing\n')).toBe('Fix the landing')
  })
})
