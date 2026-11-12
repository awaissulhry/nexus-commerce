import type { TreeLocation } from '../locations/rules'

/** The ids of a location and every location inside it (any depth), in the order found; [] when it is not in the list. */
export function subtreeIds(locations: readonly TreeLocation[], rootId: string): string[] {
  if (!locations.some((location) => location.id === rootId)) return []
  const children = new Map<string, string[]>()
  for (const location of locations) {
    if (location.parentId !== null) children.set(location.parentId, [...(children.get(location.parentId) ?? []), location.id])
  }
  const found: string[] = []
  const seen = new Set<string>()
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    found.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return found
}
