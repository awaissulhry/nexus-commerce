/**
 * CR rebuild 6 — History in words: the week, the weekly e-mail (it asks first now), each change and its Undo (asks
 * first, with the DS confirmation), and the next 24 hours (only the hours that hold a change; no server variable names).
 */
import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import {
  accountHoldWords, busyHours, cadenceIn, changeLine, changeMatches, declinedNote, deliveryWords, digestSendImpact, digestSendResult, digestState,
  engineCanWords, enginesThatCan, evidenceWords, fieldWords, hourFlags, makersOf, plainNote, plainNotes, ruleLevelWord, schedulesWords,
  spendLimitWords, undoImpact, undoResult, weekTiles, whoMade, zoneWords,
  ALL_MAKERS, type Change, type Digest, type ForesightEngine, type ForesightHour,
} from './historyWords'

const digest = (over: Partial<Digest> = {}): Digest => ({
  window: { from: '2026-10-05', to: '2026-10-06', label: '2026-10-05 → today', complete: false },
  gates: { cronFlag: 'NEXUS_ENABLE_ADS_REPORT_SCHEDULE_CRON', cronEnabled: false, outboundFlag: 'NEXUS_ENABLE_OUTBOUND_EMAILS', outboundEnabled: false, state: 'off', explanation: 'No digest is scheduled.' },
  totals: { acted: 3, proposed: 2, denied: 1, applied: 4, declined: 0, failed: 0 },
  rules: [],
  effect: { budgetDeltaCents: -1250, budgetMoves: 2, bidMoves: 5, placementMoves: 0, note: 'Bid moves are counted, not priced.' },
  proposals: { pending: 2, priced: 1, spendAtStakeCents: 900, recoverableCents: 450 },
  graduation: { ready: 0, unseen: 0, unreviewed: 0, readyNames: [], unseenNames: [] },
  breaker: { tripsThisWeek: [], maxActionsPerHour: 250, maxHourlySpendCents: 50000, spendThresholdIsDefault: false, peakHourSpendCents: 0, peakHoursSampled: 0, tripNote: '', spendNote: '' },
  coverage: null,
  delivery: { failedWrites: 0, deadLetters: 0 },
  ...over,
})

const change = (over: Partial<Change> = {}): Change => ({
  id: 'c1', at: '2026-10-06T10:00:00.000Z', actor: 'automation:rank-defend', source: 'automation',
  origin: { kind: 'engine', id: null, name: null }, entity: { type: 'keyword', id: 'k1', name: 'demo helmet' },
  campaign: { id: 'cp1', name: 'Demo · Full-face helmets' }, field: 'bidCents', oldValue: '€0.70', newValue: '€0.95',
  reason: 'Rank target moved', evidence: null, delivery: { state: 'APPLIED', attempts: 1, lastError: null },
  undoable: true, undoActionLogId: 'log1',
  ...over,
})

describe('the week', () => {
  it('tiles in words; the waiting tile keeps its CR rebuild 1 name; Failed and Coverage show only when there is one', () => {
    const tiles = weekTiles(digest())
    expect(tiles.map((t) => [t.label, t.value, t.hint])).toEqual([
      ['Acted', '3', '2 asked you first'],
      ['You decided', '5', '4 applied · 1 declined'],
      ['Daily budget moved', '−€12.50', 'over 2 changes'],
      ['Rule suggestions waiting', '2', 'rule changes that wait for you · €4.50 spent with no sale on their keywords'],
    ])
    const more = weekTiles(digest({
      totals: { acted: 0, proposed: 0, denied: 0, applied: 0, declined: 0, failed: 2 },
      coverage: { marketplace: 'IT', week: 'W41', priorWeek: 'W40', share: 0.1234, priorShare: 0.1, deltaPct: 2.34, terms: 4, measured: true, note: '' },
    }))
    expect(more.map((t) => t.key)).toEqual(['acted', 'decided', 'budget', 'suggestions', 'coverage', 'failed'])
    expect(more.find((t) => t.key === 'coverage')?.hint).toBe('+2.34 points against W40')
  })

  it('the engine’s own limit is said without the stale 4 August text', () => {
    expect(declinedNote(0)).toBeNull()
    expect(declinedNote(3)).toBe('3 runs were stopped by the engine’s own daily limit. That is the engine holding itself back — not a failure, and not your decision.')
    expect(declinedNote(3)).not.toMatch(/August|this week on/)
  })

  it('rule levels read in the one scale', () => {
    expect(ruleLevelWord('PROPOSE')).toBe('Ask me')
    expect(ruleLevelWord('OBSERVE')).toBe('Watch')
    expect(ruleLevelWord('SOMETHING')).toBe('SOMETHING')
  })
})

describe('the weekly e-mail asks first', () => {
  it('states in words, never the server variable names', () => {
    expect(digestState(digest().gates).title).toBe('Weekly e-mail — not scheduled')
    expect(digestState({ ...digest().gates, state: 'dry-run' }).title).toBe('Weekly e-mail — on, but nothing leaves Nexus')
    expect(digestState({ ...digest().gates, state: 'live', outboundEnabled: true }).title).toBe('Weekly e-mail — on, sent every Monday')
    expect(JSON.stringify(digestState(digest().gates))).not.toMatch(/NEXUS_/)
  })

  it('THE REGRESSION: with outbound e-mail on, Send now asks with the tick (it e-mailed everyone on one click)', () => {
    const impact = digestSendImpact({ ...digest().gates, outboundEnabled: true, state: 'live' })
    expect(impact.title).toBe('Send last week’s e-mail to every recipient now?')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(false)
    expect(canConfirmAction(impact, '', true)).toBe(true)
  })

  it('with outbound e-mail off it only builds and logs: a plain question', () => {
    const impact = digestSendImpact(digest().gates)
    expect(impact.consequences?.[0]).toBe('Outbound e-mail is off on the server, so nothing is mailed.')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })

  it('a dry run is said as a dry run, never as sent; a refusal keeps the server’s words', () => {
    expect(digestSendResult({ status: 'SENT', recipients: ['a@x.test'] }, 200)).toEqual({ ok: true, text: 'Sent to a@x.test.' })
    expect(digestSendResult({ status: 'DRY_RUN' }, 200).text).toBe('Built and logged. Nothing was mailed, because outbound e-mail is off.')
    expect(digestSendResult({ reason: 'No recipients set' }, 200)).toEqual({ ok: false, text: 'No recipients set' })
    expect(digestSendResult(null, 500)).toEqual({ ok: false, text: 'It could not be sent (500).' })
  })
})

describe('each change', () => {
  it('field, maker and the before → after line in words', () => {
    expect(fieldWords('bidCents')).toBe('Bid cents')
    expect(fieldWords('daily_budget')).toBe('Daily budget')
    expect(whoMade(change())).toBe('Rank defend')
    expect(whoMade(change({ origin: { kind: 'rule', id: 'r1', name: 'Cut wasted keywords' } }))).toBe('Cut wasted keywords')
    expect(whoMade(change({ actor: 'user:u1' }))).toBe('A person')
    expect(changeLine(change())).toEqual({ label: 'Bid cents', from: '€0.70', to: '€0.95' })
  })

  it('delivery keeps the server’s word, coloured by what it means', () => {
    expect(deliveryWords({ state: 'FAILED', attempts: 3, lastError: 'x' })).toEqual({ label: 'Failed', tone: 'danger' })
    expect(deliveryWords({ state: 'GATED', attempts: 0, lastError: null })?.tone).toBe('warning')
    // The real states the old Activity tab coloured (control-room.css): in flight is on its way; cancelled and
    // superseded never reached Amazon.
    expect(deliveryWords({ state: 'IN_FLIGHT', attempts: 1, lastError: null })?.tone).toBe('info')
    expect(deliveryWords({ state: 'CANCELLED', attempts: 0, lastError: null })?.tone).toBe('warning')
    expect(deliveryWords({ state: 'SUPERSEDED', attempts: 0, lastError: null })?.tone).toBe('warning')
    expect(deliveryWords({ state: 'APPLIED', attempts: 1, lastError: null })?.tone).toBe('success')
    expect(deliveryWords({ state: 'PENDING', attempts: 0, lastError: null })?.tone).toBe('info')
    expect(deliveryWords(null)).toBeNull()
  })

  it('thin evidence is marked, never hidden', () => {
    expect(evidenceWords({ metric: 'ACoS', observed: 61, threshold: 40, sampleSize: 3, sampleUnit: 'days' })).toEqual({ text: 'ACoS 61 against 40 · 3 days — thin', thin: true })
    expect(evidenceWords({ metric: 'clicks', observed: 22, sampleSize: 30, sampleUnit: 'days' })).toEqual({ text: 'clicks 22 · 30 days', thin: false })
    expect(evidenceWords({ foo: 1 })).toBeNull()
  })

  it('search and Made by filter the rows', () => {
    const rows = [change(), change({ id: 'c2', origin: { kind: 'rule', id: 'r1', name: 'Cut wasted keywords' }, campaign: { id: 'cp2', name: 'Demo · Gloves' } })]
    expect(makersOf(rows)).toEqual(['Cut wasted keywords', 'Rank defend'])
    expect(rows.filter((c) => changeMatches(c, { search: 'gloves', who: ALL_MAKERS })).map((c) => c.id)).toEqual(['c2'])
    expect(rows.filter((c) => changeMatches(c, { search: '', who: 'Rank defend' })).map((c) => c.id)).toEqual(['c1'])
  })

  it('THE REGRESSION: Undo asks with the design system’s confirmation, naming the value it puts back', () => {
    const impact = undoImpact(change())
    expect(impact.title).toBe('Undo this change to bid cents?')
    expect(impact.consequences?.[0]).toBe('Bid cents on Demo · Full-face helmets goes back to €0.70 (now €0.95).')
    expect(validateImpact(impact)).toEqual([])
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })

  it('the undo result reads the body: a 200 with nothing reversed is not "undone"', () => {
    expect(undoResult(true, 200, { ok: true, reversed: 1 })).toEqual({ ok: true, text: 'Undone. The earlier value is on its way back to Amazon.' })
    expect(undoResult(true, 200, { ok: true, reversed: 0, nothingToUndo: true })).toEqual({ ok: false, text: 'Nothing to undo.' })
    expect(undoResult(false, 409, { ok: false, reason: 'Outside the undo window' })).toEqual({ ok: false, text: 'Outside the undo window' })
  })
})

describe('the next 24 hours', () => {
  const hour = (over: Partial<ForesightHour>): ForesightHour => ({ at: '2026-10-06T10:00:00.000Z', hour: 12, bidChanges: 0, suppressed: 0, unbounded: 0, noCpcCeiling: 0, engineRuns: [], targets: [], ...over })

  it('only the hours that hold a planned bid change', () => {
    expect(busyHours([hour({ hour: 12 }), hour({ hour: 13, bidChanges: 4 }), hour({ hour: 14 })]).map((h) => h.hour)).toEqual([13])
  })

  it('an hour’s flags in words, only the ones it has', () => {
    expect(hourFlags(hour({ noCpcCeiling: 2, suppressed: 1 })).map((f) => f.label)).toEqual(['2 with no bid ceiling', '1 at the lowest bid'])
    expect(hourFlags(hour({}))).toEqual([])
  })

  it('THE REGRESSION: the notes never show a server variable name; the raw sentences go to Technical details', () => {
    const raw = 'Hourly bid plans (NEXUS_ENABLE_AMAZON_ADS_CRON is off — the whole ads fleet is dormant).'
    const notes = plainNotes([raw, raw, 'No schedule is enabled, so no bid change is scheduled.'])
    expect(notes.plain.join(' ')).not.toMatch(/NEXUS_/)
    expect(notes.plain).toHaveLength(2)
    // Every raw note the plain list rewrote is kept once, word for word.
    expect(notes.technical).toEqual([raw, 'No schedule is enabled, so no bid change is scheduled.'])
  })

  it('the cadence in the account’s clock; an engine that cannot write says why in plain words', () => {
    expect(cadenceIn({ cadence: 'every 15 min', nextFires: [] }, 'Europe/Rome')).toBe('every 15 min')
    expect(cadenceIn({ cadence: 'daily 06:30 UTC', nextFires: ['2026-10-07T06:30:00.000Z'] }, 'Europe/Rome')).toBe('daily 08:30')
    expect(engineCanWords({ key: 'k', name: 'n', cron: '', cadence: '', fires: 1, nextFires: [], canWrite: false, blockedReason: 'NEXUS_ENABLE_AMAZON_ADS_CRON is off.' }))
      .toEqual({ label: 'No', tone: 'neutral', why: 'The server keeps it off.' })
  })
})

describe('CR review — History in honest, plain words', () => {
  it('THE REGRESSION: with the default spend limit, History says the limit — never "no hourly limit"', () => {
    const b = digest().breaker
    expect(spendLimitWords({ ...b, spendThresholdIsDefault: true })).toEqual({
      title: 'Ad spend limit: €500 an hour (the default)',
      text: 'You have not set your own. Change it in Limits › Account brakes.',
    })
    expect(spendLimitWords({ ...b, spendThresholdIsDefault: true, peakHoursSampled: 12, peakHourSpendCents: 1890 })?.text)
      .toBe('You have not set your own. Change it in Limits › Account brakes. The highest hour this week was €18.90.')
    expect(spendLimitWords(b)).toBeNull() // a limit of the person's own: nothing to point out
  })

  it('the weekly e-mail has one name, says what its state means, and Build never mentions a Monday run', () => {
    const off = digestState(digest().gates)
    expect(off.text).toBe('Nothing is sent by itself. You can still preview last week’s e-mail, or build it now.')
    expect(JSON.stringify(off)).not.toMatch(/digest|NEXUS_/i)
    const build = digestSendImpact(digest().gates)
    expect(build.confirmLabel).toBe('Build the e-mail')
    expect(build.consequences?.join(' ')).not.toMatch(/Monday/)
    expect(digestSendImpact({ ...digest().gates, outboundEnabled: true, state: 'live' }).confirmLabel).toBe('Send the e-mail now')
  })

  it('Undo names its action, and its way back is a real step', () => {
    const impact = undoImpact(change())
    expect(impact.confirmLabel).toBe('Undo this change')
    expect(impact.reversal?.verb).toBe('Set the value again by hand')
    expect(validateImpact(impact)).toEqual([])
  })

  it('the time zone and the schedules in words', () => {
    expect(zoneWords('Europe/Rome')).toBe('Rome time')
    expect(zoneWords('America/New_York')).toBe('New York time')
    expect(zoneWords('UTC')).toBe('UTC')
    expect(schedulesWords({ total: 0, enabled: 0 })).toBe('No schedule is set up')
    expect(schedulesWords({ total: 3, enabled: 0 })).toBe('No schedule is on (3 set up)')
    expect(schedulesWords({ total: 5, enabled: 2 })).toBe('from 2 of 5 schedules, the ones that are on')
  })

  it('the server notes in plain words: no "tick", no "suppression target", no "CPC ceiling", no variable names', () => {
    expect(plainNote('No schedule is enabled, so no bid change is scheduled. The engines below still tick.'))
      .toBe('No schedule is on, so no bid change is planned. The engines below still run on their own clock.')
    expect(plainNote('3 hours hold a suppression target. That floors bids to about 2¢ and leaves the campaign ENABLED — delivery continues at a low bid; nothing pauses.'))
      .toBe('In 3 hours, a schedule holds bids at about 2 cents. The ads keep running; nothing pauses.')
    expect(plainNote('2 of the next 24 hours run at least one schedule all-out with no CPC ceiling. In those hours nothing bounds the bid but Amazon\'s own 900% cap.'))
      .toBe('In 2 of the next 24 hours, at least one schedule bids with no limit but Amazon’s own.')
    expect(plainNote('8 engines will run but cannot write: Hourly bid plans (NEXUS_ENABLE_AMAZON_ADS_CRON is off — the whole ads fleet is dormant).'))
      .toBe('8 engines run but cannot change your ads. The Engines list says why.')
    expect(plainNote('Automation is stopped, so none of the 4 scheduled bid changes below will reach Amazon.')).toBeNull() // the banner says it
  })

  it('CODE #9: the account level holds the engines too, so this view and the top tile never disagree', () => {
    const e: ForesightEngine = { key: 'k', name: 'Bid optimiser', cron: '', cadence: '', fires: 4, nextFires: [], canWrite: true, blockedReason: null }
    const auto = { autonomy: 'AUTO', halted: false, envKill: false }
    expect(engineCanWords(e, auto)).toEqual({ label: 'Yes', tone: 'success', why: null })
    expect(engineCanWords(e, { ...auto, autonomy: 'SUGGEST' })).toEqual({ label: 'Only records', tone: 'neutral', why: 'The account level is Ask me, so it only records what it would change.' })
    expect(engineCanWords(e, { ...auto, halted: true }).label).toBe('No')
    expect(enginesThatCan([e, e], { ...auto, autonomy: 'SUGGEST' })).toBe(0)
    expect(enginesThatCan([e, e], auto)).toBe(2)
    expect(enginesThatCan([e], undefined)).toBe(1) // not known: the server's view alone
    expect(accountHoldWords({ ...auto, autonomy: 'SUGGEST' }, false)?.title).toBe('The account level is Ask me')
    expect(accountHoldWords(auto, true)?.title).toBe('Automation is stopped')
    expect(accountHoldWords(auto, false)).toBeNull()
  })
})
