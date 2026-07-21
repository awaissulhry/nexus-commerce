/**
 * SC.5 — policy input validation + new-listing default enforcement sweep.
 */
import { describe, it, expect, vi } from 'vitest'
import { validatePolicyInput, enforceNewListingDefaults } from './sync-control-policy.service.js'

describe('SC.5 — validatePolicyInput', () => {
  it('accepts known channels, * or market codes, and at least one field', () => {
    expect(validatePolicyInput({ channel: 'AMAZON', marketplace: 'IT', pushesPaused: true })).toBeNull()
    expect(validatePolicyInput({ channel: 'ebay', marketplace: '*', newListingDefaultMode: 'PAUSED' })).toBeNull()
  })
  it('rejects unknown channel, bad market, empty change, bad types', () => {
    expect(validatePolicyInput({ channel: 'ETSY', marketplace: 'IT', pushesPaused: true })).toMatch(/unknown channel/)
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
