import { createHash } from 'node:crypto'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import { publicationChangeId } from './studio-publication-changes.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const PAGE_SIZE = 250

/** Fold only recorded intentional fields. An exact raw request is not an interpreted field baseline. */
export async function readPublicationBaseline(facts: PublicationFacts, identities: Array<{ productId: string; sku: string }>): Promise<{ values: Map<string, StudioPublishValue>; revision: string }> {
  const included = new Set(facts.products.map(product => product.id))
  const identity = new Map(identities.map(item => [item.productId, item.sku]))
  if (identity.size !== identities.length || new Set(identities.map(item => item.sku)).size !== identities.length) throw new Error('Duplicate publication product or provider SKU identity.')
  if (identities.some(item => !included.has(item.productId) || !item.sku.trim()) || [...included].some(productId => !identity.has(productId))) throw new Error('Every included publication product needs its exact provider identity.')
  const { scope } = facts
  const aliasKey = facts.destination.aliasKey ?? ''
  const listings = facts.listings.filter(listing => included.has(listing.productId) && listing.externalListingId
    && listing.channel === scope.channel && listing.marketplace === scope.marketplace && listing.channelConnectionId === scope.accountId && listing.aliasKey === aliasKey)
  if (new Set(listings.map(listing => listing.productId)).size !== listings.length) throw new Error('The publication listing identity is ambiguous.')
  const byListing = new Map(listings.map(listing => [listing.id, { productId: listing.productId, sku: identity.get(listing.productId)! }]))
  const values = new Map<string, StudioPublishValue>()
  const fieldsByProduct = new Map<string, Set<string>>()
  const revision = createHash('sha256').update(canonical({ scope, aliasKey,
    identities: [...identity].sort(([a], [b]) => a.localeCompare(b)), listings: [...byListing].sort(([a], [b]) => a.localeCompare(b)) }))

  if (listings.length) await prisma.$transaction(async tx => {
    let cursor: string | undefined
    for (;;) {
      const rows = await tx.channelListingSnapshot.findMany({
        where: { channelListingId: { in: listings.map(listing => listing.id) }, channel: scope.channel, marketplace: scope.marketplace, aliasKey,
          reason: 'publish', outcome: 'ACCEPTED', acceptedAt: { not: null } },
        select: { id: true, channelListingId: true, publishEventId: true, acceptedAt: true, createdAt: true, payload: true },
        orderBy: [{ acceptedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      for (const row of rows) {
        revision.update('\n').update(canonical(row))
        const target = byListing.get(row.channelListingId)!
        const journal = object(row.payload)
        if (journal.schemaVersion !== 1 || journal.kind !== 'studio-publication' || !Array.isArray(journal.requests) || !journal.requests.length
          || typeof journal.productId !== 'string' || typeof journal.channelConnectionId !== 'string' || typeof journal.sku !== 'string') throw new Error('An accepted publication journal has invalid identity or request metadata.')
        if (journal.productId !== target.productId || journal.channelConnectionId !== scope.accountId || journal.sku !== target.sku) continue
        const known = fieldsByProduct.get(target.productId) ?? new Set<string>()
        fieldsByProduct.set(target.productId, known)
        for (const request of journal.requests) {
          const intent = object(request)
          if (intent.intentVersion === undefined) {
            // A legacy accepted request may have overwritten any root, including a previously cleared one.
            // Keep those keys visible as unknown until a later intentional write re-establishes each field.
            for (const field of known) values.set(publicationChangeId(target.productId, field), { state: 'unknown', reason: 'An accepted request has no versioned field intent; its effects are unknown.' })
            continue
          }
          if (intent.intentVersion !== 1 || !Array.isArray(intent.writes)) throw new Error('An accepted publication request has unsupported or malformed field intent.')
          for (const write of intent.writes) {
            const entry = object(write), stored = object(entry.value)
            if (typeof entry.field !== 'string' || !entry.field.trim()) throw new Error('An accepted publication intent has an invalid field name.')
            let value: StudioPublishValue
            if (stored.state === 'absent' && !Object.prototype.hasOwnProperty.call(stored, 'value')) value = { state: 'absent' }
            else if (stored.state === 'value' && Object.prototype.hasOwnProperty.call(stored, 'value')) value = { state: 'value', value: stored.value }
            else throw new Error(`The accepted intent for ${entry.field} has an invalid value.`)
            known.add(entry.field)
            values.set(publicationChangeId(target.productId, entry.field), value)
          }
        }
      }
      if (rows.length < PAGE_SIZE) break
      cursor = rows[rows.length - 1].id
    }
  }, { isolationLevel: 'RepeatableRead' })
  return { values, revision: revision.digest('hex') }
}
