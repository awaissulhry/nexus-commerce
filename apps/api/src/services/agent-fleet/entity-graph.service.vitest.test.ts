/**
 * FX.10 — the entity graph reader: named nodes, honest truncation,
 * degree ranking, and the overview restricted to the human-scale
 * campaign↔campaign layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    graphEdge: { findMany: vi.fn() },
    campaign: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    productVariation: { findMany: vi.fn() },
  },
}))
vi.mock('./graph-traversal.service.js', () => ({ traverse: vi.fn() }))

import prisma from '../../db.js'
import { traverse } from './graph-traversal.service.js'
import {
  getEntityGraphOverview,
  getEntityNeighborhood,
  OVERVIEW_RELATIONS,
} from './entity-graph.service.js'

const db = vi.mocked(prisma, true)
const walk = vi.mocked(traverse)

const edge = (from: string, to: string, relation = 'COMPETES_WITH') => ({
  fromType: 'campaign',
  fromId: from,
  toType: 'campaign',
  toId: to,
  relation,
  weight: 3,
  properties: { sharedKeywords: ['giacca moto'] },
})

beforeEach(() => {
  vi.clearAllMocks()
  db.graphEdge.findMany.mockResolvedValue([edge('c1', 'c2'), edge('c2', 'c3', 'CANNIBALIZES')] as never)
  db.campaign.findMany.mockResolvedValue([
    { id: 'c1', name: 'XAVIA IT Broad', marketplace: 'IT', adProduct: 'SP' },
    { id: 'c2', name: 'XAVIA IT Exact', marketplace: 'IT', adProduct: 'SP' },
    { id: 'c3', name: 'XAVIA DE Auto', marketplace: 'DE', adProduct: 'SP' },
  ] as never)
  db.product.findMany.mockResolvedValue([] as never)
  db.productVariation.findMany.mockResolvedValue([] as never)
  walk.mockResolvedValue([] as never)
})

describe('getEntityGraphOverview', () => {
  it('queries only the campaign↔campaign relations, open edges', async () => {
    await getEntityGraphOverview()
    const where = (db.graphEdge.findMany.mock.calls[0]![0] as { where: Record<string, unknown> })
      .where
    expect(where.validTo).toBeNull()
    expect(where.relation).toEqual({ in: [...OVERVIEW_RELATIONS] })
  })

  it('names every node and ranks by degree', async () => {
    const g = await getEntityGraphOverview()
    expect(g.nodes).toHaveLength(3)
    expect(g.nodes[0]).toMatchObject({ id: 'c2', label: 'XAVIA IT Exact', degree: 2 })
    expect(g.nodes.map((n) => n.label)).toContain('XAVIA IT Broad')
    expect(g.relationCounts).toEqual({ COMPETES_WITH: 1, CANNIBALIZES: 1 })
    expect(g.focus).toBeNull()
  })

  it('an unresolved id is shown as itself, never invented', async () => {
    db.campaign.findMany.mockResolvedValue([] as never)
    const g = await getEntityGraphOverview()
    expect(g.nodes.every((n) => n.label === n.id)).toBe(true)
  })

  it('flags truncation instead of silently cutting', async () => {
    db.graphEdge.findMany.mockResolvedValue([edge('a', 'b'), edge('b', 'c')] as never)
    const g = await getEntityGraphOverview(1)
    expect(g.truncated).toBe(true)
    expect(g.edges).toHaveLength(1)
  })
})

describe('getEntityNeighborhood', () => {
  it('walks from the focus entity and carries it in the result', async () => {
    walk.mockResolvedValue([
      { fromType: 'campaign', fromId: 'c1', toType: 'product', toId: 'p1', relation: 'TARGETS', depth: 1 },
    ] as never)
    db.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Giacca Moto Uomo', sku: 'XAV-001', totalStock: 12 },
    ] as never)

    const g = await getEntityNeighborhood('campaign', 'c1', { depth: 2 })
    expect(walk).toHaveBeenCalledWith('campaign', 'c1', expect.objectContaining({ depth: 2 }))
    expect(g.focus).toEqual({ type: 'campaign', id: 'c1' })
    const product = g.nodes.find((n) => n.type === 'product')!
    expect(product.label).toBe('Giacca Moto Uomo')
    expect(product.sublabel).toContain('12 in stock')
  })

  it('an isolated entity comes back empty, not fabricated', async () => {
    const g = await getEntityNeighborhood('campaign', 'lonely')
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
    expect(g.truncated).toBe(false)
  })
})
