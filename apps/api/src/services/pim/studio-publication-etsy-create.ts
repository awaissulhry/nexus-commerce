/**
 * E3 (Etsy publisher, 2026-10-06) — create a NEW Etsy listing as a draft (Owner D1), then send the rest of it and read
 * it back. Owner D2: at stock 0 the draft is still created (the POST says quantity 1, Etsy refuses 0; the inventory PUT
 * then sends each variation's real stock). "Active" is refused until photos can be sent (E4).
 *
 * Order: the defences → the studio's claim (draft rows ensured, the "creating" marker written on the main row: from here
 * on a second create of this listing is refused) → the journal → createDraftListing, ONCE → the listing id stored on
 * every family row of this business at once (`landed`) → wait (Etsy is not read-your-writes) → the inventory, each
 * attribute and each translation through E2's step engine (`sendEtsySteps`) → the read-back.
 *
 * The POST is never repeated: Etsy has no idempotency key, so a second POST makes a second draft (R1 §11). The write
 * client never retries a POST, and nothing here does either. When its outcome is unknown (no answer, Etsy answering 5xx,
 * an answer without a listing number, or a listing number Nexus could not store), the marker stays open and the
 * publication is UNVERIFIED: Mark as checked looks for the draft on Etsy and links it, or clears the marker when Etsy
 * holds none. Only a clear refusal — Etsy's 4xx or its rate limit (nothing applied), the gateway's hold, the form's own
 * checks — removes the marker: Etsy made nothing.
 */
import { ETSY_NEW_ACTIVE_NEEDS_PHOTO } from '@nexus/shared/listing-actions'
import type { StudioPublishResult } from '@nexus/shared/studio-publication'
import { logger } from '../../utils/logger.js'
import { getEtsyPublishMode } from '../etsy-publish-gate.service.js'
import { createEtsyDraftListing } from '../etsy/listing-write.service.js'
import { readEtsyLive } from '../live-read/etsy.js'
import { andList } from './studio-publication-etsy-build.js'
import { etsyReadBackMismatches } from './studio-publication-etsy-changes.js'
import { etsyFieldLabel, stripNothingSent } from './studio-publication-etsy-problems.js'
import { DEFAULT_READ_BACK_DELAY_MS, ETSY_CREATE_PATH, ETSY_SEND_DISABLED, etsyNotSent, etsyStepWarnings, sendEtsySteps, stepLabel } from './studio-publication-etsy-send.js'
import { ETSY_LISTING_FIELDS, type EtsyCompiled, type EtsyCreateHooks, type EtsyLiveListing, type EtsySendReceipt, type EtsySendStep } from './studio-publication-etsy-types.js'

/** The create's outcome is unknown and Etsy gave no listing number: what the person does next. */
export const ETSY_CREATE_UNKNOWN = 'Etsy gave no clear answer to the create, so Nexus does not know whether Etsy made the draft. Nexus will not create a second one: in Publish history, open this publish and choose Mark as checked — Nexus first looks for the draft in this shop\'s Etsy drafts and links it.'
export const ETSY_NOT_A_CREATE = 'This is not a new Etsy listing. Review again.'
export const ETSY_CREATE_NO_FIELDS = 'This Etsy request does not say which fields it writes. Review again.'
export const ETSY_CREATE_NO_NUMBER = 'Etsy answered the create without a listing number.'

const textOf = (error: unknown) => error instanceof Error ? error.message : String(error)
/** A sentence ends with its full stop (an error text may not). */
const sentence = (text: string) => { const trimmed = text.trim(); return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.` }

/**
 * The POST threw: did Etsy perhaps make the draft? By the error's name (the gateway module is not loaded here):
 * - no answer at all, or Etsy answering 5xx: unknown — it may have made it;
 * - anything else answered or held before Etsy applied anything: Etsy's 4xx, its rate limit (429: nothing applied, the
 *   gateway's own rule), the gateway's refusal (gated, dry run, sign-in), the form's checks, the account or token load.
 */
function lostAnswer(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  if (error.name === 'GatewayNoAnswer') return 'Etsy did not answer the create.'
  const status = (error as { status?: unknown }).status
  if (error.name === 'EtsyWriteError' && typeof status === 'number' && status >= 500) return `Etsy answered the create with HTTP ${status}.`
  return null
}

/** A hook whose own failure must not hide what happened on Etsy: logged, never thrown. */
async function quietly(what: string, reviewId: string, step: () => Promise<void>): Promise<void> {
  try { await step() } catch (error) { logger.error(`[etsy] create: the "${what}" record could not be written`, { reviewId, error: textOf(error) }) }
}

/**
 * Create one compiled NEW Etsy listing as a draft, then send its inventory, attributes and translations, and read it
 * back. Throws (tagged `notSent`) only when Etsy made nothing; otherwise returns the receipt, whatever happened.
 */
export async function sendEtsyCreate(plan: EtsyCompiled, accountId: string, reviewId: string, hooks: EtsyCreateHooks,
  options: { readBackDelayMs?: number } = {}): Promise<EtsySendReceipt> {
  // 1 — defences: the review and the claim refuse each of these first.
  if (getEtsyPublishMode() !== 'live') etsyNotSent(ETSY_SEND_DISABLED)
  const calls = plan.request?.calls ?? []
  const post = calls[0]
  if (plan.listingId || plan.request?.operation !== 'createDraftListing' || !post || post.method !== 'POST' || post.path !== ETSY_CREATE_PATH || !post.body || !plan.create)
    return etsyNotSent(ETSY_NOT_A_CREATE)
  if (plan.create.state !== 'draft') etsyNotSent(ETSY_NEW_ACTIVE_NEEDS_PHOTO)
  if (calls.some(call => !call.fields?.length)) etsyNotSent(ETSY_CREATE_NO_FIELDS)

  // 2 — the claim: draft rows ensured and the marker written, before anything is sent (a throw: nothing was sent).
  try { await hooks.claim({ reviewId, title: plan.values.title ?? '', skus: plan.inventory.products.map(product => product.sku ?? '').filter(Boolean) }) }
  catch (error) { return etsyNotSent(textOf(error)) }

  // 3 — the POST, journalled first, made at most once.
  const ledger = { productId: plan.ownerProductId, triggeredBy: 'api' as const }
  const steps: EtsySendStep[] = calls.map(call => ({ label: stepLabel(plan, call), fields: [...(call.fields ?? [])], outcome: 'not-sent' }))
  const form = post.body
  try { await hooks.beforeSend({ operation: 'createDraftListing', method: 'POST', path: post.path, encoding: post.encoding, body: form, fields: [...steps[0].fields] }) }
  catch (error) {
    await quietly('release', reviewId, () => hooks.release())
    return etsyNotSent(textOf(error))
  }
  const outcomeUnknown = async (message: string, state: string | null): Promise<EtsySendReceipt> => {
    steps[0].outcome = 'unknown'
    steps[0].message = message
    await quietly('unknown', reviewId, () => hooks.unknown(message))
    logger.warn('[etsy] create: the outcome is unknown', { reviewId, message })
    return { reference: '', verified: false, steps, mismatches: [], created: { listingId: null, state }, createUnknown: message }
  }
  let answer: { listingId: string | null; state: string | null }
  try {
    // Ticking Automatic renewal in the review (its fee is said there) is the person's yes to Etsy's renewal fee.
    answer = await createEtsyDraftListing({ accountId, form, acceptAutoRenewCharge: form.should_auto_renew === true, ledger })
  } catch (error) {
    const lost = lostAnswer(error)
    if (lost) return outcomeUnknown(lost, null)
    // Etsy made nothing: the marker goes (a marker whose publication FAILED is stale anyway).
    await quietly('release', reviewId, () => hooks.release())
    return etsyNotSent(textOf(error))
  }
  if (!answer.listingId) return outcomeUnknown(ETSY_CREATE_NO_NUMBER, answer.state)
  const listingId = answer.listingId
  steps[0].outcome = 'applied'
  const created = { listingId, state: answer.state }

  // 4 — the listing id on every family row of this business, at once; the marker cleared. Nothing more is sent without it.
  try { await hooks.landed(listingId) }
  catch (error) {
    const message = `Etsy created listing ${listingId}, but Nexus could not record it: ${sentence(stripNothingSent(textOf(error)))}`
    await quietly('unknown', reviewId, () => hooks.unknown(message, listingId))
    logger.warn('[etsy] create: the new listing id could not be stored', { reviewId, listingId })
    return { reference: listingId, verified: false, steps, mismatches: [], created, createUnknown: message }
  }

  // 5 — the rest, once Etsy's reads can see the new draft, through E2's step engine (each journalled, none repeated). The
  // POST counts as applied, so nothing after it turns the create into "not sent".
  const delay = options.readBackDelayMs ?? DEFAULT_READ_BACK_DELAY_MS
  const wait = () => delay > 0 ? new Promise<void>(resolve => setTimeout(resolve, delay)) : Promise.resolve()
  const later = calls.map(call => ({ ...call, path: call.path.split('{listing_id}').join(listingId) }))
  const mismatches: string[] = []
  await wait()
  await sendEtsySteps(plan, later, steps, 1, { accountId, listingId, ledger, mismatches, readBackDelayMs: options.readBackDelayMs,
    beforeSend: hooks.beforeSend, operation: 'createDraftListing', create: true })

  // 6 — the read-back. A field Etsy's read never reports (production partners) is named as sent but unconfirmed.
  await wait()
  let after: EtsyLiveListing | null = null, readBackError: string | undefined
  try { after = await readEtsyLive({ accountId, listingId }) }
  catch (error) { readBackError = `Nexus could not read the new draft back from Etsy: ${stripNothingSent(textOf(error))}` }
  const applied = new Set(steps.filter(step => step.outcome === 'applied').flatMap(step => step.fields))
  const unconfirmed = after ? ETSY_LISTING_FIELDS.filter(field => applied.has(field) && after!.unread[field]).map(etsyFieldLabel) : []
  if (after) mismatches.push(...etsyReadBackMismatches(plan, applied, after, { skipUnread: true }))
  const state = after?.state ?? created.state
  if (state && state !== 'draft') mismatches.push(`Etsy reports this new listing as ${state}, not as a draft.`)
  const verified = steps.every(step => step.outcome === 'applied' || step.outcome === 'unchanged') && !readBackError && !mismatches.length
  if (!verified) logger.warn('[etsy] create not confirmed', { reviewId, listingId, steps: steps.map(step => `${step.outcome}:${step.fields.join('+')}`), mismatches: mismatches.length, readBackError: !!readBackError })
  return { reference: listingId, verified, steps, mismatches, created, ...(readBackError ? { readBackError } : {}), ...(unconfirmed.length ? { unconfirmed } : {}) }
}

/**
 * The publication result of one Etsy create: one entry per SKU, exactly once (the records settle matches them by SKU).
 * VERIFIED only when every step landed and the read-back matches. An unknown outcome is UNVERIFIED and holds the
 * destination: its journals are SUBMITTED (with the listing number when Etsy gave one) or UNKNOWN, never a baseline.
 */
export function etsyCreateResult(reviewId: string, plan: EtsyCompiled, receipt: EtsySendReceipt): StudioPublishResult {
  const products = plan.products.filter((product, index, all) => all.findIndex(other => other.sku === product.sku) === index)
  const reference = receipt.reference
  if (receipt.createUnknown && !reference) return { id: reviewId, status: 'UNVERIFIED', message: ETSY_CREATE_UNKNOWN, warnings: [receipt.createUnknown],
    results: products.map(product => ({ sku: product.sku, status: 'SUBMITTED', message: 'No clear answer from Etsy' })) }
  if (receipt.createUnknown) return { id: reviewId, status: 'UNVERIFIED', warnings: [receipt.createUnknown],
    message: `Etsy created draft listing ${reference}, but Nexus could not record it on this family. Nexus will not create a second one: mark this publication checked in Publish history and Nexus links listing ${reference}.`,
    results: products.map(product => ({ sku: product.sku, status: 'SUBMITTED', message: 'Created on Etsy; not recorded in Nexus', reference })) }
  const unconfirmed = receipt.unconfirmed?.length ? [`${andList(receipt.unconfirmed)}: sent; Etsy does not report them, so Nexus could not confirm them.`] : []
  if (receipt.verified) return { id: reviewId, status: 'VERIFIED', message: `Etsy created draft listing ${reference}, and the read-back matches. It is a draft: buyers cannot see it.`,
    ...(unconfirmed.length ? { warnings: unconfirmed } : {}),
    results: products.map(product => ({ sku: product.sku, status: 'VERIFIED', message: 'Read back from Etsy', reference })) }
  return { id: reviewId, status: 'UNVERIFIED', warnings: [...etsyStepWarnings(receipt), ...unconfirmed],
    message: `Etsy created draft listing ${reference}, but Nexus could not confirm every part of it. Check the draft on Etsy, mark this publication checked, then Publish again: Nexus sends only what still differs.`,
    results: products.map(product => ({ sku: product.sku, status: 'ACCEPTED', message: 'Sent to Etsy; not confirmed', reference })) }
}
