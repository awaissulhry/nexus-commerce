/**
 * ADS AUTONOMY W1-4 — the Strategy tab's words and rules (strategyWords.ts): labels and units, "inherited from …", the
 * honest "read by" / "stored only", the draft the API takes, the API's refusals at their field, the change table, the
 * raise list and the counted save button. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import type { ClaudeEntry, FieldEntry, HistoryVersion, StrategyChange, StrategyRowOut } from './strategyApi'
import {
  barWords,
  categoryChoices,
  effectLines,
  changeRows,
  claudeRow,
  diffDraft,
  draftOf,
  fieldAllowed,
  historyLine,
  inForceLine,
  leaveImpact,
  listWords,
  moneyCents,
  plainLabel,
  raiseList,
  readByWords,
  rowSummary,
  saveButtonWords,
  scopeWhat,
  serverError,
  sourceWords,
  stepUpSentence,
  valueText,
  type Scope,
} from './strategyWords'

const MARKET: Scope = { level: 'MARKET' }
const CATEGORY: Scope = { level: 'CATEGORY', id: 'cat-ff', label: 'Full face' }
const PRODUCT: Scope = { level: 'PRODUCT', id: 'p-m', label: 'TEST-HELMET-M' }
const marketSource = { level: 'market' as const, scopeId: '*', label: 'IT market', version: 3, strategyId: 's-m' }
const categorySource = { level: 'category' as const, scopeId: 'cat-ff', label: 'Full face (IT)', version: 1, strategyId: 's-c' }

const row = (over: Partial<StrategyRowOut> = {}): StrategyRowOut => ({
  strategyId: 's-m', level: 'MARKET', scopeId: '*', label: 'IT market', version: 3, updatedAt: '2026-10-06T08:00:00Z', updatedBy: 'user:u1',
  goal: null, goalNote: null, targetKind: null, targetPct: null, monthlySpendCapCents: null, minBidCents: null, maxBidCents: null,
  maxChangePct: null, maxActionsPerRun: null, protect: null, harvestMinOrders: null, harvestMinClicks: null, harvestMaxAcosPct: null,
  harvestWindowDays: null, negateMinClicks: null, negateMinSpendCents: null, negateMaxOrders: null, negateWindowDays: null,
  stopMethod: null, stopBidCents: null, claudeAutonomy: null, reviewEveryDays: null, ...over,
})

describe('values in words, in the market\'s money', () => {
  it('each field with its unit; money in the currency; groups as one line', () => {
    expect(valueText('target', { targetKind: 'ACOS', targetPct: 30 }, 'EUR')).toBe('ACoS 30 %')
    expect(valueText('target', { targetKind: 'TACOS', targetPct: 12 }, 'EUR')).toBe('TACoS 12 %')
    expect(valueText('maxBidCents', 150, 'EUR')).toBe('€1.50')
    expect(valueText('monthlySpendCapCents', 500000, 'EUR')).toBe('€5,000.00 a month')
    expect(valueText('maxBidCents', 150, null)).toBe('1.50')
    expect(valueText('maxChangePct', 20, 'EUR')).toBe('20 %')
    expect(valueText('reviewEveryDays', 1, 'EUR')).toBe('1 day')
    expect(valueText('harvest', { harvestMinOrders: 2, harvestMinClicks: 10, harvestMaxAcosPct: null, harvestWindowDays: 60 }, 'EUR')).toBe('2 orders · 10 clicks · any ACoS · last 60 days')
    expect(valueText('negate', { negateMinClicks: 15, negateMinSpendCents: 1000, negateMaxOrders: 0, negateWindowDays: 30 }, 'EUR')).toBe('15 clicks · €10.00 spent · at most 0 orders · last 30 days')
    expect(valueText('stop', { stopMethod: 'LOW_BIDS', stopBidCents: null }, 'EUR')).toBe('Low bids at Nexus’s own floor')
    expect(valueText('claudeAutonomy', { bid: 'ask', negative: 'confirm' }, 'EUR')).toBe('Bids: Ask · Negative keywords: Confirm')
    expect(valueText('goal', 'CLEAR_STOCK', 'EUR')).toBe('Clear stock')
    expect(valueText('maxBidCents', null, 'EUR')).toBeNull()
  })

  it('a money part hidden from this person says so, never "any ACoS"', () => {
    expect(valueText('harvest', { harvestMinOrders: 2, harvestMinClicks: 10, harvestWindowDays: 60 }, 'EUR')).toBe('2 orders · 10 clicks · ACoS hidden · last 60 days')
    expect(valueText('negate', { negateMinClicks: 15, negateMaxOrders: 0, negateWindowDays: 30 }, 'EUR')).toBe('15 clicks · spend hidden · at most 0 orders · last 30 days')
  })

  it('the most changes per run belong to a market; protection to a category or a product', () => {
    expect(fieldAllowed('maxActionsPerRun', 'MARKET')).toBe(true)
    expect(fieldAllowed('maxActionsPerRun', 'CATEGORY')).toBe(false)
    expect(fieldAllowed('protect', 'MARKET')).toBe(false)
    expect(fieldAllowed('protect', 'PRODUCT')).toBe(true)
  })
})

describe('where a value comes from', () => {
  it('set here, inherited from the market, a category or a parent product', () => {
    expect(sourceWords(marketSource, MARKET)).toBe('Set here')
    expect(sourceWords(marketSource, CATEGORY)).toBe('Inherited from the market')
    expect(sourceWords(categorySource, CATEGORY)).toBe('Set here')
    expect(sourceWords(categorySource, PRODUCT)).toBe('Inherited from the category Full face')
    expect(sourceWords({ level: 'product', scopeId: 'p-parent', label: 'TEST-HELMET (IT)', version: 1, strategyId: 's-p', via: 'parent' }, PRODUCT)).toBe('Inherited from its parent product TEST-HELMET')
    expect(sourceWords(null, MARKET)).toBeNull()
    expect(plainLabel('Full face (IT)')).toBe('Full face')
  })

  it('the line under a field: in force and from where, or what applies when nothing in the strategy does', () => {
    const target: FieldEntry = { field: 'target', label: 'Target', targetKind: 'ACOS', targetPct: 30, source: marketSource, readBy: [] }
    // Set here: the field shows its value; the line says nothing more unless something else binds beside it.
    expect(inForceLine('target', target, MARKET, 'EUR')).toBeNull()
    expect(inForceLine('target', target, CATEGORY, 'EUR')).toBe('Inherited from the market: ACoS 30 %.')
    const none: FieldEntry = { field: 'target', label: 'Target', targetKind: null, targetPct: null, source: null, readBy: [] }
    expect(inForceLine('target', none, MARKET, 'EUR')).toBe('Not set.')
    const maxBid: FieldEntry = { field: 'maxBidCents', label: 'Highest bid', maxBidCents: null, source: null, readBy: [], alsoInForce: [{ setting: "the market's bid policy", maxBidCents: 120 }] }
    expect(inForceLine('maxBidCents', maxBid, MARKET, 'EUR')).toBe("Not set in the strategy. Also in force: the market's bid policy, €1.20.")
    expect(inForceLine('stop', undefined, MARKET, 'EUR')).toBe("Not set: a stop lowers bids to Nexus's own floor (€0.02).")
    const bounded: FieldEntry = { ...maxBid, maxBidCents: 150, source: marketSource, stricter: { from: "the market's bid policy" } }
    expect(inForceLine('maxBidCents', bounded, MARKET, 'EUR')).toBe("Also in force: the market's bid policy, €1.20. The stricter one binds: the market's bid policy.")
    const harvest: FieldEntry = { field: 'harvest', label: 'Harvest', source: null, readBy: ['x'], alsoInForce: [{ setting: 'the harvest defaults (no harvest policy saved)', harvestMinOrders: 2, harvestMinClicks: 3, harvestMaxAcosPct: 45, harvestWindowDays: 60 }] }
    expect(inForceLine('harvest', harvest, MARKET, 'EUR')).toBe('Not set. In force today: the harvest defaults (no harvest policy saved): 2 orders · 3 clicks · ACoS at most 45 % · last 60 days.')
    expect(inForceLine('claudeAutonomy', undefined, MARKET, 'EUR')).toBeNull()
  })

  it('a monthly cap is never inherited: each scope\'s own cap binds on its own spend', () => {
    const cap: FieldEntry = { field: 'monthlySpendCapCents', label: 'Monthly spend cap', readBy: [], caps: [{ ...marketSource, monthlySpendCapCents: 500000 }] }
    expect(inForceLine('monthlySpendCapCents', cap, MARKET, 'EUR')).toBe("In force: €5,000.00 a month on this market's own spend.")
    expect(inForceLine('monthlySpendCapCents', cap, CATEGORY, 'EUR')).toBe("Not set: no monthly cap of its own. Also binds: the market's cap, €5,000.00 a month.")
  })

  it('who reads a field: the registry\'s readers, or "stored only" — never a reader the API did not list', () => {
    expect(readByWords([])).toEqual({ storedOnly: true, text: 'Stored only — no engine reads this yet', full: null })
    expect(readByWords(undefined).storedOnly).toBe(true)
    const read = readByWords(['harvest rules that set no thresholds of their own (harvest_and_negate)', 'recommendations (terms to graduate)'])
    expect(read).toEqual({
      storedOnly: false,
      text: 'Read by harvest rules that set no thresholds of their own; recommendations',
      full: 'harvest rules that set no thresholds of their own (harvest_and_negate) · recommendations (terms to graduate)',
    })
    // More than two: the first two by name, the rest counted; every one in full behind the info mark.
    expect(readByWords(['a: x', 'b (y)', 'c', 'd']).text).toBe('Read by a; b and 2 more')
  })
})

describe('the draft the API takes', () => {
  it('a stored row as text: money in the market\'s units, nothing set = empty', () => {
    const d = draftOf(row({ targetKind: 'ACOS', targetPct: 30, maxBidCents: 150, harvestMinOrders: 2, harvestMinClicks: 10, harvestWindowDays: 60, claudeAutonomy: { bid: 'ask' } }))
    expect(d).toMatchObject({ targetPct: '30', maxBid: '1.50', minBid: '', harvestMinOrders: '2', harvestWindowDays: '60', harvestMaxAcosPct: '', claude: { bid: 'ask' } })
    expect(draftOf(null)).toMatchObject({ goal: '', targetKind: 'ACOS', targetPct: '', protect: '' })
  })

  it('money typed with a dot or a comma; anything else is not a sum', () => {
    expect(moneyCents('1.50')).toBe(150)
    expect(moneyCents('1,5')).toBe(150)
    expect(moneyCents(' 1500 ')).toBe(150000)
    expect(moneyCents('')).toBeNull()
    expect(moneyCents('1.505')).toBeNaN()
    expect(moneyCents('abc')).toBeNaN()
  })

  it('only what changed is sent; empty clears it here (inherit); a raise and a lowering look the same to the screen', () => {
    const base = draftOf(row({ targetKind: 'ACOS', targetPct: 30, maxBidCents: 150 }))
    const lower = diffDraft({ ...base, maxBid: '1.20' }, base, 'MARKET', 'EUR')
    expect(lower).toEqual({ values: { maxBidCents: 120 }, changed: ['maxBidCents'], errors: {} })
    const cleared = diffDraft({ ...base, targetPct: '' }, base, 'MARKET', 'EUR')
    expect(cleared.values).toEqual({ target: null })
    expect(diffDraft({ ...base, targetKind: 'TACOS' }, base, 'MARKET', 'EUR').values).toEqual({ target: { kind: 'TACOS', pct: 30 } })
    expect(diffDraft(base, base, 'MARKET', 'EUR').changed).toEqual([])
    expect(diffDraft({ ...base, claude: { bid: 'ask', stop: 'off' } }, base, 'MARKET', 'EUR').values).toEqual({ claudeAutonomy: { bid: 'ask', stop: 'off' } })
  })

  it('a field this scope may not hold is never sent', () => {
    const base = draftOf(null)
    expect(diffDraft({ ...base, maxActionsPerRun: '50', protect: 'yes' }, base, 'MARKET', 'EUR').values).toEqual({ maxActionsPerRun: 50 })
    expect(diffDraft({ ...base, maxActionsPerRun: '50', protect: 'yes' }, base, 'CATEGORY', 'EUR').values).toEqual({ protect: true })
  })

  it('plain refusals before the API: ranges, half a group, a floor above the ceiling', () => {
    const base = draftOf(null)
    expect(diffDraft({ ...base, targetPct: '600' }, base, 'MARKET', 'EUR').errors).toEqual({ target: 'A whole percent from 1 to 500.' })
    expect(diffDraft({ ...base, harvestMinOrders: '2' }, base, 'MARKET', 'EUR').errors.harvest).toBe('Give the orders, the clicks and the days looked at — or leave them all empty.')
    expect(diffDraft({ ...base, minBid: '2', maxBid: '1' }, base, 'MARKET', 'EUR').errors.minBidCents).toBe('The lowest bid is above the highest bid: give one at or below it.')
    expect(diffDraft({ ...base, stopBid: '5' }, base, 'MARKET', 'EUR').errors.stop).toBe('From €0.02 to €1.00.')
    expect(diffDraft({ ...base, maxBid: '1.2.3' }, base, 'MARKET', 'EUR').errors.maxBidCents).toBe('A sum in EUR with at most 2 decimals, like 1.50.')
    // 0 goes to the API, which refuses it in its own words (shown at the field: below).
    expect(diffDraft({ ...base, monthlySpendCap: '0' }, base, 'MARKET', 'EUR')).toEqual({ values: { monthlySpendCapCents: 0 }, changed: ['monthlySpendCapCents'], errors: {} })
  })

  it('THE 0 CAP: the API\'s sentence lands on the cap field, without the column name', () => {
    expect(serverError("monthlySpendCapCents: 0 would mean 'no cap' (as on the Budget Manager); leave it empty for no cap, or use a stop for an immediate stop."))
      .toEqual({ field: 'monthlySpendCapCents', text: "0 would mean 'no cap' (as on the Budget Manager); leave it empty for no cap, or use a stop for an immediate stop." })
    expect(serverError('values.harvestMinOrders: Too small')).toEqual({ field: 'harvest', text: 'Too small' })
    expect(serverError('protect cannot be set on a market row (only on a category or product row).')).toEqual({ field: null, text: 'protect cannot be set on a market row (only on a category or product row).' })
  })
})

describe('the save: one table, the raise list, the counted button', () => {
  const changes: StrategyChange[] = [
    { field: 'maxBidCents', label: 'Highest bid (cents)', from: 150, to: 200, effectiveFrom: 150, effectiveTo: 200, direction: 'raise' },
    { field: 'target', label: 'Target', from: { targetKind: 'ACOS', targetPct: 30 }, to: null, effectiveFrom: { targetKind: 'ACOS', targetPct: 30 }, effectiveTo: { targetKind: 'ACOS', targetPct: 35 }, direction: 'raise' },
    { field: 'monthlySpendCapCents', label: 'Monthly spend cap (cents)', from: null, to: 400000, direction: 'lower' },
    { field: 'targetAcosPct', label: "Campaign's own target ACoS (%)", campaignId: 'c1', campaign: 'Test helmets', from: 28, to: null, direction: 'lower' },
  ]

  it('every row from → to in words, with inherited values named, and raise or lower', () => {
    expect(changeRows(changes, 'EUR').map(({ setting, now, next, effect, tone }) => ({ setting, now, next, effect, tone }))).toEqual([
      { setting: 'Highest bid', now: '€1.50', next: '€2.00', effect: 'Raises', tone: 'warning' },
      { setting: 'Target', now: 'ACoS 30 %', next: 'Not set (inherits ACoS 35 %)', effect: 'Raises', tone: 'warning' },
      { setting: 'Monthly spend cap', now: 'Not set', next: '€4,000.00 a month', effect: 'Lowers', tone: 'success' },
      { setting: 'Own target ACoS of “Test helmets”', now: '28 %', next: 'None: the strategy applies', effect: 'Lowers', tone: 'success' },
    ])
  })

  it('what it raises, as nouns, once each; lists read as a sentence', () => {
    expect(raiseList(changes)).toEqual(['the highest bid', 'the target'])
    expect(listWords(['a'])).toBe('a')
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c')
    expect(listWords(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
    expect(stepUpSentence(raiseList(changes), scopeWhat(MARKET, 'IT')))
      .toBe('This raises the highest bid and the target for the IT market strategy. Raising the strategy asks for the 6-digit code from your authenticator app; lowering it never does.')
    expect(stepUpSentence(['the highest bid'], scopeWhat(MARKET, 'IT'), true))
      .toBe('Undo puts a higher value back for the highest bid of the IT market strategy. Raising the strategy asks for the 6-digit code from your authenticator app; lowering it never does.')
  })

  it('what happens when it lands: what it covers, what binds at once and who reads it, what is stored only, Nexus only', () => {
    const lines = effectLines(changes, { maxBidCents: [], target: [], monthlySpendCapCents: [] }, 'IT', { campaigns: 9 })
    expect(lines).toEqual([
      'It covers the whole IT market: 9 campaigns.',
      'Highest bid, Target, Monthly spend cap: stored and shown only — no engine reads them yet, so no bid or budget moves.',
      "1 campaign loses its own target ACoS: Nexus's bid optimiser then aims at the account default, profit data or 30 % for it.",
      'Nexus only: nothing is sent to Amazon IT by this change.',
    ])
    const claude: StrategyChange = { field: 'claudeAutonomy', label: 'What Claude may do alone', from: null, to: { bid: 'ask' }, direction: 'lower' }
    expect(effectLines([claude], { claudeAutonomy: ["Claude's door (every ad change Claude asks for)"] }, 'IT', { campaigns: 2, products: 3 }).slice(0, 2)).toEqual([
      'It covers 3 products and the 2 campaigns in IT that advertise them.',
      "What Claude may do alone: binds at once — read by Claude's door.",
    ])
  })

  it('the button says what it does and how many; a raise says it asks for the code; no permission holds it with why', () => {
    expect(saveButtonWords({ changes: 1, raises: 0, mayRaise: false })).toEqual({ label: 'Save 1 change', disabled: false, why: null })
    expect(saveButtonWords({ changes: 4, raises: 2, mayRaise: true })).toEqual({ label: 'Save 4 changes with your code…', disabled: false, why: null })
    expect(saveButtonWords({ changes: 4, raises: 2, mayRaise: false })).toMatchObject({ label: 'Save 4 changes', disabled: true, why: expect.stringContaining('settings.security.manage') })
  })

  it('the sticky bar: problems first, then checking, then what saving does', () => {
    expect(barWords({ changes: 2, problems: 1, checking: false, raises: null, clears: 0 })).toBe('2 unsaved changes · 1 problem to fix first')
    expect(barWords({ changes: 2, problems: 0, checking: true, raises: null, clears: 0 })).toBe('2 unsaved changes · checking…')
    expect(barWords({ changes: 1, problems: 0, checking: false, raises: [], clears: 0 })).toBe('1 unsaved change · lowers or keeps every limit')
    expect(barWords({ changes: 1, problems: 0, checking: false, raises: ['the highest bid'], clears: 2 }))
      .toBe("1 unsaved change · clears 2 campaigns' own targets · raises the highest bid: saving asks for your code")
  })

  it('leaving unsaved edits asks first, with a confirmation the design system accepts', () => {
    const impact = leaveImpact(3, scopeWhat(CATEGORY, 'IT'))
    expect(impact.title).toBe('Drop 3 unsaved changes?')
    expect(impact.consequences).toEqual(['Your changes to the strategy for Full face (category, IT) are not saved and will be dropped. Nothing was sent anywhere.'])
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })
})

describe('what Claude may do alone', () => {
  const entry = (over: Partial<ClaudeEntry> = {}): ClaudeEntry => ({
    action: 'bid', tools: [{ tool: 'set-target-bid', business: 'confirm', effective: 'confirm' }, { tool: 'bulk-ad-bid-change', business: 'ask', effective: 'ask' }],
    strategy: null, source: null, ...over,
  })

  it('the lower of your rule and the strategy, per tool; the strategy never widens', () => {
    expect(claudeRow(entry(), '', MARKET)).toEqual({ rule: 'Confirm · Ask', inherited: null, inheritedLevel: null, result: 'Confirm · Ask', noEffect: false })
    expect(claudeRow(entry(), 'ask', MARKET)).toEqual({ rule: 'Confirm · Ask', inherited: null, inheritedLevel: null, result: 'Ask', noEffect: false })
    expect(claudeRow(entry(), 'auto', MARKET)).toMatchObject({ result: 'Confirm · Ask', noEffect: true })
  })

  it('a category inherits the market\'s level until it sets its own', () => {
    const inherited = entry({ strategy: 'off', source: marketSource })
    expect(claudeRow(inherited, '', CATEGORY)).toMatchObject({ inherited: 'Inherited from the market: Off', inheritedLevel: 'off', result: 'Off' })
    expect(claudeRow(inherited, 'ask', CATEGORY)).toMatchObject({ result: 'Ask' })
  })
})

describe('the list of categories and products, and adding one', () => {
  it('a row in a few words', () => {
    expect(rowSummary(row({ goal: 'LAUNCH', targetKind: 'ACOS', targetPct: 45, maxBidCents: 200, reviewEveryDays: 7 }), 'EUR')).toBe('Launch · ACoS 45 % · bids up to €2.00 · 1 more setting')
    expect(rowSummary(row(), 'EUR')).toBe('Nothing set yet')
  })

  it('every category by its path; one with a row here is shown and held', () => {
    const tree = [{ id: 'h', name: { en: 'Helmets', it: 'Caschi' }, slug: 'helmets', isActive: true, children: [
      { id: 'ff', name: { en: 'Full face' }, slug: 'full-face', isActive: true, children: [] },
      { id: 'old', name: {}, slug: 'old-line', isActive: false, children: [] },
    ] }]
    expect(categoryChoices(tree, new Set(['ff']))).toEqual([
      { value: 'h', label: 'Helmets' },
      { value: 'ff', label: 'Helmets › Full face', disabled: true, trailing: 'has a strategy here' },
      { value: 'old', label: 'Helmets › old-line', trailing: 'inactive' },
    ])
  })
})

describe('the history', () => {
  const version = (changes: HistoryVersion['changes']): HistoryVersion => ({
    strategyId: 's-m', level: 'MARKET', scopeId: '*', version: 4, op: 'set', direction: 'raise', via: 'screen', actor: 'Test Owner',
    stepUpAt: '2026-10-06T08:01:00Z', reason: null, at: '2026-10-06T08:01:00Z', changes,
  })

  it('who, how and what, from → to; amounts hidden from a person who may not see ad spend say so', () => {
    const out = historyLine(version([{ field: 'maxBidCents', direction: 'raise', maxBidCents: { from: 150, to: 200, effectiveFrom: 150, effectiveTo: 200 } }]), 'EUR')
    expect(out.head).toMatch(/^Version 4 · .+ · Test Owner \(on this screen, with code\)$/)
    expect(out.changes).toEqual(['Highest bid: €1.50 → €2.00 (raise)'])
    expect(historyLine(version([{ field: 'maxBidCents', direction: 'raise' }]), 'EUR').changes).toEqual(['Highest bid: changed, amounts hidden (raise)'])
  })
})
