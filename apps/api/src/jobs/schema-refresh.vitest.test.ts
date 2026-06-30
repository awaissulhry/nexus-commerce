// apps/api/src/jobs/schema-refresh.vitest.test.ts
import { describe, it, expect, vi } from 'vitest'
import { collectInUseSchemaTargets } from './schema-refresh.job.js'

describe('collectInUseSchemaTargets', () => {
  it('returns distinct (marketplace, productType) pairs from cached schemas', async () => {
    const prisma = {
      categorySchema: {
        findMany: vi.fn().mockResolvedValue([
          { marketplace: 'IT', productType: 'COAT' },
          { marketplace: 'IT', productType: 'PANTS' },
          { marketplace: 'IT', productType: 'COAT' }, // duplicate — should be removed
        ]),
      },
    } as any
    const out = await collectInUseSchemaTargets(prisma)
    expect(out).toEqual([
      { marketplace: 'IT', productType: 'COAT' },
      { marketplace: 'IT', productType: 'PANTS' },
    ])
  })

  it('defaults null marketplace to IT', async () => {
    const prisma = {
      categorySchema: {
        findMany: vi.fn().mockResolvedValue([
          { marketplace: null, productType: 'SHOE' },
          { marketplace: 'DE', productType: 'SHOE' },
        ]),
      },
    } as any
    const out = await collectInUseSchemaTargets(prisma)
    expect(out).toEqual([
      { marketplace: 'IT', productType: 'SHOE' },
      { marketplace: 'DE', productType: 'SHOE' },
    ])
  })

  it('returns empty array when no active schemas exist', async () => {
    const prisma = {
      categorySchema: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any
    const out = await collectInUseSchemaTargets(prisma)
    expect(out).toEqual([])
  })

  it('passes correct query args to findMany', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const prisma = { categorySchema: { findMany } } as any
    await collectInUseSchemaTargets(prisma)
    expect(findMany).toHaveBeenCalledWith({
      where: { channel: 'AMAZON', isActive: true },
      select: { marketplace: true, productType: true },
      orderBy: [{ marketplace: 'asc' }, { productType: 'asc' }],
    })
  })
})
