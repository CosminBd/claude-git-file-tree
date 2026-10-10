import { describe, expect, test } from 'claude-code/testing'

import type { ColoredSpan } from '../types'
import { colorDiff, colorLines, colorPage, shikiLanguageOf } from '../hooks/highlight'

const VUE = [
  '<template>',
  '  <div',
  '    class="card"',
  '    @click="open"',
  '  >{{ label }}</div>',
  '</template>',
  '',
  '<script setup lang="ts">',
  'const label = 1',
  '</script>',
  '',
].join('\n')

/** The color one piece of text is drawn in, by its line; null for the text's own color. */
const colorOf = (line: ColoredSpan[], text: string): string | null | undefined => line.find(([part]) => part.includes(text))?.[1]

describe('Shiki highlighting', () => {
  test('only Vue and Svelte files take it', () => {
    expect(shikiLanguageOf('src/Card.vue')).toBe('vue')
    expect(shikiLanguageOf('App.svelte')).toBe('svelte')
    expect(shikiLanguageOf('src/app.ts')).toBe(null)
  })

  test('a template attribute on its own line is colored, as is the tag name', () => {
    const lines = colorLines(VUE, 'vue', 'dark')!
    expect(lines).toHaveLength(10)
    expect(lines.map(line => line.map(([text]) => text).join(''))).toEqual(VUE.replace(/\n$/, '').split('\n'))
    expect(colorOf(lines[1]!, 'div')).toMatch(/^#/)
    expect(colorOf(lines[2]!, 'class')).toMatch(/^#/)
    expect(colorOf(lines[3]!, '@click')).toMatch(/^#/)
    expect(colorOf(lines[8]!, 'const')).toMatch(/^#/)
  })

  test('the light theme draws in other colors', () => {
    expect(colorLines(VUE, 'vue', 'light-daltonized')).not.toEqual(colorLines(VUE, 'vue', 'dark'))
  })

  test('a page holds its own lines only', () => {
    const page = colorPage(VUE, 'vue', 'dark', 2, 4)!
    expect(page.map(line => line.map(([text]) => text).join(''))).toEqual(['    class="card"', '    @click="open"'])
  })

  test('a diff line takes its colors from its own side, without its sign', () => {
    const before = VUE.replace('@click="open"', '@click="shut"')
    const diff = ['@@ -3,3 +3,3 @@', '     class="card"', '-    @click="shut"', '+    @click="open"', '   >{{ label }}</div>', '\\ No newline at end of file'].join('\n')
    const colored = colorDiff(diff, 'vue', 'dark', before, VUE)!
    const texts = colored.map(line => line?.map(([text]) => text).join('') ?? null)
    expect(texts).toEqual([null, '    class="card"', '    @click="shut"', '    @click="open"', '  >{{ label }}</div>', null])
    expect(colorOf(colored[2]!, '@click')).toMatch(/^#/)
  })

  test('an added file colors from its new side alone', () => {
    const colored = colorDiff('@@ -0,0 +1,2 @@\n+<template>\n+  <div', 'vue', 'dark', null, VUE)!
    expect(colored.map(line => line?.map(([text]) => text).join('') ?? null)).toEqual([null, '<template>', '  <div'])
  })

  test('without either side there is nothing to color', () => {
    expect(colorDiff('@@ -1 +1 @@\n-a\n+b', 'vue', 'dark', null, null)).toBeUndefined()
  })
})
