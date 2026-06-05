/**
 * RRT.2 — resolver parity + behavior tests. Pure function, no DB/network.
 * The parity block is the gate: existing rules (sendDelayDays backfilled =
 * minDaysSinceDelivery, no hour/weekend, anchor DELIVERY) must reproduce the old
 * `deliveredAt + delay` exactly.
 */
import { describe, it, expect } from 'vitest'
import { resolveSendTiming, lookupTimingTable, type TimingDefaultRow, type TimingRuleInput } from './review-timing.service.js'

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

describe('lookupTimingTable', () => {
  it('sortOrder precedence + substring', () => {
    expect(lookupTimingTable('Giacca Casco', TABLE)).toBe(21) // casco(10) before giacca(30)
    expect(lookupTimingTable('Guanti Pelle', TABLE)).toBe(10)
    expect(lookupTimingTable('Unknown', TABLE)).toBeNull()
    expect(lookupTimingTable(null, TABLE)).toBeNull()
  })
})
