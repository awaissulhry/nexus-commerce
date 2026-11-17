import { describe, expect, it } from 'vitest'
import { AT_RISK_STATUSES, atRiskOf, neverBilledOf, openUnitsOf, orderMoneyOf, riskDaysFor, shareOf, type OrderMoneyFacts } from './later-columns'

/**
 * The later columns' rules (B-TH-058 / B-TH-059; threads plan TH-4): open pieces, At risk from the ORDER_LATE_RISK rule's own
 * threshold, and paid and balance from deposits, invoices (one order's or several orders'), credit notes and refunds.
 * Made-up figures in minor units.
 */

describe('open pieces', () => {
  it('an open order owes its pieces less those closed short and those that left; a shipped, closed or cancelled one owes none', () => {
    expect(openUnitsOf('CONFIRMED', 10, 0, 0)).toBe(10)
    expect(openUnitsOf('PARTLY_SHIPPED', 10, 2, 5)).toBe(3)
    expect(openUnitsOf('READY', 10, 0, 12)).toBe(0)
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED', 'PENDING_APPROVAL'] as const) expect(openUnitsOf(status, 10, 0, 0), status).toBe(0)
  })
})

describe('at risk (the ORDER_LATE_RISK rule, never a second rule)', () => {
  const today = '2026-11-17'
  it('still being made, promised within the threshold, not passed: at risk with the days left', () => {
    expect(atRiskOf('CONFIRMED', '2026-11-20', today, 3)).toEqual({ daysLeft: 3, daysBeforePromise: 3 })
    expect(atRiskOf('IN_PRODUCTION', '2026-11-17', today, 3)).toEqual({ daysLeft: 0, daysBeforePromise: 3 })
  })
  it('beyond the threshold, past the promise (late, not at risk), ready, no promise, no rule: not at risk', () => {
    expect(atRiskOf('CONFIRMED', '2026-11-21', today, 3)).toBeNull()
    expect(atRiskOf('CONFIRMED', '2026-11-16', today, 3)).toBeNull()
    expect(atRiskOf('READY', '2026-11-18', today, 3)).toBeNull()
    expect(atRiskOf('CONFIRMED', null, today, 3)).toBeNull()
    expect(atRiskOf('CONFIRMED', '2026-11-18', today, null)).toBeNull()
    expect(AT_RISK_STATUSES).toEqual(['CONFIRMED', 'IN_PRODUCTION'])
  })
  it("a company's threshold: its own rule or an every-company rule, the widest; none: null", () => {
    const rules = [
      { companyId: null, daysBeforePromise: 3 },
      { companyId: 'company-a', daysBeforePromise: 7 },
      { companyId: 'company-b', daysBeforePromise: 1 },
    ]
    expect(riskDaysFor(rules, 'company-a')).toBe(7)
    expect(riskDaysFor(rules, 'company-b')).toBe(3)
    expect(riskDaysFor(rules, 'company-c')).toBe(3)
    expect(riskDaysFor([{ companyId: 'company-a', daysBeforePromise: 5 }], 'company-c')).toBeNull()
    expect(riskDaysFor([], 'company-a')).toBeNull()
  })
})

describe('shares in minor units', () => {
  it('exact, rounded half away from zero, never a float', () => {
    expect(shareOf(1000, 1, 3)).toBe(333)
    expect(shareOf(1000, 2, 3)).toBe(667)
    expect(shareOf(-1000, 2, 3)).toBe(-667)
    expect(shareOf(5, 1, 2)).toBe(3)
    expect(shareOf(7, 5, 5)).toBe(7)
    expect(shareOf(7, 0, 5)).toBe(0)
    expect(shareOf(7, 5, 0)).toBe(0)
    // Large amounts stay exact (BigInt): 9 000 000.00 split in thirds.
    expect(shareOf(900_000_000, 1, 3)).toBe(300_000_000)
    expect(shareOf(900_000_001, 1, 3)).toBe(300_000_000)
  })
})

describe('paid and balance', () => {
  const line = (quantity: number, netAmount: number, vatAmount: number, closedShortQuantity: number | null = null, feeCredited = false) => ({ quantity, netAmount, vatAmount, closedShortQuantity, feeCredited })
  const order = (fields: Partial<OrderMoneyFacts> = {}): OrderMoneyFacts => ({ grossAmount: 122_000, lines: [line(10, 100_000, 22_000)], depositPlaced: 0, depositRefunded: 0, invoices: [], ...fields })

  it('nothing paid: the balance is the gross', () => {
    expect(orderMoneyOf(order())).toEqual({ paid: 0, balance: 122_000 })
  })

  it('the deposit paid on its request counts; the final invoice paid settles it (deposit deducted on the invoice)', () => {
    expect(orderMoneyOf(order({ depositPlaced: 36_600 }))).toEqual({ paid: 36_600, balance: 85_400 })
    const final = { placed: 85_400, creditedGross: 0, refunded: 0, part: 100_000, whole: 100_000 }
    expect(orderMoneyOf(order({ depositPlaced: 36_600, invoices: [final] }))).toEqual({ paid: 122_000, balance: 0 })
  })

  it('a monthly invoice for two orders: each order counts its share of what is placed on it', () => {
    // The TD24 bills 100 000 net of this order and 300 000 of another: a quarter of the 244 000 placed is this order's.
    const td24 = { placed: 244_000, creditedGross: 0, refunded: 0, part: 100_000, whole: 400_000 }
    expect(orderMoneyOf(order({ invoices: [td24] }))).toEqual({ paid: 61_000, balance: 61_000 })
  })

  it('a credit note lowers what is due; its PAID refund gives the money back', () => {
    const credited = { placed: 122_000, creditedGross: 12_200, refunded: 12_200, part: 1, whole: 1 }
    expect(orderMoneyOf(order({ invoices: [credited] }))).toEqual({ paid: 109_800, balance: 0 })
    const notRefunded = { placed: 61_000, creditedGross: 12_200, refunded: 0, part: 1, whole: 1 }
    expect(orderMoneyOf(order({ invoices: [notRefunded] }))).toEqual({ paid: 61_000, balance: 48_800 })
  })

  it('pieces closed short and a credited fee are never billed: not in the balance', () => {
    const lines = [line(10, 100_000, 22_000, 4), line(1, 5_000, 1_100, null, true)]
    expect(neverBilledOf(lines)).toBe(48_800 + 6_100)
    expect(orderMoneyOf(order({ grossAmount: 128_100, lines }))).toEqual({ paid: 0, balance: 73_200 })
  })

  it('a reversed payment counts as taken back; paid beyond what is due never makes the balance negative', () => {
    expect(orderMoneyOf(order({ depositPlaced: 36_600 - 36_600 }))).toEqual({ paid: 0, balance: 122_000 })
    expect(orderMoneyOf(order({ invoices: [{ placed: 130_000, creditedGross: 0, refunded: 0, part: 1, whole: 1 }] }))).toEqual({ paid: 130_000, balance: 0 })
  })

  it('a refund of a deposit invoice credit note gives the deposit back', () => {
    expect(orderMoneyOf(order({ depositPlaced: 36_600, depositRefunded: 36_600 }))).toEqual({ paid: 0, balance: 122_000 })
  })
})
