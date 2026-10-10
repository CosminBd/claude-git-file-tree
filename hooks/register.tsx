import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import * as A from './actions'
import type { Io } from './actions'
import * as S from './state'
import { renderFooter, renderPane } from './view'

/** How often git is read while the pane is open; four times slower while it is closed. */
const POLL_MS = 3000

/** How soon the tree follows a switch to a subagent's transcript, or back. */
const FOLLOW_MS = 250

const ui = atom({ plugin: 'git-file-tree', key: 'ui' } as const, S.INITIAL)
// The session keeps this value across reloads: a field added since it was written reads as its default.

export const register: Register = on => {
  let ticks = 0
  /** The transcript the pane's last drawing showed beside it: an agent id, null for the main one. */
  let wanted: string | null = null
  /** The transcript the tree follows now, as the ticker last set it; undefined until the first tick syncs it. */
  let followed: string | null | undefined
  /** The name the viewed agent is addressed by: a worktree named after it is its own. */
  let wantedName: string | null = null
  /** The engine's closures, built once the session starts; every hook after it works through them. */
  let io: Io | null = null

  on('session.start', async ($, e, next) => {
    const engine: Io = {
      get: async () => ({ ...S.INITIAL, ...(await read($, ui)) }),
      set: change => update($, ui, state => change({ ...S.INITIAL, ...state })),
      run: (argv, cwd, init) => $.process.run(argv, { ...(cwd === undefined ? {} : { cwd }), ...init }),
      now: () => $.clock.now(),
      writeText: (path, text) => $.fs.write(path, text),
      stat: path => $.fs.stat(path),
      readText: path => $.fs.read(path),
      readBase64: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      cwd: () => $.session.cwd(),
      scroll: args => $.ui.scroll(args),
      focus: args => $.ui.focus(args),
      open: args => $.ui.open(args),
      close: id => $.ui.close({ id }),
      toast: text => $.ui.toast(text),
      copy: async (text, surface) => (await $.ui.copy({ text, surface })).isCopied,
      fork: async prompt => {
        const reply = await $.model.fork({ prompt })

        return reply.isAnswered ? { text: reply.text } : { reason: reply.reason }
      },
    }
    io = engine

    await $.command.register({
      name: 'files',
      description: 'Open the git pane: changed files, diffs, commit and push',
      argumentHint: '[path]',
      immediate: true,
    })
    await A.loadPrefs(engine)
    void A.takePromptBase(engine, 'session').catch(() => undefined)
    void A.refresh(engine).catch(() => undefined)
    // Follows the transcript in view: the drawing notes it, this tick (outside any drawing) switches the tree.
    $.clock.every(FOLLOW_MS, () => {
      if (wanted === followed) return
      followed = wanted
      void A.followView(engine, wanted, wantedName).catch(() => undefined)
    })
    $.clock.every(POLL_MS, () => {
      ticks += 1
      void (async () => {
        await A.expireConfirm(engine)
        if ((await S.pick(engine, 'isOpen')) || ticks % 4 === 0) await A.refresh(engine)
      })().catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    if (io === null) return { text: 'The file tree is still starting.' }
    const isPlaced = await A.openPane(io)
    const target = e.args.trim()
    if (isPlaced && target !== '') {
      await A.refresh(io)
      const snap = await S.pick(io, 'snapshot')
      const cwd = await io.cwd()
      const absolute = target.startsWith('/') ? target : `${cwd}/${target}`
      const root = snap?.root ?? cwd
      const relative = absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1).replace(/^\.\//, '') : target
      await A.openFile(io, relative)
    }

    // No text: nothing of this reaches the model.
    return {}
  })

  // Each prompt starts a fresh record of what Claude reads, writes and commits.
  on('prompt.submit', async ($, e, next) => {
    if (io !== null) await A.clearActivity(io).catch(() => undefined)
    // Not awaited: the snapshot lands long before Claude's first edit, and the prompt goes at once.
    if (io !== null) void A.takePromptBase(io, 'prompt').catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  // After Claude's reads, edits and commands: mark the files and refresh, never holding up the tool.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (io === null) return result
    const engine = io
    const tool = String(e.tool)
    const agentId = (e as { agentId?: unknown }).agentId
    const filePath = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    const path = typeof filePath === 'string' ? filePath : null
    const isWrite = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit'

    // The main conversation's marks; a subagent's count there too when it works in the session's own tree.
    const noteMain = () => {
      if (isWrite) void A.noteEdit(engine, path).catch(() => undefined)
      else if (tool === 'Read' && path !== null) void A.noteRead(engine, path).catch(() => undefined)
      else if (tool === 'Bash') {
        const command = (e as { command?: unknown }).command
        const done = result as { text?: string; isReadOnly?: true; isError?: true }
        void A.noteShell(engine, typeof command === 'string' ? command : '', done.text ?? '', done.isReadOnly === true, done.isError === true)
          .catch(() => undefined)
      }
    }

    if (typeof agentId !== 'string') noteMain()
    else if (path !== null && (isWrite || tool === 'Read')) {
      void A.noteAgent(engine, agentId, isWrite ? 'write' : 'read', path)
        .then(async root => {
          if (root === (await A.sessionRoot(engine))) noteMain()
        })
        .catch(() => undefined)
    } else if (tool === 'Bash') void A.refresh(engine).catch(() => undefined)

    return result
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: 'files' }, async ($, e, next) => {
    const result = await next(e)
    await update($, ui, state => ({ ...state, isOpen: false }))

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'files' }, async ($, e, next) => {
    if (io === null) return next(e)
    // Reads go through this drawing's own `$`, so a later write draws it again.
    const drawing: Io = { ...io, get: async () => ({ ...S.INITIAL, ...(await read($, ui)) }) }
    // A drawing may not write, nor anything it starts: the follow tick of session.start makes the switch.
    const viewed = e.props.view.agentId ?? null
    const agent = viewed === null ? null : (await $.agent.list().catch(() => [])).find(info => info.id === viewed)
    // Both at once, so the tick never follows the agent without its name.
    wantedName = agent?.name ?? null
    wanted = viewed

    return renderPane({ io: drawing, t: $.ui.resolve(e), e, agentLabel: agent?.description ?? agent?.name ?? null })
  })

  // The Files button, at the right of the prompt footer beside the mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (io === null) return next(e)
    const drawing: Io = { ...io, get: async () => ({ ...S.INITIAL, ...(await read($, ui)) }) }
    const footer = await renderFooter({ io: drawing, t: $.ui.resolve(e), e }, e.props.modes)

    return footer ?? next(e)
  })
}
