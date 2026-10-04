/**
 * Sheet publish parity, step 7 (item 5) and build shape v2 (Owner 2026-10-04) — THE listing-action engine: the sheet's
 * per-channel Status column (Active / Inactive / Ended) and the Action column's Delete, and Claude's close-listing /
 * reopen-listing (listing-close.service.ts wraps Pause offer / Resume offer). A change is never a silent autosave: a
 * PREVIEW says what each row would do (plain English), the person confirms, and the RUN makes the channel calls through
 * one channel adapter (./listing-action-adapters/*), each of them through the channel gateway. The rules are the shared
 * ones (packages/shared/src/listing-actions.ts); Delete is typed-confirmed like End (token 'DELETE', the family SKU).
 *
 *   readListingActionState  → every row's selling state and the changes it may offer (no channel call)
 *   planListingAction       → the per-row plan, nothing saved (Claude's dry run reads it)
 *   previewListingAction    → the per-row plan, saved as a BulkOperation (kind 'listing-action', status PREVIEW, 15 min)
 *   runListingAction        → checks the confirm and the publish mode, then executeListingAction
 *   executeListingAction    → claims the preview (PREVIEW → RUNNING), re-reads the rows, runs the adapter, audits,
 *                             and finishes the BulkOperation. THE SEAM for batching: a batch worker calls this with a
 *                             preview id; nothing here depends on an HTTP request.
 *
 * Safety: the destination is resolved exactly (account + alias; never another account's or business's rows); the
 * publish mode of the channel must be live or nothing changes; a row that changed since the preview is skipped, not
 * guessed; every row the channel touched gets an audit record (ChannelListingSnapshot, reason = the action).
 */
import { randomUUID } from 'node:crypto'
import {
  ACTIONS_FROM_STATE, actionsFor, AMAZON_PAN_EU_DELETE_WARNING, deletedPublishSkip, deletedStatusReason, deleteOffered, familySellingState,
  fbaDeleteWarning, LISTING_ACTION_LABEL, LISTING_ACTIONS, listingActionCapability, SELLING_STATE_LABEL, sellingStateOf,
  type ActionReach, type CapabilityFacts, type ListingAction, type ListingActionConfirm, type ListingActionDestination,
  type ListingActionPlanRow, type ListingActionPreview, type ListingActionRowResult, type ListingActionRunResult,
  type ListingActionRunStatus, type ListingActionStateRead, type ListingActionStateRow, type ListingDeletion, type ListingModel,
  type SellingState, type SellingStateRead,
} from '@nexus/shared/listing-actions'
import { isOldClosePause } from '@nexus/shared/push-lock'
import prisma from '../../db.js'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { etsyWriteRefusal } from '../etsy-publish-gate.service.js'
import { readEbayOutOfStockPreference } from '../channel-delist.service.js'
import { auditLogService } from '../audit-log.service.js'
import { publishListingEvent } from '../listing-events.service.js'
import { resolveWorkspaceDestination, WorkspaceScopeError } from '../pim/workspace-destination.js'
import { usesEbayInventory } from '../pim/ebay-listing-model.js'
import { logger } from '../../utils/logger.js'
import { amazonListingActions } from './listing-action-adapters/amazon.js'
import { ebayTradingListingActions } from './listing-action-adapters/ebay-trading.js'
import { ebayInventoryListingActions } from './listing-action-adapters/ebay-inventory.js'
import { shopifyListingActions } from './listing-action-adapters/shopify.js'
import { etsyListingActions } from './listing-action-adapters/etsy.js'
import { amazonMarket, readFbaUnits, readListingDeletions, usesPanEu } from './listing-deletions.js'
import type { ActionContext, ActionListing, AdapterRowResult, ListingActionAdapter } from './listing-action-adapters/types.js'
import { object } from './listing-action-adapters/types.js'

export const LISTING_ACTION_KIND = 'listing-action'
const PREVIEW_TTL_MS = 15 * 60_000

/** A refusal with its HTTP status and a machine code; the message is what the person reads. */
export class ListingActionError extends Error {
  constructor(message: string, readonly statusCode = 409, readonly code = 'LISTING_ACTION_REFUSED') { super(message) }
}

const ADAPTERS: Record<Exclude<ListingModel, 'unsupported'>, ListingActionAdapter> = {
  amazon: amazonListingActions,
  'ebay-trading': ebayTradingListingActions,
  'ebay-inventory': ebayInventoryListingActions,
  shopify: shopifyListingActions,
  etsy: etsyListingActions,
}

const CHANNEL_LABEL: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' }
const channelName = (channel: string) => CHANNEL_LABEL[channel] ?? channel
/** "Amazon · IT", "eBay · IT", "Shopify" (a store is one market for this purpose). */
export const destinationLabel = (d: Pick<ListingActionDestination, 'channel' | 'marketplace'>) =>
  d.channel === 'SHOPIFY' || d.marketplace === 'GLOBAL' ? channelName(d.channel) : `${channelName(d.channel)} · ${d.marketplace}`

export function isListingAction(value: unknown): value is ListingAction {
  return typeof value === 'string' && (LISTING_ACTIONS as readonly string[]).includes(value)
}

/** The channel's publish mode must be live, as for publishing. A sentence when it is not; null when it is. */
export function listingActionGate(channel: string): string | null {
  if (channel === 'AMAZON') {
    const mode = getAmazonPublishMode()
    return mode === 'live' ? null : `Amazon changes are switched off on this server (publish mode: ${mode}). Nothing was changed.`
  }
  if (channel === 'EBAY') {
    const mode = getEbayPublishMode()
    if (mode !== 'live') return `eBay changes are switched off on this server (publish mode: ${mode}). Nothing was changed.`
    if (process.env.NEXUS_EBAY_REAL_API !== 'true' || process.env.EBAY_SANDBOX === 'true') return 'The real eBay API is not enabled on this server. Nothing was changed.'
    return null
  }
  if (channel === 'SHOPIFY') {
    const mode = getShopifyPublishMode()
    return mode === 'live' ? null : `Shopify changes are switched off on this server (publish mode: ${mode}). Nothing was changed.`
  }
  if (channel === 'ETSY') {
    const refusal = etsyWriteRefusal()
    return refusal ? refusal.replace('Nothing was sent to Etsy.', 'Nothing was changed.') : null
  }
  return `Changing the status of ${channelName(channel)} listings from Nexus is not available yet. Nothing was changed.`
}

// ── Reading the family on one destination ────────────────────────────────────────────────────────

export interface DestinationInput { channel?: unknown; marketplace?: unknown; market?: unknown; accountId?: unknown; aliasKey?: unknown }

async function destinationOf(productId: string, input: DestinationInput) {
  const channel = typeof input.channel === 'string' ? input.channel.trim().toUpperCase() : ''
  const marketplace = typeof input.marketplace === 'string' ? input.marketplace.trim().toUpperCase()
    : typeof input.market === 'string' ? input.market.trim().toUpperCase() : ''
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
  if (!accountId) throw new ListingActionError('Choose the connected account.', 400, 'invalid_request')
  const aliasKey = typeof input.aliasKey === 'string' ? input.aliasKey : ''
  const resolved = await resolveWorkspaceDestination({ productId, channel, marketplace, accountId, aliasKey: aliasKey || undefined })
  return { familyId: resolved.familyId, destination: { channel, marketplace, accountId: resolved.accountId, aliasKey: resolved.aliasKey ?? '' } satisfies ListingActionDestination }
}

// ── THE selling-state reader (one destination) ───────────────────────────────────────────────────

/** Build shape v2 (P13) — what an eBay listing an OLDER Claude close-listing paused reads (`oldClosePauses`). */
export const OLD_CLOSE_PAUSE_REASON = 'Inactive: quantity 0 on eBay, pinned by an earlier Claude close. Set Active and Publish to sell again; Nexus then follows the stock.'

/** The listing facts `oldClosePauses` reads (every one is in the generated client except the presence marks). */
export interface OldClosePauseCandidate {
  id: string
  channel: string
  listingStatus?: string | null
  offerClosedAt?: Date | null
  followMasterQuantity?: boolean | null
  quantity?: number | null
  quantityOverride?: number | null
}

/**
 * Build shape v2 (P13) — which of these rows an OLDER Claude close-listing paused (MCP full control L9, 2026-10-02 until
 * build shape v2): an eBay listing pinned at 0 through the Matrix with the presence mark `endedAt`, and no hold
 * (`isOldClosePause`, packages/shared/push-lock.ts — the one rule). A READ rule: nothing is written; such a row reads
 * Inactive, and Resume lifts the pin (hold.ts). The presence columns are not in the generated client, so they are read
 * raw — and only for the rows that already look paused (eBay, pinned at 0, no hold), so most reads add no query. A
 * database without the columns, or a failed read, reads every row as before.
 */
export async function oldClosePauses(rows: readonly OldClosePauseCandidate[]): Promise<Set<string>> {
  const candidates = rows.filter(row => isOldClosePause({ ...row, endedAt: 'checked below' }))
  if (!candidates.length) return new Set()
  try {
    const has = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ChannelListing' AND column_name IN ('endedAt', 'endedReason')`)
    if ((has[0]?.n ?? 0) !== 2) return new Set()
    const marks = await prisma.$queryRawUnsafe<Array<{ id: string; endedAt: Date | null; endedReason: string | null }>>(
      `SELECT id, "endedAt", "endedReason" FROM "ChannelListing" WHERE id = ANY($1::text[]) AND "endedAt" IS NOT NULL`, candidates.map(row => row.id))
    const markOf = new Map(marks.map(mark => [mark.id, mark]))
    return new Set(candidates.filter(row => {
      const mark = markOf.get(row.id)
      return !!mark && isOldClosePause({ ...row, endedAt: mark.endedAt, endedReason: mark.endedReason })
    }).map(row => row.id))
  } catch (err) {
    logger.warn('[listing-action] older close marks unreadable; those listings read as before', { error: err instanceof Error ? err.message : String(err) })
    return new Set()
  }
}

/** One member of a family, as the state reader needs it. */
export interface SellingStateProduct { id: string; sku: string; isParent: boolean; fulfillmentMethod?: string | null }

/** One listing row of the family on ONE destination (channel + market + account + alias). */
export interface SellingStateListing {
  id: string
  productId: string
  externalListingId: string | null
  listingStatus: string
  isPublished: boolean
  offerClosedAt: Date | null
  offerCloseReason: string | null
  offerActive: boolean
  fulfillmentMethod: string | null
  platformAttributes: unknown
}

export interface DestinationSellingStates {
  model: ListingModel
  /** Facts every row of this destination shares (a Shopify colour split refuses every action). */
  shopifyLinked: boolean
  /** Every product of the family (a product with no row here reads Not listed). */
  states: Map<string, SellingStateRead>
  /** Per listing row: Amazon fulfils it (FBA) — the capability fact `isFba`. */
  isFba: Map<string, boolean>
}

/**
 * THE selling-state reader for one family on ONE destination — the engine (preview, run, state read) and the waiting
 * values (publish-action.service.ts) read the same states from the same facts; no channel call, no database read.
 *
 * - Model: Amazon; eBay Trading or Inventory (`usesEbayInventory`); Shopify; Etsy; anything else unsupported.
 * - A variation reads its own row. A main product reads its variations (they are what sells), unless its own listing
 *   is Ended; on Shopify, unless the product itself stops selling (Archived, Draft or Unlisted in Shopify) or no
 *   variation has a row there.
 * - Shopify: the product's status is the family listing's (Active / Draft / Archived, `platformAttributes.status`), but
 *   Pause offer is a quantity-0 hold PER VARIANT, so each variant reads its own hold: one paused variant reads Inactive
 *   and its product Mixed.
 */
export function destinationSellingStates(input: {
  familyId: string
  channel: string
  products: readonly SellingStateProduct[]
  listings: readonly SellingStateListing[]
  /** Shopify: the family has colour products on this store (ShopifyColourProduct rows for the account). */
  shopifyColourProducts?: boolean
  /** Shown for a product with no row here. */
  notListedReason?: string | null
  /** eBay rows an OLDER Claude close-listing paused (`oldClosePauses`): they read Inactive. */
  oldClosePauses?: ReadonlySet<string>
  /** Rows Nexus deleted and that are not listed again (`readListingDeletions`): they read Not listed (a row not on the channel). */
  deletions?: ReadonlyMap<string, ListingDeletion>
}): DestinationSellingStates {
  const { familyId, channel } = input
  const listingOf = new Map(input.listings.map(row => [row.productId, row]))
  const familyListing = listingOf.get(familyId)
  let model: ListingModel = 'unsupported'
  let shopifyLinked = false
  if (channel === 'AMAZON') model = 'amazon'
  else if (channel === 'EBAY') model = usesEbayInventory({ listings: input.listings }) ? 'ebay-inventory' : 'ebay-trading'
  else if (channel === 'ETSY') model = 'etsy'
  else if (channel === 'SHOPIFY') {
    model = 'shopify'
    const linkedDraft = object(object(familyListing?.platformAttributes)._nexusLinkedProducts)
    shopifyLinked = !!input.shopifyColourProducts || (linkedDraft.version === 1 && (!linkedDraft.informationOnly || !!linkedDraft.relationship))
  }
  const rowState = (row: SellingStateListing | undefined): SellingStateRead => {
    if (!row) return { state: 'not_listed', reason: input.notListedReason ?? null }
    if (channel === 'EBAY' && input.oldClosePauses?.has(row.id)) return { state: 'paused', reason: OLD_CLOSE_PAUSE_REASON }
    const owner = channel === 'SHOPIFY' ? familyListing ?? row : row
    const status = object(owner.platformAttributes).status
    return sellingStateOf({
      channel, listingStatus: owner.listingStatus, isPublished: owner.isPublished, externalListingId: owner.externalListingId,
      offerClosedAt: row.offerClosedAt, offerCloseReason: row.offerCloseReason, offerActive: row.offerActive,
      shopifyStatus: typeof status === 'string' ? status : null,
      deletion: input.deletions?.get(row.id) ?? input.deletions?.get(owner.id) ?? null,
    })
  }
  const states = new Map<string, SellingStateRead>()
  const children = input.products.filter(p => !p.isParent)
  for (const product of children) states.set(product.id, rowState(listingOf.get(product.id)))
  for (const product of input.products) {
    if (!product.isParent) continue
    const own = listingOf.get(product.id)
    const ownState = own ? rowState(own) : null
    // Shopify: the product is the listing — its own state when it stops the whole product, or when no variant has a row.
    const ownWins = channel === 'SHOPIFY'
      ? ownState?.state === 'ended' || ownState?.state === 'paused' || !children.some(p => listingOf.has(p.id))
      : ownState?.state === 'ended'
    // Delete and relist: a main product Nexus deleted reads its own delete (Not listed, a row not on the channel).
    const read = ownState?.deleted ? ownState : ownWins && ownState ? ownState : familySellingState(children.map(p => states.get(p.id)!.state))
    // A main product whose every listed variation Nexus deleted reads as they do (Not listed, with the newest delete's
    // words); it is a row not on the channel itself only when its own listing is not on the channel either.
    const listedChildren = children.filter(p => listingOf.has(p.id)).map(p => states.get(p.id)!)
    const deleted = !read.deleted && read.state === 'not_listed' && listedChildren.length && listedChildren.every(child => child.deleted)
      ? listedChildren.map(child => child.deleted!).sort((a, b) => b.at.localeCompare(a.at))[0] : null
    states.set(product.id, deleted ? { state: 'not_listed', reason: deletedStatusReason(deleted), ...(own?.externalListingId ? {} : { deleted }) } : read)
  }
  const fulfilment = new Map(input.products.map(p => [p.id, p.fulfillmentMethod ?? null]))
  const isFbaOf = new Map(input.listings.map(row => [row.id, isFbaCoordinate({ fulfillmentMethod: row.fulfillmentMethod, platformAttributes: row.platformAttributes, product: { fulfillmentMethod: fulfilment.get(row.productId) ?? null } })]))
  return { model, shopifyLinked, states, isFba: isFbaOf }
}

interface FamilyRead {
  familyId: string
  familySku: string
  products: Array<{ id: string; sku: string; isParent: boolean }>
  listings: Map<string, ActionListing>
  model: ListingModel
  facts: { shopifyLinked: boolean }
  states: Map<string, SellingStateRead>
}

async function readFamily(familyId: string, destination: ListingActionDestination): Promise<FamilyRead> {
  const products = await prisma.product.findMany({
    where: { deletedAt: null, OR: [{ id: familyId }, { parentId: familyId }] },
    select: { id: true, sku: true, parentId: true, fulfillmentMethod: true },
    orderBy: { sku: 'asc' },
  })
  const parent = products.find(p => p.id === familyId)
  if (!parent) throw new ListingActionError('This product is unavailable.', 404, 'not_found')
  const hasChildren = products.some(p => p.parentId === familyId)
  const productOf = new Map(products.map(p => [p.id, p]))
  const rows = (await prisma.channelListing.findMany({
    where: { productId: { in: products.map(p => p.id) }, channel: destination.channel, marketplace: destination.marketplace,
      channelConnectionId: destination.accountId, aliasKey: destination.aliasKey },
    select: { id: true, productId: true, externalListingId: true, listingStatus: true, isPublished: true, offerClosedAt: true,
      offerCloseReason: true, offerActive: true, fulfillmentMethod: true, platformAttributes: true,
      followMasterQuantity: true, quantity: true, quantityOverride: true, publishAction: true, publishActionAt: true },
  })).filter(row => productOf.has(row.productId))
  const oldPauses = destination.channel === 'EBAY' ? await oldClosePauses(rows.map(row => ({ ...row, channel: 'EBAY' }))) : new Set<string>()
  const deletions = await readListingDeletions(rows.map(row => ({ ...row, channel: destination.channel, marketplace: destination.marketplace })))
  const listings = new Map<string, ActionListing>()
  for (const row of rows) {
    const product = productOf.get(row.productId)!
    listings.set(row.productId, {
      id: row.id, productId: row.productId, sku: product.sku, isParent: row.productId === familyId && hasChildren,
      externalListingId: row.externalListingId, listingStatus: row.listingStatus, isPublished: row.isPublished,
      offerClosedAt: row.offerClosedAt, offerCloseReason: row.offerCloseReason, offerActive: row.offerActive,
      fulfillmentMethod: row.fulfillmentMethod, productFulfillmentMethod: product.fulfillmentMethod ?? null, platformAttributes: row.platformAttributes,
      ...(oldPauses.has(row.id) ? { oldClosePause: true } : {}),
    })
  }
  const members = products.map(p => ({ id: p.id, sku: p.sku, isParent: p.id === familyId && hasChildren, fulfillmentMethod: p.fulfillmentMethod ?? null }))
  const colourProducts = destination.channel === 'SHOPIFY'
    ? await prisma.shopifyColourProduct.count({ where: { familyId, channelConnectionId: destination.accountId } }) : 0
  const read = destinationSellingStates({ familyId, channel: destination.channel, products: members, listings: rows,
    shopifyColourProducts: colourProducts > 0, notListedReason: `No listing on ${destinationLabel(destination)} yet. Publish creates it.`, oldClosePauses: oldPauses, deletions })
  return {
    familyId, familySku: parent.sku, products: members.map(({ id, sku, isParent }) => ({ id, sku, isParent })),
    listings, model: read.model, facts: { shopifyLinked: read.shopifyLinked }, states: read.states,
  }
}

const isFba = (row: ActionListing) => isFbaCoordinate({ fulfillmentMethod: row.fulfillmentMethod, platformAttributes: row.platformAttributes, product: { fulfillmentMethod: row.productFulfillmentMethod } })

/** Every product's state on the destination (read once with the family). */
const statesOf = (family: FamilyRead, _destination: ListingActionDestination) => family.states

const capabilityFacts = (row: ActionListing | undefined, family: FamilyRead, extra: CapabilityFacts = {}): CapabilityFacts =>
  ({ isFba: row ? isFba(row) : false, shopifyLinked: family.facts.shopifyLinked, deleted: row ? family.states.get(row.productId)?.deleted ?? null : null, ...extra })

export async function readListingActionState(productId: string, input: DestinationInput): Promise<ListingActionStateRead> {
  const { familyId, destination } = await destinationOf(productId, input)
  const family = await readFamily(familyId, destination)
  const states = statesOf(family, destination)
  const label = channelName(destination.channel)
  const rows: ListingActionStateRow[] = family.products.map(product => {
    const listing = family.listings.get(product.id)
    const { state, reason } = states.get(product.id)!
    const facts = capabilityFacts(listing, family)
    const refusals: Partial<Record<ListingAction, string>> = {}
    for (const action of ACTIONS_FROM_STATE[state]) {
      const capability = listingActionCapability(family.model, action, facts, label)
      if (!capability.offered && capability.reason) refusals[action] = capability.reason
    }
    return { productId: product.id, listingId: listing?.id ?? null, sku: product.sku, isParent: product.isParent, state, reason,
      actions: actionsFor(state, family.model, facts, label), refusals }
  })
  return { destination, model: family.model, rows, readAt: new Date().toISOString() }
}

// ── The plan (preview and run share it) ─────────────────────────────────────────────────────────

interface Plan {
  reach: ActionReach
  checkedAtSend: string | null
  rows: ListingActionPlanRow[]
  /** listing rows to send, by product id */
  send: Map<string, ActionListing>
}

const SKIP_WORDS: Record<ListingAction, Partial<Record<SellingState, string>>> = {
  pause: { paused: 'Already inactive.', ended: 'Ended — nothing to pause.' },
  resume: { active: 'Not inactive.', ended: 'Ended — use Relist.' },
  end: { ended: 'Already ended.' },
  relist: { active: 'Not ended.', paused: 'Not ended — use Resume offer.', mixed: 'Not ended.' },
  delete: {},
}

function planFor(action: ListingAction, family: FamilyRead, destination: ListingActionDestination, requested: string[] | null, extra: CapabilityFacts = {}): Plan {
  const label = channelName(destination.channel)
  const states = statesOf(family, destination)
  const base = listingActionCapability(family.model, action, capabilityFacts(undefined, family, extra), label)
  const reach = base.reach
  // Which products the change reaches: the chosen rows; a main product means its variations; an item- or
  // product-level change reaches the whole family (the web shows that in the consequence and the rows).
  const chosen = new Set(requested ?? family.products.map(p => p.id))
  const children = family.products.filter(p => !p.isParent)
  if (reach !== 'row' || family.products.some(p => p.isParent && chosen.has(p.id))) for (const child of children) chosen.add(child.id)
  if (reach !== 'row') for (const product of family.products) chosen.add(product.id)

  const rows: ListingActionPlanRow[] = []
  const send = new Map<string, ActionListing>()
  for (const product of family.products) {
    if (!chosen.has(product.id)) continue
    const listing = family.listings.get(product.id)
    const { state } = states.get(product.id)!
    const row = (plan: ListingActionPlanRow['plan'], sentence: string) => rows.push({ productId: product.id, listingId: listing?.id ?? null, sku: product.sku, plan, sentence })
    // A main product of a family has no offer or stock of its own: its variations carry the change. Two exceptions: on
    // Shopify it IS the product, so a product-level change (End, Relist, Delete) reaches it; and Delete reaches a main
    // product's own channel listing everywhere (on Amazon after its variations), so its old channel id is audited too.
    const parentCarries = destination.channel === 'SHOPIFY' ? reach !== 'row' : action === 'delete' && !!listing?.externalListingId
    if (product.isParent && !parentCarries) { row('skip', 'The main product follows its variations.'); continue }
    // Delete and relist: a row Nexus deleted takes no selling change (refused, with the way to list it again: its Status
    // column, Active); a Delete has nothing left to do there.
    const deleted = states.get(product.id)!.deleted
    if (deleted) { row(action === 'delete' ? 'skip' : 'refused', deletedPublishSkip(deleted)); continue }
    if (!listing || state === 'not_listed') { row('skip', `Not on ${destinationLabel(destination)} yet. Publish creates it.`); continue }
    const facts = capabilityFacts(listing, family, extra)
    if (action === 'delete') {
      const capability = deleteOffered(state, family.model, facts, label)
      if (!capability.offered) { row(state === 'draft' ? 'skip' : 'refused', capability.reason ?? 'Not available here.'); continue }
      row('send', ACTION_SENTENCE.delete)
      send.set(product.id, listing)
      continue
    }
    if (!ACTIONS_FROM_STATE[state].includes(action)) { row('skip', SKIP_WORDS[action][state] ?? `It is ${SELLING_STATE_LABEL[state].toLowerCase()}.`); continue }
    const capability = listingActionCapability(family.model, action, facts, label)
    if (!capability.offered) { row('refused', capability.reason ?? 'Not available here.'); continue }
    // An offered change the person should know about first (an FBA pause) says so on its row.
    row('send', capability.warning ? `${ACTION_SENTENCE[action]} ${capability.warning}` : ACTION_SENTENCE[action])
    send.set(product.id, listing)
  }
  return { reach, checkedAtSend: base.checkedAtSend, rows, send }
}

const ACTION_SENTENCE: Record<ListingAction, string> = {
  pause: 'Stops selling here.', resume: 'Sells here again.', end: 'Ends here.', relist: 'Listed here again.',
  delete: 'Deleted from the channel here. Its Status then reads Not listed: to list it again, set Status to Active and Publish.',
}

/** After a Delete, the row reads Not listed (and every Publish skips it) until its Status is set to Active and Publish runs. */
const RELIST_HOW = 'To list it again, set Status to Active and Publish.'

const GONE = 'This cannot be undone.'

function consequenceOf(action: ListingAction, family: FamilyRead, destination: ListingActionDestination, sendCount: number, sent: ActionListing[]): string {
  const where = destinationLabel(destination)
  const skus = `${sendCount} SKU${sendCount === 1 ? '' : 's'}`
  const variations = family.products.filter(p => !p.isParent).length
  const whole = variations ? `${family.familySku} and all ${variations} variations` : family.familySku
  switch (family.model) {
    case 'amazon':
      if (action === 'pause') return `${where} stops selling ${skus}: this market's offer is removed. Other markets keep selling; the listing, its reviews and its page stay. Undo with Resume offer.${sent.some(isFba) ? ' FBA units stay in Amazon\'s warehouse and Amazon keeps their quantity.' : ''}`
      if (action === 'resume') return `${where} sells ${skus} again at the price they had when paused (a listing created inactive gets Nexus's price), and Nexus sends their current stock${sent.some(isFba) ? ' (FBA: Amazon keeps its own quantity; Nexus sends none)' : ''}.`
      return `Amazon deletes ${skus} on ${where} only; other markets keep their listings. Nexus keeps them here as Not listed. ${RELIST_HOW}${sent.some(isFba) ? ' FBA units stay in Amazon\'s warehouse and cannot sell here until then.' : ''} ${GONE}`
    case 'ebay-trading':
    case 'ebay-inventory':
      if (action === 'pause') return `${where} shows quantity 0 for ${skus}; the listing and its item number stay. Nexus holds every stock push until you resume.`
      if (action === 'resume') return `${where} gets the current stock again for ${skus} (a pinned quantity comes back).`
      if (action === 'end') return `eBay ends ${whole} on ${where}. To sell again, Relist makes a new eBay item number.`
      if (action === 'delete') return family.model === 'ebay-trading'
        ? `eBay ends ${whole} on ${where} (if it is still live) and Nexus forgets its item number; Nexus keeps it here as Not listed. ${RELIST_HOW} ${GONE}`
        : `eBay withdraws ${whole} on ${where} and deletes this marketplace's offers; the inventory items stay for other marketplaces. Nexus keeps the listing here as Not listed. ${RELIST_HOW} ${GONE}`
      return `eBay lists ${whole} again on ${where} with a new item number. Nexus saves it on this business's listing only, then sends the stock.`
    case 'shopify': {
      const productStatus = String(object(family.listings.get(family.familyId)?.platformAttributes).status ?? '').toUpperCase()
      if (action === 'pause') return `Shopify shows quantity 0 for ${skus}; the product page stays and shows "sold out". Nexus holds every stock push until you resume. A variant that sells when out of stock is not paused.`
      if (action === 'resume') return productStatus === 'DRAFT' || productStatus === 'UNLISTED'
        ? `Shopify makes ${family.familySku} active again in every market of the store, and gets the current stock again for ${skus}.`
        : `Shopify gets the current stock again for ${skus}; Nexus lifts its hold (a pinned quantity comes back).`
      if (action === 'end') return `Shopify archives ${family.familySku} in every market of the store. Relist makes it active again.`
      if (action === 'delete') return `Shopify deletes ${family.familySku} and all its variants in every market of the store. Nexus keeps the product here as Not listed. ${RELIST_HOW} ${GONE}`
      return `Shopify makes ${family.familySku} active again in every market of the store, and Nexus sends the current stock.`
    }
    case 'etsy':
      if (action === 'pause') return `Etsy sets ${family.familySku} inactive: buyers cannot find or buy it; the listing stays. Nexus holds every stock push until you resume.`
      if (action === 'resume') return `Etsy sets ${family.familySku} active again. Etsy may set its quantity to 1 and charge a renewal fee; Nexus then sends the current stock.`
      return listingActionGate(destination.channel) ?? 'Not available here.'
    default:
      return listingActionGate(destination.channel) ?? 'Not available here.'
  }
}

/**
 * End and Delete are typed. End: the eBay item number when there is one, else the family SKU; Delete: the family SKU.
 * The shared `ListingActionConfirm.token` names only 'END' (packages/shared/src/listing-actions.ts); widening it to
 * 'END' | 'DELETE' there removes this cast.
 */
function confirmOf(action: ListingAction, family: FamilyRead): ListingActionConfirm {
  if (action === 'delete') return { kind: 'type', expected: family.familySku, token: 'DELETE' }
  if (action !== 'end') return { kind: 'checkbox', expected: null, token: null }
  const itemId = family.model === 'ebay-trading'
    ? [...family.listings.values()].find(row => /^\d+$/.test(row.externalListingId ?? ''))?.externalListingId ?? null : null
  return { kind: 'type', expected: itemId ?? family.familySku, token: 'END' }
}

const CHOOSE_ACTION = 'Choose pause, resume, end, relist or delete.'

/** What a preview would show, without saving it: the per-row plan for one family on one destination. */
export interface ListingActionPlan extends Omit<ListingActionPreview, 'previewId' | 'expiresAt'> {
  familyId: string
  /** The rows the caller named (null = the whole family). */
  requested: string[] | null
}

export async function planListingAction(productId: string, actionInput: unknown, body: unknown): Promise<ListingActionPlan> {
  if (!isListingAction(actionInput)) throw new ListingActionError(CHOOSE_ACTION, 400, 'invalid_request')
  const action = actionInput
  const input = object(body)
  const { familyId, destination } = await destinationOf(productId, object(input.scope) as DestinationInput)
  const family = await readFamily(familyId, destination)
  let requested: string[] | null = null
  if (input.productIds !== undefined) {
    if (!Array.isArray(input.productIds) || input.productIds.some(id => typeof id !== 'string')) throw new ListingActionError('productIds must be a list of product ids.', 400, 'invalid_request')
    const members = new Set(family.products.map(p => p.id))
    if ((input.productIds as string[]).some(id => !members.has(id))) throw new ListingActionError('A chosen product is not in this family.', 400, 'invalid_request')
    requested = [...new Set(input.productIds as string[])]
  }
  // An eBay Inventory pause depends on the ACCOUNT's out-of-stock preference: read it now (bounded; unknown refuses).
  const extra: CapabilityFacts = family.model === 'ebay-inventory' && action === 'pause'
    ? { ebayOutOfStockPreference: await readEbayOutOfStockPreference(destination.accountId, destination.marketplace) } : {}
  const plan = planFor(action, family, destination, requested, extra)
  if (action === 'delete' && family.model === 'amazon') await warnAmazonDelete(plan, family, destination)
  const sendCount = plan.send.size
  return {
    familyId, requested, action, destination, model: family.model, reach: plan.reach,
    consequence: consequenceOf(action, family, destination, sendCount, [...plan.send.values()]), checkedAtSend: plan.checkedAtSend,
    confirm: confirmOf(action, family), rows: plan.rows, sendCount,
  }
}

/**
 * S1/S2 — an Amazon Delete of an FBA offer is sent (typed, as every Delete), with a warning on its row: Amazon's unit
 * count from Nexus's last FBA read (sellable · on the way · reserved · read time) and, for Pan-European FBA, that Amazon
 * may stop moving stock to this market. The delete itself reaches this market only. Never throws: a warning without a
 * count says so.
 */
async function warnAmazonDelete(plan: Plan, family: FamilyRead, destination: ListingActionDestination) {
  const fba = [...plan.send.values()].filter(isFba)
  if (!fba.length) return
  let market: Awaited<ReturnType<typeof amazonMarket>> = { marketplaceId: null, fbaProgram: null }
  try { market = await amazonMarket(destination.marketplace) } catch (err) {
    logger.warn('[listing-action] Amazon marketplace unreadable; the FBA delete warning names no count', { error: err instanceof Error ? err.message : String(err) })
  }
  const units = await readFbaUnits(market.marketplaceId, fba.map(row => ({ productId: row.productId, sku: row.sku })))
  const panEu = usesPanEu(destination.marketplace, market.fbaProgram)
  for (const row of plan.rows) {
    const listing = plan.send.get(row.productId)
    if (row.plan !== 'send' || !listing || !isFba(listing)) continue
    row.warning = [fbaDeleteWarning(units.get(row.productId) ?? null), panEu ? AMAZON_PAN_EU_DELETE_WARNING : null].filter(Boolean).join(' ')
  }
}

/** The plan, saved for 15 minutes as the caller's preview. `reason` (optional, ≤ 300 characters) travels to the audit. */
export async function previewListingAction(productId: string, actionInput: unknown, body: unknown, userId: string | null): Promise<ListingActionPreview> {
  const { familyId, requested, ...plan } = await planListingAction(productId, actionInput, body)
  const rawReason = object(body).reason
  const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim().slice(0, 300) : null
  const previewId = randomUUID()
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS)
  const preview: ListingActionPreview = { previewId, ...plan, expiresAt: expiresAt.toISOString() }
  await prisma.bulkOperation.create({ data: {
    id: previewId, userId, status: 'PREVIEW', productCount: plan.rows.length, changeCount: plan.sendCount, expiresAt,
    kind: LISTING_ACTION_KIND, productId: familyId, channel: plan.destination.channel, marketplace: plan.destination.marketplace,
    channelConnectionId: plan.destination.accountId, aliasKey: plan.destination.aliasKey,
    changes: { kind: LISTING_ACTION_KIND, action: plan.action, requested, preview, ...(reason ? { reason } : {}) } as never,
  } })
  return preview
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────

const RUN_STATUS_MESSAGE = (action: ListingAction, status: ListingActionRunStatus, done: number, total: number, where: string) => {
  const verb = ({ pause: 'paused', resume: 'resumed', end: 'ended', relist: 'relisted', delete: 'deleted' } as Record<ListingAction, string>)[action]
  const relist = action === 'delete' ? ` ${RELIST_HOW}` : ''
  if (status === 'NOT_SENT') return `Nothing was sent to ${where}.`
  if (status === 'DONE') return `${done} of ${total} ${verb} on ${where}.${relist}`
  if (status === 'PARTIAL') return `${done} of ${total} ${verb} on ${where}.${relist} Open the rows that did not change to see why.`
  return `Nothing was ${verb} on ${where}. Open the rows to see why.`
}

function finalStatus(rows: ListingActionRowResult[]): ListingActionRunStatus {
  const done = rows.filter(r => r.outcome === 'DONE').length
  const bad = rows.filter(r => r.outcome === 'FAILED' || r.outcome === 'UNKNOWN').length
  if (done && bad) return 'PARTIAL'
  if (done) return 'DONE'
  if (bad) return 'FAILED'
  return 'NOT_SENT'
}

const snapshotOutcome = (outcome: AdapterRowResult['outcome']) => outcome === 'DONE' ? 'ACCEPTED' : outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN'

/**
 * Run a confirmed preview (the seam a batch worker calls). Claims it, re-reads the family, sends only rows that are
 * still 'send' now AND were in the preview, records each row and finishes the BulkOperation.
 */
export async function executeListingAction(previewId: string, opts: { actorUserId: string | null }): Promise<ListingActionRunResult> {
  const row = await prisma.bulkOperation.findFirst({ where: { id: previewId, kind: LISTING_ACTION_KIND } })
  if (!row) throw new ListingActionError('This change no longer exists. Open it again.', 404, 'not_found')
  const changes = object(row.changes)
  const action = changes.action
  const preview = object(changes.preview) as unknown as ListingActionPreview
  if (!isListingAction(action) || !preview.destination) throw new ListingActionError('This change is unreadable. Open it again.', 409)
  const claimed = await prisma.bulkOperation.updateMany({ where: { id: previewId, status: 'PREVIEW' }, data: { status: 'RUNNING' } })
  if (!claimed.count) throw new ListingActionError('This change was already sent. Open it again to see its result.', 409)

  const destination = preview.destination
  const family = await readFamily(String(row.productId), destination)
  const plan = planFor(action, family, destination, (changes.requested as string[] | null) ?? null)
  const reviewed = new Set(preview.rows.filter(r => r.plan === 'send').map(r => r.productId))
  const targets: ActionListing[] = []
  const results: ListingActionRowResult[] = []
  for (const planned of plan.rows) {
    const listing = plan.send.get(planned.productId)
    if (listing && reviewed.has(planned.productId)) targets.push(listing)
    else if (reviewed.has(planned.productId)) results.push({ productId: planned.productId, listingId: planned.listingId, sku: planned.sku, outcome: 'SKIPPED', message: `Changed since the preview: ${planned.sentence}` })
  }
  const actor = opts.actorUserId ?? 'system'
  const reason = typeof changes.reason === 'string' ? changes.reason : null
  const ctx: ActionContext = {
    previewId, actor, destination, familyId: family.familyId, familySku: family.familySku,
    family: [...family.listings.values()],
  }
  let adapterRows: AdapterRowResult[] = []
  if (targets.length) {
    const adapter = family.model === 'unsupported' ? null : ADAPTERS[family.model] ?? null
    try {
      adapterRows = adapter ? await adapter.run(action, targets, ctx)
        : targets.map(t => ({ listingId: t.id, productId: t.productId, sku: t.sku, outcome: 'NOT_SENT' as const, message: listingActionGate(destination.channel) ?? 'Not available here.' }))
    } catch (err) {
      logger.error('[listing-action] adapter failed', { previewId, action, error: err instanceof Error ? err.message : String(err) })
      adapterRows = targets.map(t => ({ listingId: t.id, productId: t.productId, sku: t.sku, outcome: 'UNKNOWN' as const,
        message: `The change stopped unexpectedly (${err instanceof Error ? err.message : String(err)}). Check the listing on the channel.` }))
    }
  }
  results.push(...adapterRows.map(({ evidence: _evidence, ...rest }) => rest))

  // One audit record per row the channel was asked to change.
  const label = `${LISTING_ACTION_LABEL[action]} · ${destinationLabel(destination)}`
  for (const result of adapterRows) {
    if (result.outcome === 'SKIPPED' || result.outcome === 'NOT_SENT') continue
    try {
      await prisma.channelListingSnapshot.create({ data: {
        channelListingId: result.listingId, channel: destination.channel, marketplace: destination.marketplace, aliasKey: destination.aliasKey,
        reason: action, publishEventId: previewId, outcome: snapshotOutcome(result.outcome), acceptedAt: result.outcome === 'DONE' ? new Date() : null,
        label, capturedBy: actor,
        payload: { kind: LISTING_ACTION_KIND, action, sku: result.sku, outcome: result.outcome, message: result.message, destination, evidence: result.evidence ?? null, ...(reason ? { reason } : {}) } as never,
      } })
    } catch (err) {
      logger.warn('[listing-action] audit record failed', { previewId, listingId: result.listingId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const status = finalStatus(results)
  const done = results.filter(r => r.outcome === 'DONE').length
  const message = RUN_STATUS_MESSAGE(action, status, done, results.length, destinationLabel(destination))
  const runResult: ListingActionRunResult = { previewId, action, status, message, rows: results }
  await prisma.bulkOperation.update({ where: { id: previewId }, data: {
    status, completedAt: new Date(), submittedAt: new Date(),
    summary: { message, done, failed: results.filter(r => r.outcome === 'FAILED').length, unknown: results.filter(r => r.outcome === 'UNKNOWN').length,
      skipped: results.filter(r => r.outcome === 'SKIPPED').length, notSent: results.filter(r => r.outcome === 'NOT_SENT').length } as never,
    changes: { ...changes, result: runResult } as never,
  } })
  await auditLogService.write({ userId: opts.actorUserId, entityType: 'BulkOperation', entityId: previewId, action: `listing.${action}`,
    metadata: { destination, status, done, rows: results.length, ...(reason ? { reason } : {}) } })
  for (const result of adapterRows) if (result.outcome === 'DONE') publishListingEvent({ type: 'listing.updated', listingId: result.listingId, reason: `listing-action:${action}`, ts: Date.now() })
  return runResult
}

/** The route's door: the preview must be the caller's, unexpired and for this action and family; End and Delete need their typed confirm; the channel must be live. */
export async function runListingAction(productId: string, actionInput: unknown, body: unknown, userId: string | null): Promise<ListingActionRunResult> {
  if (!isListingAction(actionInput)) throw new ListingActionError(CHOOSE_ACTION, 400, 'invalid_request')
  const action = actionInput
  const input = object(body)
  const previewId = typeof input.previewId === 'string' ? input.previewId : ''
  if (!previewId) throw new ListingActionError('Open the change first (previewId is missing).', 400, 'invalid_request')
  if (action === 'end' && input.confirm !== 'END') throw new ListingActionError('Ending a listing needs your confirmation: type the item number, then confirm.', 400, 'confirm_required')
  if (action === 'delete' && input.confirm !== 'DELETE') throw new ListingActionError('Deleting a listing needs your confirmation: type the SKU, then confirm. It cannot be undone.', 400, 'confirm_required')
  const row = await prisma.bulkOperation.findFirst({ where: { id: previewId, kind: LISTING_ACTION_KIND },
    select: { id: true, userId: true, status: true, expiresAt: true, productId: true, channel: true, changes: true } })
  if (!row || (row.userId ?? null) !== userId) throw new ListingActionError('This change no longer exists. Open it again.', 404, 'not_found')
  if (object(row.changes).action !== action) throw new ListingActionError('This preview is for a different change. Open it again.', 400, 'invalid_request')
  const owner = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!owner || (owner.parentId ?? owner.id) !== row.productId) throw new ListingActionError('This change no longer exists. Open it again.', 404, 'not_found')
  if (row.status !== 'PREVIEW') throw new ListingActionError('This change was already sent. Open it again to see its result.', 409)
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) throw new ListingActionError('This preview expired. Open the change again.', 409, 'preview_expired')
  const gate = listingActionGate(String(row.channel))
  if (gate) throw new ListingActionError(gate, 409, 'publish_gated')
  return executeListingAction(previewId, { actorUserId: userId })
}

export { WorkspaceScopeError }
