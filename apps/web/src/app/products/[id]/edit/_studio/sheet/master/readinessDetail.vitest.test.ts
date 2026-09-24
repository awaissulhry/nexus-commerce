import { describe, expect, it } from 'vitest'
import { DETAIL_ITEM_CAP, NOT_COMPUTED_SENTENCE, NOT_RECORDED_YET, filledAllFieldsTip, readingAge, readinessDetailModel, readinessDetailTriggerLabel, type DetailEntry } from './readinessDetail'

/**
 * A-45 (Step 4.3 #4) — the completeness card, as a pure model (apps/web vitest is node-only). The arms are the
 * ones that would put a false sentence on screen: a guessed list, a 0 % for "not computed", a card that hides
 * how many it did not show, an old row read as "nothing is empty".
 */
const NOW = Date.parse('2026-09-24T12:00:00Z')
const base = { coordinateLabel: 'Amazon · IT', languageLabel: 'German', now: NOW, presence: () => 'visible' as const }
const req = (field: string, label = field, reason = 'Required and empty'): DetailEntry => ({ field, label, reason, requiredEmpty: true })
const issue = (field: string, label = field, reason = `${label} is too long`): DetailEntry => ({ field, label, reason })

describe('readinessDetailModel', () => {
  it('no index row = not computed: the server\'s sentence, no groups, never 0 %', () => {
    const m = readinessDetailModel({ ...base, value: null, entries: [] })
    expect(m).toMatchObject({ title: 'Amazon · IT · German', summary: NOT_COMPUTED_SENTENCE, groups: [], footer: null })
    expect(JSON.stringify(m)).not.toContain('0%')
  })

  it('the header uses the product\'s own counts; required-empty first, other issues after, each reason verbatim', () => {
    const m = readinessDetailModel({ ...base, value: { state: 'blocked', pct: 82, required: { filled: 18, total: 22 }, computedAt: '2026-09-24T06:00:00Z' },
      entries: [issue('title', 'Title'), req('gtin', 'GTIN'), req('brand', 'Brand', 'Brand is required by Amazon · IT'), req('color', 'Colour'), req('size', 'Size')] })
    expect(m.title).toBe('Amazon · IT · German — 82% (18 of 22 required)')
    expect(m.groups.map(g => g.heading)).toEqual(['Required and empty (4)', 'Other issues (1)'])
    expect(m.groups[0].items.map(i => i.field)).toEqual(['gtin', 'brand', 'color', 'size'])
    expect(m.groups[0].items[0].reason).toBeNull()                                  // the generic reason adds nothing
    expect(m.groups[0].items[1].reason).toBe('Brand is required by Amazon · IT')     // a real reason is kept verbatim
    expect(m.groups[1].items[0].reason).toBe('Title is too long')
    expect(m.notRecordedYet).toBeNull()                                               // 4 flagged = 22 − 18
    expect(m.footer).toBe('Computed 6 h ago · this is not publish eligibility')
  })

  it('an old row (flagged < total − filled) says the names are not recorded yet — it never lists part as all', () => {
    const m = readinessDetailModel({ ...base, value: { state: 'blocked', pct: 50, required: { filled: 2, total: 4 } }, entries: [issue('title', 'Title')] })
    expect(m.notRecordedYet).toBe(NOT_RECORDED_YET)
    expect(m.groups.map(g => g.id)).toEqual(['other'])
  })

  it(`shows at most ${DETAIL_ITEM_CAP} items and says how many more — required first`, () => {
    const entries = [...Array.from({ length: 6 }, (_, i) => req(`r${i}`)), ...Array.from({ length: 5 }, (_, i) => issue(`o${i}`))]
    const m = readinessDetailModel({ ...base, value: { state: 'blocked', pct: 10, required: { filled: 1, total: 7 } }, entries })
    expect(m.groups.flatMap(g => g.items)).toHaveLength(DETAIL_ITEM_CAP)
    expect(m.groups[0].items).toHaveLength(6)
    expect(m.groups[1].items).toHaveLength(2)
    expect(m.groups[1].heading).toBe('Other issues (5)')                             // the heading counts ALL
    expect(m.more).toBe(3)
  })

  it('each item says what its action does: go to a visible column, Customise a hidden one, name the scope otherwise', () => {
    const presence = (field: string) => (field === 'a' ? 'visible' : field === 'b' ? 'hidden' : 'absent') as never
    const m = readinessDetailModel({ ...base, presence, value: { state: 'blocked', pct: 0, required: { filled: 0, total: 3 } }, entries: [req('a', 'GTIN'), req('b', 'Brand'), req('c', 'Bullet point')] })
    expect(m.groups[0].items.map(i => i.action)).toEqual([
      { kind: 'goto', label: 'Go to GTIN' },
      { kind: 'customise', label: 'Brand is hidden — Customise' },
      { kind: 'elsewhere', text: 'Not a column on this sheet — edit it in the Amazon · IT scope.' },
    ])
  })

  it('a scope that could not be scored says so, with the server\'s own note', () => {
    const m = readinessDetailModel({ ...base, value: { state: 'absent', pct: null, note: 'Category metadata is incomplete: COAT' }, entries: [] })
    expect(m.title).toBe('Amazon · IT · German — not scored')
    expect(m.summary).toBe('Category metadata is incomplete: COAT')
  })
})

describe('the small sentences', () => {
  it('reading age', () => {
    expect(readingAge('2026-09-24T11:59:40Z', NOW)).toBe('just now')
    expect(readingAge('2026-09-24T11:48:00Z', NOW)).toBe('12 min ago')
    expect(readingAge('2026-09-22T12:00:00Z', NOW)).toBe('48 h ago'.replace('48 h', '2 d'))
    expect(readingAge(null, NOW)).toBeNull()
    expect(readingAge('not a date', NOW)).toBeNull()
  })
  it('the trigger names the whole reading', () => {
    expect(readinessDetailTriggerLabel('Amazon · IT', 'German', { state: 'blocked', pct: 82, required: { filled: 18, total: 22 } }, 'Blocked'))
      .toBe('Amazon · IT, German: Blocked, 82% of required values filled, 4 required fields empty. Show details.')
    expect(readinessDetailTriggerLabel('Amazon · IT', 'German', null, 'Not computed')).toBe('Amazon · IT, German: not computed. Show details.')
  })
  it('R-54: the Product column\'s pill is "Filled (all fields)" — how rich, not whether it can publish', () => {
    expect(filledAllFieldsTip(7)).toBe('Filled (all fields): 7% — filled ÷ every applicable attribute, optional included. Not publish readiness.')
    expect(filledAllFieldsTip(null)).toBe('Filled (all fields): — — filled ÷ every applicable attribute, optional included. Not publish readiness.')
  })
})
