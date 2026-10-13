import { describe, expect, it } from 'vitest'
import type { BidRuleRow } from '../../bid/rules/bidRulesModel'
import type { HistoryRow } from '../_shared/types'
import {
  autoCapWords, autoMeans, blocksWord, canAddKeywords, destinationWords, effectByRule, effectParts, effectScore,
  effectText, harvestLast7Parts, harvestLast7Tab, harvestLast7Text, harvestRaiseAck, harvestStatusView, harvestSteps, harvestUndoView,
  historyStateView, isHeld, isRulesShow, keywords7d, plainStale, rowMatchesSearch, rowMatchesShow, rulesViewTotals, verdictView,
  visibleHarvestRows, RULES_SHOWS,
} from './harvestRulesModel'
import { UNARCHIVED_AT_OFF, archiveUndoResult, harvestModeReviewChanges, isHarvestBuilderRule, levelBefore, modeable, undoModeBody, modeBase, needsAutoAgain, pickHarvestMode, retidyHarvestModes, shownHarvestMode } from './harvestRuleChanges'
import { latestRead } from '../../../_shared/latestRead'

const ref = (id: string, name = id) => ({ id, name, href: `/marketing/ads/campaigns/${id}` })

function row(over: Partial<BidRuleRow> = {}): BidRuleRow {
  return {
    id: 'r1', kind: 'rule', name: 'Harvest winners', sentence: 'If orders ≥ 2 over 30 d → keyword + block the source', market: 'IT',
    mode: { set: 'ASK', acts: 'ASK', heldBy: null, also: [], autoLocked: null },
    scope: { portfolios: [], campaigns: [ref('c1', 'Jacket Auto')], adGroups: [], all: false, product: null, counts: { portfolios: 0, campaigns: 1, adGroups: 0 } },
    changed7d: { portfolios: [], campaigns: [], adGroups: [], bids: 0, keywords: 0 },
    last7d: { runs: 0, asks: 0, applied: 0, written: 0, brainInputs: 0, refused: 0 },
    waiting: 0, lastRunAt: null, nextRunAt: null, effect: null, archived: false,
    ...over,
  }
}
const brain = row({ id: 'brain', kind: 'brain', name: 'Brain', sentence: 'Harvests each product it runs', mode: { set: 'WATCH', acts: 'WATCH', heldBy: null, also: [], autoLocked: null } })
const OFF = { set: 'OFF' as const, acts: 'OFF' as const, heldBy: null, also: [], autoLocked: null }

function hist(over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    harvestId: 'h1', candidateId: 'IT|p1|jacket', term: 'jacket', market: 'IT', product: ref('p1', 'Jacket'), at: '2026-10-01T10:00:00.000Z',
    by: { kind: 'RULE', id: 'r1', name: 'Harvest winners' }, changeSetId: 'a1', match: 'EXACT', status: 'DONE',
    destination: { portfolio: null, campaign: ref('c2', 'Jacket Exact'), adGroup: ref('g2', 'Exact group') }, keyword: ref('k1', 'jacket'),
    sources: [{ adGroup: ref('g1', 'Auto group'), result: 'Live', action: 'negate' }, { adGroup: ref('g3', 'Broad group'), result: null, action: 'standing' }],
    funnel: [{ adGroup: ref('g4', 'Phrase group'), match: 'NEGATIVE_EXACT', result: 'landed', action: 'negate' }],
    judge: { verdict: null, judgeAfter: null, judgedAt: null, why: null }, undo: { available: true, why: null },
    ...over,
  }
}

describe('harvest rule words', () => {
  it('Auto names the Owner’s D2 caps, with the server’s number once read', () => {
    // One cap wording (re-audit N-S6): its number once read, never a placeholder that changes.
    expect(autoCapWords(10)).toBe('On Auto: ≤ 10 keywords a day · own campaigns')
    expect(autoCapWords(1)).toBe('On Auto: ≤ 1 keyword a day · own campaigns')
    expect(autoCapWords(null)).toBeNull()
    expect(autoMeans(10)).toBe('Harvests by itself, inside its caps.')
    expect(harvestSteps(5).map((s) => s.label)).toEqual(['Off', 'Watch', 'Ask me', 'Auto'])
    expect(harvestSteps(5)[3].note).toBe('Harvests by itself, inside its caps.')
    expect(harvestSteps(5)[1].note).toBe('Shows what it would add.')
  })

  it('a raise is Ask me or Auto upward; Watch adds nothing', () => {
    expect(canAddKeywords('OFF', 'WATCH')).toBe(false)
    expect(canAddKeywords('WATCH', 'ASK')).toBe(true)
    expect(canAddKeywords('ASK', 'AUTO')).toBe(true)
    expect(canAddKeywords('AUTO', 'ASK')).toBe(false)
    expect(harvestRaiseAck(2)).toContain('these 2 rules can add keywords')
  })

  it('Last 7 d counts keywords, not bids; chips open History or the asks', () => {
    const r = row({ changed7d: { ...row().changed7d, keywords: 3, bids: 0 }, last7d: { runs: 5, asks: 2, applied: 1, written: 3, brainInputs: 0, refused: 1 } })
    expect(harvestLast7Parts(r).map((p) => p.text)).toEqual(['3 keywords', '2 asked', '1 applied', '1 refused'])
    expect(harvestLast7Parts(r).map((p) => p.tab ?? null)).toEqual(['history', 'waiting', 'history', null])
    expect(harvestLast7Text(r)).toBe('3 keywords · 2 asked · 1 applied · 1 refused · 5 runs')
    expect(harvestLast7Text(row({ last7d: { ...row().last7d, runs: 2 } }))).toBe('2 runs, nothing harvested')
    expect(harvestLast7Text(row())).toBe('No runs')
    expect(harvestLast7Tab(row({ waiting: 1 }))).toBe('waiting')
    expect(harvestLast7Tab(r)).toBe('history')
    expect(harvestLast7Tab(row())).toBe('overview')
    // The brain's landed writes count when its keyword list is empty.
    expect(keywords7d({ ...brain, last7d: { ...brain.last7d, written: 2 } })).toBe(2)
    expect(keywords7d(row({ last7d: { ...row().last7d, written: 4 } }))).toBe(0)
  })
})

describe('tiles and the rows they show (audit M1: one predicate)', () => {
  const rows = [
    brain,
    row({ id: 'a', waiting: 2 }),
    row({ id: 'b', mode: OFF }),
    row({ id: 'c', changed7d: { ...row().changed7d, keywords: 4 }, mode: { set: 'AUTO', acts: 'WATCH', heldBy: { kind: 'server', label: 'Server: no changes', reason: 'x' }, also: [], autoLocked: null } }),
    row({ id: 'd', archived: true, waiting: 5 }),
  ]
  it('counts the Bid way (audit M6): rules and "Rules on" leave the brain out; keywords and asks are sums', () => {
    const t = rulesViewTotals(rows, 1)
    expect(t).toMatchObject({ rules: 3, on: 2, keywords7d: 4, asks: 2, held: 1, archived: 1, otherMarkets: 1 })
    expect(t.tiles.map((x) => [x.id, x.label, x.value])).toEqual([
      ['on', 'Rules on', 2], ['harvested', 'Keywords · 7 d', 4], ['asks', 'Waiting for you', 2], ['held', 'Held back', 1],
    ])
    // The brain's own asks count with the rules' (one "Waiting for you").
    expect(rulesViewTotals([{ ...brain, waiting: 3 }, row({ waiting: 1 })]).asks).toBe(4)
  })
  it('a tile that counts rules shows exactly that many rules (the brain row shows, uncounted)', () => {
    const t = rulesViewTotals(rows)
    for (const id of ['on', 'held'] as const) {
      expect(visibleHarvestRows(rows, { show: id, search: '', archived: false }).filter((r) => r.kind !== 'brain')).toHaveLength(t.tiles.find((x) => x.id === id)!.value)
    }
    expect(visibleHarvestRows(rows, { show: 'harvested', search: '', archived: false }).map((r) => r.id)).toEqual(['c'])
    expect(visibleHarvestRows(rows, { show: 'asks', search: '', archived: false }).map((r) => r.id)).toEqual(['a'])
    expect(visibleHarvestRows(rows, { show: null, search: '', archived: true }).map((r) => r.id)).toEqual(['d'])
  })
  it('a tile with nothing to show does not filter', () => {
    expect(rulesViewTotals([row()]).tiles.find((x) => x.id === 'asks')!.filters).toBe(false)
  })
  it('held back: a hold on the rule as a whole — the API’s own count (functional walk NICE); part of its campaigns is its shield', () => {
    expect(isHeld(row({ mode: { set: 'ASK', acts: 'ASK', heldBy: null, also: [{ kind: 'allowlist', label: '3 campaigns locked' }], autoLocked: null } }))).toBe(false)
    expect(isHeld(rows[3])).toBe(true)
    expect(isHeld(row({ mode: { ...row().mode, heldBy: { kind: 'cap', label: 'Daily limit reached' } } }))).toBe(true)
    expect(isHeld(row())).toBe(false)
    expect(isHeld(row({ archived: true, mode: { ...row().mode, heldBy: { kind: 'x', label: 'y' } } }))).toBe(false)
    expect(isHeld(brain)).toBe(false)
    expect(rowMatchesShow(row(), null)).toBe(true)
  })
  it('search reads name, line, market and links, every word, without accents', () => {
    expect(rowMatchesSearch(row(), 'jacket auto')).toBe(true)
    expect(rowMatchesSearch(row({ name: 'Récolte' }), 'recolte')).toBe(true)
    expect(rowMatchesSearch(row(), 'phrase')).toBe(false)
  })
  it('the show values are the page’s ?show=', () => {
    expect(RULES_SHOWS).toEqual(['on', 'harvested', 'asks', 'held'])
    expect(isRulesShow('asks')).toBe(true)
    expect(isRulesShow('waiting')).toBe(false)
  })
})

describe('history: what became of a harvest', () => {
  it('status words come from the one delivery set, plus Part live and Undo waits', () => {
    expect(harvestStatusView('DONE')).toEqual({ word: 'Live', tone: 'success' })
    expect(harvestStatusView('WRITING').word).toBe('Sent')
    expect(harvestStatusView('HALF_DONE').word).toBe('Part live')
    expect(harvestStatusView('UNDO_PROPOSED').word).toBe('Undo waits')
    expect(harvestStatusView('UNDONE').word).toBe('Undone')
    expect(harvestStatusView('REFUSED').word).toBe('Failed')
  })
  it('verdict: Better / Worse, or Too early with when it is judged', () => {
    const now = Date.parse('2026-10-10T00:00:00Z')
    expect(verdictView({ verdict: 'better', judgeAfter: null, judgedAt: 'x', why: 'ACoS 30 → 20 %' }, now)).toEqual({ word: 'Better', tone: 'success', hint: 'ACoS 30 → 20 %' })
    expect(verdictView({ verdict: null, judgeAfter: '2026-10-13T00:00:00Z', judgedAt: null, why: null }, now)?.word).toBe('Too early')
    expect(verdictView({ verdict: null, judgeAfter: '2026-10-13T00:00:00Z', judgedAt: null, why: null }, now)?.hint).toMatch(/^Judged in /)
    expect(verdictView({ verdict: null, judgeAfter: null, judgedAt: null, why: null }, now)).toBeNull()
  })
  it('blocks counts the source and funnel negatives that STAND (landed, not lifted)', () => {
    expect(blocksWord(hist({ sources: [{ adGroup: ref('g1'), result: 'landed', action: 'negate' }] }))).toBe('2 blocked')
    expect(blocksWord(hist())).toBe('1 blocked')
    expect(blocksWord(hist({ undo: { available: false, why: 'Nothing of it is left to put back: its keyword is not running and its blocks are lifted.' } }))).toBeNull()
    expect(blocksWord(hist({ status: 'UNDONE' }))).toBeNull()
    // The server's count wins (only standing blocks).
    expect(blocksWord({ ...hist(), blocks: 0 } as never)).toBeNull()
    expect(blocksWord({ ...hist({ status: 'UNDONE' }), blocks: 3 } as never)).toBe('3 blocked')
    expect(plainStale('The rule changed after it asked.')).toBe('The rule changed after it asked.')
    expect(blocksWord(hist({ sources: [], funnel: [] }))).toBeNull()
    expect(destinationWords(null)).toBe('—')
  })
  it('never Live for a keyword that no longer runs; undo words as on Terms (re-audit M3)', () => {
    const stopped = hist({ undo: { available: false, why: 'Nothing of it is left to put back: its keyword is not running and its blocks are lifted.' } })
    expect(historyStateView(stopped)).toEqual({ word: 'Not running', tone: 'neutral' })
    expect(harvestUndoView(stopped)).toEqual({ kind: 'cant', reason: 'Already undone' })
    expect(historyStateView({ ...hist(), keyword: { state: 'PAUSED' } } as never).word).toBe('Not running')
    expect(historyStateView({ ...hist(), keyword: { state: 'ENABLED' } } as never).word).toBe('Live')
    expect(historyStateView(hist()).word).toBe('Live')
  })
  it('Undo is offered, or says why not', () => {
    expect(harvestUndoView(hist())).toEqual({ kind: 'undo' })
    expect(harvestUndoView(hist({ undo: { available: false, why: 'Waiting for its first write.' } }))).toEqual({ kind: 'cant', reason: 'Waiting for its first write.' })
    expect(harvestUndoView(hist({ status: 'UNDONE', undo: { available: false, why: null } }))).toEqual({ kind: 'cant', reason: 'Already undone' })
  })
  it('effect: rules by id, the brain as brain; people and Claude left out', () => {
    const e = effectByRule([
      hist({ judge: { verdict: 'better', judgeAfter: null, judgedAt: null, why: null } }),
      hist({ harvestId: 'h2', judge: { verdict: 'worse', judgeAfter: null, judgedAt: null, why: null } }),
      hist({ harvestId: 'h3' }),
      hist({ harvestId: 'h4', status: 'UNDONE' }),
      hist({ harvestId: 'h5', by: { kind: 'BRAIN', id: null, name: 'Brain' } }),
      hist({ harvestId: 'h6', by: { kind: 'PERSON', id: 'u1', name: 'You' } }),
    ])
    expect(e.get('r1')).toEqual({ harvests: 4, better: 1, worse: 1, tooEarly: 1 })
    expect(e.get('brain')).toEqual({ harvests: 1, better: 0, worse: 0, tooEarly: 1 })
    expect(e.has('u1')).toBe(false)
    expect(effectParts(e.get('r1')).map((p) => p.text)).toEqual(['1 better', '1 worse', '1 too early'])
    expect(effectText(e.get('r1'), 30)).toBe('1 better · 1 worse · 1 too early · 30 d')
    expect(effectText(undefined, 30)).toBe('No harvests in 30 d')
    expect(effectScore(undefined)).toBeLessThan(effectScore(e.get('r1')))
  })
})

describe('mode changes: the builder belt', () => {
  const builder = [{ type: 'keyword-harvesting', control: 'manual', mappings: [] }]
  const engine = [{ type: 'harvest_and_negate', minOrders: 2 }]
  it('knows a builder harvest rule', () => {
    expect(isHarvestBuilderRule(builder)).toBe(true)
    expect(isHarvestBuilderRule(engine)).toBe(false)
    expect(isHarvestBuilderRule(null)).toBe(false)
  })
  it('D1: an Undo sends what the rule was back UNCHANGED — mode, belt and harvest Auto mark', () => {
    // A rule saved at Auto before the release (no mark): back at Auto, still unmarked — it keeps asking.
    expect(undoModeBody('r1', { mode: 'AUTO', belt: 'automate', marked: false })).toEqual({ ids: ['r1'], mode: 'AUTO', belt: 'automate', marked: false })
    expect(undoModeBody('r1', { mode: 'WATCH', belt: 'manual', marked: false })).toEqual({ ids: ['r1'], mode: 'WATCH', belt: 'manual', marked: false })
    expect(undoModeBody('r1', { mode: 'ASK', belt: null })).toEqual({ ids: ['r1'], mode: 'ASK', belt: null })
    // Nothing known, nothing sent.
    expect(undoModeBody('r1', null)).toBeNull()
    expect(undoModeBody('r1', { mode: 'BRAIN', belt: null })).toBeNull()
    expect(levelBefore({ mode: 'WATCH', belt: 'manual' }, 'ASK')).toBe('WATCH')
    expect(levelBefore(undefined, 'ASK')).toBe('ASK')
    expect(UNARCHIVED_AT_OFF).toBe('Unarchived · Off — set its mode again')
    // An archive's Undo whose mode the server refuses (back to Auto from Off): it says it is back at Off, never "Undone: Auto".
    expect(archiveUndoResult({ ok: true }, { ok: false }, 'AUTO')).toEqual({ ok: false, words: 'Unarchived · Off — set its mode again', verb: 'undone' })
    expect(archiveUndoResult({ ok: true }, { ok: true }, 'ASK')).toEqual({ ok: true, words: 'Undone: Ask me' })
    expect(archiveUndoResult({ ok: true }, null, 'OFF')).toEqual({ ok: true, words: 'Undone: Off' })
    expect(archiveUndoResult({ ok: false, words: 'No' }, null, 'ASK')).toEqual({ ok: false, words: 'No', verb: 'undone' })
  })
  it('review lines: a raise needs the tick, Auto names its caps, a held rule says what it acts as', () => {
    const rows = new Map([['a', row({ id: 'a' })], ['b', row({ id: 'b', mode: { set: 'AUTO', acts: 'WATCH', heldBy: { kind: 'server', label: 'Server: no changes' }, also: [], autoLocked: null } })], ['c', row({ id: 'c', mode: OFF })]])
    const out = harvestModeReviewChanges({ a: 'AUTO', b: 'ASK', c: 'WATCH' }, rows, 'CAPS')
    expect(out).toEqual([
      { id: 'a', where: 'Harvest winners', what: 'Mode', now: 'Ask me', next: 'Auto', raise: true, note: 'CAPS' },
      { id: 'b', where: 'Harvest winners', what: 'Mode', now: 'Auto', next: 'Ask me', raise: false, note: 'Acts as Watch now: Server: no changes' },
      { id: 'c', where: 'Harvest winners', what: 'Mode', now: 'Off', next: 'Watch', raise: false },
    ])
  })
  it('bulk mode reaches rules only', () => {
    expect(modeable([brain, row({ id: 'a' }), row({ id: 'b', archived: true })]).map((r) => r.id)).toEqual(['a'])
  })
})

describe('the Mode cell’s shield', () => {
  it('marks holds while it acts as set, or higher (a belt that asks); a lower step is the DS arrow', async () => {
    const { shieldHolds } = await import('./harvestRulesModel')
    const hold = { kind: 'manual', label: 'Rule asks first', reason: 'It asks.' }
    expect(shieldHolds({ set: 'WATCH', acts: 'ASK', heldBy: hold, also: [], autoLocked: null })).toEqual([hold])
    expect(shieldHolds({ set: 'ASK', acts: 'ASK', heldBy: null, also: [hold], autoLocked: null })).toEqual([hold])
    expect(shieldHolds({ set: 'AUTO', acts: 'WATCH', heldBy: hold, also: [], autoLocked: null })).toEqual([])
  })
})

describe('plain words (audit §2, S10, S12, S21)', () => {
  it('a stale ask in a few words', () => {
    expect(plainStale('This change cannot be applied now: TEST rule was edited (actions, scope) after it proposed this, and it has not proposed it again since.'))
      .toBe('The rule changed since it asked. It asks again on its next run if still needed.')
    expect(plainStale(null)).toBeNull()
    expect(plainStale('Something else.')).toBe('Something else.')
  })
  it('holds without jargon', async () => {
    const { plainHold, plainHoldWords } = await import('./harvestRulesModel')
    expect(plainHold({ kind: 'allowlist', label: '79 campaigns locked', reason: 'Not on the live-change list, bids held by hand, or the account takes no changes: A, B +77.' }))
      .toEqual({ kind: 'allowlist', label: 'Can’t change 79 campaigns', reason: 'Nexus may not change these campaigns: A, B +77.' })
    expect(plainHold({ kind: 'gate', label: 'Auto: Amazon test mode', reason: "The server sends ads changes to Amazon's test account, not the live one." }))
      .toEqual({ kind: 'gate', label: 'Auto off: test account', reason: 'Changes go to Amazon’s test account, not the live one.' })
    expect(plainHoldWords('Rule asks first')).toBe('Rule asks first')
  })
  it('a rule’s line, the schedule in a hover that already has the Rome time', async () => {
    const { ruleLine, scheduleShort } = await import('./harvestRulesModel')
    expect(ruleLine('If a term converts → harvest by its mapping')).toBe('If a term sells → its mapped ad group')
    expect(ruleLine('If orders ≥ 2 over 30 d → keyword + block the source')).toBe('If orders ≥ 2 over 30 d → keyword + block the source')
    expect(scheduleShort('Daily · 05:25 UTC')).toBe('daily')
    expect(scheduleShort('Daily · 00:00 · Rome')).toBe('daily')
    expect(scheduleShort('Every 15 min')).toBe('every 15 min')
    expect(scheduleShort(null)).toBeNull()
  })
  it('the bulk Mode list holds Auto with the cell’s reason', async () => {
    const { bulkModeOptions, harvestHeldStep } = await import('./harvestRulesModel')
    const off = row({ id: 'o', mode: { ...OFF, autoLocked: { kind: 'graduation', label: 'Turn on first', reason: 'x' } } })
    expect(harvestHeldStep(off, 'AUTO')).toBe('Turn on Watch first')
    const opts = bulkModeOptions([row(), off])
    expect(opts.find((o) => o.value === 'AUTO')?.heldReason).toBe('Turn on Watch first')
    expect(opts.find((o) => o.value === 'WATCH')?.heldReason).toBeUndefined()
  })
  it('the preview’s brain terms are one line', async () => {
    const { previewView, brainTermsLine } = await import('./harvestRulesModel')
    const brainHold = { kind: 'lever' as const, label: 'Brain decides', reason: 'x' }
    const s = (id: string, heldBy: typeof brainHold | null) => ({ candidateId: id, term: id, product: ref('p'), destination: null, startBidCents: 10, heldBy })
    const v = previewView({ sample: [s('a', brainHold), s('b', null), s('c', brainHold)], held: 2 }, 50)
    expect(v.rows.map((x) => x.candidateId)).toEqual(['b'])
    expect(v).toMatchObject({ brainTerms: 2, ofFirst: null, held: 0 })
    // A cut sample cannot say how many of the rest are the brain's: the total stays, the line says "of the first N".
    expect(previewView({ sample: [s('a', brainHold), s('c', brainHold)], held: 54 }, 2)).toMatchObject({ brainTerms: 2, ofFirst: 2, held: 54 })
    expect(previewView({ sample: [], held: 60, brainTerms: 54 } as never)).toMatchObject({ brainTerms: 54, ofFirst: null, held: 6 })
    expect(brainTermsLine(54, 'WATCH')).toBe('54 terms belong to the Brain (Watch: it adds nothing)')
    expect(brainTermsLine(50, 'WATCH', 50)).toBe('50 of the first 50 terms belong to the Brain (Watch: it adds nothing)')
    expect(brainTermsLine(1, null)).toBe('1 term belongs to the Brain')
    // The server's own line (S12): its words, the brain's terms apart from `held`.
    expect(previewView({ sample: [s('b', null)], held: 3, brainOwned: { terms: 54, mode: 'WATCH', words: '54 terms belong to the brain (Watch: it adds nothing)' } }))
      .toMatchObject({ brainTerms: 54, held: 3, words: '54 terms belong to the Brain (Watch: it adds nothing)' })
  })
})

describe('RS5: only the newest read shows', () => {
  it('an answer that lands after a newer read began is dropped — another market’s, or an older one', async () => {
    const begin = latestRead()
    const shown: string[] = []
    const read = async (market: string, ms: number) => {
      const current = begin()
      await new Promise((r) => setTimeout(r, ms))
      if (current()) shown.push(market)
    }
    // IT is slow, DE (picked after) is fast: IT's answer lands last and must not show.
    await Promise.all([read('IT', 20), read('DE', 1)])
    expect(shown).toEqual(['DE'])
    await read('FR', 1)
    expect(shown).toEqual(['DE', 'FR'])
  })
})

describe('functional walk: Pick Auto again, Auto from Off, plain words', () => {
  const again = row({ id: 'g', mode: { set: 'AUTO', acts: 'ASK', heldBy: { kind: 'graduation', label: 'Pick Auto again', reason: 'Pick Auto again to let it act: until then it asks.' }, also: [], autoLocked: null } })
  it('MUST: on a rule saved at Auto before, picking Auto is a change that is sent (cell, window, bulk)', () => {
    expect(needsAutoAgain(again.mode)).toBe(true)
    expect(modeBase(again.mode)).toBe('ASK')
    // The cell and the window show what it does, so Auto is a pick of its own.
    expect(shownHarvestMode(again, {}).set).toBe('ASK')
    expect(pickHarvestMode({}, again, 'AUTO')).toEqual({ g: 'AUTO' })
    expect(retidyHarvestModes({ g: 'AUTO' }, new Map([['g', again]]))).toEqual({ g: 'AUTO' })
    const [line] = harvestModeReviewChanges({ g: 'AUTO' }, new Map([['g', again]]), 'CAPS')
    expect(line).toMatchObject({ now: 'Ask me', next: 'Auto', raise: true, note: 'Set to Auto before: picked again, it acts by itself' })
    // A rule on Auto that acts on Auto is no change.
    const auto = row({ id: 'h', mode: { set: 'AUTO', acts: 'AUTO', heldBy: null, also: [], autoLocked: null } })
    expect(pickHarvestMode({}, auto, 'AUTO')).toEqual({})
  })
  it('SHOULD: Auto is held up front on the server’s autoLocked — from Off with the plain next step (cell, window, bulk)', async () => {
    const { bulkModeOptions, harvestHeldStep } = await import('./harvestRulesModel')
    const off = row({ id: 'o', mode: { ...OFF, autoLocked: { kind: 'graduation', label: 'Turn on first', reason: 'Auto is for a rule that runs: pick Watch or Ask me first.' } } })
    const gated = row({ id: 'n', mode: { set: 'ASK', acts: 'ASK', heldBy: null, also: [], autoLocked: { kind: 'graduation', label: 'Auto from 22 Oct', reason: 'A new rule first runs 14 days, at least 10 times and matches a keyword once.' } } })
    expect(harvestHeldStep(gated, 'AUTO')).toBe('A new rule first runs 14 days, at least 10 times and matches a keyword once.')
    // A rule set to Auto that the gate would refuse to mark: Auto held with the gate's plain reason (no pick to send).
    const locked = row({ id: 'l', mode: { set: 'AUTO', acts: 'ASK', heldBy: { kind: 'gate', label: 'Amazon test mode', reason: 'Auto is off while Amazon runs in test mode.' }, also: [], autoLocked: { kind: 'gate', label: 'Amazon test mode', reason: 'Auto is off while Amazon runs in test mode.' } } })
    expect(harvestHeldStep(locked, 'AUTO')).toBe('Auto is off while Amazon runs in test mode.')
    expect(needsAutoAgain(locked.mode)).toBe(false)
    // A hold on what it does (heldBy) never holds Auto.
    expect(harvestHeldStep(row({ id: 'h', mode: { set: 'ASK', acts: 'WATCH', heldBy: { kind: 'cap', label: 'Run limit 0' }, also: [], autoLocked: null } }), 'AUTO')).toBeNull()
    expect(harvestHeldStep(off, 'AUTO')).toBe('Turn on Watch first')
    expect(harvestHeldStep(off, 'WATCH')).toBeNull()
    expect(bulkModeOptions([off]).find((o) => o.value === 'AUTO')?.heldReason).toBe('Turn on Watch first')
  })
  it('SHOULD: a refusal never shows developer text; NICE: the code step in one plain line', async () => {
    const { plainRefusal, plainApproveError } = await import('./harvestRulesModel')
    const refusal = 'AUTO only after the graduation gate: Rule must be enabled (toggle it on first); 10/14 days — 4 days remaining; 0 evaluations; Set NEXUS_AMAZON_ADS_MODE=live on Railway and redeploy.'
    const plain = plainRefusal(refusal)
    expect(plain).not.toMatch(/NEXUS_|Railway|redeploy|graduation|evaluation/)
    expect(plain).toBe('Auto only after its first runs: turn it on first; 10/14 days — 4 days remaining; 0 runs; Changes go to Amazon’s test account, not the live one.')
    expect(plainApproveError({ code: 'mfa_not_enrolled', error: 'Turn on two-factor authentication before you approve a change.' })).toBe('Needs the code from your authenticator app')
    expect(plainApproveError({ code: 'mfa_required' })).toBe('Needs the code from your authenticator app')
    expect(plainApproveError({ error: 'Expired' })).toBe('Expired')
  })
})

