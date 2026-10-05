/**
 * E5a (Etsy publisher) — "ours" for ONE Etsy listing: what Studio Publish WOULD SEND, taken from the publisher itself
 * (`prepareEtsyPublication`), never from a second copy of its rules (the ebay-content-ours.ts pattern).
 *
 * The unit is the listing's MAIN row (its one parentless `ChannelListing`): Etsy's listing fields, attributes,
 * translations and the variation set belong to the listing, which the main row owns in Nexus.
 *
 * The publisher is given a reader that throws: it never reads Etsy here (the sweep already holds Etsy's answers) and,
 * without a live listing, it never asks the order-import switch (studio-publication-etsy.ts:188-193). Schemas are read
 * from the cache only (`withCachedSchemas`): a read job never starts provider work. Any refusal of the publisher is the
 * reason the listing is not compared — never clean.
 *
 * The photo count is Nexus's Etsy gallery as the media plan lays it out for this listing (`mediaLayoutFor`, import only);
 * a family not on the media plan has no Etsy photo list (`ETSY_NOT_ON_MEDIA_PLAN`): nothing of Nexus's to differ, so the
 * comparison settles its photos as matching; any other failure leaves them not compared.
 */
import type { EtsyMediaLayout } from '@nexus/shared/media-plan-channels'
import prisma from '../../db.js'
import { mediaLayoutFor } from '../images/media-plan.service.js'
import { withCachedSchemas } from '../pim/cached-schema-context.js'
import { prepareEtsyPublication } from '../pim/studio-publication-etsy.js'
import type { EtsyPublication } from '../pim/studio-publication-etsy-types.js'
import { readPublicationFacts, type PublicationFacts } from '../pim/studio-publication-plan.js'
import { ETSY_NOT_ON_MEDIA_PLAN } from './etsy-content-compare.js'

export type EtsyOursResult = { ok: true; facts: PublicationFacts; publication: EtsyPublication } | { ok: false; reason: string }

/** Settled on Nexus's side: the comparison records photos as compared with no difference (etsy-content-compare.ts). */
export { ETSY_NOT_ON_MEDIA_PLAN }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function etsyContentOurs(ownerListingId: string): Promise<EtsyOursResult> {
  const row = await prisma.channelListing.findUnique({ where: { id: ownerListingId },
    select: { id: true, productId: true, marketplace: true, channelConnectionId: true, externalListingId: true,
      product: { select: { parentId: true, deletedAt: true } } } })
  if (!row || !row.product || row.product.deletedAt) return { ok: false, reason: 'the listing or its product no longer exists' }
  if (row.product.parentId) return { ok: false, reason: 'not the Etsy listing\'s main row' }
  if (!row.externalListingId || !row.channelConnectionId) return { ok: false, reason: 'the listing has no Etsy Listing ID or no account' }
  const accountId = row.channelConnectionId, listingId = row.externalListingId
  try {
    return await withCachedSchemas(async (): Promise<EtsyOursResult> => {
      const facts = await readPublicationFacts(row.productId, { channel: 'ETSY', marketplace: row.marketplace, accountId, listingId: row.id })
      const publication = await prepareEtsyPublication(facts, { readLive: async () => { throw new Error('not read here') } })
      if (publication.listingId !== listingId) return { ok: false, reason: `the review targets Etsy listing ${publication.listingId ?? 'none'}, not ${listingId}` }
      return { ok: true, facts, publication }
    })
  } catch (error) {
    return { ok: false, reason: `the Etsy review refused: ${message(error)}` }
  }
}

export async function etsyNexusPhotoCount(owner: { productId: string; channelConnectionId: string; aliasKey: string }): Promise<{ count: number | null; reason?: string }> {
  try {
    const plan = await mediaLayoutFor({ productId: owner.productId, channel: 'ETSY', marketplace: 'GLOBAL', accountId: owner.channelConnectionId, aliasKey: owner.aliasKey })
    if (!plan) return { count: null, reason: ETSY_NOT_ON_MEDIA_PLAN }
    // An Etsy destination's layout is Etsy's (`projectEtsy`): `images` is the listing's gallery, at most Etsy's 20.
    return { count: (plan.layout as EtsyMediaLayout).images.length }
  } catch (error) {
    return { count: null, reason: message(error) }
  }
}
