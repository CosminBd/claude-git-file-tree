import type { ElementTable, RenderElement, RenderInput } from 'claude-code'

import type { Activity, ActivityKind, AgentWork, ChangedFile, CommitInfo, FileStatus, PreviewMode, Snapshot } from '../types'
import * as A from './actions'
import type { Io } from './actions'
import { displayWidth, layoutTable, parseBlocks } from './markdown'
import type { Span } from './markdown'
import * as S from './state'
import { ancestors, toRelative } from './activity'
import { prLabel } from './ops'
import { buildTree, flatten, matches, reviewOrder } from './tree'
import type { Row } from './tree'

/** A row's stage or unstage button, at the left of the row. */
type Gutter = { sign: '+' | '−'; paths: string[] } | null

/** What a drawing works from: the engine's closures (reads subscribing this drawing), the surface's elements, the input. */
export type Ctx = {
  io: Io
  t: ElementTable
  e: RenderInput
  /** What the subagent in view is doing, as its Agent call described it; null or absent for the main conversation. */
  agentLabel?: string | null
}

/** Rows drawn at most, so a huge expanded tree stays inside one drawing. */
const MAX_ROWS = 1500

const STATUS: Record<FileStatus, { letter: string; color: string; label: string }> = {
  modified: { letter: 'M', color: 'warning', label: 'modified' },
  added: { letter: 'A', color: 'success', label: 'added' },
  untracked: { letter: 'U', color: 'success', label: 'new' },
  deleted: { letter: 'D', color: 'error', label: 'deleted' },
  renamed: { letter: 'R', color: 'suggestion', label: 'renamed' },
  conflict: { letter: '!', color: 'error', label: 'conflict' },
}

/** What Claude did to a file, by color: reads and searches purple, writes orange, commits green. */
const ACTIVITY: Record<ActivityKind, { color: string }> = {
  read: { color: 'merged' },
  write: { color: 'claude' },
  commit: { color: 'success' },
}

/** The activity marks the rows draw: each file's latest, and the latest of all. */
type Marks = { byPath: Map<string, Activity>; latest: number; all: readonly Activity[] }

/** ● on the latest thing Claude did, • on the rest. */
const mark = (c: Ctx, entry: Activity | undefined, latest: number) => {
  const { Text } = c.t
  if (entry === undefined) return ''

  return <Text color={ACTIVITY[entry.kind].color} bold={entry.seq === latest}>{entry.seq === latest ? ' ●' : ' •'}</Text>
}

const MODE_LABEL: Record<PreviewMode, { label: string; hotkey: string }> = {
  diff: { label: 'Diff', hotkey: 'd' },
  source: { label: 'Source', hotkey: 's' },
  rendered: { label: 'Rendered', hotkey: 'm' },
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const dirname = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)

const totals = (files: readonly ChangedFile[]) => {
  const byStatus = new Map<FileStatus, number>()
  let added = 0
  let removed = 0
  for (const file of files) {
    byStatus.set(file.status, (byStatus.get(file.status) ?? 0) + 1)
    added += file.added ?? 0
    removed += file.removed ?? 0
  }

  return { byStatus, added, removed }
}

const ORDER: FileStatus[] = ['modified', 'added', 'untracked', 'renamed', 'deleted', 'conflict']

/** `3M 2U 1D  +120 −30`, each part in its status color: the Text children of a Button or Box. */
const summaryParts = (c: Ctx, files: readonly ChangedFile[]) => {
  const { Text } = c.t
  const { byStatus, added, removed } = totals(files)
  const parts = ORDER.filter(status => byStatus.has(status)).map(status => (
    <Text color={STATUS[status].color}>{` ${byStatus.get(status)}${STATUS[status].letter}`}</Text>
  ))
  if (added > 0) parts.push(<Text color="success">{`  +${added}`}</Text>)
  if (removed > 0) parts.push(<Text color="error">{` −${removed}`}</Text>)

  return parts
}

const stats = (c: Ctx, file: ChangedFile) => {
  const { Text } = c.t
  if (file.isBinary) return [<Text dimColor> binary</Text>]
  const parts = []
  if ((file.added ?? 0) > 0) parts.push(<Text color="success">{` +${file.added}`}</Text>)
  if ((file.removed ?? 0) > 0) parts.push(<Text color="error">{` −${file.removed}`}</Text>)

  return parts
}

/** The row with its stage (+) or unstage (−) button before it; a row that has neither keeps the column. */
const withGutter = (c: Ctx, row: Row, element: RenderElement, gutter: Gutter | undefined) => {
  const { Box, Button, Text } = c.t
  if (gutter === undefined) return element
  if (gutter === null) return <Box key={`line:${row.key}`}><Text>{'  '}</Text>{element}</Box>
  const isStage = gutter.sign === '+'

  return (
    <Box key={`line:${row.key}`}>
      <Button key={`${isStage ? 'stage' : 'unstage'}:${row.path}`} plain onPress={() => (isStage ? A.stage(c.io, gutter.paths) : A.unstage(c.io, gutter.paths))}>
        <Text dimColor>{gutter.sign}</Text>
      </Button>
      <Text> </Text>
      {element}
    </Box>
  )
}

const rowElement = (c: Ctx, row: Row, selected: string | null, marks: Marks, isAll: boolean, gutter?: Gutter) =>
  withGutter(c, row, rowButton(c, row, selected, marks, isAll), gutter)

const rowButton = (c: Ctx, row: Row, selected: string | null, marks: Marks, isAll: boolean) => {
  const { Button, Text } = c.t
  const indent = '  '.repeat(row.depth)

  if (row.isDir) {
    const showCount = row.changes > 0 && (!row.isOpen || isAll)

    return (
      <Button key={row.key} plain onPress={() => A.toggleDir(c.io, row.path, row.isOpen)}>
        {indent}
        <Text color="subtle">{row.isOpen ? '▾ ' : '▸ '}</Text>
        <Text bold={row.changes > 0}>{row.label}</Text>
        {showCount ? <Text color="warning">{` ${row.changes}`}</Text> : ''}
        {row.isOpen ? '' : mark(c, latestIn(marks.all, row.path), marks.latest)}
      </Button>
    )
  }

  const status = row.file ? STATUS[row.file.status] : null
  const isDeleted = row.file?.status === 'deleted'

  return (
    <Button key={row.key} plain onPress={() => A.openFile(c.io, row.path)}>
      {indent}
      <Text color={status?.color ?? 'subtle'} bold>{status ? `${status.letter} ` : '  '}</Text>
      <Text
        {...(status ? { color: status.color } : {})}
        bold={row.path === selected}
        strikethrough={isDeleted}
        dimColor={isDeleted}
      >
        {row.label}
      </Text>
      {...(row.file ? stats(c, row.file) : [])}
      {mark(c, marks.byPath.get(row.path), marks.latest)}
    </Button>
  )
}

/** The latest activity inside the folder `path` (ends in `/`), for a closed folder's row. */
const latestIn = (activity: readonly Activity[], path: string): Activity | undefined => {
  let found: Activity | undefined
  for (const entry of activity) if (entry.path.startsWith(path) && (found === undefined || entry.seq > found.seq)) found = entry

  return found
}

/** `feature/x → origin/feature/x ↑2 ↓1`: the branch, where it pushes, and how far apart they are. */
const branchLine = (c: Ctx, snap: { branch: string; upstream?: string; ahead?: number; behind?: number }) => {
  const { Text } = c.t
  const parts = [<Text bold>{snap.branch}</Text>]
  if (snap.upstream === undefined) return parts
  parts.push(<Text dimColor>{` → ${snap.upstream}`}</Text>)
  const ahead = snap.ahead ?? 0
  const behind = snap.behind ?? 0
  if (ahead === 0 && behind === 0) parts.push(<Text dimColor> ✓ up to date</Text>)
  if (ahead > 0) parts.push(<Text color="warning">{` ↑${ahead}`}</Text>)
  if (behind > 0) parts.push(<Text color="suggestion">{` ↓${behind}`}</Text>)

  return parts
}

/** The git operations work on the working changes of the current branch: not on a past commit, not on the whole branch. */
const isGitMode = async (c: Ctx, snap: Snapshot): Promise<boolean> =>
  snap.commit === undefined && snap.error === undefined && (await S.pick(c.io, 'baseMode')) === 'head' && (await sharedAgent(c)) === null

/** The subagent in view, when it works in the session's own tree: the tree shows only its files, with no git operations. */
const sharedAgent = async (c: Ctx): Promise<AgentWork | null> => {
  const agentId = await S.pick(c.io, 'agentView')
  if (agentId === null) return null
  const work = (await S.pick(c.io, 'agents'))[agentId] ?? { root: null, isApart: false, activity: [] }

  return work.isApart ? null : work
}

/** A toggle drawn as all its options, the current one bold: `Changed · All`. */
const choice = (c: Ctx, options: readonly string[], active: number) => {
  const { Text } = c.t

  return options.flatMap((option, index) => [
    ...(index > 0 ? [<Text dimColor> · </Text>] : []),
    index === active ? <Text bold>{option}</Text> : <Text dimColor>{option}</Text>,
  ])
}

/** Outside git mode: the keys that lead back to stage, commit and push. */
const gitHint = (isAll: boolean, isCommit: boolean, baseMode: string): string => {
  const steps: string[] = []
  if (isAll) steps.push('a for Changed')
  if (isCommit) steps.push('v for Working changes')
  else if (baseMode === 'branch') steps.push('v twice for Uncommitted')
  else if (baseMode !== 'head') steps.push('v for Uncommitted')

  return `Stage, commit and push: press ${steps.join(', then ')}.`
}

/** What a destructive button says after its first press. */
const CONFIRM_TEXT: Record<string, string> = { force: 'Press again to force push', undo: 'Press again to undo the last commit' }

/** The line under the toolbar: the running operation, a press to repeat, or how the last one went. */
const statusLine = async (c: Ctx): Promise<RenderElement | null> => {
  const { Box, Text, Button } = c.t
  const git = await S.pick(c.io, 'git')
  if (git.busy !== null) return <Text dimColor>{git.busy}</Text>
  if (git.confirm !== null) {
    const text = CONFIRM_TEXT[git.confirm.key] ?? 'Press x again to discard the changes'

    return <Text color="warning">{text}</Text>
  }
  if (git.notice === null) return null
  const notice = git.notice

  return (
    <Box flexDirection="column">
      <Box columnGap={2}>
        <Text color={notice.ok ? 'success' : 'error'}>{`${notice.ok ? '✓' : '✗'} ${notice.text}`}</Text>
        <Button key="notice-close" plain onPress={() => S.put(c.io, 'git', g => ({ ...g, notice: null }))}><Text dimColor>✕</Text></Button>
      </Box>
      {notice.detail !== undefined ? <Text dimColor>{notice.detail}</Text> : null}
    </Box>
  )
}

/** Why Push cannot run now, or null when it can (or Force push stands in its place). */
const pushBlocker = (snap: Snapshot, isDetached: boolean, isDiverged: boolean): string | null => {
  if (isDetached) return 'Push: not on a branch'
  if (isDiverged) return null
  if (snap.upstream !== undefined && (snap.ahead ?? 0) === 0) return 'Push: nothing to push, commit first'

  return null
}

/** Push, pull, fetch, undo and the PR. Push always shows: a dim line says why it cannot run yet. */
const syncRow = async (c: Ctx, snap: Snapshot): Promise<RenderElement> => {
  const { Box, Button, Text } = c.t
  const git = await S.pick(c.io, 'git')
  const ahead = snap.ahead ?? 0
  const behind = snap.behind ?? 0
  const hasUpstream = snap.upstream !== undefined
  const isDetached = snap.branch === 'HEAD' || snap.branch === ''
  const isDiverged = ahead > 0 && behind > 0
  const canPr = git.hasGh === true && git.pr === null && !isDetached && snap.branch !== (git.base ?? 'main')
  const blocker = pushBlocker(snap, isDetached, isDiverged)

  return (
    <Box flexWrap="wrap" columnGap={2}>
      {blocker !== null ? (
        <Text dimColor>{blocker}</Text>
      ) : !isDiverged ? (
        <Button key="push" plain hotkey="p" onPress={() => A.push(c.io)}>{hasUpstream ? 'Push' : 'Push branch'}</Button>
      ) : null}
      {isDiverged ? <Button key="force-push" plain onPress={() => A.push(c.io, true)}>Force push</Button> : null}
      {behind > 0 && !isDiverged ? <Button key="pull" plain onPress={() => A.pull(c.io)}>Pull</Button> : null}
      {hasUpstream ? <Button key="fetch" plain onPress={() => A.fetch(c.io)}>Fetch</Button> : null}
      {ahead > 0 ? <Button key="undo" plain onPress={() => A.undoCommit(c.io)}>Undo commit</Button> : null}
      {git.pr !== null ? (
        <Button key="pr-open" plain onPress={() => A.openUrl(c.io, git.pr?.url ?? '')}>{prLabel(git.pr)}</Button>
      ) : canPr ? (
        <Button key="pr-create" plain onPress={() => A.openPrForm(c.io)}>Create PR</Button>
      ) : null}
    </Box>
  )
}

/** The message and the commit buttons, always; with nothing staged a dim line says how to stage. */
const commitBox = async (c: Ctx, stagedCount: number): Promise<RenderElement | null> => {
  const table = c.t
  const { Box, Button, Text } = table
  const git = await S.pick(c.io, 'git')
  if (!('Input' in table)) return null
  const { Input } = table

  return (
    <Box flexDirection="column">
      <Input
        key="message"
        label="Message"
        placeholder="what this commit does"
        value={git.message}
        submitLabel="commit"
        onInput={value => A.setMessage(c.io, value)}
        onSubmit={async value => {
          await A.setMessage(c.io, value)
          await A.commit(c.io)
        }}
      />
      <Box flexWrap="wrap" columnGap={2}>
        <Button key="write-message" plain hotkey="w" onPress={() => A.writeMessage(c.io)}>Write message</Button>
        <Button key="commit" plain hotkey="c" onPress={() => A.commit(c.io)}>{git.amend ? 'Amend' : 'Commit'}</Button>
        <Button key="commit-push" plain onPress={() => A.commit(c.io, true)}>{git.amend ? 'Amend & push' : 'Commit & push'}</Button>
        <Button key="amend" plain onPress={() => A.toggleAmend(c.io)}>{git.amend ? '[x] Amend last commit' : '[ ] Amend last commit'}</Button>
      </Box>
      {stagedCount === 0 && !git.amend ? <Text dimColor>Nothing staged: press + before a file, or Stage all, to choose what to commit.</Text> : null}
    </Box>
  )
}

const renderTree = async (c: Ctx): Promise<RenderElement> => {
  const table = c.t
  const { Box, Text, Button } = table
  const snap = await S.pick(c.io, 'snapshot')
  const isLoading = await S.pick(c.io, 'isLoading')
  const isFocused = c.e.component === 'Pane' && c.e.props.isFocused

  if (snap === null) {
    return <Text dimColor>{isLoading ? 'Reading git…' : 'Nothing read yet.'}</Text>
  }
  if (snap.error !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color="warning">{snap.error === 'not-a-repo' ? 'Not a git repository' : 'git failed'}</Text>
        <Text dimColor>{snap.message ?? ''}</Text>
        <Button key="refresh" plain hotkey="r" onPress={() => A.refresh(c.io)}>Try again</Button>
      </Box>
    )
  }

  const view = await S.pick(c.io, 'view')
  const isAll = view === 'all'
  const baseMode = await S.pick(c.io, 'baseMode')
  const filter = await S.pick(c.io, 'filter')
  // With a subagent in view, its own marks; in the session's own tree, only the files it touched.
  const agentId = await S.pick(c.io, 'agentView')
  const agentWork = agentId === null ? null : ((await S.pick(c.io, 'agents'))[agentId] ?? { root: null, isApart: false, activity: [] })
  const shared = agentWork !== null && !agentWork.isApart ? agentWork : null
  const activity: Activity[] =
    agentWork === null
      ? await S.pick(c.io, 'activity')
      : agentWork.activity.flatMap(entry => {
          const path = toRelative(entry.path, snap.root)

          return path === null ? [] : [{ ...entry, path }]
        })
  const marks: Marks = {
    byPath: new Map(activity.map(entry => [entry.path, entry])),
    latest: activity.reduce((max, entry) => Math.max(max, entry.seq), 0),
    all: activity,
  }
  const shown = await S.pick(c.io, 'preview')
  const changes = new Map(snap.files.map(f => [f.path, f]))

  // The changes, and every file Claude read, wrote or committed since the prompt.
  // A past commit shows its own files only.
  const isCommit = snap.commit !== undefined
  let paths: string[] = [...new Set([...snap.files.map(f => f.path), ...(isCommit ? [] : activity.map(entry => entry.path))])]
  if (shared !== null && !isCommit) paths = [...new Set(activity.map(entry => entry.path))]
  const agentPaths = new Set(paths)
  const counted = shared !== null && !isCommit ? snap.files.filter(file => agentPaths.has(file.path)) : snap.files
  if (isAll) paths = [...new Set([...((await S.pick(c.io, 'allFiles')) ?? []), ...paths])]
  const isFiltering = filter !== null && filter.trim() !== ''
  if (isFiltering) paths = paths.filter(path => matches(path, filter))

  const activeFolders = new Set(activity.flatMap(entry => ancestors(entry.path)))
  const collapsed = new Set(await S.pick(c.io, 'collapsed'))
  const expanded = new Set(await S.pick(c.io, 'expanded'))
  const options = {
    // Folders holding changes start open in both views; the rest of the repository starts closed.
    isOpen: (path: string, count: number) => isFiltering || (!collapsed.has(path) && (count > 0 || activeFolders.has(path) || (isAll && expanded.has(path)))),
    isCompact: true,
  }

  // The working changes split in two, as git keeps them: staged, and the rest.
  const gitMode = !isAll && (await isGitMode(c, snap))
  const staged = snap.files.filter(file => file.staged)
  const stagedPaths = new Set(staged.map(file => file.path))
  const unstagedChanges = new Map(snap.files.filter(file => file.unstaged || !file.staged).map(file => [file.path, file]))
  const stagedRows = gitMode
    ? flatten(buildTree(paths.filter(path => stagedPaths.has(path)), new Map(staged.map(file => [file.path, file]))), options).map(row => ({
        ...row,
        key: row.key.replace(/^row:/, 'staged:'),
      }))
    : []
  const rows = gitMode
    ? flatten(buildTree(paths.filter(path => unstagedChanges.has(path) || !changes.has(path)), unstagedChanges), options)
    : flatten(buildTree(paths, changes), options)
  const hidden = Math.max(0, stagedRows.length + rows.length - MAX_ROWS)
  const gutterOf = (row: Row, sign: '+' | '−', section: ReadonlyMap<string, ChangedFile>): Gutter => {
    if (row.isDir) return row.changes > 0 ? { sign, paths: [row.path] } : null
    const file = section.get(row.path)

    return file === undefined ? null : { sign, paths: file.status === 'renamed' && file.from && sign === '−' ? [file.from, file.path] : [file.path] }
  }

  const filterField = (() => {
    if (filter === null) return null
    if (!('Input' in table)) return null
    const { Input } = table

    return (
      <Box columnGap={1}>
        <Input
          key="filter-input"
          label="Filter"
          placeholder="type a name, Enter opens the first match"
          value={filter}
          autoFocus
          submitLabel="open"
          onInput={value => S.put(c.io, 'filter', () => value)}
          onSubmit={value => {
            const first = rows.find(row => !row.isDir && matches(row.path, value))
            if (first) void A.openFile(c.io, first.path)
          }}
        />
        <Button key="filter-clear" plain onPress={() => S.put(c.io, 'filter', () => null)}>✕</Button>
      </Box>
    )
  })()

  let empty: RenderElement | null = null
  if (rows.length === 0 && stagedRows.length === 0) {
    empty = shared !== null && !isFiltering && !isCommit ? (
      <Text dimColor>The pane has seen no file that this agent read or changed.</Text>
    ) : isFiltering ? (
      <Text dimColor>No file matches “{filter}”.</Text>
    ) : isAll ? (
      <Text dimColor>No files.</Text>
    ) : isCommit ? (
      <Text dimColor>No file changes in this commit.</Text>
    ) : (
      <Box flexDirection="column">
        <Text color="success">{snap.baseMode === 'prompt' ? `✓ No changes since ${snap.baseLabel}` : `✓ No changes against ${snap.baseLabel}`}</Text>
        <Text dimColor>Press a to browse all files, or v to change what the tree compares with.</Text>
      </Box>
    )
  }

  const agentLine =
    agentWork === null ? null : (
      <Box flexWrap="wrap">
        <Text color="claude" bold>{'Agent '}</Text>
        <Text bold>{c.agentLabel ?? 'subagent'}</Text>
        <Text dimColor>
          {agentWork.isApart && agentWork.root !== null ? `  in ${agentWork.root.split('/').slice(-2).join('/')}` : '  the files it read and changed'}
        </Text>
      </Box>
    )

  return (
    <Box flexDirection="column">
      {agentLine}
      <Box flexWrap="wrap">{...branchLine(c, snap)}</Box>
      <Box flexWrap="wrap">
        {snap.commit ? <Text>{`${snap.commit.short} ${snap.commit.subject}`}</Text> : <Text dimColor>{snap.baseMode === 'prompt' ? `since ${snap.baseLabel}` : `vs ${snap.baseLabel}`}</Text>}
        <Text dimColor>{counted.length > 0 ? `  ${counted.length} changed ` : ''}</Text>
        {...summaryParts(c, counted)}
      </Box>
      <Box flexWrap="wrap" columnGap={2}>
        <Button key="view" plain hotkey="a" onPress={() => A.toggleView(c.io)}>{...choice(c, ['Changed', 'All'], isAll ? 1 : 0)}</Button>
        {isCommit ? (
          <Button key="base" plain hotkey="v" onPress={() => A.showCommit(c.io, null)}>Working changes</Button>
        ) : (
          <Button key="base" plain hotkey="v" onPress={() => A.toggleBase(c.io)}>{...choice(c, ['Uncommitted', 'Branch', 'Prompt'], A.BASE_ORDER.indexOf(baseMode))}</Button>
        )}
        <Button key="history" plain hotkey="h" onPress={() => A.showLog(c.io)}>History</Button>
        <Button key="filter" plain hotkey="f" onPress={() => A.toggleFilter(c.io)}>Filter</Button>
      </Box>
      {filterField}
      {stagedRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Box columnGap={2}>
            <Text bold>{`Staged ${staged.length}`}</Text>
            <Button key="unstage-all" plain onPress={() => A.unstage(c.io, staged.flatMap(file => (file.status === 'renamed' && file.from ? [file.from, file.path] : [file.path])))}>
              Unstage all
            </Button>
          </Box>
          {...stagedRows.slice(0, MAX_ROWS).map(row => rowElement(c, row, shown?.path ?? null, marks, isAll, gutterOf(row, '−', new Map(staged.map(f => [f.path, f])))))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {gitMode && unstagedChanges.size > 0 ? (
          <Box columnGap={2}>
            <Text bold>{`Changes ${unstagedChanges.size}`}</Text>
            <Button key="stage-all" plain onPress={() => A.stage(c.io, ['.'])}>Stage all</Button>
          </Box>
        ) : null}
        {empty}
        {...rows
          .slice(0, Math.max(0, MAX_ROWS - stagedRows.length))
          .map(row => rowElement(c, row, shown?.path ?? null, marks, isAll, gitMode ? gutterOf(row, '+', unstagedChanges) : undefined))}
        {hidden > 0 ? <Text dimColor>{`… ${hidden} more rows. Use the filter (f) to narrow.`}</Text> : null}
      </Box>
      {/* The git operations last, under the files they act on. */}
      <Box flexDirection="column" marginTop={1}>
        {gitMode ? await commitBox(c, staged.length) : null}
        {gitMode ? (
          await syncRow(c, snap)
        ) : (
          <Text dimColor>{shared !== null ? 'Stage, commit and push: go back to the main conversation.' : gitHint(isAll, isCommit, baseMode)}</Text>
        )}
        {gitMode ? await statusLine(c) : null}
      </Box>
      {isFocused ? null : <Text dimColor>Click a file to preview. Click the pane (or ctrl+x tab) for the letter keys.</Text>}
    </Box>
  )
}

/** Styled spans as Text pieces. */
const spanElements = (c: Ctx, spans: readonly Span[]) => {
  const { Text } = c.t

  return spans.map(span => {
    const style: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; dimColor?: boolean; color?: string } = {}
    if (span.bold) style.bold = true
    if (span.italic) style.italic = true
    if (span.strike) style.strikethrough = true
    if (span.dim) style.dimColor = true
    if (span.code) style.color = 'permission'
    if (span.link) {
      style.color = 'suggestion'
      style.underline = true
    }

    return Object.keys(style).length === 0 ? span.text : <Text {...style}>{span.text}</Text>
  })
}

/**
 * A markdown page: headings and tables drawn here, fitted to the pane's `width`;
 * code fences as highlighted code; the rest (paragraphs, lists, quotes) by the engine's renderer.
 */
const renderMarkdown = (c: Ctx, text: string, width: number): RenderElement => {
  const { Box, Text, Code, Markdown } = c.t
  const blocks = parseBlocks(text)

  return (
    <Box flexDirection="column">
      {...blocks.map((block, index) => {
        const gap = index === 0 ? 0 : 1
        switch (block.kind) {
          case 'heading': {
            const title = spanElements(c, block.spans)
            const ruleWidth = Math.max(4, Math.min(width, displayWidth(block.spans.map(s => s.text).join('')) + 2))
            if (block.level === 1) {
              return (
                <Box flexDirection="column" marginTop={gap}>
                  <Text bold color="claude">{...title}</Text>
                  <Text color="claude">{'━'.repeat(width)}</Text>
                </Box>
              )
            }
            if (block.level === 2) {
              return (
                <Box flexDirection="column" marginTop={gap}>
                  <Text bold color="claude">{...title}</Text>
                  <Text dimColor>{'─'.repeat(ruleWidth)}</Text>
                </Box>
              )
            }

            return (
              <Box marginTop={gap}>
                <Text bold>
                  <Text color="claude">{`${'#'.repeat(block.level)} `}</Text>
                  {...title}
                </Text>
              </Box>
            )
          }
          case 'table':
            return (
              <Box flexDirection="column" marginTop={gap}>
                {...layoutTable(block, width).map(line => <Text wrap="truncate-end">{...spanElements(c, line)}</Text>)}
              </Box>
            )
          case 'code':
            return (
              <Box flexDirection="column" marginTop={gap}>
                {block.language !== '' ? <Text dimColor>{block.language}</Text> : null}
                {block.language !== '' ? <Code source={block.source} language={block.language} /> : <Code source={block.source} />}
              </Box>
            )
          default:
            return (
              <Box marginTop={gap}>
                <Markdown text={block.text} />
              </Box>
            )
        }
      })}
    </Box>
  )
}

const renderPreview = async (c: Ctx): Promise<RenderElement> => {
  const table = c.t
  const { Box, Text, Button, Code } = table
  const shown = await S.pick(c.io, 'preview')
  const snap = await S.pick(c.io, 'snapshot')
  if (shown === null || snap === null) return renderTree(c)

  const file = snap.files.find(f => f.path === shown.path)
  const status = file ? STATUS[file.status] : null
  const order = reviewOrder(snap.files)
  const position = order.indexOf(shown.path)
  const bodyColumns = c.e.component === 'Pane' ? c.e.props.bodyColumns : 60
  const gitMode = await isGitMode(c, snap)

  let content: RenderElement
  switch (shown.kind) {
    case 'diff':
      content = <Code source={shown.text} format="diff" path={shown.path} />
      break
    case 'code':
      content = <Code source={shown.text} path={shown.path} startLine={shown.firstLine ?? 1} />
      break
    case 'markdown':
      content = renderMarkdown(c, shown.text, Math.max(20, bodyColumns - 1))
      break
    case 'image': {
      const image = shown.image
      if (image !== undefined && 'Image' in c.t) {
        const { Image } = c.t
        const columns = Math.max(8, Math.min(255, bodyColumns - 2))
        // Terminal cells are about twice as tall as wide.
        const rows = Math.max(4, Math.min(60, Math.round((columns * image.height) / Math.max(1, image.width) / 2)))
        content = (
          <Box flexDirection="column">
            <Image source={{ file: image.file, format: 'png' }} columns={columns} rows={rows} alt={shown.note ?? 'PNG image'} />
          </Box>
        )
      } else {
        content = <Text dimColor>{shown.note ?? 'Image'}</Text>
      }
      break
    }
    default:
      content = <Text dimColor>{shown.note ?? ''}</Text>
  }

  const pager =
    shown.pages > 1 ? (
      <Box columnGap={2} flexWrap="wrap" marginTop={1}>
        {shown.page > 0 ? (
          <Button key="page-prev" plain hotkey="k" onPress={() => A.openFile(c.io, shown.path, shown.mode, shown.page - 1)}>Previous page</Button>
        ) : null}
        <Text dimColor>
          {`page ${shown.page + 1} of ${shown.pages}`}
          {shown.firstLine !== undefined && shown.totalLines !== undefined
            ? ` · from line ${shown.firstLine} of ${shown.totalLines}`
            : ''}
        </Text>
        {shown.page < shown.pages - 1 ? (
          <Button key="page-next" plain hotkey="j" onPress={() => A.openFile(c.io, shown.path, shown.mode, shown.page + 1)}>Next page</Button>
        ) : null}
      </Box>
    ) : null

  return (
    <Box flexDirection="column">
      <Box flexWrap="wrap" columnGap={2}>
        <Button key="back" plain hotkey="b" autoFocus onPress={() => A.back(c.io)}>‹ Back</Button>
        {...shown.modes.map(mode => (
          <Button key={`mode:${mode}`} plain hotkey={MODE_LABEL[mode].hotkey} onPress={() => A.openFile(c.io, shown.path, mode)}>
            {mode === shown.mode ? <Text bold color="claude">{MODE_LABEL[mode].label}</Text> : MODE_LABEL[mode].label}
          </Button>
        ))}
        {order.length > 0 ? <Button key="prev" plain hotkey="p" onPress={() => A.step(c.io, -1)}>Prev</Button> : null}
        {order.length > 0 ? <Button key="next" plain hotkey="n" onPress={() => A.step(c.io, 1)}>Next</Button> : null}
        <Button
          key="copy"
          plain
          hotkey="c"
          onPress={async press => {
            const isCopied = await c.io.copy(shown.path, press.surface)
            c.io.toast(isCopied ? `Copied ${shown.path}` : 'Could not copy the path')
          }}
        >
          Copy path
        </Button>
        {file?.status === 'deleted' || snap.commit !== undefined ? null : (
          <Button key="open-app" plain hotkey="o" onPress={() => A.openInApp(c.io, shown.path)}>Open</Button>
        )}
        {file !== undefined && gitMode ? (
          <Button key="stage-toggle" plain hotkey="t" onPress={() => (file.unstaged ? A.stageFile(c.io, file) : A.unstageFile(c.io, file))}>
            {file.unstaged ? 'Stage' : 'Unstage'}
          </Button>
        ) : null}
        {file !== undefined && gitMode && file.status !== 'conflict' ? (
          <Button key="discard" plain hotkey="x" onPress={() => A.discard(c.io, file)}>Discard</Button>
        ) : null}
      </Box>
      {gitMode ? await statusLine(c) : null}
      <Box flexWrap="wrap" marginTop={1}>
        <Text dimColor>{dirname(shown.path)}</Text>
        <Text bold {...(status ? { color: status.color } : {})}>{basename(shown.path)}</Text>
        {status ? <Text color={status.color}>{`  ${status.label}`}</Text> : ''}
        {file?.status === 'renamed' && file.from ? <Text dimColor>{` from ${file.from}`}</Text> : ''}
        {...(file ? stats(c, file) : [])}
        {position >= 0 ? <Text dimColor>{`  ${position + 1}/${order.length}`}</Text> : ''}
      </Box>
      {shown.kind === 'image' && shown.note ? <Text dimColor>{shown.note}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {content}
      </Box>
      {pager}
    </Box>
  )
}

/** One commit of the history, bold while the tree shows it. */
const commitRow = (c: Ctx, commit: CommitInfo, shown: CommitInfo | null) => {
  const { Button, Text } = c.t
  const isShown = shown?.sha === commit.sha

  return (
    <Button key={`commit:${commit.sha}`} plain {...(isShown ? { autoFocus: true as const } : {})} onPress={() => A.showCommit(c.io, commit)}>
      <Text dimColor>{`${commit.short} `}</Text>
      {isShown ? <Text bold>{commit.subject}</Text> : commit.subject}
      <Text dimColor>{`  ${commit.when} · ${commit.author}`}</Text>
    </Button>
  )
}

/**
 * The history screen: the working changes, then the latest commits, newest first: those not
 * pushed in a section of their own above those the remote has, where a remote can say.
 */
const renderLog = async (c: Ctx): Promise<RenderElement> => {
  const { Box, Text, Button } = c.t
  const log = await S.pick(c.io, 'log')
  const shown = await S.pick(c.io, 'commit')
  const upstream = (await S.pick(c.io, 'snapshot'))?.upstream
  const isKnown = (log ?? []).some(commit => commit.isPushed !== undefined)
  const unpushed = (log ?? []).filter(commit => commit.isPushed === false)
  const pushed = (log ?? []).filter(commit => commit.isPushed !== false)

  return (
    <Box flexDirection="column">
      <Button key="back" plain hotkey="b" onPress={() => S.put(c.io, 'screen', () => 'tree')}>‹ Back</Button>
      <Box flexDirection="column" marginTop={1}>
        <Button key="commit:working" plain {...(shown === null ? { autoFocus: true as const } : {})} onPress={() => A.showCommit(c.io, null)}>
          {shown === null ? <Text bold>Working changes</Text> : 'Working changes'}
        </Button>
        {log === null ? <Text dimColor>Reading history…</Text> : null}
        {...(isKnown ? [] : log ?? []).map(commit => commitRow(c, commit, shown))}
      </Box>
      {isKnown && unpushed.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="warning">{`Not pushed ${unpushed.length}`}</Text>
          {...unpushed.map(commit => commitRow(c, commit, shown))}
        </Box>
      ) : null}
      {isKnown && pushed.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{upstream === undefined ? 'On the remote' : `On ${upstream}`}</Text>
          {...pushed.map(commit => commitRow(c, commit, shown))}
        </Box>
      ) : null}
    </Box>
  )
}

/** The PR form: a title, the base branch, draft or not, and the description from the template. */
const renderPr = async (c: Ctx): Promise<RenderElement> => {
  const table = c.t
  const { Box, Text, Button } = table
  const form = await S.pick(c.io, 'prForm')
  const snap = await S.pick(c.io, 'snapshot')
  if (form === null || !('Input' in table)) return renderTree(c)
  const { Input } = table
  const bodyColumns = c.e.component === 'Pane' ? c.e.props.bodyColumns : 60
  const back = () => c.io.set(state => ({ ...state, screen: 'tree', prForm: null }))

  return (
    <Box flexDirection="column">
      <Button key="back" plain hotkey="b" onPress={back}>‹ Back</Button>
      <Box flexWrap="wrap" marginTop={1}>
        <Text bold>Create PR</Text>
        <Text dimColor>{` ${snap?.branch ?? ''} → ${form.base}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Input key="pr-title" label="Title" value={form.title} autoFocus onInput={value => A.editPrForm(c.io, f => ({ ...f, title: value }))} onSubmit={() => A.createPr(c.io)} submitLabel="create" />
        <Input key="pr-base" label="Base" value={form.base} onInput={value => A.editPrForm(c.io, f => ({ ...f, base: value }))} onSubmit={() => A.createPr(c.io)} submitLabel="create" />
      </Box>
      <Box flexWrap="wrap" columnGap={2}>
        <Button key="pr-draft" plain onPress={() => A.editPrForm(c.io, f => ({ ...f, draft: !f.draft }))}>{form.draft ? '[x] Draft' : '[ ] Draft'}</Button>
        <Button key="pr-edit" plain hotkey="e" onPress={() => A.editPrBody(c.io)}>Edit description</Button>
        <Button key="pr-submit" plain onPress={() => A.createPr(c.io)}>{form.draft ? 'Create draft PR' : 'Create PR'}</Button>
      </Box>
      {form.templates.length > 1 ? (
        <Box flexWrap="wrap" columnGap={2}>
          <Text dimColor>Template</Text>
          {...form.templates.map(template => (
            <Button key={`pr-template:${template}`} plain onPress={() => A.chooseTemplate(c.io, template)}>
              {template === form.template ? <Text bold>{basename(template)}</Text> : basename(template)}
            </Button>
          ))}
        </Box>
      ) : null}
      {await statusLine(c)}
      <Box flexDirection="column" marginTop={1}>
        {form.body.trim() === '' ? <Text dimColor>No description. Push e to write one.</Text> : renderMarkdown(c, form.body, Math.max(20, bodyColumns - 1))}
      </Box>
    </Box>
  )
}

export const renderPane = async (c: Ctx): Promise<RenderElement> => {
  const screen = await S.pick(c.io, 'screen')

  return screen === 'preview' ? renderPreview(c) : screen === 'log' ? renderLog(c) : screen === 'pr' ? renderPr(c) : renderTree(c)
}

/**
 * The Files button at the right of the prompt footer, beside the mode labels (`auto mode`):
 * the labels the engine had, then the button that opens or hides the pane.
 */
export const renderFooter = async (c: Ctx, modes: readonly string[]): Promise<RenderElement | null> => {
  const snap = await S.pick(c.io, 'snapshot')
  if (snap === null || snap.error !== undefined) return null
  const { Box, Text, Button } = c.t
  const isOpen = await S.pick(c.io, 'isOpen')

  return (
    <Box columnGap={2}>
      {modes.length > 0 ? <Text dimColor>{modes.join(' & ')}</Text> : null}
      <Button key="toggle" plain onPress={() => (isOpen ? A.closePane(c.io) : A.openPane(c.io))}>
        <Text color="claude">▤ </Text>
        <Text>{isOpen ? 'Hide files' : 'Files'}</Text>
        {snap.files.length === 0 ? <Text dimColor> clean</Text> : ''}
        {...summaryParts(c, snap.files)}
      </Button>
    </Box>
  )
}
