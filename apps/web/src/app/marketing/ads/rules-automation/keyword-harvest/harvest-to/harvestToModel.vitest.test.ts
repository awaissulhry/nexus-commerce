import { describe, expect, it } from 'vitest'

import type { HarvestCandidateRow, HarvestDestinations, HistoryRow, PreviewAnswer, PreviewStep } from '../_shared/types'
import {
  MAX_TERMS, TAKEN_BACK, acosWords, bidProblem, bidsAllTo, bidsFromCpc, buildPreviewBody, canTakeBack, candidateParts,
  BUDGET_BIDS, LIMITS_HREF, WIZARD_DEFAULT_BUDGET_CENTS, anchorRow, defaultBudgetCents, currencyOfRow, keptBySaved, oneCurrency, parseMoney as parseMoneyAgain, limitWordsOf, sourceChoice, bidWhyWords, campaignReason, defaultTo, draftProblem, doneViewOf, harvestButtonWords, harvestDoneLine, harvestsOf,
  leftOutOf, newCampaignHold, plainReason, probeBody, rowHold, newCampaignDefaults, openCampaignOf, termList,
  parseMoney, parsePercent, reviewHeld, reviewRowsOf, reviewSummary, scopeOf, setupHeld, sourceSwitch, termRowsOf, undoButtonWords,
  undoDoneLine, undoPlanOf,
} from './harvestToModel'

// Made-up names and round numbers only (the repo is public).
const ref = (id: string, name: string, href?: string) => ({ id, name, ...(href ? { href } : {}) })

function row(over: Partial<HarvestCandidateRow> & { id: string }): HarvestCandidateRow {
  const [market, productId, term] = over.id.split('|')
  return {
    term, kind: 'keyword', market, currency: 'EUR', product: ref(productId, `Product ${productId}`),
    source: null, sources: [], metrics: { windowDays: 60, impressions: 100, clicks: 10, orders: 2, spendCents: 400, salesCents: 4000, acosPct: 10, cpcCents: 40 },
    bar: { by: 'brain', label: '1+ order', passes: true }, state: 'READY', owner: { kind: 'NONE', id: null, name: '—' }, heldBy: null,
    destination: { kind: 'existing', how: 'own', portfolio: null, campaign: ref('c-exact', 'Jacket Exact', '/marketing/ads/campaigns/c-exact'), adGroup: ref('g-exact', 'Exact group'), match: 'EXACT', status: 'will-create' },
    funnel: [], startBidCents: 50, bidWhy: null, skipped: null, waiting: null, lastHarvest: null,
    ...over,
  }
}

const A = row({ id: 'IT|p1|rain jacket' })
const B = row({ id: 'IT|p1|summer jacket', startBidCents: 30, metrics: { windowDays: 60, impressions: 50, clicks: 5, orders: 1, acosPct: 5.25, cpcCents: 20 } })
const NEW = row({
  id: 'IT|p2|mesh gloves', product: ref('p2', 'Gloves'),
  destination: { kind: 'new', how: 'new', match: 'EXACT', plan: { name: 'GLOVES-SP-Keyword-Exact-Harvest', adGroupName: 'GLOVES-SP-Keyword-Exact-Harvest Ad Group', portfolio: ref('pf-1', 'Gloves IT'), dailyBudgetCents: 1000 } },
})

function tree(over: Partial<HarvestDestinations> = {}): HarvestDestinations {
  return {
    market: 'IT', product: ref('p1', 'Jacket'), match: 'EXACT', suggested: { kind: 'existing', adGroupId: 'g-exact' }, portfolios: [], unplaced: [],
    newCampaign: { name: 'JACKET-SP-Keyword-Exact-Harvest', adGroupName: 'JACKET-SP-Keyword-Exact-Harvest Ad Group', portfolio: ref('pf-1', 'Jacket IT'), dailyBudgetCents: 500, held: null },
    stored: [], ...over,
  }
}

const step = (over: Partial<PreviewStep> & Pick<PreviewStep, 'i' | 'kind'>): PreviewStep => ({ from: 'none', to: '', after: [], refusal: null, ...over })

function preview(over: Partial<PreviewAnswer> = {}): PreviewAnswer {
  return {
    steps: [], items: [], approvals: { count: 1, codes: 0 }, blocked: [],
    totals: { items: 3, ok: 3, keywords: 3, enables: 0, sourceNegatives: 4, funnelNegatives: 2, campaigns: 1, portfolios: 0 },
    planHash: 'hash-1234', raises: [], effect: '', ...over,
  }
}

describe('harvestToModel — ids and scope', () => {
  it('splits a candidate id on its first two bars (a term may hold one)', () => {
    expect(candidateParts('IT|p1|rain jacket')).toEqual({ market: 'IT', productId: 'p1', term: 'rain jacket' })
    expect(candidateParts('IT|p1|a|b')).toEqual({ market: 'IT', productId: 'p1', term: 'a|b' })
    expect(candidateParts('IT|p1')).toBe(null)
    expect(candidateParts('|p1|x')).toBe(null)
  })

  it('one place serves the terms of one product in one market; else each goes to its own place, said why', () => {
    expect(scopeOf([A, B])).toMatchObject({ market: 'IT', productId: 'p1', products: 1, held: null })
    expect(scopeOf([A, NEW]).held).toBe('Each to its own place · 2 products')
    expect(scopeOf([A, row({ id: 'DE|p1|rain jacket' })]).held).toBe('Each to its own place · 2 markets')
    expect(scopeOf([]).held).toBe('No terms to harvest')
  })
})

describe('harvestToModel — money and bids typed by a person', () => {
  it('reads an amount in either decimal mark, a percent with a sign', () => {
    expect(parseMoney('0.35')).toEqual({ kind: 'ok', value: 35 })
    expect(parseMoney('0,35')).toEqual({ kind: 'ok', value: 35 })
    expect(parseMoney('€ 1')).toEqual({ kind: 'ok', value: 100 })
    expect(parseMoney('')).toEqual({ kind: 'empty' })
    expect(parseMoney('abc')).toEqual({ kind: 'bad' })
    expect(parseMoney('1.234')).toEqual({ kind: 'bad' })
    expect(parsePercent('+10')).toEqual({ kind: 'ok', value: 10 })
    expect(parsePercent('-5 %')).toEqual({ kind: 'ok', value: -5 })
    expect(parsePercent('x')).toEqual({ kind: 'bad' })
  })

  it('a bid outside Amazon\'s band says so; an empty one lets the server pick', () => {
    expect(bidProblem('0.01', 'EUR')).toBe('Between €0.02 and €100.00')
    expect(bidProblem('abc', 'EUR')).toBe('Type an amount, like 0.35')
    expect(bidProblem('', 'EUR')).toBe(null)
    expect(bidProblem('0.40', 'EUR')).toBe(null)
  })

  it('shows the start bid until the person types one; ACoS in plain percent', () => {
    const [a, b] = termRowsOf([A, B], { [B.id]: '0.9' })
    expect(a.bidText).toBe('0.50')
    expect(b.bidText).toBe('0.9')
    expect(a.acos).toBe('10 %')
    expect(b.acos).toBe('5.3 %')
    expect(acosWords(null)).toBe('—')
    expect(termRowsOf([row({ id: 'IT|p1|x', startBidCents: undefined })], {})[0].moneyHidden).toBe(false)
    const hidden = row({ id: 'IT|p1|y' }); delete (hidden as { startBidCents?: number }).startBidCents
    expect(termRowsOf([hidden], {})[0].moneyHidden).toBe(true)
  })

  it('"All to €x" sets every bid; "CPC +x %" raises each term\'s own CPC, inside the band', () => {
    expect(bidsAllTo([A, B], 45)).toEqual({ [A.id]: '0.45', [B.id]: '0.45' })
    expect(bidsAllTo([A], 1)).toEqual({ [A.id]: '0.02' })
    expect(bidsFromCpc([A, B], 10)).toEqual({ [A.id]: '0.44', [B.id]: '0.22' })
    expect(bidsFromCpc([row({ id: 'IT|p1|z', metrics: { windowDays: 60, impressions: 0, clicks: 0, orders: 0, cpcCents: null } })], 10)).toEqual({})
  })
})

describe('harvestToModel — the preview body', () => {
  it('each to its own place: no `to`, the typed bid only, the source switch only once touched', () => {
    const body = buildPreviewBody({ rows: [A, B], to: null, match: 'EXACT', negate: null, bids: { [B.id]: '0.9', [A.id]: 'bad' }, newCampaign: null, newPortfolio: null })
    expect(body).toEqual({ items: [{ candidateId: A.id, match: 'EXACT' }, { candidateId: B.id, match: 'EXACT', bidCents: 90 }] })
    const off = buildPreviewBody({ rows: [A], to: null, match: 'EXACT', negate: false, bids: {}, newCampaign: null, newPortfolio: null })
    expect(off.items[0].negateSource).toBe(false)
  })

  it('a term whose suggested place is a new campaign gets its product\'s one new campaign (in its portfolio)', () => {
    const NEW2 = row({ ...NEW, id: 'IT|p2|mesh gloves women' })
    const body = buildPreviewBody({ rows: [A, NEW, NEW2], to: null, match: 'EXACT', negate: null, bids: {}, newCampaign: null, newPortfolio: null })
    expect(body.items.map((i) => i.to)).toEqual([undefined, { newCampaign: 'new-1' }, { newCampaign: 'new-1' }])
    // Its budget fits its start bids (10 × 0.50 = 5.00 is under the wizard's 10.00): 10.00.
    expect(body.newCampaigns).toEqual([{ key: 'new-1', productId: 'p2', match: 'EXACT', name: 'GLOVES-SP-Keyword-Exact-Harvest', dailyBudgetCents: 1000, portfolio: { id: 'pf-1' } }])
    // Harvested as phrase, the server names the phrase campaign itself.
    const phrase = buildPreviewBody({ rows: [NEW], to: null, match: 'PHRASE', negate: null, bids: {}, newCampaign: null, newPortfolio: null })
    expect(phrase.newCampaigns?.[0].name).toBeUndefined()
  })

  it('one place for all: every term goes there; a new campaign (and portfolio) is described once', () => {
    const body = buildPreviewBody({
      rows: [A, B], to: { newCampaign: 'new' }, match: 'EXACT', negate: true, bids: {},
      newCampaign: { name: ' Jacket Exact 2 ', budget: '10', portfolio: { newPortfolio: 'pf' } }, newPortfolio: { name: 'Jacket IT', cap: '300' },
    })
    expect(body.items.every((i) => 'newCampaign' in (i.to ?? {}) && i.negateSource === true)).toBe(true)
    expect(body.newCampaigns).toEqual([{ key: 'new', productId: 'p1', match: 'EXACT', name: 'Jacket Exact 2', dailyBudgetCents: 1000, portfolio: { newPortfolio: 'pf' } }])
    expect(body.newPortfolios).toEqual([{ key: 'pf', name: 'Jacket IT', capMonthlyCents: 30000 }])
    const plain = buildPreviewBody({ rows: [A], to: { adGroupId: 'g-exact' }, match: 'EXACT', negate: null, bids: {}, newCampaign: null, newPortfolio: null })
    expect(plain).toEqual({ items: [{ candidateId: A.id, match: 'EXACT', to: { adGroupId: 'g-exact' } }] })
  })

  it('never sends more than one change set takes', () => {
    const many = Array.from({ length: MAX_TERMS + 5 }, (_, i) => row({ id: `IT|p1|term ${i}` }))
    expect(buildPreviewBody({ rows: many, to: null, match: 'EXACT', negate: null, bids: {}, newCampaign: null, newPortfolio: null }).items).toHaveLength(MAX_TERMS)
  })
})

describe('harvestToModel — set up', () => {
  it('the source switch: on by default; the saved "keep the source" shows off with why; a person can turn it on', () => {
    const t = tree({ stored: [{ grain: 'product', scopeId: 'p1', match: 'EXACT', adGroup: ref('g-exact', 'Exact group'), negateAtSource: false }] })
    expect(sourceSwitch(tree(), { adGroupId: 'g-exact' }, 'EXACT', null)).toEqual({ on: true, why: null })
    expect(sourceSwitch(t, { adGroupId: 'g-exact' }, 'EXACT', null)).toEqual({ on: false, why: 'Off for this destination: your setting' })
    expect(sourceSwitch(t, { adGroupId: 'g-exact' }, 'EXACT', true)).toEqual({ on: true, why: 'On for this harvest: your saved setting says off' })
    expect(sourceSwitch(tree(), { adGroupId: 'g-exact' }, 'EXACT', false)).toEqual({ on: false, why: null })
  })

  it('the new campaign starts as the server proposes it; its fields say what is missing', () => {
    expect(newCampaignDefaults(tree())).toEqual({ name: 'JACKET-SP-Keyword-Exact-Harvest', budget: '10.00', portfolio: { id: 'pf-1' } })
    expect(newCampaignDefaults(tree({ newCampaign: { name: 'X', adGroupName: 'X g', portfolio: ref('local-pf-1', 'Local'), dailyBudgetCents: 50, held: null } }))).toEqual({ name: 'X', budget: '10.00', portfolio: null })
    // Start bids of 1.30 and 1.94: 10 × 1.94 = 19.40, rounded up to 20.00.
    expect(newCampaignDefaults(tree(), [130, 194, null]).budget).toBe('20.00')
    expect(draftProblem({ name: ' ', budget: '5', portfolio: null }, null, 'EUR')).toBe('Name the new campaign')
    expect(draftProblem({ name: 'A', budget: '0.5', portfolio: null }, null, 'EUR')).toBe('Budget: at least €1.00 a day')
    expect(draftProblem({ name: 'A', budget: '5', portfolio: { newPortfolio: 'pf' } }, { name: '', cap: '' }, 'EUR')).toBe('Name the new portfolio')
    expect(draftProblem({ name: 'A', budget: '5', portfolio: { newPortfolio: 'pf' } }, { name: 'P', cap: 'x' }, 'EUR')).toBe('Monthly cap: at least €1.00, or leave it empty')
    expect(draftProblem({ name: 'A', budget: '5', portfolio: { newPortfolio: 'pf' } }, { name: 'P', cap: '' }, 'EUR')).toBe(null)
  })

  it('one place for all starts where the server suggests, else where most terms would go, else a new campaign', () => {
    const exact = { id: 'g-exact', name: 'Exact group', role: 'EXACT' as const, keywords: 2, productTargets: 0, serving: true, held: null, suggested: false }
    const auto = { ...exact, id: 'g-auto', name: 'Auto group', role: 'AUTO' as const, held: { label: 'Auto group', reason: 'Takes no keywords.' } }
    const campaign = { id: 'c', name: 'Jacket', status: 'ENABLED', serving: true, role: 'EXACT' as const, biddingStrategy: null, adGroups: [exact, auto] }
    expect(defaultTo(tree(), [A])).toBe(null) // suggested, but not in the tree: nothing to start on
    const t = tree({ suggested: null, unplaced: [campaign] })
    expect(defaultTo(t, [A, B])).toEqual({ adGroupId: 'g-exact' })
    expect(defaultTo(tree({ suggested: { kind: 'existing', adGroupId: 'g-exact' }, unplaced: [campaign] }), [])).toEqual({ adGroupId: 'g-exact' })
    expect(defaultTo(tree({ suggested: null }), [NEW])).toEqual({ newCampaign: 'new' })
    expect(defaultTo(null, [A])).toBe(null)
  })

  it('a term that will not go says why: its own hold, else its state', () => {
    expect(rowHold({ heldBy: null, state: 'READY' })).toBe(null)
    expect(rowHold({ heldBy: null, state: 'WAITING' })?.label).toBe('Waiting')
    expect(rowHold({ heldBy: null, state: 'HARVESTED' })?.label).toBe('Harvested')
    expect(rowHold({ heldBy: { kind: 'cap', label: 'Daily cap', reason: 'Ten a day.' }, state: 'HELD' })?.label).toBe('Daily cap')
  })

  it('Review is held, and says why, until it can run', () => {
    const base = { rows: 2, mode: 'choose' as const, single: true, to: { adGroupId: 'g' }, draft: null, bid: null }
    expect(setupHeld({ ...base, rows: 0 })).toBe('No terms to harvest')
    expect(setupHeld({ ...base, to: null })).toBe('Choose where they go')
    expect(setupHeld({ ...base, to: null, mode: 'suggested' })).toBe(null)
    expect(setupHeld({ ...base, draft: 'Name the new campaign' })).toBe('Name the new campaign')
    expect(setupHeld({ ...base, bid: { term: 'rain jacket', problem: 'Type an amount, like 0.35' } })).toBe('Bid of “rain jacket”: Type an amount, like 0.35')
    expect(setupHeld(base)).toBe(null)
  })
})

describe('harvestToModel — the review', () => {
  const p = preview({
    steps: [
      step({ i: 0, kind: 'portfolio', portfolio: ref('new:pf', 'Jacket IT') }),
      step({ i: 1, kind: 'portfolioCap', portfolio: ref('new:pf', 'Jacket IT'), capMonthlyCents: 30000 }),
      step({ i: 2, kind: 'campaign', portfolio: ref('new:pf', 'Jacket IT'), campaign: ref('new:new', 'Jacket Exact 2'), adGroup: ref('new:new:group', 'Jacket Exact 2 Ad Group'), match: 'EXACT', dailyBudgetCents: 1000 }),
      step({ i: 3, kind: 'keyword', term: 'rain jacket', campaign: ref('new:new', 'Jacket Exact 2'), adGroup: ref('new:new:group', 'Jacket Exact 2 Ad Group'), match: 'EXACT', bidCents: 35 }),
      step({ i: 4, kind: 'enable', term: 'summer jacket', campaign: ref('c-exact', 'Jacket Exact', '/x'), adGroup: ref('g-exact', 'Exact group', '/y'), match: 'EXACT', bidCents: 20 }),
      step({ i: 5, kind: 'sourceNegative', term: 'rain jacket', campaign: ref('c-auto', 'Jacket Auto', '/a'), adGroup: ref('g-auto', 'Auto group'), match: 'EXACT' }),
      step({ i: 6, kind: 'funnelNegative', term: 'rain jacket', campaign: ref('c-broad', 'Jacket Broad'), adGroup: ref('g-broad', 'Broad group'), match: 'PHRASE' }),
    ],
    totals: { items: 3, ok: 2, keywords: 1, enables: 1, sourceNegatives: 1, funnelNegatives: 1, campaigns: 1, portfolios: 1 },
    blocked: [{ candidateId: 'IT|p1|x', term: 'leather jacket', reason: 'It is already an exact keyword of this product.' }],
  })

  it('one table in three tabs: keywords (Now = the CPC, the bid\'s why in a few words), negatives, the new campaign', () => {
    const withWhy = { ...p, steps: p.steps.map((x) => (x.kind === 'keyword' || x.kind === 'enable' ? { ...x, candidateId: `IT|p1|${x.term}` } : x)),
      items: [{ candidateId: 'IT|p1|rain jacket', bidWhy: 'the bid brain\'s goal bid — target ACoS × …' }, { candidateId: 'IT|p1|summer jacket', bidWhy: 'the bid you set' }] } as unknown as PreviewAnswer
    const rows = reviewRowsOf(withWhy, 'EUR', new Map([['IT|p1|rain jacket', 40]]))
    expect(rows.map((r) => [r.group, r.what, r.now, r.next, r.note ?? ''])).toEqual([
      ['portfolio', 'Portfolio', '—', 'New · €300.00 a month', ''],
      ['campaign', 'Campaign', '—', '€10.00 a day', 'Exact · 1 ad group'],
      ['keywords', 'rain jacket', 'CPC €0.40', 'Exact · €0.35', 'For your target ACoS'],
      ['keywords', 'summer jacket', 'Paused', 'Exact · €0.20', 'On again · Your bid'],
      ['negatives', 'rain jacket', '—', 'Negative exact', 'Where found'],
      ['negatives', 'rain jacket', '—', 'Negative phrase', 'Wider match'],
    ])
    // Without a CPC or a why, a dash and no note.
    const plainRow = reviewRowsOf(p, 'EUR').find((r) => r.what === 'rain jacket')
    expect(plainRow?.now).toBe('—')
    expect(plainRow?.note).toBeUndefined()
    // A new entity has no page yet: no link.
    expect(rows[2].where).toEqual([{ id: 'new:new', name: 'Jacket Exact 2' }, { id: 'new:new:group', name: 'Jacket Exact 2 Ad Group' }])
    expect(rows[3].where[0]).toEqual({ id: 'c-exact', name: 'Jacket Exact', href: '/x' })
  })

  it('the counted primary, the summary line, the terms left out', () => {
    expect(harvestButtonWords(p)).toBe('Harvest 2 · create 2')
    expect(harvestButtonWords(preview({ totals: { ...p.totals, campaigns: 0, portfolios: 0 } }))).toBe('Harvest 2')
    expect(harvestButtonWords(preview({ totals: { ...p.totals, ok: 0 } }))).toBe('Harvest')
    expect(reviewSummary(['IT'], p)).toBe('Amazon IT · 1 new campaign · 1 new portfolio')
    expect(reviewSummary(['IT', 'DE'], preview({ totals: { ...p.totals, campaigns: 0, portfolios: 0 } }))).toBe('Amazon IT, DE')
    expect(leftOutOf(p, 'IT')).toEqual([{ key: 'Left out', label: 'Left out', terms: ['leather jacket'], reason: 'It is already an exact keyword of this product.', fix: null }])
    const withHold = { ...p, items: [{ candidateId: 'IT|p1|x', hold: { kind: 'home' as const, label: 'Already a keyword', reason: 'One owner per term.' } }] } as unknown as PreviewAnswer
    expect(leftOutOf(withHold, 'IT')[0]).toMatchObject({ label: 'Already a keyword', reason: 'One owner per term.', terms: ['leather jacket'] })
    // One line per reason, in words on the line (M7), with where to fix it.
    const ceiling = 'The new campaign cannot be built: IT has no daily spend ceiling: set one first (a new campaign is built only inside the market\'s spend ceiling).'
    const two = { ...p, blocked: [{ candidateId: 'IT|p1|a', term: 'a', reason: ceiling }, { candidateId: 'IT|p1|b', term: 'b', reason: ceiling }], items: [] } as unknown as PreviewAnswer
    expect(leftOutOf(two, 'IT')).toEqual([{ key: 'Set IT\'s daily spend limit first', label: 'Set IT\'s daily spend limit first', terms: ['a', 'b'], reason: ceiling, fix: { label: 'Set IT\'s daily spend limit', href: LIMITS_HREF } }])
    expect(termList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2')
  })

  it('Harvest is held while the plan is read, when nothing can go, and on a refusal', () => {
    expect(reviewHeld('reading', null, null)).toBe('Reading the plan')
    expect(reviewHeld('failed', null, null)).toBe('The plan could not be read')
    expect(reviewHeld('ready', preview({ totals: { ...p.totals, ok: 0 } }), null)).toBe('Nothing can be harvested')
    expect(reviewHeld('ready', p, 'Refused: no person')).toBe('Refused: no person')
    expect(reviewHeld('saving', p, null)).toBe('Sending')
    expect(reviewHeld('ready', p, null)).toBe(null)
  })
})

describe('harvestToModel — done, open campaign, undo', () => {
  const p = preview()

  it('approved: the counts the button promised, and when it goes to Amazon; asked: it waits', () => {
    // S2: what was approved, never "harvested" before it ran.
    expect(harvestDoneLine(p)).toBe('3 keywords · 1 new campaign · 6 blocks')
    expect(harvestDoneLine(preview({ totals: { ...p.totals, ok: 1, campaigns: 0, sourceNegatives: 1, funnelNegatives: 1 } }))).toBe('1 keyword · 2 blocks')
    expect(doneViewOf({ status: 'scheduled', executeAfter: '2026-10-11T10:00:20Z', approve: { ok: true } }, harvestDoneLine(p)))
      .toEqual({ line: '3 keywords · 1 new campaign · 6 blocks', tone: 'success', words: 'Approved', resultTone: 'success', runsAt: '2026-10-11T10:00:20Z', approveError: null })
    expect(doneViewOf({ status: 'queued', approve: { ok: false, error: 'Not yours to approve' } }, 'x'))
      .toMatchObject({ line: 'Asked · waits for approval', tone: 'warning', words: 'Waiting', approveError: 'Not yours to approve' })
    expect(doneViewOf({ status: 'queued', approve: { ok: false, code: 'mfa_required', error: 'raise: code' } }, 'x').approveError).toBe('Waits for your authenticator code')
    expect(TAKEN_BACK).toBe('Taken back · nothing sent')
  })

  it('Open campaign: the one campaign the keywords go to; a new one is built when it runs', () => {
    const kw = (campaign: { id: string; name: string; href?: string }) => step({ i: 0, kind: 'keyword', campaign })
    expect(openCampaignOf({ steps: [kw(ref('c1', 'A', '/marketing/ads/campaigns/c1'))] })).toEqual({ href: '/marketing/ads/campaigns/c1' })
    expect(openCampaignOf({ steps: [kw(ref('new:new', 'A'))] })).toEqual({ held: 'The campaign is built when the harvest runs' })
    expect(openCampaignOf({ steps: [kw(ref('c1', 'A', '/a')), { ...kw(ref('c2', 'B', '/b')), i: 1 }] })).toBe(null)
  })

  it('Undo before it ran takes it back; after the window it reads what ran', () => {
    const now = Date.parse('2026-10-11T10:00:10Z')
    expect(canTakeBack({ status: 'scheduled', executeAfter: '2026-10-11T10:00:20Z' }, now)).toBe(true)
    expect(canTakeBack({ status: 'scheduled', executeAfter: '2026-10-11T10:00:00Z' }, now)).toBe(false)
    expect(canTakeBack({ status: 'queued', executeAfter: null }, now)).toBe(true)
  })

  it('an undo pauses each keyword and lifts each block that landed; nothing standing says why', () => {
    const h = (over: Partial<HistoryRow>): HistoryRow => ({
      harvestId: 'h1', candidateId: 'IT|p1|rain jacket', term: 'rain jacket', market: 'IT', product: ref('p1', 'Jacket'), at: '2026-10-11T10:01:00Z',
      by: { kind: 'PERSON', id: 'u1', name: 'Person' }, changeSetId: 'cs-1', match: 'EXACT', status: 'DONE',
      destination: { portfolio: null, campaign: ref('c-exact', 'Jacket Exact'), adGroup: ref('g-exact', 'Exact group') }, keyword: ref('k1', 'rain jacket'),
      sources: [{ adGroup: ref('g-auto', 'Auto group'), result: 'landed', action: 'negate' }, { adGroup: ref('g-b', 'Broad group'), result: null, action: 'kept' }],
      funnel: [{ adGroup: ref('g-p', 'Phrase group'), match: 'EXACT', result: 'landed', action: 'negate' }],
      judge: { verdict: null, judgeAfter: null, judgedAt: null, why: null }, undo: { available: true, why: null }, ...over,
    })
    const mine = harvestsOf([h({}), h({ harvestId: 'h9', changeSetId: 'other' })], 'cs-1')
    expect(mine.map((x) => x.harvestId)).toEqual(['h1'])
    const plan = undoPlanOf(mine)
    expect(plan.harvestIds).toEqual(['h1'])
    expect(plan.rows.map((r) => [r.group, r.what, r.now, r.next])).toEqual([
      ['keywords', 'rain jacket', 'On', 'Paused'],
      ['negatives', 'rain jacket', 'Negative', 'Removed'],
      ['negatives', 'rain jacket', 'Negative', 'Removed'],
    ])
    expect(undoButtonWords(plan)).toBe('Undo 1 harvest')
    expect(undoDoneLine(plan)).toBe('Undo · 1 keyword · 2 blocks')
    const none = undoPlanOf([h({ undo: { available: false, why: 'It is put back already.' } })])
    expect(none.held).toBe('It is put back already.')
    expect(none.harvestIds).toEqual([])
  })
})

describe('harvestToModel — can this market build a new campaign? (M7, asked up front)', () => {
  const refused = (reason: string, label = 'Campaign not buildable') => ({ items: [{ ok: false, refusal: reason, hold: { kind: 'record', label, reason } }] }) as unknown as PreviewAnswer

  it('the probe is one term into a new campaign of its product, and writes nothing', () => {
    expect(probeBody(A, 'PHRASE')).toEqual({ items: [{ candidateId: A.id, to: { newCampaign: 'probe' }, match: 'PHRASE' }], newCampaigns: [{ key: 'probe', productId: 'p1', match: 'PHRASE' }] })
  })

  it('held in plain words, with where to fix it; a term refused for its own reason says nothing about the campaign', () => {
    expect(newCampaignHold(refused('The new campaign cannot be built: IT has no daily spend ceiling: set one first (a new campaign is built only inside the market\'s spend ceiling).'), 'IT'))
      .toEqual({ label: 'Set IT\'s daily spend limit first', reason: 'Set IT\'s daily spend limit first', fix: { label: 'Set IT\'s daily spend limit', href: LIMITS_HREF } })
    expect(newCampaignHold(refused('The new campaign cannot be built: the product\'s own campaigns advertise no SKU Nexus knows (none): a new campaign has nothing to advertise.'), 'IT')?.reason).toBe('No product to advertise')
    // R9: a reason the window does not know is not held up front (the review says it).
    expect(newCampaignHold(refused('The new campaign cannot be built: something new happened.'), 'IT')).toBe(null)
    expect(campaignReason('The new campaign cannot be built: something new happened.')?.words).toBe('Something new happened')
    expect(newCampaignHold(refused('It is already a exact keyword of this product.', 'Already a keyword'), 'IT')).toBe(null)
    expect(newCampaignHold({ items: [{ ok: true }] } as unknown as PreviewAnswer, 'IT')).toBe(null)
    expect(newCampaignHold(null, 'IT')).toBe(null)
    expect(campaignReason('Something else')).toBe(null)
    expect(plainReason('its daily budget is above IT\'s spend ceiling a day', 'IT')?.words).toBe('Budget above the daily spend limit')
  })
})

describe('harvestToModel — the start bid in a few words, the tree read for a term (S3, S4)', () => {
  it('never the brain\'s formula', () => {
    expect(bidWhyWords('the bid brain\'s goal bid — target ACoS (the ads strategy …) × the term\'s pooled conversion rate')).toBe('For your target ACoS')
    expect(bidWhyWords('the term\'s observed cost per click, held inside the strategy\'s lowest and highest bid (no goal)')).toBe('Your CPC, inside your bid limits')
    expect(bidWhyWords('the term\'s observed cost per click (no goal)')).toBe('Your CPC')
    expect(bidWhyWords('the bid you set')).toBe('Your bid')
    expect(bidWhyWords(null)).toBe(null)
    const [a] = termRowsOf([row({ id: 'IT|p1|x', bidWhy: 'the bid brain\'s goal bid …' })], {})
    expect(a).toMatchObject({ cpc: '€0.40', bidHint: 'For your target ACoS · CPC now €0.40' })
    expect(termRowsOf([A], { [A.id]: '0.9' })[0].bidHint).toBe('Your bid · CPC now €0.40')
  })

  it('the tree is read for a term that can go, whose place most terms share', () => {
    const other = row({ id: 'IT|p1|z', destination: { kind: 'existing', how: 'own', portfolio: null, campaign: ref('c2', 'Other'), adGroup: ref('g2', 'Other group'), match: 'EXACT', status: 'will-create' } })
    const waiting = row({ id: 'IT|p1|w', state: 'WAITING' })
    expect(anchorRow([waiting, other, A, B])?.id).toBe(A.id)
    expect(anchorRow([waiting])?.id).toBe(waiting.id)
    expect(anchorRow([])).toBe(null)
  })
})

describe('harvestToModel — release review fixes', () => {
  it('R1: terms of one product in two markets never share a new campaign', () => {
    const it_ = row({ ...NEW, id: 'IT|p2|mesh gloves' })
    const de = row({ ...NEW, id: 'DE|p2|mesh gloves', market: 'DE' })
    const it2 = row({ ...NEW, id: 'IT|p2|mesh gloves women' })
    const body = buildPreviewBody({ rows: [it_, de, it2], to: null, match: 'EXACT', negate: null, bids: {}, newCampaign: null, newPortfolio: null })
    expect(body.items.map((i) => i.to)).toEqual([{ newCampaign: 'new-1' }, { newCampaign: 'new-2' }, { newCampaign: 'new-1' }])
    expect(body.newCampaigns?.map((c) => [c.key, c.productId])).toEqual([['new-1', 'p2'], ['new-2', 'p2']])
  })

  it('R3: ticking the source box off and on again is no choice: a saved "keep the source" still wins', () => {
    expect(sourceChoice(true, true)).toBe(null)
    expect(sourceChoice(false, true)).toBe(false)
    expect(sourceChoice(true, false)).toBe(true)
    expect(sourceChoice(false, false)).toBe(null)
    // Off, then on again, where each term goes to its own place: nothing is sent, so each saved place decides.
    const back = sourceChoice(true, true)
    const body = buildPreviewBody({ rows: [A], to: null, match: 'EXACT', negate: back, bids: {}, newCampaign: null, newPortfolio: null })
    expect(body.items[0]).not.toHaveProperty('negateSource')
    const kept = row({ id: 'IT|p1|k', sources: [{ portfolio: null, campaign: ref('c', 'C'), adGroup: ref('g', 'G'), role: 'AUTO', clicks: 1, action: 'kept', why: 'your saved harvest place says not to block the source: the term keeps running here too' }] })
    expect(keptBySaved([A, kept])).toBe(1)
  })

  it('R5: each row in its own market\'s money; "Bid all" only when the rows share one', () => {
    const uk = row({ id: 'UK|p1|rain jacket', market: 'UK', currency: null })
    expect(currencyOfRow(uk)).toBe('GBP')
    expect(currencyOfRow(A)).toBe('EUR')
    expect(oneCurrency([A, B])).toBe('EUR')
    expect(oneCurrency([A, uk])).toBe(null)
    const [, ukRow] = termRowsOf([A, uk], {})
    expect(ukRow).toMatchObject({ currency: 'GBP', cpc: '£0.40' })
    const p = preview({
      steps: [step({ i: 0, kind: 'keyword', candidateId: uk.id, term: 'rain jacket', campaign: ref('c', 'C'), adGroup: ref('g', 'G'), match: 'EXACT', bidCents: 50 })],
    })
    expect(reviewRowsOf(p, 'EUR', new Map([[uk.id, 40]]), new Map([[uk.id, 'GBP']]))[0]).toMatchObject({ now: 'CPC £0.40', next: 'Exact · £0.50' })
  })

  it('R7: more ticked than one change set takes — it says what it harvests', () => {
    expect(limitWordsOf(3, 3)).toBe(null)
    expect(limitWordsOf(6200, 200)).toBe('6,200 selected: this harvests the 200 listed below, at most 200 at once. Harvest the rest after this one.')
  })

  it('R9: the probe holds only what no field here can change — never a budget or bid it guessed', () => {
    const refused = (reason: string) => ({ items: [{ ok: false, refusal: reason, hold: { kind: 'destination', label: 'Campaign not buildable', reason } }] }) as unknown as PreviewAnswer
    expect(newCampaignHold(refused('The new campaign cannot be built: its daily budget is above IT\'s spend ceiling a day.'), 'IT')).toBe(null)
    expect(newCampaignHold(refused('A start bid is above the new campaign\'s daily budget: raise the budget or lower the bid.'), 'IT')).toBe(null)
    expect(newCampaignHold(refused('The new campaign cannot be built: IT already has a campaign named "X": give it another name.'), 'IT')).toBe(null)
    expect(newCampaignHold(refused('Amazon\'s write gate refuses the new campaign "X" (over the per-write cap): nothing of it is written.'), 'IT')).toBe(null)
    expect(newCampaignHold(refused('The new campaign cannot be built: IT has no daily spend ceiling: set one first.'), 'IT')?.reason).toBe('Set IT\'s daily spend limit first')
  })

  it('Low: a percent with a stray letter is bad, not NaN; names and amounts past the server\'s limits say so', () => {
    expect(parsePercent('x5')).toEqual({ kind: 'bad' })
    expect(parsePercent('+5')).toEqual({ kind: 'ok', value: 5 })
    expect(draftProblem({ name: 'x'.repeat(129), budget: '5', portfolio: null }, null, 'EUR')).toBe('Name: at most 128 characters')
    expect(draftProblem({ name: 'A', budget: '100000.01', portfolio: null }, null, 'EUR')).toBe('Budget: at most €100,000.00 a day')
    expect(parseMoneyAgain('100000.01')).toEqual({ kind: 'ok', value: 10000001 })
  })
})

describe('harvestToModel — functional walk', () => {
  it('a new campaign starts with a budget its start bids fit in: the wizard\'s 10.00, at least 10 × the highest bid', () => {
    expect(WIZARD_DEFAULT_BUDGET_CENTS).toBe(1000)
    expect(BUDGET_BIDS).toBe(10)
    expect(defaultBudgetCents(100, [130, 194])).toBe(2000)
    expect(defaultBudgetCents(100, [50])).toBe(1000)
    expect(defaultBudgetCents(5000, [50])).toBe(5000) // a playbook's larger budget stays
    expect(defaultBudgetCents(null, [])).toBe(1000)
    // Suggested places: the per-product new campaign takes its own terms' bids (a typed one wins).
    const hi = row({ ...NEW, id: 'IT|p2|hi', startBidCents: 300 })
    const typed = buildPreviewBody({ rows: [NEW, hi], to: null, match: 'EXACT', negate: null, bids: { [NEW.id]: '4.05' }, newCampaign: null, newPortfolio: null })
    expect(typed.newCampaigns?.[0].dailyBudgetCents).toBe(4100)
  })

  it('a new portfolio is its own tab, not counted as a campaign; 2FA off says what to do', () => {
    const p = preview({ steps: [step({ i: 0, kind: 'portfolio', portfolio: ref('new:pf', 'Jacket IT') }), step({ i: 1, kind: 'campaign', portfolio: ref('new:pf', 'Jacket IT'), campaign: ref('new:new', 'J'), match: 'EXACT', dailyBudgetCents: 1000 })] })
    expect(reviewRowsOf(p, 'EUR').map((r) => r.group)).toEqual(['portfolio', 'campaign'])
    expect(doneViewOf({ status: 'queued', approve: { ok: false, code: 'mfa_not_enrolled', error: 'Turn on two-factor authentication before you approve a change that builds 1 new campaign …' } }, 'x').approveError)
      .toBe('Turn on your authenticator to approve a new campaign')
  })
})
