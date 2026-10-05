/**
 * Approvals grid — a change plan's words in the drawer (grid/planWords.ts). Ported from the old card's
 * planWords.vitest.test.ts, planSteps.vitest.test.ts and ApprovalCard.generic.vitest.test.ts (clean-up F, 2026-10-05):
 * the assertions that still describe what the drawer says. The old counted button (`planButton`) left with its card.
 */
import { describe, expect, it } from 'vitest'
import { STEP_STATUS, kindSentence, plainValue, rovingTarget, stepMatches, stepWhat, type PlanKind, type PlanStep } from './planWords'

const kinds: PlanKind[] = [
  { tool: 'set-price', title: 'Set master price', count: 120, outbound: true, reversibility: 'full' },
  { tool: 'apply-content', title: 'Apply content', count: 17, outbound: false, reversibility: 'full' },
  { tool: 'send-customer-message', title: 'Message a customer', count: 1, outbound: true, reversibility: 'none' },
  { tool: 'publish-listing', title: 'Publish a listing', count: 1, outbound: true, reversibility: 'partial' },
]

describe('one line per kind of change', () => {
  it('says how many, what, where it lands and whether it can be put back', () => {
    expect(kindSentence(kinds[0])).toBe('120 × Set master price — reach a marketplace or a buyer; can be undone')
    expect(kindSentence(kinds[1])).toBe('17 × Apply content — stay in Nexus; can be undone')
    expect(kindSentence(kinds[2])).toBe('1 × Message a customer — reaches a marketplace or a buyer; cannot be undone')
    expect(kindSentence(kinds[3])).toBe('1 × Publish a listing — reaches a marketplace or a buyer; can be partly undone')
  })
})

describe('the steps', () => {
  const step: PlanStep = {
    step: 3, tool: 'set-price', title: 'Set master price', status: 'pending', reason: null, changeId: null, undoesChangeId: null, outbound: true,
    preview: { action: 'set-price', sku: 'TEST-SKU-1', changes: { 'base price': { from: 19.9, to: 21 } } },
  }

  it('each step in one line: what it changes, from what to what', () => {
    expect(stepWhat(step)).toBe('TEST-SKU-1 · base price: 19.9 → 21')
    expect(stepWhat({ ...step, preview: null, previewHidden: 'The preview needs the permissions of set-price.' })).toBe('The preview needs the permissions of set-price.')
    expect(stepWhat({ ...step, preview: { action: 'bulk-price-change', effect: 'Master price +5 % on 3 products.' } })).toBe('Master price +5 % on 3 products.')
    expect(stepWhat({ ...step, preview: {} })).toBe('Set master price')
  })

  // The 2026-10-02 browser check showed raw JSON in this line: 'tags: [] → ["Clearance","Winter"]'.
  it('a list or an object reads as words, never raw JSON; an empty list says so', () => {
    const tags = { ...step, preview: { sku: 'TEST-SKU-2', changes: { tags: { from: [], to: ['Clearance', 'Winter'] } } } }
    expect(stepWhat(tags)).toBe('TEST-SKU-2 · tags: (none) → Clearance, Winter')
    const keywords = { ...step, preview: { sku: 'TEST-SKU-3', changes: { keywords: { from: null, to: ['test keyword'] }, size: { from: { unit: 'cm' }, to: { unit: 'mm' } } } } }
    expect(stepWhat(keywords)).toBe('TEST-SKU-3 · keywords: — → test keyword; size: unit: cm → unit: mm')
    expect(stepWhat(tags)).not.toMatch(/[[\]{}"]/)
    const three = { ...step, preview: { changes: { a: { from: 1, to: 2 }, b: { from: 1, to: 2 }, c: { from: 1, to: 2 } } } }
    expect(stepWhat(three)).toBe('a: 1 → 2; b: 1 → 2; and 1 more')
  })

  it('a value in words: a list, a flat object, a deep one counted', () => {
    expect(plainValue(['IT', 'DE'])).toBe('IT, DE')
    expect(plainValue(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
    expect(plainValue({ handling: 2, markets: ['IT'] })).toBe('handling: 2, markets: IT')
    expect(plainValue({ a: { b: 1 } })).toBe('a: 1 field')
    expect(plainValue(null)).toBe('—')
    expect(plainValue(true)).toBe('yes')
  })

  it('the filter matches the step number, the change and what it touches, in any case', () => {
    expect(stepMatches(step, 'test-sku')).toBe(true)
    expect(stepMatches(step, 'master price')).toBe(true)
    expect(stepMatches(step, '3')).toBe(true)
    expect(stepMatches(step, 'apply')).toBe(false)
    expect(stepMatches(step, '')).toBe(true)
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

  it('a step’s fate in words', () => {
    expect(STEP_STATUS.pending).toBe('To run')
    expect(STEP_STATUS.failed).toBe('Failed')
  })
})
