import type { StudioPublishOverwrite } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { DRIFT_FIELD_CAP } from '../channel-drift.service.js'
import type { PublicationFacts } from './studio-publication-plan.js'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const timestamp = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null

/** Historical content evidence for the exact publication coordinate. This does not read a channel or compare today's draft. */
export async function readPublicationOverwrite(facts: PublicationFacts): Promise<StudioPublishOverwrite> {
  const source = facts.scope.channel === 'AMAZON' ? 'amazon-content' : facts.scope.channel === 'EBAY' ? 'ebay-content' : null
  const included = new Set(facts.products.map(product => product.id))
  // readPublicationFacts already scoped these listings to the selected channel, account, market and alias.
  const existing = new Map(facts.listings.filter(listing => included.has(listing.productId) && listing.externalListingId)
    .map(listing => [listing.productId, listing]))
  const rows = source && existing.size ? await prisma.channelDrift.findMany({
    where: { channelListingId: { in: [...existing.values()].map(listing => listing.id) } },
    select: { channelListingId: true, driftedFields: true, checkedBySource: true },
  }) : []
  const byListing = new Map(rows.map(row => [row.channelListingId, row]))

  return {
    requiresConfirmation: existing.size > 0,
    products: facts.products.map(product => {
      const base = { productId: product.id, sku: product.sku, checkedAt: null, differing: 0, notCompared: null, omittedDifferences: 0, fields: [] }
      const listing = existing.get(product.id)
      if (!listing) return { ...base, status: 'new' as const }
      if (!source) return { ...base, status: 'not_read' as const, reason: 'No saved content comparison is available for this channel.' }

      const row = byListing.get(listing.id)
      const clock = record(record(row?.checkedBySource)[source])
      const at = timestamp(clock.at)
      const status = at && (clock.outcome === 'compared' || clock.outcome === 'not_compared') ? clock.outcome : 'not_read'
      const entries = (Array.isArray(row?.driftedFields) ? row.driftedFields : []).map(record).filter(entry => entry.source === source)
      const fields = entries.flatMap(entry => {
        const checkedAt = timestamp(entry.checkedAt)
        if (typeof entry.field !== 'string' || !entry.field.trim() || !checkedAt || !('ours' in entry) || !('theirs' in entry)) return []
        return [{ field: entry.field, nexusAtRead: entry.ours, channelAtRead: entry.theirs, checkedAt }]
      }).slice(0, DRIFT_FIELD_CAP)
      // Source clocks count fields before the storage cap. A later failed read keeps earlier entries;
      // an inconsistent/older clock must not hide those known historical differences.
      const differing = Math.max(entries.length, status === 'not_read' ? 0 : count(clock.differing) ?? 0)
      const notCompared = status === 'not_read' ? null : clock.notCompared === undefined ? 0 : count(clock.notCompared)
      const reason = status === 'not_read' ? 'No valid saved content-read status is available for this listing.'
        : typeof clock.reason === 'string' && clock.reason.trim() ? clock.reason.slice(0, 300)
          : status === 'not_compared' ? 'The latest content read could not compare this listing.' : undefined
      return { ...base, status, checkedAt: status === 'not_read' ? null : at, ...(reason ? { reason } : {}),
        differing, notCompared, omittedDifferences: differing - fields.length, fields }
    }),
  }
}
