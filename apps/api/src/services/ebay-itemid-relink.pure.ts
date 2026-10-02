/**
 * ItemID re-link — the SAFETY RULES, pure and testable.
 *
 * Why this exists (VENTRA, 2026-07-27): the operator ended listings, rebuilt
 * the families under new SKUs and created new eBay items. The new ItemIDs
 * landed on SharedListingMembership rows, but ChannelListing.externalListingId
 * kept the OLD, ended ones (status DRAFT) — and the flat file renders that
 * column, so the grid showed dead ItemIDs with no way to correct them.
 *
 * Re-pointing a family at an ItemID is one of the most dangerous edits in the
 * system: get it wrong and Nexus drives someone else's live listing — pushing
 * this family's price, quantity, title and images onto it. So the ID is never
 * taken on trust. It is checked against what eBay reports for that item, and
 * the write is refused unless ownership is proven.
 *
 * Deliberately three-valued: 'verified' | 'unverifiable' | 'rejected'.
 * "Cannot prove" must never collapse into "fine" — that conflation is what
 * lets bad data through quietly.
 */

/** eBay ItemIDs are numeric; 12 digits today, bounded loosely for longevity. */
export function normalizeItemId(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!/^\d{9,15}$/.test(s)) return null
  return s
}

export type OwnershipVerdict = 'verified' | 'unverifiable' | 'rejected'

export interface OwnershipCheck {
  verdict: OwnershipVerdict
  /** Operator-facing sentence. Always populated. */
  reason: string
  /** Live SKUs that belong to this family. */
  matchedSkus: string[]
  /** Live SKUs that belong to something ELSE — the dangerous signal. */
  foreignSkus: string[]
}

const norm = (s: string) => s.trim().toLowerCase()

export function checkItemIdOwnership(args: {
  /** SKUs eBay reports on the target ItemID ('' entries = SKU-less variations). */
  liveSkus: string[]
  /** Parent + child SKUs of the family being re-linked. */
  familySkus: string[]
  /** GetItem SellingStatus.ListingStatus, e.g. 'Active' | 'Completed' | 'Ended'. */
  listingStatus?: string | null
}): OwnershipCheck {
  const status = (args.listingStatus ?? '').trim()
  // A dead listing is exactly what caused this incident — never re-link onto one.
  if (status && norm(status) !== 'active') {
    return {
      verdict: 'rejected',
      reason: `eBay reports this listing as "${status}", not Active. Re-linking a family to an ended listing is the fault being repaired — refusing.`,
      matchedSkus: [],
      foreignSkus: [],
    }
  }

  const family = new Set(args.familySkus.map(norm).filter(Boolean))
  const live = args.liveSkus.map(norm).filter(Boolean) // '' = SKU-less variation

  if (live.length === 0) {
    return {
      verdict: 'unverifiable',
      reason:
        'That listing reports no SKUs, so ownership cannot be proven from eBay. ' +
        'Linking it is a judgement call — confirm explicitly that this ItemID is the right one.',
      matchedSkus: [],
      foreignSkus: [],
    }
  }

  const matchedSkus = [...new Set(live.filter((s) => family.has(s)))]
  const foreignSkus = [...new Set(live.filter((s) => !family.has(s)))]

  if (matchedSkus.length === 0) {
    return {
      verdict: 'rejected',
      reason: `None of the ${live.length} SKU(s) on that listing belong to this family — it is a different product. Linking it would drive someone else's listing.`,
      matchedSkus,
      foreignSkus,
    }
  }
  if (foreignSkus.length > 0) {
    return {
      verdict: 'rejected',
      reason: `That listing also carries ${foreignSkus.length} SKU(s) from outside this family (${foreignSkus.slice(0, 5).join(', ')}${foreignSkus.length > 5 ? '…' : ''}). Refusing a partial match — a shared listing must be adopted, not re-linked.`,
      matchedSkus,
      foreignSkus,
    }
  }
  return {
    verdict: 'verified',
    reason: `eBay confirms all ${matchedSkus.length} SKU(s) on this listing belong to this family.`,
    matchedSkus,
    foreignSkus,
  }
}

/** GetItem SellingStatus.ListingStatus, when present. */
export function parseListingStatus(raw: string): string | null {
  return /<ListingStatus>([^<]+)<\/ListingStatus>/.exec(raw)?.[1]?.trim() ?? null
}

/** Single-SKU listings carry Item.SKU instead of Variations. */
export function parseTopLevelSku(raw: string): string | null {
  const withoutVariations = raw.replace(/<Variations>[\s\S]*?<\/Variations>/g, '')
  return /<SKU>([^<]*)<\/SKU>/.exec(withoutVariations)?.[1]?.trim() || null
}

/**
 * I4 / G2 — GetItem's Item.Seller.UserID. Other UserIDs in the body (a high bidder) are not the seller.
 */
export function parseSellerUserId(raw: string): string | null {
  return /<Seller>[\s\S]*?<UserID>([^<]+)<\/UserID>[\s\S]*?<\/Seller>/.exec(raw)?.[1]?.trim() || null
}

export interface SellerCheck {
  verdict: OwnershipVerdict
  reason: string
}

/**
 * I4 / G2 — is the item listed by the seller behind the account Nexus would drive it through? The SKUs alone do not
 * say so: two businesses that share stock by SKU carry the same SKUs, so another business's live item passed the SKU
 * check. eBay user ids are case-insensitive. An account connected before Nexus recorded its seller (no
 * externalAccountId) cannot prove it: unverifiable, never verified.
 */
export function checkSellerOwnership(args: { itemSeller: string | null; accountSeller: string | null }): SellerCheck {
  const account = (args.accountSeller ?? '').trim()
  const item = (args.itemSeller ?? '').trim()
  if (!account) {
    return {
      verdict: 'unverifiable',
      reason: 'This eBay account has no recorded eBay seller (it was connected before Nexus recorded one), so it cannot be '
        + 'proven that the item is this account\'s. Reconnect the account in Nexus, or confirm explicitly.',
    }
  }
  if (!item) {
    return { verdict: 'unverifiable', reason: 'eBay did not say which seller lists this item, so it cannot be proven that it is this account\'s.' }
  }
  if (norm(item) !== norm(account)) {
    return {
      verdict: 'rejected',
      reason: `The item is listed by eBay seller "${item}", not by this account's seller "${account}". Linking it would drive another seller's listing — refusing.`,
    }
  }
  return { verdict: 'verified', reason: `eBay confirms the item is listed by this account's seller "${account}".` }
}

const VERDICT_RANK: Record<OwnershipVerdict, number> = { verified: 0, unverifiable: 1, rejected: 2 }

/** The SKU check and the seller check together: the worse verdict wins, and both reasons are said. */
export function combineOwnership(skus: OwnershipCheck, seller: SellerCheck): OwnershipCheck {
  const verdict = VERDICT_RANK[seller.verdict] > VERDICT_RANK[skus.verdict] ? seller.verdict : skus.verdict
  return { ...skus, verdict, reason: `${skus.reason} ${seller.reason}` }
}
