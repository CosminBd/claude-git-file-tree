// The part of the bundled Shiki (shiki.js, built by scripts/shiki/build.sh) the pane uses.
export type ShikiLanguage = 'vue' | 'svelte'
export type ShikiTheme = 'monokai' | 'github-light'
export type ThemedToken = { content: string; color?: string }
export type Highlighter = {
  codeToTokensBase: (code: string, options: { lang: ShikiLanguage; theme: ShikiTheme }) => ThemedToken[][]
  getTheme: (theme: ShikiTheme) => { fg: string }
}
export declare const createHighlighter: () => Highlighter
