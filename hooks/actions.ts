import type { PaneOpenArgs, RenderSurface, UiFocusArgs, UiScrollArgs } from 'claude-code'

import type { ActivityKind, BaseMode, ChangedFile, CommitInfo, GitUi, PrForm, Preview, PreviewMode, Snapshot } from '../types'
import { ancestors, isCommit, mergeActivity, pathsIn, toRelative } from './activity'
import { defaultBranch, EMPTY_TREE, listAll, listCommits, listTree, scan } from './git'
import type { Git, RunResult } from './git'
import { defaultMode, loadPreview, modesFor, pngDimensions } from './preview'
import type { PreviewDeps } from './preview'
import * as S from './state'
import { cleanMessage, CONFIRM_MS, discardCommands, findTemplates, messagePrompt, outcomeOf, parsePrView, pathsOf } from './ops'
import type { Outcome } from './ops'
import { reviewOrder } from './tree'

/**
 * What the actions need from the engine, as closures a hook builds where `$` is in scope
 * (a mod spells `$` only at its call sites, never passes it on).
 */
export type Io = S.StateIo & {
  run: (argv: string[], cwd?: string, init?: RunInit) => Promise<RunResult>
  now: () => Promise<number>
  writeText: (path: string, text: string) => Promise<void>
  stat: (path: string) => Promise<{ kind: string; size: number }>
  readText: (path: string) => Promise<string>
  readBase64: (path: string) => Promise<string>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  cwd: () => Promise<string>
  scroll: (args: UiScrollArgs) => Promise<unknown>
  focus: (args: UiFocusArgs) => Promise<unknown>
  open: (args: PaneOpenArgs) => Promise<{ isPlaced: boolean }>
  close: (id: string) => Promise<void>
  toast: (text: string) => void
  copy: (text: string, surface: RenderSurface) => Promise<boolean>
  /** Asks the session's own model, over this conversation, with no tools: its reply, or why there is none. */
  fork: (prompt: string) => Promise<{ text: string } | { reason: string }>
}

export type RunInit = { env?: Record<string, string>; stdin?: string; timeoutMs?: number }

const gitOf = (io: Io): Git => (args, cwd) => io.run(['git', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], cwd)

const previewDeps = (io: Io): PreviewDeps => ({
  git: gitOf(io),
  size: async path => {
    try {
      const stat = await io.stat(path)

      return stat.kind === 'file' ? stat.size : null
    } catch {
      return null
    }
  },
  readText: path => io.readText(path),
  pngSize: async path => {
    try {
      return pngDimensions((await io.readBase64(path)).slice(0, 32))
    } catch {
      return null
    }
  },
})

const savePrefs = async (io: Io): Promise<void> => {
  const prefs: S.Prefs = { view: await S.pick(io, 'view'), baseMode: await S.pick(io, 'baseMode') }
  await io.storeSet(S.PREFS_KEY, prefs).catch(() => undefined)
}

export const loadPrefs = async (io: Io): Promise<void> => {
  const prefs = ((await io.storeGet(S.PREFS_KEY).catch(() => undefined)) ?? {}) as S.Prefs
  if (prefs.view === 'changes' || prefs.view === 'all') await S.put(io, 'view', () => prefs.view ?? 'changes')
  if (prefs.baseMode !== undefined && BASE_ORDER.includes(prefs.baseMode)) await S.put(io, 'baseMode', () => prefs.baseMode ?? 'head')
}

const failed = (cwd: string, error: unknown, baseMode: Snapshot['baseMode']): Snapshot => ({
  root: cwd, branch: '', baseMode, baseRev: '', baseLabel: '', files: [],
  error: 'git-failed', message: error instanceof Error ? error.message : String(error),
})

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Shows `path` in the preview screen, in `mode` (or the file's default), at `page`. */
export const openFile = async (io: Io, path: string, mode?: PreviewMode, page = 0, keepScroll = false): Promise<void> => {
  const snap = await S.pick(io, 'snapshot')
  if (snap === null || snap.error !== undefined) return
  const file = snap.files.find(f => f.path === path)
  const chosen = mode ?? defaultMode(path, file)
  let next: Preview
  try {
    next = await loadPreview(previewDeps(io), snap, path, chosen, page)
  } catch (error) {
    next = {
      path, mode: chosen, modes: modesFor(path, file), kind: 'note', text: '', page: 0, pages: 1,
      note: `Could not read it: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const shown = await S.pick(io, 'preview')
  if (!sameJson(shown, next)) await S.put(io, 'preview', () => next)
  await S.put(io, 'screen', () => 'preview')
  if (!keepScroll) await io.scroll({ to: 'start', in: S.PANE }).catch(() => undefined)
}

let isRefreshing = false
let isQueued = false

/**
 * The working tree as a git tree, untracked files in and ignored ones out, written through an index
 * of the mod's own (`name`) so the real one, and what is staged, stays as it is. Null outside a repository.
 */
const workTree = async (io: Io, cwd: string, name: string): Promise<string | null> => {
  const paths = await runGit(io, cwd, ['rev-parse', '--git-path', 'index', '--git-path', `git-file-tree-${name}.index`])
  const [real, own] = paths.stdout.split('\n')
  if (paths.exitCode !== 0 || !real || !own) return null
  // Starting from a copy of the real index, git rehashes only the files that changed.
  await io.run(['cp', real, own], cwd).catch(() => undefined)
  const env = { GIT_INDEX_FILE: own }
  if ((await runGit(io, cwd, ['add', '-A'], { env })).exitCode !== 0) return null
  const tree = await runGit(io, cwd, ['write-tree'], { env })

  return tree.exitCode === 0 ? tree.stdout.trim() : null
}

/** Keeps the working tree as the prompt view's base: at each prompt, and once when the session starts. */
export const takePromptBase = async (io: Io, at: 'prompt' | 'session'): Promise<void> => {
  if (at === 'session' && (await S.pick(io, 'promptBase')) !== null) return
  const tree = await workTree(io, await io.cwd(), 'prompt')
  if (tree !== null) await S.put(io, 'promptBase', () => ({ tree, at }))
}

const refreshOnce = async (io: Io, forcePreview: string | null): Promise<void> => {
  const mode = await S.pick(io, 'baseMode')
  const cwd = await io.cwd()
  const commit = await S.pick(io, 'commit')
  const base = mode === 'prompt' && commit === null ? await S.pick(io, 'promptBase') : null
  const now = base !== null ? await workTree(io, cwd, 'now') : null
  const prompt = base !== null && now !== null ? { before: base.tree, now, label: base.at === 'prompt' ? 'your last prompt' : 'the session start' } : null
  const next = await scan(gitOf(io), io.run, cwd, mode, commit, prompt).catch(error => failed(cwd, error, mode))
  const previous = await S.pick(io, 'snapshot')
  const hasChanged = !sameJson(previous, next)
  if (hasChanged) await S.put(io, 'snapshot', () => next)

  if ((await S.pick(io, 'view')) === 'all' && next.error === undefined) {
    const list = await (commit ? listTree(gitOf(io), next.root, commit.sha) : listAll(gitOf(io), next.root)).catch(() => null)
    if (list !== null && !sameJson(await S.pick(io, 'allFiles'), list)) await S.put(io, 'allFiles', () => list)
  }

  await reloadPrBody(io)

  // Keep an open preview current with what is on disk now.
  const shown = await S.pick(io, 'preview')
  const isPreviewing = (await S.pick(io, 'screen')) === 'preview'
  if (shown !== null && isPreviewing && (hasChanged || forcePreview === shown.path)) {
    await openFile(io, shown.path, shown.mode, shown.page, true)
  }
}

/** Reads git again; calls that land while one runs fold into one more pass. */
export const refresh = async (io: Io, forcePreview: string | null = null): Promise<void> => {
  if (isRefreshing) {
    isQueued = true

    return
  }
  isRefreshing = true
  try {
    if ((await S.pick(io, 'snapshot')) === null) await S.put(io, 'isLoading', () => true)
    let pass = 0
    do {
      isQueued = false
      await refreshOnce(io, pass === 0 ? forcePreview : null)
      pass += 1
    } while (isQueued && pass < 3)
  } finally {
    isRefreshing = false
    await S.put(io, 'isLoading', () => false)
  }
}

/** Claude wrote `absolutePath`: mark it and refresh the tree. */
export const noteEdit = async (io: Io, absolutePath: string | null): Promise<void> => {
  let relative: string | null = null
  if (absolutePath !== null) {
    const snap = await S.pick(io, 'snapshot')
    const root = snap?.root ?? (await io.cwd())
    relative = absolutePath.startsWith(`${root}/`) ? absolutePath.slice(root.length + 1) : null
    if (relative !== null && relative !== (await S.pick(io, 'touched'))) await S.put(io, 'touched', () => relative)
    if (relative !== null) await noteActivity(io, 'write', [relative])
  }
  await refresh(io, relative)
}

const rootOf = async (io: Io): Promise<string> => {
  const snap = await S.pick(io, 'snapshot')

  return snap?.root ?? (await io.cwd())
}

/** Marks `paths` (root-relative) with what Claude did, opening the folders they sit in. */
export const noteActivity = async (io: Io, kind: ActivityKind, paths: readonly string[]): Promise<void> => {
  if (paths.length === 0) return
  const folders = new Set(paths.flatMap(ancestors))
  await io.set(state => ({
    ...state,
    activity: mergeActivity(state.activity, kind, paths),
    collapsed: state.collapsed.filter(folder => !folders.has(folder)),
    expanded: [...new Set([...state.expanded, ...folders])],
  }))
}

/** Claude read a file with its Read tool. */
export const noteRead = async (io: Io, absolutePath: string): Promise<void> => {
  const path = toRelative(absolutePath, await rootOf(io))
  if (path !== null) await noteActivity(io, 'read', [path])
}

/** What a shell command did: a commit marks the committed files; a read-only one, the files it named or printed. */
export const noteShell = async (io: Io, command: string, output: string, isReadOnly: boolean, isError: boolean): Promise<void> => {
  if (isCommit(command) && !isError) {
    await refresh(io)
    const root = await rootOf(io)
    const shown = await gitOf(io)(['show', '--name-only', '--format=', '--no-renames', 'HEAD'], root)
    if (shown.exitCode === 0) await noteActivity(io, 'commit', shown.stdout.split('\n').map(line => line.trim()).filter(Boolean))

    return
  }
  if (isReadOnly) {
    const root = await rootOf(io)
    const cwd = await io.cwd()
    const base = cwd.startsWith(`${root}/`) ? `${cwd.slice(root.length + 1)}/` : ''
    const known = new Set(await listAll(gitOf(io), root).catch(() => []))
    await noteActivity(io, 'read', pathsIn(command, output, known, root, base))

    return
  }
  await noteEdit(io, null)
}

/** A new prompt: what Claude did before it is no longer news. */
export const clearActivity = async (io: Io): Promise<void> => {
  if ((await S.pick(io, 'activity')).length > 0) await S.put(io, 'activity', () => [])
}

/** Hands a file or a URL to the system: `open` on macOS, `xdg-open` on Linux. */
const openExternal = async (io: Io, target: string): Promise<boolean> => {
  for (const opener of ['open', 'xdg-open']) {
    const result = await io.run([opener, target]).catch(() => null)
    if (result !== null && result.exitCode === 0) return true
  }

  return false
}

/** Opens `path` (root-relative) in the app the system picks for it. */
export const openInApp = async (io: Io, path: string): Promise<void> => {
  const isOpened = await openExternal(io, `${await rootOf(io)}/${path}`)
  io.toast(isOpened ? `Opened ${path.slice(path.lastIndexOf('/') + 1)}` : 'Could not open it: no app is set for this file')
}

export const openUrl = async (io: Io, url: string): Promise<void> => {
  if (!(await openExternal(io, url))) io.toast('Could not open the browser')
}

// Git operations ------------------------------------------------------------------------

/** Network operations may take this long before they are stopped. */
const NETWORK_MS = 120_000

const putGit = (io: Io, change: (git: GitUi) => GitUi) => S.put(io, 'git', change)

/** Runs git for an operation: no prompt can wait for an answer nobody can give. */
const runGit = (io: Io, root: string, args: string[], init: RunInit = {}): Promise<RunResult> =>
  io.run(['git', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], root, {
    ...init,
    env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...init.env },
  })

/** A command's outcome: `okText` (or its own first line) when it worked, git's words when it did not. */
const outcome = (result: RunResult, okText: string, useOutput = false): Outcome =>
  result.exitCode === 0
    ? outcomeOf(true, useOutput ? result.stdout : '', okText)
    : outcomeOf(false, `${result.stderr}\n${result.stdout}`, `git exited with ${result.exitCode}`)

/** Runs one operation at a time: its outcome on the status line, the tree read again after. */
const operate = async (io: Io, busy: string, work: (root: string) => Promise<Outcome>): Promise<boolean> => {
  if ((await S.pick(io, 'git')).busy !== null) return false
  await putGit(io, git => ({ ...git, busy, confirm: null }))
  let result: Outcome
  try {
    result = await work(await rootOf(io))
  } catch (error) {
    result = { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
  await putGit(io, git => ({ ...git, busy: null, notice: result }))
  await refresh(io)

  return result.ok
}

/** The first press of a destructive action arms it; a second within CONFIRM_MS goes ahead. */
const confirmed = async (io: Io, key: string): Promise<boolean> => {
  const now = await io.now()
  const { confirm } = await S.pick(io, 'git')
  if (confirm !== null && confirm.key === key && now - confirm.at < CONFIRM_MS) return true
  await putGit(io, git => ({ ...git, confirm: { key, at: now } }))

  return false
}

/** Disarms a destructive press nobody repeated (the poll calls it). */
export const expireConfirm = async (io: Io): Promise<void> => {
  const { confirm } = await S.pick(io, 'git')
  if (confirm !== null && (await io.now()) - confirm.at >= CONFIRM_MS) await putGit(io, git => ({ ...git, confirm: null }))
}

const describe = (paths: readonly string[]): string =>
  paths.length === 1 ? (paths[0] === '.' ? 'all changes' : (paths[0] ?? '')) : `${paths.length} paths`

/** Stages files or folders (root-relative); new files are added, deleted ones removed. */
export const stage = (io: Io, paths: readonly string[]): Promise<boolean> =>
  operate(io, 'Staging…', async root => outcome(await runGit(io, root, ['add', '-A', '--', ...paths]), `Staged ${describe(paths)}`))

export const unstage = (io: Io, paths: readonly string[]): Promise<boolean> =>
  operate(io, 'Unstaging…', async root => {
    const hasHead = (await S.pick(io, 'snapshot'))?.baseRev !== EMPTY_TREE
    const args = hasHead ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths]

    return outcome(await runGit(io, root, args), `Unstaged ${describe(paths)}`)
  })

export const stageFile = (io: Io, file: ChangedFile) => stage(io, pathsOf(file))
export const unstageFile = (io: Io, file: ChangedFile) => unstage(io, pathsOf(file))

/** Throws away a file's changes, back to HEAD, on a second press. */
export const discard = async (io: Io, file: ChangedFile): Promise<void> => {
  if (!(await confirmed(io, `discard:${file.path}`))) return
  const isDone = await operate(io, 'Discarding…', async root => {
    for (const args of discardCommands(file)) {
      const result = await runGit(io, root, args)
      if (result.exitCode !== 0) return outcome(result, '')
    }

    return { ok: true, text: `Discarded the changes to ${file.path}` }
  })
  if (isDone) await back(io)
}

export const setMessage = (io: Io, message: string) => putGit(io, git => ({ ...git, message }))

/** Amend on: the message starts as the last commit's, when none is written yet. */
export const toggleAmend = async (io: Io): Promise<void> => {
  const { amend, message } = await S.pick(io, 'git')
  let next = message
  if (!amend && message.trim() === '') {
    const last = await runGit(io, await rootOf(io), ['log', '-1', '--format=%B']).catch(() => null)
    if (last !== null && last.exitCode === 0) next = last.stdout.trim()
  }
  await putGit(io, git => ({ ...git, amend: !amend, message: next }))
}

/** Why the session's model wrote no message, in words for the status line. */
const NO_MESSAGE: Record<string, string> = {
  'nothing-to-fork': 'Claude has not answered yet in this session: there is no conversation to write the message from.',
  'empty-reply': 'Claude replied with nothing. Try again.',
  aborted: 'Writing the message was stopped.',
}

/** Asks Claude, over this conversation, for the message of what is staged, and puts it in the field to edit. */
export const writeMessage = async (io: Io): Promise<void> => {
  const { amend } = await S.pick(io, 'git')
  const staged = ((await S.pick(io, 'snapshot'))?.files ?? []).filter(file => file.staged)
  if (staged.length === 0 && !amend) {
    await putGit(io, git => ({ ...git, notice: { ok: false, text: 'Stage the files to commit first.' } }))
    return
  }
  await operate(io, 'Claude is writing the message…', async root => {
    // An amend's message covers the whole commit it replaces: the staged changes on top of HEAD's parent.
    const base = amend ? ['HEAD^'] : []
    const [stat, diff, log, last] = await Promise.all([
      runGit(io, root, ['diff', '--cached', '--stat', ...base]),
      runGit(io, root, ['diff', '--cached', ...base]),
      runGit(io, root, ['log', '-8', '--format=%s']),
      amend ? runGit(io, root, ['log', '-1', '--format=%B']) : Promise.resolve(null),
    ])
    if (diff.exitCode !== 0) return outcome(diff, '')
    const prompt = messagePrompt({
      stat: stat.stdout,
      diff: diff.stdout,
      subjects: log.exitCode === 0 ? log.stdout.split('\n').filter(line => line.trim() !== '') : [],
      amend: last !== null && last.exitCode === 0 ? last.stdout.trim() : null,
    })
    const reply = await io.fork(prompt)
    if ('reason' in reply) return { ok: false, text: NO_MESSAGE[reply.reason] ?? `Claude could not write the message (${reply.reason}).` }
    const message = cleanMessage(reply.text)
    if (message === '') return { ok: false, text: NO_MESSAGE['empty-reply'] ?? '' }
    await putGit(io, git => ({ ...git, message }))

    return { ok: true, text: 'Claude wrote the message. Edit it, then commit.' }
  })
}

/** Commits what is staged with the written message; then pushes, for Commit & push. */
export const commit = async (io: Io, thenPush = false): Promise<void> => {
  const { message, amend } = await S.pick(io, 'git')
  const staged = ((await S.pick(io, 'snapshot'))?.files ?? []).filter(file => file.staged)
  if (message.trim() === '') {
    await putGit(io, git => ({ ...git, notice: { ok: false, text: 'Write a commit message first.' } }))
    return
  }
  if (staged.length === 0 && !amend) {
    await putGit(io, git => ({ ...git, notice: { ok: false, text: 'Stage the files to commit first.' } }))
    return
  }
  const isDone = await operate(io, 'Committing…', async root => {
    const args = amend ? ['commit', '--amend', '-F', '-'] : ['commit', '-F', '-']
    const result = await runGit(io, root, args, { stdin: message.trim() + '\n' })
    if (result.exitCode !== 0) return outcome(result, '')
    const head = await runGit(io, root, ['log', '-1', '--format=%h %s'])

    return { ok: true, text: `${amend ? 'Amended' : 'Committed'} ${head.stdout.trim()}` }
  })
  if (!isDone) return
  await putGit(io, git => ({ ...git, message: '', amend: false }))
  if (thenPush) await push(io)
}

/** The arguments of a push: a branch without an upstream gets one on the first remote. */
const pushArgs = async (io: Io, root: string, force: boolean): Promise<string[] | Outcome> => {
  const snap = await S.pick(io, 'snapshot')
  if (snap?.upstream !== undefined) return force ? ['push', '--force-with-lease', '--force-if-includes'] : ['push']
  const remotes = (await runGit(io, root, ['remote'])).stdout.split('\n').map(r => r.trim()).filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (remote === undefined) return { ok: false, text: 'This repository has no remote to push to.' }

  return ['push', '-u', remote, 'HEAD']
}

/** Pushes the branch; a force push (with lease) on a second press. */
export const push = async (io: Io, force = false): Promise<void> => {
  if (force && !(await confirmed(io, 'force'))) return
  const isDone = await operate(io, force ? 'Force pushing…' : 'Pushing…', async root => {
    const args = await pushArgs(io, root, force)
    if (!Array.isArray(args)) return args
    const snap = await S.pick(io, 'snapshot')

    return outcome(await runGit(io, root, args, { timeoutMs: NETWORK_MS }), `${force ? 'Force pushed' : 'Pushed'} ${snap?.branch ?? ''}`.trim())
  })
  if (isDone) await refreshPr(io)
}

/** Pulls fast-forward only: a diverged branch is left for the person to settle. */
export const pull = (io: Io) =>
  operate(io, 'Pulling…', async root => outcome(await runGit(io, root, ['pull', '--ff-only'], { timeoutMs: NETWORK_MS }), 'Pulled', true))

export const fetch = (io: Io) =>
  operate(io, 'Fetching…', async root => outcome(await runGit(io, root, ['fetch'], { timeoutMs: NETWORK_MS }), 'Fetched'))

/** Undoes the last (unpushed) commit on a second press; its changes stay staged. */
export const undoCommit = async (io: Io): Promise<void> => {
  if (!(await confirmed(io, 'undo'))) return
  await operate(io, 'Undoing…', async root =>
    outcome(await runGit(io, root, ['reset', '--soft', 'HEAD~1']), 'Undid the last commit. Its changes are staged.'),
  )
}

// Pull requests -------------------------------------------------------------------------

/** Asks once whether `gh` is there and signed in, and which branch PRs go to. */
export const checkGh = async (io: Io): Promise<void> => {
  const known = await S.pick(io, 'git')
  if (known.hasGh !== null) return
  const root = await rootOf(io)
  const auth = await io.run(['gh', 'auth', 'status'], root, { timeoutMs: 15_000 }).catch(() => null)
  const target = await defaultBranch(gitOf(io), root).catch(() => null)
  await putGit(io, git => ({ ...git, hasGh: auth !== null && auth.exitCode === 0, base: target === null ? null : target.replace(/^origin\//, '') }))
  await refreshPr(io)
}

/** Reads the branch's PR, when `gh` can: on opening the pane and after a push. */
export const refreshPr = async (io: Io): Promise<void> => {
  if ((await S.pick(io, 'git')).hasGh !== true) return
  const view = await io.run(['gh', 'pr', 'view', '--json', 'number,url,state,isDraft'], await rootOf(io), { timeoutMs: 20_000 }).catch(() => null)
  const pr = view !== null && view.exitCode === 0 ? parsePrView(view.stdout) : null
  // gh answers this when no remote is on GitHub: no PR can be made here.
  const isGithub = view === null || !/none of the git remotes/i.test(view.stderr)
  await putGit(io, git => ({ ...git, pr, hasGh: isGithub }))
}

/** Opens the PR form: title from the last commit, the description from the repository's template. */
export const openPrForm = async (io: Io): Promise<void> => {
  const root = await rootOf(io)
  const gitDir = (await runGit(io, root, ['rev-parse', '--absolute-git-dir'])).stdout.trim()
  const templates = findTemplates(await listAll(gitOf(io), root).catch(() => []))
  const template = templates[0] ?? null
  const body = template === null ? '' : await io.readText(`${root}/${template}`).catch(() => '')
  const bodyFile = `${gitDir}/PR_EDITMSG.md`
  await io.writeText(bodyFile, body)
  const title = (await runGit(io, root, ['log', '-1', '--format=%s'])).stdout.trim()
  const base = (await S.pick(io, 'git')).base ?? 'main'
  await io.set(state => ({
    ...state,
    screen: 'pr',
    prForm: { title, base, draft: false, templates, template, bodyFile, body },
    git: { ...state.git, notice: null },
  }))
  await io.scroll({ to: 'start', in: S.PANE }).catch(() => undefined)
}

export const editPrForm = (io: Io, change: (form: PrForm) => PrForm) =>
  S.put(io, 'prForm', form => (form === null ? null : change(form)))

/** Starts the description again from another template. */
export const chooseTemplate = async (io: Io, template: string): Promise<void> => {
  const form = await S.pick(io, 'prForm')
  if (form === null) return
  const body = await io.readText(`${await rootOf(io)}/${template}`).catch(() => '')
  await io.writeText(form.bodyFile, body)
  await editPrForm(io, f => ({ ...f, template, body }))
}

/** Opens the description in the person's editor; the form reads it back as the pane refreshes. */
export const editPrBody = async (io: Io): Promise<void> => {
  const form = await S.pick(io, 'prForm')
  if (form === null) return
  io.toast((await openExternal(io, form.bodyFile)) ? 'Edit the description, save it, and come back' : 'Could not open an editor')
}

const reloadPrBody = async (io: Io): Promise<void> => {
  const form = await S.pick(io, 'prForm')
  if (form === null || (await S.pick(io, 'screen')) !== 'pr') return
  const body = await io.readText(form.bodyFile).catch(() => form.body)
  if (body !== form.body) await editPrForm(io, f => ({ ...f, body }))
}

/** Pushes the branch when the remote lacks it, then creates the PR with `gh`. */
export const createPr = async (io: Io): Promise<void> => {
  const form = await S.pick(io, 'prForm')
  if (form === null) return
  if (form.title.trim() === '') {
    await putGit(io, git => ({ ...git, notice: { ok: false, text: 'Write a title first.' } }))
    return
  }
  const isDone = await operate(io, 'Creating the PR…', async root => {
    const snap = await S.pick(io, 'snapshot')
    if (snap?.upstream === undefined || (snap.ahead ?? 0) > 0) {
      const args = await pushArgs(io, root, false)
      if (!Array.isArray(args)) return args
      const pushed = await runGit(io, root, args, { timeoutMs: NETWORK_MS })
      if (pushed.exitCode !== 0) return outcome(pushed, '')
    }
    const args = ['pr', 'create', '--title', form.title.trim(), '--body-file', form.bodyFile, '--base', form.base.trim() || 'main']
    if (form.draft) args.push('--draft')
    const created = await io.run(['gh', ...args], root, { timeoutMs: NETWORK_MS })
    if (created.exitCode !== 0) return outcomeOf(false, `${created.stderr}\n${created.stdout}`, 'gh pr create failed')
    const url = created.stdout.trim().split('\n').pop() ?? ''

    return { ok: true, text: `Created ${url}` }
  })
  if (!isDone) return
  await io.set(state => ({ ...state, screen: 'tree', prForm: null }))
  await refreshPr(io)
}

/** Opens the history screen and reads the recent commits. */
export const showLog = async (io: Io): Promise<void> => {
  await S.put(io, 'screen', () => 'log')
  await io.scroll({ to: 'start', in: S.PANE }).catch(() => undefined)
  const log = await listCommits(gitOf(io), await rootOf(io)).catch(() => [])
  await S.put(io, 'log', () => log)
}

/** Shows one past commit in the tree, or the working changes again (null). */
export const showCommit = async (io: Io, commit: CommitInfo | null): Promise<void> => {
  await io.set(state => ({ ...state, commit, preview: null, screen: 'tree', allFiles: null }))
  await io.scroll({ to: 'start', in: S.PANE }).catch(() => undefined)
  await refresh(io)
}

/** Opens the filter with the cursor in it, or closes it. */
export const toggleFilter = async (io: Io): Promise<void> => {
  const filter = await S.put(io, 'filter', value => (value === null ? '' : null))
  if (filter !== null) await io.focus({ requestId: S.PANE, key: 'filter-input' }).catch(() => undefined)
}

export const back = async (io: Io): Promise<void> => {
  const shown = await S.pick(io, 'preview')
  await S.put(io, 'screen', () => 'tree')
  if (shown === null) return
  const key = `row:${shown.path}`
  await io.scroll({ to: { key }, in: S.PANE, block: 'center' }).catch(() => undefined)
  await io.focus({ requestId: S.PANE, key }).catch(() => undefined)
}

/** Moves to the next (1) or previous (-1) changed file in review order. */
export const step = async (io: Io, delta: 1 | -1): Promise<void> => {
  const snap = await S.pick(io, 'snapshot')
  if (snap === null) return
  const order = reviewOrder(snap.files)
  if (order.length === 0) return
  const shown = await S.pick(io, 'preview')
  const at = shown === null ? -1 : order.indexOf(shown.path)
  const index = at < 0 ? (delta === 1 ? 0 : order.length - 1) : Math.min(Math.max(at + delta, 0), order.length - 1)
  const path = order[index]
  if (path === undefined || (at === index && shown !== null)) return
  const file = snap.files.find(f => f.path === path)
  const keep = shown !== null && modesFor(path, file).includes(shown.mode) ? shown.mode : undefined
  await openFile(io, path, keep)
}

export const toggleDir = async (io: Io, path: string, isOpenNow: boolean): Promise<void> => {
  const without = (list: string[]) => list.filter(p => p !== path)
  await io.set(state => ({
    ...state,
    collapsed: isOpenNow ? [...without(state.collapsed), path] : without(state.collapsed),
    expanded: isOpenNow ? without(state.expanded) : [...without(state.expanded), path],
  }))
}

export const toggleView = async (io: Io): Promise<void> => {
  const next = (await S.pick(io, 'view')) === 'all' ? 'changes' : 'all'
  await S.put(io, 'view', () => next)
  await savePrefs(io)
  if (next === 'all') await refresh(io)
}

/** The order v walks the comparisons in. */
export const BASE_ORDER: readonly BaseMode[] = ['head', 'branch', 'prompt']

export const toggleBase = async (io: Io): Promise<void> => {
  await S.put(io, 'baseMode', mode => BASE_ORDER[(BASE_ORDER.indexOf(mode) + 1) % BASE_ORDER.length] ?? 'head')
  await savePrefs(io)
  await refresh(io)
}

export const openPane = async (io: Io): Promise<boolean> => {
  const opened = await io.open({ id: S.PANE, title: 'Files', focus: true, columns: 64, rows: 26 })
  await S.put(io, 'isOpen', () => opened.isPlaced)
  if (opened.isPlaced) void refresh(io).then(() => checkGh(io)).catch(() => undefined)

  return opened.isPlaced
}

export const closePane = async (io: Io): Promise<void> => {
  await io.close(S.PANE).catch(() => undefined)
  await S.put(io, 'isOpen', () => false)
}
