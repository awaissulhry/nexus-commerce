/**
 * Amazon sheet gaps (D4=B, D6=A, D7=A) — what Amazon's ACCEPTANCE of a Publish of offer drafts does in Nexus, ONCE
 * (design-draft-and-remote §A "Promotion").
 *
 * Runs after the result is stored (`storeResult` in `studio-publication-settle.ts`, after its transaction committed), in
 * its own transaction, so the doors' after-commit work (the job re-send, the live hint) runs after IT commits. Exactly
 * once: under an advisory lock per publication, and `BulkOperation.changes.offerPromotion = 'done'` in the same
 * transaction. A crash before that commit leaves no marker and no write; the result sweep runs it again
 * (`recoverOfferPromotions`).
 *
 * Per ACCEPTED journal that carried an offer (`request.offer = { leaves, base }`, base = Nexus live at review):
 *   - live still equals the base → the sent value becomes live through its own door (`writeChannelPrices`,
 *     `setAmazonFulfilmentSettings`, reason `publish-accepted`: Amazon took it, so no bounds re-check);
 *   - live moved since the review → the newer live wins: nothing is written over it, the leaf is dropped, an audit row
 *     says so, and live is sent again;
 *   - either way each door sends ONE job re-send of the live values (D6: a stock push during processing may have carried
 *     the old handling time), and a draft leaf is removed only while it still holds exactly the sent value
 *     (`clearPromotedDraftLeaves`) — a newer saved value stays. Fulfilment settings are one per SKU across the EU
 *     markets: both doors work on every EU row.
 * A FAILED journal promotes nothing and its draft stays. UNVERIFIED promotes nothing (`OFFER_DRAFT_UNVERIFIED`).
 */
import { Prisma } from '@prisma/client'
import { OFFER_DRAFT_UNVERIFIED, type StudioPublishResult } from '@nexus/shared/studio-publication'
import { pricingRuleLabel } from '@nexus/shared/listing-price'
import prisma from '../../db.js'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { logger } from '../../utils/logger.js'
import { AMAZON_OFFER_LEAVES, rootOfLeaf, type AmazonOfferLeaf } from '../amazon/offer-fields.js'
import { liveDraftValues, loadAmazonOfferFacts } from '../amazon/offer-facts.js'
import { amazonOfferPromotionPlan, readAmazonOfferDraft, type SentAmazonOfferLeaf } from '../amazon/offer-draft.js'
import { writeChannelPrices, type AmazonOfferWrite, type PriceWriteTarget } from './channel-price-write.service.js'
import { setAmazonFulfilmentSettings, type AmazonFulfilmentSettings } from './amazon-fulfilment-settings.service.js'
import { clearPromotedDraftLeaves } from './amazon-offer-draft.service.js'
import { offerValueWords, type AmazonOfferJournal } from './studio-publication-amazon-offer.js'
import { PUBLICATION_KIND } from './studio-publication-settle.js'

/** The marker in `BulkOperation.changes`: the promotion of this publication ran (whatever it found). */
export const OFFER_PROMOTION_MARKER = 'offerPromotion'
/** The statuses whose ACCEPTED journals are promoted (PARTIAL: only the SKUs Amazon accepted). */
const PROMOTABLE = ['ACCEPTED', 'PARTIAL'] as const
const REASON = 'Publish accepted by Amazon'

export interface OfferPromotionResult {
  /** Why nothing ran: already promoted, not a publication, not accepted (FAILED, in flight), or Amazon's answer unknown. */
  skipped?: 'done' | 'none' | 'not-accepted' | 'unverified'
  /** The sheet's words for an unverified publication. */
  note?: string
  promoted: Array<{ listingId: string; leaves: AmazonOfferLeaf[] }>
  dropped: Array<{ listingId: string; leaf: AmazonOfferLeaf; note: string }>
  /** A door that refused (the listing became FBA, a closed offer…): those leaves stay drafts. */
  refused: Array<{ listingId: string; leaves: AmazonOfferLeaf[]; reason: string }>
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const isLeaf = (k: string): k is AmazonOfferLeaf => (AMAZON_OFFER_LEAVES as readonly string[]).includes(k)

/** The offer a journal's request carried (one Amazon feed message per SKU). */
function journalOffer(payload: unknown): AmazonOfferJournal | null {
  const requests = record(payload)?.requests
  for (const request of Array.isArray(requests) ? [...requests].reverse() : []) {
    const offer = record(record(request)?.offer)
    if (offer && record(offer.leaves)) return { leaves: record(offer.leaves)!, base: record(offer.base) ?? {} }
  }
  return null
}

/** The price door's target for the promoted price, sale and offer settings (none = a re-send of the live values). */
function priceTarget(listingId: string, promote: ReadonlyArray<{ leaf: AmazonOfferLeaf; value: unknown }>): PriceWriteTarget {
  const target: PriceWriteTarget = { listingId, unguardedReason: 'publish-accepted' }
  for (const { leaf, value } of promote) {
    const v = record(value)
    if (leaf === 'our_price') { if (v?.follow === true) target.follow = true; else target.price = Number(v?.pin) }
    else if (leaf === 'sale') target.sale = v ? { value: Number(v.price), start: String(v.start), end: String(v.end) } : { value: null, start: null, end: null }
    else (target.offer ??= {})[leaf as keyof AmazonOfferWrite] = value as never
  }
  return target
}

type Tx = Prisma.TransactionClient

async function promoteListing(tx: Tx, listingId: string, offer: AmazonOfferJournal, actor: string, out: OfferPromotionResult): Promise<void> {
  const sent: Partial<Record<AmazonOfferLeaf, SentAmazonOfferLeaf>> = {}
  for (const [leaf, value] of Object.entries(offer.leaves)) if (isLeaf(leaf)) sent[leaf] = { value, base: offer.base[leaf] ?? null }
  const row = await tx.channelListing.findUnique({ where: { id: listingId }, select: { platformAttributes: true, pricingRule: true, priceAdjustmentPercent: true } })
  const facts = row ? (await loadAmazonOfferFacts(tx, [listingId], 'job')).get(listingId) : undefined
  if (!row || !facts) { out.refused.push({ listingId, leaves: Object.keys(sent) as AmazonOfferLeaf[], reason: 'The listing no longer exists.' }); return }
  const rule = pricingRuleLabel(row.pricingRule, row.priceAdjustmentPercent as never)
  const plan = amazonOfferPromotionPlan({ sent, live: liveDraftValues(facts), draft: readAmazonOfferDraft(row.platformAttributes),
    describe: (leaf, value) => offerValueWords(leaf, value, rule) })
  const all = [...plan.promote, ...plan.drop]
  const applied = new Set<AmazonOfferLeaf>()

  // Price, sale and offer settings: the promoted ones written; the door re-sends the live values once either way.
  const offerSent = all.filter((p) => rootOfLeaf(p.leaf) === 'purchasable_offer')
  if (offerSent.length) {
    const r = (await writeChannelPrices({ targets: [priceTarget(listingId, plan.promote.filter((p) => rootOfLeaf(p.leaf) === 'purchasable_offer'))],
      actor, source: 'MANUAL_OVERRIDE', reason: REASON, tx })).results[0]
    if (r?.outcome === 'applied' || r?.outcome === 'noop') offerSent.forEach((p) => applied.add(p.leaf))
    else out.refused.push({ listingId, leaves: offerSent.map((p) => p.leaf), reason: r?.reason ?? 'The price door did not answer.' })
  }
  // Fulfilment settings: the promoted values, and live again for a dropped leaf (the door re-sends once with the quantity).
  const fulfilmentSent = all.filter((p) => rootOfLeaf(p.leaf) === 'fulfillment_availability')
  if (fulfilmentSent.length) {
    const settings: AmazonFulfilmentSettings = Object.fromEntries([
      ...plan.promote.filter((p) => rootOfLeaf(p.leaf) === 'fulfillment_availability').map((p) => [p.leaf, p.value]),
      ...plan.drop.filter((d) => rootOfLeaf(d.leaf) === 'fulfillment_availability').map((d) => [d.leaf, d.live]),
    ])
    const r = await setAmazonFulfilmentSettings({ listingIds: [listingId], unguardedReason: 'publish-accepted', settings, actor, reason: REASON, tx })
    if (r.outcome === 'applied' || r.outcome === 'noop') fulfilmentSent.forEach((p) => applied.add(p.leaf))
    else out.refused.push({ listingId, leaves: fulfilmentSent.map((p) => p.leaf), reason: r.reason ?? r.outcome })
  }

  // Drafts: a leaf goes only while it still holds exactly what was sent (the draft door clears a fulfilment leaf on every
  // EU row of the SKU, where it was saved).
  const clear = Object.fromEntries(all.filter((p) => applied.has(p.leaf)).map((p) => [p.leaf, p.value])) as Partial<Record<AmazonOfferLeaf, unknown>>
  if (Object.keys(clear).length) await clearPromotedDraftLeaves({ listingId, sent: clear }, { tx })
  for (const d of plan.drop) {
    if (!applied.has(d.leaf)) continue
    await tx.channelListingOverride.create({ data: { channelListingId: listingId, fieldName: `amazonOfferDraft.${d.leaf}`,
      previousValue: offerValueWords(d.leaf, d.value, rule), newValue: offerValueWords(d.leaf, d.live, rule), reason: `${REASON}: ${d.note}`, changedBy: actor } })
    out.dropped.push({ listingId, leaf: d.leaf, note: d.note })
  }
  const promoted = plan.promote.filter((p) => applied.has(p.leaf)).map((p) => p.leaf)
  if (promoted.length) out.promoted.push({ listingId, leaves: promoted })
}

/** Promote one publication's accepted offer drafts, once. Throws on a database failure (the sweep retries it). */
export async function promotePublishedOffers(publicationId: string, options: { actor?: string | null } = {}): Promise<OfferPromotionResult> {
  const result = await inDatabaseTransaction(prisma, async () => {
    // Per attempt: a restarted transaction starts with nothing reported.
    const out: OfferPromotionResult = { promoted: [], dropped: [], refused: [] }
    const tx = activeDatabaseTransaction()!
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `studio-publication-offer:${publicationId}`)
    const operation = await tx.bulkOperation.findFirst({ where: { id: publicationId }, select: { status: true, userId: true, changes: true } })
    const data = record(operation?.changes) ?? {}
    if (!operation || data.kind !== PUBLICATION_KIND) return { ...out, skipped: 'none' as const }
    if (data[OFFER_PROMOTION_MARKER] === 'done') return { ...out, skipped: 'done' as const }
    if (operation.status === 'UNVERIFIED') return { ...out, skipped: 'unverified' as const, note: OFFER_DRAFT_UNVERIFIED }
    if (!(PROMOTABLE as readonly string[]).includes(operation.status)) return { ...out, skipped: 'not-accepted' as const }
    const actor = options.actor ?? operation.userId ?? 'publish'
    const journals = await tx.channelListingSnapshot.findMany({ where: { publishEventId: publicationId, reason: 'publish', channel: 'AMAZON', outcome: 'ACCEPTED' },
      select: { channelListingId: true, payload: true }, orderBy: { channelListingId: 'asc' } })
    for (const journal of journals) {
      const offer = journalOffer(journal.payload)
      if (offer) await promoteListing(tx, journal.channelListingId, offer, actor, out)
    }
    await tx.$executeRaw`UPDATE "BulkOperation" SET changes = jsonb_set(COALESCE(changes, '{}'::jsonb), ${`{${OFFER_PROMOTION_MARKER}}`}::text[], '"done"'::jsonb) WHERE id = ${publicationId}`
    return out
  }, { isolationLevel: 'ReadCommitted' })
  if (result.promoted.length || result.dropped.length || result.refused.length) {
    logger.info('studio publication: offer drafts promoted', { publicationId, promoted: result.promoted.length, dropped: result.dropped.length, refused: result.refused.length })
  }
  return result
}

/**
 * The settle core's one call, after `storeResult` committed: an Amazon result Amazon accepted (in whole or in part)
 * promotes its offer drafts. Never throws — a failure is logged and the result sweep recovers it.
 */
export async function promoteOffersAfterResult(publicationId: string, data: Record<string, any>, result: StudioPublishResult, userId: string | null): Promise<void> {
  if (data.scope?.channel !== 'AMAZON' || !(PROMOTABLE as readonly string[]).includes(result.status)) return
  try { await promotePublishedOffers(publicationId, { actor: userId }) }
  catch (error) { logger.warn('studio publication: offer promotion failed; the result sweep runs it again', { publicationId, error: error instanceof Error ? error.message : String(error) }) }
}

const RECOVERY_GRACE_MS = 60_000
const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60_000

/**
 * The result sweep's recovery: accepted Amazon publications (the last 7 days) whose journals carried an offer and that
 * have no marker — the promotion after `storeResult` never committed (a crash, a database failure). A minute's grace
 * leaves the normal run its turn; the lock and the marker make a race harmless either way.
 */
export async function recoverOfferPromotions(now = new Date(), limit = 20): Promise<{ found: number; promoted: number; failed: number }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; userId: string | null }>>(Prisma.sql`
    SELECT b.id, b."userId" FROM "BulkOperation" b
     WHERE b.kind = ${PUBLICATION_KIND} AND b.channel = 'AMAZON' AND b.status IN ('ACCEPTED', 'PARTIAL')
       AND b."completedAt" <= ${new Date(now.getTime() - RECOVERY_GRACE_MS)} AND b."completedAt" >= ${new Date(now.getTime() - RECOVERY_WINDOW_MS)}
       AND (b.changes ->> ${OFFER_PROMOTION_MARKER}) IS NULL
       AND EXISTS (SELECT 1 FROM "ChannelListingSnapshot" s WHERE s."publishEventId" = b.id AND s.reason = 'publish' AND s.outcome = 'ACCEPTED'
                     AND jsonb_path_exists(s.payload, '$.requests[*].offer'))
     ORDER BY b."completedAt" ASC LIMIT ${limit}`)
  let promoted = 0, failed = 0
  for (const row of rows) {
    try { await promotePublishedOffers(row.id, { actor: row.userId }); promoted++ }
    catch (error) { failed++; logger.warn('studio publication: offer promotion recovery failed; the next sweep tries again', { publicationId: row.id, error: error instanceof Error ? error.message : String(error) }) }
  }
  return { found: rows.length, promoted, failed }
}
