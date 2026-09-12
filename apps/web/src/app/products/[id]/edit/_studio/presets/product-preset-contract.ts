export interface ProductPresetScope {
  productId: string; channel: 'AMAZON' | 'EBAY'; accountId: string; market: string; listingId: string | null; aliasKey: string
}
export const productPresetScopeKey = (s: ProductPresetScope) => JSON.stringify([s.productId, s.channel, s.accountId, s.market, s.listingId, s.aliasKey])
export function productPresetDraftHref(wizardId: string, scope: ProductPresetScope) {
  const query = new URLSearchParams({ wizard: wizardId, channel: scope.channel, accountId: scope.accountId, marketplace: scope.market, listingId: scope.listingId ?? '', aliasKey: scope.aliasKey })
  return `/products/${encodeURIComponent(scope.productId)}/list-wizard?${query}`
}
export function productPresetStudioHref(scope: ProductPresetScope) {
  const query = new URLSearchParams({ scope: scope.channel, account: scope.accountId, market: scope.market })
  if (scope.listingId) query.set('listing', scope.listingId)
  return `/products/${encodeURIComponent(scope.productId)}/edit?${query}`
}
export function displayPresetValue(value: { absent?: boolean; value?: unknown }) {
  if (value.absent) return 'Not set'
  if (value.value === '') return 'Explicit blank (preserved)'
  if (value.value === null) return 'Explicit null (preserved)'
  if (value.value === false) return 'False (preserved)'
  if (value.value === 'shared') return 'Use the shared product SKU'
  if (value.value === 'per-marketplace') return 'Add the market suffix to future listing SKUs'
  return String(value.value)
}

/** A newer selection, close or scope unmount invalidates even transports that ignore abort. */
export function createPresetRequestGate() {
  let generation = 0
  let controller: AbortController | undefined
  return {
    cancel() { generation++; controller?.abort() },
    begin() {
      controller?.abort()
      const current = ++generation, request = new AbortController()
      controller = request
      return { signal: request.signal, current: () => current === generation && !request.signal.aborted }
    },
  }
}
