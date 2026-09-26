/**
 * PSIE — the Owner's choice (2026-09-26): an import notes each family's readiness and rebuilds it once AFTER its save.
 * Outside `deferReadiness` nothing changes: a refresh still needs the write's own transaction.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../db.js', () => ({ default: { product: { findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id, parentId: where.id === 'variant' ? 'root' : null }) } } }))
const { deferReadiness, produceReadiness } = await import('../readiness-index.service.js')

describe('deferred readiness', () => {
  it('inside deferReadiness a refresh only notes the family root (a variant notes its parent), once', async () => {
    const families = new Set<string>()
    await deferReadiness(families, async () => {
      await produceReadiness('variant')
      await produceReadiness('root', { channel: 'AMAZON', market: 'IT', accountId: 'a' })
      await produceReadiness('other')
    })
    expect([...families].sort()).toEqual(['other', 'root'])
  })
  it('outside it, a refresh still requires the write transaction (unchanged for every other writer)', async () => {
    await expect(produceReadiness('root')).rejects.toThrow('A readiness producer requires the content transaction.')
  })
})
