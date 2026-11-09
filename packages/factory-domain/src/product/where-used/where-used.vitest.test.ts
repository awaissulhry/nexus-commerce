import { describe, expect, it } from 'vitest'
import { byOpenThenNewest, isOpen, priceListOpen, WHERE_USED_KINDS, WHERE_USED_PERMISSION } from './rules'

describe('where a style is used (PRD-021)', () => {
  it('reads each kind with its own view permission', () => {
    expect(WHERE_USED_KINDS.map((kind) => WHERE_USED_PERMISSION[kind])).toEqual([
      'quotes.view',
      'orders.view',
      'workorders.view',
      'inventory.stock.view',
      'pricelists.view',
      'product.styles.view',
      'compliance.certificates.view',
    ])
  })

  it('says which records still wait on the style', () => {
    expect(isOpen('QUOTES', 'SENT')).toBe(true)
    expect(isOpen('QUOTES', 'ACCEPTED')).toBe(false)
    expect(isOpen('SALES_ORDERS', 'PARTLY_SHIPPED')).toBe(true)
    expect(isOpen('SALES_ORDERS', 'SHIPPED')).toBe(false)
    expect(isOpen('WORK_ORDERS', 'ON_HOLD')).toBe(true)
    expect(isOpen('CERTIFICATES', 'EXPIRED')).toBe(false)
    expect(priceListOpen('ACTIVE', null, '2026-11-10')).toBe(true)
    expect(priceListOpen('ACTIVE', '2026-11-09', '2026-11-10')).toBe(false)
    expect(priceListOpen('DRAFT', null, '2026-11-10')).toBe(false)
  })

  it('lists the open ones first, then the newest', () => {
    const rows = [
      { number: 'A', open: false, at: '2026-11-09' },
      { number: 'B', open: true, at: '2026-01-01' },
      { number: 'C', open: true, at: '2026-06-01' },
    ]
    expect(byOpenThenNewest(rows).map((row) => row.number)).toEqual(['C', 'B', 'A'])
  })
})
