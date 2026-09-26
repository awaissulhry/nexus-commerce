/**
 * Progress columns (2026-09-26) — colour rule A and the card model. The colour says WHAT is missing, never how much
 * (#43, #727); grey is "cannot say", never a guess (R-LX-9).
 */
import { describe, expect, it } from 'vitest'
import { combinedPercent, OPTIONAL_NOT_RECORDED, progressDetailModel, progressListKey, progressPercent, progressText, progressTone,
  progressTriggerLabel, REQUIRED_NAMES_NOT_RECORDED, type ProgressValue } from './progress'

const f = (field: string) => ({ field, label: field[0].toUpperCase() + field.slice(1) })
const value = (over: Partial<ProgressValue> = {}): ProgressValue => ({
  pct: 50, required: { filled: 3, total: 3 }, optional: { filled: 2, total: 4 }, requiredEmpty: [], optionalEmpty: [f('colour'), f('material')], ...over,
})

describe('progressTone — colour rule A', () => {
  it('red when a required field is empty, whatever the percentage', () => {
    expect(progressTone(value({ pct: 96, required: { filled: 24, total: 25 }, requiredEmpty: [f('brand')] }))).toBe('missing')
    // The count alone is enough: an index row can know HOW MANY before it knows the names.
    expect(progressTone(value({ pct: 96, required: { filled: 24, total: 25 }, requiredEmpty: [] }))).toBe('missing')
  })
  it('yellow when every required field is filled and an optional one is empty — even at 12%', () => {
    expect(progressTone(value({ pct: 12 }))).toBe('partial')
  })
  it('green only when nothing is empty', () => {
    expect(progressTone(value({ pct: 100, optional: { filled: 4, total: 4 }, optionalEmpty: [] }))).toBe('complete')
  })
  it('grey when it cannot be said — never green on a guess', () => {
    expect(progressTone(null)).toBe('unknown')
    expect(progressTone(value({ optional: null, optionalEmpty: null }))).toBe('unknown')
    expect(progressTone(value({ pct: null, note: 'Category metadata is incomplete' }))).toBe('unknown')
  })
  it('a KNOWN empty required field stays red while the optional side is unknown', () => {
    expect(progressTone(value({ pct: null, optional: null, optionalEmpty: null, requiredEmpty: [f('brand')], required: { filled: 2, total: 3 } }))).toBe('missing')
  })
  it('the percentage never decides the colour', () => {
    for (const pct of [0, 12, 50, 99, 100]) {
      expect(progressTone(value({ pct, requiredEmpty: [f('brand')], required: { filled: 2, total: 3 } }))).toBe('missing')
      expect(progressTone(value({ pct }))).toBe('partial')
    }
  })
})

describe('percent helpers', () => {
  it('rounds and clamps once; null stays null', () => {
    expect(progressPercent(20.6)).toBe(21)
    expect(progressPercent(130)).toBe(100)
    expect(progressPercent(-4)).toBe(0)
    expect(progressPercent(null)).toBeNull()
    expect(progressPercent(Number.NaN)).toBeNull()
  })
  it('combines both sides, and refuses when the optional side is not recorded', () => {
    expect(combinedPercent({ filled: 3, total: 4 }, { filled: 1, total: 4 })).toBe(50)
    expect(combinedPercent(null, { filled: 0, total: 0 })).toBe(100)
    expect(combinedPercent({ filled: 3, total: 4 }, null)).toBeNull()
  })
})

describe('progressDetailModel — the card', () => {
  const goto = (_field: string, label: string) => ({ kind: 'goto' as const, label: `Go to ${label}` })
  it('lists required, then optional, then other issues — every one, no cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => f(`field${i}`))
    const m = progressDetailModel({ scopeLabel: 'Amazon · IT', subject: 'AIREON-NERO-L', now: 0, actionFor: goto,
      value: value({ requiredEmpty: [f('brand')], required: { filled: 2, total: 3 }, optionalEmpty: many, optional: { filled: 0, total: 40 }, otherIssues: [{ field: 'ean', label: 'EAN', reason: 'Not a valid EAN-13' }] }) })
    expect(m.groups.map(g => [g.id, g.items.length, g.tone])).toEqual([['required', 1, 'missing'], ['optional', 40, 'partial'], ['other', 1, 'unknown']])
    expect(m.groups[0].heading).toBe('Required and empty (1)')
    expect(m.groups[1].items[39].action).toEqual({ kind: 'goto', label: 'Go to Field39' })
    expect(m.groups[2].items[0].reason).toBe('Not a valid EAN-13')
    expect(m.title).toBe('Amazon · IT · 50%')
    expect(m.toneWord).toBe('Required fields empty')
    expect(m.summary).toBe('1 of 3 required empty · 40 of 40 optional empty')
  })
  it('says everything is filled when it is', () => {
    const m = progressDetailModel({ scopeLabel: 'eBay · IT', now: 0, actionFor: goto, value: value({ pct: 100, optional: { filled: 4, total: 4 }, optionalEmpty: [] }) })
    expect(m.groups).toEqual([])
    expect(m.allFilled).toBe('Every field eBay · IT asks for is filled.')
  })
  it('names what it does not know instead of listing part of it as all of it', () => {
    const m = progressDetailModel({ scopeLabel: 'Amazon · IT', now: 0, actionFor: goto,
      value: value({ required: { filled: 1, total: 4 }, requiredEmpty: [f('brand')], optional: null, optionalEmpty: null }) })
    expect(m.notes).toEqual([REQUIRED_NAMES_NOT_RECORDED, OPTIONAL_NOT_RECORDED])
  })
  it('an uncomputed row says so, and is not a score', () => {
    const m = progressDetailModel({ scopeLabel: 'Amazon · IT', now: 0, actionFor: goto, value: null })
    expect(m.tone).toBe('unknown')
    expect(m.summary).toMatch(/not been computed/)
    expect(m.title).toBe('Amazon · IT')
  })
  it('the footer carries the reading age and what this is not', () => {
    const now = Date.parse('2026-09-26T16:00:00Z')
    const m = progressDetailModel({ scopeLabel: 'Amazon · IT', now, actionFor: goto, value: value({ computedAt: '2026-09-26T10:00:00Z' }) })
    expect(m.footer).toBe('Computed 6 h ago · completeness — not publish readiness')
  })
})

describe('labels and keys', () => {
  it('the trigger names the whole reading', () => {
    expect(progressTriggerLabel('Shared product', 'AIREON', value({ pct: 83 }))).toBe('Shared product, AIREON: 83% filled, optional fields empty. Show what is missing.')
    expect(progressText(value({ pct: 83 }))).toBe('83% · Optional fields empty')
    expect(progressText(null)).toBe('— · Not measured')
  })
  it('↑ ↓ Home End move through the list and stop at its ends', () => {
    expect(progressListKey('ArrowDown', -1, 5)).toBe(0)
    expect(progressListKey('ArrowDown', 4, 5)).toBe(4)
    expect(progressListKey('ArrowUp', 0, 5)).toBe(0)
    expect(progressListKey('ArrowUp', -1, 5)).toBe(4)
    expect(progressListKey('Home', 3, 5)).toBe(0)
    expect(progressListKey('End', 0, 5)).toBe(4)
    expect(progressListKey('Enter', 1, 5)).toBe(-1)
    expect(progressListKey('ArrowDown', 0, 0)).toBe(-1)
  })
})
