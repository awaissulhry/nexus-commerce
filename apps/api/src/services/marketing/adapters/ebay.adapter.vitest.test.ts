/**
 * E1 characterization tests — pin the eBay adapter's normalization contract
 * before the eBay ads console builds on it (E0 audit: the adapters had zero
 * tests). These lock CURRENT behavior; the E2 modernization (fundingModel
 * vocabulary, SCHEDULED/PENDING statuses) must update them deliberately.
 */
import { describe, it, expect } from 'vitest'
import type { EbayCampaign } from '@prisma/client'
import { normalizeEbayCampaign, ebayAdapter } from './ebay.adapter.js'
import { adapterFor } from './types.js'

function row(overrides: Partial<Record<keyof EbayCampaign, unknown>> = {}): EbayCampaign {
  return {
    id: 'ec_1',
    channelConnectionId: 'conn_1',
    marketplace: 'EBAY_IT',
    externalCampaignId: '123456789',
    name: 'Catch-all IT',
    fundingStrategy: 'STANDARD',
    bidPercentage: { toString: () => '5.50' },
    dailyBudget: null,
    budgetCurrency: 'EUR',
    status: 'RUNNING',
    startDate: new Date('2026-06-01T00:00:00Z'),
    endDate: null,
    impressions: 1000,
    clicks: 20,
    sales: { toString: () => '250.00' },
    spend: { toString: () => '13.75' },
    metricsAt: new Date('2026-07-01T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  } as unknown as EbayCampaign
}

describe('normalizeEbayCampaign', () => {
  it('maps a STANDARD (CPS) campaign to BID_PCT with no budget', () => {
    const n = normalizeEbayCampaign(row())
    expect(n.channel).toBe('EBAY')
    expect(n.surface).toBe('PROMOTED_LISTINGS')
    expect(n.marketplace).toBe('EBAY_IT')
    expect(n.externalId).toBe('123456789')
    expect(n.status).toBe('ACTIVE') // RUNNING → ACTIVE
    expect(n.budgetKind).toBe('BID_PCT')
    expect(n.budgetCents).toBeNull()
    expect(n.currency).toBe('EUR')
    expect(n.detail).toMatchObject({
      fundingStrategy: 'STANDARD',
      bidPercentage: '5.50',
      channelConnectionId: 'conn_1',
      spendCents: 1375,
      salesCents: 25000,
      impressions: 1000,
      clicks: 20,
    })
  })

  it('maps an ADVANCED (CPC) campaign to DAILY budget in cents', () => {
    const n = normalizeEbayCampaign(
      row({ fundingStrategy: 'ADVANCED', dailyBudget: { toString: () => '12.00' }, bidPercentage: null }),
    )
    expect(n.budgetKind).toBe('DAILY')
    expect(n.budgetCents).toBe(1200)
    expect((n.detail as Record<string, unknown>).bidPercentage).toBeNull()
  })

  it('maps every documented status and falls back to DRAFT on unknowns', () => {
    expect(normalizeEbayCampaign(row({ status: 'PAUSED' })).status).toBe('PAUSED')
    expect(normalizeEbayCampaign(row({ status: 'ENDED' })).status).toBe('ENDED')
    expect(normalizeEbayCampaign(row({ status: 'SUSPENDED' })).status).toBe('SUSPENDED')
    expect(normalizeEbayCampaign(row({ status: 'DRAFT' })).status).toBe('DRAFT')
    expect(normalizeEbayCampaign(row({ status: 'SCHEDULED' })).status).toBe('DRAFT') // current fallback — E2 revisits
  })

  it('defaults missing currency to EUR', () => {
    expect(normalizeEbayCampaign(row({ budgetCurrency: null })).currency).toBe('EUR')
  })
})

describe('ebayAdapter registration + write posture', () => {
  it('self-registers under EBAY with the documented capabilities', () => {
    expect(adapterFor('EBAY')).toBe(ebayAdapter)
    expect(ebayAdapter.capabilities.supportsKeywords).toBe(false)
    expect(ebayAdapter.capabilities.supportsDailyBudget).toBe(true)
    expect(ebayAdapter.capabilities.supportsBudgetRebalance).toBe(true)
    expect(ebayAdapter.capabilities.surfaces).toEqual(['PROMOTED_LISTINGS'])
  })

  it('write paths THROW until the eBay write phase lands (safety posture)', async () => {
    const ctx = { connectionId: 'c', marketplace: 'EBAY_IT', mode: 'sandbox' as const }
    await expect(
      ebayAdapter.applyMutation({ syncType: 'MKT_STATE_UPDATE', entityType: 'CAMPAIGN', payload: {} }, ctx),
    ).rejects.toThrow(/not enabled/)
    await expect(ebayAdapter.setBudget('123', 1000, ctx)).rejects.toThrow(/not enabled/)
  })

  it('pullMetrics returns [] (no daily series until the E2 report pipeline)', async () => {
    const ctx = { connectionId: 'c', marketplace: 'EBAY_IT', mode: 'sandbox' as const }
    await expect(ebayAdapter.pullMetrics({ start: '2026-06-01', end: '2026-06-30' }, ctx)).resolves.toEqual([])
  })
})
