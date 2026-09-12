import { WorkspaceCache } from '../../lib/workspace-cache.js'
import { resolveConnection } from '../connection-resolver.service.js'
import { etsyReader } from './read-client.js'

export interface EtsyCategoryChoice { productType: string; displayName: string }
const cache = new WorkspaceCache<string, { expires: number; pending: Promise<EtsyCategoryChoice[]> }>()

/** Seller taxonomy identity stays separate from translated names and breadcrumbs. */
export function flattenEtsyTaxonomy(body: unknown): EtsyCategoryChoice[] {
  const roots = (body as { results?: unknown[] } | null)?.results
  if (!Array.isArray(roots)) throw new Error('Etsy returned an incomplete seller taxonomy.')
  const items: EtsyCategoryChoice[] = [], ids = new Set<number>()
  const walk = (nodes: unknown[], path: string[], depth: number) => {
    if (depth > 30) throw new Error('Etsy returned an invalid seller taxonomy.')
    for (const node of nodes) {
      const n = node as { id: number; name: string; children: unknown[] }
      if (!n || !Number.isSafeInteger(n.id) || n.id < 1 || ids.has(n.id) || typeof n.name !== 'string' || !n.name.trim() || !Array.isArray(n.children)) throw new Error('Etsy returned an invalid seller category.')
      ids.add(n.id)
      const names = [...path, n.name]
      items.push({ productType: String(n.id), displayName: names.join(' › ') })
      walk(n.children, names, depth + 1)
    }
  }
  walk(roots, [], 0)
  return items
}

export async function getEtsyTaxonomy(accountId?: string, fresh = false): Promise<EtsyCategoryChoice[]> {
  const account = await resolveConnection(accountId ? { accountId } : { channel: 'ETSY', primary: true })
  if (account.channelType !== 'ETSY') throw new Error('The selected account is not Etsy.')
  const hit = cache.get(account.id)
  if (!fresh && hit && hit.expires > Date.now()) return hit.pending
  const entry = { expires: Date.now() + 86_400_000, pending: Promise.resolve([] as EtsyCategoryChoice[]) }
  entry.pending = etsyReader(account.id).then(({ get }) => get('/seller-taxonomy/nodes')).then(flattenEtsyTaxonomy).catch(error => {
    if (cache.get(account.id) === entry) cache.delete(account.id)
    throw error
  })
  cache.set(account.id, entry)
  return entry.pending
}
