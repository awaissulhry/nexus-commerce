/**
 * E3 — the "creating" marker of a new Etsy listing (spec §4.3; decision §6 Q1 = A: a `platformAttributes` key on the main
 * row, written and cleared by atomic jsonb SQL, no migration).
 *
 * Etsy's createDraftListing has no idempotency key: a POST whose answer was lost may or may not have made a draft, and a
 * second POST makes a second one (R1 §11). So before the POST, in one locked step, the family's main Etsy row records
 * that a create is under way (`_etsyCreate`: the publish, when, the title and SKUs sent). While it stands, no second
 * create of this listing starts — the review shows it (`ETSY_CREATE_OPEN`) and the claim refuses it (`claimEtsyCreate`,
 * a compare-and-set under the row lock). It ends one of three ways:
 * - Etsy answered with a listing id → `storeEtsyCreatedListing` links it on every family row and removes the marker, in one
 *   transaction (the go-live write of a create: the rows become a DRAFT listing, kept inert);
 * - Etsy clearly made nothing (a refusal before or by Etsy) → `releaseEtsyCreate` removes it;
 * - the outcome is unknown → `markEtsyCreateUnknown` keeps it, with why (and Etsy's id when one was answered), until a
 *   person's **Mark as checked** on that publish runs `resolveEtsyCreateOnCheck`: it links the id Etsy answered (kept on
 *   the marker, or in the publication's stored result), or looks in this shop's Etsy drafts and links exactly one match
 *   no other Nexus row holds; it clears the marker on none — but only once `ETSY_CREATE_SETTLE_MS` (15 minutes) have
 *   passed since the create started, because Etsy is not read-your-writes and a draft made seconds ago may not be listed
 *   yet — and it refuses on several, too early, or when Etsy cannot be read (the publication stays open and the person
 *   can try again).
 *
 * Every write names the main row exactly (Etsy, this product, market, account and alias) and runs as one SQL statement
 * under the business's row-level security; an unknown or release touches only its own publish's marker (`reviewId`).
 * Each bumps the row's `version`, so an open review of the family is stale and a stale sheet save refuses. A marker a
 * copy carried to another row (an alias copy, a catalogue transfer) names another destination, and a marker whose
 * publish FAILED (or was never sent) is stale: both are ignored and a new claim overwrites them.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { EtsyReadError } from '../etsy/read-client.js'
import { etsyListingReads, findEtsyDrafts } from '../live-read/etsy.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import type { EtsyCreateMarkerInput } from './studio-publication-etsy-types.js'
import { ETSY_STATE_TO_LISTING_STATUS } from '../../jobs/etsy-content-refresh.job.js'

export const ETSY_CREATE_MARKER_KEY = '_etsyCreate'
/**
 * How long after a create started Mark as checked may conclude that Etsy holds nothing from it (an empty draft search, or
 * a 404 for the id Etsy answered) and clear the marker. Etsy is not read-your-writes (the send itself waits before its
 * read-back), and a create whose answer was lost may still be finishing on Etsy's side: clearing earlier would let the
 * next Publish make a second draft. Linking a draft that IS found never waits.
 */
export const ETSY_CREATE_SETTLE_MS = 15 * 60_000
export interface EtsyCreateMarker { v: 1; state: 'creating' | 'unknown'; reviewId: string; startedAt: string; title: string; skus: string[]
  userId: string | null; listingId?: string; message?: string }
/** The main row of the listing: the family's owner product at this Etsy market, account and alias. */
export interface EtsyCreateWhere { marketplace: string; accountId: string; aliasKey: string; ownerProductId: string }

type Json = Record<string, any>
type Client = Pick<Prisma.TransactionClient, 'bulkOperation'>
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const isListingId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** A jsonb value as the driver hands it back: parsed already, or (some adapters) as its text. */
const bagOf = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** PURE — the marker a row's `platformAttributes` holds, or null (none, or not one Nexus wrote: never guessed at). */
export function etsyCreateMarkerOf(platformAttributes: unknown): EtsyCreateMarker | null {
  const raw = obj(obj(bagOf(platformAttributes))[ETSY_CREATE_MARKER_KEY])
  if (raw.v !== 1 || (raw.state !== 'creating' && raw.state !== 'unknown')) return null
  if (typeof raw.reviewId !== 'string' || !raw.reviewId || typeof raw.startedAt !== 'string' || !Number.isFinite(Date.parse(raw.startedAt))) return null
  if (typeof raw.title !== 'string' || !Array.isArray(raw.skus) || !raw.skus.every((sku: unknown) => typeof sku === 'string')) return null
  if (raw.userId !== null && raw.userId !== undefined && typeof raw.userId !== 'string') return null
  if (raw.listingId !== undefined && !isListingId(raw.listingId)) return null
  return { v: 1, state: raw.state, reviewId: raw.reviewId, startedAt: raw.startedAt, title: raw.title, skus: [...raw.skus], userId: raw.userId ?? null,
    ...(raw.listingId !== undefined ? { listingId: raw.listingId } : {}), ...(typeof raw.message === 'string' ? { message: raw.message } : {}) }
}

/** The marker stands unless its publish was never sent or failed (nothing reached Etsy), or it names another destination. */
async function openMarker(client: Client, where: EtsyCreateWhere, listing: { platformAttributes?: unknown; externalListingId?: string | null } | undefined)
  : Promise<{ marker: EtsyCreateMarker; sending: boolean } | null> {
  if (!listing || listing.externalListingId) return null
  const marker = etsyCreateMarkerOf(listing.platformAttributes)
  if (!marker) return null
  const publication = await client.bulkOperation.findFirst({ where: { id: marker.reviewId },
    select: { status: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true } })
  // Not found (another business's id, or a row since removed): the marker still stands — refusing a create is the safe side.
  if (!publication) return { marker, sending: false }
  if (publication.status === 'FAILED' || publication.status === 'PREVIEW') return null
  if (publication.productId !== where.ownerProductId || publication.channel !== 'ETSY' || publication.marketplace !== where.marketplace
    || publication.channelConnectionId !== where.accountId || (publication.aliasKey ?? '') !== where.aliasKey) return null
  return { marker, sending: publication.status === 'PUBLISHING' }
}

/**
 * The open marker of this destination's main row (as the review read it), or null: no marker, the row already has an
 * Etsy listing id, or the marker is stale (its publish FAILED or was never sent, or it names another destination).
 * `sending` = its publish is being sent right now.
 */
export async function openEtsyCreateMarker(where: EtsyCreateWhere, listing: { platformAttributes?: unknown; externalListingId?: string | null } | undefined)
  : Promise<{ marker: EtsyCreateMarker; sending: boolean } | null> {
  return openMarker(prisma, where, listing)
}

/** "2026-10-05 14:03 UTC" */
const utcMinute = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`

export const ETSY_CREATE_OPEN = (open: { marker: EtsyCreateMarker; sending: boolean }): string => open.sending
  ? 'A create of this Etsy listing is being sent now. Wait for its result before you publish again.'
  : open.marker.listingId
    ? `A create of this Etsy listing started on ${utcMinute(open.marker.startedAt)}; Etsy answered with listing ${open.marker.listingId}, but Nexus did not finish recording it. Nexus will not create a second one: in Publish history, open that publish and choose Mark as checked — Nexus reads that listing on Etsy and links it.`
    : `A create of this Etsy listing started on ${utcMinute(open.marker.startedAt)} and Nexus did not see Etsy's answer, so Etsy may already hold it as a draft. Nexus will not create a second one: in Publish history, open that publish and choose Mark as checked — Nexus first looks for the draft on Etsy and links it.`

interface MainRow { id: string; externalListingId: string | null; platformAttributes: unknown }

/** The main row, locked for this transaction (FOR UPDATE): one claim, link or check of it at a time. */
async function lockMainRow(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, where: EtsyCreateWhere): Promise<MainRow | null> {
  const rows = await tx.$queryRaw<MainRow[]>`
    SELECT id, "externalListingId", "platformAttributes" FROM "ChannelListing"
    WHERE channel = 'ETSY' AND "productId" = ${where.ownerProductId} AND marketplace = ${where.marketplace}
      AND "channelConnectionId" = ${where.accountId} AND "aliasKey" = ${where.aliasKey}
    FOR UPDATE`
  return rows[0] ?? null
}

/**
 * Before the POST, in one transaction under the main row's lock: refuse when the row is missing, already holds an Etsy
 * listing id, or holds an open marker; otherwise write `{ v: 1, state: 'creating', reviewId, startedAt: now, title, skus,
 * userId }` under `_etsyCreate` and bump the row's version. A throw = nothing was sent (every sentence says so).
 */
export async function claimEtsyCreate(where: EtsyCreateWhere, input: EtsyCreateMarkerInput & { userId: string | null }): Promise<void> {
  if (typeof input.reviewId !== 'string' || !input.reviewId || typeof input.title !== 'string'
    || !Array.isArray(input.skus) || !input.skus.every(sku => typeof sku === 'string')) throw new Error('This create names no publish, title or SKUs to record. Nothing was sent.')
  const marker: EtsyCreateMarker = { v: 1, state: 'creating', reviewId: input.reviewId, startedAt: new Date().toISOString(), title: input.title,
    skus: [...input.skus], userId: typeof input.userId === 'string' ? input.userId : null }
  await prisma.$transaction(async tx => {
    const row = await lockMainRow(tx, where)
    if (!row) throw new Error('The main row of this Etsy listing has no listing record here. Nothing was sent.')
    if (row.externalListingId) throw new Error('This Etsy listing already has a listing number in Nexus. Review again. Nothing was sent.')
    const bag = bagOf(row.platformAttributes)
    if (bag !== null && bag !== undefined && (typeof bag !== 'object' || Array.isArray(bag)))
      throw new Error('The Etsy data on the main row cannot be read, so Nexus cannot record this create. Nothing was sent.')
    const open = await openMarker(tx, where, { platformAttributes: bag, externalListingId: null })
    if (open) throw new Error(`${ETSY_CREATE_OPEN(open)} Nothing was sent.`)
    await tx.$executeRaw`
      UPDATE "ChannelListing"
      SET "platformAttributes" = (CASE WHEN jsonb_typeof("platformAttributes") = 'object' THEN "platformAttributes" ELSE '{}'::jsonb END)
            || jsonb_build_object('_etsyCreate', ${JSON.stringify(marker)}::jsonb),
          "version" = "version" + 1,
          "updatedAt" = now()
      WHERE id = ${row.id}`
  })
}

/**
 * The POST's outcome is unknown: this publish's marker stays, as `unknown`, with why and Etsy's listing id when one was
 * answered. When the marker is gone (a whole-bag writer replaced the bag) and Etsy did answer an id, a new `unknown`
 * marker carrying that id is written under the row lock — only while the row has no listing id and no other publish's
 * marker — so Mark as checked can still link it and no second create starts. Throws when nothing could be kept (the
 * caller logs it; the publication's stored result still names the id).
 */
export async function markEtsyCreateUnknown(where: EtsyCreateWhere, reviewId: string, message: string, listingId?: string): Promise<void> {
  const patch = { state: 'unknown', message: String(message ?? ''), ...(isListingId(listingId) ? { listingId } : {}) }
  const count = await updateUnknown(where, reviewId, patch)
  if (count === 1) return
  if (!isListingId(listingId)) throw new Error(`The Etsy create marker of publish ${reviewId} is not on the main row, so Nexus could not keep its unknown outcome.`)
  await prisma.$transaction(async tx => {
    const row = await lockMainRow(tx, where)
    if (!row) throw new Error(`The main row of this Etsy listing has no listing record here, so Nexus could not keep Etsy listing ${listingId}.`)
    if (row.externalListingId === listingId) return
    if (row.externalListingId) throw new Error(`This Etsy listing already has listing number ${row.externalListingId} in Nexus, so Nexus did not keep Etsy listing ${listingId} on it.`)
    const present = etsyCreateMarkerOf(row.platformAttributes)
    if (present && present.reviewId !== reviewId) throw new Error(`Another create (publish ${present.reviewId}) is recorded on this Etsy listing, so Nexus did not keep Etsy listing ${listingId} on it.`)
    if (present) {
      if (await updateUnknown(where, reviewId, patch, tx) === 1) return
      throw new Error(`The Etsy create marker of publish ${reviewId} could not be updated, so Nexus could not keep Etsy listing ${listingId} on it.`)
    }
    const fresh: EtsyCreateMarker = { v: 1, state: 'unknown', reviewId, startedAt: new Date().toISOString(), title: '', skus: [], userId: null,
      listingId, message: patch.message }
    await tx.$executeRaw`
      UPDATE "ChannelListing"
      SET "platformAttributes" = (CASE WHEN jsonb_typeof("platformAttributes") = 'object' THEN "platformAttributes" ELSE '{}'::jsonb END)
            || jsonb_build_object('_etsyCreate', ${JSON.stringify(fresh)}::jsonb),
          "version" = "version" + 1,
          "updatedAt" = now()
      WHERE id = ${row.id}`
  })
}

/** The jsonb merge of `patch` into this publish's own marker (never another publish's). Returns the rows changed (0 or 1). */
function updateUnknown(where: EtsyCreateWhere, reviewId: string, patch: Record<string, unknown>, client: Pick<Prisma.TransactionClient, '$executeRaw'> = prisma): Promise<number> {
  return client.$executeRaw`
    UPDATE "ChannelListing"
    SET "platformAttributes" = jsonb_set("platformAttributes", '{_etsyCreate}', ("platformAttributes"->'_etsyCreate') || ${JSON.stringify(patch)}::jsonb),
        "version" = "version" + 1,
        "updatedAt" = now()
    WHERE channel = 'ETSY' AND "productId" = ${where.ownerProductId} AND marketplace = ${where.marketplace}
      AND "channelConnectionId" = ${where.accountId} AND "aliasKey" = ${where.aliasKey}
      AND "platformAttributes"->'_etsyCreate'->>'reviewId' = ${reviewId}`
}

/** Etsy clearly made nothing: this publish's marker is removed (another publish's never is). Repeating it changes nothing. */
export async function releaseEtsyCreate(where: EtsyCreateWhere, reviewId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "ChannelListing"
    SET "platformAttributes" = "platformAttributes" - '_etsyCreate',
        "version" = "version" + 1,
        "updatedAt" = now()
    WHERE channel = 'ETSY' AND "productId" = ${where.ownerProductId} AND marketplace = ${where.marketplace}
      AND "channelConnectionId" = ${where.accountId} AND "aliasKey" = ${where.aliasKey}
      AND "platformAttributes"->'_etsyCreate'->>'reviewId' = ${reviewId}`
}

/**
 * The go-live write of a create, in one transaction under the main row's lock: Etsy listing `listingId` (the draft this
 * publish made) goes on every family row at this destination that has no listing id yet (`productIds` = the claim's
 * delivered products) as a listing kept inert — the status Etsy's state maps to by the 4-hourly refresh's own table
 * (`etsyState`, default `draft` → `DRAFT`, what Etsy answers a create with), `isPublished` false for a draft (true for a
 * listing Etsy already shows, inactive or ended), and `syncPaused: true` (no push reaches it; E4's activation lifts it) —
 * and this publish's marker is removed. Only this business's rows of this account (the workspace client and the
 * account's own id).
 *
 * The marker is NOT required: when a whole-bag writer replaced the bag between the claim and Etsy's answer, the id Etsy
 * answered is still linked (losing it would let the next Publish make a second draft). Refused (nothing written) when:
 * ANOTHER publish's marker is on the row (another create is recorded); a family row here already holds another listing
 * id (a family is one Etsy listing — never split); any other row of this account holds `listingId` (ids never link
 * twice); Etsy's state has no Nexus status. A repeat of a link that already happened writes nothing and returns 0.
 * Returns the number of rows linked.
 */
export async function storeEtsyCreatedListing(where: EtsyCreateWhere, input: { reviewId: string; productIds: string[]; listingId: string
  etsyState?: string | null }): Promise<number> {
  const { listingId, reviewId } = input
  if (!isListingId(listingId)) throw new Error(`"${String(listingId)}" is not an Etsy listing number; Nexus linked nothing.`)
  const etsyState = typeof input.etsyState === 'string' && input.etsyState.trim() ? input.etsyState.trim() : 'draft'
  const listingStatus = Object.prototype.hasOwnProperty.call(ETSY_STATE_TO_LISTING_STATUS, etsyState) ? ETSY_STATE_TO_LISTING_STATUS[etsyState] : null
  if (!listingStatus) throw new Error(`Etsy reports listing ${listingId} as "${etsyState}", a state Nexus has no status for; Nexus did not link it.`)
  const productIds = [...new Set([where.ownerProductId, ...(input.productIds ?? []).filter((id): id is string => typeof id === 'string' && id !== '')])]
  const destination = { channel: 'ETSY', marketplace: where.marketplace, channelConnectionId: where.accountId, aliasKey: where.aliasKey }
  const linked = await prisma.$transaction(async tx => {
    const row = await lockMainRow(tx, where)
    if (!row) throw new Error(`The main row of this Etsy listing has no listing record here; Nexus did not link listing ${listingId}.`)
    const marker = etsyCreateMarkerOf(row.platformAttributes)
    const repeat = row.externalListingId === listingId
    if (row.externalListingId && !repeat)
      throw new Error(`This Etsy listing already has listing number ${row.externalListingId} in Nexus; Nexus did not link listing ${listingId}.`)
    if (!repeat && marker && marker.reviewId !== reviewId)
      throw new Error(`Another create (publish ${marker.reviewId}) is recorded on this Etsy listing; Nexus did not link listing ${listingId}. Review again.`)
    const elsewhere = await tx.channelListing.findFirst({ where: { channel: 'ETSY', channelConnectionId: where.accountId, externalListingId: listingId,
      NOT: { productId: { in: productIds }, marketplace: where.marketplace, aliasKey: where.aliasKey } }, select: { id: true } })
    if (elsewhere) throw new Error(`Etsy listing ${listingId} is already linked to another product in Nexus; Nexus did not link it again.`)
    const split = await tx.channelListing.findFirst({ where: { ...destination, productId: { in: productIds }, externalListingId: { not: null },
      NOT: { externalListingId: listingId } }, select: { externalListingId: true } })
    if (split) throw new Error(`A product of this family is already on Etsy listing ${split.externalListingId}; Nexus did not link listing ${listingId}.`)
    const stored = await tx.channelListing.updateMany({ where: { ...destination, productId: { in: productIds }, externalListingId: null },
      data: { externalListingId: listingId, listingStatus, isPublished: listingStatus !== 'DRAFT', syncPaused: true, version: { increment: 1 } } })
    await tx.$executeRaw`
      UPDATE "ChannelListing"
      SET "platformAttributes" = "platformAttributes" - '_etsyCreate',
          "version" = "version" + 1,
          "updatedAt" = now()
      WHERE id = ${row.id} AND "platformAttributes"->'_etsyCreate'->>'reviewId' = ${reviewId}`
    return { count: stored.count, repeat }
  })
  if (!linked.repeat && linked.count < productIds.length) {
    logger.warn('studio publication: an Etsy create linked fewer family rows than it delivered', { reviewId, listingId, linked: linked.count, delivered: productIds.length })
  }
  return linked.count
}

/** What Mark as checked can still say about a create, or why it cannot decide (a 409: the publication stays open). */
const refuse = (sentence: string) => new WorkspaceScopeError(sentence, 409)
/** "18:15 UTC" */
const utcTime = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`

/** The account cannot be used now (signed out, revoked, deleted, or not an Etsy shop any more): no read can answer. */
function accountUnusable(error: unknown): boolean {
  const named = error as { name?: unknown; code?: unknown; message?: unknown } | null
  if (named?.name === 'ConnectionNeedsReauth') return true
  if (named?.name === 'GatewayRefusal' && (named.code === 'ACCOUNT_NEEDS_SIGNIN' || named.code === 'ACCOUNT_NOT_FOUND')) return true
  return typeof named?.message === 'string' && /ChannelConnection not found|The selected account is not Etsy|no verified shop identity/.test(named.message)
}
/** Why Etsy could not be asked, as the 409 says it. */
function lookFailed(error: unknown): WorkspaceScopeError {
  // The search could not prove whether one of its drafts still exists (live-read/etsy.ts `EtsyDraftUnconfirmed`): said as is.
  if ((error as { name?: unknown } | null)?.name === 'EtsyDraftUnconfirmed') return refuse(message(error))
  if (accountUnusable(error)) return refuse(`This Etsy account cannot be used in Nexus right now (${message(error)}), so Nexus cannot look for the draft on Etsy. Reconnect the account, then mark this publication checked again.`)
  return refuse(`Nexus could not look for the draft on Etsy (${message(error)}), so it cannot tell whether Etsy holds one. Try again in a while.`)
}

/**
 * The listing id the publication's stored result names ONLY in the "created on Etsy, not recorded in Nexus" outcome
 * (`etsyCreateResult` with `createUnknown` and a reference: status UNVERIFIED, every product SUBMITTED with that one
 * reference) — never from an ordinary sent-but-unconfirmed result (ACCEPTED rows: the id WAS stored then, and a person
 * may have unlinked it since), a verified one, or a create with no answer (no reference). Else null.
 */
function resultListingId(data: Record<string, any>): string | null {
  const result = obj(data.result)
  const rows = Array.isArray(result.results) ? (result.results as unknown[]).map(obj) : []
  if (result.status !== 'UNVERIFIED' || !rows.length || !rows.every(entry => entry.status === 'SUBMITTED' && isListingId(entry.reference))) return null
  const ids = new Set(rows.map(entry => entry.reference as string))
  return ids.size === 1 ? [...ids][0] : null
}

/**
 * Whether a person unlinked Etsy listing `listingId` from this destination in Nexus after the create started (the
 * Listing ID control and Claude's unlink-channel-id both record it: an accepted `unlink` snapshot whose evidence names the
 * old id, identity-fix.service.ts `runUnlink`). A listing a person unlinked on purpose is never linked again here.
 */
async function unlinkedSince(where: EtsyCreateWhere, listingId: string, startedAt: number): Promise<boolean> {
  const unlink = await prisma.channelListingSnapshot.findFirst({ where: { reason: 'unlink', outcome: 'ACCEPTED', channel: 'ETSY',
    marketplace: where.marketplace, aliasKey: where.aliasKey, channelListing: { channelConnectionId: where.accountId },
    payload: { path: ['evidence', 'oldExternalListingId'], equals: listingId },
    ...(Number.isFinite(startedAt) ? { acceptedAt: { gte: new Date(startedAt) } } : {}) }, select: { id: true } })
  return !!unlink
}

/**
 * Mark as checked on an Etsy create (spec §4.3, E3 review). Null unless the publication is an Etsy create
 * (`data.etsyCreate`) and its main row holds THIS publication's marker — or holds no marker while the publication's
 * stored result is the "created on Etsy, not recorded in Nexus" outcome naming the id Etsy answered (the marker was lost:
 * the id still is not). Then:
 * - Etsy answered an id (the marker's, else that result's) → never linked again when a person unlinked it from this
 *   destination since the create started (said; the marker is cleared); else the listing must read back as this shop's,
 *   and is linked with the status its Etsy state maps to (a draft stays DRAFT and unpublished); a row already on another
 *   listing is never relinked (said, not refused). A 404 → Etsy no longer holds it: the marker is cleared, but only once
 *   `ETSY_CREATE_SETTLE_MS` have passed since the create started (before that: a 409 with the time to check again);
 * - else this shop's drafts are searched (`findEtsyDrafts`) and every candidate another Nexus row of this account already
 *   holds is dropped (an alias's own draft is never counted, linked or named): one → linked; none → the marker is cleared
 *   (again only after `ETSY_CREATE_SETTLE_MS`); several → refused, naming them.
 * Etsy unreadable (and a disconnected account, said as such) → refused. Returns the sentence for the check's note. Every
 * refusal is a 409 `WorkspaceScopeError` and leaves the publication open.
 */
export async function resolveEtsyCreateOnCheck(publicationId: string, data: Record<string, any>, now: Date = new Date()): Promise<string | null> {
  const scope = obj(data?.scope)
  if (scope.channel !== 'ETSY' || data?.etsyCreate !== true) return null
  const owner = obj(obj(data.changePlan).publication).ownerProductId ?? data.productId
  if (typeof owner !== 'string' || !owner || typeof scope.accountId !== 'string' || typeof scope.marketplace !== 'string') return null
  const where: EtsyCreateWhere = { marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: String(obj(data.delivery).aliasKey ?? ''), ownerProductId: owner }
  const row = await prisma.channelListing.findFirst({ where: { channel: 'ETSY', productId: owner, marketplace: where.marketplace,
    channelConnectionId: where.accountId, aliasKey: where.aliasKey }, select: { platformAttributes: true, externalListingId: true } })
  if (!row) return null
  const marker = etsyCreateMarkerOf(row.platformAttributes)
  const ours = marker?.reviewId === publicationId
  // Another publish's marker is that publish's to resolve; with no marker, only an id the stored result names is left to link.
  if (marker && !ours) return null
  const answered = (ours ? marker!.listingId : undefined) ?? resultListingId(data) ?? undefined
  if (!ours && (!answered || row.externalListingId === answered)) return null
  if (!ours && row.externalListingId)
    return `Etsy created listing ${answered} in this publish, but this family is already on Etsy listing ${row.externalListingId}, so Nexus did not link ${answered}. Delete listing ${answered} on Etsy if it is not needed.`
  const delivered = obj(data.delivery).productIds
  const productIds: string[] = Array.isArray(delivered) ? delivered.filter((id: unknown): id is string => typeof id === 'string') : [owner]
  const link = async (listingId: string, etsyState: string | null) => {
    try { await storeEtsyCreatedListing(where, { reviewId: publicationId, productIds, listingId, etsyState }) } catch (error) { throw refuse(message(error)) }
  }
  // When the create started: the marker's own time, else the claim's (`startedAt`). Unknown → nothing to wait for.
  const startedAt = Date.parse((ours ? marker!.startedAt : undefined) ?? (typeof data.startedAt === 'string' ? data.startedAt : ''))
  const settled = (sentence: string): void => {
    if (Number.isFinite(startedAt) && now.getTime() < startedAt + ETSY_CREATE_SETTLE_MS)
      throw refuse(`${sentence} Check again after ${utcTime(startedAt + ETSY_CREATE_SETTLE_MS)}.`)
  }

  if (answered) {
    if (await unlinkedSince(where, answered, startedAt)) {
      if (ours) await releaseEtsyCreate(where, publicationId)
      return `Etsy listing ${answered} (created by this publish) was unlinked from this family in Nexus since, so Nexus did not link it again.`
    }
    const reads = etsyListingReads(where.accountId)
    let listing: Json, shop: Json
    try {
      [listing, shop] = (await Promise.all([reads.listingPlain(answered), reads.shop()])).map(obj) as [Json, Json]
    } catch (error) {
      if (error instanceof EtsyReadError && error.status === 404) {
        settled(`Etsy does not show listing ${answered} right now: it may still be finishing, or it was deleted on Etsy.`)
        if (ours) await releaseEtsyCreate(where, publicationId)
        return `Etsy no longer holds listing ${answered} (the draft this publish created), so Nexus linked nothing; the next Publish creates the draft.`
      }
      throw lookFailed(error)
    }
    if (String(listing.listing_id ?? '') !== answered || listing.shop_id == null || shop.shop_id == null || String(listing.shop_id) !== String(shop.shop_id))
      throw refuse(`Etsy did not confirm that listing ${answered} is in this shop, so Nexus did not link it. Try again in a while.`)
    const state = typeof listing.state === 'string' && listing.state.trim() ? listing.state.trim() : null
    if (!state) throw refuse(`Etsy did not say what state listing ${answered} is in, so Nexus did not link it. Try again in a while.`)
    await link(answered, state)
    return state === 'draft'
      ? `Nexus linked Etsy listing ${answered} (the draft this publish created) to this family; the next Publish sends what it still lacks.`
      : `Nexus linked Etsy listing ${answered} (created by this publish; Etsy now reports it as ${state}) to this family, with its sync paused; the next Publish sends what it still lacks.`
  }

  let found: Awaited<ReturnType<typeof findEtsyDrafts>>
  try {
    found = await findEtsyDrafts(where.accountId, { title: marker!.title, since: marker!.startedAt, skus: marker!.skus })
  } catch (error) {
    throw lookFailed(error)
  }
  // A draft another Nexus row of this account already holds is that row's (an alias created seconds apart, with the same
  // title and SKUs): never this publish's, never linked here, never named for deletion. A draft already on this family's
  // own rows here stays (its link is a repeat).
  const held = found.length ? await prisma.channelListing.findMany({ where: { channel: 'ETSY', channelConnectionId: where.accountId,
    externalListingId: { in: found.map(draft => draft.listingId) } }, select: { externalListingId: true, productId: true, marketplace: true, aliasKey: true } }) : []
  const others = new Set(held.filter(other => !(productIds.includes(other.productId) && other.marketplace === where.marketplace && other.aliasKey === where.aliasKey))
    .map(other => other.externalListingId))
  const drafts = found.filter(draft => !others.has(draft.listingId))
  if (drafts.length > 1) {
    throw refuse(`Etsy holds ${drafts.length} drafts that match this publish (listings ${drafts.map(draft => draft.listingId).join(', ')}). Delete the extra ones on Etsy, then mark this publication checked again; Nexus then links the one left.`)
  }
  if (drafts.length === 1) {
    await link(drafts[0].listingId, 'draft')
    return `Nexus found the draft on Etsy (listing ${drafts[0].listingId}) and linked it to this family; the next Publish sends what it still lacks.`
  }
  settled('Nexus found no draft from this publish in this shop\'s Etsy drafts yet. Etsy may still be finishing this create.')
  await releaseEtsyCreate(where, publicationId)
  return 'Nexus looked in this shop\'s Etsy drafts and found none from this publish, so the next Publish creates the draft.'
}
