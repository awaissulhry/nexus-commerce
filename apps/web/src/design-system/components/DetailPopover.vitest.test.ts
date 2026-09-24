import { createElement } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DetailPopover } from './DetailPopover'
import { detailPopoverClickAway, detailPopoverKey, detailPopoverOpenFocus } from './detailPopoverKeys'
import { ScopeReadinessCell } from '../grid/renderers/cells'

/**
 * A-45 (Step 4.3 #4) — `DetailPopover`, the DS toggletip that can hold actions. `apps/web` vitest is node-only:
 * the keyboard rule is tested as a pure table, the trigger as static markup.
 */
describe('the keyboard table (detailPopoverKeys)', () => {
  it('Esc closes and RETURNS focus', () => {
    expect(detailPopoverKey('Escape', false, 1, 3)).toEqual({ action: 'close', returnFocus: true })
  })
  it('Tab stays inside: from the last action to the first; from the panel itself to the first', () => {
    expect(detailPopoverKey('Tab', false, 2, 3)).toEqual({ action: 'focus', index: 0 })
    expect(detailPopoverKey('Tab', false, -1, 3)).toEqual({ action: 'focus', index: 0 })
    expect(detailPopoverKey('Tab', false, 0, 3)).toEqual({ action: 'none' }) // in between: the browser's
  })
  it('Shift+Tab from the first action wraps to the last', () => {
    expect(detailPopoverKey('Tab', true, 0, 3)).toEqual({ action: 'focus', index: 2 })
    expect(detailPopoverKey('Tab', true, 2, 3)).toEqual({ action: 'none' })
  })
  it('with no action inside, Tab keeps focus on the panel instead of walking out', () => {
    expect(detailPopoverKey('Tab', false, -1, 0)).toEqual({ action: 'focus', index: -1 })
  })
  it('every other key belongs to the focused control', () => {
    expect(detailPopoverKey('Enter', false, 0, 3)).toEqual({ action: 'none' })
    expect(detailPopoverKey('ArrowDown', false, 0, 3)).toEqual({ action: 'none' })
  })
  it('opening by click or keyboard moves focus in; hover never does', () => {
    expect(detailPopoverOpenFocus('keyboard', 2)).toBe(0)
    expect(detailPopoverOpenFocus('click', 0)).toBe(-1)
    expect(detailPopoverOpenFocus('hover', 2)).toBeNull()
  })
  it('a click away closes WITHOUT moving focus', () => {
    expect(detailPopoverClickAway()).toEqual({ action: 'close', returnFocus: false })
  })
})

describe('the trigger', () => {
  it('is a real button naming a dialog, with the whole sentence as its name; closed, nothing is portaled', () => {
    const html = render(createElement(DetailPopover, { trigger: 'Blocked · 82%', triggerLabel: 'Amazon · IT, German: Blocked. Show details.', label: 'Completeness', children: 'Body' }))
    expect(html).toContain('<button type="button" class="nds-detailpop-trigger"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Amazon · IT, German: Blocked. Show details."')
    expect(html).toContain('data-cell-detail-trigger=""')
    expect(html).not.toContain('role="dialog"')
  })
})

describe('ScopeReadinessCell (W4)', () => {
  const params = (extra: Record<string, unknown> = {}) => ({ value: { state: 'blocked', pct: 82, note: 'server sentence' }, ...extra }) as never
  it('without detail params the cell is exactly what it was — no trigger, the InfoTip note', () => {
    // Pinned byte for byte (captured 2026-09-24 from the cell before A-45 touched it): every other caller unchanged.
    expect(render(createElement(ScopeReadinessCell, params()))).toBe('<span class="h10-tipwrap"><span class="nds-pill danger">Blocked · 82%</span></span>')
  })
  it('with detail params the pill becomes the trigger of the detail', () => {
    const html = render(createElement(ScopeReadinessCell, params({ detail: () => () => 'card', detailLabels: () => ({ trigger: 'Amazon · IT: Blocked. Show details.', panel: 'Completeness' }) })))
    expect(html).toContain('nds-detailpop-trigger')
    expect(html).toContain('aria-label="Amazon · IT: Blocked. Show details."')
    expect(html).toContain('82%')
  })
  it('a detail that returns null keeps the plain cell', () => {
    const html = render(createElement(ScopeReadinessCell, params({ detail: () => null, detailLabels: () => ({ trigger: 't', panel: 'p' }) })))
    expect(html).not.toContain('nds-detailpop-trigger')
  })
})
