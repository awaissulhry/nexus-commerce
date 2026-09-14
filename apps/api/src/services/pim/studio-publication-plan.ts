import { createHash } from 'node:crypto'
import type { StudioPublishIssue, StudioPublishScope } from '@nexus/shared/studio-publication'
import { assertPushAllowed } from '@nexus/shared/push-lock'
import prisma from '../../db.js'
import { resolveConnection } from '../connection-resolver.service.js'
import { resolveWorkspaceDestination, WorkspaceScopeError } from './workspace-destination.js'
import { readExcludedListingIds } from './variation-excluded.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { marketLanguages } from './market-languages.js'
import { publishContentIssues, resolvePublishContent, requireReviewedContent } from './publish-review-gate.js'

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
  const included = products.filter(p => !listings.some(l => l.productId === p.id && excludedIds.has(l.id)))
    .sort((a, b) => Number(b.id === parent.id) - Number(a.id === parent.id) || a.sku.localeCompare(b.sku))
  const issues: StudioPublishIssue[] = []
  const error = (message: string) => issues.push({ message, severity: 'error' })
  if (!included.length) error('Every product is excluded from this destination. Include a product in Information first.')
  if (!included.some(p => p.id === parent.id)) error('The parent listing is excluded. Include it before publishing this family.')
  if ((parent.isParent || parent.isMaster) && included.length < 2) error('This family has no included variants to publish.')
  if (included.length > 200) error('This family exceeds the publication limit of 200 products.')
  if (['disconnected', 'revoked', 'needs_reauth'].includes(account.authStatus)) error('Reconnect this account before publishing.')
  for (const listing of listings.filter(l => !excludedIds.has(l.id))) {
    const refusal = assertPushAllowed(listing)
    if (refusal) error(refusal.sentence)
  }
  const languages = await marketLanguages(scope.channel, scope.marketplace)
  const resolved = []
  for (const locale of languages) {
    const result = await resolveBatch({ channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId,
      aliasKey: destination.aliasKey ?? '', productIds: included.map(p => p.id), locale, includeCatalogue: true })
    for (const row of result.products) for (const [field, cell] of Object.entries(row.cells)) {
      for (const message of cell.errors) issues.push({ productId: row.productId, sku: row.sku, field, severity: 'error', message: `${cell.label ?? field}: ${message}` })
    }
    if (result.missingProductIds.length) error('Some products could not be read. Refresh the product before publishing.')
    resolved.push(result)
  }
  if (!languages.length) error('Configure a content language for this destination before publishing.')
  for (const product of included) {
    const listing = listings.find(l => l.productId === product.id)
    const content = await resolvePublishContent({ product: product as any, parent: product.id === parent.id ? null : parent as any,
      listing, channel: scope.channel, marketplace: scope.marketplace })
    for (const issue of publishContentIssues(content)) {
      if (issue.severity === 'ERROR' && !requireReviewedContent()) continue
      issues.push({ productId: product.id, sku: product.sku, field: issue.field, message: issue.message, severity: issue.severity === 'ERROR' ? 'error' : 'warning' })
    }
  }
  const alias = destination.aliasKey ? await prisma.productListingAlias.findUnique({ where: { id: destination.aliasKey }, select: { label: true } }) : null
  const revision = publicationDigest({ scope, products, listings, excluded: [...excludedIds].sort(),
    resolved: resolved.map(r => ({ products: r.products, catalogue: r.catalogue })) })
  return { scope, destination, account, parent, products: included, listings, resolved, languages, issues, revision,
    excluded: products.length - included.length, aliasLabel: alias?.label ?? 'Primary listing' }
}
export type PublicationFacts = Awaited<ReturnType<typeof readPublicationFacts>>
