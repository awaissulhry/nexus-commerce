/**
 * S10 (per-channel SKU, Owner D2 = A, 2026-10-05) — moving a LIVE Amazon listing to a new seller SKU is ONE Publish:
 * it creates NEW (the listing's own SKU, `ChannelListing.channelSku`) as a new offer on the same ASIN, and only after
 * Amazon ACCEPTS NEW it deletes OLD (the SKU Amazon held) in that market. If Amazon refuses NEW, OLD stays and nothing is
 * deleted. Amazon is per market: the delete reaches this marketplace only (EU markets are separate).
 *
 *   - Review (`amazonMoveReview`): each moved row says "Creates NEW on Amazon · IT as a new offer, then deletes OLD
 *     there."; an FBA row adds that NEW starts with no FBA units and Amazon's stay under OLD (with Nexus's last count);
 *     the review asks for the typed confirmation Delete asks for (the family SKU, `confirm: 'DELETE'`).
 *   - Claim (`claimMoveCoordinates`): on a SHARED account the coordinate NEW is claimed for this business before anything
 *     is sent (another business holding it refuses the Publish by name).
 *   - Settle (`finishAmazonMovesAfterResult`, after `storeResult` committed; `recoverAmazonMoves` from the result sweep):
 *     NEW accepted → OLD deleted through the Delete path's channel half (`deleteAmazonListingOnChannel`), OLD's claim
 *     released, OLD's offer rows closed, an audit record kept (`ChannelListingSnapshot`, reason `sku-move`). The SKU
 *     Amazon holds (`liveChannelSku` = NEW) is recorded by the settle core from the journal, as for every accepted publish.
 *     NEW refused → nothing is deleted; the result says OLD stays. Exactly once: a compare-and-set marker
 *     (`changes.skuMoveFinish`) is taken before any channel call; a run that died mid-way is taken again after a lease.
 *
 * The row itself stays the same listing (same ASIN, same Nexus row): it is never returned to draft.
 */
import { Prisma } from '@prisma/client'
import type { StudioPublishConfirm, StudioPublishResult, StudioPublishSkuMove } from '@nexus/shared/studio-publication'
import type { FbaUnits } from '@nexus/shared/listing-actions'
import { amazonMoveConfirmSentence, amazonMoveSentence, bothSkusSell, DELETE_OLD_SKU_AGAIN, fbaMoveWarning } from '@nexus/shared/publish-actions'
import type { HistorySkuMove } from '@nexus/shared/publication-history'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { channelPlace } from '@nexus/shared/channel-label'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { object, type PublicationFacts } from './studio-publication-plan.js'
import type { AmazonPublication, AmazonSkuMove } from './studio-publication-amazon.js'
import { PUBLICATION_KIND, json } from './studio-publication-settle.js'
import { CHANNEL_SKU_LISTING_SELECT, listingsThatMayHoldSkus } from '../listings/channel-sku.js'
import { liveChannelSku } from '../listings/channel-sku.pure.js'

/** What a publication keeps about one move (`changes.skuMoves`): the move, its market, and what became of OLD. */
export interface StoredSkuMove extends AmazonSkuMove {
  marketplaceId: string
  /** Set by the finisher: what became of OLD. */
  state?: SkuMoveState
  /** The sentence the result shows for this move. */
  message?: string
}

/**
 * `deleted`: Amazon took the delete of OLD. `kept`: Amazon refused NEW, so OLD stays (nothing deleted). `shared`: another
 * listing of this business still sells OLD here, so it was not deleted. `not-sent`: this server does not send to Amazon.
 * `failed`: Amazon did not confirm the delete (its words are kept); the sweep tries again, then a person must.
 */
export type SkuMoveState = 'deleted' | 'kept' | 'shared' | 'not-sent' | 'failed'

/** The marker in `BulkOperation.changes`: the moves of this publication were finished ('done'), or are being ('running:<iso>'). */
export const SKU_MOVE_MARKER = 'skuMoveFinish'
/** A run that died mid-way is taken again after this long. */
const RUNNING_LEASE_MS = 10 * 60_000
/** A delete Amazon did not confirm is tried again by the sweep this many times, then left to a person. */
const MAX_DELETE_TRIES = 5

const where = (marketplace: string) => channelPlace('AMAZON', marketplace)

// ── Review ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Amazon's FBA units under ONE seller SKU in one marketplace, as Nexus last read them (`FbaInventoryDetail`); null when
 * Nexus holds none. The read time is the oldest contributing row. Never throws: an unreadable count is null.
 */
export async function fbaUnitsUnderSku(marketplaceId: string, sku: string): Promise<FbaUnits | null> {
  try {
    const rows = await prisma.fbaInventoryDetail.findMany({ where: { marketplaceId, sku }, select: { condition: true, quantity: true, lastSyncedAt: true } })
    if (!rows.length) return null
    const units: FbaUnits = { sellable: 0, inbound: 0, reserved: 0, other: 0, readAt: rows.map(row => row.lastSyncedAt.toISOString()).sort()[0] ?? null }
    for (const row of rows) {
      const quantity = Math.max(0, row.quantity)
      if (row.condition === 'SELLABLE') units.sellable += quantity
      else if (row.condition === 'INBOUND') units.inbound += quantity
      else if (row.condition === 'RESERVED') units.reserved += quantity
      else units.other += quantity
    }
    return units
  } catch (error) {
    logger.warn('[sku-move] FBA units unreadable; the move warning names no count', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/** The review's words for each moved row, and the typed confirmation the review needs (null when nothing moves). */
export async function amazonMoveReview(facts: Pick<PublicationFacts, 'scope' | 'parent'>, prepared: { marketplaceId: string | null; moves?: AmazonPublication['moves'] } | null) {
  const rows = new Map<string, StudioPublishSkuMove>()
  const moves = prepared?.moves ?? []
  if (!moves.length) return { rows, confirm: null as StudioPublishConfirm | null }
  const here = where(facts.scope.marketplace)
  for (const move of moves) {
    // No marketplace identifier (a review that could not be prepared): the warning names no count.
    const units = prepared!.marketplaceId ? await fbaUnitsUnderSku(prepared!.marketplaceId, move.from) : null
    const warning = move.fba ? fbaMoveWarning(units, move.to, move.from) : null
    rows.set(move.productId, { from: move.from, to: move.to, kind: 'create-delete', sentence: amazonMoveSentence(move.to, move.from, here), warning })
  }
  const confirm: StudioPublishConfirm = { kind: 'type', expected: facts.parent.sku, token: 'DELETE', sentence: amazonMoveConfirmSentence(moves, here) }
  return { rows, confirm }
}

// ── Claim ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * On a SHARED account (business profiles on), claim each NEW coordinate for this business before anything is sent
 * (`assertClaimed`). Another business holding it throws its sentence: nothing is sent. An account with one business
 * needs no claim (the claim service's own gate).
 */
export async function claimMoveCoordinates(scope: { accountId: string; marketplace: string }, moves: ReadonlyArray<Pick<AmazonSkuMove, 'to' | 'listingId'>>): Promise<void> {
  if (!moves.length || process.env.NEXUS_WORKSPACES_ENABLED !== '1') return
  const { assertClaimed } = await import('../listing-claim.service.js')
  for (const move of moves) await assertClaimed({ connectionId: scope.accountId, marketplace: scope.marketplace, sellerSku: move.to, channelListingId: move.listingId })
}

// ── Settle ───────────────────────────────────────────────────────────────────────────────────────────

/** The moves a publication keeps, read back (anything malformed is left out: it was never sent as a move). */
export function storedMoves(data: Record<string, any>): StoredSkuMove[] {
  const moves = Array.isArray(data?.skuMoves) ? data.skuMoves : []
  return moves.filter((move: any) => move && typeof move.productId === 'string' && typeof move.listingId === 'string' && typeof move.from === 'string'
    && typeof move.to === 'string' && move.from && move.to && typeof move.marketplaceId === 'string') as StoredSkuMove[]
}

const FINAL: ReadonlySet<SkuMoveState> = new Set(['deleted', 'kept', 'shared', 'not-sent'])
/** Amazon's answers under which the moves are settled (a publication still in flight settles nothing). */
const SETTLED_RESULTS: ReadonlySet<string> = new Set(['ACCEPTED', 'PARTIAL', 'FAILED'])

/**
 * Change a publication's `changes` by a compare-and-set on the whole document, re-read and retried when another writer
 * (the offer promotion, the content settle) changed it meanwhile: only the keys `patch` returns are written over the
 * fresh document. Returns the written document, or null when `patch` declines (returns null) or the row is gone.
 */
async function patchChanges(publicationId: string, patch: (data: Record<string, any>) => Record<string, unknown> | null): Promise<Record<string, any> | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.bulkOperation.findFirst({ where: { id: publicationId }, select: { changes: true } })
    if (!row?.changes) return null
    const data = object(row.changes)
    const keys = patch(data)
    if (!keys) return null
    const next = { ...data, ...keys }
    const written = await prisma.bulkOperation.updateMany({ where: { id: publicationId, changes: { equals: row.changes } }, data: { changes: json(next) } })
    if (written.count === 1) return next
  }
  throw new Error('The publication record kept changing; its moves are finished by the next sweep.')
}

/** Take the publication's moves for this run: compare-and-set the marker. Null = done, or another run holds them. */
async function takeMoves(publicationId: string, now: Date): Promise<Record<string, any> | null> {
  return patchChanges(publicationId, data => {
    if (data.kind !== PUBLICATION_KIND || !storedMoves(data).length) return null
    const marker = data[SKU_MOVE_MARKER]
    if (marker === 'done') return null
    if (typeof marker === 'string' && marker.startsWith('running:') && now.getTime() - Date.parse(marker.slice(8)) < RUNNING_LEASE_MS) return null
    return { [SKU_MOVE_MARKER]: `running:${now.toISOString()}` }
  })
}

/** Another listing of this business still sells OLD on this account and market (then OLD is not deleted). */
async function oldStillSold(move: StoredSkuMove, scope: { accountId: string; marketplace: string }): Promise<boolean> {
  const held = await listingsThatMayHoldSkus(prisma as never, { skus: [move.from], connectionId: scope.accountId, channel: 'AMAZON', marketplace: scope.marketplace })
  const others = held.filter(row => row.listingId !== move.listingId)
  if (!others.length) return false
  const rows = await prisma.channelListing.findMany({ where: { id: { in: others.map(row => row.listingId) } }, select: CHANNEL_SKU_LISTING_SELECT })
  return rows.some(row => !isStillDraftListing(row) && liveChannelSku(row, row.product?.sku)?.sku === move.from)
}

/**
 * OLD was not deleted yet: why, that Nexus tries again by itself, that both SKUs sell meanwhile, and the Nexus action that
 * tries it now (never "go to Seller Central": the flow stays in Nexus).
 */
const notDeleted = (move: Pick<StoredSkuMove, 'from' | 'to'>, here: string, why: string) =>
  `${move.to} is live on ${here}. ${move.from} was not deleted yet: ${why}. Nexus tries again by itself; to try now, open this publish in Publish history and choose "${DELETE_OLD_SKU_AGAIN}". ${bothSkusSell(move.from, move.to, here)}`

/** After the last automatic try: Nexus stops trying by itself, and the person has the Nexus action. */
const gaveUpDeleting = (move: Pick<StoredSkuMove, 'from' | 'to'>, here: string, tries: number) =>
  `${move.to} is live on ${here}. Amazon did not confirm the delete of ${move.from} after ${tries} tries, so Nexus stopped trying by itself. To try again, open this publish in Publish history and choose "${DELETE_OLD_SKU_AGAIN}". ${bothSkusSell(move.from, move.to, here)}`

/** Delete OLD on Amazon (the Delete path's channel half), and what the result says about it. */
async function deleteOld(move: StoredSkuMove, scope: { accountId: string; marketplace: string }, publicationId: string, actor: string | null): Promise<{ state: SkuMoveState; message: string }> {
  const here = where(scope.marketplace)
  if (await oldStillSold(move, scope)) return { state: 'shared', message: `${move.to} is live on ${here}. ${move.from} is still the SKU of another listing here, so Nexus did not delete it.` }
  const [{ getAmazonSellerId }, { deleteAmazonListingOnChannel }, { readAmazonOfferLive }] = await Promise.all([
    import('../../lib/amazon-sp-client.js'), import('../channel-delist.service.js'), import('../amazon/purchasable-offer.js')])
  let sellerId: string
  try { sellerId = await getAmazonSellerId(scope.accountId); if (!sellerId) throw new Error('no seller id') }
  catch (error) { return { state: 'failed', message: notDeleted(move, here, `the Amazon account has no seller id (${error instanceof Error ? error.message : String(error)})`) } }
  // Amazon's own fulfilment answer for OLD, kept on the audit record (as the Delete keeps it).
  const live = await readAmazonOfferLive({ sellerId, sku: move.from, marketplaceId: move.marketplaceId }).catch(() => null)
  const fulfillmentChannels = live?.read === 'ok' ? live.fulfillmentChannels.filter(Boolean) : null
  const answer = await deleteAmazonListingOnChannel({ sellerId, sku: move.from, marketplaceId: move.marketplaceId })
  if (answer.dryRun || answer.outcome === 'NOT_SENT') return { state: 'not-sent', message: `${move.to} is live on ${here}. Amazon writes are in preview mode on this server, so ${move.from} was not deleted.` }
  if (!answer.success) return { state: 'failed', message: notDeleted(move, here, `Amazon did not confirm it (${answer.error ?? 'no answer'})`) }
  // The coordinate OLD is free again (shared accounts), its offer rows no longer sell here, and the audit record says so.
  try {
    if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
      const { releaseCoordinate } = await import('../listing-claim.service.js')
      await releaseCoordinate({ connectionId: scope.accountId, marketplace: scope.marketplace, sellerSku: move.from })
    }
  } catch (error) { logger.warn('[sku-move] the old SKU\'s claim was not released', { publicationId, sku: move.from, error: error instanceof Error ? error.message : String(error) }) }
  await prisma.offer.updateMany({ where: { channelListingId: move.listingId, sku: move.from, isActive: true }, data: { isActive: false } })
  const listing = await prisma.channelListing.findUnique({ where: { id: move.listingId }, select: { aliasKey: true } })
  await prisma.channelListingSnapshot.create({ data: { channelListingId: move.listingId, channel: 'AMAZON', marketplace: scope.marketplace.toUpperCase(),
    aliasKey: listing?.aliasKey ?? '', reason: 'sku-move', publishEventId: publicationId, outcome: 'ACCEPTED', acceptedAt: new Date(), label: `Moved to ${move.to} · ${here}`, capturedBy: actor ?? 'publish',
    payload: { kind: 'sku-move', from: move.from, to: move.to, asin: move.asin, fba: move.fba, submissionId: answer.submissionId ?? null, fulfillmentChannels } as never } })
  return { state: 'deleted', message: `${move.to} is live on ${here}; ${move.from} was deleted there.` }
}

/**
 * Finish the moves of one publication whose Amazon result is known: delete OLD for each NEW Amazon accepted, keep OLD
 * where NEW was refused. Records each move's state and sentence on the publication (`changes.skuMoves`), adds the
 * sentences to its stored result (and to `result`, the caller's copy, so the answer it returns says them). Returns the
 * states, or null when there was nothing to do (no moves, already finished, or another run holds them).
 */
export async function finishAmazonMoves(publicationId: string, result: StudioPublishResult, options: { actor: string | null; now?: Date }): Promise<StoredSkuMove[] | null> {
  if (!SETTLED_RESULTS.has(result.status)) return null
  const now = options.now ?? new Date()
  const data = await takeMoves(publicationId, now)
  if (!data) return null
  const scope = { accountId: String(data.scope?.accountId ?? ''), marketplace: String(data.scope?.marketplace ?? '') }
  const tries = Number(data.skuMoveTries ?? 0) + 1
  const moves: StoredSkuMove[] = []
  for (const move of storedMoves(data)) {
    if (move.state && FINAL.has(move.state)) { moves.push(move); continue }
    const row = result.results.find(entry => entry.sku === move.to)
    if (!row || row.status === 'FAILED' || row.status === 'SUBMITTED') {
      moves.push({ ...move, state: 'kept', message: `Amazon did not accept ${move.to}, so ${move.from} stays on ${where(scope.marketplace)} and nothing was deleted.` })
      continue
    }
    try { moves.push({ ...move, ...await deleteOld(move, scope, publicationId, options.actor) }) }
    catch (error) {
      moves.push({ ...move, state: 'failed', message: notDeleted(move, where(scope.marketplace), error instanceof Error ? error.message : String(error)) })
    }
  }
  const open = moves.filter(move => move.state === 'failed')
  const gaveUp = open.length > 0 && tries >= MAX_DELETE_TRIES
  // A delete Amazon did not confirm is tried again by the sweep; after the last try the sentence names the Nexus action
  // that tries it again ("Delete the old SKU again", `deleteOldSkuAgain`).
  const final = moves.map(move => move.state === 'failed' && gaveUp ? { ...move, message: gaveUpDeleting(move, where(scope.marketplace), tries) } : move)
  const sentences = final.map(move => move.message!).filter(Boolean)
  // An earlier run's sentences are replaced by this run's (a retried delete says its newest outcome only).
  const earlier = new Set(storedMoves(data).map(move => move.message).filter((message): message is string => !!message))
  const withMoves = (target: StudioPublishResult): StudioPublishResult =>
    ({ ...target, warnings: [...new Set([...(target.warnings ?? []).filter(warning => !earlier.has(warning)), ...sentences])] })
  await patchChanges(publicationId, fresh => ({ skuMoves: final, skuMoveTries: tries, [SKU_MOVE_MARKER]: open.length && !gaveUp ? null : 'done',
    ...(fresh.result ? { result: withMoves(object(fresh.result) as unknown as StudioPublishResult) } : {}) }))
  result.warnings = withMoves(result).warnings
  // The publish history and a batch list the publication by its summary: its message says what became of OLD too.
  const summary = object((await prisma.bulkOperation.findFirst({ where: { id: publicationId }, select: { summary: true } }))?.summary)
  if (Object.keys(summary).length) await prisma.bulkOperation.updateMany({ where: { id: publicationId },
    data: { summary: json({ ...summary, message: [result.message, ...sentences].filter(Boolean).join(' ') }) } })
  if (final.some(move => move.state === 'deleted')) {
    void import('../listing-events.service.js').then(({ publishListingEvent }) => {
      for (const move of final.filter(entry => entry.state === 'deleted')) publishListingEvent({ type: 'listing.updated', listingId: move.listingId, reason: 'sku-move', ts: Date.now() })
    }).catch(() => undefined)
  }
  return final
}

/**
 * "Delete the old SKU again" (Publish history → a publish that moved a live Amazon listing) — the person's own try of
 * the deletes Amazon did not confirm. It re-arms only those moves (a move already deleted, kept or shared is never touched)
 * and runs the same finisher now, through the same Delete channel half. The automatic tries start again after it.
 * Refused, by name: another publication, nothing left to delete, or a run of the finisher already under way.
 */
export async function deleteOldSkuAgain(productId: string, publicationId: string, actor: string | null): Promise<{ moves: HistorySkuMove[] }> {
  const { WorkspaceScopeError } = await import('./workspace-destination.js')
  const row = await prisma.bulkOperation.findFirst({ where: { id: publicationId }, select: { status: true, changes: true, productId: true } })
  const data = object(row?.changes)
  if (!row || data.kind !== PUBLICATION_KIND) throw new WorkspaceScopeError('Publication not found.', 404)
  // As the history's other actions: opened from the publication's product, or any product of its family.
  if (data.productId !== productId && row.productId !== productId) {
    const product = row.productId ? await prisma.product.findFirst({ where: { id: productId }, select: { parentId: true } }) : null
    if (!product || product.parentId !== row.productId) throw new WorkspaceScopeError('Publication not found.', 404)
  }
  if (!storedMoves(data).some(move => move.state === 'failed')) throw new WorkspaceScopeError('Nothing is left to delete again: every old SKU of this publish is deleted, kept or still waiting for Amazon.', 409)
  const marker = data[SKU_MOVE_MARKER]
  if (typeof marker === 'string' && marker.startsWith('running:') && Date.now() - Date.parse(marker.slice(8)) < RUNNING_LEASE_MS)
    throw new WorkspaceScopeError('Nexus is deleting the old SKU right now. Open this publish again in a minute.', 409)
  // Re-arm: the finisher takes the moves again (its own compare-and-set marker), and the sweep's tries start over.
  await patchChanges(publicationId, fresh => storedMoves(fresh).some(move => move.state === 'failed') ? { [SKU_MOVE_MARKER]: null, skuMoveTries: 0 } : null)
  const result = object(data.result) as unknown as StudioPublishResult
  if (!Array.isArray(result.results)) throw new WorkspaceScopeError('This publish has no result from Amazon yet.', 409)
  const moves = await finishAmazonMoves(publicationId, { ...result, status: row.status as StudioPublishResult['status'] }, { actor })
  if (!moves) throw new WorkspaceScopeError('Nexus is deleting the old SKU right now. Open this publish again in a minute.', 409)
  return { moves: historySkuMoves({ skuMoves: moves }) }
}

/** S10 — a publication's moves as the history shows them (`HistoryRunDetail.skuMoves`). */
export function historySkuMoves(data: Record<string, any>): HistorySkuMove[] {
  return storedMoves(data).map(move => ({ productId: move.productId, from: move.from, to: move.to, state: move.state ?? 'pending',
    message: move.message ?? null, canDeleteAgain: move.state === 'failed' }))
}

/** The settle core's one call, after `storeResult` committed. Never throws: a failure is logged and the sweep runs it again. */
export async function finishAmazonMovesAfterResult(publicationId: string, data: Record<string, any>, result: StudioPublishResult, userId: string | null): Promise<void> {
  if (data.scope?.channel !== 'AMAZON' || !storedMoves(data).length) return
  try { await finishAmazonMoves(publicationId, result, { actor: userId }) }
  catch (error) { logger.warn('[sku-move] finishing the moves failed; the result sweep runs it again', { publicationId, error: error instanceof Error ? error.message : String(error) }) }
}

/**
 * The result sweep's recovery: Amazon publications with moves whose result is known (the last 7 days) that are not
 * finished — the run after `storeResult` never committed, died mid-way (lease), or a delete Amazon did not confirm is
 * due again. A minute's grace leaves the normal run its turn; the marker makes a race harmless.
 */
export async function recoverAmazonMoves(now = new Date(), limit = 20): Promise<{ found: number; finished: number; failed: number }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; userId: string | null }>>(Prisma.sql`
    SELECT b.id, b."userId" FROM "BulkOperation" b
     WHERE b.kind = ${PUBLICATION_KIND} AND b.channel = 'AMAZON' AND b.status IN ('ACCEPTED', 'PARTIAL', 'FAILED')
       AND b."completedAt" <= ${new Date(now.getTime() - 60_000)} AND b."completedAt" >= ${new Date(now.getTime() - 7 * 24 * 60 * 60_000)}
       AND jsonb_typeof(b.changes -> 'skuMoves') = 'array' AND jsonb_array_length(b.changes -> 'skuMoves') > 0
       AND COALESCE(b.changes ->> ${SKU_MOVE_MARKER}, '') <> 'done'
     ORDER BY b."completedAt" ASC LIMIT ${limit}`)
  let finished = 0, failed = 0
  for (const row of rows) {
    try {
      const operation = await prisma.bulkOperation.findFirst({ where: { id: row.id }, select: { changes: true } })
      const result = object(object(operation?.changes).result) as unknown as StudioPublishResult
      if (!Array.isArray(result.results)) continue
      if (await finishAmazonMoves(row.id, result, { actor: row.userId, now })) finished++
    } catch (error) {
      failed++
      logger.warn('[sku-move] recovery failed; the next sweep tries again', { publicationId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { found: rows.length, finished, failed }
}
