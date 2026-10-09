import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import * as A from './actions'
import type { Io } from './actions'
import * as S from './state'
import { renderFooter, renderPane } from './view'

/** How often git is read while the pane is open; four times slower while it is closed. */
const POLL_MS = 3000

const ui = atom({ plugin: 'git-file-tree', key: 'ui' } as const, S.INITIAL)
// The session keeps this value across reloads: a field added since it was written reads as its default.

export const register: Register = on => {
  let ticks = 0
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
    const tool = String(e.tool)
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
      const path = (e as { file_path?: unknown }).file_path
      void A.noteEdit(io, typeof path === 'string' ? path : null).catch(() => undefined)
    } else if (tool === 'NotebookEdit') {
      const path = (e as { notebook_path?: unknown }).notebook_path
      void A.noteEdit(io, typeof path === 'string' ? path : null).catch(() => undefined)
    } else if (tool === 'Read') {
      const path = (e as { file_path?: unknown }).file_path
      if (typeof path === 'string') void A.noteRead(io, path).catch(() => undefined)
    } else if (tool === 'Bash') {
      const command = (e as { command?: unknown }).command
      const done = result as { text?: string; isReadOnly?: true; isError?: true }
      void A.noteShell(io, typeof command === 'string' ? command : '', done.text ?? '', done.isReadOnly === true, done.isError === true)
        .catch(() => undefined)
    }

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

    return renderPane({ io: drawing, t: $.ui.resolve(e), e })
  })

  // The Files button, at the right of the prompt footer beside the mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (io === null) return next(e)
    const drawing: Io = { ...io, get: async () => ({ ...S.INITIAL, ...(await read($, ui)) }) }
    const footer = await renderFooter({ io: drawing, t: $.ui.resolve(e), e }, e.props.modes)

    return footer ?? next(e)
  })
}
