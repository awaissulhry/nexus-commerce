import type { Prisma } from '@prisma/client'
import type { ListingReadinessPage, ListingReadinessRow } from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { normalizeLanguage } from './content-language.js'
import { SCOPE_STATES } from './readiness-model.js'

const PAGE_SIZE = 25
const identifier = (value: unknown, name: string) => {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Invalid ${name}`)
  return value.trim()
}
export function readinessQuery(query: Record<string, unknown>) {
  const list = (value: unknown, name: string) => {
    if (value === undefined || value === '') return undefined
    if (typeof value !== 'string') throw new Error(`Invalid ${name}`)
    let parsed: unknown
    try { parsed = name === 'SKUs' ? value.startsWith('[') ? JSON.parse(value) : [value] : value.split(',') } catch { throw new Error(`Invalid ${name}`) }
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 200 || parsed.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw new Error(`Choose 1–200 ${name}`)
    return [...new Set((parsed as string[]).map(v => v.trim()))]
  }
  const familyId = identifier(query.familyId, 'family'), jobId = identifier(query.job, 'import job')
  const productIds = list(query.productIds, 'product IDs'), skus = list(query.skus, 'SKUs'), listingIds = list(query.listingIds, 'listing IDs')
  if ([familyId, jobId, productIds, skus, listingIds].filter(Boolean).length > 1) throw new Error('Choose one product family, product selection, listing selection, SKU list or completed import')
  const accountId = identifier(query.accountId, 'account'), channel = identifier(query.channel, 'channel')?.toUpperCase()
  const marketplace = identifier(query.marketplace ?? query.market, 'marketplace')?.toUpperCase()
  if (channel && !/^[A-Z][A-Z0-9_]{1,49}$/.test(channel)) throw new Error('Select a supported channel')
  if (marketplace && marketplace !== 'GLOBAL' && !/^[A-Z]{2}$/.test(marketplace)) throw new Error('Select a valid marketplace')
  const language = query.language ? normalizeLanguage(String(query.language)) : undefined
  const state = identifier(query.state, 'state')
  if (state && !(SCOPE_STATES as readonly string[]).includes(state)) throw new Error('Select a readiness state')
  if (query.page !== undefined && (typeof query.page !== 'string' || !/^\d+$/.test(query.page))) throw new Error('Use a positive page number')
  const page = Number(query.page ?? 1)
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new Error('Use a positive page number')
  return { familyId, jobId, productIds, skus, listingIds, accountId, channel, marketplace, language, state, page }
}

/** Shared by the paged reader and Translate: filtering happens before count/page. */
export async function listingReadinessWhere(query: Record<string, unknown>, userId: string | null): Promise<Prisma.ReadinessIndexWhereInput> {
  const input = readinessQuery(query)
  let skus = input.skus
  if (input.jobId) {
    const job = await prisma.bulkOperation.findFirst({ where: { id: input.jobId, userId }, select: { status: true, changes: true } })
    if (!job || (job.changes as { kind?: string } | null)?.kind !== 'catalog-transfer-v2') throw new Error('Import job not found')
    if (!['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.status)) throw new Error('Wait for this import to finish saving before checking listing readiness')
    const records = await prisma.importJobRow.findMany({ where: { jobId: input.jobId, status: 'SUCCESS' }, select: { targetId: true } })
    skus = [...new Set(records.map(row => {
      const key: unknown = JSON.parse(row.targetId ?? 'null')
      if (!Array.isArray(key) || !['Products', 'Listings'].includes(key[0]) || typeof key[1] !== 'string') throw new Error('The saved import has an invalid product identity')
      return key[1] as string
    }))]
  }
  const product: Prisma.ProductWhereInput = { deletedAt: null,
    ...(input.productIds ? { id: { in: input.productIds } } : skus ? { sku: { in: skus } } : input.familyId ? { OR: [{ familyId: input.familyId }, { familyId: null, parent: { familyId: input.familyId } }] } : {}) }
  const where: Prisma.ReadinessIndexWhereInput = { product,
    ...(input.channel ? { channel: input.channel === 'SHARED' ? null : input.channel } : {}), ...(input.marketplace ? { market: input.marketplace } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.language ? { language: input.language } : {}), ...(input.state ? { state: input.state } : {}) }
  if (input.listingIds) {
    const listings = await prisma.channelListing.findMany({ where: { id: { in: input.listingIds }, product: { deletedAt: null } }, select: { productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true } })
    where.OR = listings.map(listing => ({ productId: listing.productId, channel: listing.channel, market: listing.marketplace, accountId: listing.channelConnectionId, aliasId: listing.aliasKey || null }))
  }
  return where
}

/** Only materialized index reads. No live resolveBatch computation or default-language collapse. */
export async function listingReadiness(query: Record<string, unknown>, userId: string | null): Promise<ListingReadinessPage> {
  const input = readinessQuery(query), where = await listingReadinessWhere(query, userId)
  const [total, records, productCount] = await Promise.all([
    prisma.readinessIndex.count({ where }),
    prisma.readinessIndex.findMany({ where, orderBy: [{ channel: 'asc' }, { market: 'asc' }, { language: 'asc' }, { productId: 'asc' }, { id: 'asc' }], skip: (input.page - 1) * PAGE_SIZE, take: PAGE_SIZE,
      include: { product: { select: { id: true, sku: true, name: true, familyId: true } } } }),
    prisma.readinessIndex.findMany({ where, select: { productId: true }, distinct: ['productId'] }).then(rows => rows.length),
  ])
  const rows: ListingReadinessRow[] = records.map(record => {
    const params = new URLSearchParams({ scope: record.channel ?? 'master', locale: record.language, tab: 'errors' })
    if (record.market) params.set('market', record.market)
    if (record.accountId) params.set('account', record.accountId)
    if (record.aliasId) params.set('alias', record.aliasId)
    const missing = Array.isArray(record.missing) ? record.missing as Array<{ field: string; label: string; reason: string }> : []
    return { id: record.id, productId: record.productId, sku: record.product.sku, name: record.product.name,
      channel: record.channel ?? 'SHARED', marketplace: record.market ?? '', accountId: record.accountId, accountName: record.label,
      aliasKey: record.aliasId ?? '', locale: record.language, state: record.state as ListingReadinessRow['state'], pct: record.pct,
      computedAt: record.computedAt.toISOString(), familyId: record.product.familyId,
      issues: missing.map(issue => ({ field: issue.field, label: issue.label, kind: 'missing', message: issue.reason })),
      editorHref: `/products/${encodeURIComponent(record.productId)}/edit/studio?${params}` }
  })
  return { computedAt: rows.reduce<string | null>((date, row) => !date || row.computedAt! < date ? row.computedAt! : date, null), page: input.page, pageSize: PAGE_SIZE, total, productCount,
    rows }
}
