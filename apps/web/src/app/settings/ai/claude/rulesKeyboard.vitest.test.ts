/**
 * MCP full control C9 — Settings › AI › Claude › Rules, by keyboard and at phone width (the 2026-10-02 browser check).
 *
 * The tools were a NexusGrid: Tab stayed in its header row (89 of 90 presses) and no Level select could be reached.
 * The tools are now a list: Tab goes Pause → "Claude’s changes need no approval" → the daily limit → Save → each tool's
 * Level select and its limits' Edit, in the order they are shown, and below a phone-sized width each tool stacks instead
 * of scrolling sideways.
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
const markup = (rules: ClaudeRules = RULES) => renderToStaticMarkup(createElement(RulesPanel, { rules, onChanged: () => undefined }))

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

describe('Rules: “Claude’s changes need no approval”', () => {
  /** The switches, in order, each with the words its aria-labelledby names. */
  const switches = (html: string) => [...html.matchAll(/<button\b([^>]*role="switch"[^>]*)>/g)].map(([, attrs]) => {
    const label = `id="${attrs.match(/aria-labelledby="([^"]*)"/)?.[1]}">`
    const at = html.indexOf(label)
    return { attrs, name: at < 0 ? undefined : html.slice(at + label.length, html.indexOf('<', at)) }
  })

  it('a second switch in the brakes, after Pause and before the daily limit; an older API answer reads as off', () => {
    const html = markup()
    const [pause, noApproval] = switches(html)
    expect(pause.name).toBe('Pause every change that runs by rule')
    expect(noApproval.name).toBe('Claude’s changes need no approval')
    expect(noApproval.attrs).toContain('aria-checked="false"')
    expect(noApproval.attrs).not.toMatch(/tabindex="-1"|disabled=""/)
    expect(html.indexOf('Claude’s changes need no approval')).toBeLessThan(html.indexOf('Most changes that may run by rule'))
    expect(html).toContain('Each kind below follows its own level.')
    expect(html).not.toContain('No approval needed is on')
  })

  it('on: since when and by whom, one notice above the tools, and every Level select still editable', () => {
    const html = markup({ ...RULES, autonomy: { ...RULES.autonomy, noApproval: { on: true, since: '2026-10-20T08:00:00.000Z', by: 'Ada' } } })
    expect(switches(html)[1].attrs).toContain('aria-checked="true"')
    expect(html).toMatch(/On since [^<]+ by Ada\./)
    expect(html).toContain('This includes refunds, buyer messages, deletes and Google Ads.')
    expect(html.match(/No approval needed is on: the levels below apply only when it is off\./g)).toHaveLength(1)
    expect(html.indexOf('No approval needed is on')).toBeLessThan(html.indexOf('Level for Search products'))
    expect(tabOrder(html).filter((name) => name.startsWith('Level for '))).toHaveLength(3)
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
