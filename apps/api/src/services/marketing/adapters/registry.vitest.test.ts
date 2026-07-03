/**
 * E1 characterization tests — the adapter registry seam (register/resolve),
 * which the eBay ads console resolves adapters through.
 */
import { describe, it, expect } from 'vitest'
import {
  registerAdapter,
  adapterFor,
  registeredAdapters,
  type ChannelAdapter,
} from './types.js'

function fakeAdapter(channel: ChannelAdapter['channel']): ChannelAdapter {
  return {
    channel,
    capabilities: {
      surfaces: [],
      supportsKeywords: false,
      supportsNegativeTargets: false,
      supportsAudiences: false,
      supportsLifetimeBudget: false,
      supportsDailyBudget: false,
      supportsMultiMarket: false,
      supportsBudgetRebalance: false,
    },
    pullCampaigns: async () => [],
    applyMutation: async () => ({ ok: true, status: 'SUCCESS' as const }),
    pullMetrics: async () => [],
    setBudget: async () => ({ ok: true, status: 'SUCCESS' as const }),
  }
}

describe('adapter registry', () => {
  it('resolves a registered adapter by channel and lists it', () => {
    const google = fakeAdapter('GOOGLE')
    registerAdapter(google)
    expect(adapterFor('GOOGLE')).toBe(google)
    expect(registeredAdapters()).toContain(google)
  })

  it('returns undefined for channels with no adapter registered in this context', () => {
    expect(adapterFor('TIKTOK')).toBeUndefined()
  })

  it('last registration wins (idempotent re-register)', () => {
    const a = fakeAdapter('META')
    const b = fakeAdapter('META')
    registerAdapter(a)
    registerAdapter(b)
    expect(adapterFor('META')).toBe(b)
  })
})
