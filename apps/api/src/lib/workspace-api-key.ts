/** Translate the existing key scopes to a particular route's required business permission. */
export function apiKeyPermission(scopes: string[], permission: string, method: string): boolean {
  const family = permission.split('.')[0]
  const read = ['GET', 'HEAD'].includes(method.toUpperCase())
  if (scopes.includes('admin')) return true
  const scopeFamily = ['products', 'pim', 'assets'].includes(family) ? 'products'
    : ['listings', 'channels'].includes(family) ? 'listings'
    : ['orders', 'customers'].includes(family) ? 'orders'
    : ['inventory', 'stock', 'lots', 'inbound', 'outbound', 'returns', 'suppliers', 'po', 'replenishment', 'carriers', 'fnsku', 'fulfillment'].includes(family) ? 'stock'
    : ['analytics', 'insights', 'forecast', 'reports', 'financials'].includes(family) ? 'analytics'
    : null
  return !!scopeFamily && scopes.includes(`${scopeFamily}:${read ? 'read' : 'write'}`)
}
