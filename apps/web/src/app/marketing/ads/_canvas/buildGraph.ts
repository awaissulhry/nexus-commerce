import type { OpsObject, OpsGraph, ObjectKind } from './types'

const LEVELS: ObjectKind[] = ['market', 'portfolio', 'campaign', 'adgroup', 'target']
export const COL_WIDTH = 220
export const ROW_HEIGHT = 92

export function buildGraph(objects: OpsObject[]): OpsGraph {
  const rowCursor: Record<number, number> = {}
  const nodes = objects.map((o) => {
    const depth = LEVELS.indexOf(o.kind)
    const level = depth < 0 ? LEVELS.length : depth
    const row = rowCursor[level] ?? 0
    rowCursor[level] = row + 1
    return {
      id: o.id,
      type: 'object' as const,
      position: { x: level * COL_WIDTH, y: row * ROW_HEIGHT },
      data: { kind: o.kind, name: o.name, spend: o.spend, acos: o.acos, health: o.health },
    }
  })
  const ids = new Set(objects.map((o) => o.id))
  const edges = objects
    .filter((o) => o.parentId && ids.has(o.parentId))
    .map((o) => ({
      id: `${o.parentId}->${o.id}`,
      source: o.parentId as string,
      target: o.id,
      type: 'smoothstep' as const,
    }))
  return { nodes, edges }
}
