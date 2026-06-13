/**
 * A3.1 — ChannelListing optimistic-concurrency helper. The DB client is injected,
 * so the CAS logic is testable without a real database.
 */
import { describe, it, expect, vi } from 'vitest'
import { casUpdateChannelListing, ChannelListingVersionConflict, isVersionConflict } from './channel-listing-cas.js'

const mkDb = (update: any, findUnique: any = vi.fn()) => ({ channelListing: { update, findUnique } })

describe('casUpdateChannelListing', () => {
  it('no expectedVersion → plain update that bumps version (back-compat)', async () => {
    const update = vi.fn(async () => ({ id: 'L1', version: 4 }))
    await casUpdateChannelListing(mkDb(update), 'L1', undefined, { title: 'x' })
    expect(update).toHaveBeenCalledWith({ where: { id: 'L1' }, data: { title: 'x', version: { increment: 1 } } })
  })

  it('matching version → CAS update on (id, version), bumps version', async () => {
    const update = vi.fn(async () => ({ id: 'L1', version: 6 }))
    const r = await casUpdateChannelListing(mkDb(update), 'L1', 5, { title: 'x' })
    expect(update).toHaveBeenCalledWith({ where: { id: 'L1', version: 5 }, data: { title: 'x', version: { increment: 1 } } })
    expect(r.version).toBe(6)
  })

  it('stale version → throws ChannelListingVersionConflict carrying the CURRENT version', async () => {
    const update = vi.fn(async () => { const e: any = new Error('no row'); e.code = 'P2025'; throw e })
    const findUnique = vi.fn(async () => ({ version: 9 }))
    await expect(casUpdateChannelListing(mkDb(update, findUnique), 'L1', 5, { title: 'x' }))
      .rejects.toMatchObject({ name: 'ChannelListingVersionConflict', id: 'L1', expectedVersion: 5, currentVersion: 9 })
  })

  it('a non-P2025 error is re-thrown as-is', async () => {
    const update = vi.fn(async () => { throw new Error('db down') })
    await expect(casUpdateChannelListing(mkDb(update), 'L1', 5, {})).rejects.toThrow('db down')
  })

  it('isVersionConflict type-guard', () => {
    expect(isVersionConflict(new ChannelListingVersionConflict('L1', 1, 2))).toBe(true)
    expect(isVersionConflict(new Error('x'))).toBe(false)
  })
})
