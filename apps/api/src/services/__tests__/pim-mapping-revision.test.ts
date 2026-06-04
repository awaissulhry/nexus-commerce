/**
 * FM.13 — mapping-revision rollback guards.
 *
 * Pins the rollback validation: unknown revision / wrong marketplace both
 * reject before any write. prisma is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindUnique } = vi.hoisted(() => ({ mockFindUnique: vi.fn() }))
vi.mock('../../db.js', () => ({
  default: { mappingRevision: { findUnique: mockFindUnique } },
}))

import { rollbackMapping } from '../pim/mapping-revision.service.js'

beforeEach(() => vi.clearAllMocks())

describe('rollbackMapping guards', () => {
  it('rejects when the revision does not exist', async () => {
    mockFindUnique.mockResolvedValue(null)
    await expect(rollbackMapping('AMAZON', 'IT', 'rev1')).rejects.toThrow(/not found/)
  })

  it('rejects when the revision belongs to a different marketplace', async () => {
    mockFindUnique.mockResolvedValue({ id: 'rev1', channel: 'EBAY', code: 'DE', snapshot: {} })
    await expect(rollbackMapping('AMAZON', 'IT', 'rev1')).rejects.toThrow(/not found/)
  })
})
