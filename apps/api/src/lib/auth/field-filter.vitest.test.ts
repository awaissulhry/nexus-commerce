/**
 * Phase S2 (RBAC engine) — field-level financial filter tests.
 * Proves the "absent, not hidden" contract: restricted money is deleted
 * for callers without the permission, operational fields survive, owners
 * and financials.view see everything, and nested blobs are covered.
 */

import { describe, it, expect } from 'vitest'
import { filterFinancialPayload } from './field-filter.js'
import type { ResolvedPermissions } from './rbac.js'

const owner: ResolvedPermissions = { isOwner: true, permissions: new Set() }
const financeAll: ResolvedPermissions = { isOwner: false, permissions: new Set(['financials.view']) }
const adspendOnly: ResolvedPermissions = { isOwner: false, permissions: new Set(['financials.adspend.view']) }
const none: ResolvedPermissions = { isOwner: false, permissions: new Set() }

const sample = () => ({
  sku: 'ABC',
  basePrice: '19.99', // OPERATIONAL — must survive
  totalStock: 42, // not money
  totalRows: 100, // not money (false-positive name)
  costPrice: '8.50', // RESTRICTED (costs)
  weightedAvgCostCents: 850, // RESTRICTED (costs)
  estimatedFbaFee: '3.10', // RESTRICTED (fees)
  acos: 0.22, // RESTRICTED (adspend)
  spendCents: 1200, // RESTRICTED (adspend)
  variation: {
    price: '21.00', // OPERATIONAL
    costPrice: '9.00', // RESTRICTED nested
  },
  campaigns: [
    { name: 'x', dailyBudget: '15.00', acos7d: 0.3 }, // RESTRICTED in array
  ],
  auditBlob: { before: { costPrice: '7.00' }, after: { costPrice: '8.00' } }, // smuggled money
})

describe('financial field filter', () => {
  it('owner sees everything', () => {
    const out = filterFinancialPayload(sample(), owner) as any
    expect(out.costPrice).toBe('8.50')
    expect(out.acos).toBe(0.22)
    expect(out.auditBlob.before.costPrice).toBe('7.00')
  })

  it('financials.view sees everything', () => {
    const out = filterFinancialPayload(sample(), financeAll) as any
    expect(out.costPrice).toBe('8.50')
    expect(out.estimatedFbaFee).toBe('3.10')
  })

  it('no financial perms → all restricted stripped, operational kept', () => {
    const out = filterFinancialPayload(sample(), none) as any
    // stripped
    expect(out.costPrice).toBeUndefined()
    expect(out.weightedAvgCostCents).toBeUndefined()
    expect(out.estimatedFbaFee).toBeUndefined()
    expect(out.acos).toBeUndefined()
    expect(out.spendCents).toBeUndefined()
    expect(out.variation.costPrice).toBeUndefined()
    expect(out.campaigns[0].dailyBudget).toBeUndefined()
    expect(out.campaigns[0].acos7d).toBeUndefined()
    expect(out.auditBlob.before.costPrice).toBeUndefined() // nested blob covered
    expect(out.auditBlob.after.costPrice).toBeUndefined()
    // kept
    expect(out.basePrice).toBe('19.99')
    expect(out.totalStock).toBe(42)
    expect(out.totalRows).toBe(100)
    expect(out.variation.price).toBe('21.00')
    expect(out.campaigns[0].name).toBe('x')
  })

  it('sub-grain: adspend-only sees ad money but not costs/fees', () => {
    const out = filterFinancialPayload(sample(), adspendOnly) as any
    expect(out.acos).toBe(0.22) // adspend — visible
    expect(out.spendCents).toBe(1200)
    expect(out.campaigns[0].dailyBudget).toBe('15.00')
    expect(out.costPrice).toBeUndefined() // costs — hidden
    expect(out.estimatedFbaFee).toBeUndefined() // fees — hidden
  })

  it('passes through non-objects untouched', () => {
    expect(filterFinancialPayload(null, none)).toBeNull()
    expect(filterFinancialPayload('hello', none)).toBe('hello')
    expect(filterFinancialPayload(42, none)).toBe(42)
  })
})
