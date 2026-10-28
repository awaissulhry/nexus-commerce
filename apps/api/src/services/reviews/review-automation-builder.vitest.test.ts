/**
 * The rules builder's review automations (review-automation-builder.ts): what it reads of each stored rule — the three
 * templates exactly —, what a save may hold, that a save writes only what changed (a kept condition and an AI action's
 * own fields stay), that a part it cannot draw is held and kept, and the words the Settings list shows. Pure: no database.
 */
import { describe, expect, it } from 'vitest'
import { evaluateConditions, type ConditionsPayload } from '../automation/conditions-tree.js'
import {
  buildReviewRuleWrite, isUnchangedTemplate, listedWords, readReviewRule, reviewAutomationWords, validateReviewAutomation,
  type ReviewAutomationView, type StoredReviewRule,
} from './review-automation-builder.js'
import { REVIEW_TEMPLATES } from './review-templates.js'

const SETTING_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|spike\.|product\.|familyId|maxExecutions|scopeMarketplace/

/** A template as the seeder stores it. */
const stored = (name: string, over: Partial<StoredReviewRule> = {}): StoredReviewRule => {
  const t = REVIEW_TEMPLATES.find((x) => x.name === name)!
  return { name: t.name, trigger: t.trigger, conditions: t.conditions, actions: t.actions, scopeMarketplace: t.scopeMarketplace, maxExecutionsPerDay: t.maxExecutionsPerDay ?? 20, ...over }
}
const ALERT = 'Alert team on negative review spike'
const BULLETS = 'Auto-update bullets on quality spike'
const APLUS = 'Create A+ module from review spike'

const ctx = (view: ReviewAutomationView, pickable: string[] = ['test-jacket', 'test-helmet'], markets: string[] = ['IT', 'DE']) =>
  ({ stored: view, pickable: new Set(pickable), markets: new Set(markets) })
const body = (view: ReviewAutomationView, over: Record<string, unknown> = {}) => ({ ...view, ...over })

describe('what the builder reads', () => {
  it('the three templates, exactly as loaded', () => {
    expect(readReviewRule(stored(ALERT))).toEqual({
      view: { name: ALERT, themes: [], minMultiplier: null, families: [], market: null, does: 'notify', tellTeam: true, message: 'Negative review spike detected — check the Spikes feed for details', maxPerDay: 50 },
      kept: [], whenHeld: null, thenHeld: null,
    })
    expect(readReviewRule(stored(BULLETS)).view).toMatchObject({ does: 'bullets', tellTeam: true, minMultiplier: null, maxPerDay: 20 })
    expect(readReviewRule(stored(APLUS)).view).toMatchObject({ does: 'aplus', tellTeam: true, minMultiplier: 2.5, themes: [], maxPerDay: 10 })
    for (const name of [ALERT, BULLETS, APLUS]) expect(isUnchangedTemplate(stored(name))).toBe(true)
  })

  it('a theme as one value or a list, a market, products; a condition it has no control for is kept, in words', () => {
    const r = readReviewRule(stored(ALERT, {
      conditions: [
        { field: 'spike.category', op: 'eq', value: 'FIT_SIZING' },
        { field: 'product.familyId', op: 'in', value: ['test-jacket'] },
        { field: 'spike.rate7dNumerator', op: 'gte', value: 3 },
      ],
      scopeMarketplace: 'DE',
    }))
    expect(r.view).toMatchObject({ themes: ['FIT_SIZING'], families: ['test-jacket'], market: 'DE' })
    expect(r.kept).toEqual(['spike.rate7dNumerator ≥ 3'])
    expect(r.whenHeld).toBeNull()
  })

  it('a part it cannot draw is held, in words: grouped conditions, another trigger, an action it does not know', () => {
    expect(readReviewRule(stored(ALERT, { conditions: { kind: 'or', children: [] } })).whenHeld).toMatch(/grouped \(and \/ or \/ not\).*kept as they are/)
    expect(readReviewRule(stored(ALERT, { trigger: 'REVIEW_INGESTED' })).whenHeld).toMatch(/not a complaint spike/)
    expect(readReviewRule(stored(ALERT, { actions: [{ type: 'log_only' }] })).thenHeld).toMatch(/kept as they are/)
    expect(readReviewRule(stored(ALERT, { actions: [] })).thenHeld).not.toBeNull()
  })
})

describe('what a save may hold', () => {
  const view = readReviewRule(stored(APLUS)).view
  const words = (b: unknown, c = ctx(view)) => {
    const r = validateReviewAutomation(b, c)
    return r.ok ? null : r.words
  }

  it('refuses in words a person can act on', () => {
    expect(words(null)).toBe('There is nothing to save.')
    expect(words(body(view, { name: '  ' }))).toBe('Give the automation a name.')
    expect(words(body(view, { themes: ['NOISE'] }))).toMatch(/^Pick the themes from the list: Fit & sizing, Durability/)
    expect(words(body(view, { minMultiplier: 0.5 }))).toMatch(/a number from 1 to 50/)
    expect(words(body(view, { minMultiplier: '3' }))).toMatch(/a number from 1 to 50/)
    expect(words(body(view, { families: ['gone-product'] }))).toBe('A picked product is not in Nexus as a whole product. Pick the products from the list.')
    expect(words(body(view, { market: 'XX' }))).toBe('Pick the market from the list.')
    expect(words(body(view, { does: 'pause' }))).toMatch(/^Pick what it does/)
    expect(words(body(view, { message: ' ' }))).toBe('Write what the team is told.')
    expect(words(body(view, { maxPerDay: 0 }))).toMatch(/a whole number from 1 to 500/)
    expect(words(body(view, { maxPerDay: 2.5 }))).toMatch(/a whole number from 1 to 500/)
    for (const w of [words(body(view, { themes: ['NOISE'] })), words(body(view, { does: 'pause' }))]) expect(w).not.toMatch(SETTING_NAME)
  })

  it('a product it already names stays allowed after it left Nexus; themes keep the list’s order; notify always tells the team', () => {
    const named = { ...view, families: ['gone-product'] }
    expect(validateReviewAutomation(body(named), ctx(named, [])).ok).toBe(true)
    const r = validateReviewAutomation(body(view, { themes: ['QUALITY', 'FIT_SIZING', 'QUALITY'], does: 'notify', tellTeam: false }), ctx(view))
    expect(r.ok && r.view).toMatchObject({ themes: ['FIT_SIZING', 'QUALITY'], does: 'notify', tellTeam: true })
  })
})

describe('the rule a save stores', () => {
  it('nothing changed: nothing written', () => {
    for (const name of [ALERT, BULLETS, APLUS]) {
      const rule = stored(name)
      const reading = readReviewRule(rule)
      expect(buildReviewRuleWrite(rule, reading, reading.view)).toEqual({ data: {}, changed: [] })
    }
  })

  it('trigger settings and action round-trip: what is stored reads back as what was saved, and matches as it says', () => {
    const rule = stored(APLUS, { conditions: [{ field: 'spike.spikeMultiplier', op: 'gte', value: 2.5 }, { field: 'spike.rate7dNumerator', op: 'gte', value: 3 }] })
    const reading = readReviewRule(rule)
    const next: ReviewAutomationView = { ...reading.view, themes: ['FIT_SIZING', 'COMFORT'], minMultiplier: 3, families: ['test-jacket'], market: 'DE', does: 'bullets', tellTeam: true, message: 'Sizes run small', maxPerDay: 5 }
    const { data, changed } = buildReviewRuleWrite(rule, reading, next)
    expect(changed).toEqual(['themes', 'how fast', 'products', 'market', 'action', 'what the team is told', 'runs a day'])
    expect(data.conditions).toEqual([
      { field: 'spike.category', op: 'in', value: ['FIT_SIZING', 'COMFORT'] },
      { field: 'spike.spikeMultiplier', op: 'gte', value: 3 },
      { field: 'product.familyId', op: 'in', value: ['test-jacket'] },
      // kept as it was
      { field: 'spike.rate7dNumerator', op: 'gte', value: 3 },
    ])
    expect(data.actions).toEqual([
      { type: 'update_product_bullets_from_review', reason: 'Review spike — regenerate bullets to address customer concern' },
      // the stored notice keeps its own fields; its words are new
      { type: 'notify', target: 'operator', message: 'Sizes run small' },
    ])
    expect(data).toMatchObject({ scopeMarketplace: 'DE', maxExecutionsPerDay: 5 })
    expect(data.description).toBe(reviewAutomationWords(next))

    const back = readReviewRule({ ...rule, conditions: data.conditions, actions: data.actions, scopeMarketplace: 'DE', maxExecutionsPerDay: 5 })
    expect(back.view).toEqual(next)
    expect(back.kept).toEqual(['spike.rate7dNumerator ≥ 3'])

    const spike = (over: Record<string, unknown> = {}) => ({
      trigger: 'REVIEW_SPIKE_DETECTED', marketplace: 'DE',
      spike: { id: 's', category: 'FIT_SIZING', spikeMultiplier: '3.2', rate7dNumerator: 4 },
      product: { id: 'test-jacket-m', familyId: 'test-jacket' }, ...over,
    })
    const matches = (c: unknown) => evaluateConditions(data.conditions as ConditionsPayload, c)
    expect(matches(spike())).toBe(true)
    expect(matches(spike({ spike: { category: 'SHIPPING', spikeMultiplier: '3.2', rate7dNumerator: 4 } }))).toBe(false)
    expect(matches(spike({ spike: { category: 'FIT_SIZING', spikeMultiplier: '2.9', rate7dNumerator: 4 } }))).toBe(false)
    expect(matches(spike({ product: { id: 'test-helmet', familyId: 'test-helmet' } }))).toBe(false)
    expect(matches(spike({ product: null }))).toBe(false)
  })

  it('the A+ action keeps its own stored fields when only the notice changes; telling the team can be turned off', () => {
    const rule = stored(APLUS)
    const reading = readReviewRule(rule)
    const words = buildReviewRuleWrite(rule, reading, { ...reading.view, message: 'New A+ draft' })
    expect(words.changed).toEqual(['what the team is told'])
    expect(words.data.conditions).toBeUndefined()
    expect(words.data.actions).toEqual([REVIEW_TEMPLATES[2].actions[0], { ...(REVIEW_TEMPLATES[2].actions[1] as object), message: 'New A+ draft' }])
    const quiet = buildReviewRuleWrite(rule, reading, { ...reading.view, tellTeam: false })
    expect(quiet.data.actions).toEqual([REVIEW_TEMPLATES[2].actions[0]])
    // every theme and every spike again: the settings' conditions go, nothing else is stored
    const open = buildReviewRuleWrite(rule, reading, { ...reading.view, minMultiplier: null })
    expect(open.data.conditions).toEqual([])
  })

  it('a held part is never written, whatever the save says', () => {
    const rule = stored(ALERT, { conditions: { kind: 'leaf', field: 'spike.category', op: 'eq', value: 'SAFETY' }, actions: [{ type: 'log_only' }] })
    const reading = readReviewRule(rule)
    const { data, changed } = buildReviewRuleWrite(rule, reading, { ...reading.view, themes: ['QUALITY'], does: 'aplus', market: 'IT' })
    expect(changed).toEqual(['market'])
    expect(data.conditions).toBeUndefined()
    expect(data.actions).toBeUndefined()
  })
})

describe('in words', () => {
  it('what it does, from its settings; an unchanged template keeps its own words (null)', () => {
    expect(listedWords({ ...stored(APLUS), description: 'x' })).toBeNull()
    const view = { themes: ['FIT_SIZING', 'COMFORT'], minMultiplier: 3, families: ['a', 'b'], market: 'DE', does: 'aplus' as const, tellTeam: true }
    expect(reviewAutomationWords(view)).toBe('When complaints about fit & sizing or comfort rise 3 times faster than usual or more for one of the 2 products picked in Germany, the AI drafts an A+ module that answers them and saves it as an A+ draft in Nexus, and tells the team. A person approves it before anything is published.')
    expect(reviewAutomationWords({ ...view, does: 'notify', themes: [], minMultiplier: null, families: [], market: null }))
      .toBe('Tells the team when the spike check finds complaints about one theme rising fast for a product in one market.')
    expect(reviewAutomationWords({ ...view, does: 'bullets', tellTeam: false, minMultiplier: 2.5, families: ['a'] }))
      .toMatch(/^When complaints about fit & sizing or comfort rise 2\.5 times faster than usual or more for the product picked in Germany, the AI drafts five new bullet points that answer them\. /)
    const edited = { ...stored(ALERT, { scopeMarketplace: 'IT' }), description: 'old words' }
    expect(listedWords(edited)).toBe('Tells the team when the spike check finds complaints about one theme rising fast for a product in Italy.')
    expect(listedWords({ ...stored(ALERT, { actions: [{ type: 'log_only' }] }), description: 'its own words' })).toBe('its own words')
    expect(reviewAutomationWords(view)).not.toMatch(SETTING_NAME)
  })
})
