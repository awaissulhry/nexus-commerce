/**
 * E2 (Etsy publisher, 2026-10-05) — send the reviewed changes to an Etsy listing that already exists, and read them back.
 *
 * The eBay Inventory send's order (`studio-publication-ebay-inventory.ts`): the gate → a fresh read whose revision must
 * equal the review's → one write per call, in the review's order (the listing PATCH, each attribute, each translation,
 * the inventory PUT last), each journalled (`beforeSend`) before it is made → wait → read the listing back and compare.
 * Every write goes through the Etsy writers (`etsy/listing-write.service.ts`, `etsy/inventory-write.service.ts`), so
 * through the channel gateway, which follows the Etsy publish mode a second time.
 *
 * Etsy has no idempotency key, so no step is ever repeated here (the write client never retries a POST or a PATCH
 * either). A refusal before anything reached Etsy is "not sent" (FAILED, "Nothing was submitted."). After a step reached
 * Etsy, any problem stops the send and the rest is reported as not sent: a partial send is never hidden, and a step Etsy
 * gave no clear answer to is "unknown" (it may have landed). VERIFIED only when every step was applied (or Etsy already
 * held it) and the read-back shows every applied field as sent.
 *
 * A NEW listing is never created here (E3): its create is refused at the review, at the claim and here.
 */
import type { StudioPublishResult } from '@nexus/shared/studio-publication'
import { ETSY_CREATE_NOT_YET } from '@nexus/shared/publish-actions'
import { logger } from '../../utils/logger.js'
import { getEtsyPublishMode } from '../etsy-publish-gate.service.js'
import { replaceEtsyInventory } from '../etsy/inventory-write.service.js'
import type { InventoryDrift } from '../etsy/inventory.js'
import type { EtsyListingPatch } from '../etsy/listing-content.js'
import { deleteEtsyListingProperty, setEtsyListingProperty, updateEtsyListingContent, writeEtsyTranslation } from '../etsy/listing-write.service.js'
import { readEtsyLive } from '../live-read/etsy.js'
import { andList } from './studio-publication-etsy-build.js'
import { etsyInventoryReplaceBody, etsyReadBackMismatches, ETSY_LIVE_READ_NEEDED } from './studio-publication-etsy-changes.js'
import { etsyFieldLabel, stripNothingSent } from './studio-publication-etsy-problems.js'
import type { EtsyBeforeSend, EtsyCall, EtsyCompiled, EtsyLiveListing, EtsySendReceipt, EtsySendStep } from './studio-publication-etsy-types.js'

export const ETSY_SEND_DISABLED = 'Live Etsy publication was disabled.'
export const ETSY_CHANGED_AFTER_REVIEW = 'Etsy changed this listing after the review (its fields, attributes, variations, translations or state). Review again.'
/** The studio says "Nothing was submitted." before each of these, so none repeats it. */
export const ETSY_NOTHING_SELECTED = 'No fields are selected.'
export const ETSY_ALREADY_HOLDS = 'Etsy already holds these values.'
const DEFAULT_READ_BACK_DELAY_MS = 2_000

const textOf = (error: unknown) => error instanceof Error ? error.message : String(error)
/** Nothing reached Etsy: the studio stores FAILED with "Nothing was submitted." (studio-publication.service.ts). */
const notSent = (message: string): never => { throw Object.assign(new Error(stripNothingSent(message)), { notSent: true }) }

/** Etsy refuses these before it applies anything (a body it cannot take, a sign-in or a permission): the same on any attempt. */
const REFUSED_BEFORE_APPLYING: ReadonlySet<number> = new Set([400, 401, 403])

/**
 * How a step that failed AFTER its journal ended, by the error's name (the gateway module is not loaded here):
 * - no answer at all, or Etsy answering 5xx or 429: unknown — it may have landed;
 * - a PUT or a DELETE: the write client repeats it once after no answer (write-client.ts, `maxTransientRetries: 1`) and
 *   the error does not say whether it did, so its 4xx may answer a repeat of a call that already landed (E2 review m3).
 *   A DELETE answered 404 is "already gone": applied, and the read-back checks it. Any other 4xx is unknown, except a
 *   refusal Etsy makes before applying anything (`REFUSED_BEFORE_APPLYING`), which the first attempt got too;
 * - a POST or a PATCH is never repeated, so Etsy's 4xx answers the only attempt: refused, as is anything else thrown.
 */
function afterJournal(method: EtsyCall['method'], error: unknown): { outcome: 'applied' | 'unknown' | 'refused'; message?: string } {
  if (!(error instanceof Error)) return { outcome: 'refused' }
  if (error.name === 'GatewayNoAnswer') return { outcome: 'unknown', message: 'Etsy did not answer.' }
  const status = (error as { status?: unknown }).status
  if (error.name !== 'EtsyWriteError' || typeof status !== 'number') return { outcome: 'refused' }
  if (status >= 500 || status === 429) return { outcome: 'unknown', message: `Etsy answered HTTP ${status}.` }
  if (method !== 'PUT' && method !== 'DELETE') return { outcome: 'refused' }
  if (method === 'DELETE' && status === 404) return { outcome: 'applied', message: 'Etsy no longer holds it (HTTP 404).' }
  if (REFUSED_BEFORE_APPLYING.has(status)) return { outcome: 'refused' }
  return { outcome: 'unknown', message: `Etsy answered HTTP ${status}, possibly to a repeat of a call it had already applied.` }
}

/** The change field a single-field call writes, e.g. `property:200` → 200. */
const propertyIdOf = (field: string) => /^property:(\d+)$/.test(field) ? Number(field.slice(9)) : null

/** A step in the review's words: the fields of the PATCH, an attribute's name, a translation, the variations. */
function stepLabel(plan: EtsyCompiled, call: EtsyCall, fresh: EtsyLiveListing): string {
  const fields = call.fields ?? []
  if (call.method === 'PATCH') return andList(fields.map(etsyFieldLabel))
  const field = fields[0] ?? ''
  const id = propertyIdOf(field)
  if (id !== null) return plan.properties.find(property => property.property_id === id)?.property_name
    ?? fresh.properties.find(property => property.property_id === id)?.property_name ?? `Property ${id}`
  if (field.startsWith('translation:')) return `Translation (${field.slice(12)})`
  return etsyFieldLabel(field)
}

/** One read-back difference of the inventory writer, in plain words. */
function driftSentence(drift: InventoryDrift): string {
  if (drift.found === -1) return `${drift.product}: sent, but Etsy does not hold this variation now.`
  if (drift.field === 'is_enabled') return `${drift.product}: sent ${drift.sent ? 'shown' : 'hidden'}, Etsy holds it ${drift.found ? 'shown' : 'hidden'}.`
  return `${drift.product}: ${drift.field === 'quantity' ? 'stock' : 'price'} sent ${drift.sent}, Etsy holds ${drift.found}.`
}

/**
 * Send one compiled Etsy publication (a listing Etsy holds) and read it back. Throws (tagged `notSent`) only when
 * nothing reached Etsy; otherwise returns the receipt, whatever happened.
 */
export async function sendEtsyPublication(plan: EtsyCompiled, accountId: string, reviewId: string, beforeSend: EtsyBeforeSend,
  options: { readBackDelayMs?: number } = {}): Promise<EtsySendReceipt> {
  // 1 — defences: the review and the claim refuse each of these first.
  if (getEtsyPublishMode() !== 'live') notSent(ETSY_SEND_DISABLED)
  const listingId = plan.listingId
  if (!listingId) return notSent(ETSY_CREATE_NOT_YET)
  const calls = plan.request?.calls ?? []
  if (!calls.length) notSent(ETSY_NOTHING_SELECTED)
  if (!plan.liveRevision) notSent(ETSY_LIVE_READ_NEEDED)

  // 2 — Etsy now, by the review's own measure: its revision leaves stock and the sold-out flip out (live-read/etsy.ts),
  // so only a change someone made to the listing refuses the send.
  let fresh: EtsyLiveListing
  try { fresh = await readEtsyLive({ accountId, listingId }) }
  catch (error) { return notSent(`Nexus could not read the Etsy listing just before sending: ${textOf(error)}`) }
  if (fresh.revision !== plan.liveRevision) notSent(ETSY_CHANGED_AFTER_REVIEW)

  // 3 — one write per call, in order, each journalled first; never repeated.
  const ledger = { productId: plan.ownerProductId, triggeredBy: 'api' as const }
  const steps: EtsySendStep[] = calls.map(call => ({ label: stepLabel(plan, call, fresh), fields: [...(call.fields ?? [])], outcome: 'not-sent' }))
  const mismatches: string[] = []
  for (const [index, call] of calls.entries()) {
    const step = steps[index]
    /** The method journalled for this step (a translation's is chosen by the writer's GET): from then on, a failure may have reached Etsy. */
    let journalled: EtsyCall['method'] | null = null
    const journal = async (method: EtsyCall['method'], body: Record<string, unknown> | null) => {
      await beforeSend({ operation: 'updateListing', method, path: call.path, encoding: call.encoding, body, fields: [...step.fields] })
      journalled = method
    }
    try {
      step.outcome = await sendStep(plan, call, step.fields, { accountId, listingId, ledger, journal, mismatches, readBackDelayMs: options.readBackDelayMs })
    } catch (error) {
      const ended = journalled ? afterJournal(journalled, error) : { outcome: 'refused' as const }
      step.outcome = ended.outcome
      step.message = ended.message ?? stripNothingSent(textOf(error))
      // Applied after all (a DELETE of what is already gone): the send goes on.
      if (ended.outcome === 'applied') continue
      // Nothing reached Etsy yet: the whole publication is not sent.
      if (ended.outcome === 'refused' && !steps.some(other => other.outcome === 'applied' || other.outcome === 'unknown')) notSent(textOf(error))
      break
    }
  }
  if (steps.every(step => step.outcome === 'unchanged')) notSent(ETSY_ALREADY_HOLDS)

  // 4 — the read-back, once Etsy's read can show the writes (it is not read-your-writes, etsy/inventory-write.service.ts).
  let readBackError: string | undefined
  const delay = options.readBackDelayMs ?? DEFAULT_READ_BACK_DELAY_MS
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
  try {
    const after = await readEtsyLive({ accountId, listingId })
    mismatches.push(...etsyReadBackMismatches(plan, new Set(steps.filter(step => step.outcome === 'applied').flatMap(step => step.fields)), after))
  } catch (error) {
    readBackError = `Nexus could not read the listing back from Etsy: ${stripNothingSent(textOf(error))}`
  }
  const verified = steps.every(step => step.outcome === 'applied' || step.outcome === 'unchanged') && !readBackError && !mismatches.length
  if (!verified) logger.warn('[etsy] studio publication not confirmed', { reviewId, listingId, steps: steps.map(step => `${step.outcome}:${step.fields.join('+')}`), mismatches: mismatches.length, readBackError: !!readBackError })
  return { reference: listingId, verified, steps, mismatches, ...(readBackError ? { readBackError } : {}) }
}

interface StepContext {
  accountId: string
  listingId: string
  ledger: { productId: string; triggeredBy: 'api' }
  journal: (method: EtsyCall['method'], body: Record<string, unknown> | null) => Promise<void>
  mismatches: string[]
  readBackDelayMs?: number
}

/** One call, by the writer its fields name. Resolves `applied`, or `unchanged` when Etsy already held it; throws otherwise. */
async function sendStep(plan: EtsyCompiled, call: EtsyCall, fields: string[], context: StepContext): Promise<'applied' | 'unchanged'> {
  const { accountId, listingId, ledger, journal } = context
  const field = fields[0]
  if (!field) throw new Error('This Etsy request does not say which fields it writes. Review again.')

  // The listing's own fields: one PATCH; ticking Automatic renewal in the review is the person's yes to Etsy's fee.
  if (call.method === 'PATCH') {
    const body = call.body ?? {}
    await journal('PATCH', body)
    await updateEtsyListingContent({ accountId, listingId, content: { listing: body as EtsyListingPatch, acceptAutoRenewCharge: body.should_auto_renew === true }, ledger })
    return 'applied'
  }

  // An attribute: set as the review showed it, or removed (a Full update; Nexus holds none).
  const propertyId = propertyIdOf(field)
  if (propertyId !== null) {
    if (call.method === 'DELETE') {
      await journal('DELETE', null)
      await deleteEtsyListingProperty({ accountId, listingId, propertyId, ledger })
      return 'applied'
    }
    const property = plan.properties.find(entry => entry.property_id === propertyId)
    if (!property || call.method !== 'PUT') throw new Error(`Property ${propertyId}: Nexus holds no value to send. Review again.`)
    await journal('PUT', call.body)
    await setEtsyListingProperty({ accountId, listingId, property: { propertyId, valueIds: [...property.value_ids], values: [...property.values], scaleId: property.scale_id }, ledger })
    return 'applied'
  }

  // A translation: the writer asks Etsy whether it holds the language (GET) and journals the method that answer chose.
  if (field.startsWith('translation:')) {
    const code = field.slice(12)
    const translation = plan.translations.find(entry => entry.language === code)
    if (!translation?.title || !translation.description) throw new Error(`${code} translation: Etsy needs a title and a description. Review again.`)
    await writeEtsyTranslation({ accountId, listingId, ledger, translation: { language: code, title: translation.title, description: translation.description, tags: [...translation.tags] },
      beforeSend: (method, form) => journal(method, form) })
    return 'applied'
  }

  // The variations: built under the listing lock from Etsy's fresh inventory; Etsy's own price, stock and on/off kept.
  if (field === 'inventory') {
    const result = await replaceEtsyInventory({ accountId, listingId, ledger, readBackDelayMs: context.readBackDelayMs, priceCurrency: plan.currency ?? undefined,
      build: current => {
        const out = etsyInventoryReplaceBody(plan, current)
        if ('refusal' in out) throw new Error(out.refusal)
        return out.body
      },
      beforeSend: body => journal('PUT', body as unknown as Record<string, unknown>) })
    if (!result.sent) return 'unchanged'
    if (result.drift === null) context.mismatches.push('The variations could not be read back.')
    else context.mismatches.push(...result.drift.map(driftSentence))
    return 'applied'
  }
  throw new Error(`${field}: Nexus does not send this to Etsy. Review again.`)
}

/**
 * The publication result of one Etsy send: one entry per journalled SKU, exactly once (the records settle matches them
 * by SKU). VERIFIED only on a matching read-back; anything else is UNVERIFIED, which holds the destination until a person
 * checks Etsy and marks the publication checked (journals are SUBMITTED: no baseline is written from an unconfirmed send).
 */
export function etsyPublicationResult(reviewId: string, plan: EtsyCompiled, receipt: EtsySendReceipt): StudioPublishResult {
  const reference = receipt.reference
  const products = plan.products.filter((product, index, all) => all.findIndex(other => other.sku === product.sku) === index)
  if (receipt.verified) return { id: reviewId, status: 'VERIFIED', message: `Etsy took the change to listing ${reference}, and the read-back matches.`,
    results: products.map(product => ({ sku: product.sku, status: 'VERIFIED', message: 'Read back from Etsy', reference })) }
  const labels = (outcome: EtsySendStep['outcome']) => receipt.steps.filter(step => step.outcome === outcome).map(step => step.label)
  const applied = labels('applied'), unchanged = labels('unchanged'), notSentAfter = labels('not-sent')
  const confirmed = !receipt.readBackError && !receipt.mismatches.length
  const warnings = [
    ...(applied.length ? [`${confirmed ? 'Sent and confirmed' : 'Sent'}: ${andList(applied)}.`] : []),
    ...(unchanged.length ? [`Etsy already held: ${andList(unchanged)}.`] : []),
    ...receipt.steps.filter(step => step.outcome === 'refused').map(step => `Not sent: ${step.label} — ${step.message ?? 'refused'}`),
    ...receipt.steps.filter(step => step.outcome === 'unknown').map(step => `Not confirmed by Etsy: ${step.label} — ${step.message ?? 'no clear answer.'} It may have landed.`),
    ...(notSentAfter.length ? [`Not sent after that: ${andList(notSentAfter)}.`] : []),
    ...receipt.mismatches,
    ...(receipt.readBackError ? [receipt.readBackError] : []),
  ]
  return { id: reviewId, status: 'UNVERIFIED', warnings,
    message: `Etsy took part of this change, or Nexus could not confirm it. Check listing ${reference} on Etsy, mark this publication checked, then Publish again: Nexus sends only what still differs.`,
    results: products.map(product => ({ sku: product.sku, status: 'ACCEPTED', message: 'Sent to Etsy; not confirmed', reference })) }
}
