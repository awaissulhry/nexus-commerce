import { createHash } from 'node:crypto'
import type { StudioPublishIssue, StudioPublishScope } from '@nexus/shared/studio-publication'
import { assertPublishAllowed, assertPushAllowed, type PushLockListing } from '@nexus/shared/push-lock'
import { ENDED_FIRST } from '@nexus/shared/publish-actions'
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
import { ebayListingLevelValues, isEbayItemLevel, isEbayListingLevel, loadEbayListingAxes, type ListingLevelField } from './ebay-listing-level.js'
import { newListingChoices } from '../listings/new-listing-choices.js'
import { readListingDeletions } from '../listings/listing-deletions.js'
import { nativeListingValue } from '../shopify/native-listing-value.js'
import { aspectCanonicalName } from '../ebay-theme-axes.js'
import { EBAY_ASPECT_VALUE_MAX, ebayAspectValues } from '../ebay-aspect-values.js'

// JSONB can return object keys in a different order from the preview request.
// Preserve semantic array order and JSON/toJSON values while hashing objects canonically.
export const publicationDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex')
/** E1 — what the review says for a live eBay listing whose Condition is empty in Nexus. */
export const EBAY_CONDITION_KEPT = 'Condition is empty in Nexus; eBay keeps the listing\'s current condition.'
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
  // Audit P4 (2026-10-01) — an eBay family never started here (its main listing, no variant has a row at this destination
  // and nothing of it is live) publishes all its variants: "no included variants" was a dead end, and the send starts their
  // draft rows itself (`ensureDraftListings`, `family: false`). The review lists every product it sends and says why.
  const unstarted = scope.channel === 'EBAY' && !destination.aliasKey && products.length > 1
    && !listings.some(l => l.externalListingId) && !listings.some(l => l.productId !== parent.id)
  // Delete and relist (simplify, Owner 2026-10-04) — the rows Nexus deleted and that are not listed again: rows not on the
  // channel, default Not listed (`readListingDeletions`; the sheet reads the same). Product id → its delete.
  const deletionsByListing = await readListingDeletions(listings.map(listing => ({ ...listing, channel: scope.channel, marketplace: scope.marketplace })))
  const deletions = new Map([...deletionsByListing].map(([listingId, deletion]) => [listings.find(l => l.id === listingId)!.productId, deletion]))
  // New listings (Owner 2026-10-04) — what Publish does with each row not on the channel (deleted ones included): its own
  // Status choice, the main row's, else today's default — Not listed for a deleted row (`newListingChoices`, the sheet
  // reads the same). A variation set Not listed is left out, as an excluded one; a main row set Not listed holds the
  // family (studio-publication.service.ts `newRowsOf`).
  const createChoices = newListingChoices({ channel: scope.channel, aliasKey: destination.aliasKey ?? '', familyId: parent.id,
    products: products.map(p => ({ id: p.id, parentId: p.parentId })), listings, excludedListingIds: excludedIds, deletions: deletionsByListing,
    shopifyActive: scope.channel === 'SHOPIFY' && String(nativeListingValue(listings.find(l => l.productId === parent.id) ?? null, 'status', 'DRAFT') ?? '').toUpperCase() === 'ACTIVE' })
  const notListedVariation = (productId: string) => productId !== parent.id && createChoices.get(productId)?.own === 'not_listed'
  // VTR step 0 — the one "included" rule Information and the dock use (`studio-sheet.service.ts`, `family-projection.service.ts`):
  // a VARIANT is in this listing only with its own row here that is not excluded. A variant with no row is not sent.
  const selected = products.filter(p => {
    const rows = listings.filter(l => l.productId === p.id)
    return (p.id === parent.id || rows.length > 0 || unstarted) && !rows.some(l => excludedIds.has(l.id)) && !notListedVariation(p.id)
  })
    .sort(familyPublicationOrder(p => p.id === parent.id))
  const notListedCount = products.filter(p => notListedVariation(p.id)).length
  // D10 (build shape v2, Owner 2026-10-04) — row rules, not one lock for the family. A row ON the channel receives its
  // content (Partial and Full update) while it is paused, its offer closed or its stock sync held: content never carries
  // stock or the offer. A row the channel ENDED is skipped (relist it first); a discontinued or released identity is
  // skipped with the lock's own sentence. eBay and Shopify change a whole listing, so one skipped row skips the family.
  // A row NOT on the channel yet is created whole, with its stock and offer: the create keeps the old locks (a closed
  // Amazon offer is skipped; any other lock refuses the family).
  const onChannel = (productId: string) => !!listings.find(l => l.productId === productId)?.externalListingId
  const closed = scope.channel === 'AMAZON' ? await closedMarketSet(selected.map(p => p.id)) : new Set<string>()
  const rowSkips = new Map<string, string>()
  for (const p of selected) {
    const rule = existingRowRule(listings.find(l => l.productId === p.id))
    if (rule) rowSkips.set(p.id, rule)
    else if (!onChannel(p.id) && closed.has(`${p.id}|${scope.marketplace}`)) rowSkips.set(p.id, 'Offer closed — not sent')
  }
  const wholeListing = ['EBAY', 'SHOPIFY'].includes(scope.channel) ? [...rowSkips.values()][0] : undefined
  const skipped = selected.filter(p => wholeListing || rowSkips.has(p.id))
    .map(p => ({ productId: p.id, sku: p.sku, reason: rowSkips.get(p.id) ?? wholeListing! }))
  const included = selected.filter(p => !skipped.some(skip => skip.productId === p.id))
  const issues: StudioPublishIssue[] = []
  const error = (message: string) => issues.push({ message, severity: 'error' })
  if (!selected.length) error('Every product is excluded from this destination. Include a product in Information first.')
  if (!selected.some(p => p.id === parent.id)) error('The parent listing is excluded. Include it before publishing this family.')
  if ((parent.isParent || parent.isMaster) && selected.length < 2) error(notListedCount
    ? 'Every variation of this family is Not listed here, so there is nothing to create. Set a variation Active or Inactive.'
    : 'This family has no included variants to publish.')
  for (const skip of skipped) issues.push({ ...skip, message: skip.reason, severity: 'warning' })
  if (selected.length && !included.length) error(`Nothing of this family can be sent here: ${skipped[0].reason}`)
  if (unstarted) issues.push({ severity: 'warning', message: `No variant had an eBay row here yet, so all ${selected.length - 1} variants are included. Publishing starts their eBay rows.` })
  if (included.length > 200) error('This family exceeds the publication limit of 200 products.')
  // Audit P12 — say WHICH account and where (the studio footer says the same).
  if (['disconnected', 'revoked', 'needs_reauth'].includes(account.authStatus)) error(`Reconnect ${account.displayName?.trim() || 'this account'} in Settings → Channels before publishing.`)
  // Publish's lock for a CREATE: a paused still-draft may be sent (Publish is what makes it live); any other lock refuses.
  for (const listing of listings.filter(l => !l.externalListingId && included.some(p => p.id === l.productId))) {
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
    // Follow-up 2026-10-01 — Condition, policies, location, package… go to eBay once, from the main row: only it is judged.
    const itemLevelKeys = new Set(ebayAxes ? ebayFields(result.catalogue?.fields).filter(field => isEbayItemLevel(field.store)).map(field => field.key) : [])
    for (const row of result.products) for (const [field, cell] of Object.entries(row.cells)) {
      const existing = listings.some(listing => listing.productId === row.productId && listing.externalListingId)
      if (existing && ['AMAZON', 'EBAY'].includes(scope.channel) && ['Pricing', 'Inventory'].includes(cell.sourceOwner?.label ?? '')) continue
      // A variation's own value of a listing-level field is not sent: only the row eBay's value comes from is judged.
      if (listingLevelKeys.has(field) && row.productId !== reporterOf(field)) continue
      if (itemLevelKeys.has(field) && row.productId !== parent.id) continue
      // E1 (Owner decision 7, 2026-10-04) — a live eBay listing whose Condition is empty in Nexus sends none, so eBay keeps
      // its own: a warning, not a block. A new listing still needs one (its "required" blocks below).
      if (existing && scope.channel === 'EBAY' && field === 'conditionId' && (cell.value == null || (typeof cell.value === 'string' && !cell.value.trim()))) {
        issues.push({ productId: row.productId, sku: row.sku, field, severity: 'warning', message: EBAY_CONDITION_KEPT })
        continue
      }
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
    // An eBay variation listing sends ONE title and description, the main row's: a variation's own text is not judged.
    const variationText = !!ebayAxes && product.id !== parent.id
    for (const issue of publishContentIssues(content)) {
      if (issue.severity === 'ERROR' && !requireReviewedContent()) continue
      if (variationText && ['title', 'description'].includes(issue.field ?? '')) continue
      issues.push({ productId: product.id, sku: product.sku, field: issue.field, message: issue.message, severity: issue.severity === 'ERROR' ? 'error' : 'warning' })
    }
    // A-32 (R-30) — a pinned own text that is the primary-language text, on a market that speaks another language.
    for (const issue of foreignOwnTextIssues({ channel: scope.channel, marketplace: scope.marketplace, marketLanguages: languages,
      product: product as any, parent: product.id === parent.id ? null : parent as any, listing: listing as any })) {
      if (variationText && ['title', 'description'].includes(issue.field)) continue
      issues.push({ productId: product.id, sku: product.sku, field: issue.field, message: issue.message, severity: 'warning' })
    }
  }
  const alias = destination.aliasKey ? await prisma.productListingAlias.findUnique({ where: { id: destination.aliasKey }, select: { label: true } }) : null
  const revision = publicationDigest({ scope, products, listings, excluded: [...excludedIds].sort(), skipped,
    resolved: resolved.map(r => ({ products: r.products, catalogue: r.catalogue })) })
  return { scope, destination, account, parent, products: included, listings, resolved, languages, issues, revision, skipped,
    excluded: products.length - selected.length, aliasLabel: alias?.label ?? 'Primary listing', createChoices, deletions }
}
export type PublicationFacts = Awaited<ReturnType<typeof readPublicationFacts>>

/**
 * D10 — the one rule for a row already on the channel: null = its content is sent (paused, offer closed and stock-sync
 * held included); else the reason it is skipped. Ended (the listing's status, `endedAt`, or the ENDED intent) says
 * "relist it first"; a discontinued or released identity keeps the push lock's sentence. A row not on the channel is
 * not judged here (its create keeps the publish lock).
 */
export function existingRowRule(listing: (PushLockListing & { externalListingId?: string | null }) | null | undefined): string | null {
  if (!listing?.externalListingId) return null
  if (listing.endedAt || String(listing.listingStatus ?? '').trim().toUpperCase() === 'ENDED' || listing.presenceIntent === 'ENDED') return ENDED_FIRST
  if (listing.presenceIntent === 'DISCONTINUED' || listing.presenceIntent === 'RELEASED') return assertPushAllowed({ presenceIntent: listing.presenceIntent })?.sentence ?? null
  return null
}

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
