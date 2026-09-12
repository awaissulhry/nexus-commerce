import { getBackendUrl } from '@/lib/backend-url'

export interface CategoryOption { value: string; label: string; title: string; searchText: string }

export async function loadCategoryOptions(channel: 'AMAZON' | 'EBAY' | 'ETSY', market: string, search: string, signal: AbortSignal, refresh = false, accountId?: string): Promise<CategoryOption[]> {
  if (channel !== 'AMAZON' && search.trim().length < 2) return []
  // Standard taxonomy is shared within the business; account-specific eligibility is validated separately.
  const query = new URLSearchParams({ q: search.trim(), assignable: '1' })
  void refresh; void accountId
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/api/pim/taxonomies/${channel}/${encodeURIComponent(market)}/nodes?${query}`, { credentials: 'include', signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('Category search could not connect. Check your connection and try again.')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    if (['auth', 'auth_missing', 'auth_failed'].includes(body?.code) || response.status === 401 || response.status === 403) throw new Error(`Category search is unavailable. Check the ${channel === 'EBAY' ? 'eBay' : channel === 'ETSY' ? 'Etsy' : 'Amazon'} connection in Connections, then try again.`)
    throw new Error('Category search is temporarily unavailable. Try again.')
  }
  if (body?.state === 'missing') throw new Error('Synchronize this channel in Products → Categories → Taxonomy updates, then try again.')
  if (!Array.isArray(body?.items)) throw new Error('Category search returned an incomplete response. Try again.')
  return body.items.flatMap((item: { externalId?: unknown; path?: unknown } | null) => {
    if (!item || typeof item.externalId !== 'string' || !item.externalId || typeof item.path !== 'string' || !item.path.trim()) return []
    return [{ value: item.externalId, label: item.path, title: `${item.path}\nID: ${item.externalId}`, searchText: `${item.path} ${item.externalId}` }]
  })
}
