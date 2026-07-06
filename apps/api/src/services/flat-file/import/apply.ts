/**
 * FF2.6a — applyChanges: transactional apply of update/add/delete cell changes
 * from a dry-run diff, with FFD10 resolver write-back and inverse diff capture.
 *
 * Scope:
 *   - Applies CellChanges with kind 'add' | 'update' | 'delete' from both
 *     diff.changes (channel sheets) and diff.masterChanges (Products sheet).
 *   - Skips 'conflict' (resolved in T7) and 'out-of-scope' silently.
 *   - Row-level DELETEs (diff.deletes) are NOT handled here — see Task T6b.
 *
 * FFD10 resolver write-back:
 *   - Governed per-market fields (price, title, description, quantity, bullets):
 *     writing a value also sets the override column and clears followMaster.
 *   - Follow-flag columns (price_follows_master@IT etc.): setting 'true'
 *     re-attaches the listing to master and nulls the override.
 *
 * Inverse diff:
 *   - Before every write, a read-before-write captures the columns being
 *     overwritten into an InverseCell, enabling a future rollback pass.
 *
 * Transaction semantics (I2a):
 *   - Wraps all writes in prisma.$transaction if available.
 *   - Per-row errors are caught and recorded as FAILED; other records still
 *     apply (per-record independence). Each row's outcome is independent.
 *   - When prisma.$transaction is not available (mock/test), writes run directly.
 */

import type { ImportDiff, CellChange } from './diff.js'
import type { ImportScope, Channel } from './scope.js'
import { MASTER_FIELDS } from '../registry/master-fields.js'
import { CHANNEL_MARKET_FIELDS } from '../registry/channel-fields.js'
import type { FieldDefinition } from '../registry/types.js'

// ── Public types ───────────────────────────────────────────────────────────────

/** One snapshot of the DB state BEFORE an apply write — for rollback. */
export interface InverseCell {
  model: 'Product' | 'ChannelListing'
  sku: string
  channel?: Channel
  market?: string
  /**
   * The columns' PREVIOUS values (to restore on rollback).
   *
   * Special shape for C1 children restore (master-delete cascade):
   *   { __restoreChildrenOf: parentId, childIds: string[], deletedAt: null }
   * The T9 rollback pass recognises __restoreChildrenOf and issues
   *   product.updateMany({ where: { id: { in: childIds } }, data: { deletedAt: null } })
   */
  data: Record<string, unknown>
}

export interface ApplyRowResult {
  sku: string
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED'
  detail?: string
}

export interface ApplyResult {
  applied: number
  skipped: number
  failed: number
  rows: ApplyRowResult[]
  inverseDiff: InverseCell[]
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Infix that identifies a follow-master control column. */
const FM_INFIX = '_follows_master@'

/** Field classes that must never be written by apply — mirrors diff.ts READONLY_CLS. */
const READONLY_CLS = new Set<string>(['READONLY_SYNCED', 'DERIVED', 'SYSTEM'])

// ── Registry lookups (built once at module load) ───────────────────────────────

const MASTER_BY_ID = new Map<string, FieldDefinition>()
for (const f of MASTER_FIELDS) {
  MASTER_BY_ID.set(f.id, f)
}

const CHANNEL_BY_ID = new Map<string, FieldDefinition>()
for (const f of CHANNEL_MARKET_FIELDS) {
  if (!CHANNEL_BY_ID.has(f.id)) CHANNEL_BY_ID.set(f.id, f)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Thrown by coerce when a numeric field value is non-parseable (e.g. 'N/A'). */
class CoerceSkipError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CoerceSkipError'
  }
}

/**
 * Coerce an import cell value to the appropriate Prisma-ready type.
 *
 * - Empty string / null / undefined → null  (the __CLEAR__ / delete sentinel)
 * - decimal / number field          → Number(value.trim()); throws CoerceSkipError
 *                                     if !Number.isFinite (I4: blocks NaN writes).
 *                                     Whitespace-only → null, never 0 (I4 blank guard).
 * - boolean field                   → case-insensitive match on true/yes/1/y/t (M1)
 * - array field                     → split by arrayDelimiter
 *                                     NOTE (I3): the '|' delimiter is lossy on write —
 *                                     a value containing the delimiter will be split on
 *                                     round-trip. Revisit with a non-colliding delimiter.
 * - otherwise                       → string
 */
function coerce(value: unknown, field: FieldDefinition | undefined): unknown {
  if (value === '' || value === null || value === undefined) return null
  const s = String(value)
  if (!field) return s
  if (field.kind === 'decimal' || field.kind === 'number') {
    // I4: whitespace-only → null (avoid Number(' ') === 0 writing a spurious zero)
    if (s.trim() === '') return null
    const n = Number(s.trim())
    // I4: non-finite (NaN / Infinity / -Infinity) → skip, never write
    if (!Number.isFinite(n)) throw new CoerceSkipError('skipped: non-numeric value')
    return n
  }
  // M1: boolean coerce is case-insensitive and accepts common truthy spellings
  if (field.kind === 'boolean') {
    return ['true', 'yes', '1', 'y', 't'].includes(s.trim().toLowerCase())
  }
  if (field.kind === 'array') return s.split(field.arrayDelimiter ?? ' | ')
  return s
}

/** Returns true if the CellChange refers to a follow-master control column. */
function isFollowFlag(change: CellChange): boolean {
  return change.column.indexOf(FM_INFIX) !== -1
}

/**
 * Capture the current values of the columns that are about to be written
 * (for inverse-diff / rollback). Keys come from the data object; values
 * are read from the before row (or null if absent).
 */
function captureInverse(
  data: Record<string, unknown>,
  before: Record<string, unknown>,
): Record<string, unknown> {
  const inv: Record<string, unknown> = {}
  const keys = Object.keys(data)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    inv[k] = before[k] !== undefined ? before[k] : null
  }
  return inv
}

// ── applyChanges ───────────────────────────────────────────────────────────────

/**
 * Apply the in-scope update/add/delete cell changes from a dry-run diff.
 *
 * @param prisma  Injected Prisma client (typed any; avoids singleton import).
 *                Must expose: channelListing.{findFirst, updateMany, create},
 *                product.{findFirst, updateMany}, and optionally $transaction.
 * @param diff    ImportDiff produced by computeDiff / previewImport.
 * @param opts    scope: which channel+markets are in scope; conflictPolicy
 *                is accepted but unused in this phase (conflicts are skipped).
 */
export async function applyChanges(
  prisma: any,
  diff: ImportDiff,
  opts: { scope: ImportScope; conflictPolicy?: 'file-wins' | 'db-wins' },
): Promise<ApplyResult> {
  // Combine channel changes + master changes into a single ordered pass.
  // masterChanges (Products sheet) travel with the channel changes; their
  // sheet field distinguishes them ('Products' vs a channel sheet name).
  const allChanges: CellChange[] = [...diff.changes, ...diff.masterChanges]

  const rows: ApplyRowResult[] = []
  const inverseDiff: InverseCell[] = []
  let applied = 0
  let skipped = 0
  let failed = 0

  // ── Inner apply function (runs inside $transaction or directly) ────────────

  const applyFn = async (tx: any): Promise<void> => {
    for (const change of allChanges) {
      const { sku, kind, base } = change

      // ── Kind gate ────────────────────────────────────────────────────────
      // out-of-scope: shown greyed in preview; never applied regardless of policy.
      if (kind === 'out-of-scope') {
        skipped++
        rows.push({ sku, status: 'SKIPPED', detail: 'out-of-scope' })
        continue
      }

      // conflict: apply or skip based on the caller's conflict resolution policy.
      //   'file-wins' (default): apply the file value, identical to an 'update'.
      //   'db-wins': retain the current DB value unchanged.
      // Scope + readonly guards below still apply for 'file-wins'.
      // NOTE: apply-time fingerprint RE-check (re-fetch DB fp vs snapshot) is a future enhancement.
      if (kind === 'conflict') {
        if (opts.conflictPolicy === 'db-wins') {
          skipped++
          rows.push({ sku, status: 'SKIPPED', detail: 'conflict: kept DB value' })
          continue
        }
        // 'file-wins': fall through to the normal write path
      }

      // Any remaining non-actionable kind (no-change or future unknown) → skip defensively.
      if (kind !== 'add' && kind !== 'update' && kind !== 'delete' && kind !== 'conflict') {
        skipped++
        rows.push({ sku, status: 'SKIPPED', detail: 'out-of-scope' })
        continue
      }

      // ── SKU guard: row key is never rewritten ────────────────────────────
      if (base === 'sku') {
        skipped++
        rows.push({ sku, status: 'SKIPPED', detail: 'sku column is read-only' })
        continue
      }

      // ── parent_sku guard: re-parenting requires a structural operation ────
      // The flat-file snapshot parent_sku trap makes naive re-parenting unsafe.
      if (base === 'parent_sku') {
        skipped++
        rows.push({ sku, status: 'SKIPPED', detail: 're-parenting via import not supported' })
        continue
      }

      try {
        const isMaster = change.sheet === 'Products'

        if (isMaster) {
          // ── Master change: Product row ─────────────────────────────────────
          const field = MASTER_BY_ID.get(base)
          if (!field) {
            skipped++
            rows.push({ sku, status: 'SKIPPED', detail: 'unknown master field: ' + base })
            continue
          }

          // I5: defensive readonly guard — reject READONLY_SYNCED/DERIVED/SYSTEM
          if (READONLY_CLS.has(field.cls)) {
            skipped++
            rows.push({
              sku,
              status: 'SKIPPED',
              detail: `skipped (defensive): field '${base}' is ${field.cls} (readonly)`,
            })
            continue
          }

          // Read-before-write: for inverse diff and soft-delete guard.
          const before = await tx.product.findFirst({ where: { sku } })

          // Soft-delete guard: an 'add' must not resurrect a soft-deleted product.
          if (kind === 'add' && before && before.deletedAt) {
            skipped++
            rows.push({
              sku,
              status: 'SKIPPED',
              detail: 'skipped: product is soft-deleted (would resurrect)',
            })
            continue
          }

          const data: Record<string, unknown> = {
            [field.source.column]: coerce(change.to, field),
          }

          // Capture inverse (only when the row already exists in the DB).
          if (before) {
            inverseDiff.push({
              model: 'Product',
              sku,
              data: captureInverse(data, before),
            })
          }

          // M4: deletedAt:null guard — do not update soft-deleted products
          await tx.product.updateMany({ where: { sku, deletedAt: null }, data })
          applied++
          rows.push({ sku, status: 'SUCCESS' })
        } else {
          // ── Channel change: ChannelListing row ─────────────────────────────
          const { channel, market } = change
          if (!channel || !market) {
            skipped++
            rows.push({ sku, status: 'SKIPPED', detail: 'missing channel or market on channel change' })
            continue
          }

          // I5: defensive out-of-scope market guard — trust opts.scope over diff classification
          if (opts.scope.markets !== 'ALL' && !opts.scope.markets.includes(market)) {
            skipped++
            rows.push({
              sku,
              status: 'SKIPPED',
              detail: `skipped (defensive): market '${market}' is out of scope`,
            })
            continue
          }

          const where = { product: { sku }, channel, marketplace: market }

          // Read current listing for inverse diff + missing-listing detection.
          const before = await tx.channelListing.findFirst({ where })

          // Soft-delete guard for adds: don't create a listing for a deleted product.
          if (kind === 'add') {
            const product = await tx.product.findFirst({ where: { sku } })
            if (product && product.deletedAt) {
              skipped++
              rows.push({
                sku,
                status: 'SKIPPED',
                detail: 'skipped: product is soft-deleted (would resurrect)',
              })
              continue
            }
          }

          // ── Build the write payload ─────────────────────────────────────────
          let data: Record<string, unknown>

          if (isFollowFlag(change)) {
            // Follow-flag control column: price_follows_master@IT etc.
            // base is the governed field id (e.g. 'price') — scope.ts strips _follows_master.
            const field = CHANNEL_BY_ID.get(base)
            if (!field || !field.followMaster) {
              skipped++
              rows.push({
                sku,
                status: 'SKIPPED',
                detail: 'unknown governed field for follow-flag: ' + base,
              })
              continue
            }
            // I5: defensive readonly guard for follow-flag fields
            if (READONLY_CLS.has(field.cls)) {
              skipped++
              rows.push({
                sku,
                status: 'SKIPPED',
                detail: `skipped (defensive): field '${base}' is ${field.cls} (readonly)`,
              })
              continue
            }
            const { followColumn, overrideColumn } = field.followMaster
            if (change.to === 'true') {
              // Re-attach to master: set flag true, null the override
              data = { [followColumn]: true, [overrideColumn]: null }
            } else {
              // Detach from master (flag only — override stays as-is until next value write)
              data = { [followColumn]: false }
            }
          } else {
            // Value column (governed or non-governed)
            const field = CHANNEL_BY_ID.get(base)
            if (!field) {
              skipped++
              rows.push({ sku, status: 'SKIPPED', detail: 'unknown channel field: ' + base })
              continue
            }
            // I5: defensive readonly guard for value fields
            if (READONLY_CLS.has(field.cls)) {
              skipped++
              rows.push({
                sku,
                status: 'SKIPPED',
                detail: `skipped (defensive): field '${base}' is ${field.cls} (readonly)`,
              })
              continue
            }
            if (field.followMaster) {
              // Governed field — FFD10 write-back:
              // write the override column AND detach from master in one operation.
              const { overrideColumn, followColumn } = field.followMaster
              data = {
                [overrideColumn]: coerce(change.to, field),
                [followColumn]: false,
              }
            } else {
              // Non-governed field: write source column directly.
              data = { [field.source.column]: coerce(change.to, field) }
            }
          }

          // Capture inverse from the pre-write state.
          if (before) {
            inverseDiff.push({
              model: 'ChannelListing',
              sku,
              channel,
              market,
              data: captureInverse(data, before),
            })
          }

          if (!before) {
            // New ChannelListing: CREATE and connect to the Product by SKU.
            // I1: channelMarket and region are NON-NULL columns — always include them.
            await tx.channelListing.create({
              data: {
                product: { connect: { sku } },
                channel,
                marketplace: market,
                ...data,
                channelMarket: `${channel}_${market}`,
                region: market,
              },
            })
          } else {
            // Existing ChannelListing: UPDATE via updateMany (no upsert to keep mock simple).
            // Note (M4): ChannelListing has no deletedAt column — guard not applicable here.
            await tx.channelListing.updateMany({ where, data })
          }

          applied++
          rows.push({ sku, status: 'SUCCESS' })
        }
      } catch (err) {
        // I4: non-numeric coerce is a skip (operator data quality), not an apply failure.
        if (err instanceof CoerceSkipError) {
          skipped++
          rows.push({ sku, status: 'SKIPPED', detail: err.message })
          continue
        }
        // Per-row errors don't abort the batch; they are recorded as FAILED.
        failed++
        rows.push({
          sku,
          status: 'FAILED',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ── Execute: transactionally if available, directly otherwise ─────────────
  if (typeof prisma.$transaction === 'function') {
    await prisma.$transaction(applyFn)
  } else {
    await applyFn(prisma)
  }

  return { applied, skipped, failed, rows, inverseDiff }
}

// ── applyDeletes ───────────────────────────────────────────────────────────────

/**
 * FF2.6b — Apply row-level deletions from a dry-run diff.
 *
 * Two delete variants:
 *
 *   Channel delete  (record.channel is set):
 *     Ends the listing(s) for the scoped market(s) only.
 *     Sets { listingStatus:'ENDED', isPublished:false, offerActive:false }.
 *     Does NOT touch the Product row or any other channel.
 *
 *     markets behaviour (C2):
 *       string[]  → end each market individually (per-market inverse capture + write).
 *       'ALL'     → findMany the distinct affected marketplaces, then loop per-market
 *                   (same as string[] path — NEVER capture-one/write-many).
 *       undefined → SKIP with detail 'delete skipped: no market scope' (footgun M3).
 *
 *   Master delete   (no channel, sheet='Products'):
 *     Soft-deletes the product via deletedAt=now().
 *     Cascades the same soft-delete to all immediate children
 *     (where parentId = product.id AND deletedAt IS NULL).
 *     I2b: cascade runs BEFORE the parent write so a cascade failure keeps
 *     the parent alive (atomic within the record).
 *     C1: children are found before the cascade and their ids are stored in
 *     an InverseCell so T9 rollback can null their deletedAt back.
 *
 * Typed-confirm gate (required):
 *   opts.deleteConfirmation MUST equal deleteConfirmationPhrase(diff) before
 *   any DB write is attempted. A mismatch throws immediately.
 *
 * Inverse diff:
 *   Captures the previous state of the columns being overwritten, enabling
 *   a future rollback pass.
 *
 * M2 note: deleteConfirmationPhrase counts ALL entries in diff.deletes
 *   (both master-delete rows AND channel-end rows) in its "N PRODUCTS" total.
 *   The phrase is intentionally a typed-confirm gate, not an exact semantic count.
 */
export function deleteConfirmationPhrase(diff: ImportDiff): string {
  // M2: diff.deletes includes both master-delete rows and channel-end rows;
  // the phrase counts all of them even though channel-ends are not product deletes.
  return 'DELETE ' + diff.deletes.length + ' PRODUCTS'
}

export async function applyDeletes(
  prisma: any,
  diff: ImportDiff,
  opts: { deleteConfirmation: string },
): Promise<ApplyResult> {
  // ── Typed-confirm gate — throw BEFORE any write ────────────────────────────
  if (opts.deleteConfirmation !== deleteConfirmationPhrase(diff)) {
    throw new Error('delete confirmation phrase does not match')
  }

  const rows: ApplyRowResult[] = []
  const inverseDiff: InverseCell[] = []
  let applied = 0
  let skipped = 0
  let failed = 0

  // ── Inner delete function (runs inside $transaction or directly) ────────────

  const deleteFn = async (tx: any): Promise<void> => {
    for (const record of diff.deletes) {
      const { sku } = record

      try {
        if (record.channel) {
          // ── Channel delete: end the scoped market listing(s) ────────────────
          const endData = {
            listingStatus: 'ENDED',
            isPublished: false,
            offerActive: false,
          }

          const markets = record.markets

          if (markets === undefined) {
            // C2: no market scope defined — skip rather than end all markets (footgun M3)
            skipped++
            rows.push({ sku, status: 'SKIPPED', detail: 'delete skipped: no market scope' })
            continue
          } else if (markets === 'ALL') {
            // C2: find all distinct markets via findMany, then loop per-market.
            // NEVER capture-one/write-many: every market gets its own inverse capture + write.
            const allListings = await tx.channelListing.findMany({
              where: { product: { sku }, channel: record.channel },
              select: { marketplace: true },
            })
            const distinctMarkets = [
              ...new Set(allListings.map((l: { marketplace: string }) => l.marketplace)),
            ] as string[]

            for (let i = 0; i < distinctMarkets.length; i++) {
              const mkt = distinctMarkets[i]
              const before = await tx.channelListing.findFirst({
                where: { product: { sku }, channel: record.channel, marketplace: mkt },
              })
              if (before) {
                inverseDiff.push({
                  model: 'ChannelListing',
                  sku,
                  channel: record.channel,
                  market: mkt,
                  data: captureInverse(endData, before),
                })
              }
              await tx.channelListing.updateMany({
                where: { product: { sku }, channel: record.channel, marketplace: mkt },
                data: endData,
              })
            }
          } else {
            // string[] — end each scoped market individually
            for (let i = 0; i < markets.length; i++) {
              const market = markets[i]
              const before = await tx.channelListing.findFirst({
                where: { product: { sku }, channel: record.channel, marketplace: market },
              })
              if (before) {
                inverseDiff.push({
                  model: 'ChannelListing',
                  sku,
                  channel: record.channel,
                  market,
                  data: captureInverse(endData, before),
                })
              }
              await tx.channelListing.updateMany({
                where: { product: { sku }, channel: record.channel, marketplace: market },
                data: endData,
              })
            }
          }

          applied++
          rows.push({ sku, status: 'SUCCESS' })
        } else {
          // ── Master delete: soft-delete product + cascade to children ─────────
          const now = new Date()
          const deleteData = { deletedAt: now }

          // Read current product to get its id for cascade + capture inverse.
          const before = await tx.product.findFirst({ where: { sku } })
          if (before) {
            inverseDiff.push({
              model: 'Product',
              sku,
              data: captureInverse(deleteData, before),
            })
          }

          // C1 + I2b: cascade children BEFORE writing the parent.
          // Order matters for atomicity: if the cascade throws the parent stays alive.
          // Also capture children's inverse here so T9 rollback can restore them.
          if (before && before.id !== undefined && before.id !== null) {
            // C1: find non-deleted children before the cascade so their ids are known.
            const affectedChildren = await tx.product.findMany({
              where: { parentId: before.id, deletedAt: null },
              select: { id: true },
            })
            const childIds = affectedChildren.map((c: { id: string }) => c.id) as string[]

            if (childIds.length > 0) {
              // C1: children inverse — shape carries __restoreChildrenOf so T9 rollback
              // issues: product.updateMany({ where:{ id:{ in: childIds } }, data:{ deletedAt:null } })
              inverseDiff.push({
                model: 'Product',
                sku,
                data: { __restoreChildrenOf: before.id, childIds, deletedAt: null },
              })
            }

            // I2b: cascade first (atomicity — if this throws, parent write below is skipped)
            await tx.product.updateMany({
              where: { parentId: before.id, deletedAt: null },
              data: { deletedAt: now },
            })
          }

          // Primary soft-delete — runs AFTER cascade so a cascade failure keeps parent alive
          await tx.product.updateMany({ where: { sku }, data: deleteData })

          applied++
          rows.push({ sku, status: 'SUCCESS' })
        }
      } catch (err) {
        failed++
        rows.push({
          sku,
          status: 'FAILED',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ── Execute: transactionally if available, directly otherwise ───────────────
  if (typeof prisma.$transaction === 'function') {
    await prisma.$transaction(deleteFn)
  } else {
    await deleteFn(prisma)
  }

  return { applied, skipped, failed, rows, inverseDiff }
}
