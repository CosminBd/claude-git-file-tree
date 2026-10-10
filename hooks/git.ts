import type { BaseMode, ChangedFile, CommitInfo, FileStatus, Snapshot } from '../types'

/** git's well-known empty tree: the base of a repository with no commit yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

/** Runs git with these arguments in the given directory. */
export type Git = (args: string[], cwd?: string) => Promise<RunResult>

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'psd',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg', 'flac',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'wasm',
  'sqlite', 'db', 'phar',
])

export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const looksBinary = (path: string): boolean => BINARY_EXTENSIONS.has(extensionOf(path))

const splitZ = (text: string): string[] => {
  const parts = text.split('\0')
  if (parts[parts.length - 1] === '') parts.pop()

  return parts
}

const statusFromPorcelain = (x: string, y: string): FileStatus | null => {
  const xy = x + y
  if (xy === '??') return 'untracked'
  if (xy === '!!') return null
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflict'
  if (x === 'R' || y === 'R') return 'renamed'
  // Added to the index, then removed from disk: it exists nowhere.
  if (x === 'A' && y === 'D') return null
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A' || x === 'C') return 'added'

  return 'modified'
}

/** Parses `git status --porcelain=v1 -z`. */
export const parseStatus = (stdout: string): ChangedFile[] => {
  const parts = splitZ(stdout)
  const files: ChangedFile[] = []

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    const path = entry.slice(3)
    const status = statusFromPorcelain(x, y)
    // A rename or copy carries its source as the next entry.
    const from = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? parts[++i] : undefined
    if (status === null) continue
    const file: ChangedFile = status === 'renamed' && from !== undefined ? { path, status, from } : { path, status }
    // X is the index, Y the working tree; `??` lives in the working tree alone.
    if (x !== ' ' && x !== '?') file.staged = true
    if (y !== ' ' || x === '?') file.unstaged = true
    // A conflict is resolved in the working tree before it can be staged.
    if (status === 'conflict') delete file.staged
    files.push(file)
  }

  return files
}

const statusFromLetter = (letter: string): FileStatus => {
  switch (letter) {
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'U':
      return 'conflict'
    default:
      return 'modified'
  }
}

/** Parses `git diff --name-status -z`. */
export const parseNameStatus = (stdout: string): ChangedFile[] => {
  const parts = splitZ(stdout)
  const files: ChangedFile[] = []

  for (let i = 0; i < parts.length; i++) {
    const letter = (parts[i] ?? '').charAt(0)
    if (letter === 'R' || letter === 'C') {
      const from = parts[++i] ?? ''
      const path = parts[++i] ?? ''
      files.push(letter === 'R' ? { path, status: 'renamed', from } : { path, status: 'added' })
      continue
    }
    const path = parts[++i]
    if (path === undefined) break
    files.push({ path, status: statusFromLetter(letter) })
  }

  return files
}

export type NumStat = { added: number; removed: number; isBinary: boolean }

/** Parses `git diff --numstat -z` into counts by (new) path. */
export const parseNumstat = (stdout: string): Map<string, NumStat> => {
  const parts = splitZ(stdout)
  const stats = new Map<string, NumStat>()

  for (let i = 0; i < parts.length; i++) {
    const [added = '', removed = '', path = ''] = (parts[i] ?? '').split('\t')
    const isBinary = added === '-'
    const stat = { added: isBinary ? 0 : Number(added), removed: isBinary ? 0 : Number(removed), isBinary }
    if (path !== '') {
      stats.set(path, stat)
      continue
    }
    // A rename: the paths follow as two entries of their own.
    i += 1
    const newPath = parts[++i]
    if (newPath !== undefined) stats.set(newPath, stat)
  }

  return stats
}

/** Parses `wc -l` output into line counts by path. */
export const parseLineCounts = (stdout: string): Map<string, number> => {
  const counts = new Map<string, number>()

  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s(.+)$/.exec(line)
    if (match === null) continue
    const [, count = '0', path = ''] = match
    if (path === 'total') continue
    counts.set(path, Number(count))
  }

  return counts
}

const byPath = (a: ChangedFile, b: ChangedFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

const ok = (result: RunResult): string | null => (result.exitCode === 0 ? result.stdout.trim() : null)

/** The default branch to compare a feature branch against: origin's HEAD, else main or master. */
export const defaultBranch = async (git: Git, root: string): Promise<string | null> => {
  const remoteHead = ok(await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root))
  if (remoteHead) return remoteHead
  for (const candidate of ['main', 'master', 'origin/main', 'origin/master']) {
    const found = await git(['rev-parse', '--verify', '--quiet', candidate], root)
    if (found.exitCode === 0) return candidate
  }

  return null
}

const untrackedLineCounts = async (
  run: (argv: string[], cwd: string) => Promise<RunResult>,
  root: string,
  files: ChangedFile[],
): Promise<void> => {
  const counted = files.filter(f => f.status === 'untracked' && !looksBinary(f.path)).slice(0, 300)
  if (counted.length === 0) return
  const result = await run(['wc', '-l', '--', ...counted.map(f => f.path)], root)
  const counts = parseLineCounts(result.stdout)
  for (const file of counted) {
    const lines = counts.get(file.path)
    if (lines !== undefined) file.added = lines
  }
}

const applyStats = (files: ChangedFile[], stats: ReadonlyMap<string, NumStat>): void => {
  for (const file of files) {
    const stat = stats.get(file.path)
    if (stat === undefined) continue
    file.added = stat.added
    file.removed = stat.removed
    if (stat.isBinary) file.isBinary = true
  }
}

/** Parses `git log --format=%H%x1f%h%x1f%ar%x1f%an%x1f%s`. */
export const parseLog = (stdout: string): CommitInfo[] =>
  stdout
    .split('\n')
    .map(line => line.split('\x1f'))
    .filter(parts => parts.length >= 5 && parts[0] !== '')
    .map(([sha = '', short = '', when = '', author = '', ...subject]) => ({ sha, short, when, author, subject: subject.join('\x1f') }))

/**
 * The commits of HEAD that are not pushed: those its upstream lacks, or with no upstream those
 * no remote branch has. Null when there is no remote to compare with.
 */
const unpushedShas = async (git: Git, root: string, count: number): Promise<Set<string> | null> => {
  const hasUpstream = ok(await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)) !== null
  if (!hasUpstream && !ok(await git(['remote'], root))) return null
  const range = hasUpstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes']
  const listed = await git(['rev-list', `--max-count=${count}`, ...range], root)
  if (listed.exitCode !== 0) return null

  return new Set(listed.stdout.split('\n').filter(Boolean))
}

/** The latest commits of the current branch, newest first, each marked pushed or not where a remote says. */
export const listCommits = async (git: Git, root: string, count = 50): Promise<CommitInfo[]> => {
  const commits = parseLog((await git(['log', `-n${count}`, '--format=%H%x1f%h%x1f%ar%x1f%an%x1f%s'], root)).stdout)
  const unpushed = await unpushedShas(git, root, count)

  return unpushed === null ? commits : commits.map(commit => ({ ...commit, isPushed: !unpushed.has(commit.sha) }))
}

/** Every file in a commit, root-relative. */
export const listTree = async (git: Git, root: string, sha: string): Promise<string[]> =>
  splitZ((await git(['ls-tree', '-r', '--name-only', '-z', sha], root)).stdout)

/** Reads what changed in the repository around `cwd`, against the chosen base, or what one commit changed. */
export const scan = async (
  git: Git,
  run: (argv: string[], cwd: string) => Promise<RunResult>,
  cwd: string,
  baseMode: BaseMode,
  commit: CommitInfo | null = null,
  prompt: { before: string; now: string; label: string } | null = null,
): Promise<Snapshot> => {
  const top = await git(['rev-parse', '--show-toplevel'], cwd)
  if (top.exitCode !== 0) {
    return {
      root: cwd, branch: '', baseMode, baseRev: '', baseLabel: '', files: [],
      error: 'not-a-repo', message: 'Not inside a git repository.',
    }
  }
  const root = top.stdout.trim()

  const current = ok(await git(['branch', '--show-current'], root))
  const hasHead = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], root)).exitCode === 0
  const short = hasHead ? ok(await git(['rev-parse', '--short', 'HEAD'], root)) : null
  const branch = current || (short ? `detached at ${short}` : 'no commits yet')

  const tracking = current && hasHead ? await upstreamOf(git, root) : {}

  if (commit !== null) {
    // One past commit against its first parent (the empty tree for the first commit).
    const parent = ok(await git(['rev-parse', '--verify', '--quiet', `${commit.sha}^`], root))
    const base = parent ?? EMPTY_TREE
    const changed = await git(['diff', '--name-status', '-z', '-M', base, commit.sha], root)
    if (changed.exitCode !== 0) {
      return {
        root, branch, baseMode, baseRev: base, baseLabel: '', files: [], commit,
        error: 'git-failed', message: changed.stderr.trim() || `Could not read commit ${commit.short}.`,
      }
    }
    const files = parseNameStatus(changed.stdout)
    applyStats(files, parseNumstat((await git(['diff', '--numstat', '-z', '-M', base, commit.sha], root)).stdout))

    return { root, branch, ...tracking, baseMode, baseRev: base, baseLabel: parent ? `${commit.short}^` : 'empty tree', files: files.sort(byPath), commit }
  }

  if (baseMode === 'prompt' && prompt !== null) {
    // Two trees, both with the untracked files: what changed on disk between them, whoever changed it.
    const changed = await git(['diff', '--name-status', '-z', '-M', prompt.before, prompt.now], root)
    if (changed.exitCode !== 0) {
      return {
        root, branch, ...tracking, baseMode, baseRev: prompt.before, baseLabel: prompt.label, files: [],
        error: 'git-failed', message: changed.stderr.trim() || 'Could not compare with the last prompt.',
      }
    }
    const files = parseNameStatus(changed.stdout)
    applyStats(files, parseNumstat((await git(['diff', '--numstat', '-z', '-M', prompt.before, prompt.now], root)).stdout))

    return { root, branch, ...tracking, baseMode, baseRev: prompt.before, toRev: prompt.now, baseLabel: prompt.label, files: files.sort(byPath) }
  }

  let baseRev = hasHead ? 'HEAD' : EMPTY_TREE
  let baseLabel = hasHead ? 'HEAD' : 'empty tree'
  let effectiveMode: BaseMode = 'head'

  if (baseMode === 'branch' && hasHead) {
    const target = await defaultBranch(git, root)
    const mergeBase = target ? ok(await git(['merge-base', 'HEAD', target], root)) : null
    if (target && mergeBase) {
      baseRev = mergeBase
      baseLabel = target.replace(/^origin\//, '')
      effectiveMode = 'branch'
    }
  }

  let files: ChangedFile[]
  if (effectiveMode === 'head') {
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)
    if (status.exitCode !== 0) {
      return {
        root, branch, baseMode, baseRev, baseLabel, files: [],
        error: 'git-failed', message: status.stderr.trim() || 'git status failed.',
      }
    }
    files = parseStatus(status.stdout)
  } else {
    const changed = await git(['diff', '--name-status', '-z', '-M', baseRev], root)
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], root)
    files = [
      ...parseNameStatus(changed.stdout),
      ...splitZ(untracked.stdout).map((path): ChangedFile => ({ path, status: 'untracked' })),
    ]
  }

  const numstat = await git(['diff', '--numstat', '-z', '-M', baseRev], root)
  applyStats(files, parseNumstat(numstat.stdout))
  await untrackedLineCounts(run, root, files)

  // In the HEAD view git status lists a file staged and edited once; keep one row per path.
  const unique = new Map(files.map(f => [f.path, f]))

  return { root, branch, ...tracking, baseMode: effectiveMode, baseRev, baseLabel, files: [...unique.values()].sort(byPath) }
}

/** `2\t1` from `rev-list --left-right --count`: ahead, then behind. */
export const parseAheadBehind = (text: string): { ahead: number; behind: number } | null => {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(text.trim())

  return match === null ? null : { ahead: Number(match[1]), behind: Number(match[2]) }
}

/** The branch's upstream and how far apart they are, as of the last fetch (git is never asked to fetch). */
const upstreamOf = async (git: Git, root: string): Promise<Pick<Snapshot, 'upstream' | 'ahead' | 'behind'>> => {
  const upstream = ok(await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root))
  if (!upstream) return {}
  const counts = parseAheadBehind(ok(await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], root)) ?? '')

  return counts === null ? { upstream } : { upstream, ...counts }
}

/** Every file git knows of or would add, root-relative. */
export const listAll = async (git: Git, root: string): Promise<string[]> => {
  const result = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)

  return [...new Set(splitZ(result.stdout))]
}

/** Keeps a unified diff's hunks and drops the file headers before them. */
export const hunksOnly = (diff: string): string => {
  const start = diff.search(/^@@ /m)

  return start < 0 ? '' : diff.slice(start)
}

/** The diff of one file against the base, hunks only. */
export const fileDiff = async (git: Git, snapshot: Snapshot, file: ChangedFile | undefined, path: string): Promise<string> => {
  const root = snapshot.root
  if (file?.status === 'untracked') {
    const result = await git(['diff', '--no-color', '--no-index', '--', '/dev/null', path], root)

    return hunksOnly(result.stdout)
  }
  const paths = file?.status === 'renamed' && file.from ? [file.from, path] : [path]
  const end = snapshot.commit?.sha ?? snapshot.toRev
  const revs = end === undefined ? [snapshot.baseRev] : [snapshot.baseRev, end]
  const result = await git(['diff', '--no-color', '-M', ...revs, '--', ...paths], root)

  return hunksOnly(result.stdout)
}

/** The file as a commit has it; null when the commit lacks it. */
export const contentAt = async (git: Git, root: string, rev: string, path: string): Promise<string | null> => {
  const result = await git(['show', `${rev}:${path}`], root)

  return result.exitCode === 0 ? result.stdout : null
}

/** The file as the base has it (for a deleted file's source). */
export const baseContent = async (git: Git, snapshot: Snapshot, path: string): Promise<string | null> => {
  const result = await git(['show', `${snapshot.baseRev}:${path}`], snapshot.root)

  return result.exitCode === 0 ? result.stdout : null
}
