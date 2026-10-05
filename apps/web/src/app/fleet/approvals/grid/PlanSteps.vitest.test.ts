/**
 * Approvals grid — the drawer's plan steps stay a LIST and ONE tab stop (the 2026-10-02 rule, pinned for the old card
 * by settings/ai/claude/claudePage.vitest.test.ts), and the drawer's files are built on the design system only.
 * Rendered HTML (node SSR) and the source text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PlanStep } from '../planWords'
import { PlanStepsList } from './PlanSteps'

const step = (n: number, over: Partial<PlanStep> = {}): PlanStep => ({
  step: n, tool: 'set-product-tags', title: 'Set product tags', status: 'pending', reason: null, changeId: null,
  undoesChangeId: null, outbound: false, preview: { sku: `TEST-SKU-${n}`, changes: { tags: { from: [], to: ['Winter'] } } }, ...over,
})
const html = (steps: PlanStep[], editable: boolean, unticked: number[] = []) =>
  renderToStaticMarkup(createElement(PlanStepsList, { steps, editable, unticked: new Set(unticked), busy: false, onToggle: () => undefined }))
/** Focusable elements: controls not taken out of the order, and anything with tabindex="0". */
const tabStops = (markup: string) =>
  [...markup.matchAll(/<(input|select|button|a|textarea)\b[^>]*>/g)].filter(([tag]) => !/tabindex="-1"|disabled=""/.test(tag)).length
  + [...markup.matchAll(/<(ol|ul|div|li|span)\b[^>]*tabindex="0"[^>]*>/g)].length

describe('the steps of a plan are one tab stop, and never a grid', () => {
  it('while the plan waits: one Keep tick takes Tab, the others wait for the arrow keys', () => {
    const markup = html([step(1), step(2), step(3)], true)
    expect(tabStops(markup)).toBe(1)
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(2)
    expect(markup).not.toMatch(/role="grid"|ag-root/)
    expect(tabStops(html(Array.from({ length: 200 }, (_, i) => step(i + 1)), true))).toBe(1)
  })

  it('after it was decided: no ticks, and the list itself is the one stop (its scroll area is reachable)', () => {
    const markup = html([step(1, { status: 'done' }), step(2, { status: 'failed', reason: 'Price below the floor' })], false)
    expect(markup).not.toMatch(/<input/)
    expect(tabStops(markup)).toBe(1)
    expect(markup).toMatch(/<ol[^>]*tabindex="0"/)
    expect(markup).toContain('Why it failed: Price below the floor')
    expect(markup).toContain('Done')
  })

  it('each step says what it is: its number, change, what it touches, where it lands, its fate', () => {
    const markup = html([step(7, { outbound: true })], true, [7])
    expect(markup).toContain('Step 7')
    expect(markup).toContain('Set product tags')
    expect(markup).toContain('TEST-SKU-7')
    expect(markup).toContain('Marketplace or buyer')
    expect(markup).toContain('To run')
    expect(markup).not.toMatch(/checked=""/)
  })
})

describe('the drawer is built on the design system only', () => {
  const HERE = import.meta.dirname
  const FILES = ['ApprovalDrawer.tsx', 'PlanSteps.tsx', 'EditValue.tsx', 'useApprovalDetail.ts', 'drawerWords.ts']
  const source = (name: string) => readFileSync(join(HERE, name), 'utf8')

  it('no raw control or table, no legacy kit, no grid for the steps, no HTML from data', () => {
    for (const name of FILES) {
      const text = source(name)
      expect(text, name).not.toMatch(/<(button|input|select|table|textarea)[\s>]/)
      expect(text, name).not.toMatch(/components\/ui/)
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML/)
      expect(text, name).not.toMatch(/<NexusGrid|<DataGrid/)
      // Only module classes, the DS's visually-hidden helper and the fleet light pin: no Tailwind.
      for (const [, classes] of text.matchAll(/className="([^"]*)"/g)) expect(classes, name).toMatch(/^(nds-vh)$/)
    }
    expect(source('ApprovalDrawer.tsx')).toMatch(/className=\{`fleet-portal \$\{styles\.drawer\}`\}/)
  })

  it('the stylesheet holds layout only, on the design tokens', () => {
    const css = source('ApprovalDrawer.module.css')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/font-size:\s*\d/)
    expect(css).not.toMatch(/var\(--(?!nds-)/)
  })
})
