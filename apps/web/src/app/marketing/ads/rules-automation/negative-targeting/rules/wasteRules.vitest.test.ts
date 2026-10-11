/**
 * Negative Targeting page, Rules view (2026-10-11) — the pure rules of the table, the draft, the waiting asks, the new
 * rule and its fields. Names and numbers are made up.
 */
import { describe, expect, it } from 'vitest'
import {
  autoLockOf, changeFromTo, heldStep, isPseudo, last7Parts, last7Tab, last7Text, modeLock, negativeWord, ownerOf, partHolds, previewParts, refusalWhy,
  rowMatchesSearch, scopeCount, sharedWhy, scopeLevel, scopePath, scopeText, visibleRows, waitingAsksOf, waitingGap, whoWord,
  type WaitingRow, type WasteRuleRow,
} from './wasteRulesModel'
import {
  archiveReviewChanges, bulkMisfit, canStop, modeConflicts, modeGroups, modeReviewChanges, modeUndoLabel, pickMode, pickModeFor, retidyModes, waitsOf,
  shownMode, unarchiveReviewChanges,
} from './wasteRuleChanges'
import {
  WHOLE_MARKET, bodyOf, fieldProblems, fieldsOfSaved, fieldsOfStarter, fieldsPatch, fieldsReviewChanges, marketsOf, newRuleReviewChange, pathOfPick,
  scopeOfPick, scopeOptions, testWords, verbWords, type ScopeData, type Starter,
} from './newRuleModel'

const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })
const mode = (set: 'OFF' | 'WATCH' | 'ASK' | 'AUTO', extra: Partial<WasteRuleRow['mode']> = {}): WasteRuleRow['mode'] => ({ set, acts: set, heldBy: null, also: [], autoLocked: null, ...extra })

function rule(over: Partial<WasteRuleRow> = {}): WasteRuleRow {
  return {
    id: 'r1', kind: 'NEGATE_TERM', source: 'rule', readOnly: false, name: 'Stop waste — terms', sentence: 'Search terms: 0 orders → negative exact',
    market: 'IT', mode: mode('WATCH'), test: { kind: 'NEGATE_TERM', windowDays: 60, minClicks: 20, cpaMultiple: 1.5, spendFloorCents: 1500 },
    scope: { portfolios: [ref('pf1', 'Boots IT')], campaigns: [ref('c1', 'Boots Auto')], adGroups: [], counts: { portfolios: 1, campaigns: 1, adGroups: 0 }, all: false, product: null, adGroup: null },
    changed7d: { portfolios: [], campaigns: [], adGroups: [], paused: 0, negated: 0 },
    last7d: { runs: 0, asks: 0, applied: 0, written: 0, refused: 0, askedByCaps: 0 },
    waiting: 0, lastRunAt: null, nextRunAt: null, archived: false,
    ...over,
  }
}
const brain = () => rule({ id: 'brain', source: 'brain', readOnly: true, name: 'Brain (negatives)' })
const harvest = () => rule({ id: 'harvest', source: 'harvest', readOnly: true, name: 'Harvest (source negatives)' })

describe('owners and locks', () => {
  it('the Brain and Harvest are read only and say who owns them', () => {
    expect(isPseudo(brain())).toBe(true)
    expect(ownerOf(brain())?.word).toBe('Brain')
    expect(ownerOf(harvest())?.word).toBe('Harvest')
    expect(ownerOf(rule())).toBeNull()
    expect(modeLock(harvest())).toMatch(/Harvest owns/)
    expect(modeLock(rule({ archived: true }))).toMatch(/unarchive/)
    expect(modeLock(rule(), 'Needs the ads automation permission')).toBe('Needs the ads automation permission')
    expect(modeLock(rule())).toBeNull()
  })

  it('Auto is held with the API reason, and from Off the next step is said', () => {
    const locked = rule({ mode: mode('ASK', { autoLocked: { kind: 'graduation', label: 'Auto from 25 Oct', reason: 'A new rule first runs 14 days.' } }) })
    expect(heldStep(locked, 'AUTO')).toBe('A new rule first runs 14 days.')
    expect(heldStep(locked, 'ASK')).toBeNull()
    expect(heldStep({ mode: mode('OFF', { autoLocked: { kind: 'g', label: 'x' } }) }, 'AUTO')).toBe('Pick Watch or Ask me first')
    expect(autoLockOf(locked)?.label).toBe('Auto from 25 Oct')
    expect(autoLockOf({ ...locked, archived: true })).toBeNull()
    expect(autoLockOf({ ...locked, source: 'brain', readOnly: true })).toBeNull()
    expect(autoLockOf(rule({ mode: mode('ASK', { autoLocked: { kind: 'gate', label: 'Amazon test mode' } }) }))?.label).toBe('Auto: Amazon test mode')
    expect(autoLockOf(rule({ mode: mode('ASK', { autoLocked: { kind: 'graduation', label: 'Always asks' } }) }))?.label).toBe('Asks first')
  })

  it('part holds show only while it acts as set', () => {
    const also = [{ kind: 'allowlist', label: '2 campaigns locked' }]
    expect(partHolds(mode('ASK', { also }))).toHaveLength(1)
    expect(partHolds(mode('ASK', { acts: 'WATCH', also }))).toHaveLength(0)
  })
})

describe('scope: market › portfolio › campaign › ad group', () => {
  it('one ad group: the whole path down to it', () => {
    const r = rule({ scope: { ...rule().scope, adGroup: ref('g1', 'Auto group'), adGroups: [ref('g1', 'Auto group')], counts: { portfolios: 1, campaigns: 1, adGroups: 1 } } })
    expect(scopeLevel(r)).toBe('adGroup')
    expect(scopePath(r).map((s) => s.name)).toEqual(['IT', 'Boots IT', 'Boots Auto', 'Auto group'])
    expect(scopeCount(r)).toBe(0)
  })

  it('one campaign; a portfolio of several campaigns says how many', () => {
    expect(scopePath(rule()).map((s) => s.name)).toEqual(['IT', 'Boots IT', 'Boots Auto'])
    const pf = rule({ scope: { ...rule().scope, campaigns: [ref('c1'), ref('c2')], counts: { portfolios: 1, campaigns: 4, adGroups: 0 } } })
    expect(scopeLevel(pf)).toBe('portfolio')
    expect(scopePath(pf).map((s) => s.name)).toEqual(['IT', 'Boots IT'])
    expect(scopeCount(pf)).toBe(4)
    expect(scopeText(pf)).toBe('IT › Boots IT · 4 campaigns')
  })

  it('the whole market, every market, a product', () => {
    const whole = rule({ scope: { ...rule().scope, all: true, portfolios: [ref('a'), ref('b')], campaigns: [ref('c1'), ref('c2')], counts: { portfolios: 2, campaigns: 150, adGroups: 0 } } })
    expect(scopePath(whole).map((s) => s.name)).toEqual(['IT'])
    expect(scopeText(whole)).toBe('IT · whole market · 150 campaigns')
    expect(scopeLevel({ ...whole, market: null })).toBe('account')
    expect(scopePath({ ...whole, market: null })[0].name).toBe('All markets')
    const prod = rule({ scope: { ...rule().scope, product: ref('p1', 'BOOT-1') } })
    expect(scopePath(prod).map((s) => s.name)).toEqual(['IT', 'BOOT-1'])
  })

  it('the market step is never a link', () => {
    expect(scopePath(rule())[0].href).toBeUndefined()
  })
})

describe('last 7 days', () => {
  it('chips: paused and negatives open History, asks open Waiting, refusals warn', () => {
    const r = rule({ changed7d: { ...rule().changed7d, paused: 2, negated: 1 }, last7d: { runs: 3, asks: 1, applied: 0, written: 3, refused: 1, askedByCaps: 0 } })
    expect(last7Parts(r).map((p) => [p.text, p.tab ?? p.tone])).toEqual([['2 paused', 'history'], ['1 negative', 'history'], ['1 asked', 'waiting'], ['1 refused', 'warning']])
    expect(last7Text(r)).toBe('2 paused · 1 negative · 1 asked · 1 refused · 3 runs')
    expect(last7Text(rule({ last7d: { ...r.last7d, asks: 0, refused: 0, runs: 2 }, changed7d: rule().changed7d }))).toBe('2 runs, nothing stopped')
    expect(last7Text(rule())).toBe('No runs')
  })

  it('Enter goes to the asks while some wait', () => {
    expect(last7Tab(rule({ waiting: 2 }))).toBe('waiting')
    expect(last7Tab(rule({ changed7d: { ...rule().changed7d, negated: 1 } }))).toBe('history')
    expect(last7Tab(rule())).toBe('overview')
  })
})

describe('search and archived', () => {
  const rows = [brain(), harvest(), rule(), rule({ id: 'r2', name: 'Old one', archived: true })]
  it('the Brain and Harvest stay on top of the active list, never in Archived', () => {
    expect(visibleRows(rows, { search: '', archived: false }).map((r) => r.id)).toEqual(['brain', 'harvest', 'r1'])
    expect(visibleRows(rows, { search: '', archived: true }).map((r) => r.id)).toEqual(['r2'])
  })
  it('search reads the name, the sentence and the places, without accents', () => {
    expect(rowMatchesSearch(rule(), 'boots auto')).toBe(true)
    expect(rowMatchesSearch(rule({ name: 'Già fatto' }), 'gia')).toBe(true)
    expect(rowMatchesSearch(rule(), 'jacket')).toBe(false)
    expect(visibleRows(rows, { search: 'harvest', archived: false }).map((r) => r.id)).toEqual(['harvest'])
  })
})

describe('history and preview words', () => {
  it('a change as before → after', () => {
    expect(changeFromTo({ action: 'paused', from: 'ENABLED', to: 'PAUSED', match: null, level: null })).toEqual({ what: 'State', from: 'On', to: 'Paused' })
    expect(changeFromTo({ action: 'negated', from: null, to: null, match: 'NEGATIVE_PHRASE', level: 'CAMPAIGN' })).toEqual({ what: 'Negative', from: '—', to: 'Negative phrase · campaign' })
    expect(changeFromTo({ action: 'removed', from: null, to: null, match: 'EXACT', level: null }).to).toBe('Removed')
    expect(negativeWord(null)).toBe('Negative exact')
  })
  it('who made it, only when it is not this row', () => {
    const c = (kind: 'rule' | 'brain' | 'harvest' | 'person', id: string | null, name = '') => ({ who: { kind, id, name } })
    expect(whoWord(c('rule', 'r1', 'A'), 'r1')).toBeNull()
    expect(whoWord(c('rule', 'r9', 'Other'), 'r1')).toBe('Other')
    expect(whoWord(c('person', null), 'r1')).toBe('You')
    expect(whoWord(c('brain', 'brain'), 'brain')).toBeNull()
    expect(whoWord(c('harvest', null), 'r1')).toBe('Harvest')
  })
  it('preview chips and refusal words', () => {
    expect(previewParts({ wouldChange: 5, wouldAsk: 1, refused: [{ row: ref('x'), why: 'y' }] }).map((p) => p.text)).toEqual(['5 would change', '1 would ask', '1 refused'])
    expect(refusalWhy('source-ad-group-not-in-mappings')).toBe('Source ad group not in mappings')
    expect(refusalWhy('Refused by a guard: it sold.')).toBe('Refused by a guard: it sold.')
    const same = { why: 'Its trigger and conditions match now (its own window)' }
    expect(sharedWhy([same, same])).toBe('Passes its test now')
    expect(sharedWhy([same, { why: 'other' }])).toBeNull()
    expect(sharedWhy([same])).toBeNull()
  })
})

describe('waiting asks', () => {
  const w = (id: string, approvalId: string, by: string, at: string, group = 'g1'): WaitingRow => ({
    id, kind: 'TERM', text: id, match: 'BROAD', currency: 'EUR', portfolio: null, campaign: ref('c1'), adGroup: ref(group),
    product: null, verb: { action: 'NEGATE_EXACT', where: 'campaign', held: null }, d: { clicks: 40, orders: 0, spendCents: 2000 },
    waiting: { approvalId, by: { id: by, name: by }, at, expiresAt: null },
  })
  it('one ask per approval, the rule\'s own, oldest first; a card over two ad groups is one decision', () => {
    const rows = [w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z'), w('kids2', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z', 'g2'), w('pink', 'a2', 'r1', '2026-10-01T00:00:00Z'), w('sandal', 'a3', 'brain', '2026-10-01T00:00:00Z')]
    const asks = waitingAsksOf(rows, 'r1')
    expect(asks.map((a) => [a.approvalId, a.rows.length])).toEqual([['a2', 1], ['suggestion:k', 2]])
    expect(waitingAsksOf(rows, 'brain').map((a) => a.approvalId)).toEqual(['a3'])
    expect(waitingGap(4, asks)).toBe(2)
    expect(waitingGap(1, asks)).toBe(0)
  })
  it('as the page\'s one decide review takes them: one line per ask, places said, the path as links', () => {
    const rows = [w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z'), w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z', 'g2'), w('pink', 'a2', 'r1', '2026-10-01T00:00:00Z')]
    const waits = waitsOf(waitingAsksOf(rows, 'r1'))
    expect(waits.map((x) => [x.approvalId, x.text, x.what, x.by])).toEqual([['a2', 'pink', 'Negative exact · campaign', 'r1'], ['suggestion:k', 'kids · 2 places', 'Negative exact · campaign', 'r1']])
    expect(waits[0].place?.map((p) => p?.id ?? null)).toEqual([null, 'c1', 'g1'])
  })
})

describe('the mode draft', () => {
  const rows = new Map([brain(), rule(), rule({ id: 'r2', mode: mode('ASK') }), rule({ id: 'r3', archived: true })].map((r) => [r.id, r]))
  it('never drafts the Brain, Harvest or an archived rule; a pick back drops it', () => {
    let d = pickModeFor({}, [...rows.values()], 'ASK')
    expect(Object.keys(d)).toEqual(['r1'])
    d = pickMode(d, rows.get('r1')!, 'WATCH')
    expect(d).toEqual({})
  })
  it('a pick that lets it stop things ticks; Off → Watch does not', () => {
    expect(canStop('OFF', 'WATCH')).toBe(false)
    expect(canStop('WATCH', 'ASK')).toBe(true)
    expect(canStop('AUTO', 'ASK')).toBe(false)
    const lines = modeReviewChanges({ r1: 'AUTO', r2: 'OFF' }, rows)
    expect(lines.map((l) => [l.id, l.now, l.next, !!l.raise, l.note])).toEqual([['r1', 'Watch', 'Auto', true, 'Acts alone, inside its caps'], ['r2', 'Ask me', 'Off', false, undefined]])
  })
  it('Undo says what it does', () => {
    expect(modeUndoLabel({ a: 'ASK' })).toBe('Undo: back to Ask me')
    expect(modeUndoLabel({ a: 'ASK', b: 'OFF' })).toBe('Undo: put 2 back')
  })
  it('grouped per mode for the one route; conflicts and retidy after a re-read', () => {
    expect(modeGroups({ a: 'ASK', b: 'OFF', c: 'ASK' })).toEqual([{ mode: 'ASK', ids: ['a', 'c'] }, { mode: 'OFF', ids: ['b'] }])
    const fresh = new Map(rows)
    fresh.set('r1', rule({ mode: mode('ASK') }))
    expect(modeConflicts({ r1: 'AUTO' }, rows, fresh)).toEqual([{ label: 'Stop waste — terms', was: 'Watch', now: 'Ask me' }])
    expect(retidyModes({ r1: 'ASK' }, fresh)).toEqual({})
    expect(shownMode(rule(), { r1: 'AUTO' })).toMatchObject({ set: 'AUTO', acts: 'AUTO', heldBy: null })
  })
  it('archive and unarchive lines; a bulk verb says what does not fit', () => {
    expect(archiveReviewChanges([brain(), rule({ waiting: 2 })])).toEqual([{ id: 'r1', where: 'Stop waste — terms', what: 'Rule', now: 'Watch', next: 'Archived', note: '2 waiting asks expire' }])
    expect(unarchiveReviewChanges([rule({ archived: true })])[0]).toMatchObject({ now: 'Archived', next: 'Off' })
    expect(bulkMisfit([rule(), rule({ id: 'x', archived: true })], 'archive')).toBe('1 archived')
    expect(bulkMisfit([rule({ archived: true })], 'unarchive')).toBeNull()
  })
})

describe('a new rule and its fields', () => {
  const starter: Starter = { id: 's', kind: 'NEGATE_TERM', name: 'Stop waste — search terms', windowDays: 60, minClicks: 20, cpaMultiple: 1.5, spendFloorCents: 1500, match: 'EXACT', level: 'AD_GROUP', says: '…' }
  it('starts from the starter; the body the API takes', () => {
    const f = fieldsOfStarter(starter)
    expect(f).toMatchObject({ windowDays: 60, minClicks: 20, cpaMultiple: 1.5, spendFloorCents: 1500, match: 'EXACT', level: 'AD_GROUP', runAt: '06:00' })
    expect(bodyOf('NEGATE_TERM', f, { marketplace: 'IT', adGroupId: 'g1', campaignId: 'c1' })).toEqual({
      kind: 'NEGATE_TERM', name: 'Stop waste — search terms', scope: { marketplace: 'IT', adGroupId: 'g1', campaignId: 'c1' },
      windowDays: 60, minClicks: 20, cpaMultiple: 1.5, spendFloorCents: 1500, match: 'EXACT', level: 'AD_GROUP', runAt: '06:00',
    })
    const pause = bodyOf('PAUSE_KEYWORD', { ...f, spendFloorCents: null }, null)
    expect(pause).not.toHaveProperty('match')
    expect(pause).not.toHaveProperty('spendFloorCents')
  })
  it('the API\'s bounds', () => {
    const f = fieldsOfStarter(starter)
    expect(fieldProblems(f)).toEqual({})
    expect(Object.keys(fieldProblems({ ...f, windowDays: 7, minClicks: 0, cpaMultiple: 20, runAt: '25:00', name: ' ' }))).toEqual(['name', 'windowDays', 'minClicks', 'cpaMultiple', 'runAt'])
  })
  it('a saved rule\'s verb and run time come from its stored action; the patch holds only what changed', () => {
    const saved = fieldsOfSaved({ name: 'A', test: { windowDays: 30, minClicks: 10, cpaMultiple: 2 } }, [{ type: 'add_negative_phrase', scope: 'CAMPAIGN', schedule: { time: '07:30' } }])
    expect(saved).toMatchObject({ match: 'PHRASE', level: 'CAMPAIGN', runAt: '07:30', spendFloorCents: null })
    expect(fieldsPatch('NEGATE_TERM', saved, { ...saved, minClicks: 15, match: 'EXACT' })).toEqual({ minClicks: 15, match: 'EXACT' })
    expect(fieldsPatch('PAUSE_KEYWORD', saved, { ...saved, match: 'EXACT' })).toEqual({})
    const lines = fieldsReviewChanges('NEGATE_TERM', saved, { ...saved, minClicks: 15, level: 'AD_GROUP' }, () => '—', 'A')
    expect(lines.map((l) => [l.what, l.now, l.next])).toEqual([['Clicks at least', '10', '15'], ['Does', 'Negative phrase · campaign', 'Negative phrase · ad group']])
  })
  it('words', () => {
    expect(verbWords('PAUSE_KEYWORD', { match: 'EXACT', level: 'AD_GROUP' })).toBe('Pause · keep paused')
    expect(testWords({ windowDays: 60, minClicks: 20, cpaMultiple: 1.5 })).toEqual(['0 orders', '≥ 20 clicks', '≥ 1.5× CPA', '60 d'])
    const line = newRuleReviewChange({ kind: 'PAUSE_KEYWORD', fields: fieldsOfStarter({ ...starter, kind: 'PAUSE_KEYWORD', name: 'K' }), where: 'IT', mode: 'ASK', wouldChange: 3 })
    expect(line).toMatchObject({ what: 'K · Pause · keep paused', now: '—', next: 'Ask me', raise: true, note: '3 keywords now' })
    expect(newRuleReviewChange({ kind: 'NEGATE_TERM', fields: fieldsOfStarter(starter), where: 'IT', mode: 'WATCH', wouldChange: 0 })).toMatchObject({ raise: false, note: 'Nothing would change now' })
  })

  const data: ScopeData = {
    campaigns: [
      { id: 'c1', name: 'Boots Auto', marketplace: 'IT', portfolioId: 'pf1', status: 'ENABLED' },
      { id: 'c2', name: 'Boots Old', marketplace: 'IT', portfolioId: 'pf1', status: 'ARCHIVED' },
      { id: 'c3', name: 'Stiefel', marketplace: 'DE', portfolioId: null, status: 'PAUSED' },
    ],
    portfolios: [{ externalPortfolioId: 'pf1', name: 'Boots IT' }, { externalPortfolioId: 'pf9', name: 'Elsewhere' }],
    adGroups: [
      { id: 'g1', name: 'Auto group', status: 'ENABLED', campaignId: 'c1', campaignName: 'Boots Auto', campaignStatus: 'ENABLED', marketplace: 'IT', portfolioId: 'pf1' },
      { id: 'g2', name: 'Old group', status: 'ENABLED', campaignId: 'c2', campaignName: 'Boots Old', campaignStatus: 'ARCHIVED', marketplace: 'IT', portfolioId: 'pf1' },
    ],
  }
  it('the places of one market, grouped; archived ones left out', () => {
    expect(marketsOf(data)).toEqual(['DE', 'IT'])
    expect(scopeOptions(data, 'IT').map((o) => [o.value, o.group])).toEqual([['m', 'Market'], ['p:pf1', 'Portfolio'], ['c:c1', 'Campaign'], ['g:g1', 'Ad group']])
    expect(scopeOptions(data, 'DE').find((o) => o.value === 'c:c3')?.note).toBe('Paused')
    // the search reads the ad group's own name and its campaign's
    expect(scopeOptions(data, 'IT').find((o) => o.value === 'g:g1')?.searchText).toBe('Auto group Boots Auto')
  })
  it('a pick as the API\'s scope and as a path', () => {
    expect(scopeOfPick(data, 'IT', WHOLE_MARKET)).toEqual({ marketplace: 'IT' })
    expect(scopeOfPick(data, 'IT', 'p:pf1')).toEqual({ marketplace: 'IT', portfolioId: 'pf1' })
    expect(scopeOfPick(data, 'IT', 'g:g1')).toEqual({ marketplace: 'IT', campaignId: 'c1', adGroupId: 'g1' })
    expect(scopeOfPick(data, 'IT', 'g:nope')).toBeNull()
    expect(scopeOfPick(data, '', 'm')).toBeNull()
    expect(pathOfPick(data, 'IT', 'g:g1').map((s) => s.name)).toEqual(['IT', 'Boots IT', 'Boots Auto', 'Auto group'])
    expect(pathOfPick(data, 'IT', 'g:g1')[3].href).toBe('/marketing/ads/campaigns/c1/ad-groups/g1')
  })
})
