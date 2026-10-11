import { describe, expect, it } from 'vitest'
import {
  BRAIN_ID, LAST7_ROOM_ONE_MARKET, allAdGroups, brainAskWords, brainPickChange, brainStepOf, archiveWords, autoLockOf, holdReason, holdWord, changeFromTo, sampleFromTo, sampleHold, effectView,
  effectWindow, heldStep, holdsOf, last7Fit, last7Parts, last7Tab, last7Text, marketMoney, modeLock, nextRunView, noEffectWords, partHolds, previewParts,
  readError, rowMatchesSearch, rowMatchesTile, visibleRows, whoWord, worksOn,
  type BidRuleRow, type Effect, type RuleChange,
} from './bidRulesModel'
import {
  archiveReviewChanges, beltFor, bulkModeOptions, canChangeBids, modeConflicts, modeReviewChanges, modeSteps, pickMode, pickModeFor, raiseAck, refusalWords,
  restoreReviewChanges, retidyModes, shownMode, withBelt,
} from './ruleChanges'

const ref = (id: string, name = id) => ({ id, name, href: `/marketing/ads/campaigns/${id}` })

function row(over: Partial<BidRuleRow> = {}): BidRuleRow {
  return {
    id: 'r1', kind: 'rule', name: 'Rule A', sentence: 'If ACoS > 35 % over 14 d → bid −15 %', market: 'IT',
    mode: { set: 'ASK', acts: 'ASK', heldBy: null, also: [], autoLocked: { kind: 'graduation', label: 'Auto from 24 Oct', reason: 'A new rule runs 14 days first.' } },
    scope: { portfolios: [], campaigns: [ref('c1', 'Jacket Exact')], adGroups: [], all: false, product: null, counts: { portfolios: 0, campaigns: 1, adGroups: 0 } },
    changed7d: { portfolios: [], campaigns: [], adGroups: [], bids: 0, keywords: 0 },
    last7d: { runs: 0, asks: 0, applied: 0, written: 0, brainInputs: 0, refused: 0 },
    waiting: 0, lastRunAt: null, nextRunAt: null, effect: null, archived: false,
    ...over,
  }
}
const brain = row({ id: BRAIN_ID, kind: 'brain', name: 'Brain', mode: { set: 'WATCH', acts: 'WATCH', heldBy: null, also: [], autoLocked: { kind: 'server', label: 'Auto off (server)', reason: 'The server switch must allow changes first.' } } })

describe('rules table words', () => {
  it('tiles filter: on, changed, waiting', () => {
    expect(rowMatchesTile(row(), 'on')).toBe(true)
    expect(rowMatchesTile(row({ mode: { ...row().mode, set: 'OFF', acts: 'OFF' } }), 'on')).toBe(false)
    expect(rowMatchesTile(row({ archived: true }), 'on')).toBe(false)
    expect(rowMatchesTile(row(), 'changed')).toBe(false)
    expect(rowMatchesTile(row({ changed7d: { ...row().changed7d, bids: 3 } }), 'changed')).toBe(true)
    expect(rowMatchesTile(row({ waiting: 1 }), 'waiting')).toBe(true)
    expect(rowMatchesTile(row(), null)).toBe(true)
  })

  it('search reads name, sentence and what it works on, every word, without accents', () => {
    expect(rowMatchesSearch(row(), 'jacket exact')).toBe(true)
    expect(rowMatchesSearch(row(), 'acos 35')).toBe(true)
    expect(rowMatchesSearch(row({ name: 'Règle prix' }), 'regle')).toBe(true)
    expect(rowMatchesSearch(row(), 'gloves')).toBe(false)
  })

  it('archived rules show only when asked for; the brain stays first', () => {
    const rows = [brain, row(), row({ id: 'r2', archived: true })]
    const none = { tile: null, search: '', archived: false }
    expect(visibleRows(rows, none).map((r) => r.id)).toEqual([BRAIN_ID, 'r1'])
    expect(visibleRows(rows, { ...none, archived: true }).map((r) => r.id)).toEqual(['r2'])
  })

  it('works on: the true total and how many the list leaves out (M5); ad groups of a rule bound to none are All', () => {
    const r = row({ scope: { ...row().scope, counts: { portfolios: 0, campaigns: 155 } } })
    expect(worksOn(r, 'campaigns')).toEqual({ items: r.scope.campaigns, more: 154, total: 155 })
    // An answer without an ad-group count counts the list.
    expect(worksOn(r, 'adGroups')).toMatchObject({ more: 0, total: 0 })
    const changed = row({ changed7d: { ...row().changed7d, campaigns: [ref('c1')], counts: { portfolios: 0, campaigns: 120, adGroups: 0 } } })
    expect(worksOn(changed, 'campaigns', 'changed')).toMatchObject({ more: 119, total: 120 })
    expect(allAdGroups(row())).toBe(true)
    expect(allAdGroups(row({ scope: { ...row().scope, adGroups: [ref('g1')] } }))).toBe(false)
    expect(allAdGroups(brain)).toBe(false)
  })

  it('last 7 d: bids, asked, applied, brain, refused — chips that open a tab, and one line with the runs', () => {
    const r = row({ last7d: { runs: 12, asks: 4, applied: 1, written: 1, brainInputs: 2, refused: 60 }, changed7d: { ...row().changed7d, bids: 1 } })
    const waits = { ...r, waiting: 2 }
    expect(last7Parts(waits).map((p) => p.text)).toEqual(['1 bid', '4 asked', '1 applied', '2 to Brain', '60 refused'])
    expect(last7Parts(waits).map((p) => p.tab ?? null)).toEqual(['history', 'waiting', 'history', null, null])
    expect(last7Parts(r).find((p) => p.key === 'refused')?.tone).toBe('warning')
    expect(last7Text(waits)).toBe('1 bid · 4 asked · 1 applied · 2 to Brain · 60 refused · 12 runs')
    // Nothing waits any more: the chip says so and opens no empty tab (audit R13).
    expect(last7Parts(r).find((p) => p.key === 'asks')).toEqual({ key: 'asks', text: '4 asked · none waiting' })
    // Enter on the cell: the asks while some wait, else the first chip's tab, else the Overview.
    expect(last7Tab({ ...r, waiting: 2 })).toBe('waiting')
    expect(last7Tab(r)).toBe('history')
    expect(last7Tab(row())).toBe('overview')
    expect(last7Text(row({ last7d: { ...row().last7d, runs: 3 } }))).toBe('3 runs, nothing changed')
    expect(last7Text(row())).toBe('No runs')
  })

  it('last 7 d fits one line (design audit M7): the asks that wait first, then what fits, the rest as "+n"', () => {
    // The seed rule that wrapped onto two lines: 2 bids · 3 asked · 1 applied · 2 waiting.
    const r = row({ waiting: 2, last7d: { runs: 4, asks: 3, applied: 1, written: 2, brainInputs: 0, refused: 0 }, changed7d: { ...row().changed7d, bids: 2 } })
    // One market: the column has the Market column's room too.
    const fit = last7Fit(r, LAST7_ROOM_ONE_MARKET)
    expect(fit.shown.map((i) => i.text)).toEqual(['2 waiting', '2 bids'])
    expect(fit.hidden.map((i) => i.text)).toEqual(['3 asked', '1 applied'])
    expect(fit.shown[0].waiting).toBe(true)
    // All markets (the narrower column): the asks that wait, and the rest as "+3".
    expect(last7Fit(r).shown.map((i) => i.text)).toEqual(['2 waiting'])
    expect(last7Fit(r).hidden).toHaveLength(3)
    // Room for everything: no "+n".
    expect(last7Fit(r, 400).hidden).toEqual([])
    // One long chip still shows, alone.
    const long = row({ last7d: { ...row().last7d, asks: 1 } })
    expect(last7Fit(long).shown.map((i) => i.text)).toEqual(['1 asked · none waiting'])
    expect(last7Fit(long, 10).shown).toHaveLength(1)
    expect(last7Fit(row()).shown).toEqual([])
  })

  it('effect: ACoS before → after (lower is better), else orders; nothing when the same, too early or none (S8)', () => {
    const e: Effect = {
      window: { settledThrough: '2026-10-03' }, keywords: 2, tooEarly: 1, days: 20,
      currency: 'EUR', before: { clicks: 40, orders: 2, acosPct: 30 }, after: { clicks: 50, orders: 3, acosPct: 22.5 },
    }
    expect(effectView(e)).toMatchObject({ text: 'ACoS 30 → 22.5 %', tone: 'success' })
    expect(effectWindow(e)).toBe('2 keywords · 10 d before/after · 1 too early · ends 3 Oct')
    expect(effectView({ ...e, before: { clicks: 1, orders: 4 }, after: { clicks: 1, orders: 2 } })).toMatchObject({ text: 'Orders 4 → 2', tone: 'danger' })
    // The same before and after is no chip ("ACoS 5 → 5 %" was noise).
    expect(effectView({ ...e, after: { ...e.after, acosPct: 30 } })).toBeNull()
    expect(effectView({ ...e, before: { clicks: 1, orders: 0 }, after: { clicks: 1, orders: 0 } })).toBeNull()
    // Every changed keyword too early: keywords 0 — a dash that says so, never "Orders 0 → 0".
    expect(effectView({ ...e, keywords: 0 })).toBeNull()
    expect(noEffectWords(row({ effect: { ...e, keywords: 0 } }))).toMatch(/Too early/)
    expect(noEffectWords(row({ effect: { ...e, after: { ...e.after, acosPct: 30 } } }))).toBe('No change · 2 keywords · 10 d before/after · 1 too early · ends 3 Oct')
    expect(effectView(null)).toBeNull()
    expect(noEffectWords(row())).toBe('No bid changes to compare')
    expect(noEffectWords(row({ changed7d: { ...row().changed7d, bids: 2 } }))).toMatch(/Too early/)
  })

  it('mode: holds in order with their reasons, Auto held with its reason, one lock wording for the brain', () => {
    const m = { set: 'AUTO' as const, acts: 'ASK' as const, heldBy: { kind: 'dial', label: 'Account: Ask me', reason: 'The account asks first.' }, also: [{ kind: 'allowlist', label: '2 campaigns locked' }], autoLocked: null }
    expect(holdsOf(m).map((h) => h.label)).toEqual(['Account: Ask me', '2 campaigns locked'])
    expect(holdReason(m.heldBy)).toBe('The account asks first.')
    // An older answer without a reason: the label is the hover.
    expect(holdReason({ kind: 'allowlist', label: '2 campaigns locked' })).toBe('2 campaigns locked')
    expect(heldStep(row(), 'AUTO')).toBe('A new rule runs 14 days first.')
    expect(heldStep(row(), 'WATCH')).toBeNull()
    // From Off, Auto is not the next step — also when the answer sends no Auto hold for an Off rule (use audit A5).
    expect(heldStep(row({ mode: { ...row().mode, set: 'OFF', acts: 'OFF' } }), 'AUTO')).toBe('Pick Watch or Ask me first')
    expect(heldStep(row({ mode: { ...row().mode, set: 'OFF', acts: 'OFF', autoLocked: null } }), 'AUTO')).toBe('Pick Watch or Ask me first')
    expect(heldStep(row({ mode: { ...row().mode, autoLocked: null } }), 'AUTO')).toBeNull()
    // The chip: the server's label as it is when it starts with Auto; an archived rule shows none.
    expect(autoLockOf(row())?.label).toBe('Auto from 24 Oct')
    expect(autoLockOf(row({ mode: { ...row().mode, autoLocked: { kind: 'graduation', label: 'No match yet' } } }))?.label).toBe('Auto: No match yet')
    expect(autoLockOf(row({ archived: true }))).toBeNull()
    // An Off rule shows no Auto chip ("Auto: Turn on first" only repeated the mode list; audit R15).
    expect(autoLockOf(row({ mode: { ...row().mode, set: 'OFF', acts: 'OFF', autoLocked: { kind: 'off', label: 'Turn on first' } } }))).toBeNull()
    // The server's "shadow" is the page's Watch.
    expect(holdWord('Server: shadow')).toBe('Server: Watch')
    expect(modeLock(brain)).toBe('Set per campaign: open the Brain')
    expect(modeLock(row({ archived: true }))).toMatch(/Archived/)
    expect(modeLock(row())).toBeNull()
  })

  it('the Mode cell marks holds on part of its campaigns only while it acts as set (the arrow says the rest)', () => {
    const part = { set: 'ASK' as const, acts: 'ASK' as const, heldBy: null, also: [{ kind: 'allowlist', label: '1 campaign locked', reason: 'Not on the live-change list: IT Exact' }], autoLocked: null }
    expect(partHolds(part).map((h) => h.label)).toEqual(['1 campaign locked'])
    expect(partHolds({ ...part, acts: 'WATCH' })).toEqual([])
    expect(partHolds({ ...part, also: [] })).toEqual([])
  })

  it('money in the market’s own money; the next run with its first run and schedule', () => {
    expect(marketMoney(15, 'IT')).toBe('€0.15')
    expect(marketMoney(null, 'IT')).toBe('—')
    expect(marketMoney(120, 'UK')).toBe('£1.20')
    const now = Date.parse('2026-10-10T12:00:00Z')
    expect(nextRunView({ nextRunAt: '2026-10-10T12:20:00Z', firstRunAt: null, thenRunAt: null, schedule: 'Daily · 06:00 · Rome' }, now)).toEqual({ value: 'in 20 min', hint: '10 Oct, 14:20 · Daily · 06:00 · Rome' })
    expect(nextRunView({ nextRunAt: '2026-10-10T12:20:00Z', firstRunAt: '2026-10-10T12:20:00Z', thenRunAt: '2026-10-11T04:00:00Z', schedule: 'Daily · 06:00 · Rome' }, now))
      .toEqual({ value: 'in 20 min', hint: 'First 10 Oct, 14:20, then daily 06:00 · Rome' }) // its schedule's run is not said twice (C-UI 8)
    // Two first runs on one day: the day once (audit R14).
    expect(nextRunView({ nextRunAt: '2026-10-10T23:30:00Z', firstRunAt: '2026-10-10T23:30:00Z', thenRunAt: '2026-10-11T11:30:00Z', schedule: 'Daily · 06:00 · Rome' }, now).hint)
      .toBe('First 11 Oct, 01:30 and 13:30, then daily 06:00 · Rome')
    expect(nextRunView({ nextRunAt: null, schedule: 'Every 15 min' }, now)).toEqual({ value: '—', hint: 'Every 15 min' })
  })

  it('the brain per campaign: Auto while it owns the campaign; Auto takes the tick and the code; when it runs', () => {
    expect(brainStepOf('c1', new Set(['c1']))).toBe('AUTO')
    expect(brainStepOf('c2', new Set(['c1']))).toBe('WATCH')
    expect(brainPickChange({ id: 'c2', name: 'Jacket Exact', from: 'WATCH', to: 'AUTO' })).toEqual({
      id: 'c2', where: 'Jacket Exact', what: 'Brain', now: 'Watch', next: 'Auto', raise: true, note: 'Becomes its one bid writer · your code',
    })
    expect(brainPickChange({ id: 'c1', name: 'Jacket Exact', from: 'AUTO', to: 'WATCH' })).toMatchObject({ raise: false, next: 'Watch' })
    const now = Date.parse('2026-10-10T12:00:00Z')
    expect(brainAskWords({ executeAfter: '2026-10-10T12:00:30Z' }, now)).toBe('Approved · runs now')
    expect(brainAskWords({ executeAfter: '2026-10-10T12:05:00Z' }, now)).toBe('Approved · runs in 5 min')
    expect(brainAskWords({}, now)).toBe('Approved')
  })

  it('a failed read keeps the server’s sentence, never a bare code', () => {
    expect(readError('Not allowed for your account.')).toBe('Not allowed for your account.')
    expect(readError('Refused (HTTP 500: x).')).toBeNull()
    expect(readError('Failed to fetch')).toBeNull()
    expect(readError(null)).toBeNull()
  })

  it('a history change: a bid in money, a state as stored', () => {
    const base: RuleChange = { id: 'x', at: '2026-10-10T08:00:00Z', target: null, adGroup: null, campaign: null, portfolio: null, field: 'bid', who: { kind: 'rule', id: 'r1', name: 'Rule A' }, delivery: null, changeId: null, undoBlocked: null }
    expect(changeFromTo({ ...base, fromCents: 18, toCents: 15 }, 'IT')).toEqual({ from: '€0.18', to: '€0.15' })
    expect(changeFromTo({ ...base, field: 'state', from: 'ENABLED', to: 'PAUSED' }, 'IT')).toEqual({ from: 'ENABLED', to: 'PAUSED' })
    // Who: never "Rule" for the rule whose History this is; a person, the Brain or another rule by name.
    expect(whoWord(base, 'r1')).toBeNull()
    expect(whoWord({ ...base, who: { kind: 'rule', id: 'r9', name: 'Rule Z' } }, 'r1')).toBe('Rule Z')
    expect(whoWord({ ...base, who: { kind: 'person', id: 'u1', name: '' } }, 'r1')).toBe('You')
    // A person is "You" on the whole page, whatever name the server sends ("operator", a login).
    expect(whoWord({ ...base, who: { kind: 'person', id: 'u1', name: 'operator' } }, 'r1')).toBe('You')
    expect(whoWord({ ...base, who: { kind: 'brain', id: null, name: 'Brain' } }, 'r1')).toBe('Brain')
    expect(whoWord({ ...base, who: { kind: 'brain', id: null, name: 'Brain' } }, BRAIN_ID)).toBeNull()
  })

  it('preview: the count and what happens to the rest', () => {
    const base = { ruleId: null, saved: false, wouldChange: 6, unsampled: 2, brainInputs: 2, locked: 1, refused: 0, capped: false, windowDays: 14, sample: [], note: null }
    expect(previewParts(base).map((p) => p.text)).toEqual(['6 bids', '2 not listed', '2 to Brain', '1 locked'])
    expect(previewParts({ ...base, capped: true }).map((p) => p.text)).toContain('Daily limit reached')
    // A held change: the server's words, else the page's for its kind.
    expect(sampleHold({ held: 'brain', heldBy: { kind: 'brain', label: 'Brain decides', reason: 'The brain sets these bids.' } })).toEqual({ label: 'Brain decides', reason: 'The brain sets these bids.', tone: 'info' })
    expect(sampleHold({ held: 'market' })).toMatchObject({ label: 'Market not set up', tone: 'warning' })
    expect(sampleHold({ held: null })).toBeNull()
    const pause = { ...base, wouldChange: 1, unsampled: 0, brainInputs: 0, locked: 0, sample: [{ target: null, adGroup: null, campaign: null, field: 'state' as const, from: 'ENABLED', to: 'PAUSED', held: null }] }
    expect(previewParts(pause).map((p) => p.text)).toEqual(['1 keyword'])
    expect(sampleFromTo(pause.sample[0], 'IT')).toEqual({ label: 'State', from: 'On', to: 'Paused' })
    expect(sampleFromTo({ target: null, adGroup: null, campaign: null, field: 'bid', fromCents: 15, toCents: 18, held: 'market' }, 'IT')).toEqual({ label: 'Bid', from: '€0.15', to: '€0.18' })
  })

  it('archive: what went with it, for the Done step', () => {
    expect(archiveWords({ expiredAsks: 1, endedBrainInputs: 2, cancelledWrites: 0 })).toBe('Archived · 1 ask expired · 2 Brain inputs ended')
    expect(archiveWords({ already: true })).toBe('Already archived')
    expect(archiveWords(null)).toBe('Archived')
  })
})

describe('mode draft and review', () => {
  const rows = new Map([['r1', row()], ['r2', row({ id: 'r2', name: 'Rule B', mode: { set: 'AUTO', acts: 'ASK', heldBy: { kind: 'dial', label: 'Account: Ask me' }, also: [], autoLocked: null } })]])

  it('a pick back to the set mode leaves the draft; the brain, archived rules and a held step never enter it (A4, A5)', () => {
    const free = row({ mode: { ...row().mode, autoLocked: null } })
    let d = pickMode({}, free, 'AUTO')
    expect(d).toEqual({ r1: 'AUTO' })
    d = pickMode(d, free, 'ASK')
    expect(d).toEqual({})
    // Auto held by its gate ("Auto from 24 Oct"), and Auto from Off: the server would refuse the save.
    expect(pickMode({}, row(), 'AUTO')).toEqual({})
    expect(pickMode({}, row({ mode: { ...row().mode, set: 'OFF', acts: 'OFF', autoLocked: null } }), 'AUTO')).toEqual({})
    expect(pickMode({}, brain, 'AUTO')).toEqual({})
    expect(pickMode({}, row({ archived: true }), 'OFF')).toEqual({})
    expect(pickModeFor({}, [row(), rows.get('r2')!, brain], 'WATCH')).toEqual({ r1: 'WATCH', r2: 'WATCH' })
    // The bulk Auto: a held rule keeps its mode; the list says so, or holds Auto when no ticked rule may take it.
    const two = [row(), row({ id: 'r3', mode: { ...row().mode, autoLocked: null } })]
    expect(pickModeFor({}, two, 'AUTO')).toEqual({ r3: 'AUTO' })
    expect(bulkModeOptions(two).find((o) => o.value === 'AUTO')).toEqual({ value: 'AUTO', label: 'Auto', note: '1 rule keeps its mode: A new rule runs 14 days first.' })
    expect(bulkModeOptions([row()]).find((o) => o.value === 'AUTO')).toMatchObject({ heldReason: 'A new rule runs 14 days first.' })
    expect(bulkModeOptions([row()]).find((o) => o.value === 'WATCH')).toEqual({ value: 'WATCH', label: 'Watch' })
  })

  it('the review: Now → New, only a pick that can change bids needs the tick (S1), the held state is noted', () => {
    const changes = modeReviewChanges({ r1: 'AUTO', r2: 'WATCH' }, rows)
    expect(changes).toEqual([
      { id: 'r1', where: 'Rule A', what: 'Mode', now: 'Ask me', next: 'Auto', raise: true, note: 'Can change bids' },
      { id: 'r2', where: 'Rule B', what: 'Mode', now: 'Auto', next: 'Watch', raise: false, note: 'Acts as Ask me now: Account: Ask me' },
    ])
    // Off → Watch changes nothing: no tick.
    const off = new Map([['r1', row({ mode: { ...row().mode, set: 'OFF', acts: 'OFF' } })]])
    expect(modeReviewChanges({ r1: 'WATCH' }, off)).toEqual([{ id: 'r1', where: 'Rule A', what: 'Mode', now: 'Off', next: 'Watch', raise: false }])
    expect(modeReviewChanges({ r1: 'ASK' }, off)[0]).toMatchObject({ raise: true, note: 'Can change bids' })
    expect(canChangeBids('OFF', 'WATCH')).toBe(false)
    expect(canChangeBids('WATCH', 'ASK')).toBe(true)
    expect(canChangeBids('AUTO', 'ASK')).toBe(false)
    expect(raiseAck(1)).toBe('I understand: from its next run this rule can change bids')
    expect(raiseAck(2)).toBe('I understand: from their next run these 2 rules can change bids')
  })

  it('conflicts name a set mode that moved, an archive or a rule that is gone', () => {
    const fresh = new Map([['r1', row({ mode: { ...row().mode, set: 'WATCH' } })]])
    expect(modeConflicts({ r1: 'AUTO', r2: 'OFF' }, rows, fresh)).toEqual([
      { label: 'Rule A', was: 'Ask me', now: 'Watch' },
      { label: 'Rule B', was: 'Auto', now: 'gone' },
    ])
    expect(retidyModes({ r1: 'WATCH', r2: 'OFF' }, fresh)).toEqual({})
  })

  it('the grid shows the pick while drafted', () => {
    expect(shownMode(row(), { r1: 'OFF' })).toMatchObject({ set: 'OFF', acts: 'OFF', heldBy: null })
    const r = row()
    expect(shownMode(r, {})).toBe(r.mode)
  })

  it('the requests: belt first for Watch and Auto, last for Ask me; engine rules only the level', () => {
    const builder = [{ type: 'bid', control: 'manual', campaigns: [] }]
    expect(beltFor('OFF')).toBeNull()
    expect(modeSteps('AUTO', builder)).toEqual([{ kind: 'belt', control: 'automate', rollbackOnFail: 'manual' }, { kind: 'level', level: 'AUTO' }])
    expect(modeSteps('WATCH', builder)).toEqual([{ kind: 'belt', control: 'automate', rollbackOnFail: 'manual' }, { kind: 'level', level: 'OBSERVE' }])
    expect(modeSteps('ASK', builder)).toEqual([{ kind: 'level', level: 'PROPOSE' }])
    expect(modeSteps('ASK', [{ type: 'bid', control: 'automate' }])).toEqual([{ kind: 'level', level: 'PROPOSE' }, { kind: 'belt', control: 'manual' }])
    expect(modeSteps('OFF', builder)).toEqual([{ kind: 'level', level: 'OFF' }])
    expect(modeSteps('AUTO', [{ type: 'bid_down', percent: 20 }])).toEqual([{ kind: 'level', level: 'AUTO' }])
    expect(withBelt(builder, 'automate')).toEqual([{ type: 'bid', control: 'automate', campaigns: [] }])
  })

  it('a refusal in the server’s words', () => {
    expect(refusalWords(409, { error: 'above_ceiling', message: 'Pausing a keyword stays at Ask me.' })).toBe('Pausing a keyword stays at Ask me.')
    expect(refusalWords(400, { error: 'x', problems: ['Min bid below 0.02'] })).toBe('Min bid below 0.02')
    expect(refusalWords(500, { error: 'boom' })).toBe('Refused (HTTP 500: boom).')
    expect(refusalWords(404, null)).toMatch(/Not found/)
    expect(refusalWords(409, { ok: false, reversed: 0, reason: 'Already undone.' })).toBe('Already undone.')
  })

  it('archive and restore lines', () => {
    const a = archiveReviewChanges([brain, row({ waiting: 1, last7d: { ...row().last7d, brainInputs: 2 } }), row({ id: 'r3', archived: true })])
    expect(a).toEqual([{ id: 'r1', where: 'Rule A', what: 'Rule', now: 'Ask me', next: 'Archived', note: '1 waiting ask expires · 2 Brain inputs end' }])
    expect(restoreReviewChanges([row({ archived: true })])).toEqual([{ id: 'r1', where: 'Rule A', what: 'Rule', now: 'Archived', next: 'Off' }])
  })
})
