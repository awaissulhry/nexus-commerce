/**
 * Amazon sheet gaps (D4=B) — the offer DRAFT of a live Amazon listing: offer facts saved in Nexus that go to Amazon only
 * on Publish (design-draft-and-remote §A). Pure: the draft door (U5) persists it, Publish (U4a) sends and promotes it.
 *
 *   platformAttributes.amazonOfferDraft = { v: 1, leaves: { <leaf>: { value, base, savedAt, savedBy } } }
 *
 * `value: null` = remove it on Amazon; `base` = the live value when it was saved (the conflict check: D7=A keeps the
 * draft when live moves, and the sheet says so). A leaf equal to live is no change, so it is removed, and an empty
 * draft is no draft. Values use one shape per leaf (`AmazonOfferDraftValues`).
 */
import { AMAZON_OFFER_DRAFT_KEY, AMAZON_OFFER_LEAVES, dayOf, isAmazonDate, type AmazonOfferLeaf } from './offer-fields.js'

/** A draft's value of each leaf. A price either pins a number or follows its rule again. */
export interface AmazonOfferDraftValues {
  our_price: { pin: number } | { follow: true }
  sale: { price: number; start: string; end: string } | null
  minimum_seller_allowed_price: number | null
  maximum_seller_allowed_price: number | null
  map_price: number | null
  offer_start_at: string | null
  offer_end_at: string | null
  automated_pricing_rule_id: string | null
  lead_time_to_ship_max_days: number | null
  restock_date: string | null
  is_inventory_available: boolean | null
}

export interface AmazonOfferDraftLeaf<V = unknown> {
  value: V
  base: V
  savedAt: string
  savedBy: string
}

export interface AmazonOfferDraft {
  v: 1
  leaves: Partial<{ [L in AmazonOfferLeaf]: AmazonOfferDraftLeaf<AmazonOfferDraftValues[L] | null> }>
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const isLeaf = (k: string): k is AmazonOfferLeaf => (AMAZON_OFFER_LEAVES as readonly string[]).includes(k)

/** The draft a listing carries, or null. Unknown leaves and malformed entries are dropped, never trusted. */
export function readAmazonOfferDraft(platformAttributes: unknown): AmazonOfferDraft | null {
  const raw = record(record(platformAttributes)?.[AMAZON_OFFER_DRAFT_KEY])
  const leaves = record(raw?.leaves)
  if (!raw || raw.v !== 1 || !leaves) return null
  const out: AmazonOfferDraft = { v: 1, leaves: {} }
  for (const [k, entry] of Object.entries(leaves)) {
    const e = record(entry)
    if (!isLeaf(k) || !e || !('value' in e)) continue
    ;(out.leaves as Record<string, AmazonOfferDraftLeaf>)[k] = {
      value: e.value ?? null, base: e.base ?? null,
      savedAt: typeof e.savedAt === 'string' ? e.savedAt : '', savedBy: typeof e.savedBy === 'string' ? e.savedBy : '',
    }
  }
  return Object.keys(out.leaves).length ? out : null
}

const cents = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null)
const sameDate = (a: unknown, b: unknown): boolean => {
  if (a == null || b == null) return a == null && b == null
  if (typeof a !== 'string' || typeof b !== 'string') return false
  // A calendar day equals the same day written as a date-time at midnight UTC; any other time is a different value.
  const norm = (s: string) => (isAmazonDate(s) && /T00:00(:00(\.0+)?)?(Z|\+00:00)?$/.test(s) ? dayOf(s) : s)
  return norm(a.trim()) === norm(b.trim())
}

/** Do two values of one leaf say the same thing on Amazon? Prices to the cent; dates by their written value. */
export function amazonOfferValuesEqual(leaf: AmazonOfferLeaf, a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null
  switch (leaf) {
    case 'our_price': {
      const x = a as { pin?: number; follow?: boolean }, y = b as { pin?: number; follow?: boolean }
      if (x.follow === true || y.follow === true) return x.follow === true && y.follow === true
      return cents(x.pin) != null && cents(x.pin) === cents(y.pin)
    }
    case 'sale': {
      const x = a as { price?: number; start?: string; end?: string }, y = b as { price?: number; start?: string; end?: string }
      return cents(x.price) === cents(y.price) && sameDate(x.start, y.start) && sameDate(x.end, y.end)
    }
    case 'minimum_seller_allowed_price': case 'maximum_seller_allowed_price': case 'map_price':
      return cents(a) != null && cents(a) === cents(b)
    case 'offer_start_at': case 'offer_end_at': case 'restock_date':
      return sameDate(a, b)
    case 'automated_pricing_rule_id':
      return typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim()
    default:
      return a === b
  }
}

/**
 * Save one leaf. `live` is the live value now, in the draft's shape; it becomes the leaf's `base`. A value equal to live
 * removes the leaf (nothing waits for Publish). Returns the new draft, or null when nothing is left.
 */
export function setAmazonOfferDraftLeaf<L extends AmazonOfferLeaf>(
  draft: AmazonOfferDraft | null,
  leaf: L,
  input: { value: AmazonOfferDraftValues[L] | null; live: AmazonOfferDraftValues[L] | null; at: string; by: string },
): AmazonOfferDraft | null {
  if (amazonOfferValuesEqual(leaf, input.value, input.live)) return removeAmazonOfferDraftLeaf(draft, leaf)
  const leaves = { ...(draft?.leaves ?? {}) } as Record<string, AmazonOfferDraftLeaf>
  leaves[leaf] = { value: input.value ?? null, base: input.live ?? null, savedAt: input.at, savedBy: input.by }
  return { v: 1, leaves }
}

/** Discard one leaf (Discard / undo, or a promotion). Null when nothing is left. */
export function removeAmazonOfferDraftLeaf(draft: AmazonOfferDraft | null, leaf: AmazonOfferLeaf): AmazonOfferDraft | null {
  if (!draft || !(leaf in draft.leaves)) return draft && Object.keys(draft.leaves).length ? draft : null
  const leaves = { ...draft.leaves } as Record<string, AmazonOfferDraftLeaf>
  delete leaves[leaf]
  return Object.keys(leaves).length ? { v: 1, leaves } : null
}

/** The platformAttributes bag with this draft — or without the key when the draft is null. Everything else is kept. */
export function withAmazonOfferDraft(platformAttributes: unknown, draft: AmazonOfferDraft | null): Record<string, unknown> {
  const pa = { ...(record(platformAttributes) ?? {}) }
  if (draft && Object.keys(draft.leaves).length) pa[AMAZON_OFFER_DRAFT_KEY] = draft
  else delete pa[AMAZON_OFFER_DRAFT_KEY]
  return pa
}

/** How many leaves wait for Publish on one listing. */
export const amazonOfferDraftCount = (draft: AmazonOfferDraft | null): number => (draft ? Object.keys(draft.leaves).length : 0)
/** How many listings / leaves wait for Publish across many. */
export function amazonOfferDraftTotals(drafts: ReadonlyArray<AmazonOfferDraft | null>): { listings: number; leaves: number } {
  let listings = 0, leaves = 0
  for (const d of drafts) { const n = amazonOfferDraftCount(d); if (n) { listings++; leaves += n } }
  return { listings, leaves }
}

/** One leaf Publish sent and Amazon accepted: the value sent and the base it was saved against (the journal's). */
export interface SentAmazonOfferLeaf { value: unknown; base: unknown }

export interface AmazonOfferPromotionPlan {
  /** Live == base: write the sent value to the live store, through its door. */
  promote: Array<{ leaf: AmazonOfferLeaf; value: unknown }>
  /** Live moved after the save: the newer live wins (re-sent by the caller); Amazon got the saved value meanwhile. */
  drop: Array<{ leaf: AmazonOfferLeaf; value: unknown; live: unknown; note: string }>
  /** Draft leaves to remove: those that still hold exactly the sent value (a newer saved value stays). */
  removeDraft: AmazonOfferLeaf[]
}

/**
 * After Amazon accepted a Publish: for each sent leaf, live still equals the base it was saved against → promote it;
 * live moved meanwhile → the newer live wins and the leaf is dropped. A draft leaf saved again after the send (a newer
 * value) is kept in both cases.
 */
export function amazonOfferPromotionPlan(input: {
  sent: Partial<Record<AmazonOfferLeaf, SentAmazonOfferLeaf>>
  /** The live values now, in the draft's shape. */
  live: Partial<Record<AmazonOfferLeaf, unknown>>
  /** The listing's draft now (it may have changed since the send). */
  draft: AmazonOfferDraft | null
  describe?: (leaf: AmazonOfferLeaf, value: unknown) => string
}): AmazonOfferPromotionPlan {
  const plan: AmazonOfferPromotionPlan = { promote: [], drop: [], removeDraft: [] }
  const words = input.describe ?? ((_l, v) => (v == null ? 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v)))
  for (const leaf of AMAZON_OFFER_LEAVES) {
    const sent = input.sent[leaf]
    if (!sent) continue
    const live = input.live[leaf] ?? null
    if (amazonOfferValuesEqual(leaf, live, sent.base)) plan.promote.push({ leaf, value: sent.value })
    else plan.drop.push({ leaf, value: sent.value, live,
      note: `Live changed to ${words(leaf, live)} after the saved ${words(leaf, sent.value)} was sent; Nexus keeps live and sends it again.` })
    const now = input.draft?.leaves[leaf]
    if (now && amazonOfferValuesEqual(leaf, now.value, sent.value)) plan.removeDraft.push(leaf)
  }
  return plan
}
