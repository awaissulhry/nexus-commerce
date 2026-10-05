/**
 * E1 — the name an Etsy account is shown by: the shop's name, never the login name.
 *
 * For Etsy, `displayName` (and `identity.username`) hold the login name (token.service.ts writes `identity.username`,
 * which the Etsy connector fills with `login_name`), a code buyers never see. The shop's name is `identity.extra.shopName`;
 * `identity.storeName` and its copy `ebayStoreName` are that name too, except that the connector falls back to the login
 * name and then to "Etsy shop <shop id>" when Etsy sends no shop name (cx/connectors/etsy/spec.ts) — so those two
 * fallbacks are skipped here, and a shop with no name reads "Etsy shop". eBay, Amazon and Shopify keep their own label.
 */
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null

export function etsyShopLabel(account: { accountLabel?: string | null; ebayStoreName?: string | null; identity?: unknown }): string {
  const identity = object(account.identity)
  const shopName = text(object(identity.extra).shopName)
  const login = text(identity.username)
  // The operator's own label first, then the shop's name; a copy of it counts only when it is not a connector fallback.
  const copied = (name: string | null) => name && name !== login && !/^Etsy shop \d+$/.test(name) ? name : null
  return text(account.accountLabel) ?? shopName ?? copied(text(identity.storeName)) ?? copied(text(account.ebayStoreName)) ?? 'Etsy shop'
}
