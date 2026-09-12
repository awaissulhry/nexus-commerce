import { getBackendUrl } from '@/lib/backend-url'

export const policyLists: Record<string, string> = { paymentPolicyId: 'paymentPolicies', returnPolicyId: 'returnPolicies', fulfillmentPolicyId: 'fulfillmentPolicies' }
export type Policy = { id: string; name: string }
const cache = new Map<string, { expires: number; value: Promise<Record<string, Policy[]>> }>()

/** Names and editor choices must belong to the same seller and marketplace. */
export function loadEbayPolicies(market: string, refresh: boolean, connectionId?: string) {
  const marketplaceId = `EBAY_${market === 'UK' ? 'GB' : market}`
  const key = JSON.stringify([marketplaceId, connectionId ?? 'primary'])
  const hit = cache.get(key)
  if (!refresh && hit && hit.expires > Date.now()) return hit.value
  const query = new URLSearchParams({ marketplaceId, ...(connectionId ? { connectionId } : {}), ...(refresh ? { refresh: '1' } : {}) })
  const value = fetch(`${getBackendUrl()}/api/ebay/policies?${query}`, { credentials: 'include' })
    .then(async response => {
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || /credential|auth|token|not connected/i.test(body?.error ?? '')) throw new Error('Seller policies are unavailable. Check the eBay connection in Connections, then refresh policies.')
        throw new Error('Seller policies are temporarily unavailable. Refresh policies to try again.')
      }
      if (!body || typeof body !== 'object' || !Object.values(policyLists).every(list => Array.isArray(body[list]) && body[list].every((policy: unknown) => {
        const value = policy as Policy | null
        return value && typeof value.id === 'string' && value.id && typeof value.name === 'string' && value.name.trim()
      }))) throw new Error('Seller policies returned an incomplete response. Refresh policies to try again.')
      return body as Record<string, Policy[]>
    })
    .catch(error => {
      if (cache.get(key)?.value === value) cache.delete(key)
      if (error instanceof TypeError) throw new Error('Seller policies could not connect. Check your connection and refresh policies.')
      throw error
    })
  cache.set(key, { expires: Date.now() + 300_000, value })
  return value
}
