import type { ChangedFile, PrInfo } from '../types'

/** How long a destructive press waits for its second press. */
export const CONFIRM_MS = 4000

/** What a git operation came to, as the status line shows it. */
export type Outcome = { ok: boolean; text: string; detail?: string }

const DETAIL_LINES = 12

/** git's words as a status line: the first meaningful line, the rest kept for a failure. */
export const outcomeOf = (ok: boolean, output: string, fallback: string): Outcome => {
  const lines = output
    .split('\n')
    .map(line => line.replace(/^(error|fatal|hint|remote): /, '').trimEnd())
    .filter(line => line.trim() !== '')
  const [first = fallback, ...rest] = lines
  const detail = rest.slice(0, DETAIL_LINES).join('\n')

  return ok || detail === '' ? { ok, text: first } : { ok, text: first, detail }
}

/** The paths a stage or unstage of `file` touches: a rename moves both its paths. */
export const pathsOf = (file: ChangedFile): string[] => (file.status === 'renamed' && file.from ? [file.from, file.path] : [file.path])

/**
 * The commands that throw away the changes to `file`, back to HEAD: a new or added file is
 * deleted, a rename is undone, anything else is restored in the index and on disk.
 */
export const discardCommands = (file: ChangedFile): string[][] => {
  switch (file.status) {
    case 'untracked':
      return [['clean', '-f', '--', file.path]]
    case 'added':
      return [['rm', '-f', '--', file.path]]
    case 'renamed':
      return [
        ['rm', '-f', '--', file.path],
        ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.from ?? file.path],
      ]
    default:
      return [['restore', '--source=HEAD', '--staged', '--worktree', '--', file.path]]
  }
}

/** `gh pr view --json number,url,state,isDraft`, or null when there is no PR. */
export const parsePrView = (stdout: string): PrInfo | null => {
  try {
    const value = JSON.parse(stdout) as Partial<PrInfo>
    if (typeof value.number !== 'number' || typeof value.url !== 'string') return null

    return { number: value.number, url: value.url, state: String(value.state ?? 'OPEN'), isDraft: value.isDraft === true }
  } catch {
    return null
  }
}

/** The PR templates among the repository's files, in the places GitHub reads them. */
export const findTemplates = (paths: readonly string[]): string[] =>
  paths
    .filter(path => /^(\.github\/|docs\/)?pull_request_template\.md$/i.test(path) || /^\.github\/pull_request_template\/[^/]+\.md$/i.test(path))
    .sort((a, b) => a.localeCompare(b))

/** A PR's state as the header says it: `PR #14 open`, `PR #14 draft`, `PR #14 merged`. */
export const prLabel = (pr: PrInfo): string => `PR #${pr.number} ${pr.isDraft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase()}`

/** How much of the staged diff the message prompt carries; the file list always goes whole. */
export const MESSAGE_DIFF_CHARS = 24_000

/**
 * The prompt that asks the session's model for a commit message: the staged changes, and the
 * repository's last subjects so the message reads like the rest of its history.
 */
export const messagePrompt = (input: { stat: string; diff: string; subjects: readonly string[]; amend: string | null }): string => {
  const diff = input.diff.length > MESSAGE_DIFF_CHARS ? `${input.diff.slice(0, MESSAGE_DIFF_CHARS)}\n[… the rest of the diff is left out]` : input.diff

  return [
    'Write the git commit message for the staged changes below. Use what you know from this conversation about why they were made.',
    input.amend === null ? '' : `This replaces the last commit (amend). Its message was:\n${input.amend}`,
    input.subjects.length > 0 ? `Write it in the style of the repository's recent commits:\n${input.subjects.map(subject => `- ${subject}`).join('\n')}` : '',
    'A subject line in the imperative, at most 60 characters, with no type prefix (feat:, fix:) and no closing period. Then, when the why is not obvious from the subject, a blank line and a short body in plain sentences saying why, wrapped at 72 columns.',
    'Reply with the message alone: no quotes, no code fence, nothing before or after it.',
    `Staged files:\n${input.stat.trim()}`,
    `Staged diff:\n${diff.trim()}`,
  ]
    .filter(part => part !== '')
    .join('\n\n')
}

/** The model's reply as a commit message: a code fence or wrapping quotes taken off. */
export const cleanMessage = (reply: string): string => {
  let text = reply.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text)
  if (fenced) text = (fenced[1] ?? '').trim()
  if (/^(["'`]).*\1$/s.test(text)) text = text.slice(1, -1).trim()

  return text
}
