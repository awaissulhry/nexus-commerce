/**
 * Reads the category tables directly (as the fixture owner, below row security) and lists every broken
 * invariant `CategoryTreeService` promises. An empty list means the tree is consistent.
 *
 *   • parentId has no cycle, and no two siblings share a URL key.
 *   • Category.depth is the number of ancestors.
 *   • CategoryClosure holds exactly one (ancestor, descendant, hops) row per root→node path step,
 *     including the self-row, and nothing else.
 *   • A product with memberships has exactly one primary membership.
 */
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>

export async function categoryTreeProblems(query: Query): Promise<string[]> {
  const categories: Array<{ id: string; parentId: string | null; slug: string; depth: number }> = (await query('SELECT id, "parentId", slug, depth FROM "Category"')).rows
  const closure: Array<{ ancestorId: string; descendantId: string; depth: number }> = (await query('SELECT "ancestorId", "descendantId", depth FROM "CategoryClosure"')).rows
  const primaries: Array<{ productId: string; primaries: number }> = (await query('SELECT "productId", count(*) FILTER (WHERE "isPrimary")::int AS primaries FROM "ProductCategory" GROUP BY "productId"')).rows
  const problems: string[] = []
  const parent = new Map(categories.map((c) => [c.id, c.parentId]))
  const expected = new Map<string, number>()
  const siblings = new Set<string>()
  for (const category of categories) {
    const sibling = `${category.parentId ?? ''}/${category.slug}`
    if (siblings.has(sibling)) problems.push(`two siblings share the URL key ${sibling}`)
    siblings.add(sibling)
    const seen = new Set<string>()
    let at: string | null = category.id
    let hops = 0
    while (at) {
      if (seen.has(at)) { problems.push(`parentId cycle through ${category.id}`); break }
      seen.add(at)
      expected.set(`${at}>${category.id}`, hops)
      at = parent.get(at) ?? null
      hops++
    }
    if (!at && category.depth !== hops - 1) problems.push(`${category.id} has depth ${category.depth}, expected ${hops - 1}`)
  }
  const actual = new Map(closure.map((row) => [`${row.ancestorId}>${row.descendantId}`, row.depth]))
  for (const [key, hops] of expected) {
    if (!actual.has(key)) problems.push(`closure is missing ${key}`)
    else if (actual.get(key) !== hops) problems.push(`closure ${key} has depth ${actual.get(key)}, expected ${hops}`)
  }
  for (const key of actual.keys()) if (!expected.has(key)) problems.push(`closure has a stray row ${key}`)
  for (const row of primaries) if (row.primaries !== 1) problems.push(`product ${row.productId} has ${row.primaries} primary categories`)
  return problems
}
