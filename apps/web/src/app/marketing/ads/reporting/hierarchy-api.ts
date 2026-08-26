/**
 * GX.3 — client contract for the drill-down tree.
 *
 * Mirrors the service exactly and computes nothing: the metrics, the remainder and its reason
 * are all decided server-side beside the SQL that produced them. A percentage computed in the
 * browser is a second definition of the same thing, and a second definition is how a parent and
 * its own children end up disagreeing.
 */
import { getBackendUrl } from '@/lib/backend-url'

export type HierarchyLevel = 'root' | 'market' | 'portfolio' | 'campaign'
export type Decompose = 'product' | 'target'
export type NodeKind = 'market' | 'portfolio' | 'campaign' | 'product' | 'target' | 'remainder'

export interface HierarchyNode {
  id: string
  label: string
  sub: string | null
  kind: NodeKind
  expandable: boolean
  href: string | null
  metrics: Record<string, number | null>
}

export interface HierarchyResult {
  level: HierarchyLevel
  parentId: string | null
  childLabel: string
  decompose: Decompose | null
  nodes: HierarchyNode[]
  parentMetrics: Record<string, number | null> | null
  remainder: { amount: number; pctOfParent: number; reason: string } | null
  columns: Array<{ id: string; label: string; format: string; help?: string }>
  caveats: string[]
  elapsedMs: number
}

/** The next level down, or null when this node is a leaf. */
export const nextLevel = (kind: NodeKind): HierarchyLevel | null => {
  if (kind === 'market') return 'market'
  if (kind === 'portfolio') return 'portfolio'
  if (kind === 'campaign') return 'campaign'
  return null
}

export async function fetchHierarchy(
  q: {
    level: HierarchyLevel
    parentId?: string | null
    from: string
    to: string
    decompose?: Decompose
    marketplaces?: string[]
  },
  signal?: AbortSignal,
): Promise<HierarchyResult> {
  const qs = new URLSearchParams({ level: q.level, from: q.from, to: q.to })
  if (q.parentId) qs.set('parentId', q.parentId)
  if (q.decompose) qs.set('decompose', q.decompose)
  if (q.marketplaces?.length) qs.set('marketplaces', q.marketplaces.join(','))
  const res = await fetch(`${getBackendUrl()}/api/advertising/reporting/hierarchy?${qs}`, {
    credentials: 'include',
    signal,
    // The route caches for a minute and expanding re-requests the same URL; without this a
    // re-expand after a filter change can hand back the previous answer.
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Could not load this level (${res.status})`)
  }
  return res.json() as Promise<HierarchyResult>
}

/**
 * One row of the flat list the grid renders.
 *
 * The tree is held flat on purpose — parents and their loaded children interleaved in display
 * order, each carrying its own depth. It is what the grid wants, it makes "insert these children
 * after this parent" a splice rather than a recursive rebuild, and it keeps every row addressable
 * by a single id.
 */
export interface FlatNode extends HierarchyNode {
  depth: number
  /** The chain of ids from the root down to this node, for the breadcrumb and for re-fetching. */
  path: string[]
  /** Which decomposition this row was loaded under, so a campaign can be re-expanded the other way. */
  decompose: Decompose | null
}

/** Splice a node's children in directly after it, replacing any it already had. */
export function insertChildren(
  rows: FlatNode[],
  parentId: string,
  children: FlatNode[],
): FlatNode[] {
  const at = rows.findIndex((r) => r.id === parentId)
  if (at < 0) return rows
  const depth = rows[at].depth
  // Everything deeper than the parent, immediately after it, is its existing subtree.
  let end = at + 1
  while (end < rows.length && rows[end].depth > depth) end++
  return [...rows.slice(0, at + 1), ...children, ...rows.slice(end)]
}

/** Drop a node's whole subtree — used on collapse, and before re-expanding the other way. */
export function removeChildren(rows: FlatNode[], parentId: string): FlatNode[] {
  const at = rows.findIndex((r) => r.id === parentId)
  if (at < 0) return rows
  const depth = rows[at].depth
  let end = at + 1
  while (end < rows.length && rows[end].depth > depth) end++
  return [...rows.slice(0, at + 1), ...rows.slice(end)]
}
