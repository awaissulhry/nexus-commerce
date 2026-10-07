/**
 * SC.5 — policy input validation + new-listing default enforcement sweep.
 */
import { describe, it, expect, vi } from 'vitest'
import { validatePolicyInput, enforceNewListingDefaults, loadChannelPolicies, policyFor, policyKey, parsePolicyKey } from './sync-control-policy.service.js'

describe('SC.5 — validatePolicyInput', () => {
  it('accepts known channels, * or market codes, and at least one field', () => {
    expect(validatePolicyInput({ channel: 'AMAZON', marketplace: 'IT', pushesPaused: true })).toBeNull()
    expect(validatePolicyInput({ channel: 'ebay', marketplace: '*', newListingDefaultMode: 'PAUSED' })).toBeNull()
  })
  it('2026-10-01 — an Etsy policy is accepted; Etsy has one market (GLOBAL), so its policy is for every market', () => {
    expect(validatePolicyInput({ channel: 'ETSY', marketplace: '*', pushesPaused: true })).toBeNull()
    expect(validatePolicyInput({ channel: 'etsy', marketplace: '*', newListingDefaultMode: 'PAUSED' })).toBeNull()
    const policies = new Map([[policyKey('ETSY', '*'), { pushesPaused: true, newListingDefaultMode: 'FOLLOW' }]])
    expect(policyFor(policies, 'ETSY', 'GLOBAL', 'etsy-acct')).toEqual({ pushesPaused: true, newListingDefaultMode: 'FOLLOW' })
    // It pauses Etsy and nothing else.
    expect(policyFor(policies, 'SHOPIFY', 'GLOBAL', null)).toBeNull()
  })
  it('rejects unknown channel, bad market, empty change, bad types', () => {
    expect(validatePolicyInput({ channel: 'WISH', marketplace: 'IT', pushesPaused: true })).toMatch(/unknown channel/)
    expect(validatePolicyInput({ channel: 'AMAZON', marketplace: 'ITALY!', pushesPaused: true })).toMatch(/marketplace/)
    expect(validatePolicyInput({ channel: 'AMAZON', marketplace: 'IT' })).toMatch(/nothing to change/)
    expect(validatePolicyInput({ channel: 'AMAZON', marketplace: 'IT', pushesPaused: 'yes' })).toMatch(/boolean/)
    expect(validatePolicyInput({ channel: 'AMAZON', marketplace: 'IT', newListingDefaultMode: 'DARK' })).toMatch(/FOLLOW or PAUSED/)
  })
})

function mockDb(opts: {
  policies?: unknown[]
  listings?: unknown[]
  seen?: unknown[]
}) {
  return {
    syncChannelPolicy: { findMany: vi.fn().mockResolvedValue(opts.policies ?? []) },
    channelListing: {
      findMany: vi.fn().mockResolvedValue(opts.listings ?? []),
      updateMany: vi.fn().mockResolvedValue({ count: (opts.listings ?? []).length }),
    },
    syncControlAudit: {
      findMany: vi.fn().mockResolvedValue(opts.seen ?? []),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  }
}

const cutoff = new Date('2026-07-21T00:00:00Z')

describe('SC.5 — enforceNewListingDefaults', () => {
  it('no PAUSED-default policies → single query, zero writes', async () => {
    const db = mockDb({})
    expect(await enforceNewListingDefaults(db as never)).toEqual({ paused: 0 })
    expect(db.channelListing.findMany).not.toHaveBeenCalled()
    expect(db.channelListing.updateMany).not.toHaveBeenCalled()
  })

  it('pauses fresh in-scope listings once, with audit marker rows', async () => {
    const db = mockDb({
      policies: [{ channel: 'EBAY', marketplace: 'IT', newListingModeSetAt: cutoff }],
      listings: [
        { id: 'l1', sku: 'A', channel: 'EBAY', marketplace: 'EBAY_IT' },
        { id: 'l2', sku: 'B', channel: 'EBAY', marketplace: 'EBAY_DE' }, // out of scope
      ],
    })
    expect(await enforceNewListingDefaults(db as never)).toEqual({ paused: 1 })
    expect(db.channelListing.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1'] } },
      data: { syncPaused: true },
    })
    const auditArg = db.syncControlAudit.createMany.mock.calls[0][0] as { data: Array<{ actor: string; scopeId: string }> }
    expect(auditArg.data).toHaveLength(1)
    expect(auditArg.data[0]).toMatchObject({ actor: 'policy:new-listing', scopeId: 'l1', field: 'syncPaused' })
  })

  it("resume-sticky: a listing with a prior 'policy:new-listing' audit row is never re-paused", async () => {
    const db = mockDb({
      policies: [{ channel: 'AMAZON', marketplace: '*', newListingModeSetAt: cutoff }],
      listings: [{ id: 'l1', sku: 'A', channel: 'AMAZON', marketplace: 'IT' }],
      seen: [{ scopeId: 'l1' }],
    })
    expect(await enforceNewListingDefaults(db as never)).toEqual({ paused: 0 })
    expect(db.channelListing.updateMany).not.toHaveBeenCalled()
    expect(db.syncControlAudit.createMany).not.toHaveBeenCalled()
  })

  it("'*' matches every market of the channel", async () => {
    const db = mockDb({
      policies: [{ channel: 'EBAY', marketplace: '*', newListingModeSetAt: cutoff }],
      listings: [
        { id: 'l1', sku: 'A', channel: 'EBAY', marketplace: 'EBAY_IT' },
        { id: 'l2', sku: 'B', channel: 'EBAY', marketplace: 'EBAY_DE' },
      ],
    })
    expect(await enforceNewListingDefaults(db as never)).toEqual({ paused: 2 })
  })
})

describe('MAP.2b — a policy row names an account, or every account', () => {
  const load = (rows: unknown[]) => loadChannelPolicies({ syncChannelPolicy: { findMany: vi.fn().mockResolvedValue(rows) } })
  const row = (over: Record<string, unknown>) => ({ channel: 'EBAY', marketplace: 'IT', channelConnectionId: null, pushesPaused: true, newListingDefaultMode: 'FOLLOW', ...over })

  it('a row with no account pauses every account, and a caller that knows no account', async () => {
    const policies = await load([row({})])
    expect(policyFor(policies, 'EBAY', 'EBAY_IT', 'acct-1')?.pushesPaused).toBe(true)
    expect(policyFor(policies, 'EBAY', 'EBAY_IT', 'acct-2')?.pushesPaused).toBe(true)
    expect(policyFor(policies, 'EBAY', 'EBAY_IT')?.pushesPaused).toBe(true)
  })

  it('a row for one account pauses only that account', async () => {
    const policies = await load([row({ channelConnectionId: 'acct-1' })])
    expect(policyFor(policies, 'EBAY', 'IT', 'acct-1')?.pushesPaused).toBe(true)
    expect(policyFor(policies, 'EBAY', 'IT', 'acct-2')).toBeNull()
    expect(policyFor(policies, 'EBAY', 'IT')).toBeNull()
  })

  it('the market decides first: an exact market row beats a channel-wide row, for this account or every account', async () => {
    const policies = await load([row({ marketplace: '*', channelConnectionId: 'acct-1', pushesPaused: true }), row({ newListingDefaultMode: 'PAUSED', pushesPaused: false })])
    expect(policyFor(policies, 'EBAY', 'IT', 'acct-1')?.pushesPaused).toBe(false)
    expect(policyFor(policies, 'EBAY', 'DE', 'acct-1')?.pushesPaused).toBe(true)
    expect(policyFor(policies, 'EBAY', 'DE', 'acct-2')).toBeNull()
  })

  it('two rows for every account merge, and a pause wins in either order', async () => {
    for (const rows of [[row({ pushesPaused: false, newListingDefaultMode: 'PAUSED' }), row({})], [row({}), row({ pushesPaused: false, newListingDefaultMode: 'PAUSED' })]]) {
      const policies = await load(rows)
      expect(policies.size).toBe(1)
      expect(policies.get(policyKey('EBAY', 'IT'))).toEqual({ pushesPaused: true, newListingDefaultMode: 'PAUSED', sourceLocationCodes: [] })
    }
  })

  it('a key reads back as its parts', () => {
    expect(parsePolicyKey(policyKey('ebay', 'it', 'acct-1'))).toEqual({ channel: 'EBAY', market: 'IT', accountId: 'acct-1' })
    expect(parsePolicyKey(policyKey('AMAZON', '*'))).toEqual({ channel: 'AMAZON', market: '*', accountId: null })
  })

  it('the new-listing sweep of a one-account row looks only at that account', async () => {
    const db = mockDb({ policies: [{ channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'acct-1', newListingModeSetAt: cutoff }] })
    await enforceNewListingDefaults(db as never)
    expect(db.channelListing.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channelConnectionId: 'acct-1' }) }))
  })
})
