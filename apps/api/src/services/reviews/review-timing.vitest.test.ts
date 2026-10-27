/**
 * RRT.2 — resolver parity + behavior tests. Pure function, no DB/network.
 * The parity block is the gate: existing rules (sendDelayDays backfilled =
 * minDaysSinceDelivery, no hour/weekend, anchor DELIVERY) must reproduce the old
 * `deliveredAt + delay` exactly.
 */
import { describe, it, expect } from 'vitest'
import { inSendHours, nextDaySendSlot, nextSendSlot, resolveSendTiming, lookupTimingTable, windowHourFor, type TimingDefaultRow, type TimingRuleInput, type SendWindowRow } from './review-timing.service.js'

const DAY = 86_400_000
const DELIV = new Date('2026-06-10T08:00:00.000Z')
const TABLE: TimingDefaultRow[] = [
  { pattern: 'casco', delayDays: 21, isActive: true, sortOrder: 10 },
  { pattern: 'helmet', delayDays: 21, isActive: true, sortOrder: 11 },
  { pattern: 'suit', delayDays: 16, isActive: true, sortOrder: 22 },
  { pattern: 'giacca', delayDays: 14, isActive: true, sortOrder: 30 },
  { pattern: 'guant', delayDays: 10, isActive: true, sortOrder: 60 },
]
const rule = (o: Partial<TimingRuleInput> = {}): TimingRuleInput => ({
  sendDelayDays: null, anchor: 'DELIVERY', sendHourLocal: null, skipWeekends: false,
  minDaysSinceDelivery: 7, maxDaysSinceDelivery: 25, ...o,
})
const amz = (productType: string | null) => ({ channel: 'AMAZON', marketplace: 'IT', deliveredAt: DELIV, shippedAt: null, purchaseDate: null, productType })
const ebay = (o: Partial<ReturnType<typeof amz>> = {}) => ({ channel: 'EBAY', marketplace: 'IT', deliveredAt: DELIV, shippedAt: null, purchaseDate: null, productType: null, ...o })
const localHour = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(d)) % 24
const localDow = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(d)

describe('parity', () => {
  it('existing rule (sendDelayDays=7) → deliveredAt + 7d', () => {
    const r = resolveSendTiming(amz('Casco XL'), rule({ sendDelayDays: 7 }), TABLE)
    expect(r.scheduledFor?.getTime()).toBe(DELIV.getTime() + 7 * DAY)
    expect(r.source).toBe('rule-override')
  })
  it('no rule, helmet → table 21d', () => {
    const r = resolveSendTiming(amz('Casco Pro'), null, TABLE)
    expect(r.scheduledFor?.getTime()).toBe(DELIV.getTime() + 21 * DAY)
    expect(r.source).toBe('timing-table')
  })
  it('no rule, unknown product → DEFAULT 12d', () => {
    const r = resolveSendTiming(amz('Sticker'), null, TABLE)
    expect(r.scheduledFor?.getTime()).toBe(DELIV.getTime() + 12 * DAY)
    expect(r.source).toBe('default')
  })
})

describe('amazon clamp', () => {
  it('clamps high delay to 25d', () => {
    expect(resolveSendTiming(amz(null), rule({ sendDelayDays: 40 }), TABLE).scheduledFor?.getTime()).toBe(DELIV.getTime() + 25 * DAY)
  })
  it('clamps low delay to 4d', () => {
    expect(resolveSendTiming(amz(null), rule({ sendDelayDays: 2, minDaysSinceDelivery: 2 }), TABLE).scheduledFor?.getTime()).toBe(DELIV.getTime() + 4 * DAY)
  })
})

describe('anchor', () => {
  it('eBay SHIP anchor uses shippedAt', () => {
    const ship = new Date('2026-06-08T08:00:00.000Z')
    const r = resolveSendTiming(ebay({ shippedAt: ship }), rule({ anchor: 'SHIP', sendDelayDays: 5, minDaysSinceDelivery: 1 }), TABLE)
    expect(r.anchorUsed).toBe('SHIP')
    expect(r.scheduledFor?.getTime()).toBe(ship.getTime() + 5 * DAY)
  })
  it('Amazon forces DELIVERY even if anchor=SHIP', () => {
    const ship = new Date('2026-06-08T08:00:00.000Z')
    const r = resolveSendTiming({ ...amz(null), shippedAt: ship }, rule({ anchor: 'SHIP', sendDelayDays: 5, minDaysSinceDelivery: 1 }), TABLE)
    expect(r.anchorUsed).toBe('DELIVERY')
    expect(r.scheduledFor?.getTime()).toBe(DELIV.getTime() + 5 * DAY) // off deliveredAt, not shippedAt
  })
})

describe('send niceties', () => {
  it('pins preferred local hour (11:00 Europe/Rome)', () => {
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 5, sendHourLocal: 11, minDaysSinceDelivery: 1 }), TABLE)
    expect(localHour(r.scheduledFor!)).toBe(11)
  })
  it('skip weekends → lands on a weekday', () => {
    for (let d = 1; d <= 9; d++) {
      const r = resolveSendTiming(ebay(), rule({ sendDelayDays: d, skipWeekends: true, minDaysSinceDelivery: 1, maxDaysSinceDelivery: 30 }), TABLE)
      expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(localDow(r.scheduledFor!))
    }
  })
})

// STO.3 / STO.6 — send-time windows
const allDays = (hour: number, ranks: Partial<Record<number, number>> = {}, marketplace = '*'): SendWindowRow[] =>
  [0, 1, 2, 3, 4, 5, 6].map((d) => ({ marketplace, dayOfWeek: d, hourLocal: hour, dayRank: ranks[d] ?? 5, isActive: true }))

describe('send windows (STO.3)', () => {
  it('window pins the weekday hour when the rule has none', () => {
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 5, minDaysSinceDelivery: 1 }), TABLE, allDays(19))
    expect(localHour(r.scheduledFor!)).toBe(19)
    expect(r.sendHourSource).toBe('window')
    expect(r.sendHour).toBe(19)
  })
  it('rule sendHourLocal overrides the window', () => {
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 5, sendHourLocal: 8, minDaysSinceDelivery: 1 }), TABLE, allDays(19))
    expect(localHour(r.scheduledFor!)).toBe(8)
    expect(r.sendHourSource).toBe('rule')
  })
  it('per-market window beats global', () => {
    const windows = [...allDays(19, {}, '*'), ...allDays(8, {}, 'IT')]
    expect(localHour(resolveSendTiming(ebay(), rule({ sendDelayDays: 5, minDaysSinceDelivery: 1 }), TABLE, windows).scheduledFor!)).toBe(8)
    const de = { ...ebay(), marketplace: 'DE' }
    expect(localHour(resolveSendTiming(de, rule({ sendDelayDays: 5, minDaysSinceDelivery: 1 }), TABLE, windows).scheduledFor!)).toBe(19)
  })
  it('no windows → keeps anchor time-of-day (parity)', () => {
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 5, minDaysSinceDelivery: 1 }), TABLE, [])
    expect(r.sendHourSource).toBe('none')
    expect(r.scheduledFor?.getTime()).toBe(DELIV.getTime() + 5 * DAY)
  })
  it('inactive window rows are ignored', () => {
    const windows = allDays(19).map((w) => ({ ...w, isActive: false }))
    expect(resolveSendTiming(ebay(), rule({ sendDelayDays: 5, minDaysSinceDelivery: 1 }), TABLE, windows).sendHourSource).toBe('none')
  })
})

describe('shift to best day (STO.6)', () => {
  it('moves forward to the best-ranked weekday', () => {
    // DELIV is Wed 2026-06-10; +2 = Fri; Saturday ranked best → shift to Sat
    const windows = allDays(12, { 6: 0 })
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 2, shiftToBestDay: true, minDaysSinceDelivery: 1, maxDaysSinceDelivery: 30 }), TABLE, windows)
    expect(localDow(r.scheduledFor!)).toBe('Sat')
    expect(localHour(r.scheduledFor!)).toBe(12)
  })
  it('does not shift when the toggle is off', () => {
    const windows = allDays(12, { 6: 0 })
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 2, minDaysSinceDelivery: 1, maxDaysSinceDelivery: 30 }), TABLE, windows)
    expect(localDow(r.scheduledFor!)).toBe('Fri')
  })
  it('does not shift between equal-rank days (real rank, not list index)', () => {
    // DELIV is Wed; Tue & Wed both rank 1 → a Wed base must stay on Wed, not jump
    // forward to the next equally-ranked Tuesday.
    const windows = allDays(12, { 2: 1, 3: 1 })
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 0, shiftToBestDay: true, minDaysSinceDelivery: 0, maxDaysSinceDelivery: 30 }), TABLE, windows)
    expect(localDow(r.scheduledFor!)).toBe('Wed')
  })
  it('shifts to the genuinely best day, not just the first improvement', () => {
    // DELIV Wed; from Wed(rank 4) reachable: Thu5,Fri5,Sat3,Sun5,Mon5,Tue1 → pick Tue(1)
    const windows = allDays(12, { 3: 4, 6: 3, 2: 1 })
    const r = resolveSendTiming(ebay(), rule({ sendDelayDays: 0, shiftToBestDay: true, minDaysSinceDelivery: 0, maxDaysSinceDelivery: 30 }), TABLE, windows)
    expect(localDow(r.scheduledFor!)).toBe('Tue')
  })
})

describe('windowHourFor', () => {
  it('per-market beats global, falls back, null when absent', () => {
    const windows = [...allDays(19, {}, '*'), ...allDays(8, {}, 'IT')]
    expect(windowHourFor('IT', 3, windows)).toBe(8)
    expect(windowHourFor('DE', 3, windows)).toBe(19)
    expect(windowHourFor('IT', 3, [])).toBeNull()
  })
})

describe('lookupTimingTable', () => {
  it('sortOrder precedence + substring', () => {
    expect(lookupTimingTable('Giacca Casco', TABLE)).toBe(21) // casco(10) before giacca(30)
    expect(lookupTimingTable('Guanti Pelle', TABLE)).toBe(10)
    expect(lookupTimingTable('Unknown', TABLE)).toBeNull()
    expect(lookupTimingTable(null, TABLE)).toBeNull()
  })
})

// Live audit B05 — WHEN a due request may go out: its send hour (rule, else Timing) and the 3 hours after it.
describe('send hours (live audit B05)', () => {
  // The audit's table: Mon–Thu 19:00, Fri 18:00, Sat/Sun 11:00 (global).
  const windows: SendWindowRow[] = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ marketplace: '*', dayOfWeek: d, hourLocal: d === 0 || d === 6 ? 11 : d === 5 ? 18 : 19, dayRank: 1, isActive: true }))
  const ctx = { marketplace: 'IT', windows }
  // Mon 26 Oct 2026, Rome is UTC+1 (winter time).
  const at = (iso: string) => new Date(iso)

  it('inside the day’s send hour and the 3 hours after it; never in the night', () => {
    expect(inSendHours(at('2026-10-26T18:30:00Z'), ctx)).toBe(true) // Mon 19:30
    expect(inSendHours(at('2026-10-26T20:59:00Z'), ctx)).toBe(true) // Mon 21:59
    expect(inSendHours(at('2026-10-26T21:00:00Z'), ctx)).toBe(false) // Mon 22:00
    expect(inSendHours(at('2026-10-26T23:00:00Z'), ctx)).toBe(false) // Tue 00:00
    expect(inSendHours(at('2026-10-26T13:00:00Z'), ctx)).toBe(false) // Mon 14:00
  })

  it('the next send hour: later today, else the next day’s (its own weekday’s hour)', () => {
    expect(nextSendSlot(at('2026-10-26T13:00:00Z'), ctx).toISOString()).toBe('2026-10-26T18:00:00.000Z') // Mon 14:00 → Mon 19:00
    expect(nextSendSlot(at('2026-10-26T22:00:00Z'), ctx).toISOString()).toBe('2026-10-27T18:00:00.000Z') // Mon 23:00 → Tue 19:00
    expect(nextSendSlot(at('2026-10-29T23:30:00Z'), ctx).toISOString()).toBe('2026-10-30T17:00:00.000Z') // Fri 00:30 → Fri 18:00
    expect(nextSendSlot(at('2026-10-30T21:30:00Z'), ctx).toISOString()).toBe('2026-10-31T10:00:00.000Z') // Fri 22:30 → Sat 11:00
    const inside = at('2026-10-26T19:10:00Z')
    expect(nextSendSlot(inside, ctx)).toBe(inside)
  })

  it('a daily retry goes at the next day’s send hour — never now + 24 h, which slid an hour later every day', () => {
    // A retry decided at Mon 20:00:01 goes Tue 19:00, then Wed 19:00 … never 21:00, 22:00, 23:00.
    expect(nextDaySendSlot(at('2026-10-26T19:00:01Z'), ctx).toISOString()).toBe('2026-10-27T18:00:00.000Z')
    expect(nextDaySendSlot(at('2026-10-29T19:00:00Z'), ctx).toISOString()).toBe('2026-10-30T17:00:00.000Z') // Thu → Fri 18:00
  })

  it('the rule’s fixed hour beats the table; with no send hour at all nothing is held (as before)', () => {
    expect(nextSendSlot(at('2026-10-26T13:00:00Z'), { ...ctx, ruleHour: 10 }).toISOString()).toBe('2026-10-27T09:00:00.000Z')
    const none = { marketplace: 'IT', windows: [] }
    expect(inSendHours(at('2026-10-26T23:00:00Z'), none)).toBe(true)
    expect(nextDaySendSlot(at('2026-10-26T23:00:00Z'), none).toISOString()).toBe('2026-10-27T23:00:00.000Z')
  })

  it('a day switched off in Timing sends in the daytime (08:00–22:00), not at night', () => {
    const off = windows.map((w) => (w.dayOfWeek === 2 ? { ...w, isActive: false } : w))
    expect(inSendHours(at('2026-10-27T08:00:00Z'), { marketplace: 'IT', windows: off })).toBe(true) // Tue 09:00
    expect(nextSendSlot(at('2026-10-27T03:00:00Z'), { marketplace: 'IT', windows: off }).toISOString()).toBe('2026-10-27T07:00:00.000Z') // Tue 08:00
  })

  it('Amazon’s first day: a send hour before the legal minimum moves to the next day’s send hour, not the minimum’s time of day', () => {
    // Delivered Mon 26 Oct 21:00 Rome; day 4 = Fri 30 Oct 21:00. Fri's send hour 18:00 is before it → Sat 11:00.
    const delivered = at('2026-10-26T20:00:00Z')
    const r = resolveSendTiming({ channel: 'AMAZON', marketplace: 'IT', deliveredAt: delivered, shippedAt: null, purchaseDate: null, productType: null }, rule({ sendDelayDays: 4, minDaysSinceDelivery: 4 }), TABLE, windows)
    expect(r.scheduledFor?.toISOString()).toBe('2026-10-31T10:00:00.000Z')
    expect(inSendHours(r.scheduledFor!, ctx)).toBe(true)
  })
})
