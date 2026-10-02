/**
 * MCP full control C9 — the change-plan card on the Approvals page: one summary sentence, one tick per KIND of
 * consequence, a table of steps a person may filter and untick, and ONE counted button.
 *
 *   all ticked, nothing unticked   → "Approve N changes"
 *   steps unticked                 → "Make a plan of the N ticked changes" (a smaller plan, re-checked; approved next)
 *   a kind not ticked yet          → the button waits, and says what it waits for
 */
import { describe, expect, it } from 'vitest'
import { kindSentence, planButton, stepMatches, stepWhat, type PlanKind, type PlanStep } from './planWords'

const kinds: PlanKind[] = [
  { tool: 'set-price', title: 'Set master price', count: 120, outbound: true, reversibility: 'full' },
  { tool: 'apply-content', title: 'Apply content', count: 17, outbound: false, reversibility: 'full' },
  { tool: 'send-customer-message', title: 'Message a customer', count: 1, outbound: true, reversibility: 'none' },
]

describe('one tick per kind of consequence', () => {
  it('says what that kind of change does, where it lands and whether it can be put back', () => {
    expect(kindSentence(kinds[0])).toBe('120 × Set master price — reach a marketplace or a buyer; can be undone')
    expect(kindSentence(kinds[1])).toBe('17 × Apply content — stay in Nexus; can be undone')
    expect(kindSentence(kinds[2])).toBe('1 × Message a customer — reaches a marketplace or a buyer; cannot be undone')
  })
})

describe('the counted button', () => {
  const all = new Set(kinds.map((k) => k.tool))

  it('every kind ticked and every step kept: approve them all', () => {
    expect(planButton({ total: 138, kept: 138, kinds, ticked: all, busy: false })).toEqual({ label: 'Approve 138 changes', action: 'approve', disabled: false, waiting: null })
  })

  it('a kind not ticked yet: the button waits, and says for what', () => {
    const out = planButton({ total: 138, kept: 138, kinds, ticked: new Set(['set-price']), busy: false })
    expect(out).toMatchObject({ action: 'approve', disabled: true, waiting: 'Tick each kind of change above to approve: 2 not ticked yet.' })
  })

  it('steps unticked: first a smaller plan of the ticked ones, re-checked; nothing is approved by this press', () => {
    expect(planButton({ total: 138, kept: 100, kinds, ticked: new Set(), busy: false })).toEqual({
      label: 'Make a plan of the 100 ticked changes', action: 'amend', disabled: false, waiting: null,
    })
    expect(planButton({ total: 138, kept: 0, kinds, ticked: all, busy: false })).toMatchObject({ action: 'amend', disabled: true, waiting: 'Keep at least one change, or reject the plan.' })
  })

  it('one change reads as one', () => {
    expect(planButton({ total: 1, kept: 1, kinds: [kinds[1]], ticked: new Set(['apply-content']), busy: false }).label).toBe('Approve 1 change')
  })

  it('busy: nothing can be pressed twice', () => {
    expect(planButton({ total: 2, kept: 2, kinds: [kinds[1]], ticked: new Set(['apply-content']), busy: true }).disabled).toBe(true)
  })
})

describe('the table of steps', () => {
  const step: PlanStep = {
    step: 3, tool: 'set-price', title: 'Set master price', status: 'pending', reason: null, changeId: null, undoesChangeId: null, outbound: true,
    preview: { action: 'set-price', sku: 'TEST-SKU-1', changes: { 'base price': { from: 19.9, to: 21 } } },
  }

  it('each step in one line: what it changes, from what to what', () => {
    expect(stepWhat(step)).toBe('TEST-SKU-1 · base price: 19.9 → 21')
    expect(stepWhat({ ...step, preview: null, previewHidden: 'The preview needs the permissions of set-price.' })).toBe('The preview needs the permissions of set-price.')
    expect(stepWhat({ ...step, preview: { action: 'bulk-price-change', effect: 'Master price +5 % on 3 products.' } })).toBe('Master price +5 % on 3 products.')
  })

  // The 2026-10-02 browser check showed raw JSON in this column: 'tags: [] → ["Clearance","Winter"]'.
  it('a list or an object reads as words, never raw JSON; an empty list says so', () => {
    const tags = { ...step, preview: { sku: 'TEST-SKU-2', changes: { tags: { from: [], to: ['Clearance', 'Winter'] } } } }
    expect(stepWhat(tags)).toBe('TEST-SKU-2 · tags: (none) → Clearance, Winter')
    const keywords = { ...step, preview: { sku: 'TEST-SKU-3', changes: { keywords: { from: null, to: ['test keyword'] }, size: { from: { unit: 'cm' }, to: { unit: 'mm' } } } } }
    expect(stepWhat(keywords)).toBe('TEST-SKU-3 · keywords: — → test keyword; size: unit: cm → unit: mm')
    expect(stepWhat(tags)).not.toMatch(/[[\]{}"]/)
  })

  it('the filter matches the step number, the change and what it touches, in any case', () => {
    expect(stepMatches(step, 'test-sku')).toBe(true)
    expect(stepMatches(step, 'master price')).toBe(true)
    expect(stepMatches(step, '3')).toBe(true)
    expect(stepMatches(step, 'apply')).toBe(false)
    expect(stepMatches(step, '')).toBe(true)
  })
})
