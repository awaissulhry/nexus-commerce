/**
 * Negative Targeting D1 (Owner 2026-10-10) — the stop-waste kinds, their ceiling, the day caps and the never-list. Pure.
 */
import { describe, expect, it } from 'vitest'
import {
  capReason, changesOf, negativeLevelOf, neverListReason, NOT_PAGE_SHAPE, placeOf, STOP_WASTE_AGES, STOP_WASTE_CAPS, stopWasteCeiling, stopWasteKindOf,
  stopWasteParamsOf, stopWasteShapeOf, type StopWasteFacts,
} from './ads-graduation-stopwaste.js'
import { graduationCeiling } from './ads-graduation.js'
import { ruleOfBody } from './waste-rules/pure.js'

const PAUSE = ruleOfBody({ kind: 'PAUSE_KEYWORD', scope: { marketplace: 'IT' } }).actions
const NEGATE = ruleOfBody({ kind: 'NEGATE_TERM', scope: { marketplace: 'IT' } }).actions

const facts = (patch: Partial<StopWasteFacts> = {}): StopWasteFacts => ({
  kind: 'PAUSE_KEYWORD', text: 'cheap gloves', protectedTerm: null, noProtectedTerms: false, soldOrders: 0, ownKeywordThere: false,
  skipped: null, harvestDestination: false, funnelHome: false, keywordAgeDays: 90, placeAgeDays: 90, owner: 'product', windowDays: 60, ...patch,
})

describe('the two stop-waste kinds', () => {
  it('only a keyword pause, or only a negative exact, is a kind; notify never decides; mixed rules are not', () => {
    expect(stopWasteKindOf(['pause_target'])).toBe('PAUSE_KEYWORD')
    expect(stopWasteKindOf(['pause_target', 'notify', 'log_only'])).toBe('PAUSE_KEYWORD')
    expect(stopWasteKindOf(['add_negative_exact'])).toBe('NEGATE_TERM')
    expect(stopWasteKindOf(['add_negative_phrase'])).toBeNull()
    expect(stopWasteKindOf(['enable_target'])).toBeNull()
    expect(stopWasteKindOf(['bid_apply', 'pause_target'])).toBeNull()
    expect(stopWasteKindOf(['pause_target', 'add_negative_exact'])).toBeNull()
    expect(stopWasteKindOf([])).toBeNull()
  })

  it('M1 + S1 — only the page\'s shape: its test, a pause kept paused, or a negative exact in the ad group', () => {
    expect(stopWasteShapeOf(PAUSE)).toBe('PAUSE_KEYWORD')
    expect(stopWasteShapeOf(NEGATE)).toBe('NEGATE_TERM')
    // No stopWaste test: an older or Claude-saved rule, a Bid rule's THEN Pause, a builder negative rule.
    expect(stopWasteShapeOf([{ type: 'pause_target' }])).toBeNull()
    expect(stopWasteShapeOf([{ type: 'add_negative_exact', negative: { blocks: null } }])).toBeNull()
    // The pause lets the keyword go; a campaign-wide negative; a mapped wire; a phrase; a second writing action.
    expect(stopWasteShapeOf([{ ...PAUSE[0], keepPaused: false }])).toBeNull()
    expect(stopWasteShapeOf(ruleOfBody({ kind: 'NEGATE_TERM', level: 'CAMPAIGN', scope: { marketplace: 'IT' } }).actions)).toBeNull()
    expect(stopWasteShapeOf([{ ...NEGATE[0], negative: { blocks: [{ look: ['g1'], create: [{ adGroupId: 'g2', types: ['EXACT'] }] }] } }])).toBeNull()
    expect(stopWasteShapeOf(ruleOfBody({ kind: 'NEGATE_TERM', match: 'PHRASE', scope: { marketplace: 'IT' } }).actions)).toBeNull()
    expect(stopWasteShapeOf([...PAUSE, { type: 'bid_down' }])).toBeNull()
    expect(stopWasteShapeOf([...PAUSE, { type: 'notify' }])).toBe('PAUSE_KEYWORD')
  })

  it('the ceiling: the page\'s shape may be set to Auto, naming its caps; without its actions, or any other rule, below Auto', () => {
    expect(stopWasteCeiling(['pause_target'], PAUSE)).toMatchObject({ maxLevel: 'AUTO', blockedBy: [], reason: expect.stringMatching(/at most 10 keyword pauses and 20 negatives per product a day/) })
    expect(stopWasteCeiling(['pause_target'])).toBeNull()
    expect(stopWasteCeiling(['pause_target'], [{ type: 'pause_target' }])).toBeNull()
    expect(stopWasteCeiling(['enable_target'], PAUSE)).toBeNull()
    // Through graduationCeiling itself (the dial, the run-time check and the reads pass the rule's actions).
    expect(graduationCeiling({ actionTypes: ['pause_target'], hasKeywordProtections: false, actions: PAUSE }).maxLevel).toBe('AUTO')
    expect(graduationCeiling({ actionTypes: ['add_negative_exact'], hasKeywordProtections: false, actions: NEGATE }).maxLevel).toBe('AUTO')
    expect(graduationCeiling({ actionTypes: ['pause_target'], hasKeywordProtections: true }).maxLevel).toBe('PROPOSE')
    expect(graduationCeiling({ actionTypes: ['add_negative_exact'], hasKeywordProtections: true, actions: [{ type: 'add_negative_exact' }] }).maxLevel).toBe('PROPOSE')
    expect(graduationCeiling({ actionTypes: ['negative-targeting'], hasKeywordProtections: true, actions: [{ type: 'negative-targeting' }] }).maxLevel).toBe('PROPOSE')
    // harvest_and_negate / promote_to_exact are left out: a harvest rule may reach Auto inside its caps (Keyword Harvest
    // D2, Owner 2026-10-10; ads-graduation.vitest.test.ts holds it), so they are not "any other rule" here.
    for (const held of [['enable_target'], ['add_negative_phrase'], ['pause_campaign'], ['sync_negatives_across_campaigns'], ['archive_keyword'], ['bid_apply', 'pause_target'], ['bid']]) {
      expect(graduationCeiling({ actionTypes: held, hasKeywordProtections: true, actions: PAUSE }).maxLevel, held.join('+')).toBe('PROPOSE')
    }
    expect(NOT_PAGE_SHAPE).toBe('Auto is only for rules made on this page: this rule asks first.')
  })
})

describe('the day caps', () => {
  it('10 pauses and 20 negatives per product per day, the change counted with its check (S11), then it asks', () => {
    expect(STOP_WASTE_CAPS).toEqual({ pausesPerProductPerDay: 10, negativesPerProductPerDay: 20 })
    expect(capReason('PAUSE_KEYWORD', 9, 'JACKET')).toBeNull()
    expect(capReason('PAUSE_KEYWORD', 10, 'JACKET')).toBe('JACKET reached its 10 keyword pauses for today: this pause waits for your yes.')
    expect(capReason('NEGATE_TERM', 19, 'JACKET')).toBeNull()
    expect(capReason('NEGATE_TERM', 20, 'JACKET')).toMatch(/20 negatives for today/)
    // A change that would write several never passes the cap: used + n ≤ cap.
    expect(capReason('NEGATE_TERM', 18, 'JACKET', 2)).toBeNull()
    expect(capReason('NEGATE_TERM', 19, 'JACKET', 2)).toMatch(/20 negatives/)
  })

  it('counts what really changed: a pause sent, the negatives that reached Amazon; never a dry run, a skip or a no-change', () => {
    expect(changesOf('PAUSE_KEYWORD', { type: 'pause_target', ok: true, output: { status: 'PAUSED', adTargetId: 't' } })).toBe(1)
    expect(changesOf('PAUSE_KEYWORD', { type: 'pause_target', ok: true, output: { dryRun: true, wouldSet: 'PAUSED' } })).toBe(0)
    expect(changesOf('PAUSE_KEYWORD', { type: 'pause_target', ok: true, output: { noChange: true, status: 'PAUSED' } })).toBe(0)
    expect(changesOf('PAUSE_KEYWORD', { type: 'pause_target', ok: false, output: { status: 'PAUSED' } })).toBe(0)
    expect(changesOf('NEGATE_TERM', { type: 'add_negative_exact', ok: true, output: { confirmed: 2, outcomes: [] } })).toBe(2)
    expect(changesOf('NEGATE_TERM', { type: 'add_negative_exact', ok: true, output: { externalTargetId: 'x' } })).toBe(1)
    expect(changesOf('NEGATE_TERM', { type: 'add_negative_exact', ok: true, output: { externalTargetId: 'x', alreadyExisted: true } })).toBe(0)
    expect(changesOf('NEGATE_TERM', { type: 'add_negative_exact', ok: true, output: { skipped: 'term-filter' } })).toBe(0)
  })
})

describe('the never-list (PLAN §2), in the Owner\'s order', () => {
  it('a clean change passes', () => {
    expect(neverListReason(facts())).toBeNull()
    expect(neverListReason(facts({ kind: 'NEGATE_TERM', keywordAgeDays: null }))).toBeNull()
  })

  it('every item holds a change alone, in words', () => {
    expect(neverListReason(facts({ protectedTerm: 'acme' }))).toMatch(/protected term "acme"/)
    expect(neverListReason(facts({ kind: 'NEGATE_TERM', noProtectedTerms: true }))).toMatch(/No protected term is set for this market/)
    expect(neverListReason(facts({ soldOrders: 1 }))).toMatch(/sold 1 in the last 60 days, counted up to today/)
    expect(neverListReason(facts({ kind: 'NEGATE_TERM', soldOrders: 2 }))).toMatch(/where the negative would land/)
    expect(neverListReason(facts({ kind: 'NEGATE_TERM', ownKeywordThere: true }))).toMatch(/keyword of ours where the negative would land/)
    expect(neverListReason(facts({ harvestDestination: true }))).toMatch(/Harvest made this keyword/)
    expect(neverListReason(facts({ funnelHome: true }))).toMatch(/^The Brain keeps this search out of the product's other ad groups/)
    expect(neverListReason(facts({ keywordAgeDays: STOP_WASTE_AGES.keywordDays - 1 }))).toMatch(/29 days old: a keyword gets 30 days/)
    expect(neverListReason(facts({ keywordAgeDays: null }))).toMatch(/unknown age/)
    expect(neverListReason(facts({ placeAgeDays: STOP_WASTE_AGES.placeDays - 1 }))).toMatch(/13 days old: a place gets 14 days/)
    expect(neverListReason(facts({ owner: 'shared' }))).toMatch(/Several products share this campaign/)
    // M2 — a campaign no product Nexus knows owns: never alone (its cap would be per campaign, not per product).
    expect(neverListReason(facts({ owner: 'none' }))).toBe('No single product owns this campaign: a stop there waits for your yes.')
    // S9 — a person's Skip binds the rules: the row asks while it is skipped.
    expect(neverListReason(facts({ skipped: { until: new Date('2026-11-05T10:00:00Z'), by: 'user:u1' } }))).toBe('Skipped by you until 5 Nov: a skipped row waits for your yes.')
    expect(neverListReason(facts({ kind: 'NEGATE_TERM', skipped: { until: new Date('2026-11-05T10:00:00Z'), by: 'user:u1' } }))).toMatch(/^Skipped by you/)
  })

  it('a keyword-only item never holds a search term, and the first hit is named', () => {
    expect(neverListReason(facts({ kind: 'NEGATE_TERM', harvestDestination: true, funnelHome: true, keywordAgeDays: 1 }))).toBeNull()
    expect(neverListReason(facts({ kind: 'PAUSE_KEYWORD', noProtectedTerms: true, ownKeywordThere: true }))).toBeNull()
    expect(neverListReason(facts({ protectedTerm: 'acme', owner: 'shared' }))).toMatch(/protected/)
  })

  it('no amount in any reason (money stays in money keys)', () => {
    const all = [facts({ protectedTerm: 'acme' }), facts({ soldOrders: 3 }), facts({ owner: 'shared' }), facts({ kind: 'NEGATE_TERM', noProtectedTerms: true })]
    for (const f of all) expect(neverListReason(f)).not.toMatch(/€|\d+[.,]\d{2}/)
  })
})

describe('the rule\'s own settings and the context it reads', () => {
  it('stop-waste params are read from the first action, clamped; none on any other rule', () => {
    // The page's defaults (waste/pure.ts) where the rule sets none: one test.
    expect(stopWasteParamsOf([{ type: 'pause_target', stopWaste: { kind: 'PAUSE_KEYWORD' } }])).toEqual({ kind: 'PAUSE_KEYWORD', windowDays: 60, minClicks: 20, cpaMultiple: 2, spendFloorCents: 3000 })
    expect(stopWasteParamsOf([{ type: 'add_negative_exact', stopWaste: { kind: 'NEGATE_TERM', windowDays: 400, minClicks: 0 } }])).toMatchObject({ windowDays: 87, minClicks: 1, cpaMultiple: 1.5, spendFloorCents: 1500 })
    expect(stopWasteParamsOf([{ type: 'pause_target' }])).toBeNull()
    expect(stopWasteParamsOf([{ type: 'pause_target', stopWaste: { kind: 'OTHER' } }])).toBeNull()
  })

  it('the level a negative lands at; the place a context names', () => {
    expect(negativeLevelOf([{ type: 'add_negative_exact', levels: ['CAMPAIGN'] }])).toBe('CAMPAIGN')
    expect(negativeLevelOf([{ type: 'add_negative_exact', scope: 'CAMPAIGN' }])).toBe('CAMPAIGN')
    expect(negativeLevelOf([{ type: 'negative-targeting', negationLevel: 'both' }])).toBe('CAMPAIGN')
    expect(negativeLevelOf([{ type: 'add_negative_exact' }])).toBe('AD_GROUP')
    expect(placeOf({ marketplace: 'IT', adGroup: { id: 'g' }, adTarget: { id: 't', expressionValue: 'x', expressionType: 'EXACT' } })).toMatchObject({ adGroupId: 'g', targetId: 't', text: 'x', match: 'EXACT' })
    expect(placeOf({ marketplace: 'IT', searchTerm: { query: 'q', externalAdGroupId: 'xg', externalCampaignId: 'xc' } })).toMatchObject({ externalAdGroupId: 'xg', externalCampaignId: 'xc', text: 'q', adGroupId: null })
  })
})
