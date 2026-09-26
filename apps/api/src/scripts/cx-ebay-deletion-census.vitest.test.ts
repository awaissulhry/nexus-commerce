import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ construct: vi.fn(), connect: vi.fn(), poolEnd: vi.fn(), release: vi.fn(), census: vi.fn() }))
vi.mock('pg', () => ({ Pool: class { constructor(...args: unknown[]) { m.construct(...args) }; on = vi.fn(); connect = m.connect; end = m.poolEnd } }))
vi.mock('../services/cx/ingress/ebay-deletion-census.js', () => ({ readEbayDeletionCensus: m.census, EbayDeletionCensusError: class extends Error {} }))
const { ebayDeletionCensusMain } = await import('./cx-ebay-deletion-census.js')
beforeEach(() => { vi.resetAllMocks(); m.connect.mockResolvedValue({ on: vi.fn(), release: m.release }); m.census.mockResolvedValue({ snapshotComplete: true }) })
it('requires the dedicated operator connection and never falls back to the app database', async () => {
  await expect(ebayDeletionCensusMain([], { DATABASE_URL: 'postgresql://private.invalid/app' })).rejects.toThrow('Dedicated quarantine maintenance connection is required.')
  expect(m.construct).not.toHaveBeenCalled()
})
it.each([['--apply'], ['--workspace', 'other'], ['--decrypt']])('refuses unsupported invocation %j before connecting', async args => {
  await expect(ebayDeletionCensusMain(args, { CX_QUARANTINE_MAINTENANCE_DATABASE_URL: 'postgresql://operator.invalid/db' })).rejects.toThrow(/accepts no arguments/)
  expect(m.construct).not.toHaveBeenCalled()
})
it('uses only the dedicated connection and closes it after the census', async () => {
  await expect(ebayDeletionCensusMain([], { CX_QUARANTINE_MAINTENANCE_DATABASE_URL: 'postgresql://operator.invalid/db', DATABASE_URL: 'postgresql://private.invalid/app' })).resolves.toEqual({ snapshotComplete: true })
  expect(m.construct).toHaveBeenCalledWith(expect.objectContaining({ connectionString: 'postgresql://operator.invalid/db', max: 1 }))
  expect(m.release).toHaveBeenCalledTimes(1); expect(m.poolEnd).toHaveBeenCalledTimes(1)
})
it('also closes the dedicated connection when the census fails', async () => {
  m.census.mockRejectedValue(new Error('synthetic failure'))
  await expect(ebayDeletionCensusMain([], { CX_QUARANTINE_MAINTENANCE_DATABASE_URL: 'postgresql://operator.invalid/db' })).rejects.toThrow('synthetic failure')
  expect(m.release).toHaveBeenCalledTimes(1); expect(m.poolEnd).toHaveBeenCalledTimes(1)
})
