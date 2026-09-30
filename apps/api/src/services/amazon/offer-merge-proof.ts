/**
 * The read-only proof of the Amazon offer merge (NEXUS_AMAZON_OFFER_MERGE; Owner, 2026-09-30): the logic of
 * `scripts/amazon-offer-merge-proof.mts`, kept here so tests can prove it cannot send a real patch.
 *
 * For ONE listing it prints what Nexus stores, the live `purchasable_offer` verbatim, the exact merge each price sender
 * would send with the switch ON for the CURRENT live price (a no-op price), and Amazon's VALIDATION_PREVIEW answer to
 * that merge. Nothing is saved anywhere:
 *   - the database is read in a READ ONLY transaction (`inReadOnlyTransaction`: any write inside it fails);
 *   - the only Amazon calls are the listing read and `validateListing`, which always sends `mode=VALIDATION_PREVIEW`
 *     ("validated without persisting") — through `previewOnlyClient`, which refuses every other client method before a
 *     request exists.
 */
import type { Prisma } from '@prisma/client'
import type { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { amazonPriceOfferPlan, readAmazonOfferLive, type AmazonPriceOfferPlan } from './purchasable-offer.js'

type Client = typeof amazonSpApiClient
export type PreviewOnlyClient = Pick<Client, 'getListingsItem' | 'validateListing'>

/** The only client methods the proof may call: the read and Amazon's VALIDATION_PREVIEW. */
export const PROOF_CALLS: ReadonlySet<string> = new Set(['getListingsItem', 'validateListing'])

/** The client as the proof sees it: every method but the read and the preview throws, and nothing is sent. */
export function previewOnlyClient(client: object): PreviewOnlyClient {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      if (!PROOF_CALLS.has(String(property))) {
        return () => { throw new Error(`refused: ${String(property)} — the offer-merge proof only reads the offer and asks Amazon for a VALIDATION_PREVIEW; it never sends a patch.`) }
      }
      return value.bind(target)
    },
  }) as PreviewOnlyClient
}

/** Run `work` in a transaction that PostgreSQL itself keeps read-only: a write inside it fails. */
export async function inReadOnlyTransaction<T>(db: { $transaction: (work: (tx: any) => Promise<any>) => Promise<any> }, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    return work(tx)
  }) as Promise<T>
}

export interface OfferMergeProofInput {
  sellerId: string
  sku: string
  /** The Nexus market code (IT) and its Amazon marketplace id. */
  market: string
  marketplaceId: string
  productType: string
  /** What Nexus stores for the listing, read by the script in a read-only transaction. */
  stored: Record<string, unknown>
  /** Each price sender's offer instance for a price: the queue's (`buildAmazonListingPatch`), the pricing engine's. */
  senders: Array<{ name: string; buildOffer: (price: number) => Record<string, unknown> | Promise<Record<string, unknown>> }>
  client: PreviewOnlyClient
  print: (text: string) => void
}

export interface OfferMergeProofResult {
  read: 'ok' | 'failed'
  livePrice: number | null
  plans: Array<{ sender: string; plan: AmazonPriceOfferPlan }>
  previews: Array<{ senders: string[]; patch: unknown; answer: unknown }>
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

export async function runOfferMergeProof(input: OfferMergeProofInput): Promise<OfferMergeProofResult> {
  const { sellerId, sku, market, marketplaceId, productType, client, print } = input
  const result: OfferMergeProofResult = { read: 'ok', livePrice: null, plans: [], previews: [] }
  print(`Listing ${sku} on Amazon ${market} (${marketplaceId}), seller ${sellerId}, product type ${productType}.`)
  print(`\n1. Stored in Nexus (read-only transaction):\n${json(input.stored)}`)

  const live = await readAmazonOfferLive({ sellerId, sku, marketplaceId }, client)
  if (live.read === 'failed') {
    result.read = 'failed'
    print(`\n2. The live read FAILED: ${live.error}. Nothing else was done.`)
    return result
  }
  print(`\n2. Live purchasable_offer, verbatim (every instance Amazon returned):\n${json(live.instances)}`)
  if (live.productType && live.productType !== productType.toUpperCase()) print(`   (Amazon's own product type is ${live.productType}.)`)

  const standard = live.instances.find((x) => (x.marketplace_id == null || x.marketplace_id === marketplaceId) && String(x.audience ?? 'ALL').toUpperCase() === 'ALL')
  const schedule = (standard?.our_price as Array<{ schedule?: Array<{ value_with_tax?: unknown; value?: unknown }> }> | undefined)?.[0]?.schedule?.[0]
  const livePrice = Number(schedule?.value_with_tax ?? schedule?.value)
  if (!standard || !Number.isFinite(livePrice)) {
    print('\n3. No priced offer for all buyers (audience ALL) in this market: there is no live price to replay. Nothing was sent.')
    return result
  }
  result.livePrice = livePrice
  print(`\n3. Current live price ${livePrice} — replayed unchanged, so even a real send would change nothing.`)

  const previewed = new Map<string, OfferMergeProofResult['previews'][number]>()
  for (const sender of input.senders) {
    const plan = amazonPriceOfferPlan({ built: await sender.buildOffer(livePrice), live: live.instances, marketplaceId, saleRemoved: false })
    result.plans.push({ sender: sender.name, plan })
    if (plan.kind === 'first-offer') { print(`\n   ${sender.name}: no live instance in this market — ON would send the old replace. No merge to preview.`); continue }
    if (plan.kind === 'refused') { print(`\n   ${sender.name}: ON would refuse — ${plan.reason}`); continue }
    print(`\n   ${sender.name}: with the switch ON it would send exactly:\n${json({ productType, patches: [plan.patch] })}`)
    const key = JSON.stringify(plan.patch)
    const seen = previewed.get(key)
    if (seen) { seen.senders.push(sender.name); continue }
    previewed.set(key, { senders: [sender.name], patch: plan.patch, answer: null })
  }

  for (const preview of previewed.values()) {
    const answer = await client.validateListing({ sellerId, sku, marketplaceId, productType, patches: [preview.patch as { op: string; path: string; value?: unknown }] })
    preview.answer = answer
    result.previews.push(preview)
    print(`\n4. Amazon VALIDATION_PREVIEW of that merge (${preview.senders.join(' + ')}) — validated, NOT saved:`)
    print(`   available=${answer.available} ok=${answer.ok} status=${answer.status ?? '—'}`)
    print(`   errors: ${answer.errors ?? 'none'}`)
    print(`   warnings: ${answer.warnings.length ? json(answer.warnings) : 'none'}`)
    if (answer.issues?.length) print(`   issues:\n${json(answer.issues)}`)
  }
  print('\nNothing was saved in Nexus or on Amazon.')
  return result
}
