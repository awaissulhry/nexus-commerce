/**
 * Amazon sheet gaps (gaps 1–3) — THE write door of an Amazon listing's fulfilment settings: the handling time
 * (`lead_time_to_ship_max_days`), the restock date and "always available" (`is_inventory_available`), kept at
 * `platformAttributes.amazonFulfillment.*` (`amazonOfferLivePath`) and sent inside `fulfillment_availability` by the stock
 * job, which replaces that whole root (`buildAmazonListingPatch`, job lane — it re-sends what this door stores).
 *
 *   - Amazon keeps ONE fulfilment entry per SKU across the EU markets, so a write on one EU listing lands on every open EU
 *     row of the SKU on the account (`shared-inventory-targets.ts`, the Matrix's group), each under its own compare-and-set
 *     on `ChannelListing.version`. The whole call is one transaction: a conflict or a refusal writes nothing.
 *   - FBA (fail-closed evidence, `isFbaCoordinate` with FBA stock and an active FBA offer): Amazon ships, the settings do
 *     not apply — any FBA target → nothing written. A parent has no offer of its own → refused.
 *   - Then ONE QUANTITY_UPDATE per SKU group re-sends the quantity Nexus holds with the new settings, queued like every
 *     quantity push (`coalescePendingQuantityRows`, `createOutboundRow`, `fireOutboundJobs` after commit). A paused listing
 *     → saved, with ONE held row that `reassertAmazonFulfilment` sends on resume; a still-draft → saved, Publish sends it.
 *   - The old sheet value of each written leaf (`overrideData`, never sent) is removed in the same transaction; an audit
 *     row per listing and leaf; `listing.values_changed` (`fulfilmentSettings`) after COMMIT.
 *   - `tx`: run inside the caller's transaction (the jobs fire and the hint is published after its commit).
 */
import type { Prisma } from '@prisma/client'
import { assertPushAllowed, isStillDraftListing } from '@nexus/shared/push-lock'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import prisma from '../../db.js'
import { afterDatabaseCommit } from '../../lib/database-context.js'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
import { logger } from '../../utils/logger.js'
import { loadAmazonSendQuantity } from '../amazon/send-quantity.js'
import {
  FBA_FULFILMENT_REASON, FULFILMENT_LEAVES, amazonOfferKeysOf, amazonOfferLeafRefusal, amazonOfferLivePath, type AmazonOfferLeaf,
} from '../amazon/offer-fields.js'
import { amazonOfferValuesEqual } from '../amazon/offer-draft.js'
import { announceListingValues } from '../listing-values-events.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'
import { createOutboundRow } from '../outbound-rows.js'
import { coalescePendingQuantityRows } from '../sync-coalesce.js'
import { heldSentence } from './follower-price.js'
import { PARENT_REASON } from './matrix-cells.js'
import { loadSharedInventoryTargets } from './shared-inventory-targets.js'

export type AmazonFulfilmentLeaf = 'lead_time_to_ship_max_days' | 'restock_date' | 'is_inventory_available'
export interface AmazonFulfilmentSettings {
  /** Whole days, 0–120. `null` = removed on Amazon. */
  lead_time_to_ship_max_days?: number | null
  /** YYYY-MM-DD, today or later. `null` = removed on Amazon. */
  restock_date?: string | null
  is_inventory_available?: boolean | null
}

/** The reasons a fulfilment-settings write may run with no version guard: a closed set, as the price door's. */
export type FulfilmentSettingsUnguardedReason =
  /** Publish's promotion: Amazon accepted the published settings, Nexus records them as live and re-sends once. */
  | 'publish-accepted'

export type FulfilmentSettingsTarget =
  | { listingId: string; expectedVersion: number; unguardedReason?: never }
  | { listingId: string; expectedVersion?: never; unguardedReason: FulfilmentSettingsUnguardedReason }

export interface FulfilmentSettingsResult {
  outcome: 'applied' | 'noop' | 'refused' | 'conflict'
  reason?: string
  /** Every row written (each target and its EU group), at its new version. */
  written: Array<{ listingId: string; marketplace: string; version: number }>
  /** The QUANTITY_UPDATE rows queued: one per SKU group. */
  queueIds: string[]
  /** Saved but not sent now, and why (paused, a draft, a closed offer, no quantity). */
  notSent?: string
  /** A conflict: the listing that moved, at its current version (0 = gone). */
  conflict?: { listingId: string; version: number }
}

/** The payload source of the rows this door queues (and of the held row a paused listing waits with). */
export const FULFILMENT_RESEND_SOURCE = 'AMAZON_FULFILMENT_SETTINGS'
/** The held row of a paused listing: never dispatched (SKIPPED), sent by `reassertAmazonFulfilment` on resume. Its own
 * code, so the queue's retention sweep can keep it at any age (`NOT_HELD_FULFILMENT_ROW`), as it keeps a held price. */
export const HELD_FULFILMENT_CODE = 'FULFILMENT_HELD_PAUSED'
const HELD_FULFILMENT_ROWS = {
  syncType: 'QUANTITY_UPDATE', syncStatus: 'SKIPPED', errorCode: HELD_FULFILMENT_CODE,
  payload: { path: ['source'], equals: FULFILMENT_RESEND_SOURCE },
} satisfies Prisma.OutboundSyncQueueWhereInput
/** A `where` for every queue row that is NOT a held fulfilment settings change (the retention sweep). Spelled
 * positively, like `NOT_HELD_PRICE_ROW`: SQL's `!=` is unknown on a null `errorCode`. */
export const NOT_HELD_FULFILMENT_ROW = {
  OR: [{ syncType: { not: 'QUANTITY_UPDATE' } }, { syncStatus: { not: 'SKIPPED' } }, { errorCode: null }, { errorCode: { not: HELD_FULFILMENT_CODE } }],
} satisfies Prisma.OutboundSyncQueueWhereInput
/** The same 30 s operator grace window as every quantity push. */
const RESEND_HOLD_MS = 30 * 1000
const WORDS: Readonly<Record<AmazonFulfilmentLeaf, string>> = {
  lead_time_to_ship_max_days: 'handling time', restock_date: 'restock date', is_inventory_available: 'always available',
}
const MATRIX_CHANGED = MATRIX_COPY.changedElsewhere
const ONLY_AMAZON = 'Only an Amazon listing has a handling time, a restock date or always available'

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

/** The value Nexus's own store holds for a live offer leaf (`amazonOfferLivePath`), as stored; `undefined` = none stored. */
export function storedAmazonLiveLeaf(platformAttributes: unknown, leaf: AmazonOfferLeaf): unknown {
  const path = amazonOfferLivePath(leaf)
  if (!path) return undefined
  const root = record(record(platformAttributes)?.[path[0]])
  return root && Object.prototype.hasOwnProperty.call(root, path[1]) ? root[path[1]] : undefined
}

/**
 * The platformAttributes bag with these live offer leaves written at EXACTLY `amazonOfferLivePath(leaf)` (`null` kept:
 * cleared). Everything else in the bag is kept. The live-leaf writer of both doors (this one and the price door's `offer`).
 */
export function withAmazonLiveLeaves(platformAttributes: unknown, writes: ReadonlyArray<{ leaf: AmazonOfferLeaf; value: unknown }>): Record<string, unknown> {
  const pa = { ...(record(platformAttributes) ?? {}) }
  for (const w of writes) {
    const path = amazonOfferLivePath(w.leaf)
    if (!path) throw new Error(`${w.leaf} is kept in the listing's price columns, not in platformAttributes`)
    pa[path[0]] = { ...(record(pa[path[0]]) ?? {}), [path[1]]: w.value }
  }
  return pa
}

/** The leaves' words for a sentence: "The handling time and restock date". */
const what = (leaves: readonly AmazonFulfilmentLeaf[]): string => {
  const w = leaves.map((l) => WORDS[l])
  const list = w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`
  return list === 'always available' ? 'Always available' : `The ${list}`
}

/** The checked settings, or the sentence that refuses them. */
function checkSettings(settings: AmazonFulfilmentSettings, today: string): { values: Array<{ leaf: AmazonFulfilmentLeaf; value: number | string | boolean | null }> } | { refusal: string } {
  const values: Array<{ leaf: AmazonFulfilmentLeaf; value: number | string | boolean | null }> = []
  for (const [key, raw] of Object.entries(settings ?? {})) {
    if (!(FULFILMENT_LEAVES as readonly string[]).includes(key)) return { refusal: `${key} is not a fulfilment setting (handling time, restock date, always available)` }
    if (raw === undefined) continue
    const leaf = key as AmazonFulfilmentLeaf
    const value = typeof raw === 'string' ? raw.trim() : raw
    if (leaf === 'restock_date' && typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { refusal: 'A restock date is YYYY-MM-DD' }
    const problem = amazonOfferLeafRefusal(leaf, value, today)
    if (problem) return { refusal: problem }
    values.push({ leaf, value: value as number | string | boolean | null })
  }
  return { values }
}

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, channelConnectionId: true, aliasKey: true, version: true,
  syncPaused: true, offerClosedAt: true, listingStatus: true, isPublished: true, externalListingId: true, quantity: true,
  fulfillmentMethod: true, platformAttributes: true, overrideData: true,
  product: { select: { sku: true, isParent: true, fulfillmentMethod: true } },
} satisfies Prisma.ChannelListingSelect
type Row = Prisma.ChannelListingGetPayload<{ select: typeof LISTING_SELECT }>
type Db = Prisma.TransactionClient

/** The rows among these that Amazon fulfils (FBA) — fail closed: any signal counts (`isFbaCoordinate`). */
async function fbaRowIds(db: Db, rows: readonly Row[]): Promise<Set<string>> {
  const productIds = [...new Set(rows.map((r) => r.productId))]
  const [stock, offers] = await Promise.all([
    db.stockLevel.findMany({
      where: { productId: { in: productIds }, OR: [{ location: { type: 'AMAZON_FBA' } }, { location: { code: 'AMAZON-EU-FBA' } }] },
      select: { productId: true, quantity: true },
    }),
    db.offer.findMany({ where: { channelListingId: { in: rows.map((r) => r.id) }, fulfillmentMethod: 'FBA', isActive: true }, select: { channelListingId: true } }),
  ])
  const fbaStock = new Map<string, number>()
  for (const s of stock) fbaStock.set(s.productId, (fbaStock.get(s.productId) ?? 0) + s.quantity)
  const offered = new Set(offers.map((o) => o.channelListingId))
  return new Set(rows.filter((r) => isFbaCoordinate(r, r.product, { fbaStockQty: fbaStock.get(r.productId) ?? 0, hasActiveFbaOffer: offered.has(r.id) })).map((r) => r.id))
}

type QueuedRow = { id: string; productId: string | null; syncType: string; holdUntil: Date | null }

/**
 * ONE QUANTITY_UPDATE re-sending the quantity Nexus holds for this listing, in the caller's transaction: the stock job
 * reads the listing's live facts when it sends, so the settings stored now go with it. Null + why when there is no
 * quantity to send.
 */
async function queueResend(db: Db, l: Row, input: { settings: Record<string, unknown>; actor: string; reason: string | null }): Promise<{ row: QueuedRow | null; notSent?: string }> {
  let quantity = typeof l.quantity === 'number' ? l.quantity : null
  if (quantity == null) {
    const sent = await loadAmazonSendQuantity(db as never, { listingId: l.id })
    if (sent.quantity == null) return { row: null, notSent: sent.refusal ?? 'No quantity was worked out for this listing.' }
    quantity = sent.quantity
  }
  await coalescePendingQuantityRows(db, [l.id])
  const row = await createOutboundRow(db, {
    data: {
      productId: l.productId, channelListingId: l.id, targetChannel: 'AMAZON' as never, targetRegion: l.region,
      syncStatus: 'PENDING' as never, syncType: 'QUANTITY_UPDATE', holdUntil: new Date(Date.now() + RESEND_HOLD_MS),
      externalListingId: l.externalListingId, maxRetries: 3,
      payload: { source: FULFILMENT_RESEND_SOURCE, productId: l.productId, channel: 'AMAZON', marketplace: l.marketplace, quantity, settings: input.settings, actor: input.actor, reason: input.reason } as Prisma.InputJsonValue,
    },
    select: { id: true, productId: true, syncType: true, holdUntil: true },
  })
  return { row }
}

class Abort extends Error {
  constructor(readonly result: FulfilmentSettingsResult) { super(result.reason ?? result.outcome) }
}

export async function setAmazonFulfilmentSettings(input: {
  targets?: FulfilmentSettingsTarget[]
  /** Shorthand for `targets` with one unguarded reason. */
  listingIds?: string[]
  unguardedReason?: FulfilmentSettingsUnguardedReason
  settings: AmazonFulfilmentSettings
  actor: string
  /** The audit sentence prefix; the door appends what changed. */
  reason?: string
  tx?: Prisma.TransactionClient
}): Promise<FulfilmentSettingsResult> {
  const empty = (over: Partial<FulfilmentSettingsResult>): FulfilmentSettingsResult => ({ outcome: 'refused', written: [], queueIds: [], ...over })
  const targets: Array<{ listingId: string; expectedVersion?: number; unguardedReason?: FulfilmentSettingsUnguardedReason }> =
    [...(input.targets ?? []), ...(input.listingIds ?? []).map((listingId) => ({ listingId, unguardedReason: input.unguardedReason }))]
  if (targets.length === 0) return empty({ outcome: 'noop' })
  if (targets.some((t) => t.expectedVersion === undefined && !t.unguardedReason)) {
    return empty({ reason: 'A fulfilment settings write needs the listing version it was read at, or a named reason it has none' })
  }
  const checked = checkSettings(input.settings, new Date().toISOString().slice(0, 10))
  if ('refusal' in checked) return empty({ reason: checked.refusal })
  const settings = checked.values
  if (settings.length === 0) return empty({ outcome: 'noop' })
  const publishAccepted = targets.some((t) => t.unguardedReason === 'publish-accepted')
  const changedLeaves = settings.map((s) => s.leaf)

  const queued: QueuedRow[] = []
  const run = <T,>(work: (tx: Db) => Promise<T>): Promise<T> => (input.tx ? work(input.tx) : prisma.$transaction(work))
  let result: FulfilmentSettingsResult
  try {
    result = await run(async (db) => {
      const primaries = await db.channelListing.findMany({ where: { id: { in: [...new Set(targets.map((t) => t.listingId))] } }, select: LISTING_SELECT })
      const byId = new Map(primaries.map((r) => [r.id, r]))
      // Each target and its EU group, deduplicated (two markets of one SKU name the same group).
      const groups: Array<{ primary: Row; members: Row[] }> = []
      const rows = new Map<string, Row>()
      const versions = new Map<string, number>()
      for (const t of targets) {
        const p = byId.get(t.listingId)
        if (!p) throw new Abort(empty({ outcome: 'conflict', reason: MATRIX_CHANGED, conflict: { listingId: t.listingId, version: 0 } }))
        if (p.channel !== 'AMAZON') throw new Abort(empty({ reason: ONLY_AMAZON }))
        if (p.product?.isParent) throw new Abort(empty({ reason: PARENT_REASON }))
        if (t.expectedVersion !== undefined && t.expectedVersion !== p.version) {
          throw new Abort(empty({ outcome: 'conflict', reason: MATRIX_CHANGED, conflict: { listingId: p.id, version: p.version } }))
        }
        if (groups.some((g) => g.members.some((m) => m.id === p.id))) continue
        const picked = await loadSharedInventoryTargets(db, { ...p, marketplace: String(p.marketplace), version: t.expectedVersion ?? p.version })
        if ('conflict' in picked) throw new Abort(empty({ outcome: 'conflict', reason: MATRIX_CHANGED, conflict: { listingId: p.id, version: picked.conflict } }))
        if (picked.targets.length === 0) throw new Abort(empty({ reason: assertPushAllowed(p)?.sentence ?? 'This market offer is closed. Restore the offer before sending changes.' }))
        const missing = picked.targets.filter((x) => !rows.has(x.id) && !byId.has(x.id)).map((x) => x.id)
        const loaded = missing.length ? await db.channelListing.findMany({ where: { id: { in: missing } }, select: LISTING_SELECT }) : []
        for (const r of [...primaries, ...loaded]) if (picked.targets.some((x) => x.id === r.id)) rows.set(r.id, r)
        for (const x of picked.targets) versions.set(x.id, x.version)
        groups.push({ primary: p, members: picked.targets.map((x) => rows.get(x.id)).filter((r): r is Row => !!r) })
      }
      // In the groups' market order (IT, DE, FR, ES, …), each row once.
      const all = [...new Map(groups.flatMap((g) => g.members).map((r) => [r.id, r])).values()]
      if (all.some((r) => r.product?.isParent)) throw new Abort(empty({ reason: PARENT_REASON }))
      // Any FBA target → nothing written: these settings apply only to orders the seller ships.
      if ((await fbaRowIds(db, all)).size > 0) throw new Abort(empty({ reason: FBA_FULFILMENT_REASON }))

      // Every row FOR UPDATE, and its version checked, BEFORE the first write: a conflict writes nothing — also inside a
      // caller's transaction, which this door cannot roll back.
      const locked = await db.$queryRaw<Array<{ id: string; version: number }>>`SELECT id, version FROM "ChannelListing" WHERE id = ANY(${all.map((r) => r.id)}::text[]) FOR UPDATE`
      const lockedVersion = new Map(locked.map((x) => [x.id, Number(x.version)]))
      for (const r of all) {
        if (lockedVersion.get(r.id) !== (versions.get(r.id) ?? r.version)) {
          throw new Abort(empty({ outcome: 'conflict', reason: MATRIX_CHANGED, conflict: { listingId: r.id, version: lockedVersion.get(r.id) ?? 0 } }))
        }
      }

      const written: FulfilmentSettingsResult['written'] = []
      const sentence = (leaf: AmazonFulfilmentLeaf, before: unknown, after: unknown) =>
        `${WORDS[leaf]} ${before == null ? '—' : String(before)} → ${after == null ? '—' : String(after)}`
      for (const r of all) {
        const changes = settings.filter((s) => {
          const stored = storedAmazonLiveLeaf(r.platformAttributes, s.leaf)
          return !(stored !== undefined && amazonOfferValuesEqual(s.leaf, stored, s.value))
        })
        if (changes.length === 0) continue
        const version = versions.get(r.id) ?? r.version
        const guarded = await db.channelListing.updateMany({
          where: { id: r.id, version },
          data: { platformAttributes: withAmazonLiveLeaves(r.platformAttributes, changes) as Prisma.InputJsonValue, version: { increment: 1 } },
        })
        // Held FOR UPDATE above, so this cannot miss; if it ever does, the transaction must fail, not half-apply.
        if (guarded.count !== 1) throw new Error(`amazon-fulfilment-settings: listing ${r.id} moved while locked`)
        // The old sheet value of each written leaf (saved in `overrideData`, never sent) goes in the same transaction.
        const bag = record(r.overrideData) ?? {}
        const stale = changes.flatMap((c) => amazonOfferKeysOf(c.leaf)).filter((k) => Object.prototype.hasOwnProperty.call(bag, k))
        if (stale.length) await db.$executeRaw`UPDATE "ChannelListing" SET "overrideData" = COALESCE("overrideData", '{}'::jsonb) - ${stale}::text[] WHERE id = ${r.id}`
        const why = [input.reason, changes.map((c) => sentence(c.leaf, storedAmazonLiveLeaf(r.platformAttributes, c.leaf), c.value)).join(' · ')].filter(Boolean).join(': ')
        for (const c of changes) {
          const before = storedAmazonLiveLeaf(r.platformAttributes, c.leaf)
          await db.channelListingOverride.create({ data: {
            channelListingId: r.id, fieldName: amazonOfferLivePath(c.leaf)!.join('.'),
            previousValue: before == null ? null : String(before), newValue: c.value == null ? null : String(c.value), reason: why, changedBy: input.actor,
          } })
        }
        written.push({ listingId: r.id, marketplace: String(r.marketplace), version: version + 1 })
      }
      if (written.length === 0 && !publishAccepted) return empty({ outcome: 'noop' })

      // ONE re-send per SKU group, from the listing that was named (else the group's first open row).
      const notSent: string[] = []
      const sent = Object.fromEntries(settings.map((s) => [s.leaf, s.value]))
      for (const g of groups) {
        const l = g.members.find((m) => m.id === g.primary.id) ?? g.members[0]
        if (!l) continue
        if (isStillDraftListing(l)) { notSent.push(heldSentence({ ...l, syncPaused: false }, what(changedLeaves))); continue }
        if (l.syncPaused) {
          // Paused: ONE held row, replacing any earlier one, sent once on resume (`reassertAmazonFulfilment`).
          await db.outboundSyncQueue.updateMany({ where: { ...HELD_FULFILMENT_ROWS, channelListingId: l.id }, data: { syncStatus: 'CANCELLED', errorMessage: 'Replaced by a newer fulfilment settings change' } })
          await createOutboundRow(db, { data: {
            productId: l.productId, channelListingId: l.id, targetChannel: 'AMAZON' as never, targetRegion: l.region, syncStatus: 'SKIPPED' as never,
            syncType: 'QUANTITY_UPDATE', holdUntil: null, externalListingId: l.externalListingId, maxRetries: 0, errorCode: HELD_FULFILMENT_CODE,
            errorMessage: 'Held: this listing\'s sync is paused. Sent when it resumes.',
            payload: { source: FULFILMENT_RESEND_SOURCE, productId: l.productId, channel: 'AMAZON', marketplace: l.marketplace, settings: sent, actor: input.actor, reason: input.reason ?? null } as Prisma.InputJsonValue,
          }, select: { id: true } })
          notSent.push(heldSentence(l, what(changedLeaves)))
          continue
        }
        const lock = assertPushAllowed(l)
        if (lock) { notSent.push(`${what(changedLeaves)} is saved in Nexus. Nothing was sent: ${lock.sentence}`); continue }
        const resend = await queueResend(db, l, { settings: sent, actor: input.actor, reason: input.reason ?? null })
        if (resend.row) queued.push(resend.row)
        else notSent.push(`${what(changedLeaves)} is saved in Nexus and goes with the next quantity push: ${resend.notSent}`)
      }
      return { outcome: written.length ? 'applied' : 'noop', written, queueIds: queued.map((q) => q.id), ...(notSent.length ? { notSent: notSent.join(' ') } : {}) }
    })
  } catch (error) {
    if (error instanceof Abort) return error.result
    throw error
  }
  // After commit (inside a caller's transaction: after ITS commit): the instant lane honours each row's hold.
  if (queued.length) await afterDatabaseCommit(`amazon-fulfilment:${queued.map((q) => q.id).join(',')}`, () => fireOutboundJobs(queued, { source: FULFILMENT_RESEND_SOURCE }))
  if (result.written.length) announceListingValues(result.written.map((w) => w.listingId), ['fulfilmentSettings'], 'fulfilment-settings')
  logger.info('amazon-fulfilment-settings: written', { actor: input.actor, outcome: result.outcome, written: result.written.length, queued: queued.length })
  return result
}

export interface FulfilmentReassertResult {
  /** Listings whose held settings were sent now (one QUANTITY_UPDATE each). */
  sent: string[]
  /** Still paused, a draft or locked another way: the held row keeps waiting. */
  stillHeld: string[]
  /** Held rows closed without a send, and why (the listing became FBA, or there is no quantity to send). */
  closed: Array<{ listingId: string; reason: string }>
}

/**
 * Send, ONCE, the fulfilment settings saved while a listing was paused (its held row): on resume — Sync Control's
 * Resume, the Matrix's resume and a pause's end time all run `recascadeAfterSyncControlChange`, which calls this beside
 * `sendHeldPrices`. A listing still paused keeps waiting. The held row is closed in the same transaction that queues the
 * re-send, under a status check, so a second run (or one racing this one) finds nothing left. Best effort: never throws.
 */
export async function reassertAmazonFulfilment(productIds: string[], actor = 'system:resume'): Promise<FulfilmentReassertResult> {
  const result: FulfilmentReassertResult = { sent: [], stillHeld: [], closed: [] }
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return result
  try {
    const held = await prisma.outboundSyncQueue.findMany({ where: { ...HELD_FULFILMENT_ROWS, channelListing: { productId: { in: ids } } }, select: { id: true, channelListingId: true, payload: true } })
    const byListing = new Map<string, typeof held>()
    for (const row of held) if (row.channelListingId) byListing.set(row.channelListingId, [...(byListing.get(row.channelListingId) ?? []), row])
    if (byListing.size === 0) return result
    const queued: QueuedRow[] = []
    for (const listingId of byListing.keys()) {
      const rows = byListing.get(listingId)!
      const outcome = await prisma.$transaction(async (db) => {
        const l = await db.channelListing.findUnique({ where: { id: listingId }, select: LISTING_SELECT })
        if (!l) return { kind: 'closed' as const, reason: 'The listing no longer exists.' }
        if (l.syncPaused || isStillDraftListing(l) || assertPushAllowed(l)) return { kind: 'held' as const }
        const close = (why: string) => db.outboundSyncQueue.updateMany({ where: { id: { in: rows.map((r) => r.id) }, syncStatus: 'SKIPPED' }, data: { syncStatus: 'CANCELLED', errorMessage: why } })
        if ((await fbaRowIds(db, [l])).size > 0) { await close(`Not sent: ${FBA_FULFILMENT_REASON}`); return { kind: 'closed' as const, reason: FBA_FULFILMENT_REASON } }
        // Taken by another run in the gap: nothing left to send.
        if ((await close('Sent: the listing resumed')).count === 0) return { kind: 'gone' as const }
        const latest = record(rows[rows.length - 1]?.payload)
        const resend = await queueResend(db, l, { settings: record(latest?.settings) ?? {}, actor, reason: 'Held fulfilment settings sent: the listing resumed' })
        if (!resend.row) {
          const reason = resend.notSent ?? 'No quantity was worked out for this listing.'
          await db.outboundSyncQueue.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { errorMessage: `Not sent: ${reason}` } })
          return { kind: 'closed' as const, reason }
        }
        queued.push(resend.row)
        return { kind: 'sent' as const }
      })
      if (outcome.kind === 'sent') result.sent.push(listingId)
      else if (outcome.kind === 'held') result.stillHeld.push(listingId)
      else if (outcome.kind === 'closed') result.closed.push({ listingId, reason: outcome.reason })
    }
    if (queued.length) await fireOutboundJobs(queued, { source: FULFILMENT_RESEND_SOURCE })
  } catch (error) {
    logger.warn('held fulfilment settings: send failed; they keep waiting for the next run', { error: error instanceof Error ? error.message : String(error) })
  }
  if (result.sent.length || result.closed.length) logger.info('held fulfilment settings sent', { actor, sent: result.sent.length, closed: result.closed.length, stillHeld: result.stillHeld.length })
  return result
}
