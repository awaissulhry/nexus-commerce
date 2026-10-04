/**
 * W4 (2026-08-20) — first tests this executor has ever had. They pin the two pure functions;
 * the write path is exercised on prod by clicking, not here.
 */
import { describe, expect, it } from 'vitest'
import { activeWindow, classifyOverride, computeBudget, dateActive, decideCampaign, giveBackCheck, GIVE_BACK_RETRIES, missedGiveBackRecord, ownCentsOf, type ActiveWindow, type BSApplied } from './ad-budget-schedule.job.js'

describe('computeBudget', () => {
  it('multiplier multiplies the base; 0/absent value means ×1, never ×0', () => {
    expect(computeBudget(10, 'budget-multiplier', undefined, 2)).toBe(20)
    expect(computeBudget(10, 'budget-multiplier', undefined, 0)).toBe(10)
    expect(computeBudget(10, 'budget-multiplier', undefined, undefined)).toBe(10)
  })

  it('campaign-budget: set / incPct / decPct', () => {
    expect(computeBudget(10, 'campaign-budget', 'set', 25)).toBe(25)
    expect(computeBudget(10, 'campaign-budget', 'incPct', 50)).toBe(15)
    expect(computeBudget(10, 'campaign-budget', 'decPct', 30)).toBe(7)
  })

  it('clamps to Amazon’s €1 floor and rounds to cents', () => {
    expect(computeBudget(2, 'campaign-budget', 'decPct', 90)).toBe(1)
    expect(computeBudget(3.333, 'campaign-budget', 'incPct', 10)).toBe(3.67)
  })
})

describe('dateActive', () => {
  const base = { startDate: new Date('2026-08-10'), endDate: new Date('2026-08-30'), neverExpire: false }
  const on = (iso: string) => new Date(`${iso}T09:00:00Z`)

  it('inside the range with no blackouts', () => {
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-20'))).toBe(true)
  })

  it('before start and after end are inactive; neverExpire ignores the end', () => {
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-09'))).toBe(false)
    expect(dateActive({ ...base, excludeDates: [] }, on('2026-08-31'))).toBe(false)
    expect(dateActive({ ...base, neverExpire: true, excludeDates: [] }, on('2026-09-15'))).toBe(true)
  })

  it('🔴 a blackout range covers its END day inclusively (the W4 fix)', () => {
    const s = { ...base, excludeDates: [{ start: '2026-08-25', end: '2026-08-26' }] }
    expect(dateActive(s, on('2026-08-24'))).toBe(true)
    expect(dateActive(s, on('2026-08-25'))).toBe(false)
    // Before the fix this day was ACTIVE: date-only ISO parses to UTC midnight, "today" is pinned
    // to UTC noon, so `today <= end` failed on the operator's own chosen end date.
    expect(dateActive(s, on('2026-08-26'))).toBe(false)
    expect(dateActive(s, on('2026-08-27'))).toBe(true)
  })

  it('a half-empty or boolean-era excludeDates entry is ignored, never a crash', () => {
    expect(dateActive({ ...base, excludeDates: [{ start: '2026-08-25' }] }, on('2026-08-25'))).toBe(true)
    expect(dateActive({ ...base, excludeDates: true }, on('2026-08-20'))).toBe(true)
  })
})

/**
 * BSP-P5 (2026-08-21) — `activeWindow` is the function that decides whether a budget schedule does
 * anything at all, and until now it had no test at all. It carries three branches that are almost
 * impossible to catch by looking: the midnight wrap, the post-midnight weekday shift, and the
 * all-day (Budget Multiplier) window that BSP-P4 finally made authorable.
 *
 * Times are pinned in UTC and read in Europe/Rome, so these assert the RELATIONSHIP (what the
 * executor believes the local weekday and clock are) rather than a frozen offset.
 */
describe('activeWindow', () => {
  const TZ = 'Europe/Rome'
  // 2026-08-21 is a Friday. Rome is UTC+2 in August.
  const at = (utc: string) => new Date(utc)

  it('an ordinary window matches only inside its own hours, on its own weekday', () => {
    const w = [{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }] // Fri 18–20 Rome
    expect(activeWindow(w, TZ, at('2026-08-21T17:00:00Z'))?.win).toBeTruthy()   // 19:00 Rome, Friday
    expect(activeWindow(w, TZ, at('2026-08-21T15:00:00Z'))).toBeNull()     // 17:00 Rome — before
    expect(activeWindow(w, TZ, at('2026-08-21T18:00:00Z'))).toBeNull()     // 20:00 Rome — end is exclusive
    expect(activeWindow(w, TZ, at('2026-08-22T17:00:00Z'))).toBeNull()     // Saturday
  })

  it('🔴 a wrapping window covers hour 23 AND the post-midnight half, under the FOLLOWING weekday', () => {
    // BSP.2 §2.1 — `23:00 → 02:00` on Friday. Hour 23 was unreachable before that fix; the
    // post-midnight half belongs to Saturday's clock but to Friday's row.
    const w = [{ day: 5, start: '23:00', end: '02:00', adj: 'set', value: 30 }]
    expect(activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))?.win).toBeTruthy()   // 23:30 Rome Friday
    expect(activeWindow(w, TZ, at('2026-08-21T23:30:00Z'))?.win).toBeTruthy()   // 01:30 Rome SATURDAY
    expect(activeWindow(w, TZ, at('2026-08-22T00:30:00Z'))).toBeNull()     // 02:30 Rome — past the end
    expect(activeWindow(w, TZ, at('2026-08-22T21:30:00Z'))).toBeNull()     // 23:30 Rome Saturday — wrong day
  })

  it('a degenerate window (start === end) is never active, not silently all-day', () => {
    const w = [{ day: 5, start: '12:00', end: '12:00', adj: 'set', value: 9 }]
    expect(activeWindow(w, TZ, at('2026-08-21T10:00:00Z'))).toBeNull()
    expect(activeWindow(w, TZ, at('2026-08-21T13:00:00Z'))).toBeNull()
  })

  it('🔴 BSP-P4 — a window with NO hours is all-day, which is what Budget Multiplier now writes', () => {
    // The engine has always supported this; before BSP-P4 the builder could not express it,
    // because `winComplete` demanded both times. These pin the branch the form now reaches.
    const w = [{ day: 5, start: '', end: '', adj: 'mult', value: 1.5 }]
    expect(activeWindow(w, TZ, at('2026-08-21T00:30:00Z'))?.win).toBeTruthy()   // 02:30 Rome Friday
    expect(activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))?.win).toBeTruthy()   // 23:30 Rome Friday
    expect(activeWindow(w, TZ, at('2026-08-22T10:00:00Z'))).toBeNull()     // Saturday
  })

  it('picks the first matching window when several overlap — the documented precedence', () => {
    const w = [
      { day: 5, start: '10:00', end: '20:00', adj: 'set', value: 10 },
      { day: 5, start: '18:00', end: '20:00', adj: 'set', value: 99 },
    ]
    expect(activeWindow(w, TZ, at('2026-08-21T17:00:00Z'))?.win.value).toBe(10)
  })

  it('no windows at all is null, never a crash', () => {
    expect(activeWindow([], TZ, at('2026-08-21T17:00:00Z'))).toBeNull()
  })
})

/**
 * BSP.6 — the window ENTRY key. This is what turns "once per window" from an accident of
 * value-keyed memoisation into a stated rule, and every one of these cases is a way the old
 * value key got it wrong.
 */
describe('activeWindow — the entry key (BSP.6)', () => {
  const TZ = 'Europe/Rome'
  const at = (utc: string) => new Date(utc)

  it('the key is stable across every tick of one entry, so the schedule writes once', () => {
    const w = [{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }]
    const a = activeWindow(w, TZ, at('2026-08-21T16:01:00Z'))!  // 18:01 Rome
    const b = activeWindow(w, TZ, at('2026-08-21T17:46:00Z'))!  // 19:46 Rome, same entry
    expect(a.key).toBe(b.key)
    expect(a.entryDate).toBe('2026-08-21')
  })

  it('🔴 a WRAPPING window is ONE entry across midnight — the post-midnight half keeps the OPENING date', () => {
    // The failure this prevents: keying on "today" would make 00:00 look like a second entry and
    // the schedule would write twice for one window.
    const w = [{ day: 5, start: '23:00', end: '02:00', adj: 'set', value: 30 }]
    const before = activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))!  // 23:30 Fri Rome
    const after = activeWindow(w, TZ, at('2026-08-21T23:30:00Z'))!   // 01:30 SAT Rome
    expect(before.entryDate).toBe('2026-08-21')
    expect(after.entryDate).toBe('2026-08-21')
    expect(after.key).toBe(before.key)
  })

  it('the NEXT day is a new entry, so the schedule re-arms — the bug the value key could hide', () => {
    const w = [{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }]
    const fri = activeWindow(w, TZ, at('2026-08-21T17:00:00Z'))!
    const nextFri = activeWindow(w, TZ, at('2026-08-28T17:00:00Z'))!
    expect(nextFri.key).not.toBe(fri.key)
    expect(nextFri.entryDate).toBe('2026-08-28')
  })

  it('editing the window changes the key — a changed instruction is carried out', () => {
    const before = activeWindow([{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }], TZ, at('2026-08-21T17:00:00Z'))!
    const after = activeWindow([{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 25 }], TZ, at('2026-08-21T17:00:00Z'))!
    expect(after.key).not.toBe(before.key)
  })

  it('adding an unrelated row does NOT change the matched window’s key — content, not index', () => {
    const one = activeWindow([{ day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }], TZ, at('2026-08-21T17:00:00Z'))!
    const two = activeWindow(
      [{ day: 2, start: '09:00', end: '10:00', adj: 'set', value: 5 }, { day: 5, start: '18:00', end: '20:00', adj: 'set', value: 20 }],
      TZ, at('2026-08-21T17:00:00Z'))!
    expect(two.key).toBe(one.key)
  })

  it('an all-day (multiplier) window keys on the calendar day and re-arms daily', () => {
    const w = [{ day: 5, start: '', end: '', adj: 'mult', value: 1.5 }]
    const early = activeWindow(w, TZ, at('2026-08-21T00:30:00Z'))!  // 02:30 Rome Fri
    const late = activeWindow(w, TZ, at('2026-08-21T21:30:00Z'))!   // 23:30 Rome Fri
    expect(early.key).toBe(late.key)
    expect(activeWindow(w, TZ, at('2026-08-28T10:00:00Z'))!.key).not.toBe(early.key)
  })

  it('🔴 the entry date is the SCHEDULE’s timezone, not UTC', () => {
    // 22:30 UTC on the 21st is 00:30 on the 22nd in Rome. A UTC date would file this entry under
    // the 21st and the schedule would think it had already run. [[reference_day_grouping_utc_local_trap]]
    const w = [{ day: 6, start: '00:00', end: '03:00', adj: 'set', value: 12 }] // Saturday, early
    const a = activeWindow(w, TZ, at('2026-08-21T22:30:00Z'))!
    expect(a.entryDate).toBe('2026-08-22')
    expect(a.entryDate).not.toBe('2026-08-21')
  })
})

describe('classifyOverride — who took the budget (BSP.6 item 2)', () => {
  it('the pacer is named as the envelope holder, because yielding to it is CORRECT', () => {
    const c = classifyOverride('automation:budget-manager-cron')
    expect(c.kind).toBe('pacer')
    expect(c.label).toContain('monthly envelope')
  })

  it('a bare cuid is a rule — the SG.0 actor shape', () => {
    expect(classifyOverride('automation:cmt3byq3i00arl901dwu06y4u').kind).toBe('rule')
  })

  it('another budget schedule is distinguished from a rule', () => {
    expect(classifyOverride('automation:budget-schedule-cmt3byq3i00arl901dwu06y4u').kind).toBe('schedule')
  })

  it('a human override says so plainly', () => {
    expect(classifyOverride('user:awais').kind).toBe('operator')
    expect(classifyOverride('awais').kind).toBe('operator')
  })

  it('an unknown automation is a named job, never blamed on the operator', () => {
    const c = classifyOverride('automation:ads-write-reconcile')
    expect(c.kind).toBe('job')
    expect(c.label).toBe('ads write reconcile')
  })

  it('a missing actor is unattributed rather than assigned to anyone', () => {
    expect(classifyOverride(null).kind).toBe('job')
    expect(classifyOverride(null).label).toContain('unattributed')
  })
})

/**
 * 3b (review 6.2, 6.3, 6.6, 6.5 pause/delete) — what a give-back puts back, and when. `decideCampaign` is
 * the whole decision for one campaign; these pin each branch with the numbers from the review.
 */
describe('decideCampaign — the base is the budget before the window; give back only what the schedule holds (3b)', () => {
  const NOW = new Date('2026-10-05T10:00:00Z')
  const KEY = '2026-10-05#1||||incPct|50'
  const RESTORE_KEY = `${KEY}#restore`
  const open = (value = 50, key = KEY): ActiveWindow => ({ win: { day: 1, adj: 'incPct', value }, entryDate: '2026-10-05', key })
  const ctx = (o: Partial<Parameters<typeof decideCampaign>[4]> = {}) => ({ type: 'CAMPAIGN_BUDGET', now: NOW, ...o })
  const entered = (o: Partial<BSApplied> = {}): BSApplied => ({ budget: 15, at: '2026-10-05T08:00:00Z', state: 'applied', live: 10, windowKey: KEY, baseCents: 1000, ownCents: 1500, outboundQueueId: 'q-enter', ...o })
  const gaveBack = (o: Partial<BSApplied> = {}): BSApplied => ({ budget: 10, at: '2026-10-05T12:00:00Z', state: 'applied', live: 15, windowKey: RESTORE_KEY, baseCents: 1000, ownCents: 1500, outboundQueueId: 'q-back', attempts: 1, nextRetryAt: '2026-10-05T13:00:00Z', ...o })

  it('🔴 6.3 — the base is the live budget at window entry, not the creation-time snapshot: €10 → €20 by hand, then "+20%" writes €24 (it wrote €12)', () => {
    const d = decideCampaign(undefined, 2000, open(20), 1000, ctx())
    expect(d).toMatchObject({ act: 'write', purpose: 'enter', targetCents: 2400, baseCents: 2000, ownCents: 2400, windowKey: KEY })
  })

  it('S14 — still at the value this schedule set (a give-back not landed, back-to-back windows): the base recorded before stands', () => {
    const d = decideCampaign(gaveBack({ state: 'applied' }), 1500, open(50, '2026-10-06#1||||incPct|50'), null, ctx())
    // €15 is the schedule's own value, so the base stays €10 and +50% is €15 again — nothing to write.
    expect(d).toMatchObject({ act: 'keep', record: { state: 'held', baseCents: 1000, ownCents: 1500, windowKey: '2026-10-06#1||||incPct|50' } })
  })

  it('inside its own entry: at its value → held; moved by anyone → yielded, the receipts carried, no write', () => {
    expect(decideCampaign(entered(), 1500, open(), null, ctx())).toMatchObject({ act: 'keep', record: { state: 'held', windowKey: KEY } })
    const d = decideCampaign(entered({ overriddenBy: { kind: 'pacer', label: 'old', actor: 'a', at: 'b' } }), 1800, open(), null, ctx())
    expect(d).toMatchObject({ act: 'keep', outcome: 'yielded', record: { state: 'yielded', live: 18, windowKey: KEY, outboundQueueId: 'q-enter' } })
    expect((d as { record: BSApplied }).record.overriddenBy).toBeUndefined() // re-resolved by the caller, never carried stale
  })

  it('the window closes while the campaign is at the schedule’s value → give back the base, carrying giveBackOf', () => {
    expect(decideCampaign(entered(), 1500, null, null, ctx())).toEqual({
      act: 'write', purpose: 'giveBack', windowKey: RESTORE_KEY, targetCents: 1000, baseCents: 1000, ownCents: 1500, attempts: 1, giveBackOf: KEY,
    })
  })

  it('🔴 6.2 — a person changed the budget inside the window → their change wins: yielded, no write', () => {
    const d = decideCampaign(entered({ state: 'yielded', live: 25 }), 2500, null, null, ctx())
    expect(d).toMatchObject({ act: 'keep', outcome: 'yielded', record: { state: 'yielded', live: 25, windowKey: RESTORE_KEY } })
  })

  it('already back at the base (the entry never reached Amazon and the sync copied it back) → held, nothing written', () => {
    expect(decideCampaign(entered(), 1000, null, null, ctx())).toMatchObject({ act: 'keep', record: { state: 'held', windowKey: RESTORE_KEY } })
  })

  it('🔴 6.6 — outside windows the record is KEPT: a delivered give-back, and a record older than BSP.6, stay as they are', () => {
    const done = gaveBack()
    expect(decideCampaign(done, 1000, null, null, ctx({ giveBack: { status: 'SUCCESS', error: null } }))).toEqual({ act: 'keep', record: done })
    const old: BSApplied = { budget: 15, at: '2026-08-01T00:00:00Z' }
    expect(decideCampaign(old, 1500, null, 1000, ctx())).toEqual({ act: 'keep', record: old })
    expect(decideCampaign(undefined, 1500, null, 1000, ctx())).toEqual({ act: 'none' })
  })

  it('a give-back the gate SKIPPED is tried again once an hour, but only once the campaign is back at the schedule’s value', () => {
    const skipped = { giveBack: { status: 'SKIPPED', error: '[ADS-WRITE-GATE-DENY] campaign_allowlist: not allowed' } }
    // Nexus still shows the base it wrote (the sync has not copied Amazon's value back): nothing to retry yet.
    expect(decideCampaign(gaveBack(), 1000, null, null, ctx(skipped))).toEqual({ act: 'keep', record: gaveBack() })
    // Back at €15, but within the hour: wait.
    expect(decideCampaign(gaveBack(), 1500, null, null, ctx({ ...skipped, now: new Date('2026-10-05T12:45:00Z') }))).toEqual({ act: 'keep', record: gaveBack() })
    // An hour on: the second try.
    expect(decideCampaign(gaveBack(), 1500, null, null, ctx({ ...skipped, now: new Date('2026-10-05T13:00:00Z') })))
      .toMatchObject({ act: 'write', purpose: 'giveBack', targetCents: 1000, attempts: 2, windowKey: RESTORE_KEY, giveBackOf: KEY })
    // Someone set a new budget meanwhile: theirs stays, never retried over.
    expect(decideCampaign(gaveBack(), 2200, null, null, ctx({ ...skipped, now: new Date('2026-10-05T14:00:00Z') }))).toEqual({ act: 'keep', record: gaveBack() })
    // Still queued, or delivered: nothing to retry.
    expect(decideCampaign(gaveBack(), 1500, null, null, ctx({ giveBack: { status: 'PENDING', error: null }, now: new Date('2026-10-05T14:00:00Z') })).act).toBe('keep')
  })

  it(`after ${GIVE_BACK_RETRIES} retries it is given up: shown as refused, no longer tried, no longer waiting on a queue row`, () => {
    const last = gaveBack({ attempts: GIVE_BACK_RETRIES + 1 })
    const d = decideCampaign(last, 1500, null, null, ctx({ giveBack: { status: 'SKIPPED', error: 'campaign_allowlist: not allowed' }, now: new Date('2026-10-06T14:00:00Z') }))
    expect(d).toMatchObject({ act: 'keep', outcome: 'refused', record: { state: 'refused', outboundQueueId: null, nextRetryAt: null, attempts: GIVE_BACK_RETRIES + 1 } })
    const rec = (d as { record: BSApplied }).record
    expect(rec.error).toBe(`not given back: ${GIVE_BACK_RETRIES + 1} tries did not reach Amazon (last: campaign_allowlist: not allowed). The campaign keeps €15.00; change it by hand if it should go back to €10.00`)
    // Given up stays given up.
    expect(decideCampaign(rec, 1500, null, null, ctx({ now: new Date('2026-10-07T14:00:00Z') }))).toEqual({ act: 'keep', record: rec })
  })

  it('a give-back refused before it was queued is tried again in an hour (not the next tick), and given up after the last try', () => {
    const d = decideCampaign(entered(), 1500, null, null, ctx()) as Extract<ReturnType<typeof decideCampaign>, { act: 'write' }>
    const missed = missedGiveBackRecord(entered(), d, NOW, 15, 'refused', 'not_found')
    expect(missed).toMatchObject({ state: 'refused', windowKey: KEY, attempts: 1, nextRetryAt: '2026-10-05T11:00:00.000Z', error: 'not_found' })
    expect(decideCampaign(missed, 1500, null, null, ctx({ now: new Date('2026-10-05T10:30:00Z') }))).toEqual({ act: 'keep', record: missed })
    expect(decideCampaign(missed, 1500, null, null, ctx({ now: new Date('2026-10-05T11:00:00Z') }))).toMatchObject({ act: 'write', purpose: 'giveBack', attempts: 2 })
    const final = missedGiveBackRecord(entered(), { ...d, attempts: GIVE_BACK_RETRIES + 1 }, NOW, 15, 'failed', 'boom')
    expect(final).toMatchObject({ state: 'refused', windowKey: RESTORE_KEY, nextRetryAt: null, outboundQueueId: null })
  })

  it('a record written before 3b gives back the creation-time snapshot (never the rules’ captured baseline)', () => {
    const legacy: BSApplied = { budget: 15, at: '2026-10-05T08:00:00Z', state: 'applied', windowKey: KEY }
    expect(decideCampaign(legacy, 1500, null, 1000, ctx())).toMatchObject({ act: 'write', purpose: 'giveBack', targetCents: 1000 })
  })
})

describe('giveBackCheck — the one check the executor and pause/delete share (3b)', () => {
  it('gives back only a budget the schedule set and still holds; anyone else’s change is kept', () => {
    const rec: BSApplied = { budget: 15, at: 't', state: 'applied', windowKey: 'k', baseCents: 1000, ownCents: 1500 }
    expect(giveBackCheck(rec, 1500, null)).toEqual({ act: 'giveBack', baseCents: 1000, ownCents: 1500 })
    expect(giveBackCheck(rec, 1700, null).act).toBe('kept')
    expect(giveBackCheck(rec, 1000, null).act).toBe('nothing')
  })

  it('🔴 6.5 — a campaign whose window was refused was never set by the schedule: nothing to give back', () => {
    const refused: BSApplied = { budget: 15, at: 't', state: 'refused', live: 15, error: 'not_found' }
    expect(ownCentsOf(refused)).toBeNull()
    expect(giveBackCheck(refused, 1500, 1000).act).toBe('nothing')
  })
})
