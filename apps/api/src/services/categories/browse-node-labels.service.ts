import prisma from '../../db.js'
import { extractBrowseNodes } from '../amazon/browse-nodes.js'
import { amazonMarketplaceId } from './marketplace-ids.js'
import { TtlCache } from '../../utils/ttl-cache.js'

const cache = new TtlCache<Promise<Record<string, string>>>({ ttlMs: 5 * 60_000, maxEntries: 30 })

/** Browse-node identity belongs to a marketplace, even when multiple product types use it. */
export function browseNodeNamesFromSchemas(nodes: unknown[], marketplace: string): Record<string, string> {
  const names = new Map<string, Set<string>>()
  for (const node of nodes) {
    for (const value of extractBrowseNodes({ properties: { recommended_browse_nodes: node } }, amazonMarketplaceId(marketplace))) {
      const label = value.path?.trim()
      if (!label || label === value.id) continue
      if (!names.has(value.id)) names.set(value.id, new Set())
      names.get(value.id)!.add(label)
    }
  }
  // Conflicting cached paths require fresh metadata; never choose one arbitrarily.
  return Object.fromEntries([...names].filter(([, paths]) => paths.size === 1).map(([id, paths]) => [id, [...paths][0]]))
}

export async function cachedBrowseNodeLabels(marketplace: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {}
  let pending = cache.get(marketplace)
  if (!pending) {
    pending = (async () => {
      // Only the latest active schema for each product type, and only its browse-node subtree.
      // Loading whole schemas would copy unrelated attributes and old versions into memory.
      const rows = await prisma.$queryRaw<Array<{ node: unknown }>>`
        SELECT node FROM (
          SELECT DISTINCT ON ("productType")
            "schemaDefinition"->'properties'->'recommended_browse_nodes' AS node
          FROM "CategorySchema"
          WHERE "channel" = 'AMAZON' AND "marketplace" = ${marketplace} AND "isActive" = true
          ORDER BY "productType", "fetchedAt" DESC, "id" DESC
        ) latest WHERE node IS NOT NULL`
      return browseNodeNamesFromSchemas(rows.map(row => row.node), marketplace)
    })().catch(error => { cache.delete(marketplace); throw error })
    cache.set(marketplace, pending)
  }
  const names = await pending
  return Object.fromEntries(ids.filter(id => names[id]).map(id => [id, names[id]]))
}
