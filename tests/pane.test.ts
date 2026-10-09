import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const ROOT = '/repo'

const DIFF = [
  'diff --git a/app/Http/Landing.php b/app/Http/Landing.php',
  'index 1111111..2222222 100644',
  '--- a/app/Http/Landing.php',
  '+++ b/app/Http/Landing.php',
  '@@ -1,3 +1,4 @@',
  ' <?php',
  '+// the change under review',
  ' class Landing {}',
  ' ',
  '',
].join('\n')

/** What each git command answers in a repository with three changes. */
const GIT: Record<string, { exitCode?: number; stdout: string }> = {
  'rev-parse --show-toplevel': { stdout: `${ROOT}\n` },
  'branch --show-current': { stdout: 'feature/landing\n' },
  'rev-parse --verify --quiet HEAD': { stdout: 'abc\n' },
  'rev-parse --short HEAD': { stdout: 'abc\n' },
  'status --porcelain=v1 -z --untracked-files=all': {
    stdout: ' M app/Http/Landing.php\0?? docs/NOTES.md\0 D old.txt\0',
  },
  'diff --numstat -z -M HEAD': { stdout: '1\t0\tapp/Http/Landing.php\0' + '0\t5\told.txt\0' },
  'diff --no-color -M HEAD -- app/Http/Landing.php': { stdout: DIFF },
  'rev-parse --abbrev-ref --symbolic-full-name @{u}': { stdout: 'origin/feature/landing\n' },
  'rev-list --left-right --count HEAD...@{u}': { stdout: '2\t1\n' },
  'show --name-only --format= --no-renames HEAD': { stdout: 'app/Http/Landing.php\n' },
  'log -n50 --format=%H%x1f%h%x1f%ar%x1f%s': { stdout: 'def1234567\x1fdef1234\x1f2 days ago\x1fAdd the landing\n' },
  'rev-parse --verify --quiet def1234567^': { stdout: 'abc\n' },
  'diff --name-status -z -M abc def1234567': { stdout: 'A\0app/Landing.php\0' },
  'diff --numstat -z -M abc def1234567': { stdout: '5\t0\tapp/Landing.php\0' },
  'show def1234567:app/Landing.php': { stdout: '<?php // as committed\n' },
  'ls-files -z --cached --others --exclude-standard': {
    stdout: 'app/Http/Landing.php\0app/Models/User.php\0docs/NOTES.md\0old.txt\0',
  },
}

const PANE_PROPS = {
  title: 'Files',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/** Commands other than git the plugin ran, such as `open`. */
let opened: string[][] = []

/** Every git and gh command the plugin ran (git's `-c` pairs dropped, gh's prefixed `gh `), with its stdin. */
let ran: { args: string; stdin?: string }[] = []

/** Answers a test puts over GIT, such as a status after a stage. */
let answers: Record<string, { exitCode?: number; stdout: string }> = {}

/** Files the plugin wrote. */
let written: { path: string; text: string }[] = []

const didRun = (args: string) => ran.some(entry => entry.args === args)

/** The engine beneath the plugin: git, the disk, the pane and the session, from memory. */
const world = (on: On) => {
  opened = []
  ran = []
  answers = {}
  written = []
  mock.store(on)
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const [command, ...rest] = e.argv
    if (command === 'open') {
      opened.push([...e.argv])

      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (command === 'wc') return { value: { exitCode: 0, stdout: '      3 docs/NOTES.md\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // Drop git's `-c key=value` pairs.
    const args = command === 'gh' ? `gh ${rest.join(' ')}` : rest.filter((arg, i) => arg !== '-c' && rest[i - 1] !== '-c').join(' ')
    ran.push({ args, ...(e.init?.stdin !== undefined ? { stdin: e.init.stdin } : {}) })
    const answer = answers[args] ?? GIT[args] ?? { exitCode: 1, stdout: '' }

    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 40, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: '# Notes\n\nSome *markdown*.\n\n| Key | Value |\n| --- | --- |\n| a | `1` |\n' }))
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'files',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

test('the tree lists the changes, colored by kind, folders folded', async ($, on) => {
  world(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-file-tree', surface, component: 'Pane', requestId: 'files', props: PANE_PROPS })
    expect((await ui.find({ key: 'row:app/Http/' }))?.text).toContain('app/Http/')
    expect((await ui.find({ key: 'row:app/Http/Landing.php' }))?.text).toMatch(/M Landing\.php \+1/)
    expect((await ui.find({ key: 'row:docs/NOTES.md' }))?.text).toMatch(/U NOTES\.md \+3/)
    expect((await ui.find({ key: 'row:old.txt' }))?.text).toMatch(/D old\.txt −5/)
    expect(await ui.find({ type: 'Text', text: /feature\/landing/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a file opens on its diff, and Back returns to the tree', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await ui.press({ key: 'row:app/Http/Landing.php' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('+// the change under review')
  expect(code?.text.startsWith('@@ -1,3 +1,4 @@')).toBe(true)
  expect(await ui.find({ key: 'mode:source' })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ key: 'row:app/Http/Landing.php' })).toBeDefined()
})

test('markdown renders, and the source view is one press away', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await ui.press({ key: 'row:docs/NOTES.md' })
  expect(await ui.find({ type: 'Text', text: 'Notes' })).toBeDefined()
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Some *markdown*.')
  expect(await ui.find({ type: 'Text', text: /^┌─+┬─+┐$/ })).toBeDefined()
  await ui.press({ key: 'mode:source' })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('Some *markdown*.')
})

test('next walks the changes in tree order', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await ui.press({ key: 'row:app/Http/Landing.php' })
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: 'NOTES.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/3/ })).toBeDefined()
})

test('all files shows unchanged files too', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  expect(await ui.find({ key: 'row:app/Models/' })).toBeUndefined()
  expect((await ui.find({ key: 'view' }))?.text).toBe('Changed · All')
  await ui.press({ key: 'view' })
  const models = await ui.find({ key: 'row:app/Models/' })
  expect(models).toBeDefined()
  await ui.press({ key: 'row:app/Models/' })
  expect(await ui.find({ key: 'row:app/Models/User.php' })).toBeDefined()
})

test('f opens the filter, and closes it again', async ($, on) => {
  world(on)
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'filter' })
  expect(await ui.find({ key: 'filter-input' })).toBeDefined()
  await ui.press({ key: 'filter' })
  expect(await ui.find({ key: 'filter-input' })).toBeUndefined()
})

test('the footer button counts the changes and opens or hides the pane', async ($, on) => {
  world(on)
  await start($)
  // The pane's first drawing waits for the first git read; the footer draws from the same state.
  const pane = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  expect(await pane.find({ key: 'row:old.txt' })).toBeDefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const footer = await $.ui.mount({ plugin: 'git-file-tree', surface, component: 'SessionMode', props: { modes: ['auto mode'] } })
    expect(await footer.find({ type: 'Text', text: 'auto mode' })).toBeDefined()
    const toggle = await footer.find({ key: 'toggle' })
    expect(toggle?.text).toMatch(/Hide files/)
    expect(toggle?.text).toMatch(/1M/)
    await footer.unmount()
  }

  const footer = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  await footer.press({ key: 'toggle' })
  expect((await footer.find({ key: 'toggle' }))?.text).toMatch(/^▤ Files/)
})

test('the header shows the upstream and how far apart they are', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: / → origin\/feature\/landing/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ↑2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' ↓1' })).toBeDefined()
})

test('a file Claude reads shows in the tree, its folder opened, marked purple', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: {}, text: '' }) as never)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  expect(await ui.find({ key: 'row:app/Models/User.php' })).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: '/repo/app/Models/User.php' } as never)
  const row = await ui.find({ key: 'row:app/Models/User.php' })
  expect(row?.text).toMatch(/User\.php ●$/)
})

test('a commit marks the committed files green', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: {}, text: '[feature/landing abc] x' }) as never)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m x' } as never)
  const row = await ui.find({ key: 'row:app/Http/Landing.php' })
  expect(row?.text).toMatch(/●$/)
})

test('Open hands the file to the system', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await ui.press({ key: 'row:docs/NOTES.md' })
  await ui.press({ key: 'open-app' })
  expect(opened).toEqual([['open', '/repo/docs/NOTES.md']])
})

test('Prompt shows what changed since the last prompt, untracked files in', async ($, on) => {
  world(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  for (const name of ['prompt', 'now']) answers[`rev-parse --git-path index --git-path git-file-tree-${name}.index`] = { stdout: `.git/index\n.git/git-file-tree-${name}.index\n` }
  answers['add -A'] = { stdout: '' }
  answers['write-tree'] = { stdout: 'tree1\n' }
  await start($)
  const ui = await mountPane($)

  // Claude creates one file and edits another; the tree as it is now is tree2.
  answers['write-tree'] = { stdout: 'tree2\n' }
  answers['diff --name-status -z -M tree1 tree2'] = { stdout: 'A\0created.txt\0M\0app/Http/Landing.php\0' }
  answers['diff --numstat -z -M tree1 tree2'] = { stdout: '3\t0\tcreated.txt\0' }
  await ui.press({ key: 'base' })
  await ui.press({ key: 'base' })
  expect((await ui.find({ key: 'base' }))?.text).toBe('Uncommitted · Branch · Prompt')
  expect(await ui.find({ type: 'Text', text: 'since the session start' })).toBeDefined()
  expect((await ui.find({ key: 'row:created.txt' }))?.text).toMatch(/A created\.txt \+3/)
  expect(await ui.find({ key: 'row:old.txt' })).toBeUndefined()
  expect(await ui.find({ key: 'stage-all' })).toBeUndefined()

  // A new prompt: the base moves to the files as they are then.
  await $.prompt.submit({ text: 'next' } as never)
  answers['diff --name-status -z -M tree2 tree2'] = { stdout: '' }
  answers['diff --numstat -z -M tree2 tree2'] = { stdout: '' }
  for (let i = 0; i < 3; i++) await ui.press({ key: 'base' })
  expect(await ui.find({ type: 'Text', text: '✓ No changes since your last prompt' })).toBeDefined()
})

const TWO_COMMITS = 'aaa1111111\x1faaa1111\x1f1 hour ago\x1fFix the landing\nddd2222222\x1fddd2222\x1f2 days ago\x1fAdd the landing\n'

test('history puts the commits not pushed above those the upstream has', async ($, on) => {
  world(on)
  answers['log -n50 --format=%H%x1f%h%x1f%ar%x1f%s'] = { stdout: TWO_COMMITS }
  answers['rev-list --max-count=50 @{u}..HEAD'] = { stdout: 'aaa1111111\n' }
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'history' })
  expect(await ui.find({ type: 'Text', text: 'Not pushed 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'On origin/feature/landing' })).toBeDefined()
  expect(await ui.find({ key: 'commit:aaa1111111' })).toBeDefined()
  expect(await ui.find({ key: 'commit:ddd2222222' })).toBeDefined()
})

test('with no upstream, history compares with every remote branch', async ($, on) => {
  world(on)
  answers['rev-parse --abbrev-ref --symbolic-full-name @{u}'] = { exitCode: 128, stdout: '' }
  answers['remote'] = { stdout: 'origin\n' }
  answers['log -n50 --format=%H%x1f%h%x1f%ar%x1f%s'] = { stdout: TWO_COMMITS }
  answers['rev-list --max-count=50 HEAD --not --remotes'] = { stdout: 'aaa1111111\nddd2222222\n' }
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'history' })
  expect(await ui.find({ type: 'Text', text: 'Not pushed 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'On the remote' })).toBeUndefined()
})

test('history shows a past commit, and Working changes comes back', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })
  await ui.press({ key: 'history' })
  expect((await ui.find({ key: 'commit:def1234567' }))?.text).toMatch(/def1234 Add the landing {2}2 days ago/)
  await ui.press({ key: 'commit:def1234567' })
  expect(await ui.find({ type: 'Text', text: 'def1234 Add the landing' })).toBeDefined()
  expect((await ui.find({ key: 'row:app/Landing.php' }))?.text).toMatch(/A Landing\.php \+5/)
  expect(await ui.find({ key: 'row:old.txt' })).toBeUndefined()
  await ui.press({ key: 'row:app/Landing.php' })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('<?php // as committed')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'base' })
  expect(await ui.find({ key: 'row:old.txt' })).toBeDefined()
})

const STATUS = 'status --porcelain=v1 -z --untracked-files=all'

const mountPane = ($: Engine) => $.ui.mount({ plugin: 'git-file-tree', surface: 'terminal', component: 'Pane', requestId: 'files', props: PANE_PROPS })

test('+ stages a file; it moves to Staged, where − unstages it', async ($, on) => {
  world(on)
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'stage-all' })).toBeDefined()
  expect(await ui.find({ key: 'message' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Nothing staged: press + before a file, or Stage all, to choose what to commit.' })).toBeDefined()

  answers[STATUS] = { stdout: ' M app/Http/Landing.php\0A  docs/NOTES.md\0 D old.txt\0' }
  answers['add -A -- docs/NOTES.md'] = { stdout: '' }
  answers['restore --staged -- docs/NOTES.md'] = { stdout: '' }
  await ui.press({ key: 'stage:docs/NOTES.md' })
  expect(didRun('add -A -- docs/NOTES.md')).toBe(true)
  expect(await ui.find({ key: 'staged:docs/NOTES.md' })).toBeDefined()
  expect(await ui.find({ key: 'row:docs/NOTES.md' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '✓ Staged docs/NOTES.md' })).toBeDefined()
  expect(await ui.find({ key: 'message' })).toBeDefined()

  await ui.press({ key: 'unstage:docs/NOTES.md' })
  expect(didRun('restore --staged -- docs/NOTES.md')).toBe(true)
})

test('a folder stages as a whole', async ($, on) => {
  world(on)
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'stage:app/Http/' })
  expect(didRun('add -A -- app/Http/')).toBe(true)
})

test('commit sends the message on stdin; an empty message is refused', async ($, on) => {
  world(on)
  answers[STATUS] = { stdout: 'M  app/Http/Landing.php\0' }
  answers['log -1 --format=%h %s'] = { stdout: 'fed9876 Fix the landing\n' }
  await start($)
  const ui = await mountPane($)

  await ui.press({ key: 'commit' })
  expect(ran.some(entry => entry.args.startsWith('commit'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: '✗ Write a commit message first.' })).toBeDefined()

  answers['commit -F -'] = { stdout: '' }
  await ui.input({ key: 'message', text: 'Fix the landing' })
  expect(ran.find(entry => entry.args === 'commit -F -')?.stdin).toBe('Fix the landing\n')
  expect(await ui.find({ type: 'Text', text: '✓ Committed fed9876 Fix the landing' })).toBeDefined()
})

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('Write message asks Claude over the conversation and fills the field', async ($, on) => {
  world(on)
  const prompts: string[] = []
  on('model.fork', (_$, e) => {
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: '```\nFix the landing\n```', usage: USAGE } } as never
  })
  answers[STATUS] = { stdout: 'M  app/Http/Landing.php\0' }
  answers['diff --cached --stat'] = { stdout: ' app/Http/Landing.php | 2 +-\n' }
  answers['diff --cached'] = { stdout: '@@ -1 +1 @@\n-old\n+new\n' }
  answers['log -8 --format=%s'] = { stdout: 'Add commit history view\nRewrite README\n' }
  await start($)
  const ui = await mountPane($)

  await ui.press({ key: 'write-message' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('+new')
  expect(prompts[0]).toContain('- Add commit history view')
  expect((await ui.find({ key: 'message' }))?.text).toContain('Fix the landing')
  expect(await ui.find({ type: 'Text', text: '✓ Claude wrote the message. Edit it, then commit.' })).toBeDefined()
})

test('Write message says so when there is no conversation yet', async ($, on) => {
  world(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }) as never)
  answers[STATUS] = { stdout: 'M  app/Http/Landing.php\0' }
  answers['diff --cached'] = { stdout: '+new\n' }
  await start($)
  const ui = await mountPane($)

  await ui.press({ key: 'write-message' })
  expect(await ui.find({ type: 'Text', text: '✗ Claude has not answered yet in this session: there is no conversation to write the message from.' })).toBeDefined()
  expect((await ui.find({ key: 'message' }))?.text ?? '').not.toContain('new')
})

test('amend fills in the last message', async ($, on) => {
  world(on)
  answers[STATUS] = { stdout: 'M  app/Http/Landing.php\0' }
  answers['log -1 --format=%B'] = { stdout: 'Add the landing\n\n' }
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'amend' })
  expect((await ui.find({ key: 'message' }))?.text).toContain('Add the landing')
  expect((await ui.find({ key: 'commit' }))?.text).toBe('Amend')
})

test('a diverged branch offers a force push, which needs a second press', async ($, on) => {
  world(on)
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'push' })).toBeUndefined()
  expect(await ui.find({ key: 'pull' })).toBeUndefined()

  await ui.press({ key: 'force-push' })
  expect(ran.some(entry => entry.args.startsWith('push'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: 'Press again to force push' })).toBeDefined()

  await ui.press({ key: 'force-push' })
  expect(didRun('push --force-with-lease --force-if-includes')).toBe(true)
})

test('a branch with no upstream pushes to origin and sets it', async ($, on) => {
  world(on)
  answers['rev-parse --abbrev-ref --symbolic-full-name @{u}'] = { exitCode: 128, stdout: '' }
  answers['remote'] = { stdout: 'origin\n' }
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ key: 'fetch' })).toBeUndefined()
  await ui.press({ key: 'push' })
  expect(didRun('push -u origin HEAD')).toBe(true)
})

test('discard in the preview needs a second press', async ($, on) => {
  world(on)
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'row:app/Http/Landing.php' })
  expect((await ui.find({ key: 'stage-toggle' }))?.text).toBe('Stage')
  await ui.press({ key: 'discard' })
  expect(ran.some(entry => entry.args.startsWith('restore'))).toBe(false)
  await ui.press({ key: 'discard' })
  expect(didRun('restore --source=HEAD --staged --worktree -- app/Http/Landing.php')).toBe(true)
})

test('Create PR starts from the template, pushes, and runs gh', async ($, on) => {
  world(on)
  answers['gh auth status'] = { stdout: '' }
  answers['rev-list --left-right --count HEAD...@{u}'] = { stdout: '2\t0\n' }
  answers['symbolic-ref --quiet --short refs/remotes/origin/HEAD'] = { stdout: 'origin/main\n' }
  answers['rev-parse --absolute-git-dir'] = { stdout: '/repo/.git\n' }
  answers['log -1 --format=%s'] = { stdout: 'Add the landing\n' }
  answers['ls-files -z --cached --others --exclude-standard'] = {
    stdout: 'app/Http/Landing.php\0.github/pull_request_template.md\0docs/NOTES.md\0',
  }
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'pr-create' })
  expect((await ui.find({ key: 'pr-title' }))?.text).toContain('Add the landing')
  expect((await ui.find({ key: 'pr-base' }))?.text).toContain('main')
  expect(written.find(file => file.path === '/repo/.git/PR_EDITMSG.md')?.text).toContain('# Notes')
  expect(await ui.find({ type: 'Text', text: 'Notes' })).toBeDefined()

  answers['push'] = { stdout: '' }
  answers['gh pr create --title Add the landing --body-file /repo/.git/PR_EDITMSG.md --base main --draft'] = {
    stdout: 'https://github.com/o/r/pull/7\n',
  }
  await ui.press({ key: 'pr-draft' })
  await ui.press({ key: 'pr-submit' })
  expect(didRun('push')).toBe(true)
  expect(didRun('gh pr create --title Add the landing --body-file /repo/.git/PR_EDITMSG.md --base main --draft')).toBe(true)
  expect(await ui.find({ type: 'Text', text: '✓ Created https://github.com/o/r/pull/7' })).toBeDefined()
})
