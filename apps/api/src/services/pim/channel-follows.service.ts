/**
 * MS.7 — putting a channel field back under the master's control.
 *
 * `docs/2026-08-29-master-sheet-design.md` §16. This closes the one genuinely missing route in the
 * master-sheet work: `PATCH /products/:id/channel-pricing` PINS a field when a price is written
 * (`followMasterPrice = false`) and explicitly ignores `price: null`, so nothing anywhere could set
 * a follow flag back to `true`. Inheritance was a one-way door — an operator could break it by
 * accident and had no way back — which is why MS.6 shipped read-only.
 *
 * What flipping a flag does, precisely, because the distinction matters:
 *   `follows: true`  — the MASTER becomes the source for that field again. For a content field the
 *                      channel's own value is left in place (see below) and nothing is sent: the live
 *                      listing changes on the next publish. For the PRICE (2026-10-01) the flag goes
 *                      through the ONE channel price door: the price is recomputed by the listing's rule
 *                      and queued for the channel now (30 s to undo), or refused by name — outside the
 *                      product's floor or ceiling — with nothing written; a market in another currency
 *                      keeps its price and the result says why (`notSent`).
 *   `follows: false` — the channel keeps whatever it is carrying, and the master stops driving it.
 *
 * **The channel's value is never destroyed.** For price/quantity/title/description the pinned value
 * often lives in the DIRECT column (`price`, `title`), not in `*Override` — rows predating the Phase
 * 20 SSOT split store it there, and `attribute-resolver.ts` falls back to it. That column is also
 * what the channel is actually carrying right now. Clearing it to "tidy up" would erase the record of
 * a live listing's real price. So following the master again clears only the explicit `*Override`,
 * and the direct column stays as the truthful record of what is live.
 */

/** The six fields that carry a follow flag. JSONB attributes have none — see the design doc §5. */
export const FOLLOWABLE_FIELDS = ['title', 'description', 'price', 'quantity', 'images', 'bulletPoints'] as const
export type FollowableField = (typeof FOLLOWABLE_FIELDS)[number]

interface FieldColumns {
  flag: string
  /** The explicit override column, cleared when the master takes over again. Null = none exists. */
  override: string | null
}

const FIELD_COLUMNS: Record<FollowableField, FieldColumns> = {
  title: { flag: 'followMasterTitle', override: 'titleOverride' },
  description: { flag: 'followMasterDescription', override: 'descriptionOverride' },
  price: { flag: 'followMasterPrice', override: 'priceOverride' },
  quantity: { flag: 'followMasterQuantity', override: 'quantityOverride' },
  bulletPoints: { flag: 'followMasterBulletPoints', override: 'bulletPointsOverride' },
  // Images have a follow flag but no override column — the gallery is a relation, not a scalar.
  images: { flag: 'followMasterImages', override: null },
}

export const isFollowableField = (v: unknown): v is FollowableField =>
  typeof v === 'string' && (FOLLOWABLE_FIELDS as readonly string[]).includes(v)

/**
 * The Prisma `data` for one flag change. PURE — the shape is the whole contract, so it is asserted
 * directly rather than through a database.
 */
export function followUpdateData(field: FollowableField, follows: boolean): Record<string, unknown> {
  const cols = FIELD_COLUMNS[field]
  const data: Record<string, unknown> = { [cols.flag]: follows }
  // Handing the field back to the master clears the EXPLICIT override only. The direct column is
  // what the channel is carrying and is not ours to erase.
  if (follows && cols.override) data[cols.override] = null
  return data
}

/** Which fields a listing has pinned, for reporting back what actually changed. */
export function pinnedFields(listing: Record<string, unknown>): FollowableField[] {
  return FOLLOWABLE_FIELDS.filter((f) => listing[FIELD_COLUMNS[f].flag] === false)
}

export const followFlagColumn = (field: FollowableField): string => FIELD_COLUMNS[field].flag
export const overrideColumn = (field: FollowableField): string | null => FIELD_COLUMNS[field].override


export interface FollowUpdateRequest {
  marketplace: string
  channel?: string
  field: FollowableField
  follows: boolean
}

export interface FollowUpdateResult {
  marketplace: string
  channel: string
  field: FollowableField
  ok: boolean
  reason?: string
  follows?: boolean
  stillPinned?: FollowableField[]
  /** Price only: the flag was saved but no price was sent, and why (another currency, paused, Match Amazon…). */
  notSent?: string
  /** Price only: a PRICE_UPDATE row was queued for the channel. */
  queued?: boolean
}

/**
 * Apply flag changes to a product's channel listings.
 *
 * The DB work lives here rather than in the route: a route file states the contract and validates
 * the request; the logic that touches Prisma belongs in a service the route calls. That is the
 * standard the route/prisma ratchet enforces, and this service already owns the pure half.
 *
 * A coordinate with no listing is a RESULT, not an error — a market the product was never listed on
 * has nothing to inherit, and failing the whole call for it would punish a reasonable request.
 */
export async function applyChannelFollows(
  productId: string,
  updates: FollowUpdateRequest[],
  actor = 'master-sheet',
): Promise<FollowUpdateResult[]> {
  const { default: prisma } = await import('../../db.js')
  const { writeChannelPrices } = await import('./channel-price-write.service.js')
  const results: FollowUpdateResult[] = []

  for (const u of updates) {
    const marketplace = String(u.marketplace).toUpperCase()
    const channel = String(u.channel ?? 'AMAZON').toUpperCase()

    const listing = await prisma.channelListing.findFirst({
      where: { productId, channel, marketplace },
      select: { id: true },
    })
    if (!listing) {
      results.push({ marketplace, channel, field: u.field, ok: false, reason: 'no listing on this coordinate' })
      continue
    }

    const FLAGS = {
      id: true, followMasterTitle: true, followMasterDescription: true, followMasterPrice: true,
      followMasterQuantity: true, followMasterImages: true, followMasterBulletPoints: true,
    } as const
    if (u.field === 'price') {
      // The price's flag is the price door's follower mode: the same columns `followUpdateData('price', …)` names,
      // and the price it gives is sent. A coordinate names no version, so the door is told why it has none.
      const written = await writeChannelPrices({
        targets: [{ listingId: listing.id, follow: u.follows, unguardedReason: 'channel-follows' }],
        actor, source: 'MANUAL_OVERRIDE', reason: 'Master sheet: price follows',
      })
      const outcome = written.results[0]
      if (!outcome || outcome.outcome === 'refused' || outcome.outcome === 'conflict') {
        results.push({ marketplace, channel, field: u.field, ok: false, reason: outcome?.reason ?? 'The price write refused this listing.' })
        continue
      }
      const flags = await prisma.channelListing.findUnique({ where: { id: listing.id }, select: FLAGS })
      results.push({
        marketplace, channel, field: u.field, ok: true,
        follows: u.follows,
        stillPinned: pinnedFields((flags ?? {}) as unknown as Record<string, unknown>),
        queued: outcome.queueId != null,
        ...(outcome.notSent ? { notSent: outcome.notSent } : {}),
      })
      continue
    }

    const updated = await prisma.channelListing.update({
      where: { id: listing.id },
      data: followUpdateData(u.field, u.follows),
      select: FLAGS,
    })

    results.push({
      marketplace, channel, field: u.field, ok: true,
      follows: u.follows,
      stillPinned: pinnedFields(updated as unknown as Record<string, unknown>),
    })
  }

  return results
}
