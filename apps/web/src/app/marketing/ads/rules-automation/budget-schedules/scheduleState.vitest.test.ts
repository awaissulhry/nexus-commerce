/**
 * BSP-P5 — the first tests the LIVE Budget Schedules surface has ever had.
 *
 * The tab already shipped two vitest files (`planMath`, `urlState`), and both test **parked** code:
 * `BudgetSchedulesClient.tsx` has had no importer since U8. Everything the operator actually reads
 * on this tab was untested.
 */
import { describe, expect, it } from 'vitest'
import { deliveryCell, describeYields, localDayKey, scheduleStatus, type ScheduleDelivery } from './scheduleState'

const delivery = (o: Partial<ScheduleDelivery> = {}): ScheduleDelivery => ({
  campaigns: 0, applied: 0, held: 0, yielded: 0, refused: 0, failed: 0,
  delivered: 0, notDelivered: 0, unknown: 0, lastError: null, ...o,
})

describe('localDayKey', () => {
  /**
   * 🔴 The regression this exists for. `toISOString().slice(0,10)` is UTC; the dates it was compared
   * against are the local calendar dates an operator typed. Assert the RELATIONSHIP — that the key
   * matches the LOCAL calendar — so the test is meaningful in any zone, rather than pinning an
   * offset that only fails in some. [[reference_day_grouping_utc_local_trap]]
   */
  it('matches the local calendar date, not the UTC one', () => {
    const d = new Date('2026-08-21T23:30:00Z')
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(localDayKey(d)).toBe(expected)
  })

  it('east of UTC, just after local midnight, it is already the NEW day (the old code said yesterday)', () => {
    // 00:30 in Rome on 22 August is 22:30 UTC on the 21st. The UTC key would say 2026-08-21.
    const d = new Date('2026-08-21T22:30:00Z')
    if (d.getHours() === 0 && d.getDate() === 22) {
      expect(localDayKey(d)).toBe('2026-08-22')
      expect(localDayKey(d)).not.toBe(d.toISOString().slice(0, 10))
    } else {
      // In a zone where that instant is not just-after-midnight the premise does not apply; the
      // invariant above still holds and is what this suite guarantees everywhere.
      expect(localDayKey(d)).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
  })

  it('pads single-digit months and days', () => {
    expect(localDayKey(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })
})

describe('scheduleStatus', () => {
  const row = (o: Partial<Parameters<typeof scheduleStatus>[0]> = {}) => ({
    name: 'S', enabled: true, startDate: '2026-08-01', endDate: '2026-08-31', delivery: null, ...o,
  })

  it('a disabled schedule is Off, whatever its dates say', () => {
    expect(scheduleStatus(row({ enabled: false }), '2026-08-21').word).toBe('Off')
  })

  it('before the start it is Scheduled; after the end it is Completed', () => {
    expect(scheduleStatus(row(), '2026-07-31').word).toBe('Scheduled')
    expect(scheduleStatus(row(), '2026-09-01').word).toBe('Completed')
  })

  it('an unbounded side never ends the schedule', () => {
    expect(scheduleStatus(row({ endDate: '—' }), '2030-01-01').word).toBe('Active')
    expect(scheduleStatus(row({ startDate: '—' }), '2020-01-01').word).toBe('Active')
  })

  it('in range with a clean delivery it is Active', () => {
    expect(scheduleStatus(row({ delivery: delivery({ campaigns: 3, delivered: 3 }) }), '2026-08-21').word).toBe('Active')
  })

  /**
   * 🔴 The BSP-P3 regression. Every one of these used to render the plain "Active" pill whose
   * tooltip said "the weekly windows decide each campaign's budget right now" — which is exactly
   * what was NOT happening.
   */
  it.each([
    ['another writer took the budget', delivery({ campaigns: 3, yielded: 1 })],
    ['the write never reached Amazon', delivery({ campaigns: 3, notDelivered: 2 })],
    ['the mutation layer refused it', delivery({ campaigns: 3, refused: 1 })],
    ['the call threw', delivery({ campaigns: 3, failed: 1 })],
  ])('says "not in force" when %s', (_why, d) => {
    const s = scheduleStatus(row({ delivery: d }), '2026-08-21')
    expect(s.word).toBe('Active · not in force')
    expect(s.why).not.toContain('decide each campaign’s budget right now')
  })

  it('the Completed/Scheduled words outrank a contested delivery — dates first', () => {
    expect(scheduleStatus(row({ delivery: delivery({ campaigns: 2, yielded: 2 }) }), '2026-09-01').word).toBe('Completed')
  })
})

describe('deliveryCell', () => {
  it('no delivery record at all is a dash, never a success', () => {
    expect(deliveryCell(null).word).toBe('—')
    expect(deliveryCell(delivery()).word).toBe('—')
  })

  /** 🔴 The whole point of the column: "applied" is a local write, not a landed one. */
  it('a write the gate skipped reads "not at Amazon", and carries the gate reason', () => {
    const c = deliveryCell(delivery({ campaigns: 4, applied: 4, delivered: 1, notDelivered: 3, lastError: '[ADS-WRITE-GATE-DENY] budget_day_move: …' }))
    expect(c.word).toBe('3 not at Amazon')
    expect(c.cls).toBe('bad')
    expect(c.why).toContain('budget_day_move')
    expect(c.why).toContain('The local budget was changed; the channel was not.')
  })

  it('a non-delivery outranks a partial success — half-landed is not landed', () => {
    expect(deliveryCell(delivery({ campaigns: 5, delivered: 4, notDelivered: 1 })).word).toBe('1 not at Amazon')
  })

  it('a refusal outranks a yield, and a yield outranks in-flight', () => {
    expect(deliveryCell(delivery({ campaigns: 3, refused: 1, yielded: 1 })).word).toBe('1 refused')
    expect(deliveryCell(delivery({ campaigns: 3, yielded: 1, unknown: 1 })).word).toBe('1 yielded')
  })

  it('a yield explains that those campaigns are NOT on their window value', () => {
    expect(deliveryCell(delivery({ campaigns: 3, yielded: 2 })).why).toContain('NOT on their window value')
  })

  it('confirmed delivery is the only green word', () => {
    const c = deliveryCell(delivery({ campaigns: 2, delivered: 2 }))
    expect(c.word).toBe('2 at Amazon')
    expect(c.cls).toBe('ok')
  })

  it('everything already on target is "nothing to do" — not a delivery claim', () => {
    const c = deliveryCell(delivery({ campaigns: 6, held: 6 }))
    expect(c.word).toBe('nothing to do')
    expect(c.cls).toBe('none')
  })
})

/**
 * BSP.6 item 2 — the yield names its counterparty. These pin the distinction the old single word
 * hid: yielding to the pacer is the monthly envelope working, yielding to a rule is an automation
 * conflict, and yielding to the operator's own hand is not a conflict at all.
 */
describe('describeYields + deliveryCell attribution (BSP.6)', () => {
  const yielded = (by: Array<{ kind: string; label: string; count: number }>, n: number, campaigns = 6) =>
    delivery({ campaigns, yielded: n, yieldedBy: by })

  it('names a single counterparty and explains the ownership rule', () => {
    const d = yielded([{ kind: 'pacer', label: 'the budget pacer holding the monthly envelope', count: 4 }], 4)
    const s = describeYields(d)
    expect(s).toContain('4 to the budget pacer holding the monthly envelope')
    expect(s).toContain('owns a campaign only while its own window is open')
  })

  it('lists several counterparties in one readable sentence', () => {
    const d = yielded([
      { kind: 'pacer', label: 'the budget pacer holding the monthly envelope', count: 3 },
      { kind: 'rule', label: 'the rule “Reclaim idle budget — DE”', count: 1 },
      { kind: 'operator', label: 'you, by hand', count: 1 },
    ], 5)
    const s = describeYields(d)
    expect(s).toContain('3 to the budget pacer holding the monthly envelope')
    expect(s).toContain('and 1 to you, by hand')
    expect(s).toContain('the rule “Reclaim idle budget — DE”')
  })

  it('a yield with no attribution says so plainly rather than blaming anyone', () => {
    const s = describeYields(delivery({ campaigns: 3, yielded: 2 }))
    expect(s).toContain('moved by another writer')
    expect(s).not.toContain('undefined')
    expect(s).not.toContain('to null')
  })

  it('🔴 an all-operator yield reads "held by you" — not an automation conflict to chase', () => {
    const c = deliveryCell(yielded([{ kind: 'operator', label: 'you, by hand', count: 2 }], 2))
    expect(c.word).toBe('2 held by you')
    expect(c.cls).toBe('warn')
  })

  it('a mixed yield keeps the neutral word, because it is not all your doing', () => {
    const c = deliveryCell(yielded([
      { kind: 'operator', label: 'you, by hand', count: 1 },
      { kind: 'pacer', label: 'the budget pacer holding the monthly envelope', count: 1 },
    ], 2))
    expect(c.word).toBe('2 yielded')
  })

  it('the Status tooltip and the Delivery tooltip tell the SAME story', () => {
    const d = yielded([{ kind: 'pacer', label: 'the budget pacer holding the monthly envelope', count: 4 }], 4)
    const status = scheduleStatus({ name: 'S', enabled: true, startDate: '2026-08-01', endDate: '—', delivery: d }, '2026-08-21')
    const cell = deliveryCell(d)
    const shared = describeYields(d)
    expect(status.word).toBe('Active · not in force')
    expect(status.why).toContain(shared)
    expect(cell.why).toContain(shared)
  })

  it('a not-delivered failure still outranks a yield — the channel matters more than the conflict', () => {
    const c = deliveryCell(delivery({ campaigns: 5, yielded: 2, notDelivered: 1, yieldedBy: [{ kind: 'pacer', label: 'the pacer', count: 2 }] }))
    expect(c.word).toBe('1 not at Amazon')
  })
})

/**
 * BSP.6 — punctuation, because a shared fragment that punctuates itself collides with every caller
 * that punctuates too. Caught on the rendered screen, not in the diff: the Status tooltip read
 * "…rather than re-fighting.. See the Delivery column."
 */
describe('tooltip prose is well-formed', () => {
  const cases: ScheduleDelivery[] = [
    delivery({ campaigns: 6, yielded: 4, yieldedBy: [{ kind: 'pacer', label: 'the budget pacer holding the monthly envelope', count: 3 }, { kind: 'rule', label: 'the rule “X”', count: 1 }] }),
    delivery({ campaigns: 2, yielded: 2, yieldedBy: [{ kind: 'operator', label: 'you, by hand', count: 2 }] }),
    delivery({ campaigns: 3, yielded: 1 }),
    delivery({ campaigns: 4, notDelivered: 2, lastError: 'gate' }),
    delivery({ campaigns: 4, refused: 1 }),
    delivery({ campaigns: 4, unknown: 2 }),
    delivery({ campaigns: 4, delivered: 4 }),
    delivery({ campaigns: 4, held: 4 }),
  ]

  it('no tooltip contains a doubled period, a doubled space, or a dangling separator', () => {
    for (const d of cases) {
      for (const why of [deliveryCell(d).why, scheduleStatus({ name: 'S', enabled: true, startDate: '2026-08-01', endDate: '—', delivery: d }, '2026-08-21').why]) {
        expect(why, why).not.toMatch(/\.\./)
        expect(why, why).not.toMatch(/ {2}/)
        expect(why, why).not.toMatch(/[—;,]\s*$/)
        expect(why, why).toMatch(/\.$/)
        expect(why, why).not.toContain('undefined')
      }
    }
  })

  it('describeYields is a CLAUSE — it never punctuates its own end', () => {
    for (const d of cases.filter((x) => x.yielded > 0)) {
      expect(describeYields(d)).not.toMatch(/[.;]$/)
    }
  })
})
