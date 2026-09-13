/**
 * MX.1 — the Matrix WRITE DOOR, the VERBS and the REVERT (design §3.7, §3.8, D-MX9; the semantics `store.ts` gives
 * the page in preview mode, made real).
 *
 * ONE door. Every cell write is CAS-checked on the listing's `ChannelListing.version` (a stale `expectedVersion` is a
 * `conflict` carrying the CURRENT version), refused BY NAME with the read's own sentence (FBA → `Amazon-managed` or the
 * guard's sentence, the parent, a formula-owned price, a missing `products.price.edit`, a pinned buffer), a `noop` when
 * nothing would change (no version spent), and `applied` with the NEW version. Every applied write bumps the version
 * FIRST (`updateMany where { id, version }`) and only then delegates — so a concurrent writer conflicts instead of
 * being clobbered, and the July primitives (which deliberately do not bump) stay untouched:
 *
 *   syncMode / syncQty → `setFollowMasterQuantity` (FOLLOW, or PIN; typing into a Follow cell pins AT THE TYPED VALUE,
 *                        D-MX3 — the value is staged into `quantity` inside the CAS transaction and the primitive's
 *                        snapshot rule pins exactly it)
 *   syncBuffer         → `setStockBuffer`
 *   fulfilment         → `fulfillment-method.service.ts` (Add 4(a))
 *   price / salePrice  → `channel-price-write.service.ts` (Add 4(b); `products.price.edit` enforced here too, Add 4(d))
 *
 * A REGION cell (`AMAZON:EU`) lands on EVERY EU row of the SKU inside one transaction — every row's version is
 * checked, every row is bumped, or nothing is written (never a partial EU write) — and answers `expandedTo`.
 *
 * VERBS: `commit:false` runs the SHARED `previewVerb` on the live read (the page runs the same function on its own
 * read — identical by construction). `commit:true` re-verifies EVERY carried change by re-running the shared preview
 * for that one target with params rebuilt from `change.to`, refuses what the fresh preview does not reproduce, applies
 * the rest through the door as ONE `BulkOperation` (`kind: 'studio-matrix-verb'`, the D15 import store) that captures
 * every touched cell BY VALUE, and answers `VerbOperation`. REVERT restores every captured cell by value through the
 * same door (versions bump) and marks the operation `REVERTED` (or `PARTIAL`, never a lie).
 */
import prisma from '../../db.js'
import type { Prisma } from '@prisma/client'
import { previewVerb, type PreviewContext } from '@nexus/shared/matrix-preview'
import {
  MATRIX_COPY,
  type CoordinateKey,
  type FulfilmentMethod,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixRead,
  type MatrixRowRead,
  type MatrixVerbId,
  type MatrixVerbParams,
  type MatrixVerbRequest,
  type MatrixWritableKind,
  type MatrixWriteCell,
  type MatrixWriteOutcome,
  type MatrixWriteResult,
  type VerbChange,
  type VerbOperation,
  type VerbPreview,
} from '@nexus/shared/matrix-contract'
import { logger } from '../../utils/logger.js'
import { outboundSyncQueue, addJobSafely } from '../../lib/queue.js'
import { setFollowMasterQuantity, setStockBuffer } from '../follow-master.service.js'
import { recascadeAfterSyncControlChange } from '../stock-movement.service.js'
import { coalescePendingQuantityRows } from '../sync-coalesce.js'
import { fireOutboundJobs } from '../outbound-enqueue.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { canonical } from './import-diff.service.js'
import { setFulfillmentMethod, type FulfilmentWrite } from './fulfillment-method.service.js'
import { writeChannelPrices } from './channel-price-write.service.js'
import { getMatrixRead } from './matrix.service.js'
import { PRICE_PERMISSION_REASON } from './matrix-cells.js'

export interface DoorContext {
  productId: string
  actor: string
  can: (permission: string) => boolean
}

const PRICE_PERMISSION = 'products.price.edit'
const REVERTIBLE_HOURS = 24
const OP_KIND = 'studio-matrix-verb'

/* ── the read, and the listing rows a coordinate stands for ─────────────────────────────────── */

interface Target { id: string; marketplace: string; version: number }
type Located = { row: MatrixRowRead; coord: MatrixCoordinate; cells: MatrixCells }

function locate(read: MatrixRead, rowId: string, key: CoordinateKey): Located | null {
  const row = read.rows.find((r) => r.id === rowId)
  const coord = read.coordinates.find((c) => c.key === key)
  const cells = row?.cells[key]
  return row && coord && cells ? { row, coord, cells } : null
}

/**
 * The listing rows a write on this coordinate lands on: the one listing, or — on the region group — every EU row of
 * the SKU that is not closed (SCT.6: consenting to an EU-wide quantity action must never reopen a closed offer).
 * The region cell's own `listingId`/`version` is the PRIMARY market's; its fresh version must still match.
 */
async function targetsOf(hit: Located, expectedVersion: number): Promise<{ targets: Target[]; expandedTo?: CoordinateKey[] } | { conflict: number }> {
  if (!hit.coord.sharedInventoryWith) return { targets: [{ id: hit.cells.listingId!, marketplace: hit.coord.market, version: expectedVersion }] }
  const rows = await prisma.channelListing.findMany({
    where: { productId: hit.row.id, channel: hit.coord.channel, marketplace: { in: [...hit.coord.sharedInventoryWith] }, aliasKey: '', ...(hit.coord.accountId ? { channelConnectionId: hit.coord.accountId } : {}) },
    select: { id: true, marketplace: true, version: true, offerClosedAt: true },
  })
  const primary = rows.find((r) => r.id === hit.cells.listingId)
  if (!primary) return { conflict: 0 }
  if (primary.version !== expectedVersion) return { conflict: primary.version }
  const open = rows.filter((r) => !r.offerClosedAt)
  const order = hit.coord.sharedInventoryWith
  open.sort((a, b) => order.indexOf(a.marketplace) - order.indexOf(b.marketplace))
  return { targets: open.map((r) => ({ id: r.id, marketplace: r.marketplace, version: r.version })), expandedTo: open.map((r) => `${hit.coord.channel}:${r.marketplace}`) }
}

/** Bump every target's version under CAS inside the caller's transaction; `false` = someone else moved a row → roll back. */
async function bumpAll(tx: Prisma.TransactionClient, targets: readonly Target[], extra: Prisma.ChannelListingUpdateManyMutationInput = {}): Promise<boolean> {
  for (const t of targets) {
    const r = await tx.channelListing.updateMany({ where: { id: t.id, version: t.version }, data: { ...extra, version: { increment: 1 } } })
    if (r.count !== 1) return false
  }
  return true
}

class Conflict extends Error { constructor(readonly version: number) { super('conflict') } }

async function bumpTx(targets: readonly Target[], extra?: Prisma.ChannelListingUpdateManyMutationInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!(await bumpAll(tx, targets, extra))) throw new Conflict((await tx.channelListing.findUnique({ where: { id: targets[0]!.id }, select: { version: true } }))?.version ?? targets[0]!.version)
  })
}

const asInt = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number(v); return Number.isInteger(n) ? n : null }

/* ── one cell through the door ──────────────────────────────────────────────────────────────── */

export async function applyCell(read: MatrixRead, w: MatrixWriteCell, ctx: DoorContext): Promise<MatrixWriteOutcome> {
  const base = { rowId: w.rowId, coordinateKey: w.coordinateKey, cell: w.cell }
  const hit = locate(read, w.rowId, w.coordinateKey)
  if (!hit || !hit.cells.listingId) return { ...base, outcome: 'refused', reason: 'No listing on this coordinate', version: hit?.cells.version ?? 0 }
  const { row, coord, cells } = hit
  if (cells.version !== w.expectedVersion) return { ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: cells.version }
  if (cells.writable[w.cell] !== true) return { ...base, outcome: 'refused', reason: cells.writeBlockedReason[w.cell] ?? 'This cell cannot be changed here', version: cells.version }
  const refuse = (reason: string): MatrixWriteOutcome => ({ ...base, outcome: 'refused', reason, version: cells.version })
  const noop = (): MatrixWriteOutcome => ({ ...base, outcome: 'noop', version: cells.version })

  const resolved = await targetsOf(hit, w.expectedVersion)
  if ('conflict' in resolved) return { ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: resolved.conflict }
  const { targets, expandedTo } = resolved
  const applied = (version = cells.version + 1): MatrixWriteOutcome => ({ ...base, outcome: 'applied', version, ...(expandedTo ? { expandedTo } : {}) })
  const channel = coord.channel as 'AMAZON' | 'EBAY'
  const markets = targets.map((t) => t.marketplace)

  try {
    switch (w.cell) {
      case 'syncMode': {
        const s = cells.sync; if (!s) return refuse('This coordinate carries no inventory')
        const mode = w.value === 'PINNED' ? 'PINNED' : w.value === 'FOLLOW' ? 'FOLLOW' : null
        if (!mode) return refuse('Mode is Follow or Pinned')
        if (s.mode === mode) return noop()
        await bumpTx(targets)
        const r = await setFollowMasterQuantity({ productIds: [row.id], channel, markets, follow: mode === 'FOLLOW', actor: ctx.actor })
        if (r.results.some((x) => x.action === 'SKIPPED_FBA')) return { ...base, outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: cells.version + 1 }
        return applied()
      }
      case 'syncQty': {
        const s = cells.sync; if (!s) return refuse('This coordinate carries no inventory')
        const n = asInt(w.value)
        if (n == null || n < 0) return refuse('A pinned quantity is a whole number, zero or more')
        /* A pinned row's value is `intended` when the resolver speaks and `held` (the lockstep-written quantity) under a
           pause — measured in the rehearsal: comparing `intended` alone spent a version on a re-pin of a paused row. */
        if (s.mode === 'PINNED' && (s.intended ?? s.held) === n) return noop()
        /* D-MX3: the typed value is staged into `quantity` under CAS; the PIN primitive snapshots exactly that. */
        await bumpTx(targets, { quantity: n })
        const r = await setFollowMasterQuantity({ productIds: [row.id], channel, markets, follow: false, actor: ctx.actor })
        if (r.results.some((x) => x.action === 'SKIPPED_FBA')) return { ...base, outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: cells.version + 1 }
        return applied()
      }
      case 'syncBuffer': {
        const s = cells.sync; if (!s) return refuse('This coordinate carries no inventory')
        const n = asInt(w.value)
        if (n == null || n < 0) return refuse('A buffer is a whole number, zero or more')
        if (s.buffer === n) return noop()
        await bumpTx(targets)
        const r = await setStockBuffer({ productIds: [row.id], channel, markets, buffer: n, actor: ctx.actor })
        if (r.results.some((x) => x.action === 'SKIPPED_FBA')) return { ...base, outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: cells.version + 1 }
        return applied()
      }
      case 'fulfilment': {
        const f = cells.fulfilment; if (!f) return refuse('This channel has no fulfilment method')
        const m = w.value === 'FBA' || w.value === 'FBM' || w.value === 'MCF' ? (w.value as FulfilmentMethod) : w.value === null ? null : undefined
        if (m === undefined) return refuse('Fulfilment is FBA, FBM or MCF')
        if (m && !coord.vocabulary.fulfilment?.includes(m)) return refuse(`${m} is not a method on ${coord.label}`)
        if (m && f.method === m && f.source === 'set') return noop()
        const typed: FulfilmentWrite = m === null ? null : m === 'MCF' ? 'FBA' : m
        const r = await setFulfillmentMethod({ targets: targets.map((t) => ({ listingId: t.id, method: typed, expectedVersion: t.version })), actor: ctx.actor })
        const mine = r.results.find((x) => x.listingId === cells.listingId) ?? r.results[0]!
        if (mine.outcome === 'applied') return applied(mine.version)
        return { ...base, outcome: mine.outcome, reason: mine.reason, version: mine.version }
      }
      case 'price': {
        const p = cells.price; if (!p) return refuse('This coordinate has no price')
        if (!ctx.can(PRICE_PERMISSION)) return refuse(PRICE_PERMISSION_REASON)
        const v = w.value === null ? null : typeof w.value === 'number' ? w.value : Number(w.value)
        if (v !== null && (!Number.isFinite(v) || v < 0)) return refuse('A price is zero or more')
        const rounded = v === null ? null : Math.round(v * 100) / 100
        if (rounded !== null && p.value === rounded && p.source === 'override') return noop()
        if (rounded === null && p.source === 'master') return noop()
        const r = await writeChannelPrices({ targets: [{ listingId: cells.listingId, price: rounded, expectedVersion: cells.version }], actor: ctx.actor, source: 'MANUAL_OVERRIDE', reason: 'matrix' })
        const mine = r.results[0]!
        return mine.outcome === 'applied' ? applied(mine.version) : { ...base, outcome: mine.outcome, reason: mine.reason, version: mine.version }
      }
      case 'salePrice': {
        const sale = cells.sale; if (!sale) return refuse('This coordinate has no sale price')
        if (!ctx.can(PRICE_PERMISSION)) return refuse(PRICE_PERMISSION_REASON)
        const v = (w.value ?? null) as { value?: number | null; start?: string | null; end?: string | null } | null
        const next = { value: v?.value ?? null, start: v?.start ?? null, end: v?.end ?? null }
        if (sale.value === next.value && sale.start === next.start && sale.end === next.end) return noop()
        const r = await writeChannelPrices({ targets: [{ listingId: cells.listingId, sale: next, expectedVersion: cells.version }], actor: ctx.actor, source: 'MANUAL_OVERRIDE', reason: 'matrix' })
        const mine = r.results[0]!
        return mine.outcome === 'applied' ? applied(mine.version) : { ...base, outcome: mine.outcome, reason: mine.reason, version: mine.version }
      }
    }
  } catch (err) {
    if (err instanceof Conflict) return { ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: err.version }
    throw err
  }
  return refuse('This cell cannot be changed here')
}

/** The one door: every cell write, in order, each CAS-checked on its own listing version; the read is taken once. */
export async function writeMatrixCells(ctx: DoorContext, cells: readonly MatrixWriteCell[]): Promise<MatrixWriteResult> {
  const read = await getMatrixRead({ productId: ctx.productId, canEditPrice: ctx.can(PRICE_PERMISSION) })
  const results: MatrixWriteOutcome[] = []
  const versions = new Map<string, number>()
  for (const w of cells) {
    const k = `${w.rowId}|${w.coordinateKey}`
    const live = versions.get(k)
    const outcome = await applyCell(read, live === undefined ? w : { ...w, expectedVersion: w.expectedVersion }, ctx)
    if (outcome.outcome === 'applied') { versions.set(k, outcome.version); const hit = locate(read, w.rowId, w.coordinateKey); if (hit) hit.cells.version = outcome.version }
    results.push(outcome)
  }
  await refreshCache(read, results)
  return { results, version: read.version }
}

async function refreshCache(read: MatrixRead, results: readonly MatrixWriteOutcome[]): Promise<void> {
  const touched = [...new Set(results.filter((r) => r.outcome === 'applied').map((r) => r.rowId))]
  if (touched.length === 0) return
  await productReadCacheService.refreshMany(touched).catch((err) => logger.warn('matrix: read-cache refresh failed (reconcile cron will heal)', { productId: read.productId, error: err instanceof Error ? err.message : String(err) }))
}

/* ── the state verbs: pause · resume · push now · retry ─────────────────────────────────────── */

async function applySyncState(read: MatrixRead, change: VerbChange, verb: MatrixVerbId, ctx: DoorContext): Promise<MatrixWriteOutcome> {
  const base = { rowId: change.rowId, coordinateKey: change.coordinateKey, cell: 'syncMode' as MatrixWritableKind }
  const hit = locate(read, change.rowId, change.coordinateKey)
  if (!hit?.cells.sync || !hit.cells.listingId) return { ...base, outcome: 'refused', reason: 'No inventory on this coordinate', version: hit?.cells.version ?? 0 }
  const { row, cells, coord } = hit
  if (cells.sync.kind === 'FBA_EXCLUDED') return { ...base, outcome: 'refused', reason: MATRIX_COPY.amazonManaged, version: cells.version }
  const resolved = await targetsOf(hit, cells.version)
  if ('conflict' in resolved) return { ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: resolved.conflict }
  const { targets, expandedTo } = resolved
  const applied = (): MatrixWriteOutcome => ({ ...base, outcome: 'applied', version: cells.version + 1, ...(expandedTo ? { expandedTo } : {}) })
  const scopeName = (t: Target) => `${row.sku}@${coord.channel}:${t.marketplace}`
  try {
    if (verb === 'pause-sync' || verb === 'resume-sync') {
      const pause = verb === 'pause-sync'
      if (pause && cells.sync.kind === 'PAUSED') return { ...base, outcome: 'noop', version: cells.version }
      if (!pause && cells.sync.kind !== 'PAUSED') return { ...base, outcome: 'noop', version: cells.version }
      if (!pause && cells.sync.via === 'POLICY') return { ...base, outcome: 'refused', reason: 'Held by the channel policy — resuming here changes nothing; resume in Sync Control', version: cells.version }
      await bumpTx(targets, { syncPaused: pause })
      await prisma.syncControlAudit.createMany({ data: targets.map((t) => ({ actor: ctx.actor, scopeType: 'LISTING', scopeId: t.id, scopeName: scopeName(t), field: 'syncPaused', before: { syncPaused: !pause }, after: { syncPaused: pause }, reason: 'matrix' })) }).catch(() => undefined)
      if (!pause) void recascadeAfterSyncControlChange([row.id], ctx.actor).then((r) => logger.info('matrix: recascade after resume', { ...r, actor: ctx.actor }))
      return applied()
    }
    if (verb === 'push-now') {
      const intended = cells.sync.intended
      if (cells.sync.kind === 'PAUSED') return { ...base, outcome: 'refused', reason: 'Paused — resume to push', version: cells.version }
      if (cells.sync.kind === 'CLOSED') return { ...base, outcome: 'refused', reason: MATRIX_COPY.closedHint, version: cells.version }
      if (intended == null) return { ...base, outcome: 'refused', reason: MATRIX_COPY.uncountedHint, version: cells.version }
      const rows = await prisma.$transaction(async (tx) => {
        if (!(await bumpAll(tx, targets, { quantity: intended, lastSyncStatus: 'PENDING' }))) throw new Conflict(cells.version)
        await coalescePendingQuantityRows(tx, targets.map((t) => t.id))
        const listings = await tx.channelListing.findMany({ where: { id: { in: targets.map((t) => t.id) } }, select: { id: true, region: true, externalListingId: true, marketplace: true } })
        const out: Array<{ id: string; productId: string | null; syncType: string; holdUntil: Date | null }> = []
        for (const l of listings) {
          const q = await tx.outboundSyncQueue.create({
            data: { productId: row.id, channelListingId: l.id, targetChannel: coord.channel as never, targetRegion: l.region, syncStatus: 'PENDING' as never, syncType: 'QUANTITY_UPDATE', holdUntil: new Date(), externalListingId: l.externalListingId, maxRetries: 3, payload: { quantity: intended, source: 'MATRIX_PUSH_NOW', marketplace: l.marketplace, actor: ctx.actor } },
            select: { id: true, productId: true, syncType: true, holdUntil: true },
          })
          out.push(q)
        }
        return out
      })
      await fireOutboundJobs(rows, { source: 'MATRIX_PUSH_NOW' })
      return applied()
    }
    if (verb === 'retry-sync') {
      const failed = await prisma.outboundSyncQueue.findFirst({
        where: { channelListingId: { in: targets.map((t) => t.id) }, syncType: { in: ['QUANTITY_UPDATE', 'PRICE_UPDATE'] }, OR: [{ syncStatus: 'FAILED' }, { isDead: true }] },
        orderBy: { createdAt: 'desc' }, select: { id: true, productId: true, channelListingId: true, targetChannel: true, syncType: true },
      })
      if (!failed) return { ...base, outcome: 'refused', reason: 'Nothing to retry on this coordinate', version: cells.version }
      await bumpTx(targets)
      /* The explicit row id, never the unscoped bulk route (report 28 §5.4) — the same statement `POST /api/outbound-queue/:id/retry` runs. */
      await prisma.outboundSyncQueue.update({ where: { id: failed.id }, data: { syncStatus: 'PENDING', retryCount: 0, errorMessage: null, errorCode: null, nextRetryAt: null, isDead: false, diedAt: null } })
      await addJobSafely(outboundSyncQueue, 'sync-job', { queueId: failed.id, productId: failed.productId, channelListingId: failed.channelListingId, targetChannel: failed.targetChannel, syncType: failed.syncType }, { jobId: `${failed.channelListingId}:${failed.syncType}:retry:${Date.now()}` })
      return applied()
    }
  } catch (err) {
    if (err instanceof Conflict) return { ...base, outcome: 'conflict', reason: 'Changed elsewhere — reloaded', version: err.version }
    throw err
  }
  return { ...base, outcome: 'refused', reason: `${verb} is not a state verb`, version: cells.version }
}

/* ── verbs ──────────────────────────────────────────────────────────────────────────────────── */

const STATE_VERBS = new Set<MatrixVerbId>(['pause-sync', 'resume-sync', 'push-now', 'retry-sync'])

/** Params that make the shared preview reproduce ONE carried change — the server's re-verification of a client-carried preview. */
export function paramsForChange(verb: MatrixVerbId, change: VerbChange): MatrixVerbParams | null {
  switch (verb) {
    case 'set-price': case 'adjust-prices': case 'copy-prices': return typeof change.to === 'number' ? { verb: 'set-price', value: change.to } : null
    case 'pin-quantity': return typeof change.to === 'number' ? { verb: 'pin-quantity', value: change.to } : null
    case 'set-buffer': return typeof change.to === 'number' ? { verb: 'set-buffer', value: change.to } : null
    case 'set-follow': return { verb: 'set-follow' }
    case 'set-fulfilment': return change.to === 'FBA' || change.to === 'FBM' || change.to === 'MCF' ? { verb: 'set-fulfilment', method: change.to } : null
    case 'pause-sync': case 'resume-sync': case 'push-now': case 'retry-sync': return { verb }
  }
}

export type VerbCommitResult = { operation: VerbOperation; results: MatrixWriteOutcome[] }

export async function runMatrixVerb(ctx: DoorContext, req: MatrixVerbRequest & { preview?: VerbPreview }): Promise<VerbPreview | VerbCommitResult> {
  const read = await getMatrixRead({ productId: ctx.productId, canEditPrice: ctx.can(PRICE_PERMISSION) })
  const pctx: PreviewContext = { can: ctx.can, simulated: false }
  if (!req.commit) return previewVerb(read, { ...req, commit: false }, pctx)
  const verb = req.params.verb
  /* The page commits with `params: { verb }` + the preview it showed; a caller with full params gets a fresh preview. */
  const carried = req.preview?.changes ?? previewVerb(read, { ...req, commit: false }, pctx).changes

  const before: Array<{ rowId: string; coordinateKey: CoordinateKey; cells: MatrixCells }> = []
  const seen = new Set<string>()
  for (const ch of carried) {
    const k = `${ch.rowId}|${ch.coordinateKey}`
    if (seen.has(k)) continue
    seen.add(k)
    const cells = read.rows.find((r) => r.id === ch.rowId)?.cells[ch.coordinateKey]
    if (cells) before.push({ rowId: ch.rowId, coordinateKey: ch.coordinateKey, cells: JSON.parse(JSON.stringify(cells)) })
  }

  const results: MatrixWriteOutcome[] = []
  for (const ch of carried) {
    const params = paramsForChange(verb, ch)
    const fresh = params ? previewVerb(read, { params, targets: [{ rowId: ch.rowId, coordinateKey: ch.coordinateKey }], commit: false }, pctx) : null
    const same = fresh?.changes.find((c) => c.rowId === ch.rowId && c.coordinateKey === ch.coordinateKey && c.cell === ch.cell && canonical(c.to) === canonical(ch.to))
    if (!same) {
      const reason = fresh?.refusals.find((r) => r.rowId === ch.rowId)?.reason ?? 'Changed since the preview — reload and run the verb again'
      results.push({ rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: ch.cell === 'syncState' ? 'syncMode' : (ch.cell as MatrixWritableKind), outcome: 'refused', reason, version: read.rows.find((r) => r.id === ch.rowId)?.cells[ch.coordinateKey]?.version ?? 0 })
      continue
    }
    const cells = locate(read, ch.rowId, ch.coordinateKey)?.cells
    const outcome = ch.cell === 'syncState' || STATE_VERBS.has(verb)
      ? await applySyncState(read, ch, verb, ctx)
      : await applyCell(read, { rowId: ch.rowId, coordinateKey: ch.coordinateKey, cell: ch.cell as MatrixWritableKind, value: ch.to, expectedVersion: cells?.version ?? 0 }, ctx)
    if (outcome.outcome === 'applied' && cells) cells.version = outcome.version
    results.push(outcome)
  }
  await refreshCache(read, results)

  const applied = results.filter((r) => r.outcome === 'applied').length
  const refused = results.length - applied
  const op = await prisma.bulkOperation.create({
    data: {
      userId: ctx.actor, productCount: new Set(carried.map((c) => c.rowId)).size, changeCount: carried.length,
      changes: { kind: OP_KIND, verb, productId: ctx.productId, before, changes: carried, outcomes: results, phase: 'apply' } as unknown as Prisma.InputJsonValue,
      status: refused > 0 ? 'PARTIAL' : 'COMPLETED', processed: results.length, total: carried.length,
      completedAt: new Date(), expiresAt: new Date(Date.now() + REVERTIBLE_HOURS * 3600_000),
    },
    select: { id: true, createdAt: true },
  })
  return { operation: { id: op.id, verb, appliedAt: op.createdAt.toISOString(), applied, refused, before }, results }
}

/* ── revert: restore by VALUE through the same door ─────────────────────────────────────────── */

export class OperationNotRevertibleError extends Error {
  readonly code = 'operation_not_revertible'
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'OperationNotRevertibleError' }
}

interface StoredOp { kind?: string; verb?: MatrixVerbId; productId?: string; before?: VerbOperation['before']; changes?: VerbChange[]; outcomes?: MatrixWriteOutcome[]; phase?: string }

/** The cell writes that take `live` back to `before`, in the order the door must run them. */
export function restoreWrites(rowId: string, key: CoordinateKey, before: MatrixCells, live: MatrixCells): Array<{ kind: 'state'; verb: 'pause-sync' | 'resume-sync' } | { kind: 'cell'; cell: MatrixWritableKind; value: unknown }> {
  const out: Array<{ kind: 'state'; verb: 'pause-sync' | 'resume-sync' } | { kind: 'cell'; cell: MatrixWritableKind; value: unknown }> = []
  const b = before, l = live
  if (b.sync && l.sync) {
    if (b.sync.kind === 'PAUSED' && b.sync.via === 'LISTING' && l.sync.kind !== 'PAUSED') out.push({ kind: 'state', verb: 'pause-sync' })
    if (b.sync.kind !== 'PAUSED' && l.sync.kind === 'PAUSED' && l.sync.via === 'LISTING') out.push({ kind: 'state', verb: 'resume-sync' })
  }
  if (b.fulfilment && l.fulfilment && b.fulfilment.method !== l.fulfilment.method) out.push({ kind: 'cell', cell: 'fulfilment', value: b.fulfilment.source === 'set' ? b.fulfilment.method : null })
  if (b.sync && l.sync && b.sync.kind !== 'FBA_EXCLUDED') {
    if (b.sync.mode === 'PINNED' && (l.sync.mode !== 'PINNED' || l.sync.intended !== b.sync.intended)) out.push({ kind: 'cell', cell: 'syncQty', value: b.sync.intended ?? b.sync.held ?? 0 })
    else if (b.sync.mode === 'FOLLOW' && l.sync.mode !== 'FOLLOW') out.push({ kind: 'cell', cell: 'syncMode', value: 'FOLLOW' })
    if (b.sync.buffer !== l.sync.buffer) out.push({ kind: 'cell', cell: 'syncBuffer', value: b.sync.buffer })
  }
  if (b.price && l.price && b.price.source !== 'formula') {
    if (b.price.source === 'override' && (l.price.value !== b.price.value || l.price.source !== 'override')) out.push({ kind: 'cell', cell: 'price', value: b.price.value })
    else if (b.price.source === 'master' && l.price.source === 'override') out.push({ kind: 'cell', cell: 'price', value: null })
  }
  if (b.sale && l.sale && (b.sale.value !== l.sale.value || b.sale.start !== l.sale.start || b.sale.end !== l.sale.end)) out.push({ kind: 'cell', cell: 'salePrice', value: { ...b.sale } })
  void rowId; void key
  return out
}

export async function revertMatrixOperation(ctx: DoorContext, operationId: string): Promise<VerbCommitResult> {
  const op = await prisma.bulkOperation.findUnique({ where: { id: operationId } })
  const stored = (op?.changes && typeof op.changes === 'object' ? op.changes : {}) as StoredOp
  if (!op || stored.kind !== OP_KIND || stored.productId !== ctx.productId) throw new OperationNotRevertibleError(404, 'No Matrix operation with this id on this product')
  if (op.status !== 'COMPLETED' && op.status !== 'PARTIAL') throw new OperationNotRevertibleError(409, `This operation is ${op.status.toLowerCase()} — it can be reverted once, from completed or partial`)
  if (op.expiresAt && op.expiresAt.getTime() <= Date.now()) throw new OperationNotRevertibleError(409, 'This operation is past its revert window')
  const claimed = await prisma.bulkOperation.updateMany({ where: { id: op.id, status: op.status }, data: { status: 'RUNNING' } })
  if (claimed.count !== 1) throw new OperationNotRevertibleError(409, 'This operation is already being reverted')

  const read = await getMatrixRead({ productId: ctx.productId, canEditPrice: ctx.can(PRICE_PERMISSION) })
  const results: MatrixWriteOutcome[] = []
  try {
    for (const b of stored.before ?? []) {
      const hit = locate(read, b.rowId, b.coordinateKey)
      if (!hit) { results.push({ rowId: b.rowId, coordinateKey: b.coordinateKey, cell: 'syncMode', outcome: 'refused', reason: 'No listing on this coordinate any more', version: 0 }); continue }
      for (const w of restoreWrites(b.rowId, b.coordinateKey, b.cells, hit.cells)) {
        const outcome = w.kind === 'state'
          ? await applySyncState(read, { rowId: b.rowId, sku: hit.row.sku, coordinateKey: b.coordinateKey, cell: 'syncState', from: null, to: null, fromLabel: '', toLabel: '' }, w.verb, ctx)
          : await applyCell(read, { rowId: b.rowId, coordinateKey: b.coordinateKey, cell: w.cell, value: w.value, expectedVersion: hit.cells.version }, ctx)
        if (outcome.outcome === 'applied') hit.cells.version = outcome.version
        results.push(outcome)
      }
    }
  } catch (err) {
    await prisma.bulkOperation.update({ where: { id: op.id }, data: { status: 'FAILED', completedAt: new Date(), errors: [{ stage: 'revert', error: err instanceof Error ? err.message : String(err) }] as unknown as Prisma.InputJsonValue } })
    throw err
  }
  await refreshCache(read, results)
  const refused = results.filter((r) => r.outcome === 'refused' || r.outcome === 'conflict').length
  await prisma.bulkOperation.update({
    where: { id: op.id },
    data: { status: refused > 0 ? 'PARTIAL' : 'REVERTED', completedAt: new Date(), processed: results.length, changes: { ...stored, phase: 'revert', revertOutcomes: results } as unknown as Prisma.InputJsonValue },
  })
  return {
    operation: { id: op.id, verb: stored.verb ?? 'set-follow', appliedAt: op.createdAt.toISOString(), applied: results.filter((r) => r.outcome === 'applied').length, refused, before: stored.before ?? [] },
    results,
  }
}
