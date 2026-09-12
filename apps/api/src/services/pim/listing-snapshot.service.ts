import { WorkspaceScopeError } from './workspace-destination.js'
/**
 * PES.5 / D1 wave-1 — publish snapshots and restore-to-draft.
 *
 * The doctrine (Owner ruling #110), and each clause is load-bearing:
 *
 *   1. Every publish captures a snapshot of what was SENT.
 *   2. Restore writes that back as a DRAFT — never straight to live.
 *   3. Restoring auto-snapshots the CURRENT state first, so the restore is
 *      itself undoable.
 *
 * ── What "restore to draft" means with this schema ──────────────────────────
 * There is no separate draft LAYER on `ChannelListing`; the row is the listing.
 * So a restore writes the snapshot's values onto the row AND sets
 * `isPublished = false`, which is what stops the outbound push. The channel
 * keeps serving the old live content until an operator explicitly publishes.
 *
 * That is the honest reading of "never straight to live" against the schema we
 * have: the local record changes, the marketplace does not. It is stated here
 * rather than implied because a reader could reasonably assume a restore
 * reaches the channel — it does not, and must not.
 *
 * ── This module makes no channel calls ─────────────────────────────────────
 * Capturing and restoring are local-only. Actually pushing a restored state to
 * a marketplace goes through the existing publish path, explicitly, and stays
 * gated exactly as it is today.
 */

export type SnapshotReason = 'pre-publish' | 'pre-restore' | 'manual'

export interface SnapshotSummary {
  id: string
  reason: SnapshotReason | string
  label: string | null
  publishEventId: string | null
  capturedBy: string | null
  createdAt: string
  restoredAt: string | null
  restoredBy: string | null
  /** Bytes of the stored payload — a list can show weight without loading it. */
  sizeBytes: number
}

export class SnapshotNotFoundError extends Error {
  readonly code = 'snapshot_not_found'
  constructor(readonly id: string) {
    super(`No snapshot with id "${id}"`)
    this.name = 'SnapshotNotFoundError'
  }
}

export class SnapshotCoordinateMismatchError extends Error {
  readonly code = 'snapshot_coordinate_mismatch'
  constructor(readonly snapshotCoord: string, readonly targetCoord: string) {
    super(
      `That snapshot was taken on ${snapshotCoord} and cannot be restored onto ${targetCoord}. ` +
        'Restoring across coordinates would write one market\'s content onto another.',
    )
    this.name = 'SnapshotCoordinateMismatchError'
  }
}

/**
 * The listing fields a snapshot captures and a restore writes back. Deliberately
 * an explicit list, not a spread of the row: `id`, `version`, `createdAt`,
 * `externalListingId` and the sync bookkeeping must NEVER be restored — writing
 * a stale `externalListingId` back would re-point the local record at whatever
 * listing it used to be.
 */
export const SNAPSHOT_FIELDS = [
  'title', 'description', 'price', 'salePrice', 'quantity',
  'platformAttributes', 'overrideData', 'flatFileSnapshot',
  'titleOverride', 'descriptionOverride', 'priceOverride', 'quantityOverride', 'bulletPointsOverride',
  'followMasterTitle', 'followMasterDescription', 'followMasterPrice',
  'followMasterQuantity', 'followMasterImages', 'followMasterBulletPoints',
  'variationTheme', 'variationMapping',
  // NOT `channelCategoryId`: that column is on VariantChannelListing, not this
  // model. Selecting it made Prisma throw on EVERY capture and restore, so the
  // whole snapshot path was dead at runtime while type-checking clean — the
  // field list is a string array, so tsc had nothing to compare it against.
  // Nothing is lost by dropping it: a channel category lives inside
  // `platformAttributes` (eBay's `{ categoryId, ... }` bag), already captured.
] as const

const listingSelect = Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, true]))

const coordOf = (c: { channel: string; marketplace: string; aliasKey: string }) =>
  `${c.channel}:${c.marketplace}${c.aliasKey ? `#${c.aliasKey}` : ''}`

/** Read the restorable state of a listing. Pure select — no channel call. */
async function captureState(listingId: string) {
  const { default: prisma } = await import('../../db.js')
  return prisma.channelListing.findUnique({
    where: { id: listingId },
    select: { id: true, productId: true, channelConnectionId: true, version: true, channel: true, marketplace: true, aliasKey: true, ...listingSelect },
  })
}

export interface CaptureInput {
  channelListingId: string
  reason: SnapshotReason
  /** For a pre-publish capture: the payload actually SENT, not a re-render. */
  payload?: unknown
  label?: string
  publishEventId?: string | null
  capturedBy?: string | null
}

/**
 * Capture a snapshot.
 *
 * ⚠ For `pre-publish`, pass the payload that was actually SENT. Re-reading the
 * listing instead would record what we *would* send now, which can differ from
 * what the channel received — and a snapshot that does not match what went out
 * is worse than none, because a restore from it silently rewrites history.
 * When no payload is supplied the listing state is captured and the reason is
 * recorded, so the difference stays visible rather than assumed.
 */
export async function captureSnapshot(input: CaptureInput) {
  const { default: prisma } = await import('../../db.js')
  const state = await captureState(input.channelListingId)
  if (!state) throw new SnapshotNotFoundError(input.channelListingId)

  const payload = input.payload ?? { __capturedFrom: 'listing-state', state }

  return prisma.channelListingSnapshot.create({
    data: {
      channelListingId: state.id,
      channel: state.channel,
      marketplace: state.marketplace,
      aliasKey: state.aliasKey,
      reason: input.reason,
      publishEventId: input.publishEventId ?? null,
      payload: payload as object,
      label: input.label ?? null,
      capturedBy: input.capturedBy ?? null,
    },
  })
}

export async function listSnapshots(channelListingId: string, limit = 50, scope?: { productId: string; accountId: string }): Promise<SnapshotSummary[]> {
  const { default: prisma } = await import('../../db.js')
  const rows = await prisma.channelListingSnapshot.findMany({
    where: { channelListingId, ...(scope ? { OR: [
      { AND: [{ payload: { path: ['state', 'productId'], equals: scope.productId } }, { payload: { path: ['state', 'channelConnectionId'], equals: scope.accountId } }] },
      { AND: [{ payload: { path: ['productId'], equals: scope.productId } }, { payload: { path: ['channelConnectionId'], equals: scope.accountId } }] },
    ] } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Math.max(1, limit)),
  })
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    label: r.label,
    publishEventId: r.publishEventId,
    capturedBy: r.capturedBy,
    createdAt: r.createdAt.toISOString(),
    restoredAt: r.restoredAt?.toISOString() ?? null,
    restoredBy: r.restoredBy ?? null,
    sizeBytes: Buffer.byteLength(JSON.stringify(r.payload ?? null), 'utf8'),
  }))
}

export interface RestoreResult {
  restored: true
  snapshotId: string
  /**
   * The listing's version AFTER the restore, read back from the row (#201).
   *
   * A restore rewrites listing content, so it MUST advance the token — this
   * path did not. A client holding the pre-restore version then passed CAS and
   * silently overwrote the restore, the same shape as the master
   * `POST /restore` defect (#220) on the other operator-facing undo path.
   */
  currentVersion: number
  versionOf: 'channelListing'
  /** The auto-snapshot of the state that was replaced — the undo of this undo. */
  undoSnapshotId: string
  /** Always false after a restore: the channel is NOT touched. */
  isPublished: boolean
  fieldsWritten: string[]
}

/**
 * Restore a snapshot ONTO ITS OWN LISTING as a draft.
 *
 * Order matters and is enforced by the transaction: the current state is
 * snapshotted FIRST, so a restore can always be undone even if the write that
 * follows is the thing that went wrong.
 */
export async function restoreToDraft(input: {
  snapshotId: string
  productId: string
  listingId: string
  accountId: string
  expectedVersion?: number
  restoredBy?: string | null
}): Promise<RestoreResult> {
  const { default: prisma } = await import('../../db.js')

  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion! < 0) throw new WorkspaceScopeError('An observed listing version is required.', 400)
  const snap = await prisma.channelListingSnapshot.findUnique({ where: { id: input.snapshotId } })
  if (!snap) throw new SnapshotNotFoundError(input.snapshotId)
  if (snap.channelListingId !== input.listingId) throw new WorkspaceScopeError('This snapshot belongs to another listing.')

  const target = await captureState(snap.channelListingId)
  if (!target) throw new SnapshotNotFoundError(snap.channelListingId)
  if (target.productId !== input.productId || target.channelConnectionId !== input.accountId || target.version !== input.expectedVersion) throw new WorkspaceScopeError('This listing changed or belongs to another destination. Reload before restoring.')

  // A snapshot carries its coordinate; refuse to land it on a different one.
  // The listing could have been re-pointed since capture, and writing IT's
  // content onto DE is not a restore, it is a corruption.
  const from = coordOf(snap)
  const to = coordOf(target)
  if (from !== to) throw new SnapshotCoordinateMismatchError(from, to)

  const payload = snap.payload as Record<string, unknown> | null
  const source = (payload && typeof payload === 'object' && '__capturedFrom' in payload
    ? ((payload as { state?: Record<string, unknown> }).state ?? {})
    : (payload ?? {})) as Record<string, unknown>

  if (source.productId !== input.productId || source.channelConnectionId !== input.accountId) throw new WorkspaceScopeError('This snapshot has no matching product/account attribution and cannot be restored in this scope.')

  // Only fields the snapshot actually carries, and only ones on the allow-list.
  const data: Record<string, unknown> = {}
  for (const f of SNAPSHOT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, f)) data[f] = source[f]
  }

  const result = await prisma.$transaction(async (tx) => {
    const undo = await tx.channelListingSnapshot.create({
      data: {
        channelListingId: target.id,
        channel: target.channel,
        marketplace: target.marketplace,
        aliasKey: target.aliasKey,
        reason: 'pre-restore',
        payload: { __capturedFrom: 'listing-state', state: target } as object,
        label: `Before restoring ${snap.label ?? snap.id}`,
        capturedBy: input.restoredBy ?? null,
      },
    })

    const updated = await tx.channelListing.update({
      where: { id: target.id, version: input.expectedVersion, productId: input.productId, channelConnectionId: input.accountId },
      data: {
        ...data,
        // THE doctrine clause. A restore must never reach the marketplace; the
        // operator publishes explicitly, through the existing gated path.
        isPublished: false,
        listingStatus: 'DRAFT',
        // A restore changes content, so it advances the concurrency token like
        // any other write. Omitting it let a stale client's CAS succeed and undo
        // the restore without a 409 — the guard failing exactly where it is most
        // needed, on an undo path.
        version: { increment: 1 },
      },
      select: { version: true },
    })

    await tx.channelListingSnapshot.update({
      where: { id: snap.id },
      data: { restoredAt: new Date(), restoredBy: input.restoredBy ?? null },
    })

    return {
      restored: true as const,
      snapshotId: snap.id,
      undoSnapshotId: undo.id,
      isPublished: false,
      fieldsWritten: Object.keys(data),
      currentVersion: updated.version,
      versionOf: 'channelListing' as const,
    }
  }).catch(error => {
    if (error?.code === 'P2025') throw new WorkspaceScopeError('This listing changed while restoring. Reload and review the current version.')
    throw error
  })

  // ── After the transaction commits ────────────────────────────────────────
  // Outside it deliberately: a broadcast or event-log failure must not roll back
  // a restore the operator already committed to, and neither belongs in a
  // database transaction's critical section.
  //
  // Without these the restore was invisible to every other replica and tab —
  // the row changed and nothing was told, so a cross-replica cache kept serving
  // the pre-restore content.
  try {
    const { publishListingEvent } = await import('../listing-events.service.js')
    publishListingEvent({
      type: 'listing.updated',
      listingId: snap.channelListingId,
      reason: 'snapshot-restore',
      ts: Date.now(),
    })
  } catch {
    // Best-effort: the write already committed, and a refresh that did not fire
    // must not be reported to the operator as a restore that did not happen.
  }

  try {
    const { productEventService } = await import('../product-event.service.js')
    void productEventService.emit({
      aggregateId: snap.channelListingId,
      aggregateType: 'ChannelListing',
      eventType: 'CHANNEL_LISTING_UPDATED',
      data: {
        restoredFromSnapshot: result.snapshotId,
        undoSnapshotId: result.undoSnapshotId,
        fields: result.fieldsWritten,
      },
      metadata: { source: 'OPERATOR', userId: input.restoredBy ?? null, layer: 'channel', channel: target.channel, marketplace: target.marketplace, accountId: input.accountId, aliasKey: target.aliasKey },
    })
  } catch {
    // As above — the event log is downstream of the restore, not a gate on it.
  }

  return result
}
