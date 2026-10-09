import type { BaseMode, GitUi, UiState, View } from '../types'

export const PANE = 'files'

export const GIT_INITIAL: GitUi = { busy: null, notice: null, confirm: null, message: '', amend: false, hasGh: null, pr: null, base: null }

export const INITIAL: UiState = {
  snapshot: null,
  allFiles: null,
  view: 'changes',
  baseMode: 'head',
  promptBase: null,
  collapsed: [],
  expanded: [],
  screen: 'tree',
  commit: null,
  log: null,
  git: GIT_INITIAL,
  prForm: null,
  preview: null,
  touched: null,
  activity: [],
  filter: null,
  isOpen: false,
  isLoading: false,
}

/** The state half of the engine's closures (see `Io` in actions.ts). */
export type StateIo = {
  get: () => Promise<UiState>
  set: (change: (state: UiState) => UiState) => Promise<UiState>
}

/** Reads one field of the state. */
export const pick = async <K extends keyof UiState>(io: StateIo, key: K): Promise<UiState[K]> => (await io.get())[key]

/** Writes one field of the state from its current value; resolves the new value. */
export const put = async <K extends keyof UiState>(io: StateIo, key: K, change: (value: UiState[K]) => UiState[K]): Promise<UiState[K]> =>
  (await io.set(state => ({ ...state, [key]: change(state[key]) })))[key]

/** Preferences kept across sessions in `$.store`. */
export const PREFS_KEY = 'prefs'
export type Prefs = { view?: View; baseMode?: BaseMode }
