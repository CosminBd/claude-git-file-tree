// The highlighter the pane uses where Claude Code's own falls short: single-file components.
// Built into hooks/vendor/shiki.js by scripts/shiki/build.sh; JavaScript regex engine, no WebAssembly.
import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import svelte from 'shiki/langs/svelte.mjs'
import vue from 'shiki/langs/vue.mjs'
import githubLight from 'shiki/themes/github-light.mjs'
import monokai from 'shiki/themes/monokai.mjs'

export const createHighlighter = () =>
  createHighlighterCoreSync({ themes: [monokai, githubLight], langs: [vue, svelte], engine: createJavaScriptRegexEngine() })
