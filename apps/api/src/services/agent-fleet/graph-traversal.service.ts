/**
 * NAF.H — H2: recursive-CTE traversal over GraphEdge (Postgres, no graph
 * database — the acceptance demands zero new systems). Undirected walk:
 * an edge is followed from either end, open edges only (validTo IS NULL).
 * Depth capped at 3 by default; the whole result capped at 500 rows so a
 * dense subgraph cannot flood a caller.
 */
import { Prisma } from '@nexus/database'
import prisma from '../../db.js'

export interface TraversalEdge {
  fromType: string
  fromId: string
  toType: string
  toId: string
  relation: string
  depth: number
}

export async function traverse(
  fromType: string,
  fromId: string,
  opts: { depth?: number; relations?: string[] } = {},
): Promise<TraversalEdge[]> {
  const depth = Math.min(Math.max(opts.depth ?? 3, 1), 5)
  const relationFilter = opts.relations?.length
    ? Prisma.sql`AND e."relation" IN (${Prisma.join(opts.relations)})`
    : Prisma.empty

  // Frontier walk over NODES, then one pass selecting edges among the
  // visited set. The naive edge-recursive form (join on either endpoint
  // of every walked edge) re-expanded the campaign clique from both ends
  // and measured p95≈760ms server-side on real volume; this shape holds
  // p95 in single-digit ms because each node expands via two indexed
  // probes and UNION dedupes the frontier.
  const rows = await prisma.$queryRaw<TraversalEdge[]>(Prisma.sql`
    WITH RECURSIVE visit AS (
      SELECT ${fromType}::text AS type, ${fromId}::text AS id, 0 AS depth
      UNION
      SELECT nxt.type, nxt.id, v.depth + 1
      FROM visit v
      CROSS JOIN LATERAL (
        SELECT e."toType" AS type, e."toId" AS id
        FROM "GraphEdge" e
        WHERE e."validTo" IS NULL ${relationFilter}
          AND e."fromType" = v.type AND e."fromId" = v.id
        UNION ALL
        SELECT e."fromType", e."fromId"
        FROM "GraphEdge" e
        WHERE e."validTo" IS NULL ${relationFilter}
          AND e."toType" = v.type AND e."toId" = v.id
      ) nxt
      WHERE v.depth < ${depth}
    ),
    vmin AS (
      SELECT type, id, MIN(depth) AS d FROM visit GROUP BY type, id
    )
    SELECT e."fromType", e."fromId", e."toType", e."toId", e."relation",
           (LEAST(vf.d, vt.d) + 1)::int AS depth
    FROM "GraphEdge" e
    JOIN vmin vf ON vf.type = e."fromType" AND vf.id = e."fromId"
    JOIN vmin vt ON vt.type = e."toType" AND vt.id = e."toId"
    WHERE e."validTo" IS NULL ${relationFilter}
    LIMIT 500
  `)
  return rows
}

/** Depth-1 both-direction read — the bounded query the critic checks use. */
export async function neighbors(
  entityType: string,
  entityId: string,
  relations: string[],
): Promise<
  Array<{
    fromType: string
    fromId: string
    toType: string
    toId: string
    relation: string
    weight: unknown
    properties: unknown
  }>
> {
  return prisma.graphEdge.findMany({
    where: {
      validTo: null,
      relation: { in: relations },
      OR: [
        { fromType: entityType, fromId: entityId },
        { toType: entityType, toId: entityId },
      ],
    },
    select: {
      fromType: true,
      fromId: true,
      toType: true,
      toId: true,
      relation: true,
      weight: true,
      properties: true,
    },
    take: 100,
  })
}
