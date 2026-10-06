/**
 * CR rebuild 5 — the Campaigns draft: nothing writes on a click; every edit is reviewed old → new; a change that lets
 * automation touch more is a raise; the writes go to the endpoints that already existed.
 *
 * CR review: only the edited bid bound is sent (#1); a block goes first and an allow last, and an allow is not sent
 * after a refused change of the same campaign (#3); what saved leaves the draft even when the list cannot be re-read
 * (#17); a value that changed on the server since the draft was made is named (#1).
 */
import { describe, expect, it } from 'vitest'
import {
  applyBulk, campaignMatches, changeCount, conflictsOf, dropSaved, lockedWords, moneyWords, parseMoney, parseMultiple,
  problemsOf, refusalOf, requestsFor, retidy, reviewGroups, reviewLines, saveWords, setEdit, skipReason, valuesOf,
  NO_CAMPAIGN_FILTER, type CampaignRow, type Draft,
} from './campaignDraft'

const row = (over: Partial<CampaignRow> = {}): CampaignRow => ({
  id: 'c1', name: 'Helmets IT', marketplace: 'IT', status: 'ENABLED', portfolioName: null,
  managed: false, minBidCents: null, maxBidCents: 150, dailyBudgetCents: 3000, targetAcosPct: null,
  cpcCeiling: null, suppressedAt: null, suppressedBy: null,
  pins: { placement: false, bids: false, budget: false }, pinNote: null, pinnedBy: null, boundRules: [],
  ...over,
})
const byId = (...rows: CampaignRow[]) => new Map(rows.map((r) => [r.id, r]))

describe('the draft', () => {
  it('an edit back to the stored value leaves the draft; a campaign with nothing left drops out', () => {
    const r = row()
    let d: Draft = setEdit({}, r, { allowed: true })
    expect(d).toEqual({ c1: { allowed: true } })
    d = setEdit(d, r, { allowed: false })
    expect(d).toEqual({})
  })

  it('locks merge per part; the values read through the draft', () => {
    const r = row({ pins: { placement: true, bids: false, budget: false } })
    const d = setEdit(setEdit({}, r, { pins: { bids: true } }), r, { pins: { placement: false } })
    expect(d.c1.pins).toEqual({ bids: true, placement: false })
    expect(valuesOf(r, d.c1).pins).toEqual({ placement: false, bids: true, budget: false })
    expect(lockedWords(valuesOf(r, d.c1).pins)).toBe('Bids')
  })

  it('a bulk action fills the draft for every ticked campaign and writes nothing', () => {
    const a = row(), b = row({ id: 'c2', name: 'Gloves IT', managed: true })
    const d = applyBulk({}, [a, b], { kind: 'allowed', value: true })
    expect(d).toEqual({ c1: { allowed: true } }) // c2 already allowed: nothing to change
    expect(applyBulk({}, [a, b], { kind: 'maxBid', cents: null })).toEqual({ c1: { maxBidCents: null }, c2: { maxBidCents: null } })
  })

  it('after a save, what now equals the stored value leaves; what was refused stays', () => {
    const d: Draft = { c1: { allowed: true, maxBidCents: 200 } }
    expect(retidy(d, byId(row({ managed: true })))).toEqual({ c1: { maxBidCents: 200 } })
    expect(retidy(d, byId())).toEqual({})
  })
})

describe('the review', () => {
  it('lists every change old → new, in the campaign’s currency', () => {
    const r = row()
    const d = setEdit({}, r, { allowed: true, minBidCents: 20, maxBidCents: 120, pins: { budget: true } })
    const lines = reviewLines(d, byId(r))
    expect(lines.map((l) => [l.what, l.before, l.after, l.raise])).toEqual([
      ['Automation may change it', 'No', 'Yes', true],
      ['Lowest bid', '—', '€0.20', false], // a first bound tightens
      ['Highest bid', '€1.50', '€1.20', false],
      ['Budget locked', 'Not locked', 'Locked', false],
    ])
    expect(changeCount(d, byId(r))).toBe(4)
    expect(saveWords(4)).toBe('Save 4 changes')
    expect(saveWords(1)).toBe('Save 1 change')
  })

  it('a raise: allow, a higher highest bid, a lower lowest bid, clearing a bound, unlocking, a higher or cleared ceiling', () => {
    const r = row({ managed: true, minBidCents: 30, maxBidCents: 150, cpcCeiling: { enabled: true, multiple: 1.5 }, pins: { placement: true, bids: false, budget: false } })
    const raise = (patch: Parameters<typeof setEdit>[2]) => reviewLines(setEdit({}, r, patch), byId(r)).map((l) => l.raise)
    expect(raise({ maxBidCents: 200 })).toEqual([true])
    expect(raise({ maxBidCents: null })).toEqual([true])
    expect(raise({ minBidCents: 20 })).toEqual([true])
    expect(raise({ minBidCents: null })).toEqual([true])
    expect(raise({ minBidCents: 40 })).toEqual([false])
    expect(raise({ pins: { placement: false } })).toEqual([true])
    expect(raise({ cpcMultiple: 2 })).toEqual([true])
    expect(raise({ cpcMultiple: null })).toEqual([true])
    expect(raise({ cpcMultiple: 1.2 })).toEqual([false])
    expect(raise({ allowed: false })).toEqual([false])
  })
})

describe('checks', () => {
  it('money and multiples parse plainly; anything else is refused, never guessed', () => {
    expect(parseMoney('1,50')).toBe(150)
    expect(parseMoney('0.2')).toBe(20)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('1.505')).toBeNaN()
    expect(parseMoney('abc')).toBeNaN()
    expect(parseMultiple('1.5')).toBe(1.5)
    expect(parseMultiple('')).toBeNull()
    expect(parseMultiple('x2')).toBeNaN()
    expect(moneyWords(150, 'EUR')).toBe('€1.50')
    expect(moneyWords(150, null)).toBe('1.50')
  })

  it('a lowest bid above the highest one, or a ceiling outside 1–10, cannot be saved', () => {
    const r = row({ maxBidCents: 100 })
    expect(problemsOf(r, { minBidCents: 120 })).toEqual(['The lowest bid is above the highest bid. Nothing could change its bids.'])
    expect(problemsOf(r, { cpcMultiple: 12 })).toEqual(['The bid limit for you and Claude must be from 1 to 10 times the usual click cost.'])
    expect(problemsOf(r, { minBidCents: 50 })).toEqual([])
    expect(problemsOf(r, undefined)).toEqual([])
  })
})

describe('the writes', () => {
  it('each edit goes to its own endpoint; an allow goes LAST, after the limits it was reviewed with', () => {
    const r = row({ minBidCents: 20, maxBidCents: 150 })
    expect(requestsFor(r, { allowed: true, maxBidCents: 120, cpcMultiple: null, pins: { bids: true } }).map((q) => [q.kind, q.path, q.body, q.fields])).toEqual([
      ['bounds', '/api/advertising/campaigns/c1/guardrails', { maxBidCents: 120 }, ['maxBidCents']],
      ['ceiling', '/api/advertising/campaigns/c1/cpc-ceiling', { enabled: false }, ['cpcMultiple']],
      ['pins', '/api/advertising/campaigns/c1/pins', { pinBids: true }, ['pin:bids']],
      ['allow', '/api/advertising/campaigns/c1/live-writes', { enabled: true }, ['allowed']],
    ])
    expect(requestsFor(r, { cpcMultiple: 2 }).map((q) => q.body)).toEqual([{ enabled: true, multiple: 2 }])
  })

  it('THE REGRESSION (#1): one edited bound is sent alone, so a bound set elsewhere since the page loaded survives', () => {
    // The page read "no highest bid"; meanwhile €1.50 was set elsewhere. Setting only a lowest bid must not send max: null.
    const stale = row({ minBidCents: null, maxBidCents: null })
    const [only] = requestsFor(stale, { minBidCents: 30 })
    expect(only.body).toEqual({ minBidCents: 30 })
    expect(Object.prototype.hasOwnProperty.call(only.body, 'maxBidCents')).toBe(false)
    // Both edited: both sent, in one request (the server judges the pair).
    expect(requestsFor(stale, { minBidCents: 30, maxBidCents: 90 })[0]).toMatchObject({ what: 'Lowest and highest bid', body: { minBidCents: 30, maxBidCents: 90 } })
    // Clearing one bound sends that bound only, as null.
    expect(requestsFor(row({ minBidCents: 20, maxBidCents: 150 }), { maxBidCents: null })[0].body).toEqual({ maxBidCents: null })
  })

  it('#3: blocking automation goes FIRST (a brake); allowing it is skipped after a refused change of the same campaign', () => {
    const r = row({ managed: true, minBidCents: 20 })
    expect(requestsFor(r, { allowed: false, minBidCents: 30 }).map((q) => q.kind)).toEqual(['block', 'bounds'])
    const allow = requestsFor(row(), { allowed: true, maxBidCents: 100 }).at(-1)!
    expect(allow.kind).toBe('allow')
    expect(skipReason(allow, false)).toBeNull()
    expect(skipReason(allow, true)).toMatch(/^Not sent: another change for this campaign was refused/)
    // Only an allow waits: a brake or a limit is never skipped.
    expect(skipReason(requestsFor(r, { allowed: false })[0], true)).toBeNull()
  })

  it('#17: what saved leaves the draft even when the list cannot be read again; what failed stays', () => {
    const d: Draft = { c1: { allowed: true, maxBidCents: 100, pins: { bids: true, budget: true } }, c2: { minBidCents: 10 } }
    let next = dropSaved(d, 'c1', ['maxBidCents'])
    next = dropSaved(next, 'c1', ['pin:bids'])
    expect(next).toEqual({ c1: { allowed: true, pins: { budget: true } }, c2: { minBidCents: 10 } })
    next = dropSaved(next, 'c1', ['allowed', 'pin:budget'])
    expect(next).toEqual({ c2: { minBidCents: 10 } })
    expect(dropSaved(next, 'nope', ['allowed'])).toBe(next)
  })
  it('a refusal is read from the status AND the body (HTTP 200 can carry ok: false)', () => {
    expect(refusalOf(200, { ok: true })).toBeNull()
    expect(refusalOf(200, { ok: false, error: 'min above max' })).toBe('min above max')
    expect(refusalOf(400, { error: 'campaign not found' })).toBe('campaign not found')
    expect(refusalOf(500, null)).toBe('Refused (500).')
  })
})

describe('the review reads the campaigns again (#1)', () => {
  it('a drafted value that changed on the server since the draft was made is named, with was → now', () => {
    const before = row({ maxBidCents: null, minBidCents: null })
    const after = row({ maxBidCents: 150, minBidCents: null })
    const d: Draft = { c1: { minBidCents: 30, maxBidCents: 200 } }
    expect(conflictsOf(d, byId(before), byId(after))).toEqual([
      { campaignId: 'c1', campaign: 'Helmets IT', what: 'Highest bid', was: '—', now: '€1.50' },
    ])
    // A field the person did not draft is not a conflict, and an unchanged one neither.
    expect(conflictsOf({ c1: { minBidCents: 30 } }, byId(before), byId(after))).toEqual([])
  })

  it('the review is one small table per campaign, and "Now" is the fresh value', () => {
    const fresh = row({ maxBidCents: 150 })
    const d: Draft = { c1: { maxBidCents: 200 }, c2: { allowed: true } }
    const groups = reviewGroups(reviewLines(d, byId(fresh, row({ id: 'c2', name: 'Gloves IT' }))))
    expect(groups.map((g) => [g.campaign, g.lines.map((l) => [l.what, l.before, l.after])])).toEqual([
      ['Helmets IT', [['Highest bid', '€1.50', '€2.00']]],
      ['Gloves IT', [['Automation may change it', 'No', 'Yes']]],
    ])
  })
})

describe('filters', () => {
  it('THE REGRESSION: with no filter every campaign shows (the old grid opened on “Managed only”)', () => {
    expect(campaignMatches(row({ managed: false }), NO_CAMPAIGN_FILTER)).toBe(true)
  })

  it('market, automation, missing limits, locks and search', () => {
    const r = row({ marketplace: 'IT', managed: true, minBidCents: null, maxBidCents: 150, pins: { placement: false, bids: true, budget: false } })
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, market: 'DE' })).toBe(false)
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, allowed: 'no' })).toBe(false)
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, gap: 'no-min' })).toBe(true)
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, gap: 'no-max' })).toBe(false)
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, gap: 'no-bounds' })).toBe(false)
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, locked: 'locked' })).toBe(true)
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, search: 'helm' })).toBe(true)
    expect(campaignMatches(r, { ...NO_CAMPAIGN_FILTER, search: 'gloves' })).toBe(false)
  })
})
