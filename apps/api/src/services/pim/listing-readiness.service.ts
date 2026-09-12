import type { Prisma } from '@prisma/client'
import type { ListingReadinessIssue, ListingReadinessPage, ListingReadinessRow } from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { resolveBatch, type ResolvedProduct } from './mapping/resolve-batch.service.js'
import { isPresent } from './resolve-channel-field.js'
import { marketLanguages } from './market-languages.js'

const PAGE_SIZE = 25
const identifier = (value: unknown, name: string) => {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Invalid ${name}`)
  return value.trim()
}
export function readinessQuery(query: Record<string, unknown>) {
  const familyId = identifier(query.familyId, 'family'), jobId = identifier(query.job, 'import job')
  const list = (value: unknown, name: string) => {
    if (value === undefined || value === '') return undefined
    if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
    // SKUs can themselves contain commas. New clients send a JSON list; a plain
    // string remains a single SKU for bookmarked links.
    let parsed: unknown
    try { parsed = name === 'SKUs' ? value.startsWith('[') ? JSON.parse(value) : [value] : value.split(',') } catch { throw new Error(`Invalid ${name}`) }
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 200 || parsed.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw new Error(`Choose 1–200 ${name}`)
    const values = [...new Set((parsed as string[]).map(v => v.trim()))]
    return values
  }
  const productIds = list(query.productIds, 'product IDs'), skus = list(query.skus, 'SKUs'), listingIds = list(query.listingIds, 'listing IDs')
  if ([familyId, jobId, productIds, skus, listingIds].filter(Boolean).length !== 1) throw new Error('Choose one product family, product selection, listing selection, SKU list or completed import')
  const accountId = identifier(query.accountId, 'account')
  const channel = identifier(query.channel, 'channel')?.toUpperCase()
  const marketplace = identifier(query.marketplace, 'marketplace')?.toUpperCase()
  if (channel && !['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'].includes(channel)) throw new Error('Select a supported channel')
  if (marketplace && marketplace !== 'GLOBAL' && !/^[A-Z]{2}$/.test(marketplace)) throw new Error('Select a valid marketplace')
  if (query.page !== undefined && (typeof query.page !== 'string' || !/^\d+$/.test(query.page))) throw new Error('Use a positive page number')
  const page = Number(query.page ?? 1)
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new Error('Use a positive page number')
  return { familyId, jobId, productIds, skus, listingIds, accountId, channel, marketplace, page }
}

export function preparationIssues(product: ResolvedProduct): ListingReadinessIssue[] {
  const issues: ListingReadinessIssue[] = []
  if (!Object.keys(product.cells).length) issues.push({ field: '', label: 'Attribute checks', kind: 'check', message: 'No attributes were evaluated for this listing. Review its category and schema.' })
  if (!product.readiness || product.readiness.schemaValidation !== 'evaluated') issues.push({ field: 'category', label: 'Category requirements', kind: 'schema', message: 'Category requirements could not be fully checked. Refresh the category schema in the channel mapping workspace.' })
  for (const cell of Object.values(product.cells)) {
    const identity = { field: cell.fieldKey, label: cell.label ?? cell.fieldKey }
    for (const message of cell.errors) issues.push({ ...identity, kind: cell.required && !isPresent(cell.value) ? 'missing' : 'invalid', message })
    if (cell.needsTranslation) issues.push({ ...identity, kind: 'translation', message: 'Complete and review the translation for this destination.' })
    for (const message of cell.warnings) issues.push({ ...identity, kind: 'warning', message })
  }
  // A future resolver-level block must never turn green merely because it has no cell error.
  if (product.readiness?.state === 'blocked' && !issues.some(i => i.kind !== 'warning')) issues.push({ field: '', label: 'Validation', kind: 'check', message: 'The mapping engine reports a blocking check. Review this listing in the editor.' })
  return [...new Map(issues.map(issue => [JSON.stringify([issue.field, issue.kind, issue.message]), issue])).values()]
}

/** One bounded listing page, grouped by exact account + market + alias. No channel writes. */
export async function listingReadiness(query: Record<string, unknown>, userId: string | null): Promise<ListingReadinessPage> {
  const input = readinessQuery(query)
  let skus = input.skus
  if (input.jobId) {
    const job = await prisma.bulkOperation.findFirst({ where: { id: input.jobId, userId }, select: { status: true, changes: true } })
    if (!job || (job.changes as { kind?: string } | null)?.kind !== 'catalog-transfer-v2') throw new Error('Import job not found')
    if (!['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.status)) throw new Error('Wait for this import to finish saving before checking listing readiness')
    // Stable target keys contain only identity, avoiding heavy attribute snapshots. Saved
    // products include every destination affected by a shared fact, not only imported listings.
    const records = await prisma.importJobRow.findMany({ where: { jobId: input.jobId, status: 'SUCCESS' }, select: { targetId: true }, take: 50_001 })
    if (records.length > 50_000) throw new Error('This import is too large for one selection. Choose a product family instead.')
    skus = [...new Set(records.map(row => {
      const key: unknown = JSON.parse(row.targetId ?? 'null')
      if (!Array.isArray(key) || !['Products', 'Listings'].includes(key[0]) || typeof key[1] !== 'string') throw new Error('The saved import has an invalid product identity')
      return key[1] as string
    }))]
  }
  const products: Prisma.ProductWhereInput = { deletedAt: null,
    ...(input.productIds ? { id: { in: input.productIds } } : input.listingIds ? { channelListings: { some: { id: { in: input.listingIds } } } } : skus ? { sku: { in: skus } }
      : { OR: [{ familyId: input.familyId }, { familyId: null, parent: { familyId: input.familyId } }] }),
  }
  const destination: Prisma.ChannelListingWhereInput = { channel: input.channel ?? { in: ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] },
    ...(input.listingIds ? { id: { in: input.listingIds } } : {}),
    ...(input.accountId ? { channelConnectionId: input.accountId } : {}), ...(input.marketplace ? { marketplace: input.marketplace } : {}) }
  const where = { ...destination, product: products }
  const without = { AND: [products, { channelListings: { none: destination } }] }
  const [productCount, total, unlistedCount, unlisted, listings, markets, selectedListingCount] = await Promise.all([
    prisma.product.count({ where: products }), prisma.channelListing.count({ where }),
    prisma.product.count({ where: without }),
    prisma.product.findMany({ where: without, select: { id: true, sku: true }, orderBy: { sku: 'asc' }, take: 10 }),
    prisma.channelListing.findMany({ where, orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { channelConnectionId: 'asc' }, { id: 'asc' }], skip: (input.page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true,
        listingStatus: true, lastSyncedAt: true, product: { select: { id: true, sku: true, name: true, version: true } },
        channelConnection: { select: { channelType: true, isActive: true, marketplace: true, accountLabel: true, displayName: true } } } }),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, language: true, languages: true } }),
    input.listingIds ? prisma.channelListing.count({ where: { id: { in: input.listingIds }, product: { deletedAt: null } } }) : Promise.resolve(0),
  ])
  const rows: ListingReadinessRow[] = listings.map(listing => {
    const { channelConnection: account, product } = listing
    const issues: ListingReadinessIssue[] = []
    if (!account?.isActive || account.channelType !== listing.channel || account.marketplace && !['GLOBAL', listing.marketplace].includes(account.marketplace)) issues.push({ field: '', label: 'Seller account', kind: 'account', message: 'Assign an active seller account that supports this channel and marketplace.' })
    if (!markets.some(m => m.channel === listing.channel && m.code === listing.marketplace)) issues.push({ field: '', label: 'Marketplace', kind: 'account', message: 'This marketplace is not active for the selected channel.' })
    const params = new URLSearchParams({ scope: listing.channel, market: listing.marketplace, listing: listing.id })
    if (listing.channelConnectionId) params.set('account', listing.channelConnectionId)
    return { id: listing.id, productId: product.id, sku: product.sku, name: product.name, channel: listing.channel,
      marketplace: listing.marketplace, accountId: listing.channelConnectionId, accountName: account?.accountLabel || account?.displayName || 'Unassigned account',
      aliasKey: listing.aliasKey, locale: markets.some(m => m.channel === listing.channel && m.code === listing.marketplace) ? marketLanguages(listing.channel, listing.marketplace, markets)[0] : '', category: null, state: 'unavailable', issues, schema: null,
      savedStatus: listing.listingStatus, lastSyncedAt: listing.lastSyncedAt?.toISOString() ?? null,
      editorHref: `/products/${encodeURIComponent(product.id)}/edit/studio?${params}` }
  })
  const groups = new Map<string, ListingReadinessRow[]>()
  for (const row of rows.filter(r => !r.issues.length)) {
    const key = JSON.stringify([row.channel, row.marketplace, row.accountId, row.aliasKey])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  // At most three destination resolutions concurrently; schema/template work is shared per group.
  const batches = [...groups.values()]
  for (let offset = 0; offset < batches.length; offset += 3) await Promise.all(batches.slice(offset, offset + 3).map(async group => {
    try {
      const first = group[0]
      const resolved = await resolveBatch({ channel: first.channel, marketplace: first.marketplace, channelConnectionId: first.accountId,
        aliasKey: first.aliasKey, productIds: group.map(r => r.productId), includeCatalogue: false })
      const byProduct = new Map(resolved.products.map(p => [p.productId, p]))
      for (const row of group) {
        const product = byProduct.get(row.productId)
        if (!product) { row.issues.push({ field: '', label: 'Product', kind: 'check', message: 'This product could not be resolved. Refresh the check.' }); continue }
        row.locale = resolved.locale; row.category = product.category.channelCategoryId
        row.schema = product.validationContext?.schema ?? null
        row.issues = preparationIssues(product)
        row.state = row.issues.some(i => ['schema', 'check'].includes(i.kind)) ? 'unavailable' : row.issues.some(i => i.kind !== 'warning') ? 'needs-attention' : 'checks-passed'
      }
    } catch {
      // A failed destination cannot hide results from another account or masquerade as ready.
      for (const row of group) row.issues.push({ field: '', label: 'Validation', kind: 'check', message: 'The checks for this destination could not finish. Retry; if this continues, open its channel mapping workspace to check the schema.' })
    }
  }))
  if (listings.length) {
    const latest = await prisma.channelListing.findMany({ where: { id: { in: listings.map(l => l.id) } }, select: { id: true, version: true, product: { select: { version: true } } } })
    const versions = new Map(latest.map(l => [l.id, l]))
    for (const [index, row] of rows.entries()) {
      const current = versions.get(row.id), original = listings[index]
      if (!current || current.version !== original.version || current.product.version !== original.product.version) {
        row.state = 'unavailable'; row.issues.push({ field: '', label: 'Changed during check', kind: 'check', message: 'This product or listing changed while it was being checked. Refresh to check the saved values.' })
      }
    }
  }
  return { computedAt: new Date().toISOString(), page: input.page, pageSize: PAGE_SIZE, total, productCount,
    missingSelectionCount: Math.max(0, input.listingIds ? input.listingIds.length - selectedListingCount : (input.productIds?.length ?? skus?.length ?? productCount) - productCount),
    withoutListing: { total: unlistedCount, sample: unlisted }, rows }
}
