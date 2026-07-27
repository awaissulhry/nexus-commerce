/**
 * ItemID re-link — verify against eBay, then repair BOTH stores.
 *
 * The VENTRA case this was built for: ChannelListing.externalListingId held
 * ended ItemIDs (status DRAFT) while SharedListingMembership.itemId held the
 * real live ones. The flat file renders the ChannelListing value, so the grid
 * showed dead IDs. Two tables own listing identity and they had drifted.
 *
 * Contract:
 *   • DRY RUN by default. `apply` must be passed explicitly to write.
 *   • The ItemID is verified against eBay (GetItem) before any write — see
 *     ebay-itemid-relink.pure.ts for the rules. 'unverifiable' requires an
 *     explicit acknowledgement; it never auto-passes.
 *   • An ItemID already owned by a DIFFERENT family is refused outright.
 *   • Writes are transactional and cover BOTH stores, so the two can't drift
 *     apart again through this path.
 */
import type { PrismaClient } from '@prisma/client'
import { callTradingApi, siteIdForMarket, escapeXml } from './ebay-trading-api.service.js'
import { parseLiveVariations } from './ebay-membership-reconcile.service.js'
import {
  normalizeItemId,
  checkItemIdOwnership,
  parseListingStatus,
  parseTopLevelSku,
  type OwnershipVerdict,
} from './ebay-itemid-relink.pure.js'

export interface RelinkInput {
  parentSku: string
  marketplace: string
  itemId: string
  /** Omit or false = dry run. */
  apply?: boolean
  /** Required to write when the verdict is 'unverifiable'. */
  acknowledgeUnverifiable?: boolean
}

export interface RelinkResult {
  parentSku: string
  marketplace: string
  itemId: string
  verdict: OwnershipVerdict | 'invalid'
  reason: string
  matchedSkus: string[]
  foreignSkus: string[]
  liveTitle?: string
  liveStatus?: string | null
  before: {
    externalListingId: string | null
    listingStatus: string | null
    membershipItemIds: string[]
    membershipRows: number
  }
  applied: boolean
  changes: string[]
}

export function buildGetItemForRelinkXml(itemId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID>
  <OutputSelector>Item.ItemID</OutputSelector>
  <OutputSelector>Item.Title</OutputSelector>
  <OutputSelector>Item.SKU</OutputSelector>
  <OutputSelector>Item.SellingStatus.ListingStatus</OutputSelector>
  <OutputSelector>Item.Variations.Variation.SKU</OutputSelector>
  <OutputSelector>Item.Variations.Variation.VariationSpecifics</OutputSelector>
</GetItemRequest>`
}

export async function relinkEbayItemId(
  prisma: PrismaClient,
  input: RelinkInput,
  ctx: { oauthToken: string },
): Promise<RelinkResult> {
  const marketplace = input.marketplace.toUpperCase()
  const region = marketplace === 'UK' ? 'GB' : marketplace
  const base = {
    parentSku: input.parentSku,
    marketplace,
    itemId: String(input.itemId ?? ''),
    matchedSkus: [] as string[],
    foreignSkus: [] as string[],
    before: { externalListingId: null as string | null, listingStatus: null as string | null, membershipItemIds: [] as string[], membershipRows: 0 },
    applied: false,
    changes: [] as string[],
  }

  const itemId = normalizeItemId(input.itemId)
  if (!itemId) {
    return { ...base, verdict: 'invalid', reason: 'ItemID must be 9–15 digits — eBay IDs are numeric.' }
  }

  const root = await prisma.product.findFirst({
    where: { sku: input.parentSku, deletedAt: null },
    select: { id: true, sku: true },
  })
  if (!root) return { ...base, itemId, verdict: 'invalid', reason: `No product with SKU "${input.parentSku}".` }

  const kids = await prisma.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: { sku: true } })
  const familySkus = [root.sku, ...kids.map((k) => k.sku)]
  // Shell listings pool other products' SKUs through memberships — those are
  // legitimately "this family's" SKUs for ownership purposes.
  const pooled = await prisma.sharedListingMembership.findMany({
    where: { parentSku: root.sku, marketplace },
    select: { sku: true },
  })
  for (const p of pooled) if (p.sku) familySkus.push(p.sku)

  // ── current state, for the report and the diff ──
  const cl = await prisma.channelListing.findFirst({
    where: { productId: root.id, channel: 'EBAY', region },
    select: { id: true, externalListingId: true, listingStatus: true },
  })
  const mems = await prisma.sharedListingMembership.findMany({
    where: { parentSku: root.sku, marketplace },
    select: { itemId: true },
  })
  base.before = {
    externalListingId: cl?.externalListingId ?? null,
    listingStatus: cl?.listingStatus ?? null,
    membershipItemIds: [...new Set(mems.map((m) => m.itemId))],
    membershipRows: mems.length,
  }

  // ── refuse an ItemID another family already owns ──
  // Scope the exclusion to the WHOLE family, not just the root: a family's
  // child ChannelListings legitimately carry the parent's ItemID, so
  // `productId != root.id` flagged a family as its own impostor and rejected
  // a correct re-link (caught by the VENTRA dry run before any UI existed).
  const familyProductIds = [root.id, ...(await prisma.product.findMany({
    where: { parentId: root.id, deletedAt: null }, select: { id: true },
  })).map((p) => p.id)]
  const clsElsewhere = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', externalListingId: itemId, productId: { notIn: familyProductIds } },
    select: { productId: true },
  })
  const memsElsewhere = await prisma.sharedListingMembership.findMany({
    where: { itemId, marketplace, parentSku: { not: root.sku } },
    select: { parentSku: true },
    take: 5,
  })
  if (clsElsewhere.length > 0 || memsElsewhere.length > 0) {
    const owners = [...new Set(memsElsewhere.map((m) => m.parentSku))]
    return {
      ...base,
      itemId,
      verdict: 'rejected',
      reason:
        `ItemID ${itemId} is already linked to ${owners.length ? `another family (${owners.join(', ')})` : 'another product'}. ` +
        'Two families pointing at one listing is how a push overwrites the wrong item — refusing.',
    }
  }

  // ── ask eBay who this item actually is ──
  let raw = ''
  try {
    const res = await callTradingApi('GetItem', buildGetItemForRelinkXml(itemId), {
      oauthToken: ctx.oauthToken,
      siteId: siteIdForMarket(marketplace),
    })
    raw = res.raw ?? ''
  } catch (err) {
    return {
      ...base,
      itemId,
      verdict: 'rejected',
      reason: `Could not read ItemID ${itemId} from eBay: ${err instanceof Error ? err.message : String(err)}. Not writing on an unverified ID.`,
    }
  }
  if (!raw) {
    return { ...base, itemId, verdict: 'rejected', reason: 'eBay returned no body for GetItem (dry-run mode or blocked) — refusing to write an unverified ItemID.' }
  }

  const liveStatus = parseListingStatus(raw)
  const liveTitle = /<Title>([^<]*)<\/Title>/.exec(raw)?.[1]
  const variationSkus = parseLiveVariations(raw).map((v) => v.sku)
  const topSku = parseTopLevelSku(raw)
  const liveSkus = variationSkus.length > 0 ? variationSkus : topSku ? [topSku] : []

  const check = checkItemIdOwnership({ liveSkus, familySkus, listingStatus: liveStatus })
  const result: RelinkResult = {
    ...base,
    itemId,
    verdict: check.verdict,
    reason: check.reason,
    matchedSkus: check.matchedSkus,
    foreignSkus: check.foreignSkus,
    liveTitle,
    liveStatus,
  }

  const mayWrite =
    check.verdict === 'verified' ||
    (check.verdict === 'unverifiable' && input.acknowledgeUnverifiable === true)
  if (!input.apply || !mayWrite) {
    if (input.apply && !mayWrite) {
      result.reason += check.verdict === 'unverifiable'
        ? ' Pass acknowledgeUnverifiable to write anyway.'
        : ' Nothing was written.'
    }
    return result
  }

  // ── repair BOTH stores together ──
  await prisma.$transaction(async (tx) => {
    if (cl) {
      await tx.channelListing.update({
        where: { id: cl.id },
        data: { externalListingId: itemId, listingStatus: 'ACTIVE' },
      })
      result.changes.push(
        `ChannelListing(${region}): externalListingId ${cl.externalListingId ?? 'NULL'} → ${itemId}` +
        (cl.listingStatus && cl.listingStatus !== 'ACTIVE' ? `, listingStatus ${cl.listingStatus} → ACTIVE` : ''),
      )
    } else {
      result.changes.push(`No ${region} ChannelListing for ${root.sku} — nothing to update there.`)
    }
    const stale = await tx.sharedListingMembership.updateMany({
      where: { parentSku: root.sku, marketplace, itemId: { not: itemId } },
      data: { itemId },
    })
    if (stale.count > 0) result.changes.push(`SharedListingMembership: ${stale.count} row(s) re-pointed to ${itemId}`)
  })
  result.applied = true
  return result
}
