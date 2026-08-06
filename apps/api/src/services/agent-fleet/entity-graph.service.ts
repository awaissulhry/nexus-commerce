/**
 * FX.10 — the entity graph, made explorable (Phase H's cut-line overlay).
 *
 * H derived 5,900+ edges but nothing could read them. Two shapes serve
 * the whole overlay:
 *
 *  - OVERVIEW: the campaign↔campaign relations (COMPETES_WITH,
 *    CANNIBALIZES) — ~96 edges over ~30 campaigns on this account, which
 *    is a legible picture. TARGETS/SHARES_INVENTORY are thousands of
 *    edges and would render as a hairball, so they are reached by
 *    focusing one entity, never dumped whole.
 *  - NEIGHBOURHOOD: everything within N hops of one entity, via the
 *    frontier-CTE traversal (p95 ≈ 22ms on prod volume).
 *
 * Both return NAMED nodes — the FX design contract's rule 2 applies to
 * the graph too: campaign names and product titles, resolved here, never
 * cuids on the canvas.
 */
import prisma from '../../db.js'
import { traverse } from './graph-traversal.service.js'

/** Campaign↔campaign relations: the human-scale layer. */
export const OVERVIEW_RELATIONS = ['COMPETES_WITH', 'CANNIBALIZES'] as const
/** Everything H derives, for the focused view. */
export const ALL_RELATIONS = [
  'COMPETES_WITH',
  'CANNIBALIZES',
  'SHARES_INVENTORY',
  'TARGETS',
  'VARIANT_OF',
] as const

export interface EntityNode {
  type: string
  id: string
  label: string
  sublabel: string | null
  degree: number
}
export interface EntityEdge {
  from: string
  to: string
  fromType: string
  toType: string
  relation: string
  weight: number | null
  properties: unknown
}
export interface EntityGraphResult {
  nodes: EntityNode[]
  edges: EntityEdge[]
  focus: { type: string; id: string } | null
  truncated: boolean
  relationCounts: Record<string, number>
}

async function labelNodes(
  refs: Array<{ type: string; id: string }>,
): Promise<Map<string, { label: string; sublabel: string | null }>> {
  const out = new Map<string, { label: string; sublabel: string | null }>()
  const campaignIds = refs.filter((r) => r.type === 'campaign').map((r) => r.id)
  const productIds = refs.filter((r) => r.type === 'product').map((r) => r.id)
  const variationIds = refs.filter((r) => r.type === 'variation').map((r) => r.id)

  if (campaignIds.length) {
    const rows = await prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      select: { id: true, name: true, marketplace: true, adProduct: true },
    })
    for (const r of rows) {
      out.set(`campaign|${r.id}`, {
        label: r.name,
        sublabel: [r.marketplace, r.adProduct].filter(Boolean).join(' · ') || null,
      })
    }
  }
  if (productIds.length) {
    const rows = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, sku: true, totalStock: true },
    })
    for (const r of rows) {
      out.set(`product|${r.id}`, {
        label: r.name || r.sku,
        sublabel: `${r.sku} · ${r.totalStock} in stock`,
      })
    }
  }
  if (variationIds.length) {
    const rows = await prisma.productVariation.findMany({
      where: { id: { in: variationIds } },
      select: { id: true, sku: true },
    })
    for (const r of rows) out.set(`variation|${r.id}`, { label: r.sku, sublabel: null })
  }
  return out
}

function assemble(
  rows: EntityEdge[],
  focus: { type: string; id: string } | null,
  truncated: boolean,
  labels: Map<string, { label: string; sublabel: string | null }>,
): EntityGraphResult {
  const degree = new Map<string, number>()
  const seen = new Map<string, { type: string; id: string }>()
  const relationCounts: Record<string, number> = {}
  for (const e of rows) {
    relationCounts[e.relation] = (relationCounts[e.relation] ?? 0) + 1
    for (const side of [
      { type: e.fromType, id: e.from },
      { type: e.toType, id: e.to },
    ]) {
      const k = `${side.type}|${side.id}`
      seen.set(k, side)
      degree.set(k, (degree.get(k) ?? 0) + 1)
    }
  }
  const nodes: EntityNode[] = [...seen.entries()].map(([k, v]) => ({
    type: v.type,
    id: v.id,
    // An unresolved id is shown as itself — honest, never invented.
    label: labels.get(k)?.label ?? v.id,
    sublabel: labels.get(k)?.sublabel ?? null,
    degree: degree.get(k) ?? 0,
  }))
  nodes.sort((a, b) => b.degree - a.degree)
  return { nodes, edges: rows, focus, truncated, relationCounts }
}

export async function getEntityGraphOverview(
  limit = 120,
): Promise<EntityGraphResult> {
  const raw = await prisma.graphEdge.findMany({
    where: { validTo: null, relation: { in: [...OVERVIEW_RELATIONS] } },
    orderBy: { weight: 'desc' },
    take: limit + 1,
    select: {
      fromType: true,
      fromId: true,
      toType: true,
      toId: true,
      relation: true,
      weight: true,
      properties: true,
    },
  })
  const truncated = raw.length > limit
  const rows: EntityEdge[] = raw.slice(0, limit).map((e) => ({
    from: e.fromId,
    to: e.toId,
    fromType: e.fromType,
    toType: e.toType,
    relation: e.relation,
    weight: e.weight == null ? null : Number(e.weight),
    properties: e.properties,
  }))
  const labels = await labelNodes(
    rows.flatMap((e) => [
      { type: e.fromType, id: e.from },
      { type: e.toType, id: e.to },
    ]),
  )
  return assemble(rows, null, truncated, labels)
}

export async function getEntityNeighborhood(
  type: string,
  id: string,
  opts: { depth?: number; relations?: string[]; limit?: number } = {},
): Promise<EntityGraphResult> {
  const limit = opts.limit ?? 150
  const walked = await traverse(type, id, {
    depth: opts.depth ?? 2,
    relations: opts.relations?.length ? opts.relations : [...ALL_RELATIONS],
  })
  const truncated = walked.length > limit
  const rows: EntityEdge[] = walked.slice(0, limit).map((e) => ({
    from: e.fromId,
    to: e.toId,
    fromType: e.fromType,
    toType: e.toType,
    relation: e.relation,
    weight: null,
    properties: null,
  }))
  const labels = await labelNodes(
    rows.flatMap((e) => [
      { type: e.fromType, id: e.from },
      { type: e.toType, id: e.to },
    ]),
  )
  return assemble(rows, { type, id }, truncated, labels)
}
