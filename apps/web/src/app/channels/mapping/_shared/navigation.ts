/** Canonical mapping coordinates; preview product and category are independent dimensions. */
export function mappingHref(input: { channel: string; market?: string | null; category?: string | null; field?: string | null; productId?: string | null }): string {
  const query = new URLSearchParams({ channel: input.channel })
  if (input.market) query.set('market', input.market)
  if (input.category) query.set('category', input.category)
  if (input.field) query.set('field', input.field)
  if (input.productId) query.set('product', input.productId)
  return `/channels/mapping?${query}`
}
