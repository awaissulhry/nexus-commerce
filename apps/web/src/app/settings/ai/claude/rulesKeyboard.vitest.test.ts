/**
 * MCP full control C9 — Settings › AI › Claude › Rules, by keyboard and at phone width (the 2026-10-02 browser check).
 *
 * The tools were a NexusGrid: Tab stayed in its header row (89 of 90 presses) and no Level select could be reached.
 * The tools are now a list: Tab goes Pause → the daily limit → Save → each tool's Level select and its limits' Edit, in
 * the order they are shown, and below a phone-sized width each tool stacks instead of scrolling sideways.
 * Rendered HTML (node SSR) and the page's own stylesheet.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RulesPanel } from './RulesPanel'
import type { ClaudeRule, ClaudeRules } from './claudeWords'

const tool = (name: string, title: string, over: Partial<ClaudeRule> = {}): ClaudeRule => ({
  name, title, category: 'products', readOnly: false, openWorld: false, reversibility: 'full', ceiling: 'auto',
  levels: ['off', 'ask', 'confirm', 'auto'], level: 'ask', stored: 'ask', limits: null, defaultLimits: null, limitsSchema: null, ...over,
})
const RULES: ClaudeRules = {
  autonomy: { paused: false, pausedAt: null, pausedBy: null, reason: null, dailyAutoCap: 200, autoRunsLastDay: 1 },
  tools: [
    tool('product-search', 'Search products', { readOnly: true, levels: ['off', 'ask'], ceiling: 'ask' }),
    tool('set-price', 'Set price', {
      limits: { maxChangePercent: 10 }, defaultLimits: { maxChangePercent: 10 },
      limitsSchema: { type: 'object', properties: { maxChangePercent: { type: 'number', description: 'the most the price may move, in percent', maximum: 100 } } },
    }),
    tool('set-product-tags', 'Set product tags'),
  ],
}
const markup = () => renderToStaticMarkup(createElement(RulesPanel, { rules: RULES, onChanged: () => undefined }))

/** The controls Tab stops on, in order: their accessible names. */
function tabOrder(html: string): string[] {
  return [...html.matchAll(/<(input|select|button|a|textarea)\b([^>]*)>/g)]
    .filter(([, , attrs]) => !/tabindex="-1"|disabled=""/.test(attrs))
    .map(([, tag, attrs]) => attrs.match(/aria-label="([^"]*)"/)?.[1] ?? attrs.match(/id="([^"]*)"/)?.[1] ?? tag)
}

describe('Rules: every control is a Tab away, in the order shown', () => {
  it('Pause, the daily limit, then each tool\'s Level select and limits Edit; no grid to get lost in', () => {
    const html = markup()
    expect(html).not.toMatch(/role="grid"|ag-root|ag-header/)
    const order = tabOrder(html)
    const levels = order.filter((name) => name.startsWith('Level for '))
    expect(levels).toEqual(['Level for Search products', 'Level for Set price', 'Level for Set product tags'])
    expect(order.indexOf('Edit limits for Set price')).toBe(order.indexOf('Level for Set price') + 1)
    // The brakes come first: the Pause switch and the daily limit before any tool.
    expect(html.indexOf('role="switch"')).toBeLessThan(html.indexOf('Level for Search products'))
  })

  it('each tool says what it is, what it does, its ceiling and its limits beside its controls', () => {
    const html = markup()
    for (const text of ['Set price', 'set-price', 'Changes', 'At most', 'Limits for Auto']) expect(html).toContain(text)
  })
})

describe('Rules at phone width: each tool stacks, nothing scrolls sideways', () => {
  const css = readFileSync(join(import.meta.dirname, 'claude.css'), 'utf8')
  const narrow = css.match(/@container claude-tools \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/)

  it('the list measures its own width and stacks below a phone-sized width', () => {
    expect(css).toMatch(/\.claude-tools \{[^}]*container: claude-tools \/ inline-size/)
    expect(narrow, 'a @container claude-tools (max-width: …px) block').not.toBeNull()
    expect(Number(narrow![1])).toBeGreaterThanOrEqual(480)
    expect(narrow![2]).toMatch(/\.claude-tools-head \{ display: none; \}/)
    expect(narrow![2]).toMatch(/\.claude-tool-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
  })

  it('no column asks for a fixed width a phone cannot give', () => {
    expect(css).not.toMatch(/min-width: (?!0)[\d.]+(px|rem)/)
    expect(css).not.toMatch(/minmax\((?!0,)/)
  })
})
