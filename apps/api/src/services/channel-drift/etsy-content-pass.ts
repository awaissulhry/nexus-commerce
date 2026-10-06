/**
 * E5a (Etsy publisher) — the content half of the 4-hourly Etsy sweep (`jobs/etsy-content-refresh.job.ts`): for every
 * Etsy listing Nexus knows, what Etsy holds against what Studio Publish would send, into `ChannelDrift` (source
 * `etsy-content`) through the ONE drift writer. Read only: nothing is written to Etsy, and nothing of Nexus's own —
 * no listing column, no attribute, no price, no stock (P4.3a).
 *
 * Calls, all through the account's gateway reader:
 *   · none at all when the shop has no listing Nexus knows: the pass is inert and the sweep's pages stay exactly as they
 *     were (no includes);
 *   · the listing itself rides on the sweep's own `getListingsByShop` pages (`includes=Inventory,Images,Translations`,
 *     only for the four compared states): no call of its own. A page that fails with them is read again without them
 *     (the job does; each such call is counted here as an extra call), and once Etsy REFUSES them (400/422) they are
 *     not asked for again in this run. A page read without them is still compared: its variations come from the batch
 *     read below; its images and translations were not read (not compared);
 *   · one `GET /shops/{shop}` per run (the shop's languages and currency);
 *   · one `GET /shops/{shop}/listings/{id}/properties` per compared listing (Etsy has no include for properties), at most
 *     `ETSY_PROPERTY_READS_PER_RUN` a run — over it, that listing's attributes are not compared this time;
 *   · a batch `GET /listings/batch/inventory` (≤ 100 ids) only for listings whose row came without its inventory. One id
 *     Etsy no longer has makes the whole batch 404 (R1 §16): the batch is split until the dead id stands alone.
 * A listing the review refuses (Nexus's side, or the live review's own refusals: the shop's language, a variation Etsy no
 * longer holds) costs no attributes call.
 *
 * One pass per account at a time, across processes (the cron's and a manual "Run"): a Redis lease per account, the lease
 * of lib/cron/workspace-lease.ts (`SET NX PX`, renewed every 20 s while the pass lives, released by `finish`). A pass
 * that finds it held, or no Redis, is inert for that account; the status sweep is not affected.
 *
 * The rotation is content-drift.job.ts's: never-checked listings first, then the oldest `etsy-content` read, inside a
 * 5-minute budget per account; what the budget leaves stays due for the next sweep, its clock untouched. Every listing
 * is its own try: one failure is counted and the next listing goes on. A listing that cannot be compared is recorded
 * NOT COMPARED with its reason — never as clean. Writing the same read again gives the same record (idempotent).
 */
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { RELEASE_LEASE, RENEW_LEASE } from '../../lib/cron/workspace-lease.js'
import * as drift from '../channel-drift.service.js'
import type { DriftField } from '../channel-drift.service.js'
import { normaliseEtsyListing } from '../live-read/etsy.js'
import type { etsyContentOurs, etsyNexusPhotoCount } from './etsy-content-ours.js'
import { compareEtsyContent, etsyLiveImages, etsyLiveRefusal, etsyPageRaw, ETSY_COMPARED_STATES, ETSY_CONTENT_SOURCE, ETSY_PAGE_INCLUDES,
  type EtsyContentTally } from './etsy-content-compare.js'

export const ETSY_PROPERTY_READS_PER_RUN = 100
export const ETSY_CONTENT_BUDGET_MS = 5 * 60_000
/**
 * At most this many batch inventory calls a run (splits included). The batch is only a fallback (the page normally
 * carries the inventory); the cap keeps a run that meets many dead ids inside one key's shared quota (R1 §10).
 */
export const ETSY_INVENTORY_BATCH_CALLS_PER_RUN = 25
const BATCH = 100

export const ETSY_PAGE_REFUSED = 'Etsy refused the listing details on this page, so it was read without them.'
export const ETSY_PAGE_TIMED_OUT = 'Etsy did not answer the page with the listing details in time, so it was read without them.'
export const ETSY_PAGE_FAILED = 'Etsy could not answer the page with the listing details, so it was read without them.'
export const ETSY_PASS_RUNNING = 'a content pass of this Etsy account is already running'
/** The lease: 90 s, renewed every 20 s (lib/cron/workspace-lease.ts), and never renewed past this — a pass that was never finished lets go. */
const LEASE_MS = 90_000
const RENEW_EVERY_MS = 20_000
export const ETSY_CONTENT_LEASE_MAX_MS = 30 * 60_000
/**
 * Every Redis call of the lease answers within this, or counts as failed (E5a review R2-3): the queue's client waits for
 * a lost Redis without limit, and a claim or release that waits would hold this account's status sweep.
 */
export const ETSY_LEASE_CALL_TIMEOUT_MS = 4_000
const CLAIM = `if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end`
export const etsyContentLockKey = (accountId: string) => `nexus:etsy:content-pass:${accountId}`
/** The Redis commands the lease needs; ioredis has them. */
export interface EtsyContentLockStore { status: string; eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> }
export const ETSY_NO_VARIATIONS = 'Etsy did not return this listing\'s variations.'
export const ETSY_NO_MAIN_ROW = 'no main row of this Etsy listing in Nexus'
export const ETSY_MANY_MAIN_ROWS = 'more than one Nexus listing holds this Etsy Listing ID'
export const ETSY_BUDGET_LEFT = 'the 5-minute budget ran out, left for the next sweep'

export interface EtsyContentDeps {
  ours?: typeof etsyContentOurs
  photoCount?: typeof etsyNexusPhotoCount
  record?: typeof drift.recordChannelReadback
  now?: () => number
  /** The lease's store (null = no Redis); default: the queue's Redis connection. */
  lockStore?: EtsyContentLockStore | null
  /** Test seam: the lease's per-call Redis timeout (default `ETSY_LEASE_CALL_TIMEOUT_MS`). */
  lockTimeoutMs?: number
}
export interface EtsyContentPass {
  /** '' or `&includes=${ETSY_PAGE_INCLUDES}` */
  includes(state: string): string
  collect(row: Record<string, unknown>, state: string): void
  /**
   * The page failed with the includes and was read again without them: Etsy refused them (400/422 — not asked again
   * this run), did not answer in time, or failed otherwise. Counts the failed call as an extra call.
   */
  pageWithoutContent(state: string, listingIds: string[], cause?: EtsyPageCause): void
  /** never throws */
  finish(): Promise<EtsyContentTally>
}
export interface EtsyContentReader { get<T>(path: string): Promise<T>; shopId: string }
export type EtsyPageCause = 'refused' | 'timeout' | 'failed'
const PAGE_REASON: Record<EtsyPageCause, string> = { refused: ETSY_PAGE_REFUSED, timeout: ETSY_PAGE_TIMED_OUT, failed: ETSY_PAGE_FAILED }

interface KnownRow { id: string; productId: string; marketplace: string; aliasKey: string; externalListingId: string | null; channelConnectionId: string | null
  product: { parentId: string | null } | null }

type Json = Record<string, unknown>
const VALID_ID = /^[1-9]\d*$/
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** A reason's first clause, so the run's summary groups reasons instead of listing every listing (content-drift.job.ts:85). */
const reasonKey = (reason: string) => reason.split(/ — |: /)[0].slice(0, 80)
const notFound = (error: unknown) => !!error && typeof error === 'object' && (error as { status?: unknown }).status === 404

export function emptyEtsyContentTally(): EtsyContentTally {
  return { listings: 0, compared: 0, drifted: 0, notCompared: 0, reasons: {}, extraCalls: 0, errors: 0 }
}
function noteReason(tally: EtsyContentTally, reason: string, n = 1) {
  const key = reasonKey(reason)
  tally.reasons[key] = (tally.reasons[key] ?? 0) + n
}
/** A pass that changes nothing: no includes on any page, no call, no write. */
function inertPass(tally: EtsyContentTally): EtsyContentPass {
  return { includes: () => '', collect: () => {}, pageWithoutContent: () => {}, finish: async () => tally }
}

/** `promise`, or a rejection after `ms` (the promise itself is left to settle on its own). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms / 1000} s`)), ms)
    ;(timer as { unref?: () => void }).unref?.()
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** This account's lease, or why there is none: `held` = another pass has it (not an error), else the store failed or timed out. */
async function takeLease(accountId: string, override: EtsyContentLockStore | null | undefined, timeoutMs: number): Promise<{ release(): Promise<void> } | { held: boolean; reason: string }> {
  const key = etsyContentLockKey(accountId), token = randomUUID()
  let store: EtsyContentLockStore | null
  try {
    store = override !== undefined ? override : ((await import('../../lib/queue.js')).redis?.connection ?? null) as unknown as EtsyContentLockStore | null
    if (!store || store.status !== 'ready') throw new Error('Redis is not connected')
    const claim = store.eval(CLAIM, 1, key, token, LEASE_MS)
    let claimed: unknown
    try { claimed = await within(claim, timeoutMs) } catch (error) {
      // A claim that lands after the timeout is this pass's, which will not run: let it go at once (else it lapses in 90 s).
      const late = store
      claim.then(answer => { if (answer === 1) void late.eval(RELEASE_LEASE, 1, key, token).catch(() => {}) }, () => {})
      throw error
    }
    if (claimed !== 1) return { held: true, reason: ETSY_PASS_RUNNING }
  } catch (error) {
    return { held: false, reason: `the content pass could not take its lock: ${message(error)}` }
  }
  const held = store, claimedAt = Date.now()
  let renewing = false
  const timer = setInterval(async () => {
    if (renewing) return
    if (Date.now() - claimedAt > ETSY_CONTENT_LEASE_MAX_MS) { clearInterval(timer); return }
    renewing = true
    try { if (held.status === 'ready') await within(held.eval(RENEW_LEASE, 1, key, token), timeoutMs) } catch { /* it lapses on its own within 90 s */ } finally { renewing = false }
  }, RENEW_EVERY_MS)
  timer.unref?.()
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      clearInterval(timer)
      // Never throws and never waits long: `finish()` and the account's stamps come after it.
      try { if (held.status === 'ready') await within(held.eval(RELEASE_LEASE, 1, key, token), timeoutMs) } catch { /* it lapses on its own within 90 s */ }
    },
  }
}

/** An inventory in a batch answer's entry: the entry itself (getListingInventory's shape) or its `inventory` (BELIEVED, R1 §3). */
function batchInventoryOf(entry: Json): Json | null {
  if (Array.isArray(entry.products)) return entry
  return isObj(entry.inventory) && Array.isArray(entry.inventory.products) ? entry.inventory : null
}

export async function startEtsyContentPass(input: { accountId: string; reader: EtsyContentReader; at: Date; deps?: EtsyContentDeps }): Promise<EtsyContentPass> {
  const { accountId, reader, at } = input
  const deps = input.deps ?? {}
  const startTally = emptyEtsyContentTally()

  // 1 — the listings Nexus knows in this shop. None → nothing to compare: no Etsy call, no includes, no write.
  const known = new Map<string, KnownRow[]>()
  try {
    const rows: KnownRow[] = await prisma.channelListing.findMany({
      where: { channel: 'ETSY', channelConnectionId: accountId, externalListingId: { not: null }, product: { deletedAt: null } },
      select: { id: true, productId: true, marketplace: true, aliasKey: true, externalListingId: true, channelConnectionId: true, product: { select: { parentId: true } } },
    })
    for (const row of rows) {
      const id = String(row.externalListingId ?? '')
      if (VALID_ID.test(id)) known.set(id, [...(known.get(id) ?? []), row])
    }
  } catch (error) {
    startTally.errors++
    noteReason(startTally, `the content pass could not start: ${message(error)}`)
    return inertPass(startTally)
  }
  if (!known.size) return inertPass(startTally)

  // 2 — one pass per account at a time (the cron's, a manual Run's, another replica's).
  const lease = await takeLease(accountId, deps.lockStore, deps.lockTimeoutMs ?? ETSY_LEASE_CALL_TIMEOUT_MS)
  if (!('release' in lease)) {
    if (!lease.held) startTally.errors++
    noteReason(startTally, lease.reason)
    return inertPass(startTally)
  }

  // 3 — the shop, once (its languages decide which translations the review compares).
  let shop: Json
  startTally.extraCalls++
  try {
    const answer = await reader.get<unknown>(`/shops/${reader.shopId}`)
    // Never read an unreadable answer as "a shop with no languages": that would compare every translation.
    if (!isObj(answer)) throw new Error('Etsy returned no shop.')
    shop = answer
  } catch (error) {
    await lease.release()
    startTally.errors++
    noteReason(startTally, `the Etsy shop could not be read: ${message(error)}`)
    return inertPass(startTally)
  }

  let sequence = 0
  let includesRefused = false
  const seen = new Map<string, { row: Json; state: string; at: number }>()
  const plain = new Map<string, { state: string; reason: string; at: number }>()

  return {
    includes: state => !includesRefused && ETSY_COMPARED_STATES.has(state) ? `&includes=${ETSY_PAGE_INCLUDES}` : '',
    collect(row, state) {
      const id = String(row.listing_id ?? '')
      if (VALID_ID.test(id) && known.has(id)) seen.set(id, { row, state, at: ++sequence })
    },
    pageWithoutContent(state, listingIds, cause = 'refused') {
      // The failed call with the includes is the extra one (the plain read is what the page always cost).
      startTally.extraCalls++
      // Etsy refusing the parameter refuses it on every page: not asked again in this run.
      if (cause === 'refused') includesRefused = true
      for (const id of listingIds) if (known.has(id)) plain.set(id, { state, reason: PAGE_REASON[cause], at: ++sequence })
    },
    finish: async () => {
      const tally: EtsyContentTally = { ...startTally, reasons: { ...startTally.reasons } }
      try {
        await compareAll(tally)
      } catch (error) {
        tally.errors++
        noteReason(tally, `the content pass stopped: ${message(error)}`)
      } finally {
        await lease.release()
      }
      return tally
    },
  }

  async function compareAll(tally: EtsyContentTally): Promise<void> {
    const now = deps.now ?? Date.now
    const started = now()
    // A local name the drift-writer scan reads (channel.tools.vitest.test.ts): every write below is this source's.
    const recordChannelReadback = deps.record ?? drift.recordChannelReadback
    const ids = [...new Set([...seen.keys(), ...plain.keys()])]
    tally.listings = ids.length
    if (!ids.length) return
    // Loaded only when a listing is compared: the publisher and the media plan are heavy, and an idle pass needs neither.
    const loadOurs = deps.ours ?? (await import('./etsy-content-ours.js')).etsyContentOurs
    const photoCount = deps.photoCount ?? (await import('./etsy-content-ours.js')).etsyNexusPhotoCount

    // The main row of each listing, and the row a not-compared record goes on (only when exactly one row holds the id).
    const ownerOf = new Map<string, KnownRow | null>(), targetOf = new Map<string, KnownRow | null>()
    for (const id of ids) {
      const candidates = known.get(id)!
      const mains = candidates.filter(row => !row.product?.parentId)
      const owner = mains.length === 1 ? mains[0] : null
      ownerOf.set(id, owner)
      targetOf.set(id, owner ?? (candidates.length === 1 ? candidates[0] : null))
    }
    const targets = [...new Set([...targetOf.values()].filter((row): row is KnownRow => !!row).map(row => row.id))]
    const stored = new Map<string, { at: number | null; fields: string[] }>()
    for (const record of targets.length ? await prisma.channelDrift.findMany({ where: { channelListingId: { in: targets } },
      select: { channelListingId: true, checkedBySource: true, driftedFields: true } }) : []) {
      const clock = isObj(record.checkedBySource) ? record.checkedBySource[ETSY_CONTENT_SOURCE] : null
      const ms = isObj(clock) && typeof clock.at === 'string' ? Date.parse(clock.at) : NaN
      const fields = (Array.isArray(record.driftedFields) ? record.driftedFields as unknown[] : []).filter(isObj)
        .filter(entry => entry.source === ETSY_CONTENT_SOURCE && typeof entry.field === 'string').map(entry => entry.field as string)
      stored.set(record.channelListingId, { at: Number.isFinite(ms) ? ms : null, fields })
    }
    // NEVER checked first, then the oldest read (content-drift.job.ts:40-60); a listing with no row to record on costs nothing.
    const clockOf = (id: string) => { const target = targetOf.get(id); return target ? stored.get(target.id)?.at ?? -Infinity : -Infinity }
    const ordered = ids.map((id, index) => ({ id, index, at: clockOf(id) })).sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at)).map(entry => entry.id)

    const isPlain = (id: string) => {
      const page = plain.get(id), row = seen.get(id)
      return !!page && (!row || page.state === row.state || page.at > row.at)
    }
    // The listings whose page row came without its inventory (a page read without the includes among them): read in
    // batches, in the order they are compared.
    const needInventory: string[] = ordered.filter(id => ownerOf.get(id) && seen.has(id) && ETSY_COMPARED_STATES.has(seen.get(id)!.state)
      && !(isObj(seen.get(id)!.row.inventory) && Array.isArray((seen.get(id)!.row.inventory as Json).products)))
    const needsInventory = new Set(needInventory)
    const inventories = new Map<string, Json | null>()
    let batchCalls = 0
    const readBatch = async (batch: string[]): Promise<void> => {
      if (batchCalls >= ETSY_INVENTORY_BATCH_CALLS_PER_RUN) { for (const id of batch) inventories.set(id, null); return }
      batchCalls++
      tally.extraCalls++
      try {
        const answer = await reader.get<unknown>(`/listings/batch/inventory?listing_ids=${batch.join(',')}`)
        const results = isObj(answer) && Array.isArray(answer.results) ? answer.results.filter(isObj) : []
        const byId = new Map(results.filter(entry => entry.listing_id != null).map(entry => [String(entry.listing_id), batchInventoryOf(entry)]))
        for (const id of batch) inventories.set(id, byId.get(id) ?? null)
      } catch (error) {
        // R1 §16: one listing id Etsy no longer has fails the whole batch with 404 — split until it stands alone.
        if (notFound(error) && batch.length > 1) {
          const half = Math.ceil(batch.length / 2)
          await readBatch(batch.slice(0, half))
          await readBatch(batch.slice(half))
          return
        }
        for (const id of batch) inventories.set(id, null)
      }
    }
    const inventoryOf = async (id: string): Promise<Json | null> => {
      if (!inventories.has(id)) await readBatch(needInventory.slice(needInventory.indexOf(id)).filter(next => !inventories.has(next)).slice(0, BATCH))
      return inventories.get(id) ?? null
    }
    let propertyReads = 0

    const write = (row: KnownRow, record: { compared: string[]; differing: DriftField[]; outcome: 'compared' | 'not_compared'; reason?: string; notCompared?: number }) =>
      recordChannelReadback({ channelListingId: row.id, channel: 'ETSY', marketplace: row.marketplace, source: ETSY_CONTENT_SOURCE, checkedAt: at, ...record })
    const notCompared = async (row: KnownRow | null, reason: string, skipped?: number) => {
      if (row) await write(row, { compared: [], differing: [], outcome: 'not_compared', reason, ...(skipped ? { notCompared: skipped } : {}) })
      tally.notCompared++
      noteReason(tally, reason)
    }

    const one = async (id: string) => {
      const owner = ownerOf.get(id)
      if (!owner) {
        const mains = known.get(id)!.filter(row => !row.product?.parentId).length
        return notCompared(targetOf.get(id) ?? null, mains > 1 ? ETSY_MANY_MAIN_ROWS : ETSY_NO_MAIN_ROW)
      }
      // A page read without the includes, and no row of it kept: nothing of Etsy's to compare.
      const page = isPlain(id) ? plain.get(id)! : null
      if (!seen.has(id)) return notCompared(owner, page?.reason ?? ETSY_NO_VARIATIONS)
      const { row, state } = seen.get(id)!
      if (!ETSY_COMPARED_STATES.has(state)) return notCompared(owner, `the listing ended on Etsy (${state})`)
      // Nexus's side first: a listing the review refuses costs no Etsy call.
      const ours = await loadOurs(owner.id)
      if ('reason' in ours) return notCompared(owner, ours.reason)
      let inventory: Json | undefined
      if (needsInventory.has(id)) {
        const read = await inventoryOf(id)
        if (!read) return notCompared(owner, page ? `${page.reason} ${ETSY_NO_VARIATIONS}` : ETSY_NO_VARIATIONS)
        inventory = read
      }
      // Etsy's side without its attributes first: a listing the live review refuses (the shop's language, a variation Etsy
      // no longer holds) is not compared, and costs no attributes call. The refusal reads no attribute.
      const first = etsyPageRaw(row, shop, null, inventory)
      if (!first.inventoryRead) return notCompared(owner, page ? `${page.reason} ${ETSY_NO_VARIATIONS}` : ETSY_NO_VARIATIONS)
      let live: ReturnType<typeof normaliseEtsyListing>
      try { live = normaliseEtsyListing(id, first.raw) } catch (error) { return notCompared(owner, `Etsy's listing could not be read: ${message(error)}`) }
      const refusal = etsyLiveRefusal(ours.facts, ours.publication, live)
      if (refusal) return notCompared(owner, refusal)
      let properties: Json | null = null
      if (propertyReads < ETSY_PROPERTY_READS_PER_RUN) {
        propertyReads++
        tally.extraCalls++
        try {
          const answer = await reader.get<unknown>(`/shops/${reader.shopId}/listings/${id}/properties`)
          // An answer without a results list is not "no attributes": they stay not compared.
          properties = isObj(answer) && Array.isArray(answer.results) ? answer : null
        } catch { properties = null }
      }
      if (properties !== null) {
        try { live = normaliseEtsyListing(id, etsyPageRaw(row, shop, properties, inventory).raw) } catch (error) { return notCompared(owner, `Etsy's listing could not be read: ${message(error)}`) }
      }
      const nexusPhotos = await photoCount({ productId: owner.productId, channelConnectionId: owner.channelConnectionId ?? accountId, aliasKey: owner.aliasKey })
      const photos = { nexus: nexusPhotos.count, ...(nexusPhotos.reason ? { reason: nexusPhotos.reason } : {}), etsy: etsyLiveImages(row) }
      const result = compareEtsyContent(ours.facts, ours.publication, live, { propertiesRead: properties !== null, photos })
      const skipped = result.notCompared.length
      if (!result.compared.length) {
        const reason = [...new Set(result.notCompared.map(entry => entry.reason))].slice(0, 3).join(' · ') || 'nothing of Nexus\'s to compare'
        return notCompared(owner, reason, skipped)
      }
      // A field this source recorded earlier that is no longer on either side (a translation Nexus dropped, an attribute
      // gone from both) has no line in the review any more: it is cleared, as a matching field is. Never an attribute
      // in a run that did not read this listing's attributes: Etsy's side of it is unknown, so it is kept (E5a review M1).
      const planned = new Set([...result.compared, ...result.notCompared.map(entry => entry.field)])
      const vanished = [...new Set(stored.get(owner.id)?.fields ?? [])]
        .filter(field => !planned.has(field) && (properties !== null || !field.startsWith('property:')))
      await write(owner, { compared: [...result.compared, ...vanished], differing: result.differing, outcome: 'compared', notCompared: skipped })
      tally.compared++
      if (result.differing.length) tally.drifted++
    }

    for (let i = 0; i < ordered.length; i++) {
      if (now() - started >= ETSY_CONTENT_BUDGET_MS) {
        const left = ordered.length - i
        tally.notCompared += left
        noteReason(tally, ETSY_BUDGET_LEFT, left)
        break
      }
      try {
        await one(ordered[i])
      } catch (error) {
        tally.errors++
        noteReason(tally, `a listing could not be compared: ${message(error)}`)
      }
    }
  }
}
