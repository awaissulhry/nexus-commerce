import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScopeBar, scopeMenuOptions, worstScopeState, type ScopeBarItem } from './ScopeBar'

/**
 * Step 4.3 #2 (T1, R-51 / R-53) — the scope bar's menu form, and the chips it must NOT change.
 * Static markup in node (no DOM): the popover is closed, so what is asserted is the trigger and the rows
 * the menu would list (`scopeMenuOptions`, the same function the open panel renders).
 */
const items: ScopeBarItem[] = [
  { id: 'master', label: 'Shared product', readiness: { pct: 64, state: 'warn', note: 'n' } },
  { id: 'AMAZON', label: 'Amazon', readiness: { pct: 71, state: 'blocked' } },
  { id: 'EBAY', label: 'eBay', readiness: 'loading' },
  { id: 'SHOPIFY', label: 'Shopify', readiness: { pct: null, state: 'absent' } },
  { id: 'ETSY', label: 'Etsy', disabled: true, disabledReason: 'Reconnect it in Settings.' },
]
const fixture = { label: 'Editing', active: 'AMAZON', onChange: () => {}, right: createElement('span', null, 'R'), items }
const html = (props: Parameters<typeof ScopeBar>[0]) => renderToStaticMarkup(createElement(ScopeBar, props)).replace(/_R_[a-z0-9]+_/g, 'ID')

/** Recorded from the ORIGINAL ScopeBar (HEAD before Step 4.3 #2) on this fixture — the chips must not move a byte. */
const CHIPS_GOLDEN = "<div class=\"nds-scopebar\"><span class=\"nds-scopebar-label\" id=\"ID\">Editing</span><div class=\"nds-scopebar-chips\" role=\"radiogroup\" aria-labelledby=\"ID\"><button type=\"button\" role=\"radio\" aria-checked=\"false\" tabindex=\"-1\" data-scope-id=\"master\" class=\"nds-scope\" title=\"Shared product \u2014 Warnings \u00b7 64%. n\"><span class=\"nds-scope-dot warning\" aria-hidden=\"true\"></span><span class=\"nds-scope-label\">Shared product</span><span class=\"nds-scope-sep\" aria-hidden=\"true\">\u00b7</span><span class=\"nds-scope-state\">Warnings</span><span class=\"nds-scope-pct\">64%</span></button><button type=\"button\" role=\"radio\" aria-checked=\"true\" tabindex=\"0\" data-scope-id=\"AMAZON\" class=\"nds-scope on\" title=\"Amazon \u2014 Blocked \u00b7 71%. Required fields are missing or invalid \u2014 this scope cannot publish\"><span class=\"nds-scope-dot danger\" aria-hidden=\"true\"></span><span class=\"nds-scope-label\">Amazon</span><span class=\"nds-scope-sep\" aria-hidden=\"true\">\u00b7</span><span class=\"nds-scope-state\">Blocked</span><span class=\"nds-scope-pct\">71%</span></button><button type=\"button\" role=\"radio\" aria-checked=\"false\" tabindex=\"-1\" data-scope-id=\"EBAY\" class=\"nds-scope\" title=\"eBay \u2014 checking readiness\u2026\"><span class=\"nds-scope-label\">eBay</span><span class=\"nds-scope-pct loading\" role=\"status\" aria-busy=\"true\" aria-label=\"eBay \u2014 checking readiness\"></span></button><button type=\"button\" role=\"radio\" aria-checked=\"false\" tabindex=\"-1\" data-scope-id=\"SHOPIFY\" class=\"nds-scope\" title=\"Shopify \u2014 Not set up. Nothing has been set up for this scope yet\"><span class=\"nds-scope-dot neutral\" aria-hidden=\"true\"></span><span class=\"nds-scope-label\">Shopify</span><span class=\"nds-scope-sep\" aria-hidden=\"true\">\u00b7</span><span class=\"nds-scope-state\">Not set up</span></button><span class=\"h10-tipwrap\"><button type=\"button\" role=\"radio\" aria-checked=\"false\" tabindex=\"-1\" data-scope-id=\"ETSY\" class=\"nds-scope\" aria-disabled=\"true\" title=\"Reconnect it in Settings.\" aria-description=\"Reconnect it in Settings.\"><span class=\"nds-scope-label\">Etsy</span></button></span></div><div class=\"nds-scopebar-right\"><span>R</span></div></div>"

describe('ScopeBar chips (the default) — unchanged', () => {
  it('renders byte-for-byte what it rendered before the menu variant existed', () => {
    expect(html(fixture)).toBe(CHIPS_GOLDEN)
  })
})

describe('worstScopeState — the shared severity order, absent ignored', () => {
  it.each([
    [['ready', 'warn'], 'warn'],
    [['absent', 'ready'], 'ready'],
    [['absent'], null],
    [[], null],
    [['notComputed', 'ready'], 'notComputed'],
    [['ready', 'blocked', 'warn'], 'blocked'],
  ] as const)('%j -> %s', (states, worst) => {
    expect(worstScopeState(states)).toBe(worst)
  })
})

describe('ScopeBar variant="menu" (R-51)', () => {
  const menu = html({ ...fixture, variant: 'menu' })
  it('is ONE 28px trigger in the chip box — no radiogroup, no radios', () => {
    expect(menu).not.toContain('role="radio"')
    expect(menu.match(/class="nds-scope nds-scope-trigger"/g)).toHaveLength(1)
    expect(menu).toContain('data-scope-id="AMAZON"')
    expect(menu).toContain('aria-haspopup="listbox"')
    expect(menu).toContain('class="nds-scopebar is-menu"')
  })
  it('shows the active scope exactly as its chip did: dot, label, state word, percentage', () => {
    expect(menu).toContain('<span class="nds-scope-dot danger" aria-hidden="true"></span><span class="nds-scope-label">Amazon</span>')
    expect(menu).toContain('<span class="nds-scope-state">Blocked</span>')
    expect(menu).toContain('<span class="nds-scope-pct">71%</span>')
  })
  it('a HELD active scope carries its reason on the trigger (the gate reads data-scope-held + aria-description)', () => {
    const held = html({ ...fixture, variant: 'menu', active: 'ETSY' })
    expect(held).toContain('data-scope-held="true"')
    expect(held).toContain('aria-description="Reconnect it in Settings."')
  })
  it('lists EVERY scope with its state — the states move behind a click, never dropped', () => {
    const rows = scopeMenuOptions(items)
    expect(rows.map(r => r.value)).toEqual(['master', 'AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'])
    expect(rows.map(r => r.trailing)).toEqual(['Warnings · 64%', 'Blocked · 71%', 'Checking…', 'Not set up', 'Unavailable'])
    expect(rows[4].heldReason).toBe('Reconnect it in Settings.')
    expect(rows.slice(0, 4).every(r => r.heldReason === undefined)).toBe(true)
  })
  it('showPercent={false} keeps the state word and drops only the number', () => {
    expect(scopeMenuOptions(items, false).map(r => r.trailing).slice(0, 2)).toEqual(['Warnings', 'Blocked'])
  })
})

describe('ScopeBarReadiness.summary (R-53)', () => {
  const shared: ScopeBarItem[] = [{ id: 'master', label: 'Shared product', readiness: { pct: 100, state: 'warn', summary: 'See each channel' } }, items[1]]
  it('replaces the state word AND the percentage, on the chip and in the menu; the dot keeps the tone', () => {
    const chips = html({ ...fixture, items: shared, active: 'master' })
    expect(chips).toContain('<span class="nds-scope-state">See each channel</span>')
    expect(chips).not.toContain('100%')
    expect(chips).toContain('nds-scope-dot warning')
    expect(scopeMenuOptions(shared)[0].trailing).toBe('See each channel')
    expect(html({ ...fixture, items: shared, active: 'master', variant: 'menu' })).not.toContain('100%')
  })
})
