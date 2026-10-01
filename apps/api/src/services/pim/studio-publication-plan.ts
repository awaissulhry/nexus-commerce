import { createHash } from 'node:crypto'
import type { StudioPublishIssue, StudioPublishScope } from '@nexus/shared/studio-publication'
import { assertPublishAllowed } from '@nexus/shared/push-lock'
import prisma from '../../db.js'
import { resolveConnection } from '../connection-resolver.service.js'
import { resolveWorkspaceDestination, WorkspaceScopeError } from './workspace-destination.js'
import { readExcludedListingIds } from './variation-excluded.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { marketLanguages } from './market-languages.js'
import { publishContentIssues, resolvePublishContent, requireReviewedContent } from './publish-review-gate.js'
import { foreignOwnTextIssues } from './foreign-own-text.js'
import { closedMarketSet } from '../amazon-market-offer.service.js'
import { cellFindings, publishVerdict } from './value-verdict.js'
import { familyPublicationOrder } from './family-publication-order.js'
import { ebayListingLevelValues, isEbayListingLevel, loadEbayListingAxes, type ListingLevelField } from './ebay-listing-level.js'
import { aspectCanonicalName } from '../ebay-theme-axes.js'
import { EBAY_ASPECT_VALUE_MAX, ebayAspectValues } from '../ebay-aspect-values.js'

// JSONB can return object keys in a different order from the preview request.
// Preserve semantic array order and JSON/toJSON values while hashing objects canonically.
export const publicationDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex')
export const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}

export function publicationScope(body: unknown): StudioPublishScope {
  const input = object(body)
  for (const key of ['channel', 'marketplace', 'accountId']) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200)
    throw new WorkspaceScopeError(`Choose the publication ${key}.`, 400)
  if (input.listingId !== undefined && (typeof input.listingId !== 'string' || !input.listingId.trim() || input.listingId.length > 200))
    throw new WorkspaceScopeError('Choose a valid listing.', 400)
  return { channel: input.channel.toUpperCase(), marketplace: input.marketplace.toUpperCase(), accountId: input.accountId, ...(input.listingId ? { listingId: input.listingId } : {}) }
}

/** Load the same resolver and account/alias stores as Information. No writes or provider sends. */
export async function readPublicationFacts(productId: string, scope: StudioPublishScope) {
  const destination = await resolveWorkspaceDestination({ productId, ...scope })
  const account = await resolveConnection({ accountId: destination.accountId })
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: destination.familyId }, { parentId: destination.familyId }] },
    include: { translations: true, images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } }, orderBy: { sku: 'asc' } })
  const parent = products.find(p => p.id === destination.familyId)
  if (!parent) throw new WorkspaceScopeError('The product family is unavailable.', 404)
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: products.map(p => p.id) }, channel: scope.channel,
    marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey: destination.aliasKey ?? '' }, include: { translations: true, offers: true } })
  const excludedIds = await readExcludedListingIds(listings.map(l => l.id))
  // VTR step 0 — the one "included" rule Information and the dock use (`studio-sheet.service.ts`, `family-projection.service.ts`):
  // a VARIANT is in this listing only with its own row here that is not excluded. A variant with no row is not sent.
  const selected = products.filter(p => {
    const rows = listings.filter(l => l.productId === p.id)
    return (p.id === parent.id || rows.length > 0) && !rows.some(l => excludedIds.has(l.id))
  })
    .sort(familyPublicationOrder(p => p.id === parent.id))
  const closed = scope.channel === 'AMAZON' ? await closedMarketSet(selected.map(p => p.id)) : new Set<string>()
  const skipped = selected.filter(p => closed.has(`${p.id}|${scope.marketplace}`))
    .map(p => ({ productId: p.id, sku: p.sku, reason: 'Offer closed — not sent' }))
  const included = selected.filter(p => !closed.has(`${p.id}|${scope.marketplace}`))
  const issues: StudioPublishIssue[] = []
  const error = (message: string) => issues.push({ message, severity: 'error' })
  if (!selected.length) error('Every product is excluded from this destination. Include a product in Information first.')
  if (!selected.some(p => p.id === parent.id)) error('The parent listing is excluded. Include it before publishing this family.')
  if ((parent.isParent || parent.isMaster) && selected.length < 2) error('This family has no included variants to publish.')
  for (const skip of skipped) issues.push({ ...skip, message: skip.reason, severity: 'warning' })
  if (included.length > 200) error('This family exceeds the publication limit of 200 products.')
  if (['disconnected', 'revoked', 'needs_reauth'].includes(account.authStatus)) error('Reconnect this account before publishing.')
  // Publish's lock: a paused still-draft may be sent (Publish is what makes it live); any other paused listing is refused.
  for (const listing of listings.filter(l => included.some(p => p.id === l.productId))) {
    const refusal = assertPublishAllowed(listing)
    if (refusal) error(refusal.sentence)
  }
  const languages = await marketLanguages(scope.channel, scope.marketplace)
  // P1 (report 5 I-1/I-2/I-3) — eBay takes one value per listing for an item specific that is not an axis: its problems
  // are the supplying row's (the parent, else the first variation that holds one), named once; the axes are the ones
  // the publisher sends (the listing's variation projection).
  const ebayAxes = scope.channel === 'EBAY' && included.length > 1 && included.some(p => p.id === parent.id)
    ? await loadEbayListingAxes({ parentId: parent.id, market: scope.marketplace, accountId: scope.accountId, aliasKey: destination.aliasKey ?? '', familyAxes: parent.variationAxes })
    : null
  const familyRows = included.map(p => ({ productId: p.id, sku: p.sku, isParent: p.id === parent.id }))
  const resolved = []
  for (const locale of languages) {
    const result = await resolveBatch({ channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId,
      aliasKey: destination.aliasKey ?? '', productIds: included.map(p => p.id), locale, includeCatalogue: true })
    const levels = ebayAxes ? ebayListingLevelValues({ rows: familyRows, axes: ebayAxes, fields: ebayFields(result.catalogue?.fields),
      valueOf: (row, field) => result.products.find(p => p.productId === row.productId)?.cells[field.key]?.value }) : []
    const listingLevelKeys = new Set(ebayAxes ? ebayFields(result.catalogue?.fields).filter(field => isEbayListingLevel(field, ebayAxes)).map(field => field.key) : [])
    const reporterOf = (field: string) => levels.find(level => level.field.key === field)?.supplier.productId ?? parent.id
    for (const row of result.products) for (const [field, cell] of Object.entries(row.cells)) {
      const existing = listings.some(listing => listing.productId === row.productId && listing.externalListingId)
      if (existing && ['AMAZON', 'EBAY'].includes(scope.channel) && ['Pricing', 'Inventory'].includes(cell.sourceOwner?.label ?? '')) continue
      // A variation's own value of a listing-level field is not sent: only the row eBay's value comes from is judged.
      if (listingLevelKeys.has(field) && row.productId !== reporterOf(field)) continue
      // P1 — block only what the channel itself would reject (`value-verdict.ts`); every other problem warns.
      for (const found of cellFindings(cell)) issues.push({ productId: row.productId, sku: row.sku, field,
        severity: publishVerdict(scope.channel, found) === 'block' ? 'error' : 'warning', message: `${cell.label ?? field}: ${found.message}` })
    }
    if (result.missingProductIds.length) error('Some products could not be read. Refresh the product before publishing.')
    resolved.push(result)
  }
  if (!languages.length) error('Configure a content language for this destination before publishing.')
  if (ebayAxes && resolved[0]) issues.push(...ebayStoredSpecificIssues({ parentId: parent.id, rows: familyRows, listings, fields: ebayFields(resolved[0].catalogue?.fields), axes: ebayAxes }))
  for (const product of included) {
    const listing = listings.find(l => l.productId === product.id)
    const content = await resolvePublishContent({ product: product as any, parent: product.id === parent.id ? null : parent as any,
      listing, channel: scope.channel, marketplace: scope.marketplace })
    for (const issue of publishContentIssues(content)) {
      if (issue.severity === 'ERROR' && !requireReviewedContent()) continue
      issues.push({ productId: product.id, sku: product.sku, field: issue.field, message: issue.message, severity: issue.severity === 'ERROR' ? 'error' : 'warning' })
    }
    // A-32 (R-30) — a pinned own text that is the primary-language text, on a market that speaks another language.
    for (const issue of foreignOwnTextIssues({ channel: scope.channel, marketplace: scope.marketplace, marketLanguages: languages,
      product: product as any, parent: product.id === parent.id ? null : parent as any, listing: listing as any })) {
      issues.push({ productId: product.id, sku: product.sku, field: issue.field, message: issue.message, severity: 'warning' })
    }
  }
  const alias = destination.aliasKey ? await prisma.productListingAlias.findUnique({ where: { id: destination.aliasKey }, select: { label: true } }) : null
  const revision = publicationDigest({ scope, products, listings, excluded: [...excludedIds].sort(), skipped,
    resolved: resolved.map(r => ({ products: r.products, catalogue: r.catalogue })) })
  return { scope, destination, account, parent, products: included, listings, resolved, languages, issues, revision, skipped,
    excluded: products.length - selected.length, aliasLabel: alias?.label ?? 'Primary listing' }
}
export type PublicationFacts = Awaited<ReturnType<typeof readPublicationFacts>>

/** The eBay catalogue fields as listing-level candidates (key, label, store, the names they go by). */
function ebayFields(fields: ReadonlyArray<{ fieldKey: string; sheetKey?: string; label: string; channelStore?: unknown }> | undefined): ListingLevelField[] {
  return (fields ?? []).map(f => ({ key: f.fieldKey, label: f.label, store: f.channelStore as ListingLevelField['store'], names: [f.fieldKey, f.sheetKey, f.label] }))
}

/**
 * P1 (report 3 I-3.4/I-3.9) — the stored item specifics no column serves still ship: `buildEbayListingInput` starts from
 * the stored bag. The review blocks a value over eBay's 65 characters on the row eBay's one value comes from. (Column
 * values are judged per cell by the verdict.) A variation's own different value is not named: eBay takes one value per
 * listing, the sheet shows that value on every row, and the note blocked nothing (Owner, 2026-10-01: noise).
 */
export function ebayStoredSpecificIssues(input: {
  parentId: string
  rows: Array<{ productId: string; sku: string; isParent: boolean }>
  listings: Array<{ productId: string; platformAttributes?: unknown }>
  fields: ListingLevelField[]
  axes: Set<string>
}): StudioPublishIssue[] {
  const issues: StudioPublishIssue[] = []
  const covered = new Set(input.fields.flatMap(f => f.store?.kind === 'platformAttributes' && f.store.path?.[0] === 'itemSpecifics' && f.store.path[1] ? [aspectCanonicalName(f.store.path[1])] : []))
  const bagOf = (productId: string) => {
    const bag = input.listings.find(l => l.productId === productId)?.platformAttributes as { itemSpecifics?: Record<string, unknown> } | null | undefined
    return bag?.itemSpecifics && typeof bag.itemSpecifics === 'object' ? bag.itemSpecifics : {}
  }
  const names = new Map<string, string>()
  for (const row of input.rows) for (const name of Object.keys(bagOf(row.productId))) {
    const key = aspectCanonicalName(name)
    if (key && key !== 'condizione' && !covered.has(key) && !names.has(key)) names.set(key, name)
  }
  const fields: ListingLevelField[] = [...names].map(([key, name]) => ({ key, label: name, store: { kind: 'platformAttributes', path: ['itemSpecifics', name] } }))
  const levels = ebayListingLevelValues({ rows: input.rows, fields, axes: input.axes,
    valueOf: (row, field) => Object.entries(bagOf(row.productId)).find(([stored]) => aspectCanonicalName(stored) === field.key)?.[1] })
  for (const level of levels) {
    const field = `itemSpecifics.${level.field.label}`
    const long = ebayAspectValues(level.value).find(value => value.length > EBAY_ASPECT_VALUE_MAX)
    if (long) issues.push({ productId: level.supplier.productId, sku: level.supplier.sku, field, severity: 'error',
      message: `${level.field.label}: eBay takes at most ${EBAY_ASPECT_VALUE_MAX} characters per value; ${JSON.stringify(long.slice(0, 40) + '…')} has ${long.length}.` })
  }
  return issues
}
