/**
 * MCP full control C9 — the change plan's steps, by keyboard (the 2026-10-02 browser check, light/dark × 390/1280).
 *
 * The steps were a NexusGrid: Tab walked through every cell (19 to 49 extra stops) and, at 390 px, never reached the
 * counted "Approve N changes" button in 220 presses. The list is now ONE tab stop: Tab lands on one step's Keep tick,
 * the arrow keys (and Home / End) move between the steps, and the next Tab leaves the list for the button.
 * Rendered HTML (node SSR) and the pure key rule.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlanStepList } from './PlanCard'
import { rovingTarget, type PlanStep } from './planWords'

const step = (n: number, over: Partial<PlanStep> = {}): PlanStep => ({
  step: n, tool: 'set-product-tags', title: 'Set product tags', status: 'pending', reason: null, changeId: null,
  undoesChangeId: null, outbound: false, preview: { sku: `TEST-SKU-${n}`, changes: { tags: { from: [], to: ['Winter'] } } }, ...over,
})
const html = (steps: PlanStep[], unticked: number[] = []) =>
  renderToStaticMarkup(createElement(PlanStepList, { steps, unticked: new Set(unticked), busy: false, onToggle: () => undefined }))
const tabStops = (markup: string) =>
  [...markup.matchAll(/<(input|select|button|a|textarea)\b[^>]*>/g)].filter(([tag]) => !/tabindex="-1"|disabled=""/.test(tag)).length

describe('the steps of a plan are one tab stop', () => {
  it('one Keep tick takes Tab, the others wait for the arrow keys; no grid', () => {
    const markup = html([step(1), step(2), step(3)])
    expect(tabStops(markup)).toBe(1)
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(2)
    expect(markup).toMatch(/aria-label="Keep step 1"[^>]*tabindex="0"|tabindex="0"[^>]*aria-label="Keep step 1"/)
    expect(markup).not.toMatch(/role="grid"|ag-root/)
    // 200 steps: still one stop.
    expect(tabStops(html(Array.from({ length: 200 }, (_, i) => step(i + 1))))).toBe(1)
  })

  it('each step says what it is: its number, its change, what it changes, where it lands, its fate', () => {
    const markup = html([step(1, { outbound: true })], [1])
    expect(markup).toContain('Set product tags')
    expect(markup).toContain('TEST-SKU-1')
    expect(markup).toContain('Marketplace or buyer')
    expect(markup).toContain('To run')
    expect(markup).toMatch(/aria-label="Keep step 1"/)
    expect(markup).not.toMatch(/checked=""/) // unticked
  })

  it('the arrow keys move between the steps, Home and End to the ends; anything else is left alone', () => {
    expect(rovingTarget('ArrowDown', 0, 3)).toBe(1)
    expect(rovingTarget('ArrowDown', 2, 3)).toBe(2)
    expect(rovingTarget('ArrowUp', 1, 3)).toBe(0)
    expect(rovingTarget('ArrowUp', 0, 3)).toBe(0)
    expect(rovingTarget('Home', 2, 3)).toBe(0)
    expect(rovingTarget('End', 0, 3)).toBe(2)
    expect(rovingTarget('Tab', 0, 3)).toBeNull()
    expect(rovingTarget(' ', 0, 3)).toBeNull()
    expect(rovingTarget('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('at phone width each step is one stacked row: no sideways scroll', () => {
  // The 2026-10-02 browser check at 390 px: the grid showed only Keep and Step; "What it changes" needed a sideways scroll.
  const css = readFileSync(join(import.meta.dirname, 'planCard.css'), 'utf8')
  const narrow = css.match(/@container plan-steps \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/)

  it('the list measures its own width (a card, not the window), and stacks below a phone-sized width', () => {
    expect(css).toMatch(/\.plan-steps \{[^}]*container: plan-steps \/ inline-size/)
    expect(narrow, 'a @container plan-steps (max-width: …px) block').not.toBeNull()
    expect(Number(narrow![1])).toBeGreaterThanOrEqual(480)
  })

  it('stacked: no header row, the tick beside one column of step, change, what it changes, reach and fate', () => {
    const block = narrow![2]
    expect(block).toMatch(/\.plan-steps-head \{ display: none; \}/)
    expect(block).toMatch(/\.plan-step \{[^}]*grid-template-columns: auto minmax\(0, 1fr\)/)
    expect(block).toMatch(/\.plan-step > :not\(\.plan-step-keep\) \{ grid-column: 2; \}/)
    // The word "Step" is read on screen only when the header is gone.
    expect(block).toMatch(/\.plan-step-label \{[^}]*position: static/)
  })

  it('nothing in a row asks for a fixed width that a phone cannot give', () => {
    expect(css).not.toMatch(/min-width: (?!0)[\d.]+(px|rem)/)
    expect(css).not.toMatch(/minmax\((?!0,)/)
  })
})
