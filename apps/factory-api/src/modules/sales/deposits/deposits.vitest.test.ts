import { decimalOf } from '@nexus/factory-domain/product/units/units'
import { describe, expect, it } from 'vitest'
import { depositViewOf, type DepositRow } from './deposits'

// A stored percent comes back from the database as a decimal whose text has no trailing zeros ("30", not "30.00").
const rowWith = (pct: string | null): DepositRow =>
  ({
    id: 'dr_1',
    companyId: 'co_1',
    partyId: 'pa_1',
    quoteVersionId: 'qv_1',
    orderId: null,
    kind: 'ACCONTO',
    depositPct: pct === null ? null : decimalOf(pct),
    currency: 'EUR',
    amount: 71400,
    dueDate: new Date('2026-11-05T00:00:00Z'),
    fiscalDocument: null,
    fiscalRule: null,
    status: 'OPEN',
    paidAt: null,
    version: 1,
    createdAt: new Date('2026-10-29T10:00:00Z'),
  }) as unknown as DepositRow

describe('depositViewOf', () => {
  it('keeps the zeros of a whole percent', () => {
    expect(depositViewOf(rowWith('30.00')).depositPct).toBe('30')
    expect(depositViewOf(rowWith('100')).depositPct).toBe('100')
  })

  it('drops only trailing decimal zeros', () => {
    expect(depositViewOf(rowWith('12.50')).depositPct).toBe('12.5')
    expect(depositViewOf(rowWith('0.25')).depositPct).toBe('0.25')
  })

  it('has no percent when the request has none', () => {
    expect(depositViewOf(rowWith(null)).depositPct).toBeNull()
  })
})
