import type { OpsObject, OpsGraph, OpsNode } from './types'

export const COL_WIDTH = 240
export const NODE_H = 64
export const V_GAP = 18
export const GRID_THRESHOLD = 8
export const GRID_COLS = 4
export const GRID_COL_W = 172

/**
 * Parent-aware recursive tree layout.
 * - Children are placed one column to the right of their parent.
 * - Siblings stack vertically; a parent is vertically centered over its subtree.
 * - A node whose children are ALL leaves and number more than GRID_THRESHOLD
 *   lays those children out in a compact GRID_COLS-wide grid (so a market with
 *   38 campaigns reads as a tidy block, not one unreadable column).
 */
export function buildGraph(objects: OpsObject[]): OpsGraph {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const childrenOf = new Map<string, OpsObject[]>()
  const roots: OpsObject[] = []
  for (const o of objects) {
    if (o.parentId && byId.has(o.parentId)) {
      const arr = childrenOf.get(o.parentId) ?? []
      arr.push(o)
      childrenOf.set(o.parentId, arr)
    } else {
      roots.push(o)
    }
  }

  const pos = new Map<string, { x: number; y: number }>()

  const layout = (node: OpsObject, depth: number, top: number): number => {
    const x = depth * COL_WIDTH
    const kids = childrenOf.get(node.id) ?? []
    if (kids.length === 0) {
      pos.set(node.id, { x, y: top })
      return NODE_H
    }
    const allLeaves = kids.every((k) => (childrenOf.get(k.id)?.length ?? 0) === 0)
    if (allLeaves && kids.length > GRID_THRESHOLD) {
      const rows = Math.ceil(kids.length / GRID_COLS)
      kids.forEach((k, i) => {
        pos.set(k.id, {
          x: (depth + 1) * COL_WIDTH + (i % GRID_COLS) * GRID_COL_W,
          y: top + Math.floor(i / GRID_COLS) * (NODE_H + V_GAP),
        })
      })
      const blockExtent = rows * NODE_H + (rows - 1) * V_GAP
      pos.set(node.id, { x, y: top + (blockExtent - NODE_H) / 2 })
      return Math.max(blockExtent, NODE_H)
    }
    let cursor = top
    for (const k of kids) {
      cursor += layout(k, depth + 1, cursor) + V_GAP
    }
    const childrenExtent = cursor - top - V_GAP
    pos.set(node.id, { x, y: top + (childrenExtent - NODE_H) / 2 })
    return Math.max(childrenExtent, NODE_H)
  }

  let cursor = 0
  for (const r of roots) {
    cursor += layout(r, 0, cursor) + V_GAP
  }

  const nodes: OpsNode[] = objects.map((o) => ({
    id: o.id,
    type: 'object' as const,
    position: pos.get(o.id) ?? { x: 0, y: 0 },
    data: { kind: o.kind, name: o.name, spend: o.spend, acos: o.acos, health: o.health },
  }))

  const edges = objects
    .filter((o) => o.parentId && byId.has(o.parentId))
    .map((o) => ({
      id: `${o.parentId}->${o.id}`,
      source: o.parentId as string,
      target: o.id,
      type: 'smoothstep' as const,
    }))

  return { nodes, edges }
}
