/** How a file differs from the base the tree compares against. */
export type FileStatus =
  | 'modified'
  | 'added'
  | 'untracked'
  | 'deleted'
  | 'renamed'
  | 'conflict'

/** One changed file, its path relative to the repository root. */
export type ChangedFile = {
  path: string
  status: FileStatus
  /** The old path of a rename. */
  from?: string
  added?: number
  removed?: number
  isBinary?: boolean
  /** The index holds a change to it (uncommitted view only). */
  staged?: boolean
  /** The working tree holds a change the index lacks (uncommitted view only). */
  unstaged?: boolean
}

/**
 * `head`: uncommitted work against HEAD. `branch`: everything since the branch left the default branch.
 * `prompt`: what changed on disk since the last prompt (or the session start).
 */
export type BaseMode = 'head' | 'branch' | 'prompt'

/** The working tree as a git tree, taken when a prompt was sent (or the session started). */
export type PromptBase = { tree: string; at: 'prompt' | 'session' }

/** One commit, as the history lists it. */
export type CommitInfo = {
  sha: string
  short: string
  subject: string
  /** `2 days ago`. */
  when: string
  /** The author's name. */
  author: string
  /** Whether a remote has it: its upstream's branch, or any remote branch. Absent with no remote. */
  isPushed?: boolean
}

export type Snapshot = {
  root: string
  branch: string
  baseMode: BaseMode
  /** The revision diffs are taken against (HEAD, a merge base, or the empty tree). */
  baseRev: string
  /** What the header says the tree compares against: `HEAD`, `main`. */
  baseLabel: string
  files: ChangedFile[]
  /** Set when the tree shows one past commit (against its parent) instead of the working tree. */
  commit?: CommitInfo
  /** The tree diffs end at instead of the working tree: the files as they are now, in the prompt view. */
  toRev?: string
  /** The branch's upstream (`origin/main`), when it has one. */
  upstream?: string
  /** Commits on the branch the upstream lacks, and the reverse, as of the last fetch. */
  ahead?: number
  behind?: number
  error?: 'not-a-repo' | 'git-failed'
  message?: string
}

export type View = 'changes' | 'all'

export type Screen = 'tree' | 'preview' | 'log' | 'pr'

/** The branch's pull request, as `gh pr view` reports it. */
export type PrInfo = { number: number; url: string; state: string; isDraft: boolean }

/** What the git controls draw from. */
export type GitUi = {
  /** The operation running (`Pushing…`); the other controls wait while it runs. */
  busy: string | null
  /** What the last operation came to: its first line, and the rest of git's words on a failure. */
  notice: { ok: boolean; text: string; detail?: string } | null
  /** The destructive press waiting for a second one (`discard:<path>`, `force`, `undo`), and when it was armed. */
  confirm: { key: string; at: number } | null
  message: string
  amend: boolean
  /** Whether `gh` is installed and signed in; null until asked. */
  hasGh: boolean | null
  pr: PrInfo | null
  /** The branch PRs go to (`main`); null until read. */
  base: string | null
}

/** The pull request form. */
export type PrForm = {
  title: string
  base: string
  draft: boolean
  /** The repository's PR templates, root-relative, and the one the description started from. */
  templates: string[]
  template: string | null
  /** Where the description is kept for editing: a file in the git directory. */
  bodyFile: string
  /** The description as last read from that file. */
  body: string
}

export type PreviewMode = 'diff' | 'source' | 'rendered'

export type PreviewImage = { file: string; width: number; height: number }

export type Preview = {
  path: string
  mode: PreviewMode
  /** The modes this file offers, in toolbar order. */
  modes: PreviewMode[]
  kind: 'code' | 'diff' | 'markdown' | 'image' | 'note'
  text: string
  page: number
  pages: number
  /** The 1-based line the page starts at, for a source page. */
  firstLine?: number
  totalLines?: number
  note?: string
  image?: PreviewImage
}

/** What Claude did to a file: read or searched it, wrote it, committed it. */
export type ActivityKind = 'read' | 'write' | 'commit'

export type Activity = {
  /** Root-relative. */
  path: string
  kind: ActivityKind
  /** Rises with each action; the highest is the latest. */
  seq: number
}

/** What one subagent did, from its own tool calls. */
export type AgentWork = {
  /** The git root it works in: its worktree when it has one; null until it touches a file. */
  root: string | null
  /** True when `root` is not the session's own: the agent works in a worktree of its own. */
  isApart: boolean
  /** The files it read, wrote or committed; the paths are absolute. */
  activity: Activity[]
}

/** Everything the pane and the band draw from: one value, so every write redraws both. */
export type UiState = {
  snapshot: Snapshot | null
  allFiles: string[] | null
  view: View
  baseMode: BaseMode
  /** The working tree when the last prompt was sent; null until the session's first snapshot. */
  promptBase: PromptBase | null
  /** Folders the person folded in the changes view. */
  collapsed: string[]
  /** Folders the person opened in the all-files view. */
  expanded: string[]
  screen: Screen
  /** The past commit the tree shows; null for the working changes. */
  commit: CommitInfo | null
  /** The recent commits the history screen lists; null until read. */
  log: CommitInfo[] | null
  git: GitUi
  prForm: PrForm | null
  preview: Preview | null
  /** The file Claude edited last, root-relative. */
  touched: string | null
  /** The files Claude read, wrote or committed since the last prompt. */
  activity: Activity[]
  /** What each subagent did, by its agent id. */
  agents: Record<string, AgentWork>
  /** The subagent whose transcript is in view, which the pane follows; null for the main conversation. */
  agentView: string | null
  /** The filter text; null while the filter field is closed. */
  filter: string | null
  isOpen: boolean
  isLoading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'git-file-tree': { ui: UiState }
  }
}
