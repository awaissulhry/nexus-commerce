import { beforeEach, expect, it, vi } from 'vitest'
const build = vi.hoisted(() => vi.fn())
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: build }))
vi.mock('../../lib/workspace-context.js', () => ({ workspaceIdForQuery: () => 'workspace' }))
vi.mock('../../lib/workspace-cache.js', () => ({ WorkspaceCache: Map }))
import { clearStudioColumnCache, getStudioColumns } from './studio-columns.js'
beforeEach(() => { clearStudioColumnCache(); vi.clearAllMocks() })
it('shares account column builds while isolating seller accounts and languages', async () => {
  const input = { accountId: 'seller', market: 'BE', productTypes: ['OUTERWEAR'], locale: 'nl' }
  build.mockResolvedValue({ schemaAge: [{ fetchedAt: '2026-08-01T00:00:00Z' }] })
  const reads = await Promise.all([getStudioColumns(input), getStudioColumns(input), getStudioColumns(input)])
  expect(build).toHaveBeenCalledTimes(1)
  expect(reads[0]).toEqual(reads[2])
  await getStudioColumns({ ...input, accountId: 'other' })
  await getStudioColumns({ ...input, locale: 'fr' })
  expect(build).toHaveBeenCalledTimes(3)
})
it('evicts a failed account build for retry', async () => {
  const input = { accountId: 'seller', market: 'DE', productTypes: ['OUTERWEAR'] }
  build.mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({})
  await expect(getStudioColumns(input)).rejects.toThrow('temporary')
  await expect(getStudioColumns(input)).resolves.toEqual({})
  expect(build).toHaveBeenCalledTimes(2)
})
