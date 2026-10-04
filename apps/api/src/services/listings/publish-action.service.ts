/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P2 — the two values a listing row WAITS with until
 * Publish. Every channel scope of the product sheet has, one value per market:
 *  - the **Action** column: how Publish sends the row's content — Partial update (the default, never stored), Full
 *    update, Delete (`ChannelListing.publishAction`);
 *  - the **Status** column: the selling state to reach — Active, Inactive, Ended (`ChannelListing.sellingTarget`).
 * The rules and the wire shapes are shared with the web: `@nexus/shared/publish-actions` and
 * `@nexus/shared/listing-actions`. Setting a value sends nothing; Publish sends it after the review.
 *
 *   readPublishActions   → every listing row of a family (or of one destination): its selling state, its waiting
 *                          values with who and when, and what it may choose now. Only facts Nexus holds; no channel call.
 *   writePublishActions  → set or clear one column on many rows. Each row is checked against its own options (a refused
 *                          row gets the reason); the write is a compare-and-set on the column's `…At` (a different stored
 *                          value is a conflict that names who changed it and when); one `listing.publish_action_changed`
 *                          event per write, so other open sheets refetch.
 *   clearWaitingValues   → for the Publish runners: clears a value only if it is unchanged since the review.
 *
 * The selling state is read by the listing-action engine's own reader (listing-action.service.ts
 * `destinationSellingStates`), for every destination of the family in one read: the engine is what Publish will run, so a
 * waiting value is checked against the state the engine will see.
 *
 * Status is the ONE control for "is it on this market" (simplify, Owner 2026-10-04). A row NOT on the channel — Draft,
 * no listing here, or deleted by Nexus (`readListingDeletions`; `PublishActionCell.deleted` carries the delete's words) —
 * chooses Active / Inactive / Not listed in the Status column, stored as ACTIVE / INACTIVE / NOT_LISTED
 * (`PublishActionCell.create` says what Publish does, from `new-listing-choices.ts`; a deleted row's default is Not
 * listed, so every Publish skips it until its Status lists it again). Its Action reads Full update (a create always sends
 * the whole listing): choosing Full update stores nothing, Partial update and Delete are refused with the reason. A
 * value set before the delete no longer applies. An older relist choice (Partial update stored as no value WITH a time,
 * or Full update, set after the delete) reads as Status Active; a Status choice made since clears it. A read that names one
 * destination exactly (`newRows`) also returns every family member with no listing there, with a `new:` listing id; a
 * Status choice on such a row first starts the drafts of the whole family on that sheet's own account
 * (`ensureDraftListings`, primary listing only — an alias row is never created) and stores the choice in the same
 * transaction ("Started Amazon · IT for GALE and 6 variations."). eBay Inactive reads the account's out-of-stock option
 * first. The Shared scope never starts a listing (`leftOut`).
 */
import { Prisma } from '@prisma/client'
import {
  ALL_STATUS_TARGETS, AMAZON_NO_END, deletedOn, deletedShort, ETSY_NO_END, isNewListingRow, newListingSentence, STATUS_TARGET_LABEL, statusOptionsFor,
  type CapabilityFacts, type ListingModel, type SellingState, type StatusOption, type StatusTarget,
} from '@nexus/shared/listing-actions'
import {
  leftOutSentence, newRowId, parseNewRowId, SEND_MODE_LABEL, SEND_MODES, SHARED_NO_LISTING, sendModeOf,
  sendModeOptions, startedSentence, statusTargetOf, storedSendMode, storedStatusTarget, type NewRowRef, type PublishActionCell, type PublishActionChange,
  type PublishActionCreate, type PublishActionDeleted, type PublishActionStarted, type PublishActionWrite, type PublishActionWriteResult, type SendMode,
  type SendModeOption,
} from '@nexus/shared/publish-actions'
import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import { publishListingEvent } from '../listing-events.service.js'
import { userNames } from '../pim/publication-history/users.js'
import { readExcludedListingIds, variationExcludedColumnExists } from '../pim/variation-excluded.js'
import { DraftListingError, ensureDraftListings } from '../pim/draft-listing.service.js'
import { nativeListingValue } from '../shopify/native-listing-value.js'
import { logger } from '../../utils/logger.js'
import { destinationLabel, destinationSellingStates, oldClosePauses } from './listing-action.service.js'
import { readListingDeletions } from './listing-deletions.js'
import { newListingChoices, setBeforeDelete } from './new-listing-choices.js'

/** A refusal with its HTTP status and a machine code; the message is what the person reads. */
export class PublishActionError extends Error {
  constructor(message: string, readonly statusCode = 409, readonly code = 'PUBLISH_ACTION_REFUSED') { super(message) }
}

export type PublishActionColumn = PublishActionChange['column']

/** Who writes, and what this request may do (the RBAC gate's resolved permissions: `permissionCheckerFor`). */
export interface PublishActionActor {
  userId: string | null
  can: (permission: string) => boolean
}

/** One destination of the family, or part of one; every field optional. */
export interface PublishActionDestinationFilter { channel?: string; marketplace?: string; accountId?: string; aliasKey?: string }

/** The request as the route parses it (the shared write: listing ids, or every market of the product). */
export type PublishActionWriteRequest = PublishActionWrite

/**
 * One row as the GET returns it: the shared wire shape. `noLongerApplies` names a waiting value the listing has
 * outgrown (it is already in that state, or the value is no longer allowed, or the listing on the channel is not the
 * one it was set on). The sheet shows "No longer applies"; the review leaves it out and the runner clears it.
 */
export type PublishActionCellRead = PublishActionCell

/** What a row was when a value was set, per column (`ChannelListing.publishActionBasis`). */
interface ColumnBasis { state: SellingState; externalListingId: string | null; setAt: string }
type Basis = Partial<Record<PublishActionColumn, ColumnBasis>>

const CHANNEL_LABEL: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }
const channelName = (channel: string) => CHANNEL_LABEL[channel] ?? channel
const MAX_ROWS_PER_WRITE = 2000

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null

// ── Reading the family on every destination ──────────────────────────────────────────────────────

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true,
  externalListingId: true, listingStatus: true, isPublished: true, offerClosedAt: true, offerCloseReason: true, offerActive: true,
  fulfillmentMethod: true, platformAttributes: true, followMasterQuantity: true, quantity: true, quantityOverride: true,
  publishAction: true, publishActionAt: true, publishActionById: true,
  sellingTarget: true, sellingTargetAt: true, sellingTargetById: true, publishActionBasis: true,
} as const

interface FamilyProduct { id: string; sku: string; parentId: string | null; isParent: boolean; fulfillmentMethod: string | null }
interface ListingRow {
  id: string; productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string
  externalListingId: string | null; listingStatus: string; isPublished: boolean; offerClosedAt: Date | null; offerCloseReason: string | null
  offerActive: boolean; fulfillmentMethod: string | null; platformAttributes: unknown
  followMasterQuantity: boolean; quantity: number | null; quantityOverride: number | null
  publishAction: string | null; publishActionAt: Date | null; publishActionById: string | null
  sellingTarget: string | null; sellingTargetAt: Date | null; sellingTargetById: string | null; publishActionBasis: unknown
}

/** One listing row with everything its options are decided from. */
interface RowRead {
  row: ListingRow
  product: FamilyProduct
  model: ListingModel
  state: SellingState
  reason: string | null
  facts: CapabilityFacts
  channelLabel: string
  /** Delete and relist: Nexus deleted it and it is not listed again (a row not on the channel: `create` is set too); else null. */
  deleted: PublishActionDeleted | null
  /** New listings: the row is not on the channel (deleted ones included): what Publish does with it; else null. */
  create: PublishActionCreate | null
  /** New listings: no listing record here — `row` is a stand-in whose id is a `new:` id (`newRowId`). */
  noRecord: boolean
}

interface FamilyRead {
  familyId: string
  products: FamilyProduct[]
  rows: RowRead[]
  /** Destinations where the family has listings but a product has none (product id → how many): the Shared scope's "left out". */
  missingByProduct: Map<string, number>
}

/** The read's options. `newRows`: also a stand-in row for every family member with no listing on each destination read. */
interface ReadOptions { newRows?: boolean }

/** A family member with no listing on a destination, as a row with nothing stored (its id is a `new:` id). */
function standInRow(product: FamilyProduct, d: NewRowRef): ListingRow {
  return {
    id: newRowId(d), productId: product.id, channel: d.channel, marketplace: d.marketplace, channelConnectionId: d.accountId, aliasKey: d.aliasKey,
    externalListingId: null, listingStatus: 'NOT_LISTED', isPublished: false, offerClosedAt: null, offerCloseReason: null, offerActive: true,
    fulfillmentMethod: null, platformAttributes: null, followMasterQuantity: true, quantity: null, quantityOverride: null,
    publishAction: null, publishActionAt: null, publishActionById: null, sellingTarget: null, sellingTargetAt: null, sellingTargetById: null, publishActionBasis: null,
  }
}

/** The variation rows left out of their listing (`variationExcluded`); none when this database has no such column. */
async function excludedRows(listingIds: string[]): Promise<Set<string>> {
  if (!listingIds.length) return new Set()
  try {
    return (await variationExcludedColumnExists()) ? await readExcludedListingIds(listingIds) : new Set()
  } catch (error) {
    logger.warn('publish actions: variation exclusions unreadable; drafts read as included', { error: error instanceof Error ? error.message : String(error) })
    return new Set()
  }
}

const destinationKey = (row: Pick<ListingRow, 'channel' | 'marketplace' | 'channelConnectionId' | 'aliasKey'>) =>
  `${row.channel}|${row.marketplace}|${row.channelConnectionId ?? ''}|${row.aliasKey}`

async function familyOf(productId: string): Promise<{ familyId: string; products: FamilyProduct[] }> {
  const seed = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!seed) throw new PublishActionError('This product is unavailable.', 404, 'not_found')
  const familyId = seed.parentId ?? seed.id
  const members = await prisma.product.findMany({
    where: { deletedAt: null, OR: [{ id: familyId }, { parentId: familyId }] },
    select: { id: true, sku: true, parentId: true, fulfillmentMethod: true },
    orderBy: { sku: 'asc' },
  })
  const hasChildren = members.some(p => p.parentId === familyId)
  return { familyId, products: members.map(p => ({ id: p.id, sku: p.sku, parentId: p.parentId, isParent: p.id === familyId && hasChildren, fulfillmentMethod: p.fulfillmentMethod ?? null })) }
}

async function readFamilyRows(productId: string, filter: PublishActionDestinationFilter = {}, options: ReadOptions = {}): Promise<FamilyRead> {
  const { familyId, products } = await familyOf(productId)
  const channel = filter.channel?.trim().toUpperCase() || undefined
  const marketplace = filter.marketplace?.trim().toUpperCase() || undefined
  const accountId = filter.accountId?.trim() || undefined
  const rows = await prisma.channelListing.findMany({
    where: {
      productId: { in: products.map(p => p.id) },
      ...(channel ? { channel } : {}), ...(marketplace ? { marketplace } : {}),
      ...(accountId ? { channelConnectionId: accountId } : {}), ...(filter.aliasKey !== undefined ? { aliasKey: filter.aliasKey } : {}),
    },
    select: LISTING_SELECT,
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { id: 'asc' }],
  }) as ListingRow[]
  const productOf = new Map(products.map(p => [p.id, p]))
  const byDestination = new Map<string, ListingRow[]>()
  for (const row of rows) {
    if (!productOf.has(row.productId)) continue
    const key = destinationKey(row)
    byDestination.set(key, [...(byDestination.get(key) ?? []), row])
  }
  // New listings: a destination the filter names exactly (channel, market, account; alias '' unless named) is read even
  // when the family has no listing there yet — every member is then a new row.
  const named: NewRowRef | null = channel && marketplace && accountId ? { productId: '', channel, marketplace, accountId, aliasKey: filter.aliasKey ?? '' } : null
  if (options.newRows && named) {
    const key = destinationKey({ channel: named.channel, marketplace: named.marketplace, channelConnectionId: named.accountId, aliasKey: named.aliasKey })
    if (!byDestination.has(key)) byDestination.set(key, [])
  }

  // A family split into several Shopify products (one per colour) is the Shopify colour lane's: read once for every store.
  const colourStores = rows.some(r => r.channel === 'SHOPIFY')
    ? new Set((await prisma.shopifyColourProduct.findMany({ where: { familyId }, select: { channelConnectionId: true } })).map(c => c.channelConnectionId))
    : new Set<string>()

  // eBay listings an older Claude close-listing paused (pinned at 0, no hold) read Inactive, as in the engine.
  const oldPauses = await oldClosePauses(rows.filter(r => r.channel === 'EBAY'))
  // Rows Nexus deleted and that are not listed again (the engine reads them the same way).
  const deletions = await readListingDeletions(rows)
  // New listings: draft variations left out of their listing read Not listed (Publish leaves them out today).
  const excluded = await excludedRows(rows.filter(row => !row.externalListingId && row.productId !== familyId).map(row => row.id))
  const out: RowRead[] = []
  const missingByProduct = new Map<string, number>()
  for (const [key, group] of byDestination) {
    const first = group[0]
    const d: NewRowRef = first
      ? { productId: '', channel: first.channel, marketplace: first.marketplace, accountId: first.channelConnectionId ?? '', aliasKey: first.aliasKey }
      : named!
    // THE engine's reader, per destination: model, Shopify colour split, every product's state and each row's FBA fact.
    const read = destinationSellingStates({ familyId, channel: d.channel, products, listings: group,
      shopifyColourProducts: !!d.accountId && colourStores.has(d.accountId), oldClosePauses: oldPauses, deletions })
    // New listings: what Publish does with every row not on the channel here (own choice, the main row's, the default —
    // Not listed for a row Nexus deleted).
    const familyRow = group.find(row => row.productId === familyId)
    const choices = newListingChoices({ channel: d.channel, aliasKey: d.aliasKey, familyId, products, listings: group, excludedListingIds: excluded,
      deletions,
      shopifyActive: d.channel === 'SHOPIFY' && String(nativeListingValue(familyRow ?? null, 'status', 'DRAFT') ?? '').toUpperCase() === 'ACTIVE' })
    const readRow = (row: ListingRow, product: FamilyProduct, noRecord: boolean) => {
      const { state, reason, deleted } = read.states.get(product.id) ?? { state: 'not_listed' as const, reason: null, deleted: null }
      const facts: CapabilityFacts = { isFba: read.isFba.get(row.id) ?? false, shopifyLinked: read.shopifyLinked, deleted: deleted ?? null,
        isMain: product.isParent, isVariation: !!product.parentId, noRecord, alias: d.aliasKey !== '', onChannel: !!row.externalListingId }
      const choice = isNewListingRow(state, facts) ? choices.get(product.id) : undefined
      out.push({ row, product, model: read.model, state, reason, facts, channelLabel: channelName(d.channel), noRecord,
        deleted: deleted ? { ...deleted, sentence: deletedShort(deleted) } : null,
        create: choice ? { target: choice.target, source: choice.source, defaultTarget: choice.defaultTarget, noRecord,
          sentence: newListingSentence(choice, { includedByDefault: choice.includedByDefault, deleted: choice.deleted }) } : null })
    }
    for (const row of group) readRow(row, productOf.get(row.productId)!, false)
    const listed = new Set(group.map(row => row.productId))
    for (const product of products) {
      if (listed.has(product.id)) continue
      if (group.length) missingByProduct.set(product.id, (missingByProduct.get(product.id) ?? 0) + 1)
      if (options.newRows && named && key === destinationKey({ channel: named.channel, marketplace: named.marketplace, channelConnectionId: named.accountId, aliasKey: named.aliasKey }))
        readRow(standInRow(product, { ...d, productId: product.id }), product, true)
    }
  }
  return { familyId, products, rows: out, missingByProduct }
}

// ── Options and the "No longer applies" rule ─────────────────────────────────────────────────────

const sendOptionsOf = (r: RowRead): SendModeOption[] =>
  sendModeOptions(r.model, r.state, { ...r.facts, isParent: r.product.isParent, isVariation: !!r.product.parentId }, r.channelLabel)
const statusOptionsOf = (r: RowRead): StatusOption[] => statusOptionsFor(r.state, r.model, r.facts, r.channelLabel)

function basisOf(row: ListingRow): Basis {
  const raw = object(row.publishActionBasis)
  const out: Basis = {}
  for (const column of ['send', 'status'] as const) {
    const b = object(raw[column])
    if (typeof b.state === 'string' && typeof b.setAt === 'string')
      out[column] = { state: b.state as SellingState, externalListingId: typeof b.externalListingId === 'string' ? b.externalListingId : null, setAt: b.setAt }
  }
  return out
}

/** A stored Status a new row cannot hold (Ended), or Not listed on a listing already on the channel. */
const NOT_FOR_NEW_ROW = 'Not possible for a listing that is not on the channel yet. Choose Active, Inactive or Not listed.'
const NOT_LISTED_ON_CHANNEL = 'This listing is on the channel now: Not listed applies only before the first Publish.'

/** Why a stored value no longer applies to this row, or null while it still does. */
function outgrown(r: RowRead, column: PublishActionColumn): string | null {
  // New listings: a stored Status is the row's create choice; it no longer applies only when it is not allowed now, or —
  // on a deleted row — when it was set before the delete (it belonged to the listing that was deleted).
  if (column === 'status' && r.create) {
    const target = statusTargetOf(r.row.sellingTarget)
    if (!target) return null
    if (r.deleted && setBeforeDelete(r.row.sellingTargetAt, r.deleted)) return `Set before the delete on ${deletedOn(r.deleted.at)}. To list it again, set Status to Active.`
    const option = statusOptionsOf(r).find(o => o.target === target)
    return !option ? NOT_FOR_NEW_ROW : option.offered ? null : option.reason
  }
  if (column === 'status' && statusTargetOf(r.row.sellingTarget) === 'not_listed') return NOT_LISTED_ON_CHANNEL
  // A deleted row: a Delete or Full update set before the delete belongs to the listing that was deleted. (One set since
  // the delete is an older relist choice: it reads as Status Active.)
  if (column === 'send' && r.deleted && r.row.publishAction && !r.deleted.relistChosenAt)
    return `Set before the delete on ${deletedOn(r.deleted.at)}. To list it again, set Status to Active.`
  const basis = basisOf(r.row)[column]
  if (basis?.externalListingId && r.row.externalListingId && basis.externalListingId !== r.row.externalListingId)
    return `The listing on ${r.channelLabel} changed since this was set (it was ${basis.externalListingId}, it is ${r.row.externalListingId} now).`
  if (column === 'send') {
    const mode = sendModeOf(r.row.publishAction)
    if (mode === 'partial') return null
    const option = sendOptionsOf(r).find(o => o.mode === mode)
    return option && !option.offered ? option.reason : null
  }
  const target = statusTargetOf(r.row.sellingTarget)
  if (!target) return null
  const option = statusOptionsOf(r).find(o => o.target === target)
  if (option && !option.offered) return option.reason
  if (option && !option.action) return `Already ${STATUS_TARGET_LABEL[target].toLowerCase()}.`
  return null
}

function cellOf(r: RowRead, names: Map<string, string | null>): PublishActionCellRead {
  const { row, product } = r
  return {
    listingId: row.id, productId: product.id, sku: product.sku,
    channel: row.channel, marketplace: row.marketplace, accountId: row.channelConnectionId ?? '', aliasKey: row.aliasKey,
    state: r.state, stateReason: r.reason,
    // A row not on the channel reads Full update (a create always sends the whole listing); a stored Delete shows until it
    // is cleared. Its time and author are a stored value's only (never an older relist choice's: that reads as Status Active).
    send: r.create
      ? { mode: row.publishAction === 'DELETE' ? 'delete' : 'full', setAt: row.publishAction ? iso(row.publishActionAt) : null,
        setById: row.publishAction ? row.publishActionById : null, setByName: row.publishAction && row.publishActionById ? names.get(row.publishActionById) ?? null : null,
        noLongerApplies: outgrown(r, 'send') }
      : { mode: sendModeOf(row.publishAction), setAt: iso(row.publishActionAt), setById: row.publishActionById,
        setByName: row.publishActionById ? names.get(row.publishActionById) ?? null : null, noLongerApplies: outgrown(r, 'send') },
    status: { target: statusTargetOf(row.sellingTarget), setAt: iso(row.sellingTargetAt), setById: row.sellingTargetById,
      setByName: row.sellingTargetById ? names.get(row.sellingTargetById) ?? null : null, noLongerApplies: outgrown(r, 'status') },
    deleted: r.deleted,
    create: r.create,
    sendOptions: sendOptionsOf(r),
    statusOptions: statusOptionsOf(r),
  }
}

/**
 * Every listing row of the product's family (optionally one destination, or part of one), with its waiting values and
 * options. `newRows` (New listings): when the filter names one destination exactly (channel, market, account; alias ''
 * unless named), every family member with no listing there is read too, as a new row with a `new:` listing id.
 */
export async function readPublishActions(productId: string, destination?: PublishActionDestinationFilter, options: ReadOptions = {}): Promise<PublishActionCellRead[]> {
  const family = await readFamilyRows(productId, destination, options)
  const names = await userNames(family.rows.flatMap(r => [r.row.publishActionById, r.row.sellingTargetById]))
  return family.rows.map(r => cellOf(r, names))
}

// ── Writing one column on many rows ──────────────────────────────────────────────────────────────

/** The change, checked: send → 'partial' | 'full' | 'delete'; status → a target or null (clear). */
export function parsePublishActionChange(column: unknown, value: unknown): PublishActionChange {
  if (column === 'send') {
    if (typeof value === 'string' && (SEND_MODES as readonly string[]).includes(value)) return { column: 'send', mode: value as SendMode }
    throw new PublishActionError('Choose Partial update, Full update or Delete.', 400, 'invalid_request')
  }
  if (column === 'status') {
    if (value === null || value === 'none') return { column: 'status', target: null }
    if (typeof value === 'string' && (ALL_STATUS_TARGETS as readonly string[]).includes(value)) return { column: 'status', target: value as StatusTarget }
    throw new PublishActionError('Choose Active, Inactive, Ended or Not listed (or none to clear the waiting value).', 400, 'invalid_request')
  }
  throw new PublishActionError('Choose the Action or the Status column.', 400, 'invalid_request')
}

/** Delete (Action) and Ended (Status) are deletes (house rule A-10); every other value is publishing. */
export const permissionForChange = (change: PublishActionChange): 'products.publish' | 'products.delete' =>
  (change.column === 'send' && change.mode === 'delete') || (change.column === 'status' && change.target === 'ended') ? 'products.delete' : 'products.publish'

const changeLabel = (change: PublishActionChange) =>
  change.column === 'send' ? SEND_MODE_LABEL[change.mode] : change.target ? STATUS_TARGET_LABEL[change.target] : 'No status change'
const changeValue = (change: PublishActionChange): SendMode | StatusTarget | null => change.column === 'send' ? change.mode : change.target

/** The Shared scope never lists a deleted market again: that choice is made in the market's own sheet. */
export const SHARED_DELETED = (where: string) => `Deleted on ${where}. To list it again, set its Status in the ${where} sheet.`

/** What the row's column would store for this change (null = the default: Partial update / nothing waiting), or a refusal. */
function decide(r: RowRead, change: PublishActionChange, fanOut = false): { stored: string | null } | { refused: string } {
  // The Shared scope never starts a listing.
  if (r.noRecord && fanOut) return { refused: SHARED_NO_LISTING }
  // Nor lists a deleted market again (Status), or sends anything to it (Action).
  if (r.deleted && fanOut) return { refused: SHARED_DELETED(r.deleted.where) }
  // A row not on the channel (new, or deleted): its Action reads Full update — choosing it stores nothing (it clears a
  // stored value), Partial update and Delete are refused with the reason; the Status is the create choice, stored as
  // chosen (even the default: a variation's own choice stands apart from its main row's).
  if (r.create) {
    if (change.column === 'send') {
      const option = sendOptionsOf(r).find(o => o.mode === change.mode)
      return option?.offered ? { stored: null } : { refused: option?.reason ?? 'Not available here.' }
    }
    if (!change.target) return { stored: null }
    const option = statusOptionsOf(r).find(o => o.target === change.target)
    if (!option) return { refused: NOT_FOR_NEW_ROW }
    return option.offered ? { stored: storedStatusTarget(change.target) } : { refused: option.reason ?? 'Not available here.' }
  }
  if (change.column === 'status' && change.target === 'not_listed') return { refused: NOT_LISTED_ON_CHANNEL }
  if (change.column === 'send') {
    if (change.mode === 'partial') return { stored: null }
    const option = sendOptionsOf(r).find(o => o.mode === change.mode)
    if (!option?.offered) return { refused: option?.reason ?? 'Not available here.' }
    return { stored: storedSendMode(change.mode) }
  }
  if (!change.target) return { stored: null }
  const option = statusOptionsOf(r).find(o => o.target === change.target)
  // Amazon and Etsy offer no Ended at all: a fill or a paste of Ended there says why.
  if (!option && change.target === 'ended' && (r.model === 'amazon' || r.model === 'etsy')) return { refused: r.model === 'amazon' ? AMAZON_NO_END : ETSY_NO_END }
  if (!option?.offered) return { refused: option?.reason ?? 'Not available here.' }
  // The row is already in that state: nothing waits (setting a row back to what it is clears its waiting value).
  return { stored: option.action ? storedStatusTarget(change.target) : null }
}

/** One column's stored value, who and when. */
const stored = (row: ListingRow, column: PublishActionColumn) => column === 'send'
  ? { value: row.publishAction, at: row.publishActionAt, by: row.publishActionById }
  : { value: row.sellingTarget, at: row.sellingTargetAt, by: row.sellingTargetById }

/** The compare-and-set guard: both columns' `…At` exactly as read. */
const guardOf = (row: ListingRow): Prisma.ChannelListingWhereInput =>
  ({ id: row.id, publishActionAt: row.publishActionAt, sellingTargetAt: row.sellingTargetAt })

/** Set (or clear, with value null) one column, with who, when and the basis of both columns. */
function columnData(column: PublishActionColumn, value: string | null, at: Date | null, by: string | null, basis: Basis): Prisma.ChannelListingUpdateManyMutationInput {
  const json = Object.keys(basis).length ? basis as unknown as Prisma.InputJsonValue : Prisma.DbNull
  return column === 'send'
    ? { publishAction: value, publishActionAt: at, publishActionById: by, publishActionBasis: json }
    : { sellingTarget: value, sellingTargetAt: at, sellingTargetById: by, publishActionBasis: json }
}

function parseExpected(value: unknown): Record<string, string | null> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new PublishActionError('expected must map listing ids to the time each value was set.', 400, 'invalid_request')
  const out: Record<string, string | null> = {}
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (at !== null && (typeof at !== 'string' || !Number.isFinite(Date.parse(at)))) throw new PublishActionError('expected must map listing ids to the time each value was set.', 400, 'invalid_request')
    out[id] = at as string | null
  }
  return out
}

/** The route's body, checked at one boundary: `{ listingIds?, expected?, allCoordinates? }`. */
export function parsePublishActionBody(body: unknown): Omit<PublishActionWriteRequest, 'change'> {
  const input = object(body)
  let listingIds: string[] | undefined
  if (input.listingIds !== undefined && input.listingIds !== null) {
    if (!Array.isArray(input.listingIds) || input.listingIds.some(id => typeof id !== 'string' || !id)) throw new PublishActionError('listingIds must be a list of listing ids.', 400, 'invalid_request')
    listingIds = [...new Set(input.listingIds as string[])]
  }
  if (input.allCoordinates !== undefined && typeof input.allCoordinates !== 'boolean') throw new PublishActionError('allCoordinates must be true or false.', 400, 'invalid_request')
  return { listingIds, expected: parseExpected(input.expected), allCoordinates: input.allCoordinates === true }
}

/**
 * Set or clear one column on many rows of one family. Refused rows keep their value and get the reason; rows someone
 * else changed since the client read them keep that person's value (a conflict); the rest are written with who and when.
 */
export async function writePublishActions(productId: string, write: PublishActionWriteRequest, actor: PublishActionActor): Promise<PublishActionWriteResult> {
  const change = parsePublishActionChange(write.change?.column, write.change ? changeValue(write.change) : undefined)
  const permission = permissionForChange(change)
  if (!actor.can(permission)) {
    throw new PublishActionError(permission === 'products.delete'
      ? 'Your role cannot end or delete listings, so it cannot set this either.'
      : 'Your role cannot publish listings, so it cannot set what Publish sends.', 403, 'forbidden')
  }
  const family = await readFamilyRows(productId)
  const rowsById = new Map(family.rows.map(r => [r.row.id, r]))
  let targets: Array<{ id: string; r: RowRead }>
  if (write.listingIds?.length) {
    if (write.listingIds.length > MAX_ROWS_PER_WRITE) throw new PublishActionError(`At most ${MAX_ROWS_PER_WRITE} rows per change.`, 400, 'invalid_request')
    await readNewRows(productId, write.listingIds, rowsById)
    const missing = write.listingIds.filter(id => !rowsById.has(id))
    if (missing.length) throw new PublishActionError('A chosen listing is not in this product\'s family.', 400, 'invalid_request')
    targets = write.listingIds.map(id => ({ id, r: rowsById.get(id)! }))
  } else if (write.allCoordinates) {
    // The Shared scope: every market of this product (one row of the sheet), where the value is allowed.
    targets = family.rows.filter(r => r.product.id === productId).map(r => ({ id: r.row.id, r }))
  } else {
    throw new PublishActionError('Choose the rows (listingIds), or every market of the product (allCoordinates).', 400, 'invalid_request')
  }
  // New listings: eBay holds a new listing at 0 only while the account's out-of-stock option is on — read it now.
  if (change.column === 'status' && change.target === 'inactive') await readEbayOutOfStock(targets.map(t => t.r))

  const applied: string[] = []
  const written: string[] = []
  const refused: PublishActionWriteResult['refused'] = []
  const conflictRows: RowRead[] = []
  const conflictIds = new Map<RowRead, string>()
  const now = new Date()
  const expectedOf = (id: string) => {
    const seen = write.expected && Object.prototype.hasOwnProperty.call(write.expected, id) ? write.expected[id] : undefined
    return seen === undefined ? undefined : seen === null ? null : new Date(seen).toISOString()
  }
  /** New listings: chosen rows with no listing yet, per destination — their drafts are started below. */
  const starting = new Map<string, Array<{ id: string; r: RowRead; stored: string }>>()

  for (const { id, r: target } of targets) {
    // `allCoordinates` marks a Shared-scope write (every market, or the listings it chose): a deleted market is listed
    // again only from its own market's sheet, and a market with no listing is never started from there.
    const decision = decide(target, change, !!write.allCoordinates)
    if ('refused' in decision) { refused.push({ listingId: id, sku: target.product.sku, reason: decision.refused }); continue }
    if (target.noRecord) {
      // Clearing a row that has no listing changes nothing; a choice starts its drafts (below).
      if (decision.stored === null) { applied.push(id); continue }
      const key = destinationKey(target.row)
      starting.set(key, [...(starting.get(key) ?? []), { id, r: target, stored: decision.stored }])
      continue
    }
    const expectedAt = expectedOf(id)
    let current = target.row
    let outcome: 'written' | 'unchanged' | 'conflict' = 'conflict'
    // Compare-and-set: the column's own `…At` against what the client saw, and both `…At`s against what this read saw
    // (the basis is one JSON for both columns, so a concurrent write to the other column is re-read, never overwritten).
    for (let attempt = 0; attempt < 3; attempt++) {
      const own = stored(current, change.column)
      if (expectedAt !== undefined && iso(own.at) !== expectedAt) { outcome = 'conflict'; break }
      // Nothing to write: the value is already stored (no value and no time — an older relist choice's lone time clears).
      if (decision.stored === null && own.value === null && own.at === null) { outcome = 'unchanged'; break }
      const setsValue = decision.stored !== null
      const basis = basisOf(current)
      if (!setsValue) delete basis[change.column]
      else basis[change.column] = { state: target.state, externalListingId: current.externalListingId, setAt: now.toISOString() }
      // A Status choice on a deleted row replaces an older relist choice (Action after the delete): it clears it.
      const legacy = change.column === 'status' && !!target.deleted?.relistChosenAt && current.publishActionAt
      if (legacy) delete basis.send
      const done = await prisma.channelListing.updateMany({
        where: guardOf(current),
        data: { ...columnData(change.column, decision.stored, setsValue ? now : null, setsValue ? actor.userId : null, basis),
          ...(legacy ? { publishAction: null, publishActionAt: null, publishActionById: null } : {}) },
      })
      if (done.count) { outcome = 'written'; break }
      const fresh = await prisma.channelListing.findUnique({ where: { id: current.id }, select: LISTING_SELECT }) as ListingRow | null
      if (!fresh) break
      current = fresh
    }
    if (outcome === 'conflict') { const row = { ...target, row: current }; conflictRows.push(row); conflictIds.set(row, id); continue }
    applied.push(id)
    if (outcome === 'written') written.push(target.row.id)
  }

  // New listings: start the drafts of each destination (the whole family, on the sheet's own account) and store the choice
  // in the same transaction.
  const started: PublishActionStarted = { sentence: '', listingIds: [], rows: [] }
  const sentences: string[] = []
  const createdProducts: string[] = []
  for (const items of starting.values()) {
    const outcome = await startNewRows(family, items, change.column, now, actor, expectedOf)
    if ('refused' in outcome) { for (const item of items) refused.push({ listingId: item.id, sku: item.r.product.sku, reason: outcome.refused }); continue }
    for (const item of outcome.conflicts) { conflictRows.push(item.r); conflictIds.set(item.r, item.id) }
    for (const row of outcome.rows) { applied.push(row.id); written.push(row.listingId); started.rows.push(row) }
    started.listingIds.push(...outcome.createdIds)
    createdProducts.push(...outcome.createdProducts)
    if (outcome.sentence) sentences.push(outcome.sentence)
  }
  started.sentence = sentences.join(' ')
  if (createdProducts.length) await refreshReadCache(createdProducts)

  const names = await userNames(conflictRows.map(r => stored(r.row, change.column).by))
  const conflicts = conflictRows.map(r => {
    const own = stored(r.row, change.column)
    return { listingId: conflictIds.get(r) ?? r.row.id, sku: r.product.sku, setAt: iso(own.at), setByName: own.by ? names.get(own.by) ?? null : null }
  })
  // The Shared scope never starts a listing: say how many markets it left out, for every product it wrote (one row of
  // the Shared scope per product; a fill over many rows counts each row's own missing markets).
  const writtenProducts = new Set(targets.map(target => target.r.product.id))
  const missing = write.allCoordinates && change.column === 'status'
    ? [...writtenProducts].reduce((sum, id) => sum + (family.missingByProduct.get(id) ?? 0), 0) : 0
  const leftOut = missing ? { count: missing, sentence: leftOutSentence(missing) } : null

  if (written.length) {
    announce(family.familyId, written, change.column, changeValue(change))
    await auditLogService.write({ userId: actor.userId, entityType: 'Product', entityId: family.familyId, action: `listing.publish_action.${change.column}`,
      metadata: { value: changeValue(change), label: changeLabel(change), listingIds: written, refused: refused.length, conflicts: conflicts.length,
        ...(started.listingIds.length ? { started: started.listingIds, startedSentence: started.sentence } : {}) } })
  }
  return { applied, refused, conflicts, started: started.rows.length || started.listingIds.length ? started : null, leftOut }
}

/**
 * New listings: the `new:` ids of a write name family members with no listing on a destination. Each such destination is
 * read with its new rows (the stand-ins); a member that has a listing there by now is the write's target instead.
 */
async function readNewRows(productId: string, ids: readonly string[], rowsById: Map<string, RowRead>) {
  const refs = ids.map(id => ({ id, ref: parseNewRowId(id) })).filter((entry): entry is { id: string; ref: NewRowRef } => !!entry.ref && !rowsById.has(entry.id))
  const destinations = new Map<string, NewRowRef>()
  for (const { ref } of refs) destinations.set(JSON.stringify([ref.channel, ref.marketplace, ref.accountId, ref.aliasKey]), ref)
  for (const d of destinations.values()) {
    const read = await readFamilyRows(productId, { channel: d.channel, marketplace: d.marketplace, accountId: d.accountId, aliasKey: d.aliasKey }, { newRows: true })
    for (const r of read.rows) {
      if (r.noRecord) { rowsById.set(r.row.id, r); continue }
      const id = newRowId({ productId: r.product.id, channel: r.row.channel, marketplace: r.row.marketplace, accountId: r.row.channelConnectionId ?? '', aliasKey: r.row.aliasKey })
      if (refs.some(entry => entry.id === id)) rowsById.set(id, r)
    }
  }
}

/** New listings: read each eBay account's out-of-stock option once, for the new eBay rows a write would set Inactive. */
async function readEbayOutOfStock(rows: RowRead[]) {
  const ebay = rows.filter(r => r.create && r.row.channel === 'EBAY')
  if (!ebay.length) return
  const { readEbayOutOfStockPreference } = await import('../channel-delist.service.js')
  const answers = new Map<string, Promise<'ON' | 'OFF' | 'UNKNOWN'>>()
  for (const r of ebay) {
    const key = `${r.row.channelConnectionId}|${r.row.marketplace}`
    if (!answers.has(key)) answers.set(key, readEbayOutOfStockPreference(r.row.channelConnectionId ?? '', r.row.marketplace).catch(() => 'UNKNOWN' as const))
    r.facts = { ...r.facts, ebayOutOfStockPreference: await answers.get(key)! }
  }
}

type StartOutcome = { refused: string } | {
  rows: Array<{ id: string; listingId: string }>
  conflicts: Array<{ id: string; r: RowRead }>
  createdIds: string[]
  createdProducts: string[]
  sentence: string | null
}

/**
 * New listings: start the drafts on ONE destination — the sheet's own account (never another), the primary listing, the
 * whole family (`ensureDraftListings`, family: true) — and store each chosen row's value, in one transaction. A row
 * someone else started meanwhile with a value of its own is a conflict (their value is kept).
 */
async function startNewRows(family: FamilyRead, items: Array<{ id: string; r: RowRead; stored: string }>, column: PublishActionColumn, now: Date,
  actor: PublishActionActor, expectedOf: (id: string) => string | null | undefined): Promise<StartOutcome> {
  const d = items[0].r.row
  if (d.aliasKey !== '') return { refused: 'An edit never creates an alias listing. Add this product to the listing alias first.' }
  try {
    return await prisma.$transaction(async tx => {
      const ensured = await ensureDraftListings(tx, { channel: d.channel, market: d.marketplace, accountId: d.channelConnectionId, aliasKey: '',
        productIds: [...new Set(items.map(item => item.r.product.id))], family: true })
      const byProduct = new Map(ensured.map(row => [row.productId, row]))
      const rows: Array<{ id: string; listingId: string }> = []
      const conflicts: Array<{ id: string; r: RowRead }> = []
      for (const item of items) {
        const listing = byProduct.get(item.r.product.id)
        if (!listing) throw new DraftListingError('PRODUCT_UNAVAILABLE', 'The family changed. Reload the product.')
        const current = await tx.channelListing.findUnique({ where: { id: listing.id }, select: LISTING_SELECT }) as ListingRow | null
        if (!current) throw new DraftListingError('PRODUCT_UNAVAILABLE', 'The family changed. Reload the product.')
        const own = stored(current, column)
        const expectedAt = expectedOf(item.id)
        if ((expectedAt !== undefined && iso(own.at) !== expectedAt) || (expectedAt === undefined && !listing.created && own.at)) {
          conflicts.push({ id: item.id, r: { ...item.r, row: current, noRecord: false } })
          continue
        }
        const basis = basisOf(current)
        basis[column] = { state: item.r.state, externalListingId: null, setAt: now.toISOString() }
        const done = await tx.channelListing.updateMany({ where: guardOf(current), data: columnData(column, item.stored, now, actor.userId, basis) })
        if (!done.count) { conflicts.push({ id: item.id, r: { ...item.r, row: current, noRecord: false } }); continue }
        rows.push({ id: item.id, listingId: listing.id })
      }
      const created = ensured.filter(row => row.created)
      const skuOf = new Map(family.products.map(p => [p.id, p.sku]))
      const main = created.find(row => row.productId === family.familyId)
      const sentence = created.length ? startedSentence(destinationLabel({ channel: d.channel, marketplace: d.marketplace }), {
        mainSku: main ? skuOf.get(main.productId) ?? null : null,
        variationSkus: created.filter(row => row.productId !== family.familyId).map(row => skuOf.get(row.productId) ?? row.productId) }) : null
      return { rows, conflicts, createdIds: created.map(row => row.id), createdProducts: created.map(row => row.productId), sentence }
    })
  } catch (error) {
    if (error instanceof DraftListingError || (error as { name?: string } | null)?.name === 'AmbiguousConnectionError') return { refused: (error as Error).message }
    throw error
  }
}

/** The product read cache of drafts a write started (as `bulk-edit.service.ts` does for its drafts). Never throws. */
async function refreshReadCache(productIds: string[]) {
  try {
    const { productReadCacheService } = await import('../product-read-cache.service.js')
    await productReadCacheService.refreshMany([...new Set(productIds)])
  } catch (error) {
    logger.warn('publish actions: product read cache not refreshed after starting drafts; it refreshes on its own', { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Tell other open sheets that waiting values changed (the ephemeral listing lane: a refresh hint, never thrown). */
function announce(familyId: string, listingIds: string[], column: PublishActionColumn, value: SendMode | StatusTarget | null) {
  try {
    publishListingEvent({ type: 'listing.publish_action_changed', productId: familyId, listingIds, column, value, ts: Date.now() })
  } catch (error) {
    logger.warn('publish actions: change event not published', { familyId, error: error instanceof Error ? error.message : String(error) })
  }
}

// ── For the Publish runners ──────────────────────────────────────────────────────────────────────

/**
 * Clear a waiting value once Publish has done it (or found the listing already there), but only on rows whose value
 * is unchanged since the review: `onlyIfSetAt` maps each listing id to the `setAt` of that column the review saw. A
 * row someone changed since (or that the review saw empty) keeps its value. Failures never call this: they keep it.
 */
export async function clearWaitingValues(listingIds: string[], column: PublishActionColumn, onlyIfSetAt: Record<string, string | Date | null>): Promise<{ cleared: string[]; kept: string[] }> {
  const cleared: string[] = []
  const kept: string[] = []
  const families = new Map<string, string[]>()
  for (const id of [...new Set(listingIds)]) {
    const seen = onlyIfSetAt[id]
    const seenAt = seen ? new Date(seen).getTime() : NaN
    let done = false
    for (let attempt = 0; attempt < 3 && Number.isFinite(seenAt) && !done; attempt++) {
      const row = await prisma.channelListing.findUnique({ where: { id }, select: LISTING_SELECT }) as ListingRow | null
      const own = row ? stored(row, column) : null
      if (!row || !own?.at || own.at.getTime() !== seenAt) break
      const basis = basisOf(row)
      delete basis[column]
      const result = await prisma.channelListing.updateMany({ where: guardOf(row), data: columnData(column, null, null, null, basis) })
      if (!result.count) continue
      done = true
      const owner = await prisma.product.findFirst({ where: { id: row.productId }, select: { id: true, parentId: true } })
      const familyId = owner ? owner.parentId ?? owner.id : row.productId
      families.set(familyId, [...(families.get(familyId) ?? []), id])
    }
    if (done) cleared.push(id)
    else kept.push(id)
  }
  for (const [familyId, ids] of families) announce(familyId, ids, column, column === 'send' ? 'partial' : null)
  return { cleared, kept }
}
