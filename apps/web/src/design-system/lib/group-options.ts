/**
 * Bucket options under their `group`, preserving first-seen order, and return the flattened list
 * in exactly the order the groups render.
 *
 * The flat list is the point. Grouping REORDERS options, and the Listbox's keyboard navigation
 * indexes a flat array — so if the array it walks is not the rendered order, ArrowDown moves
 * through a sequence the eye cannot follow and Enter picks the wrong row. Returning both from one
 * function is what keeps them in step.
 *
 * Options with no `group` bucket under `''`, which renders without a heading.
 */
export interface GroupableOption {
  group?: string
}

export interface GroupedOptions<T> {
  groups: Array<{ name: string; options: T[] }>
  flat: T[]
}

export function groupOptions<T extends GroupableOption>(options: readonly T[]): GroupedOptions<T> | null {
  if (!options.some((o) => o.group)) return null
  const order: string[] = []
  const byGroup = new Map<string, T[]>()
  for (const o of options) {
    const g = o.group ?? ''
    let bucket = byGroup.get(g)
    if (!bucket) {
      bucket = []
      byGroup.set(g, bucket)
      order.push(g)
    }
    bucket.push(o)
  }
  const groups = order.map((name) => ({ name, options: byGroup.get(name)! }))
  return { groups, flat: groups.flatMap((g) => g.options) }
}
