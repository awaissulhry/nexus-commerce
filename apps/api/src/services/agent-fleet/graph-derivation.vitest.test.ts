/**
 * NAF.H — H1: edge derivation. Derived edges reconcile idempotently:
 * present pairs upsert with validTo=NULL, vanished pairs soft-close with
 * validTo=now. History is kept, never rewritten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    graphEdge: { findMany: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    productVariation: { findMany: vi.fn() },
    adProductAd: { findMany: vi.fn() },
    adTarget: { findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import {
  deriveKeywordCompetition,
  deriveSharedInventory,
  deriveVariantOf,
} from './graph-derivation.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.graphEdge.findMany.mockResolvedValue([] as never)
  db.graphEdge.updateMany.mockResolvedValue({ count: 0 } as never)
  db.graphEdge.upsert.mockResolvedValue({} as never)
  db.productVariation.findMany.mockResolvedValue([] as never)
  db.adProductAd.findMany.mockResolvedValue([] as never)
  db.adTarget.findMany.mockResolvedValue([] as never)
})

describe('deriveVariantOf', () => {
  it('one edge per variation → parent product, and closes vanished edges', async () => {
    db.productVariation.findMany.mockResolvedValue([
      { id: 'v1', productId: 'p1' },
      { id: 'v2', productId: 'p1' },
    ] as never)
    db.graphEdge.findMany.mockResolvedValue([
      // stale edge from a deleted variation — must be closed
      { id: 'e-old', fromType: 'variation', fromId: 'v9', toType: 'product', toId: 'p9' },
    ] as never)

    const out = await deriveVariantOf()
    expect(out.upserted).toBe(2)
    expect(out.closed).toBe(1)
    expect(db.graphEdge.upsert).toHaveBeenCalledTimes(2)
    const first = db.graphEdge.upsert.mock.calls[0]![0]! as {
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    expect(first.create).toMatchObject({
      fromType: 'variation',
      fromId: 'v1',
      toType: 'product',
      toId: 'p1',
      relation: 'VARIANT_OF',
      source: 'derived',
    })
    // a re-appearing edge reopens rather than duplicating
    expect(first.update.validTo).toBeNull()
    const close = db.graphEdge.updateMany.mock.calls[0]![0]! as {
      where: { id: { in: string[] } }
      data: Record<string, unknown>
    }
    expect(close.where.id.in).toEqual(['e-old'])
    expect(close.data.validTo).toBeInstanceOf(Date)
  })
})

describe('deriveKeywordCompetition', () => {
  const target = (campaign: string, marketplace: string, text: string) => ({
    expressionValue: text,
    expressionType: 'EXACT',
    adGroup: { campaign: { id: campaign, marketplace, status: 'ENABLED', spend: 0, sales: 0 } },
  })

  it('campaigns sharing a keyword in the SAME marketplace compete, canonically ordered', async () => {
    db.adTarget.findMany.mockResolvedValue([
      target('c2', 'IT', 'Giacca Moto'),
      target('c1', 'IT', 'giacca  moto'),
    ] as never)
    const out = await deriveKeywordCompetition()
    expect(out.competesWith.upserted).toBe(1)
    const call = db.graphEdge.upsert.mock.calls.find(
      (c) => (c[0] as { create: { relation: string } }).create.relation === 'COMPETES_WITH',
    )!
    const create = (call[0] as { create: Record<string, unknown> }).create
    expect(create.fromId).toBe('c1') // canonical order halves the pairs
    expect(create.toId).toBe('c2')
  })

  it('the same keyword in DIFFERENT marketplaces is no contest', async () => {
    db.adTarget.findMany.mockResolvedValue([
      target('c1', 'IT', 'giacca moto'),
      target('c2', 'DE', 'giacca moto'),
    ] as never)
    const out = await deriveKeywordCompetition()
    expect(out.competesWith.upserted).toBe(0)
  })

  it('CANNIBALIZES points from the demoted campaign to the ACOS winner', async () => {
    db.adTarget.findMany.mockResolvedValue([
      {
        ...target('c-good', 'IT', 'giacca moto'),
        adGroup: {
          campaign: { id: 'c-good', marketplace: 'IT', status: 'ENABLED', spend: 100, sales: 1000 },
        },
      },
      {
        ...target('c-bad', 'IT', 'giacca moto'),
        adGroup: {
          campaign: { id: 'c-bad', marketplace: 'IT', status: 'ENABLED', spend: 100, sales: 50 },
        },
      },
    ] as never)
    const out = await deriveKeywordCompetition()
    expect(out.cannibalizes.upserted).toBe(1)
    const call = db.graphEdge.upsert.mock.calls.find(
      (c) => (c[0] as { create: { relation: string } }).create.relation === 'CANNIBALIZES',
    )!
    const create = (call[0] as { create: Record<string, unknown> }).create
    expect(create.fromId).toBe('c-bad')
    expect(create.toId).toBe('c-good')
  })
})

describe('deriveSharedInventory', () => {
  it('campaigns in different marketplaces advertising the same product share the pool', async () => {
    const pairs = [
      { campaignId: 'c-it', marketplace: 'IT', productId: 'p1' },
      { campaignId: 'c-de', marketplace: 'DE', productId: 'p1' },
      { campaignId: 'c-it2', marketplace: 'IT', productId: 'p1' },
    ]
    const out = await deriveSharedInventory(pairs)
    // c-it↔c-de and c-de↔c-it2 share across marketplaces; c-it↔c-it2 do
    // not (same marketplace = same listing, not a cross-pool draw).
    expect(out.upserted).toBe(2)
  })
})
