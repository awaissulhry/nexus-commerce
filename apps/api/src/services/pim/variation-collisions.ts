import { canonicalVariantAxis } from './variant-attribute-keys.js'

export function variationAxisValue(values: Record<string, string>, key: string): string {
  return values[key] ?? Object.entries(values).find(([name]) => canonicalVariantAxis(name) === canonicalVariantAxis(key))?.[1] ?? ''
}

/** Compare the actual included combinations, including duplicates that already existed before an axis drop. */
export function variationCollisionGroups<T extends { included: boolean; axisValues: Record<string, string> }>(axes: string[], variants: T[]): Array<{ key: string[]; members: T[] }> {
  const groups = new Map<string, { key: string[]; members: T[] }>()
  for (const variant of variants) {
    if (!variant.included) continue
    const key = axes.map(axis => variationAxisValue(variant.axisValues, axis))
    const encoded = JSON.stringify(key)
    const group = groups.get(encoded) ?? { key, members: [] }
    group.members.push(variant)
    groups.set(encoded, group)
  }
  return [...groups.values()].filter(group => group.members.length > 1)
}

export function variationCollisionSummary(unresolved: number, coordinate: string, dropped: string[]): string {
  if (!unresolved) return '0 collisions on this coordinate'
  return `${unresolved} variants cannot be told apart on ${coordinate}${dropped.length ? ` after ${dropped.join(', ')} is dropped` : ' with the current variation values'}.`
}
