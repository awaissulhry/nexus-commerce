/**
 * Phase S3 — map a nav href to the page permission it requires, and filter
 * the nav tree so only permitted links render. Prefixes mirror the API
 * route→permission manifest + the permission registry. Unknown hrefs map to
 * null (always shown) — filtering only ever HIDES a link we can prove the
 * user lacks, never breaks navigation on an unrecognised route.
 */

// href prefix → page permission (longest prefix wins).
const NAV_PERMS: Array<[string, string]> = [
  ['/marketing/advertising', 'pages.advertising'],
  ['/marketing/ads', 'pages.advertising'],
  ['/marketing/reviews', 'pages.reviews'],
  ['/marketing', 'pages.marketing'],
  ['/products', 'pages.products'],
  ['/catalog', 'pages.products'],
  ['/inventory', 'pages.products'],
  ['/listings', 'pages.listings'],
  ['/reconciliation', 'pages.listings'],
  ['/orders', 'pages.orders'],
  ['/fulfillment', 'pages.fulfillment'],
  ['/pricing', 'pages.pricing'],
  ['/insights', 'pages.insights'],
  ['/analytics', 'pages.analytics'],
  ['/reports', 'pages.analytics'],
  ['/customers', 'pages.customers'],
  ['/bulk-operations', 'pages.bulkOperations'],
  ['/sync-logs', 'pages.syncLogs'],
  ['/inbox', 'pages.syncLogs'],
  ['/outbound', 'pages.syncLogs'],
  ['/performance', 'pages.performance'],
  ['/admin', 'pages.admin'],
  ['/command-matrix', 'pages.admin'],
  ['/settings', 'pages.settings'],
]

export function navPagePermission(href: string): string | null {
  let best: string | null = null
  let bestLen = -1
  for (const [prefix, perm] of NAV_PERMS) {
    if ((href === prefix || href.startsWith(prefix + '/') || href.startsWith(prefix)) && prefix.length > bestLen) {
      best = perm
      bestLen = prefix.length
    }
  }
  return best
}

interface NavLike {
  href?: string
  children?: NavLike[]
}

/**
 * Filter a nav tree by permission. Keeps an item when its href needs no
 * known permission OR the user has it; a parent with no own permission is
 * kept if any child survives.
 */
export function filterNavByPermission<T extends NavLike>(items: T[], has: (perm: string) => boolean): T[] {
  const out: T[] = []
  for (const item of items) {
    const kids = item.children ? filterNavByPermission(item.children, has) : undefined
    const perm = item.href ? navPagePermission(item.href) : null
    const selfAllowed = perm === null || has(perm)
    if (selfAllowed || (kids && kids.length > 0)) {
      out.push(kids ? ({ ...item, children: kids } as T) : item)
    }
  }
  return out
}
