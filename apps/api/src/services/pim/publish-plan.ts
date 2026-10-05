/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P6 — the mixed-plan Publish: ONE Publish of one
 * product family to one or many destinations sends the rows' content (Partial and Full update) AND their waiting
 * lifecycle values (a Status change, or the Action column's Delete), reviewed together, sent as one batch. The wire
 * shapes are shared: `@nexus/shared/publish-plan`.
 *
 *   reviewPublishPlan      → per destination: the content review (the studio's own review, made with the rows whose
 *                            stored Action is Full update; rows being ended, deleted or relisted are held back and say
 *                            why), one lifecycle row per waiting Status change or Delete (the listing-action engine's
 *                            own plan gives each its sentence), and the values the listing outgrew. It sends nothing;
 *                            its only write is the content review it saves (as the studio's preview does).
 *   preparePlanSubmit      → the send request checked against the values NOW: each ticked row still holds the value
 *                            the review saw (otherwise 409, review again); Ended and Delete need the typed family SKU
 *                            and products.delete (without products.delete they are not sent and keep waiting).
 *                            publication-batch.service.ts makes the batch from it.
 *   settleLifecycleValues  → after a lifecycle child ran: clears the values it did, and those the listing outgrew;
 *                            a failure, NOT_SENT or UNKNOWN keeps the value.
 *   afterContentSettled    → after a content result is stored (the settle core calls it): clears Full update on the
 *                            rows the channel accepted.
 *
 * Every value is cleared through `clearWaitingValues`, only if nobody changed it since the review.
 *
 * Delete and relist (Owner 2026-10-04, simplified the same day): a row Nexus deleted is a row not on the channel
 * (`PublishActionCell.create`, with `deleted`). Left Not listed (its default), its content is held on every Publish
 * (`heldOnDestination`, the reason names the delete) and the studio's review never ticks its create. Set Active or
 * Inactive, the content review lists it again (a create, ticked by default) and `afterContentSettled` clears that Status
 * choice once the channel accepted it (an older relist choice in the Action column clears the same way).
 *
 * P11 — the products list's Publish… window sets one Status on many products × markets (no stored waiting value):
 *   reviewStatusPair       → one product family × one destination: one listing-action preview per action its listings
 *                            need (the engine's own plan: every listing there where allowed, refusals with the reason),
 *                            stamped as a lifecycle child of the batch. publication-batch.processor.ts calls it in the
 *                            review stage; the submit and the send are the batch's (send order as above).
 */
import type { StudioPublishReview, StudioPublishResult, StudioPublishScope } from '@nexus/shared/studio-publication'
import { deletedPublishSkip, NOT_LISTED_LEFT_OUT, NOT_LISTED_MAIN_HELD, statusChangeAction, STATUS_TARGET_LABEL, type ListingAction, type ListingActionDestination, type ListingActionPlanRow,
  type ListingActionPreview, type ListingActionRunResult, type StatusTarget } from '@nexus/shared/listing-actions'
import { AMAZON_MOVE_ROLE_CANNOT_DELETE, CONTENT_HELD_FOR_DELETE, CONTENT_HELD_FOR_END, isStaleWaiting, needsTypedConfirm, publishPlanSummary, SEND_ORDER,
  type PublishActionCell } from '@nexus/shared/publish-actions'
import { CONTENT_HELD_FOR_RELIST, confirmMatches, lifecycleStep, MAX_PLAN_DESTINATIONS, publishPlanCounts, ROLE_CANNOT_END_OR_DELETE,
  STATUS_TARGET_ACTIONS, TYPE_TO_CONFIRM, type ListedStatusTarget, type PublishPlan, type PublishPlanColumn, type PublishPlanDestination, type PublishPlanHeldRow,
  type PublishPlanLifecycleRow, type PublishPlanOutgrownRow } from '@nexus/shared/publish-plan'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { clearWaitingValues, readPublishActions } from '../listings/publish-action.service.js'
import { object, publicationScope } from './studio-publication-plan.js'
import { blockRowChanges } from './studio-publication-selection.js'
import { json } from './studio-publication-settle.js'
import { resolveWorkspaceDestination } from './workspace-destination.js'

/** A refusal with its HTTP status and a machine code; the message is what the person reads. */
export class PublishPlanError extends Error {
  constructor(message: string, readonly statusCode = 409, readonly code = 'PUBLISH_PLAN_REFUSED') { super(message) }
}

/** Who reviews or sends, and what this request may do (the RBAC gate's resolved permissions: `permissionCheckerFor`). */
export interface PublishPlanActor {
  userId: string | null
  can: (permission: string) => boolean
}

const CHANNEL_LABEL: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }
/** "Amazon · IT", "eBay · DE", "Shopify" (as the listing-action engine names a destination). */
export const planDestinationLabel = (d: Pick<ListingActionDestination, 'channel' | 'marketplace'>) =>
  d.channel === 'SHOPIFY' || d.marketplace === 'GLOBAL' ? CHANNEL_LABEL[d.channel] ?? d.channel : `${CHANNEL_LABEL[d.channel] ?? d.channel} · ${d.marketplace}`

const MAX_ROWS = 2000
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

// ── Row ids: opaque to the web, they pin the value the review saw ────────────────────────────────

/** `v1:<column>:<listingId>:<setAt ms>:<action, or - for an outgrown value>`. */
export function planRowId(column: PublishPlanColumn, listingId: string, setAt: string, action: ListingAction | null): string {
  return `v1:${column}:${listingId}:${Date.parse(setAt)}:${action ?? '-'}`
}

export interface PlanRowRef { column: PublishPlanColumn; listingId: string; setAt: Date; action: ListingAction | null }

export function parsePlanRowId(id: unknown): PlanRowRef | null {
  if (typeof id !== 'string' || id.length > 300) return null
  const [version, column, listingId, ms, action] = id.split(':')
  if (version !== 'v1' || (column !== 'status' && column !== 'send') || !listingId || !/^\d+$/.test(ms ?? '')) return null
  if (action !== '-' && !['pause', 'resume', 'end', 'relist', 'delete'].includes(action ?? '')) return null
  return { column, listingId, setAt: new Date(Number(ms)), action: action === '-' ? null : action as ListingAction }
}

// ── The waiting values of one destination (pure) ─────────────────────────────────────────────────

/** One waiting value that still applies: it becomes a lifecycle row. */
export interface WaitingLifecycleValue {
  cell: PublishActionCell
  column: PublishPlanColumn
  value: StatusTarget | 'delete'
  action: ListingAction
  setAt: string
  setById: string | null
  setByName: string | null
}

const sameDestination = (cell: Pick<PublishActionCell, 'channel' | 'marketplace' | 'accountId' | 'aliasKey'>, d: ListingActionDestination) =>
  cell.channel === d.channel && cell.marketplace === d.marketplace && cell.accountId === d.accountId && cell.aliasKey === d.aliasKey

/**
 * PURE. A destination's rows split into what Publish does with their stored values: the Full update rows, the lifecycle
 * values (a Status target → `statusChangeAction` from the state now; Delete → 'delete'), and the values the listing
 * outgrew ("No longer applies": the read already says why; a target the row already holds is outgrown too).
 */
export function waitingValuesOf(cells: readonly PublishActionCell[]): { fullProductIds: string[]; values: WaitingLifecycleValue[]; outgrown: PublishPlanOutgrownRow[] } {
  const fullProductIds: string[] = []
  const values: WaitingLifecycleValue[] = []
  const outgrown: PublishPlanOutgrownRow[] = []
  const outgrow = (cell: PublishActionCell, column: PublishPlanColumn, value: PublishPlanOutgrownRow['value'], setAt: string | null, reason: string) => {
    if (setAt) outgrown.push({ id: planRowId(column, cell.listingId, setAt, null), listingId: cell.listingId, productId: cell.productId, sku: cell.sku, column, value, reason })
  }
  for (const cell of cells) {
    const send = cell.send
    if (send.mode !== 'partial' && send.setAt) {
      if (send.noLongerApplies) outgrow(cell, 'send', send.mode, send.setAt, send.noLongerApplies)
      else if (send.mode === 'full') fullProductIds.push(cell.productId)
      else values.push({ cell, column: 'send', value: 'delete', action: 'delete', setAt: send.setAt, setById: send.setById, setByName: send.setByName })
    }
    const status = cell.status
    // New listings: a row not on the channel holds its CREATE choice here — the content review creates it as chosen
    // (Active, Inactive) or leaves it out (Not listed); it is never a lifecycle change, and never "Already …". On a deleted
    // row a Status set before the delete no longer applies: the Publish clears it.
    if (cell.create) {
      if (cell.deleted && status.target && status.setAt && status.noLongerApplies) outgrow(cell, 'status', status.target, status.setAt, status.noLongerApplies)
      continue
    }
    if (status.target && status.setAt) {
      const action = statusChangeAction(cell.state, status.target)
      if (status.noLongerApplies) outgrow(cell, 'status', status.target, status.setAt, status.noLongerApplies)
      else if (!action) outgrow(cell, 'status', status.target, status.setAt, `Already ${STATUS_TARGET_LABEL[status.target].toLowerCase()}.`)
      else values.push({ cell, column: 'status', value: status.target, action, setAt: status.setAt, setById: status.setById, setByName: status.setByName })
    }
  }
  return { fullProductIds: [...new Set(fullProductIds)], values, outgrown }
}

/**
 * PURE. Whose content this Publish holds back on a destination, and why (`contentGoesOut`). eBay and Shopify end, delete
 * and relist a WHOLE listing (an eBay relist also makes a new item number), so any of these holds every row's content
 * there. Elsewhere (Amazon) the rows being deleted are held — every row when it is the family's main row, because the
 * engine then deletes every variation too. A value that cannot be sent (`refused`) holds nothing.
 */
export function heldContent(channel: string, familyId: string, values: ReadonlyArray<{ productId: string; action: ListingAction; refused?: string | null }>,
  products: ReadonlyArray<{ productId: string; sku: string }>): PublishPlanHeldRow[] {
  const applying = values.filter(value => !value.refused)
  const reasonOf = (action: ListingAction) => action === 'delete' ? CONTENT_HELD_FOR_DELETE : action === 'end' ? CONTENT_HELD_FOR_END : CONTENT_HELD_FOR_RELIST
  const all = (action: ListingAction) => products.map(p => ({ productId: p.productId, sku: p.sku, reason: reasonOf(action) }))
  const whole = (actions: readonly ListingAction[], from: typeof applying) => actions.find(action => from.some(value => value.action === action))
  if (channel === 'EBAY' || channel === 'SHOPIFY') {
    const action = whole(['delete', 'end', 'relist'], applying)
    return action ? all(action) : []
  }
  const main = whole(['delete', 'end'], applying.filter(value => value.productId === familyId))
  if (main) return all(main)
  const held = new Map<string, ListingAction>()
  for (const value of applying) if (value.action === 'delete' || value.action === 'end') held.set(value.productId, held.get(value.productId) === 'delete' ? 'delete' : value.action)
  return products.filter(p => held.has(p.productId)).map(p => ({ productId: p.productId, sku: p.sku, reason: reasonOf(held.get(p.productId)!) }))
}

/** The rows a destination lists (one per product, by SKU), as `heldContent` takes them. */
const listedProducts = (cells: readonly PublishActionCell[]) =>
  [...new Map(cells.map(cell => [cell.productId, { productId: cell.productId, sku: cell.sku }])).values()].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)

/**
 * The content held on one destination, from EVERY value waiting there (ticked or not, stale or not: the review and the
 * send decide it the same way). Only Ended and Delete without products.delete are refused here, so they hold nothing.
 * Rows not on the channel that Publish leaves out are held too (`notListedHeld`; a deleted row with the delete's words).
 */
export function heldOnDestination(channel: string, familyId: string, cells: readonly PublishActionCell[], canDelete: boolean): PublishPlanHeldRow[] {
  const values = waitingValuesOf(cells).values.map(value => ({ productId: value.cell.productId, action: value.action,
    refused: (value.action === 'end' || value.action === 'delete') && !canDelete ? ROLE_CANNOT_END_OR_DELETE : null }))
  const products = listedProducts(cells)
  const held = heldContent(channel, familyId, values, products)
  return [...held, ...notListedHeld(channel, familyId, cells, products).filter(row => !held.some(other => other.productId === row.productId))]
}

/**
 * New listings — what a Not listed holds (a row not on the channel: never sent, no listing, or deleted by Nexus). A main
 * row set Not listed — or a deleted main row left Not listed, its default — holds its family here (eBay and Shopify: the
 * whole listing; Amazon: the main row and every row not on the channel — they need their main product; a standalone
 * product itself). A deleted variation left Not listed is held (`deleted: true`, in the delete's own words); a new
 * variation set Not listed is left out (the content review leaves it out as an excluded row).
 */
export function notListedHeld(channel: string, familyId: string, cells: readonly PublishActionCell[],
  products: ReadonlyArray<{ productId: string; sku: string }> = listedProducts(cells)): PublishPlanHeldRow[] {
  const cellOf = (productId: string) => cells.find(cell => cell.productId === productId)
  const leftOut = (cell: PublishActionCell | undefined) => cell?.create?.target === 'not_listed' && (cell.create.source === 'own' || !!cell.deleted)
  const words = (cell: PublishActionCell | undefined, reason: string) => cell?.deleted
    ? { reason: deletedPublishSkip(cell.deleted), deleted: true as const } : { reason, notListed: true as const }
  const main = cellOf(familyId)
  if (leftOut(main)) {
    const family = products.some(p => p.productId !== familyId)
    const whole = channel === 'EBAY' || channel === 'SHOPIFY'
    return products.filter(p => whole || p.productId === familyId || !!cellOf(p.productId)?.create)
      .map(p => ({ productId: p.productId, sku: p.sku, ...words(cellOf(p.productId), family ? NOT_LISTED_MAIN_HELD : NOT_LISTED_LEFT_OUT) }))
  }
  return products.filter(p => p.productId !== familyId && leftOut(cellOf(p.productId)))
    .map(p => ({ productId: p.productId, sku: p.sku, ...words(cellOf(p.productId), NOT_LISTED_LEFT_OUT) }))
}

// ── The review ───────────────────────────────────────────────────────────────────────────────────

type ContentPreview = (productId: string, scope: StudioPublishScope, userId: string | null, options: { fullProductIds?: string[] }) => Promise<StudioPublishReview>
type ActionPlan = (productId: string, action: ListingAction, body: unknown) => Promise<{ rows: Array<{ productId: string; plan: string; sentence: string; warning?: string | null; heldSku?: string }>;
  consequence: string; checkedAtSend: string | null; sendCount: number; reach: string }>

export interface PublishPlanDeps {
  /** The studio's content review (default `previewStudioPublication`). */
  preview?: ContentPreview
  /** The listing-action engine's plan, nothing saved (default `planListingAction`). */
  plan?: ActionPlan
  now?: () => Date
}

async function defaultPreview(productId: string, scope: StudioPublishScope, userId: string | null, options: { fullProductIds?: string[] }) {
  const { previewStudioPublication } = await import('./studio-publication.service.js')
  return previewStudioPublication(productId, scope, userId, options)
}

async function defaultPlan(productId: string, action: ListingAction, body: unknown) {
  const { planListingAction } = await import('../listings/listing-action.service.js')
  return planListingAction(productId, action, body)
}

async function familyOf(productId: string) {
  const seed = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!seed) throw new PublishPlanError('This product is unavailable.', 404, 'not_found')
  const familyId = seed.parentId ?? seed.id
  const family = await prisma.product.findFirst({ where: { id: familyId }, select: { id: true, sku: true } })
  if (!family) throw new PublishPlanError('This product is unavailable.', 404, 'not_found')
  const variations = await prisma.product.count({ where: { parentId: familyId, deletedAt: null } })
  return { familyId, familySku: family.sku, hasVariations: variations > 0 }
}

function parseDestinations(raw: unknown): StudioPublishScope[] {
  if (!Array.isArray(raw) || !raw.length) throw new PublishPlanError('Choose at least one destination to publish.', 400, 'invalid_request')
  if (raw.length > MAX_PLAN_DESTINATIONS) throw new PublishPlanError(`Publish to at most ${MAX_PLAN_DESTINATIONS} destinations at once.`, 400, 'invalid_request')
  const seen = new Set<string>()
  return raw.map(entry => {
    const scope = publicationScope(entry)
    const key = JSON.stringify([scope.channel, scope.marketplace, scope.accountId, scope.listingId ?? null])
    if (seen.has(key)) throw new PublishPlanError('A destination appears twice in this request.', 400, 'invalid_request')
    seen.add(key)
    return scope
  })
}

async function resolveDestination(productId: string, scope: StudioPublishScope): Promise<ListingActionDestination> {
  const resolved = await resolveWorkspaceDestination({ productId, ...scope })
  return { channel: scope.channel, marketplace: scope.marketplace, accountId: resolved.accountId, aliasKey: resolved.aliasKey ?? '' }
}

/** Run `work` over `items`, at most `limit` at a time, keeping the results in order. */
async function inOrder<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await work(items[at]) }
  }))
  return out
}

/** The lifecycle rows of one destination: one listing-action plan per action, each value mapped to its own plan row. */
async function lifecycleRowsOf(family: { familyId: string; hasVariations: boolean }, destination: ListingActionDestination, values: WaitingLifecycleValue[],
  actor: PublishPlanActor, plan: ActionPlan, now: number): Promise<PublishPlanLifecycleRow[]> {
  const { familyId } = family
  const byAction = new Map<ListingAction, WaitingLifecycleValue[]>()
  for (const value of values) byAction.set(value.action, [...(byAction.get(value.action) ?? []), value])
  const canDelete = actor.can('products.delete')
  const rows: PublishPlanLifecycleRow[] = []
  for (const [action, group] of byAction) {
    let read: Awaited<ReturnType<ActionPlan>> | null = null
    let failure: string | null = null
    try { read = await plan(familyId, action, { scope: destination, productIds: [...new Set(group.map(v => v.cell.productId))] }) }
    catch (error) { failure = errorText(error) }
    const ownRow = new Map((read?.rows ?? []).map(row => [row.productId, row]))
    for (const value of group) {
      const own = ownRow.get(value.cell.productId)
      const consequence = read?.consequence ?? failure ?? 'Not available here.'
      let refused: string | null = failure
        ?? (own?.plan === 'refused' ? own.sentence : null)
        ?? (read && read.sendCount === 0 ? own?.sentence ?? 'Nothing would be sent here.' : null)
      const confirm = needsTypedConfirm({ kind: value.column, value: value.value })
      if (!refused && confirm && !canDelete) refused = ROLE_CANNOT_END_OR_DELETE
      const option = value.column === 'status' ? value.cell.statusOptions.find(o => o.target === value.value) : null
      const stale = isStaleWaiting({ setAt: value.setAt, setById: value.setById }, actor.userId, now)
      rows.push({
        id: planRowId(value.column, value.cell.listingId, value.setAt, action), listingId: value.cell.listingId, productId: value.cell.productId,
        // S11 follow-up — the SKU this End, Delete, Pause or Resume acts on: the one the channel holds for the listing (the
        // listing action's own row), not the product SKU in its place.
        sku: own?.heldSku ?? value.cell.sku, isParent: value.cell.productId === familyId && family.hasVariations,
        column: value.column, value: value.value, action, step: lifecycleStep(action), state: value.cell.state,
        sentence: own?.plan === 'send' ? own.sentence : read && read.sendCount > 0 ? consequence : own?.sentence ?? consequence,
        consequence, warning: own?.warning ?? option?.warning ?? null, checkedAtSend: read?.checkedAtSend ?? option?.checkedAtSend ?? null,
        setAt: value.setAt, setById: value.setById, setByName: value.setByName,
        stale, tickedByDefault: !stale && !refused, needsTypedConfirm: confirm, refused,
      })
    }
  }
  const rank = (row: PublishPlanLifecycleRow) => SEND_ORDER.indexOf(row.step)
  return rows.sort((a, b) => rank(a) - rank(b) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
}

/**
 * A saved content review whose held rows may not be ticked: their changes become unselectable with the reason, and
 * the row says it is held (`blocked`). Written onto the saved review (compare-and-set), so the tick route refuses them;
 * the send rebuilds the plan and compiles only the ticked changes, which never include them.
 */
async function holdReviewRows(review: StudioPublishReview, held: PublishPlanHeldRow[]): Promise<StudioPublishReview> {
  const reasons = new Map(held.map(row => [row.productId, row.reason]))
  const block = (r: StudioPublishReview): StudioPublishReview => ({ ...r,
    ...(r.changes ? { changes: blockRowChanges(r.changes, reasons) } : {}),
    rows: r.rows.map(row => reasons.has(row.productId) ? { ...row, blocked: reasons.get(row.productId)! } : row) })
  if (!review.id) return block(review)
  const stored = await prisma.bulkOperation.findFirst({ where: { id: review.id, status: 'PREVIEW' }, select: { changes: true } })
  const data = object(stored?.changes)
  if (!stored || !data.review) return block(review)
  const next = { ...data, review: block(data.review as StudioPublishReview),
    ...(data.changePlan?.changes ? { changePlan: { ...data.changePlan, changes: blockRowChanges(data.changePlan.changes, reasons) } } : {}) }
  const saved = await prisma.bulkOperation.updateMany({ where: { id: review.id, status: 'PREVIEW', changes: { equals: json(stored.changes) } }, data: { changes: json(next) } })
  if (saved.count !== 1) throw new PublishPlanError('This review changed while it was being made. Review again.', 409)
  return block(review)
}

/**
 * The review of one Publish: per destination the content review, the lifecycle rows, the held rows and the values the
 * listing outgrew; the counts and the summary line with the default ticks; whether a typed confirmation is needed.
 */
export async function reviewPublishPlan(productId: string, body: unknown, actor: PublishPlanActor, deps: PublishPlanDeps = {}): Promise<PublishPlan> {
  const scopes = parseDestinations(object(body).destinations)
  const preview = deps.preview ?? defaultPreview
  const plan = deps.plan ?? defaultPlan
  const now = (deps.now ?? (() => new Date()))()
  const family = await familyOf(productId)
  const { familyId, familySku } = family
  const canDelete = actor.can('products.delete')
  const cells = await readPublishActions(productId)

  // Destinations of one channel account one after another (its read rate); two accounts side by side.
  const reviewOne = async (scope: StudioPublishScope): Promise<PublishPlanDestination> => {
    const empty = { review: null, fullProductIds: [], contentHeld: [], lifecycle: [], outgrown: [] }
    let destination: ListingActionDestination
    try { destination = await resolveDestination(productId, scope) }
    catch (error) {
      const fallback = { channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: '' }
      return { scope, destination: fallback, label: planDestinationLabel(fallback), ...empty, error: errorText(error) }
    }
    const here = cells.filter(cell => sameDestination(cell, destination))
    const waiting = waitingValuesOf(here)
    const lifecycle = await lifecycleRowsOf(family, destination, waiting.values, actor, plan, now.getTime())
    const products = listedProducts(here)
    const contentHeld = heldOnDestination(destination.channel, familyId, here, canDelete)
    const heldIds = new Set(contentHeld.map(row => row.productId))
    const fullProductIds = waiting.fullProductIds.filter(id => !heldIds.has(id))
    const base = { scope, destination, label: planDestinationLabel(destination), fullProductIds, contentHeld, lifecycle, outgrown: waiting.outgrown }
    // Every row this destination lists is held: no content goes out here, so no review is made (no channel read).
    if (products.length && contentHeld.length === products.length) return { ...base, review: null, error: null }
    try {
      const made = await preview(productId, scope, actor.userId, fullProductIds.length ? { fullProductIds } : {})
      return { ...base, review: contentHeld.length ? await holdReviewRows(made, contentHeld) : made, error: null }
    } catch (error) {
      return { ...base, review: null, error: errorText(error) }
    }
  }
  const groups = new Map<string, number[]>()
  scopes.forEach((scope, at) => { const key = `${scope.channel}\u0000${scope.accountId}`; groups.set(key, [...(groups.get(key) ?? []), at]) })
  const destinations = new Array<PublishPlanDestination>(scopes.length)
  await inOrder([...groups.values()], 2, async indexes => { for (const at of indexes) destinations[at] = await reviewOne(scopes[at]) })

  const counts = publishPlanCounts({ destinations })
  const confirmRows = destinations.flatMap(d => d.lifecycle).filter(row => row.needsTypedConfirm && !row.refused).length
  return { productId, familyId, familySku, destinations, counts, summary: publishPlanSummary(counts),
    confirm: confirmRows ? { expected: familySku, rows: confirmRows } : null, canDelete, readAt: now.toISOString() }
}

// ── The send request, checked against the values now ─────────────────────────────────────────────

/**
 * The submit body of one content review, as the batch stamps it (`{ selectionToken?, confirmOverwrite?, locationId?,
 * confirm? }`). `confirm: 'DELETE'` (S10): the review moves a live Amazon listing to a new SKU, which deletes the old SKU;
 * the plan checked the typed family SKU and the delete permission before stamping it.
 */
export interface PlanContentChild { reviewId: string; selectionToken?: string; confirmOverwrite?: boolean; locationId?: string; confirm?: 'DELETE' }

/** One waiting value a lifecycle child carries, to clear after it succeeds (only if still set at `setAt`). */
export interface PlanValueRef { listingId: string; productId: string; column: PublishPlanColumn; setAt: string }

/** One lifecycle child to make: one destination × one action, the rows whose values asked for it. */
export interface PlanLifecycleGroup {
  destinationIndex: number
  destination: ListingActionDestination
  action: ListingAction
  productIds: string[]
  values: PlanValueRef[]
  /** Set: the child is recorded NOT_SENT with this reason (the values keep waiting). */
  refused: string | null
}

export interface PreparedPlanSubmit {
  familyId: string
  familySku: string
  destinations: Array<{ scope: StudioPublishScope; destination: ListingActionDestination; label: string; content: PlanContentChild | null
    /** Rows whose content is held here (`heldOnDestination`); a content review that ticks one of them is refused. */
    held: PublishPlanHeldRow[]
    /** Products listed on this destination. */
    listed: number }>
  groups: PlanLifecycleGroup[]
  outgrown: PlanValueRef[]
}

const optionalText = (value: unknown, max: number, what: string) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value || value.length > max) throw new PublishPlanError(`${what} is not valid.`, 400, 'invalid_request')
  return value
}

function idList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_ROWS || value.some(id => typeof id !== 'string' || !id || id.length > 300))
    throw new PublishPlanError(`${what} must be a list of row ids from the review.`, 400, 'invalid_request')
  return [...new Set(value as string[])]
}

/**
 * Check one Publish against the values as they are now. Refused as a whole (nothing queued) when a ticked row's value
 * changed since the review or no longer applies, when a row is not in a chosen destination, or when Ended or Delete is
 * ticked without the typed family SKU by someone who may end and delete. Someone who may not: those rows are recorded
 * NOT_SENT and keep waiting; the rest still sends.
 */
export async function preparePlanSubmit(body: unknown, actor: PublishPlanActor): Promise<PreparedPlanSubmit> {
  const input = object(body)
  const productId = optionalText(input.productId, 200, 'The product')
  if (!productId) throw new PublishPlanError('Choose the product to publish.', 400, 'invalid_request')
  const rawDestinations = input.destinations
  if (!Array.isArray(rawDestinations) || !rawDestinations.length) throw new PublishPlanError('Choose at least one destination to publish.', 400, 'invalid_request')
  if (rawDestinations.length > MAX_PLAN_DESTINATIONS) throw new PublishPlanError(`Publish to at most ${MAX_PLAN_DESTINATIONS} destinations at once.`, 400, 'invalid_request')
  const ticked = idList(input.lifecycle, 'lifecycle')
  const outgrownIds = idList(input.outgrown, 'outgrown')
  const confirmText = input.confirmText === undefined || input.confirmText === null ? null : optionalText(input.confirmText, 300, 'The typed confirmation') ?? null

  const { familyId, familySku } = await familyOf(productId)
  const cells = await readPublishActions(productId)
  const cellOf = new Map(cells.map(cell => [cell.listingId, cell]))
  const destinations: PreparedPlanSubmit['destinations'] = []
  const seen = new Set<string>()
  for (const raw of rawDestinations) {
    const entry = object(raw)
    const scope = publicationScope(entry.scope)
    const destination = await resolveDestination(productId, scope)
    const key = JSON.stringify([destination.channel, destination.marketplace, destination.accountId, destination.aliasKey])
    if (seen.has(key)) throw new PublishPlanError('A destination appears twice in this request.', 400, 'invalid_request')
    seen.add(key)
    const reviewId = optionalText(entry.reviewId, 200, 'A review')
    if (entry.confirmOverwrite !== undefined && typeof entry.confirmOverwrite !== 'boolean') throw new PublishPlanError('The overwrite confirmation is not valid.', 400, 'invalid_request')
    const selectionToken = optionalText(entry.selectionToken, 200, 'A selection token')
    const locationId = optionalText(entry.locationId, 200, 'The inventory location')
    // S10 — the review deletes an old Amazon SKU (a move): the typed family SKU and the delete permission, checked below.
    if (entry.confirmDelete !== undefined && typeof entry.confirmDelete !== 'boolean') throw new PublishPlanError('The delete confirmation is not valid.', 400, 'invalid_request')
    const confirmDelete = entry.confirmDelete === true && !!reviewId
    destinations.push({ scope, destination, label: planDestinationLabel(destination), held: [], listed: 0,
      content: reviewId ? { reviewId, ...(selectionToken ? { selectionToken } : {}), ...(entry.confirmOverwrite !== undefined ? { confirmOverwrite: entry.confirmOverwrite } : {}),
        ...(locationId ? { locationId } : {}), ...(confirmDelete ? { confirm: 'DELETE' as const } : {}) } : null })
  }
  const destinationIndex = (cell: PublishActionCell) => destinations.findIndex(d => sameDestination(cell, d.destination))

  // Every ticked row must still hold the value the review saw, and still lead to the same action.
  const canDelete = actor.can('products.delete')
  const groups = new Map<string, PlanLifecycleGroup>()
  for (const id of ticked) {
    const ref = parsePlanRowId(id)
    const cell = ref ? cellOf.get(ref.listingId) : undefined
    if (!ref || !ref.action || !cell) throw new PublishPlanError('A ticked row is not in this product\'s review. Review again.', 400, 'invalid_request')
    const at = destinationIndex(cell)
    if (at < 0) throw new PublishPlanError(`${cell.sku}: its destination is not in this Publish. Review again.`, 400, 'invalid_request')
    const own = ref.column === 'send' ? cell.send : cell.status
    if (!own.setAt || Date.parse(own.setAt) !== ref.setAt.getTime())
      throw new PublishPlanError(`${cell.sku}: its waiting value changed since the review${own.setByName ? ` (${own.setByName})` : ''}. Review again.`, 409, 'changed')
    if (own.noLongerApplies) throw new PublishPlanError(`${cell.sku}: ${own.noLongerApplies} Review again.`, 409, 'changed')
    const action = ref.column === 'send' ? (cell.send.mode === 'delete' ? 'delete' : null) : cell.status.target ? statusChangeAction(cell.state, cell.status.target) : null
    if (action !== ref.action) throw new PublishPlanError(`${cell.sku}: this listing changed since the review. Review again.`, 409, 'changed')
    const key = `${at}\u0000${action}`
    const group = groups.get(key) ?? { destinationIndex: at, destination: destinations[at].destination, action, productIds: [], values: [], refused: null }
    if (!group.productIds.includes(cell.productId)) group.productIds.push(cell.productId)
    group.values.push({ listingId: cell.listingId, productId: cell.productId, column: ref.column, setAt: own.setAt })
    groups.set(key, group)
  }
  const confirming = [...groups.values()].filter(group => group.action === 'end' || group.action === 'delete')
  if (confirming.length) {
    if (!canDelete) for (const group of confirming) group.refused = ROLE_CANNOT_END_OR_DELETE
    else if (!confirmMatches(familySku, confirmText)) throw new PublishPlanError(TYPE_TO_CONFIRM(familySku), 400, 'confirm_required')
  }
  // S10 — a content review that moves a live Amazon listing to a new SKU deletes the old SKU: the same typed family SKU
  // and the same permission as Delete. The review itself refuses a send without it (`claimPublication`).
  if (destinations.some(entry => entry.content?.confirm === 'DELETE')) {
    if (!canDelete) throw new PublishPlanError(AMAZON_MOVE_ROLE_CANNOT_DELETE, 403, 'forbidden')
    if (!confirmMatches(familySku, confirmText)) throw new PublishPlanError(TYPE_TO_CONFIRM(familySku), 400, 'confirm_required')
  }

  // The content held on each destination, decided as the review decided it.
  for (const entry of destinations) {
    const here = cells.filter(cell => sameDestination(cell, entry.destination))
    entry.held = heldOnDestination(entry.destination.channel, familyId, here, canDelete)
    entry.listed = listedProducts(here).length
  }

  const outgrown: PlanValueRef[] = []
  for (const id of outgrownIds) {
    const ref = parsePlanRowId(id)
    const cell = ref ? cellOf.get(ref.listingId) : undefined
    if (!ref || !cell) throw new PublishPlanError('A row to clear is not in this product\'s review. Review again.', 400, 'invalid_request')
    outgrown.push({ listingId: cell.listingId, productId: cell.productId, column: ref.column, setAt: ref.setAt.toISOString() })
  }
  const order = (group: PlanLifecycleGroup) => group.destinationIndex * SEND_ORDER.length + SEND_ORDER.indexOf(lifecycleStep(group.action))
  return { familyId, familySku, destinations, groups: [...groups.values()].sort((a, b) => order(a) - order(b)), outgrown }
}

/**
 * The content review's ticks must leave out the rows held on its destination (a review made by `reviewPublishPlan`
 * cannot tick them; one made elsewhere could). A sentence when it does not, else null.
 */
export function heldTickRefusal(entry: Pick<PreparedPlanSubmit['destinations'][number], 'label' | 'held' | 'listed'>, data: Record<string, any>): string | null {
  const { label, held } = entry
  if (!held.length) return null
  if (held.length >= entry.listed) return `${label}: ${held[0].reason} Leave its changes out, or clear the waiting value first.`
  const heldIds = new Map(held.map(row => [row.productId, row]))
  const selected = new Set<string>(Array.isArray(data.selection?.selectedIds) ? data.selection.selectedIds : [])
  const changes: Array<{ id: string; productId: string }> = Array.isArray(data.changePlan?.changes) ? data.changePlan.changes : []
  const hit = changes.find(change => selected.has(change.id) && heldIds.has(change.productId))
  if (hit) return `${label}: ${heldIds.get(hit.productId)!.sku}: ${heldIds.get(hit.productId)!.reason} Untick its changes.`
  if (!data.changePlan && held.length) return `${label}: ${held[0].reason} Leave its changes out, or clear the waiting value first.`
  return null
}

/** Clear the plan's "No longer applies" values (only those unchanged since the review). Never throws. */
export async function clearOutgrown(values: PlanValueRef[]): Promise<number> {
  let cleared = 0
  for (const column of ['send', 'status'] as const) {
    const mine = values.filter(value => value.column === column)
    if (!mine.length) continue
    try {
      const done = await clearWaitingValues(mine.map(v => v.listingId), column, Object.fromEntries(mine.map(v => [v.listingId, v.setAt])))
      cleared += done.cleared.length
    } catch (error) {
      logger.warn('publish plan: outgrown values not cleared; they keep saying "No longer applies"', { column, error: errorText(error) })
    }
  }
  return cleared
}

// ── After a lifecycle child ran ──────────────────────────────────────────────────────────────────

/**
 * Clear the values a lifecycle child carried that it did (its own row DONE) or that the listing outgrew since (already
 * in that state, deleted back to a draft…): only if unchanged since the review. A failure, NOT_SENT or UNKNOWN keeps
 * the value. Never throws: the run's result is already stored.
 */
export async function settleLifecycleValues(input: { familyId: string; destination: ListingActionDestination; values: PlanValueRef[]; result: ListingActionRunResult | null }):
  Promise<{ cleared: string[]; kept: string[] }> {
  const out = { cleared: [] as string[], kept: [] as string[] }
  if (!input.values.length) return out
  try {
    const done = new Set((input.result?.rows ?? []).filter(row => row.outcome === 'DONE' && row.listingId).map(row => row.listingId!))
    const now = await readPublishActions(input.familyId, input.destination)
    const cellOf = new Map(now.map(cell => [cell.listingId, cell]))
    for (const column of ['send', 'status'] as const) {
      const mine = input.values.filter(value => value.column === column)
      const clear = mine.filter(value => done.has(value.listingId) || !!(column === 'send' ? cellOf.get(value.listingId)?.send : cellOf.get(value.listingId)?.status)?.noLongerApplies)
      out.kept.push(...mine.filter(value => !clear.includes(value)).map(value => value.listingId))
      if (!clear.length) continue
      const result = await clearWaitingValues(clear.map(v => v.listingId), column, Object.fromEntries(clear.map(v => [v.listingId, v.setAt])))
      out.cleared.push(...result.cleared)
      out.kept.push(...result.kept)
    }
  } catch (error) {
    logger.warn('publish plan: waiting values not cleared after a lifecycle change; they stay set', { familyId: input.familyId, error: errorText(error) })
  }
  return out
}

// ── After a content result is stored (the settle core's hook) ────────────────────────────────────

/**
 * Full update resets to Partial once the channel accepted that row: called by the settle core (`storeResult` in
 * studio-publication-settle.ts) after it stored a result. Only publications reviewed with Full update rows do anything.
 * A row clears when its own record was accepted (Amazon per SKU; eBay and Shopify per delivered product), and the
 * family's main row — where eBay keeps the whole item's Full update — when the publication as a whole was ACCEPTED or
 * VERIFIED. Only values set before the review are cleared (a later one is someone's new choice). Never throws.
 */
export async function afterContentSettled(publicationId: string, data: Record<string, any>, result: Pick<StudioPublishResult, 'status'>): Promise<string[]> {
  const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id: unknown): id is string => typeof id === 'string') : []
  const fullProductIds = ids(data?.fullProductIds)
  // Delete and relist: the rows this publication listed again; an older relist choice (Partial or Full update set in the
  // Action column after the delete, read as Status Active) resets the same way. Their Status choice clears below.
  const relistProductIds = ids(data?.relistProductIds)
  // New listings: the rows this publication created from their own Status choice; the choice clears once accepted.
  const createChoiceProductIds = ids(data?.createChoiceProductIds)
  if ((!fullProductIds.length && !relistProductIds.length && !createChoiceProductIds.length) || !data?.scope) return []
  try {
    const publication = await prisma.bulkOperation.findFirst({ where: { id: publicationId }, select: { createdAt: true, productId: true } })
    if (!publication) return []
    const accepted = new Set((await prisma.channelListingSnapshot.findMany({ where: { publishEventId: publicationId, reason: 'publish', outcome: 'ACCEPTED' },
      select: { channelListingId: true } })).map(row => row.channelListingId))
    const whole = result.status === 'ACCEPTED' || result.status === 'VERIFIED'
    const destination = { channel: data.scope.channel, marketplace: data.scope.marketplace, channelConnectionId: data.scope.accountId, aliasKey: data.delivery?.aliasKey ?? '' }
    const cleared: string[] = []
    if (fullProductIds.length || relistProductIds.length) {
      const rows = await prisma.channelListing.findMany({ where: { ...destination, publishActionAt: { lte: publication.createdAt }, OR: [
        ...(fullProductIds.length ? [{ productId: { in: fullProductIds }, publishAction: 'FULL_UPDATE' }] : []),
        ...(relistProductIds.length ? [{ productId: { in: relistProductIds }, publishAction: null }] : []),
      ] }, select: { id: true, productId: true, publishActionAt: true } })
      const clear = rows.filter(row => accepted.has(row.id) || (whole && row.productId === publication.productId))
      if (clear.length) cleared.push(...(await clearWaitingValues(clear.map(row => row.id), 'send', Object.fromEntries(clear.map(row => [row.id, row.publishActionAt])))).cleared)
    }
    if (createChoiceProductIds.length) {
      const rows = await prisma.channelListing.findMany({ where: { ...destination, productId: { in: createChoiceProductIds }, sellingTarget: { in: ['ACTIVE', 'INACTIVE'] },
        sellingTargetAt: { lte: publication.createdAt } }, select: { id: true, sellingTargetAt: true } })
      const clear = rows.filter(row => accepted.has(row.id) || whole)
      if (clear.length) cleared.push(...(await clearWaitingValues(clear.map(row => row.id), 'status', Object.fromEntries(clear.map(row => [row.id, row.sellingTargetAt])))).cleared)
    }
    return cleared
  } catch (error) {
    logger.warn('publish plan: Full update not reset after the result; it stays set', { publicationId, error: errorText(error) })
    return []
  }
}

// ── P11: one Status on many products × destinations (the products list's Publish… window) ───────

/** The listing-action engine's kind (`LISTING_ACTION_KIND`); a batch's lifecycle child is one of its previews. */
const LISTING_ACTION_KIND = 'listing-action'

/** One product family × one destination of a many-product batch. */
export interface StatusPair { familyId: string; scope: StudioPublishScope }

type StatusPreview = (familyId: string, action: ListingAction, body: unknown, userId: string | null) => Promise<ListingActionPreview>

export interface StatusPairDeps {
  /** The engine's saved preview (default `previewListingAction`). */
  preview?: StatusPreview
  now?: () => Date
}

export interface StatusPairReview {
  /** The lifecycle children made for the batch, one per action. */
  children: Array<{ previewId: string; action: ListingAction; sendCount: number }>
  /** Listing rows they send, together. */
  sendCount: number
}

async function defaultStatusPreview(familyId: string, action: ListingAction, body: unknown, userId: string | null) {
  const { previewListingAction } = await import('../listings/listing-action.service.js')
  return previewListingAction(familyId, action, body, userId)
}

/**
 * PURE. Why a product × market sends nothing for a Status target, from its plan rows: the first refusal (the channel or
 * the listing cannot), else that every listing there is already there or not on the channel.
 */
export function statusNothingMessage(target: ListedStatusTarget, rows: readonly Pick<ListingActionPlanRow, 'plan' | 'sentence'>[]): string {
  const refused = rows.find(row => row.plan === 'refused')
  if (refused) return `Not possible here: ${refused.sentence}`
  return `Nothing to change: every listing here is already ${STATUS_TARGET_LABEL[target].toLowerCase()}, or not on the channel.`
}

/**
 * PURE. Which previews a product × market keeps: those that send something; when none does, the target's first
 * action alone (it shows why nothing changes). The rest are removed (never sent).
 */
export function keptStatusPreviews<T extends { action: ListingAction; sendCount: number }>(target: ListedStatusTarget, made: readonly T[]): { keep: T[]; drop: T[] } {
  const sending = made.filter(preview => preview.sendCount > 0)
  const first = STATUS_TARGET_ACTIONS[target][0]
  const keep = sending.length ? sending : made.filter(preview => preview.action === first).slice(0, 1)
  return { keep, drop: made.filter(preview => !keep.includes(preview)) }
}

/**
 * Review one product family × one destination for a Status target: one listing-action preview per action that can
 * bring its listings there (`STATUS_TARGET_ACTIONS`; the engine's plan covers every listing of the family there, where
 * allowed, and says per row why not). The kept previews become lifecycle children of the batch: `batchId`, their place
 * in the send order, a 2-hour life (`ttlMs`), no waiting values to clear. One that sends nothing is marked
 * `nothingToSend` with the reason; the submit removes it. Throws when the destination cannot be read (the caller records
 * the pair as not reviewed).
 */
export async function reviewStatusPair(batchId: string, pair: StatusPair, target: ListedStatusTarget, userId: string | null, ttlMs: number,
  deps: StatusPairDeps = {}): Promise<StatusPairReview> {
  const preview = deps.preview ?? defaultStatusPreview
  const scope = { channel: pair.scope.channel, marketplace: pair.scope.marketplace, accountId: pair.scope.accountId }
  const made: ListingActionPreview[] = []
  try {
    for (const action of STATUS_TARGET_ACTIONS[target]) made.push(await preview(pair.familyId, action, { scope, reason: 'Publish' }, userId))
  } catch (error) {
    await removePreviews(made.map(p => p.previewId))
    throw error
  }
  const { keep, drop } = keptStatusPreviews(target, made)
  await removePreviews(drop.map(p => p.previewId))
  const now = (deps.now ?? (() => new Date()))()
  await prisma.$transaction(async tx => {
    for (const kept of keep) {
      const row = await tx.bulkOperation.findFirst({ where: { id: kept.previewId, kind: LISTING_ACTION_KIND, status: 'PREVIEW', batchId: null }, select: { changes: true } })
      if (!row) throw new PublishPlanError('A status change was sent or removed while the batch was checking it. Check again.', 409)
      const batch = { batchId, step: lifecycleStep(kept.action), familyId: pair.familyId, destination: kept.destination, values: [] }
      const nothing = kept.sendCount === 0
      const stamped = await tx.bulkOperation.updateMany({ where: { id: kept.previewId, status: 'PREVIEW', batchId: null, changes: { equals: json(row.changes) } },
        data: { batchId, expiresAt: new Date(now.getTime() + ttlMs), changes: json({ ...object(row.changes), batch, statusTarget: target }),
          ...(nothing ? { summary: json({ nothingToSend: true, message: statusNothingMessage(target, kept.rows) }) } : {}) } })
      if (stamped.count !== 1) throw new PublishPlanError('A status change was sent or removed while the batch was checking it. Check again.', 409)
    }
  })
  const children = keep.map(p => ({ previewId: p.previewId, action: p.action, sendCount: p.sendCount }))
  return { children, sendCount: children.reduce((n, child) => n + child.sendCount, 0) }
}

/** Remove previews made for a batch that it will not use (never sent; nobody else knows their ids). Never throws. */
async function removePreviews(ids: string[]) {
  if (!ids.length) return
  await prisma.bulkOperation.deleteMany({ where: { id: { in: ids }, kind: LISTING_ACTION_KIND, status: 'PREVIEW', batchId: null } })
    .catch(error => logger.warn('publish plan: unused status previews not removed; they expire unsent', { error: errorText(error) }))
}
