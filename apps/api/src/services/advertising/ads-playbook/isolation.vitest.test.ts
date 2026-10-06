/**
 * ADS PLAYBOOK PB-7 — isolation per product, pure (isolation.ts). Values are made up (public repo).
 *
 *   compile     the action holds the slots' roles, the brand terms and the handover; no number of its own; every
 *               switch off → saved off
 *   owners      only a LIVE keyword of the product's own Exact (Phrase, brand) slots owns a term
 *   exact       negated exact in the research slots only — never in an Exact, brand or product slot
 *   brand       negated as a phrase in the category and competitor slots, an Exact one too unless it would block a
 *               keyword there; only while a live brand keyword holds the term; Amazon's 4-word limit
 *   lock        never over a keyword of the ad group (L1); a protected term is never isolated; a standing one is
 *               not planned again
 *   winners     a search that wins where it runs stays there under "proven" until its exact home wins too; "landed"
 *               negates it at once
 *   scope       a planned negative outside the product's scope throws
 */
import { describe, expect, it } from 'vitest'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { negativeKey, type Positive } from '../ads-winner-lock.js'
import { SLOT, type TemplateDoc } from './doc.js'
import { assertInScope, compileIsolationRule, planIsolation, type IsolationPlanInput, type ScopeGroup } from './isolation.js'

/** The fixture template with a Phrase category slot too. */
function doc(isolation?: Partial<TemplateDoc['isolation']>): TemplateDoc {
  const d = templateDoc()
  d.structure.slots.splice(2, 0, SLOT.parse({ key: 'phrase-category', targeting: 'KEYWORD', match: 'PHRASE', intent: 'CATEGORY', rankRole: 'research', feeds: ['category'], nameParts: ['Phrase', 'Category'] }))
  d.bids.ladder['phrase-category'] = 1
  d.isolation = { ...d.isolation, ...isolation }
  return d
}

const compiled = (over: Partial<Parameters<typeof compileIsolationRule>[0]> = {}) => compileIsolationRule({
  playbookId: 'pb-test-1', market: 'IT', nameToken: 'TESTA', doc: doc(), handover: 'proven',
  terms: { brand: ['testa', 'Testa Moto'], category: [], competitor: [], competitorAsins: [], negatives: [] }, ...over,
})

const scope: ScopeGroup[] = [
  { adGroupId: 'g-auto', campaignId: 'c-auto', slot: 'auto', role: 'research', intent: 'ANY' },
  { adGroupId: 'g-broad', campaignId: 'c-broad', slot: 'broad-category', role: 'research', match: 'BROAD', intent: 'CATEGORY' },
  { adGroupId: 'g-phrase', campaignId: 'c-phrase', slot: 'phrase-category', role: 'research', match: 'PHRASE', intent: 'CATEGORY' },
  { adGroupId: 'g-exact', campaignId: 'c-exact', slot: 'exact-category', role: 'exact', match: 'EXACT', intent: 'CATEGORY' },
  { adGroupId: 'g-brand', campaignId: 'c-brand', slot: 'exact-brand', role: 'exact', match: 'EXACT', intent: 'BRAND' },
  { adGroupId: 'g-pat', campaignId: 'c-pat', slot: 'pat', role: 'pat', intent: 'ANY' },
]
const pos = (adGroupId: string, text: string, match: Positive['match'], live = true): Positive => ({ adTargetId: `t:${adGroupId}:${text}`, adGroupId, text, match, live })

function plan(over: Partial<IsolationPlanInput> & { positives?: Positive[]; winners?: Record<string, string[]> } = {}) {
  const positives = new Map<string, Positive[]>()
  for (const p of over.positives ?? []) positives.set(p.adGroupId, [...(positives.get(p.adGroupId) ?? []), p])
  return planIsolation({
    action: { exactIntoResearch: true, phraseIntoBroadAndAuto: false, brandPhrase: null, handover: 'proven', ...over.action },
    scope: over.scope ?? scope,
    positives,
    winners: new Map(Object.entries(over.winners ?? {}).map(([g, terms]) => [g, new Set(terms)])),
    standing: over.standing ?? new Set(),
    protections: over.protections ?? new Map(),
  })
}
const where = (p: ReturnType<typeof plan>, text: string) => p.adds.filter((a) => a.text === text).map((a) => `${a.match}:${a.adGroupId}`).sort()

describe('compileIsolationRule', () => {
  it('holds each slot\'s role, the brand terms and the handover — and no threshold of its own', () => {
    const c = compiled()
    expect(c.problems).toEqual([])
    expect(c.enabled).toBe(true)
    expect(c.name).toBe('TESTA (IT) — isolation')
    expect(c.action).toMatchObject({
      type: 'isolate_product_terms', v: 1, control: 'manual', playbookId: 'pb-test-1', market: 'IT', cadenceDays: 1, handover: 'proven',
      exactIntoResearch: true, phraseIntoBroadAndAuto: false,
      brandPhrase: { terms: ['TESTA', 'Testa Moto'] },
      slots: {
        auto: { role: 'research', intent: 'ANY' },
        'broad-category': { role: 'research', match: 'BROAD', intent: 'CATEGORY' },
        'phrase-category': { role: 'research', match: 'PHRASE', intent: 'CATEGORY' },
        'exact-category': { role: 'exact', match: 'EXACT', intent: 'CATEGORY' },
        'exact-brand': { role: 'exact', match: 'EXACT', intent: 'BRAND' },
        pat: { role: 'pat', intent: 'ANY' },
      },
    })
    expect(c.action.slots.auto).not.toHaveProperty('match')
    for (const key of ['windowDays', 'minOrders', 'minClicks', 'minSpendCents', 'maxAcosPct']) expect(c.action).not.toHaveProperty(key)
  })

  it('every switch off: saved, and off; the brand phrase is null when its switch is off', () => {
    const off = compiled({ doc: doc({ exactIntoResearch: false, brandPhraseIntoCategoryAndCompetitor: false, phraseIntoBroadAndAuto: false }) })
    expect(off.enabled).toBe(false)
    expect(off.action.brandPhrase).toBeNull()
    expect(off.warnings.join(' ')).toMatch(/every isolation switch off/)
  })

  it('a product row without a name token cannot be compiled', () => {
    expect(compiled({ nameToken: null }).problems.join(' ')).toMatch(/name token/)
  })
})

describe('planIsolation — owners and exact into research', () => {
  it('a live exact keyword is negated exact in the Auto, Broad and Phrase slots only', () => {
    const p = plan({ positives: [pos('g-exact', 'test x', 'EXACT')] })
    expect(where(p, 'test x')).toEqual(['EXACT:g-auto', 'EXACT:g-broad', 'EXACT:g-phrase'])
    expect(p.adds.every((a) => a.owner.adTargetId === 't:g-exact:test x' && a.owner.slot === 'exact-category')).toBe(true)
    expect(p.adds[0].why).toMatch(/own exact keyword in the slot "exact-category"/)
  })

  it('a keyword that is not live owns nothing; neither does a phrase or broad keyword for the exact rule', () => {
    const p = plan({ positives: [pos('g-exact', 'test y', 'EXACT', false), pos('g-phrase', 'test z', 'PHRASE'), pos('g-broad', 'test w', 'BROAD')] })
    expect(p.adds).toEqual([])
  })

  it('never negates over a keyword of the ad group (L1)', () => {
    const p = plan({ positives: [pos('g-exact', 'test x', 'EXACT'), pos('g-phrase', 'test x', 'EXACT')] })
    expect(where(p, 'test x')).toEqual(['EXACT:g-auto', 'EXACT:g-broad'])
    expect(p.leftAlone).toEqual([expect.objectContaining({ adGroupId: 'g-phrase', why: expect.stringMatching(/would block your own exact keyword "test x"/) })])
  })

  it('a protected term is never isolated; a standing negative is not planned again', () => {
    const p = plan({
      positives: [pos('g-exact', 'test x', 'EXACT')],
      protections: new Map([['c-auto', [{ term: 'test x', matchType: 'EXACT' }]]]),
      standing: new Set([negativeKey('g-broad', 'EXACT', 'Test X')]),
    })
    expect(where(p, 'test x')).toEqual(['EXACT:g-phrase'])
    expect(p.alreadyStanding).toBe(1)
    expect(p.leftAlone).toEqual([expect.objectContaining({ adGroupId: 'g-auto', why: expect.stringMatching(/^Protected, never isolated/) })])
  })

  it('phrase into Broad and Auto: a live phrase keyword, as a phrase, in the Broad slots of its own intent and Auto only', () => {
    const withBrandBroad: ScopeGroup[] = [...scope, { adGroupId: 'g-broad-brand', campaignId: 'c-broad-brand', slot: 'broad-brand', role: 'research', match: 'BROAD', intent: 'BRAND' }]
    const p = plan({ action: { exactIntoResearch: false, phraseIntoBroadAndAuto: true, brandPhrase: null, handover: 'proven' }, scope: withBrandBroad, positives: [pos('g-phrase', 'test z', 'PHRASE')] })
    // A category phrase never reaches Broad | Brand: with the brand phrase negated in the category slots, "brand +
    // category" searches would have nowhere left to go.
    expect(where(p, 'test z')).toEqual(['PHRASE:g-auto', 'PHRASE:g-broad'])
  })
})

describe('planIsolation — winners stay (handover)', () => {
  const owner = [pos('g-exact', 'test x', 'EXACT')]
  it('proven: a search that wins in the research slot stays there while its exact keyword has not won', () => {
    const p = plan({ positives: owner, winners: { 'g-phrase': ['test x'] } })
    expect(where(p, 'test x')).toEqual(['EXACT:g-auto', 'EXACT:g-broad'])
    expect(p.leftAlone).toEqual([expect.objectContaining({ adGroupId: 'g-phrase', why: expect.stringMatching(/"test x" wins here .* has not met that bar yet/) })])
  })
  it('proven: negated there once its exact home meets the bar too', () => {
    const p = plan({ positives: owner, winners: { 'g-phrase': ['test x'], 'g-exact': ['test x'] } })
    expect(where(p, 'test x')).toEqual(['EXACT:g-auto', 'EXACT:g-broad', 'EXACT:g-phrase'])
  })
  it('proven needs a LIVE exact home: a paused one that won does not hand the search over', () => {
    const brand = (live: boolean) => plan({
      action: { exactIntoResearch: false, phraseIntoBroadAndAuto: false, brandPhrase: { terms: ['testa'] }, handover: 'proven' },
      positives: [pos('g-brand', 'testa jacket', 'EXACT'), pos('g-brand', 'red testa jacket', 'EXACT', live)],
      winners: { 'g-broad': ['red testa jacket'], 'g-brand': ['red testa jacket'] },
    })
    expect(where(brand(false), 'testa')).toEqual(['PHRASE:g-exact', 'PHRASE:g-phrase'])
    expect(where(brand(true), 'testa')).toEqual(['PHRASE:g-broad', 'PHRASE:g-exact', 'PHRASE:g-phrase'])
  })
  it('landed: negated at once', () => {
    const p = plan({ action: { exactIntoResearch: true, phraseIntoBroadAndAuto: false, brandPhrase: null, handover: 'landed' }, positives: owner, winners: { 'g-phrase': ['test x'] } })
    expect(where(p, 'test x')).toEqual(['EXACT:g-auto', 'EXACT:g-broad', 'EXACT:g-phrase'])
  })
  it('a phrase negative waits while any search it would block wins there', () => {
    const p = plan({
      action: { exactIntoResearch: false, phraseIntoBroadAndAuto: false, brandPhrase: { terms: ['testa'] }, handover: 'proven' },
      positives: [pos('g-brand', 'testa jacket', 'EXACT')],
      winners: { 'g-broad': ['red testa jacket'] },
    })
    expect(where(p, 'testa')).toEqual(['PHRASE:g-exact', 'PHRASE:g-phrase'])
    expect(p.leftAlone[0]).toMatchObject({ adGroupId: 'g-broad', why: expect.stringMatching(/"red testa jacket" wins here/) })
  })
})

describe('planIsolation — the brand phrase', () => {
  const brand = (terms: string[], positives: Positive[]) => plan({ action: { exactIntoResearch: false, phraseIntoBroadAndAuto: false, brandPhrase: { terms }, handover: 'proven' }, positives })

  it('into the category and competitor slots (an Exact one too) — never Auto, the brand slot or the product slot', () => {
    const p = brand(['testa'], [pos('g-brand', 'testa jacket', 'EXACT')])
    expect(where(p, 'testa')).toEqual(['PHRASE:g-broad', 'PHRASE:g-exact', 'PHRASE:g-phrase'])
    expect(p.adds[0].why).toMatch(/is this product's brand, and its searches go to its brand slot "exact-brand"/)
  })

  it('an Exact category slot that holds a brand keyword is left alone, naming the keyword to move first', () => {
    const p = brand(['testa'], [pos('g-brand', 'testa jacket', 'EXACT'), pos('g-exact', 'testa coat', 'EXACT')])
    expect(where(p, 'testa')).toEqual(['PHRASE:g-broad', 'PHRASE:g-phrase'])
    expect(p.leftAlone).toEqual([expect.objectContaining({ adGroupId: 'g-exact', why: expect.stringMatching(/block your own keyword "testa coat" in this Exact slot; move that keyword/) })])
  })

  it('only while a live keyword of the brand slots holds the term — a category keyword holding it is no owner', () => {
    const p = brand(['testa'], [pos('g-brand', 'testa jacket', 'EXACT', false), pos('g-broad', 'testa gloves', 'BROAD')])
    expect(p.adds).toEqual([])
    expect(p.leftAlone).toEqual([expect.objectContaining({ text: 'testa', adGroupId: null, why: expect.stringMatching(/no live keyword of this product's brand slots holds it/) })])
  })

  it('a phrase over Amazon\'s 4-word limit is left alone, by name', () => {
    const p = brand(['testa one two three four'], [pos('g-brand', 'testa one two three four', 'EXACT')])
    expect(p.adds).toEqual([])
    expect(p.leftAlone[0].why).toMatch(/at most 4 in a negative phrase/)
  })
})

describe('the scope assertion', () => {
  it('throws for a negative planned outside the product\'s own ad groups, or an owner outside them', () => {
    const owner = { adTargetId: 't1', adGroupId: 'g-exact', slot: 'exact-category', text: 'test x' }
    expect(() => assertInScope([{ adGroupId: 'g-other-product', owner, text: 'test x' }], scope)).toThrow(/outside this product's own campaigns/)
    expect(() => assertInScope([{ adGroupId: 'g-phrase', owner: { ...owner, adGroupId: 'g-other-product' }, text: 'test x' }], scope)).toThrow(/outside/)
    expect(() => assertInScope([{ adGroupId: 'g-phrase', owner, text: 'test x' }], scope)).not.toThrow()
  })
})
