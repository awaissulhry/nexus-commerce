/**
 * Sheet publish parity — the selling side of a listing (build shape v2, Owner 2026-10-04).
 *
 * The product sheet has, in every channel scope, a **Status** column — THE one control for "is it on this market"
 * (Owner 2026-10-04, simplify): Active / Inactive / Ended (Ended only where the channel really ends a listing: eBay End,
 * Shopify Archived); a row not on the channel — never sent, or deleted by Nexus — chooses Active / Inactive / Not listed:
 * what Publish creates it as, or that it leaves it out (`newListingOptions`). The **Action** column says what Publish
 * sends: Partial update / Full update / Delete (a row not on the channel always reads Full update — `publish-actions.ts`).
 * Changing the
 * Status (or the selection bar's Action button) only marks the row; **Publish** sends it, through the listing-action
 * engine (apps/api/src/services/listings/listing-action.service.ts), after the review. Stock › Sync control's
 * Close/Reopen offer, the sheet's old "Mark paused / active" and Claude's close-listing / reopen-listing all run the
 * same engine. The master `Product.status` is the Nexus-only "Catalog status" (Products list), not a channel state.
 *
 * Words: the state is **Inactive** (the key stays `paused`); the actions are **Pause offer** / **Resume offer** /
 * **End listing** / **Relist** / **Delete listing**. Inactive = buyers cannot buy here; the listing, its number, its
 * reviews and its content stay. Resume sends the CURRENT stock (never a remembered number: that could oversell).
 *
 * Per channel (what each action sends):
 *  - Amazon: Pause = remove THIS market's offer (SCT.6 `closeMarketOffers`; never quantity 0 — Amazon EU keeps one
 *    quantity per SKU for every EU market). Resume = put the saved offer back. FBA offers may be paused too (the FBA
 *    quantity is never touched), with a warning: the units stay in Amazon's warehouse, and a Pan-European FBA product
 *    needs an active offer in every required market. No End or Relist on Amazon, and Amazon never reads Ended (a listing
 *    removed from Amazon reads Not listed). Delete = remove the listing in that
 *    market only; an FBA offer too (Owner D2 A, 2026-10-04), typed, with a warning naming Amazon's unit count (the units
 *    cannot sell here until the SKU is listed here again) and, for Pan-European FBA, that Amazon may stop moving stock.
 *  - eBay, Trading listing: Pause = quantity 0 held by Nexus, only when the ITEM's out-of-stock control is on (read when
 *    sending); otherwise eBay would END the listing, so Pause is refused and End offered (D6 A). End =
 *    EndFixedPriceItem (the item number is kept). Relist = RelistFixedPriceItem (a NEW item number). Delete = end, then
 *    Nexus forgets the item number; listed again (Status → Active, Publish) it gets a new one.
 *  - eBay, Inventory listing: Pause needs the ACCOUNT's out-of-stock preference on. End = withdraw. Relist = publish.
 *    Delete = withdraw, then delete this market's offers (the inventory items stay: other markets share them).
 *  - Shopify: Pause = quantity 0 held by Nexus, per variant (the product page stays and shows "sold out"); a variant
 *    that sells at 0 ("Continue selling when out of stock") is not paused, and the review says why. End = ARCHIVED,
 *    Relist = ACTIVE (whole product, every market of the store). Delete = delete the Shopify product (D8 A). A family
 *    split into several Shopify products (one per colour) is refused: the Shopify colour lane owns their status.
 *  - Etsy: Pause = Etsy's own "inactive", Resume = "active" (never quantity 0: a sold-out Etsy listing costs a renewal
 *    fee to sell again). No End or Relist; Delete is not available yet.
 *  - WooCommerce: not available yet.
 *
 * New listings (Owner 2026-10-04): Amazon Inactive creates the listing WITHOUT this market's offer (never quantity 0,
 * never an FBA quantity) and the row is then marked exactly as a paused Amazon row; eBay Inactive creates it at
 * quantity 0 (only with the account's out-of-stock option on) and holds stock sync as an eBay pause does; Shopify
 * Inactive creates a Draft product, Active an active one. Resume (Active + Publish) sells it through the engine.
 *
 * Delete and relist (Owner 2026-10-04, simplified the same day): a listing Nexus deleted is a row NOT on the channel,
 * exactly like a new row — its Status reads **Not listed** ("Deleted on Amazon · IT on 4 Oct."), its default is Not
 * listed (every Publish skips it), and its Status offers the new-row choices: Active or Inactive lists it again (whole)
 * on the next Publish, through the new-listing create path. Nexus derives "deleted" from the delete's own audit record
 * (`ListingDeletion`); nothing extra is stored. (An older relist choice — Partial or Full update set in the Action column
 * after the delete — is read as Status Active: `ListingDeletion.relistChosenAt`.)
 */

export type ListingAction = 'pause' | 'resume' | 'end' | 'relist' | 'delete'
/** The four the Status column drives (Delete is the Action column's). */
export const STATUS_ACTIONS: readonly ListingAction[] = ['pause', 'resume', 'end', 'relist']
export const LISTING_ACTIONS: readonly ListingAction[] = [...STATUS_ACTIONS, 'delete']

/** How a listing is held on its channel; decides which calls an action makes. */
export type ListingModel = 'amazon' | 'ebay-trading' | 'ebay-inventory' | 'shopify' | 'etsy' | 'unsupported'

/**
 * What a row's Status shows.
 * - `paused`: shown as **Inactive** (the key is kept so stored data and older code read the same).
 * - `draft`: a listing Nexus holds but never sent — Publish creates it. It reads **Not listed** (one set of words,
 *   Owner 2026-10-04: Active · Inactive · Not listed · Ended, Mixed); its Status chooses what Publish creates.
 * - `not_listed`: no listing in this market at all.
 * - `mixed`: a main product whose variations are not all in the same state ("Mixed").
 * - `unknown`: Nexus cannot say honestly (for example an old Nexus-only "inactive" mark the channel never received).
 */
export type SellingState = 'active' | 'paused' | 'ended' | 'draft' | 'not_listed' | 'mixed' | 'unknown'

/** The permission each action needs (permissions-manifest.ts decides by the URL; this is the same rule for the web). */
export const LISTING_ACTION_PERMISSION: Readonly<Record<ListingAction, 'products.publish' | 'products.delete'>> = {
  pause: 'products.publish', resume: 'products.publish', relist: 'products.publish',
  // Ending or deleting a live listing is the house rule for a delete (amendment A-10, like /api/ebay/flat-file/delete).
  end: 'products.delete', delete: 'products.delete',
}

export const SELLING_STATE_LABEL: Readonly<Record<SellingState, string>> = {
  active: 'Active', paused: 'Inactive', ended: 'Ended', draft: 'Not listed', not_listed: 'Not listed', mixed: 'Mixed', unknown: 'Unknown',
}

export const LISTING_ACTION_LABEL: Readonly<Record<ListingAction, string>> = {
  pause: 'Pause offer', resume: 'Resume offer', end: 'End listing', relist: 'Relist', delete: 'Delete listing',
}

/** The state a successful action leaves a row in (a deleted row reads Not listed until its Status lists it again). */
export const ACTION_TARGET_STATE: Readonly<Record<ListingAction, SellingState>> = {
  pause: 'paused', resume: 'active', end: 'ended', relist: 'active', delete: 'not_listed',
}

/** Which part of the listing one action reaches: one row, the whole channel listing (all its variations), or the whole channel product. */
export type ActionReach = 'row' | 'listing' | 'product'

export interface ActionCapability {
  offered: boolean
  reach: ActionReach
  /** Why it is not offered (plain English), or null. */
  reason: string | null
  /** A check made only when sending (plain English), shown in the review. */
  checkedAtSend: string | null
  /** Offered, but the person should know this first (plain English), shown in the review. */
  warning: string | null
}

const no = (reason: string, reach: ActionReach = 'row'): ActionCapability => ({ offered: false, reach, reason, checkedAtSend: null, warning: null })
const yes = (reach: ActionReach, checkedAtSend: string | null = null, warning: string | null = null): ActionCapability => ({ offered: true, reach, reason: null, checkedAtSend, warning })

export const AMAZON_NO_END = 'Amazon has no End. Set Inactive to pause this market, or Delete to remove the listing here.'
/** An Amazon listing Nexus marks ended (removed from Amazon outside the product sheet's Delete): it reads Not listed. */
export const AMAZON_REMOVED_ELSEWHERE = 'Removed from Amazon in this market outside the product sheet. Nexus still holds its ASIN, so it cannot list it again from here yet.'
export const NOT_AVAILABLE = (channel: string) => `Changing the status of ${channel} listings from Nexus is not available yet.`
export const AMAZON_FBA_PAUSE_WARNING = 'Amazon runs this offer (FBA). Pausing removes the offer in this market only; your units stay in Amazon\'s warehouse and still pay storage. If this product uses Pan-European FBA, Amazon needs an active offer in every required market, so it may stop moving stock here.'
export const AMAZON_FBA_DELETE_WARNING = 'Amazon runs this offer (FBA). Deleting it here leaves your units in Amazon\'s warehouse: they cannot sell until you list this SKU here again, and Amazon still charges storage.'
export const AMAZON_PAN_EU_DELETE_WARNING = 'This SKU uses Pan-European FBA. Amazon may stop moving stock to this market until you list it here again.'
export const EBAY_TRADING_PAUSE_CHECK = 'Nexus reads this eBay listing first. If its out-of-stock control is off, quantity 0 would end the listing, so nothing is sent; set Ended instead.'
export const EBAY_INVENTORY_PREFERENCE_OFF = 'This eBay account\'s out-of-stock control is off, so quantity 0 would end the listing. Turn the control on in eBay, or set Ended.'
export const EBAY_INVENTORY_PREFERENCE_UNKNOWN = 'Nexus could not confirm that this eBay account\'s out-of-stock control is on, so quantity 0 could end the listing. Nothing will be sent.'
export const SHOPIFY_LINKED_REFUSED = 'This family is several Shopify products (one per colour). Change their status in Shopify for now.'
export const SHOPIFY_PAUSE_CHECK = 'Nexus checks each variant first. A variant that sells when out of stock ("Continue selling when out of stock" in Shopify) is not paused, because quantity 0 would not stop its sales.'
export const ETSY_NO_END = 'Etsy has no End here. Set Inactive to pause the listing.'
export const ETSY_DELETE_NOT_YET = 'Deleting Etsy listings from Nexus is not available yet. Set Inactive, or delete it in Etsy.'
/** D13 (decision 12): while sending to Etsy is not live on the server (off, or dry-run), an Etsy Status change is held with this reason. */
export const ETSY_PUBLISHING_OFF = 'Sending to Etsy is not live on this server, so Publish cannot change this. Change it in Etsy.'

export interface CapabilityFacts {
  /** Amazon: this row's offer is fulfilled by Amazon. */
  isFba?: boolean
  /** Shopify: the family is split into several Shopify products (colour products or linked products). */
  shopifyLinked?: boolean
  /** eBay (Inventory pause; every eBay new listing's Inactive): the account's out-of-stock preference, when known. */
  ebayOutOfStockPreference?: 'ON' | 'OFF' | 'UNKNOWN'
  /**
   * Nexus deleted this listing from the channel and it is not listed again yet: no selling change (pause, resume, end,
   * relist, delete) applies to it; its Status chooses as a new row's does (Active or Inactive lists it again).
   */
  deleted?: ListingDeletion | null
  /** New listings: the row is the main product of a family (its variations follow its choice unless they have their own). */
  isMain?: boolean
  /** The row is a variation of a family (new listings; Etsy: its Pause and Resume reach only this row). */
  isVariation?: boolean
  /** New listings: no listing record here yet (a Status choice first starts the drafts). */
  noRecord?: boolean
  /** New listings: the destination is a listing alias (not the primary listing). */
  alias?: boolean
  /**
   * The row's own listing is on the channel (it has a channel number) although its state reads Draft or Not listed — a
   * family's main product whose variations are not on the channel yet. It is then no new listing itself.
   */
  onChannel?: boolean
  /**
   * New listings, one listing per family (Etsy): the family's listing is on the channel already (a row of it has a
   * channel number), so a new row is a new variation of that listing, not a new listing.
   */
  listingOnChannel?: boolean
}

/** The ONE table: can this action run on this listing model, and how far does it reach? */
export function listingActionCapability(model: ListingModel, action: ListingAction, facts: CapabilityFacts = {}, channelLabel = 'this channel'): ActionCapability {
  if (facts.deleted) return no(deletedStatusReason(facts.deleted))
  switch (model) {
    case 'amazon':
      if (action === 'end' || action === 'relist') return no(AMAZON_NO_END)
      if (action === 'delete') return yes('row', null, facts.isFba ? AMAZON_FBA_DELETE_WARNING : null)
      return yes('row', null, facts.isFba && action === 'pause' ? AMAZON_FBA_PAUSE_WARNING : null)
    case 'ebay-trading':
      if (action === 'pause') return yes('row', EBAY_TRADING_PAUSE_CHECK)
      if (action === 'resume') return yes('row')
      return yes('listing')
    case 'ebay-inventory':
      if (action === 'pause') {
        if (facts.ebayOutOfStockPreference === 'OFF') return no(EBAY_INVENTORY_PREFERENCE_OFF)
        if (facts.ebayOutOfStockPreference === 'UNKNOWN') return no(EBAY_INVENTORY_PREFERENCE_UNKNOWN)
        return yes('row', facts.ebayOutOfStockPreference === 'ON' ? null : 'Nexus confirms the account\'s out-of-stock control is on before sending.')
      }
      if (action === 'resume') return yes('row')
      return yes('listing')
    case 'shopify':
      if (facts.shopifyLinked) return no(SHOPIFY_LINKED_REFUSED, 'product')
      if (action === 'pause') return yes('row', SHOPIFY_PAUSE_CHECK)
      if (action === 'resume') return yes('row')
      return yes('product')
    case 'etsy':
      if (action === 'end' || action === 'relist') return no(ETSY_NO_END)
      if (action === 'delete') return no(ETSY_DELETE_NOT_YET)
      // A variation's Inactive hides only its offering on Etsy (D6); the main row's acts on the whole listing.
      if ((action === 'pause' || action === 'resume') && facts.isVariation) return yes('row')
      return yes('listing')
    default:
      return no(NOT_AVAILABLE(channelLabel))
  }
}

/** The listing facts a selling state is read from. */
export interface SellingFacts {
  channel: string
  listingStatus: string | null
  isPublished: boolean | null
  externalListingId: string | null
  offerClosedAt: Date | string | null
  offerCloseReason?: string | null
  offerActive?: boolean | null
  /** Shopify: `platformAttributes.status` (ACTIVE / DRAFT / ARCHIVED / UNLISTED). */
  shopifyStatus?: string | null
  /** The last delete Nexus made of this listing that the channel accepted (`ListingDeletion`), or null. */
  deletion?: ListingDeletion | null
}

/** The hold reason a Pause offer writes on eBay, Shopify and Etsy rows (Amazon's close keeps SCT.6's own reason). */
export const SHEET_PAUSE_REASON = 'sheet-pause'
/** The hold reason of ONE hidden variation of an Etsy listing (its offering is off on Etsy; the rest of the listing sells). */
export const ETSY_VARIATION_HIDDEN_REASON = 'etsy-variation-hidden'

export interface SellingStateRead {
  state: SellingState
  reason: string | null
  /** Set when the row reads Not listed because Nexus deleted it from the channel (its Status lists it again). */
  deleted?: ListingDeletion | null
}

/** What the Status column shows for one listing row. Only facts Nexus holds; no channel call. */
export function sellingStateOf(facts: SellingFacts): SellingStateRead {
  const status = String(facts.listingStatus ?? '').trim().toUpperCase()
  const neverSent = !facts.externalListingId && (status === 'DRAFT' || facts.isPublished === false)
  // Deleted by Nexus and not listed again (still the draft shape the delete left): Not listed, like a new row.
  if (neverSent && facts.deletion) return { state: 'not_listed', reason: deletedStatusReason(facts.deletion), deleted: facts.deletion }
  if (neverSent) return { state: 'draft', reason: 'In Nexus only. Publish creates it on the channel.' }
  if (facts.channel === 'SHOPIFY') {
    const shopify = String(facts.shopifyStatus ?? '').trim().toUpperCase()
    if (shopify === 'ARCHIVED' || status === 'ENDED') return { state: 'ended', reason: 'Archived in Shopify.' }
    if (facts.offerClosedAt) return { state: 'paused', reason: 'Inactive: quantity 0 in Shopify, and Nexus holds every stock push. The product page stays and shows "sold out".' }
    if (shopify === 'DRAFT') return { state: 'paused', reason: 'Draft in Shopify: buyers cannot see it in any market of the store.' }
    if (shopify === 'UNLISTED') return { state: 'paused', reason: 'Unlisted in Shopify: buyers can open its link but cannot find it.' }
    if (shopify === 'ACTIVE' || (!shopify && status === 'ACTIVE')) return { state: 'active', reason: null }
    return { state: 'unknown', reason: 'Nexus has not read this product\'s Shopify status yet.' }
  }
  // Ended only where the channel really ends a listing (eBay; Shopify above). Amazon has no End: a listing marked ended
  // there was removed from Amazon (a flat-file delete, a file import) — it reads Not listed. An expired Etsy listing too.
  if (status === 'ENDED' && facts.channel === 'AMAZON') return { state: 'not_listed', reason: AMAZON_REMOVED_ELSEWHERE }
  if (status === 'ENDED' && facts.channel === 'ETSY') return { state: 'not_listed', reason: 'Expired or removed on Etsy.' }
  if (status === 'ENDED') return { state: 'ended', reason: 'Ended on the channel.' }
  if (facts.channel === 'ETSY' && status === 'INACTIVE') return { state: 'paused', reason: 'Inactive on Etsy: buyers cannot find or buy it.' }
  if (facts.channel === 'ETSY' && facts.offerClosedAt) {
    return { state: 'paused', reason: facts.offerCloseReason === ETSY_VARIATION_HIDDEN_REASON
      ? 'Hidden on Etsy: buyers cannot buy this variation; the rest of the listing sells.'
      : 'Inactive on Etsy: buyers cannot find or buy it.' }
  }
  if (facts.offerClosedAt) {
    return { state: 'paused', reason: facts.channel === 'AMAZON'
      ? 'Inactive: this market\'s Amazon offer is removed. Other markets keep selling.'
      : 'Inactive: the channel has quantity 0, and Nexus holds every stock push.' }
  }
  // Amazon's own words come back from its listing reads (BUYABLE / DISCOVERABLE); the Matrix reads them the same way
  // (`listingStateOf`, apps/api/src/services/pim/matrix-cells.ts).
  if (status === 'ACTIVE' || status === 'BUYABLE' || status === 'DISCOVERABLE' || (status === 'DRAFT' && facts.externalListingId)) {
    if (facts.offerActive === false) return { state: 'active', reason: 'Marked inactive in Nexus only — the channel still sells. Set Inactive and Publish to stop it.' }
    if (status === 'DISCOVERABLE') return { state: 'active', reason: 'Amazon lists it but reports it not buyable now (for example no stock or a problem Amazon found). Setting Inactive still removes this market\'s offer.' }
    if (status === 'DRAFT') return { state: 'active', reason: 'Nexus still marks it a draft, but it has a channel number, so it is on the channel.' }
    return { state: 'active', reason: null }
  }
  if (status === 'INACTIVE') return { state: 'unknown', reason: 'Nexus once marked this listing inactive, but the channel was never told. Check it on the channel.' }
  if (status === 'ERROR') return { state: 'unknown', reason: 'The last change to this listing failed. Check it on the channel.' }
  return { state: 'unknown', reason: 'Nexus has no confirmed state for this listing.' }
}

/** A main product's state from its variations' states (the variations are what sells). Their states differ: Mixed. */
export function familySellingState(children: readonly SellingState[]): SellingStateRead {
  const listed = children.filter(state => state !== 'not_listed' && state !== 'draft')
  if (!listed.length) return children.includes('draft') ? { state: 'draft', reason: 'No variation is on the channel yet. Publish creates them.' } : { state: 'not_listed', reason: 'No variation is on the channel yet.' }
  const states = new Set(listed)
  if (states.size === 1) return { state: listed[0], reason: null }
  const paused = listed.filter(state => state === 'paused').length
  if (paused && [...states].every(state => state === 'paused' || state === 'active'))
    return { state: 'mixed', reason: `${paused} of ${listed.length} variations are inactive.` }
  return { state: 'mixed', reason: 'Its variations are in different states. Open a variation to see each one.' }
}

/** Which status changes a row in this state may offer (before the capability table narrows them). */
export const ACTIONS_FROM_STATE: Readonly<Record<SellingState, readonly ListingAction[]>> = {
  active: ['pause', 'end'],
  paused: ['resume', 'end'],
  mixed: ['pause', 'resume', 'end'],
  ended: ['relist'],
  draft: [],
  not_listed: [],
  // Stopping or ending is safe when Nexus is unsure; resuming is not, so it waits for a known state.
  unknown: ['pause', 'end'],
}

/** The status changes one row offers: allowed from its state AND offered by its channel (none on a deleted row). (Delete: `deleteOffered`.) */
export function actionsFor(state: SellingState, model: ListingModel, facts: CapabilityFacts = {}, channelLabel?: string): ListingAction[] {
  return ACTIONS_FROM_STATE[state].filter(action => listingActionCapability(model, action, facts, channelLabel).offered)
}

/** Delete on a row Nexus already deleted. */
export const ALREADY_DELETED = (where: string) => `Already deleted on ${where}. To keep it off, leave its Status Not listed.`

/**
 * Delete on a row Nexus UNLINKED (Item ID control, 2026-10-05): Nexus forgot the channel's id, so it has nothing to address
 * a delete to. "Unlinked from eBay · IT: Nexus no longer holds its Item ID, so it cannot delete it. Link its Item ID again
 * on the main row first, or delete it in eBay."
 */
export const ALREADY_UNLINKED = (where: string) => {
  const words = unlinkWords(where)
  return `Unlinked from ${where}: Nexus no longer holds its ${words.id}, so it cannot delete it. Link its ${words.id} again${words.on} first, or delete it in ${words.channel}.`
}

/** Delete on a row Nexus removed: `ALREADY_DELETED`, or `ALREADY_UNLINKED` when the removal was an unlink. */
export const alreadyRemoved = (d: Pick<ListingDeletion, 'where' | 'unlinked'>) => d.unlinked ? ALREADY_UNLINKED(d.where) : ALREADY_DELETED(d.where)

/** Delete needs a listing on the channel (a draft or an absent listing has nothing to delete) and a channel that can. */
export function deleteOffered(state: SellingState, model: ListingModel, facts: CapabilityFacts = {}, channelLabel?: string): ActionCapability {
  if (facts.deleted) return no(alreadyRemoved(facts.deleted))
  if (state === 'draft' || state === 'not_listed') return no('Nothing to delete: this listing is not on the channel.')
  return listingActionCapability(model, 'delete', facts, channelLabel)
}

// ── The Status column (Owner 2026-10-04): a target value, sent by Publish ─────────────────────────

/**
 * What a person can choose in the Status column. A listing on the channel: Active, Inactive, Ended (`STATUS_TARGETS`;
 * Ended only where the channel can end: never on Amazon or Etsy). A row not on the channel (Draft, no listing here, or
 * deleted by Nexus): Active, Inactive, Not listed (`NEW_LISTING_TARGETS`) — what Publish creates it as, or that Publish
 * leaves it out.
 */
export type StatusTarget = 'active' | 'inactive' | 'ended' | 'not_listed'
/** The targets of a listing ON the channel. */
export const STATUS_TARGETS: readonly StatusTarget[] = ['active', 'inactive', 'ended']
/** Every target a Status cell can hold (the write routes take each). */
export const ALL_STATUS_TARGETS: readonly StatusTarget[] = ['active', 'inactive', 'ended', 'not_listed']
export const STATUS_TARGET_LABEL: Readonly<Record<StatusTarget, string>> = { active: 'Active', inactive: 'Inactive', ended: 'Ended', not_listed: 'Not listed' }

/** The action that moves a row from `from` to `to`, or null when it is already there (nothing to send). Not listed is never an action. */
export function statusChangeAction(from: SellingState, to: StatusTarget): ListingAction | null {
  if (to === 'not_listed') return null
  if (to === 'active') return from === 'paused' || from === 'mixed' ? 'resume' : from === 'ended' ? 'relist' : null
  if (to === 'inactive') return from === 'active' || from === 'mixed' || from === 'unknown' ? 'pause' : null
  return from === 'active' || from === 'paused' || from === 'mixed' || from === 'unknown' ? 'end' : null
}

/** The state a target stands for (to compare with what the channel reports). */
export const STATUS_TARGET_STATE: Readonly<Record<StatusTarget, SellingState>> = { active: 'active', inactive: 'paused', ended: 'ended', not_listed: 'not_listed' }

export interface StatusOption {
  target: StatusTarget
  offered: boolean
  action: ListingAction | null
  reason: string | null
  warning: string | null
  checkedAtSend: string | null
  /** New listings: what this choice makes Publish do ("Publish creates it and it sells."), for the option's tooltip. */
  sentence?: string | null
}

// ── New listings (Owner 2026-10-04): control before the first publish ──────────────────────────────

/** A row not on the channel yet: the Status Publish creates it with, or Not listed (Publish leaves it out). */
export type NewListingTarget = 'active' | 'inactive' | 'not_listed'
export const NEW_LISTING_TARGETS: readonly NewListingTarget[] = ['active', 'inactive', 'not_listed']
export const isNewListingTarget = (value: unknown): value is NewListingTarget => (NEW_LISTING_TARGETS as readonly unknown[]).includes(value)

/**
 * A row whose Status is a NEW listing's choice: not on the channel — Draft, no listing here, or deleted by Nexus (a
 * deleted row is a row not on the channel, exactly like a new one; its default is Not listed).
 */
export const isNewListingRow = (state: SellingState, facts: Pick<CapabilityFacts, 'deleted' | 'onChannel'> = {}) =>
  (state === 'draft' || state === 'not_listed') && (!!facts.deleted || !facts.onChannel)

/** What each choice makes Publish do (the option's tooltip). */
export const NEW_LISTING_SENTENCE: Readonly<Record<NewListingTarget, string>> = {
  active: 'Publish creates it and it sells.',
  inactive: 'Publish creates it, but buyers cannot buy it yet. Set Active and Publish when you are ready.',
  not_listed: 'Publish leaves it out. It stays in Nexus only.',
}
/** The same choices on a row Nexus deleted: Active or Inactive lists it again (whole); Not listed keeps it off. */
export const RELIST_SENTENCE: Readonly<Record<NewListingTarget, string>> = {
  active: 'Publish lists it again, whole, and it sells.',
  inactive: 'Publish lists it again, whole, but buyers cannot buy it yet. Set Active and Publish when you are ready.',
  not_listed: 'Publish leaves it out: it stays deleted on the channel.',
}
export const EBAY_NEW_INACTIVE_OOS_OFF = 'This eBay account\'s out-of-stock option is off, so eBay cannot hold a new listing at 0. Turn it on in eBay, or choose Active or Not listed.'
export const EBAY_NEW_INACTIVE_OOS_UNKNOWN = 'Nexus could not confirm that this eBay account\'s out-of-stock option is on, so eBay may not hold a new listing at 0. Try again, or choose Active or Not listed.'
export const EBAY_NEW_INACTIVE_CHECK = 'Nexus checks this eBay account\'s out-of-stock option when you choose Inactive and again when Publish sends: eBay holds a new listing at 0 only while it is on.'
export const ETSY_PUBLISH_NOT_YET = 'Publishing to Etsy from Nexus is not available yet.'
/** Etsy (E1, Owner D1 = A): a new Etsy listing starts as a draft; Active waits for photos, which Nexus does not send yet. */
export const ETSY_NEW_ACTIVE_NEEDS_PHOTO = 'Etsy needs at least 1 photo to go live; photos come in a later Nexus update.'
export const ETSY_NEW_DRAFT = 'Starts on Etsy as a draft when Publish sends it: buyers cannot buy a draft.'
/**
 * Etsy: a new variation of a listing already on Etsy joins it for sale (the listing has its photos), or joins it hidden
 * (Inactive: its offering is off on Etsy, and Nexus holds its pushes until its row is set Active).
 */
export const ETSY_NEW_VARIATION_ACTIVE = 'Joins the Etsy listing when Publish sends it; it sells while the listing is active.'
export const ETSY_NEW_VARIATION_INACTIVE = 'Joins the Etsy listing hidden when Publish sends it: buyers cannot buy this variation until you set it Active.'
/** The Status cell's sentence of an Etsy row whose listing is not on Etsy (E2: Publish reviews a create and sends nothing). E3 changes it here. */
export const ETSY_NEW_ROW_SENTENCE = 'Not on Etsy yet. Publish shows what Nexus would send; creating Etsy listings comes in the next Nexus update.'
export const NEW_LISTING_NOT_AVAILABLE = (channel: string) => `Publishing to ${channel} from Nexus is not available yet.`
export const SHOPIFY_NEW_VARIATION = 'Shopify creates the whole product. Choose its status on the main row.'
export const NEW_LISTING_ALIAS = 'An edit never creates an alias listing. Add this product to the listing alias first.'
/** The warning on a main row's Not listed: its variations cannot be created without it. */
export const NOT_LISTED_MAIN_WARNING = 'Publish leaves the whole family out here: its variations need their main product.'
/** Why Publish holds a family whose main row is Not listed (the review's sentence on every row it holds). */
export const NOT_LISTED_MAIN_HELD = 'The main product\'s Status is Not listed, so Publish leaves this family out here. Set the main product Active or Inactive to create it.'
/** A row that reads Not listed while Nexus still holds its channel number (removed outside the sheet). */
export const NOT_ON_CHANNEL_KEEPS_NUMBER = 'Not on the channel any more, but Nexus still holds its channel number, so it cannot list it again from here yet.'
/** Why Publish leaves out a row whose Status is Not listed. */
export const NOT_LISTED_LEFT_OUT = 'Status is Not listed: Publish leaves it out. It stays in Nexus only.'

const NEW_LISTING_CHANNEL: Partial<Record<ListingModel, string>> = { amazon: 'AMAZON', 'ebay-trading': 'EBAY', 'ebay-inventory': 'EBAY', shopify: 'SHOPIFY', etsy: 'ETSY' }

/**
 * ND2 A (Owner 2026-10-04) — what Publish does with a new row nobody chose for, as it does today: Amazon and eBay create
 * it selling; Shopify creates a Draft product (Inactive) unless the family's own Shopify status says ACTIVE; Etsy creates
 * an Etsy draft (Inactive, Owner D1 = A), and adds a new variation of a listing already on Etsy selling (Active, as eBay
 * and Amazon add one); any other channel cannot be published from Nexus (Not listed).
 */
export function newListingDefault(channel: string, options: { shopifyActive?: boolean; listingOnChannel?: boolean } = {}): NewListingTarget {
  const c = String(channel ?? '').toUpperCase()
  if (c === 'AMAZON' || c === 'EBAY') return 'active'
  if (c === 'SHOPIFY') return options.shopifyActive ? 'active' : 'inactive'
  if (c === 'ETSY') return options.listingOnChannel ? 'active' : 'inactive'
  return 'not_listed'
}

/**
 * Wave 2 D4 (Owner decisions 9, 10) — the ONE rule for the status a product Shopify does not hold yet is created with:
 * the Status column's choice of its main row on that Shopify store (`newListingChoice`). Active creates it ACTIVE,
 * Inactive creates it as a DRAFT, Not listed creates nothing (null). Publish, the sheet's "Shopify status" cell and the
 * Media tab's "Create reviewed product" read it; a stored Shopify status never decides a create.
 */
export type ShopifyCreateStatus = 'ACTIVE' | 'DRAFT'
export function shopifyCreateStatus(target: NewListingTarget | null | undefined): ShopifyCreateStatus | null {
  return target === 'active' ? 'ACTIVE' : target === 'inactive' ? 'DRAFT' : null
}
/**
 * Etsy (E1, Owner D1 = A) — the same rule for a listing Etsy does not hold yet: the main row's Status choice. Inactive
 * creates an Etsy draft, Active asks for a live listing (refused until Nexus sends photos), Not listed creates nothing (null).
 */
export type EtsyCreateState = 'draft' | 'active'
export function etsyCreateState(target: NewListingTarget | null | undefined): EtsyCreateState | null {
  return target === 'active' ? 'active' : target === 'inactive' ? 'draft' : null
}
/** The "Shopify status" cell of a row not on Shopify yet: read-only, it shows the Status column's create value. */
export const SHOPIFY_STATUS_FROM_STATUS_COLUMN = 'A product not on Shopify yet is created with the Status column\'s choice. Change it there.'
/** The Media tab's "Create reviewed product" when the Status column says Not listed: nothing is created. */
export const SHOPIFY_CREATE_NOT_LISTED = 'This product\'s Status is Not listed for this Shopify store, so Nexus does not create it. Set its Status to Active or Inactive first.'

export interface NewListingChoiceInput {
  channel: string
  /** This row's own stored choice (`sellingTarget` on a row not on the channel), or null. */
  own: NewListingTarget | null
  /** The main row's stored choice while the main row is not on the channel either; a variation without its own follows it. */
  main: NewListingTarget | null
  isVariation: boolean
  /**
   * Publish includes this row today without any choice: a main product, a draft row not left out of the listing
   * (variation exclusion), or a variation of an eBay family never started here. Otherwise it reads Not listed.
   */
  includedByDefault: boolean
  /** Shopify: the family's stored Shopify status is ACTIVE (`newListingDefault`). */
  shopifyActive?: boolean
  /** Etsy: the family's listing is on the channel already, so this row is a new variation of it (`newListingDefault`). */
  listingOnChannel?: boolean
  /** Nexus deleted this row from the channel: nobody's choice = Not listed (every Publish skips it until Status lists it again). */
  deleted?: boolean
}

export type NewListingSource = 'own' | 'main' | 'default'

/** PURE. What Publish does with one new row: its own choice, else the main row's, else today's default (ND2 A). */
export function newListingChoice(input: NewListingChoiceInput): { target: NewListingTarget; source: NewListingSource } {
  if (input.own) return { target: input.own, source: 'own' }
  if (input.isVariation && input.main) return { target: input.main, source: 'main' }
  if (!input.includedByDefault || input.deleted) return { target: 'not_listed', source: 'default' }
  return { target: newListingDefault(input.channel, { shopifyActive: input.shopifyActive, listingOnChannel: input.listingOnChannel }), source: 'default' }
}

/**
 * The cell's sentence for a new row's choice: what Publish does, and where the choice comes from when nobody set it here.
 * A row Nexus deleted that stays off says so in the delete's own words ("Deleted on Amazon · IT on 4 Oct. To list it
 * again, set Status to Active and Publish."). `channel` ETSY: a new variation of a listing on Etsy (`listingOnChannel`)
 * reads `ETSY_NEW_VARIATION_ACTIVE` or `ETSY_NEW_VARIATION_INACTIVE`; a row of a listing not on Etsy reads
 * `ETSY_NEW_ROW_SENTENCE` for Active and Inactive (E2 sends no create to Etsy).
 */
export function newListingSentence(choice: { target: NewListingTarget; source: NewListingSource },
  options: { includedByDefault?: boolean; deleted?: Pick<ListingDeletion, 'where' | 'at' | 'unlinked'> | null; now?: number; channel?: string; listingOnChannel?: boolean } = {}): string {
  // An unlinked row is never listed as new (Publish holds it): every choice says why, in the unlink's own words.
  if (options.deleted?.unlinked) return choice.target === 'not_listed' ? deletedStatusReason(options.deleted, options.now) : deletedPublishSkip(options.deleted, options.now)
  if (options.deleted && choice.target === 'not_listed' && choice.source !== 'main') return deletedStatusReason(options.deleted, options.now)
  const etsy = String(options.channel ?? '').toUpperCase() === 'ETSY' && choice.target !== 'not_listed'
  const etsyWhat = !options.listingOnChannel ? ETSY_NEW_ROW_SENTENCE
    : choice.target === 'inactive' ? ETSY_NEW_VARIATION_INACTIVE : ETSY_NEW_VARIATION_ACTIVE
  const what = etsy ? etsyWhat : (options.deleted ? RELIST_SENTENCE : NEW_LISTING_SENTENCE)[choice.target]
  if (choice.source === 'main') return `${what} (It follows the main product's choice; set this row to choose for it.)`
  if (choice.source === 'default' && choice.target === 'not_listed' && options.includedByDefault === false)
    return `${what} (A variation with no listing here is left out until you choose Active or Inactive for it.)`
  return what
}

/**
 * PURE. The Status choices of a row not on the channel: Active, Inactive, Not listed, each offered or refused by the
 * channel's rule. Amazon: all three (Inactive = created without this market's offer). eBay: Inactive only while the
 * account's out-of-stock option is on (refused when Nexus read it off or could not read it; when not read, offered and
 * checked when choosing and when sending). Shopify: all three on the main row (the product's status); a variation
 * follows the main row; a family split into colour products is the Shopify colour lane's. Etsy, a listing not on Etsy
 * yet: Inactive (an Etsy draft) and Not listed; Active waits for photos (E1, Owner D1 = A). Etsy, a new variation of a
 * listing on Etsy (`listingOnChannel`): Active (it joins the listing for sale), Inactive (it joins hidden, D6) and Not
 * listed. Other channels: none.
 * A row with no listing in an alias destination: none (an edit never creates an alias listing).
 */
export function newListingOptions(model: ListingModel, facts: CapabilityFacts = {}, channelLabel = 'this channel'): StatusOption[] {
  const words = facts.deleted ? RELIST_SENTENCE : NEW_LISTING_SENTENCE
  const option = (target: NewListingTarget, reason: string | null, extra: Partial<StatusOption> = {}): StatusOption =>
    ({ target, offered: !reason, action: null, reason, warning: null, checkedAtSend: null, sentence: words[target], ...extra })
  const all = (reason: string) => NEW_LISTING_TARGETS.map(target => option(target, reason))
  const channel = NEW_LISTING_CHANNEL[model]
  if (!channel) return all(NEW_LISTING_NOT_AVAILABLE(channelLabel))
  if (facts.noRecord && facts.alias) return all(NEW_LISTING_ALIAS)
  if (channel === 'SHOPIFY') {
    if (facts.shopifyLinked) return all(SHOPIFY_LINKED_REFUSED)
    if (facts.isVariation) return all(SHOPIFY_NEW_VARIATION)
  }
  // Unlinked (Item ID control, 2026-10-05): the listing may still be live on the channel, so it is never listed as new —
  // that would make a second one. Only Not listed is offered; Active and Inactive are held with the unlink's own words.
  if (facts.deleted?.unlinked) {
    const reason = deletedStatusReason(facts.deleted)
    return [option('active', reason), option('inactive', reason), option('not_listed', null, { sentence: UNLINKED_NOT_LISTED })]
  }
  const notListedWarning = facts.isMain ? NOT_LISTED_MAIN_WARNING : null
  if (channel === 'ETSY') return facts.listingOnChannel
    ? [option('active', null, { sentence: ETSY_NEW_VARIATION_ACTIVE }), option('inactive', null, { sentence: ETSY_NEW_VARIATION_INACTIVE }), option('not_listed', null, { warning: notListedWarning })]
    : [option('active', ETSY_NEW_ACTIVE_NEEDS_PHOTO), option('inactive', null, { sentence: ETSY_NEW_DRAFT }), option('not_listed', null, { warning: notListedWarning })]
  let inactive = option('inactive', null)
  if (channel === 'EBAY') {
    inactive = facts.ebayOutOfStockPreference === 'OFF' ? option('inactive', EBAY_NEW_INACTIVE_OOS_OFF)
      : facts.ebayOutOfStockPreference === 'UNKNOWN' ? option('inactive', EBAY_NEW_INACTIVE_OOS_UNKNOWN)
        : option('inactive', null, { checkedAtSend: facts.ebayOutOfStockPreference === 'ON' ? null : EBAY_NEW_INACTIVE_CHECK })
  }
  return [option('active', null), inactive, option('not_listed', null, { warning: notListedWarning })]
}

/** The Status targets a listing ON the channel offers: Ended only where the channel can end a listing (not Amazon, not Etsy). */
export const statusTargetsFor = (model: ListingModel): readonly StatusTarget[] =>
  model === 'amazon' || model === 'etsy' ? STATUS_TARGETS.filter(target => target !== 'ended') : STATUS_TARGETS

/**
 * The Status choices of one row: its current value (offered, no action) and every target it can reach, each refused
 * one with its reason. A row not on the channel (Draft, no listing here, or deleted by Nexus) offers the new-listing
 * choices instead (`newListingOptions`). Amazon and Etsy never offer Ended.
 */
export function statusOptionsFor(state: SellingState, model: ListingModel, facts: CapabilityFacts = {}, channelLabel?: string): StatusOption[] {
  if (isNewListingRow(state, facts)) return newListingOptions(model, facts, channelLabel)
  return statusTargetsFor(model).map(target => {
    // A main product on the channel whose variations are not: they are the new listings. (Any other row on the channel
    // that reads Not listed was removed outside the sheet: it says why.)
    if (state === 'draft' || state === 'not_listed') return { target, offered: false, action: null, reason: state === 'draft' || facts.isMain ? 'Its variations are not on the channel yet. Publish creates them.' : NOT_ON_CHANNEL_KEEPS_NUMBER, warning: null, checkedAtSend: null }
    if (STATUS_TARGET_STATE[target] === state) return { target, offered: true, action: null, reason: null, warning: null, checkedAtSend: null }
    const action = statusChangeAction(state, target)
    if (!action) return { target, offered: false, action: null, reason: target === 'active' ? 'Nexus cannot confirm this listing\'s state, so it does not resume it. Check it on the channel.' : 'Not possible from this state.', warning: null, checkedAtSend: null }
    const capability = listingActionCapability(model, action, facts, channelLabel)
    return { target, offered: capability.offered, action, reason: capability.reason, warning: capability.warning, checkedAtSend: capability.checkedAtSend }
  })
}

/**
 * PURE. The same Status choices with every CHANGE held with `reason` (a channel Publish cannot send to now, e.g. Etsy
 * while Etsy publishing is off): a choice that would send something is refused; the row's current value (no action) and
 * a choice already refused keep what they say.
 */
export function holdStatusChanges(options: StatusOption[], reason: string): StatusOption[] {
  return options.map(option => option.offered && option.action ? { ...option, offered: false, reason, warning: null, checkedAtSend: null } : option)
}

// ── The wire shapes (API ↔ web) ──────────────────────────────────────────────────────────────────

export interface ListingActionDestination {
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string
}

export interface ListingActionStateRow {
  productId: string
  listingId: string | null
  sku: string
  isParent: boolean
  state: SellingState
  reason: string | null
  /** The changes this row may offer now. */
  actions: ListingAction[]
  /** Why an action this channel has is not offered on this row (plain English). */
  refusals: Partial<Record<ListingAction, string>>
}

export interface ListingActionStateRead {
  destination: ListingActionDestination
  model: ListingModel
  rows: ListingActionStateRow[]
  readAt: string
}

export type ListingActionRowPlan = 'send' | 'skip' | 'refused'

export interface ListingActionPlanRow {
  productId: string
  listingId: string | null
  sku: string
  /**
   * S11 follow-up (per-channel SKU) — the SKU this action names on the channel for the row's listing when it is not the
   * product SKU (`sku`): the one the channel holds (its own SKU there). The Publish window names an End or a Delete by it.
   */
  heldSku?: string
  plan: ListingActionRowPlan
  /** What happens to this row, or why nothing does (plain English). */
  sentence: string
  /** Sent, but the person should know this first (an FBA delete's unit count, Pan-European FBA), or null. */
  warning?: string | null
}

export interface ListingActionConfirm {
  /** `checkbox`: tick to confirm; `type`: type `expected` (the SKU or item number) — End cannot be undone the same way. */
  kind: 'checkbox' | 'type'
  expected: string | null
  /** The body field the run needs (`confirm: 'END'` for End, `'DELETE'` for Delete). */
  token: 'END' | 'DELETE' | null
}

export interface ListingActionPreview {
  previewId: string
  action: ListingAction
  destination: ListingActionDestination
  model: ListingModel
  reach: ActionReach
  /** One sentence: what will happen, where, and how to undo it. */
  consequence: string
  /** A check the channel answers only when sending, or null. */
  checkedAtSend: string | null
  confirm: ListingActionConfirm
  rows: ListingActionPlanRow[]
  sendCount: number
  expiresAt: string
}

export type ListingActionRowOutcome = 'DONE' | 'SKIPPED' | 'FAILED' | 'NOT_SENT' | 'UNKNOWN'

export interface ListingActionRowResult {
  productId: string
  listingId: string | null
  sku: string
  outcome: ListingActionRowOutcome
  message: string
}

export type ListingActionRunStatus = 'DONE' | 'PARTIAL' | 'FAILED' | 'NOT_SENT'

export interface ListingActionRunResult {
  previewId: string
  action: ListingAction
  status: ListingActionRunStatus
  message: string
  rows: ListingActionRowResult[]
}

// ── Delete and relist (Owner 2026-10-04): the Deleted rest, read from the delete's own record ──────────

/**
 * The last delete Nexus made of one listing that the channel accepted (its `ChannelListingSnapshot`, reason 'delete'),
 * while the listing is not on the channel again. Derived, never stored.
 */
export interface ListingDeletion {
  /** When the channel accepted the delete (ISO). */
  at: string
  /** "Amazon · IT", "eBay · DE", "Shopify". */
  where: string
  /** The channel number the listing had (Amazon: its ASIN; eBay: the item number; Shopify: the product id), or null. */
  oldReference: string | null
  /**
   * The seller SKU the channel held for this listing when it was removed (the delete record's `sku`: the SKU the Delete
   * named), or null when the record does not say (an unlink records none). Absent on older readers.
   */
  sku?: string | null
  /**
   * Set when the removal was an UNLINK, not a delete (Item ID control, 2026-10-05: the sheet's Clear, Claude's
   * unlink-channel-id): nothing was removed on the channel — the listing may still be live there, and Nexus no longer
   * updates it. Such a row is never listed as new (a second item); its id is linked again instead.
   */
  unlinked?: true
  /**
   * OLDER STORED VALUE (the first delete-and-relist build, before the simplify): when the Action column chose Partial
   * update or Full update on this row AFTER the delete (ISO), or null. It is read as the row's Status choice Active
   * (`new-listing-choices.ts`); any Status choice made since replaces it.
   */
  relistChosenAt: string | null
}

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "4 Oct" (UTC; with the year when it is not this year). */
export function deletedOn(at: string, now: number = Date.now()): string {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return 'an earlier date'
  const year = date.getUTCFullYear() !== new Date(now).getUTCFullYear() ? ` ${date.getUTCFullYear()}` : ''
  return `${date.getUTCDate()} ${SHORT_MONTH[date.getUTCMonth()]}${year}`
}

/**
 * How an unlinked row is named per channel, from its `where` ("eBay · IT", "Amazon · IT", "Shopify", "Etsy · …"): the id
 * the sheet links it by, what the channel holds, where the id is linked again, and — where listing it as new really makes
 * a second one — what that would be. Amazon keys a listing by its seller SKU, so a create there is no second listing: it
 * names none.
 */
export function unlinkWords(where: string): { channel: string; id: string; thing: string; on: string; second: string | null } {
  const channel = String(where ?? '').split(' · ')[0].trim()
  if (channel === 'eBay') return { channel, id: 'Item ID', thing: 'item', on: ' on the main row', second: 'item' }
  if (channel === 'Amazon') return { channel, id: 'ASIN', thing: 'listing', on: ' on this row', second: null }
  if (channel === 'Shopify') return { channel, id: 'Product ID', thing: 'product', on: ' on the main row', second: 'product' }
  if (channel === 'Etsy') return { channel, id: 'Listing ID', thing: 'listing', on: ' on the main row', second: 'listing' }
  return { channel: channel || 'the channel', id: 'channel ID', thing: 'listing', on: '', second: null }
}

/** The small mark beside an unlinked row's Status: "unlinked 5 Oct". (A deleted row's: "deleted 4 Oct".) */
export const removedMark = (d: Pick<ListingDeletion, 'at' | 'unlinked'>, now?: number) => `${d.unlinked ? 'unlinked' : 'deleted'} ${deletedOn(d.at, now)}`

/**
 * A removed row's short reason: "Deleted on Amazon · IT on 4 Oct." — or, unlinked: "Unlinked from eBay · IT on 5 Oct: the
 * item may still be live there, and Nexus no longer updates it."
 */
export const deletedShort = (d: Pick<ListingDeletion, 'where' | 'at' | 'unlinked'>, now?: number) => d.unlinked
  ? `Unlinked from ${d.where} on ${deletedOn(d.at, now)}: the ${unlinkWords(d.where).thing} may still be live there, and Nexus no longer updates it.`
  : `Deleted on ${d.where} on ${deletedOn(d.at, now)}.`

/** "Link its Item ID again on the main row; listing it as new makes a second item." — what an unlinked row needs. */
const relinkHow = (where: string) => {
  const words = unlinkWords(where)
  return `Link its ${words.id} again${words.on}${words.second ? `; listing it as new makes a second ${words.second}` : ' to update it from Nexus'}.`
}

/**
 * The Status column's tooltip on a removed row: "Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and
 * Publish." — or, unlinked: "Unlinked from eBay · IT on 5 Oct: the item may still be live there, and Nexus no longer updates
 * it. Link its Item ID again on the main row; listing it as new makes a second item."
 */
export const deletedStatusReason = (d: Pick<ListingDeletion, 'where' | 'at' | 'unlinked'>, now?: number) => d.unlinked
  ? `${deletedShort(d, now)} ${relinkHow(d.where)}`
  : `${deletedShort(d, now)} To list it again, set Status to Active and Publish.`

/**
 * Why a Publish skips a removed row: "Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active." — or,
 * unlinked (skipped whatever its Status says): "Unlinked from eBay · IT on 5 Oct: the item may still be live there, and
 * Nexus no longer updates it. Publish leaves it out: link its Item ID again on the main row; listing it as new makes a
 * second item."
 */
export const deletedPublishSkip = (d: Pick<ListingDeletion, 'where' | 'at' | 'unlinked'>, now?: number) => d.unlinked
  ? `${deletedShort(d, now)} Publish leaves it out: ${relinkHow(d.where).replace(/^L/, 'l')}`
  : `${deletedShort(d, now)} To list it again, set Status to Active.`

/** "Set before the delete on 4 Oct. To list it again, set Status to Active." — a waiting value that belonged to the removed listing. */
export const setBeforeRemoval = (d: Pick<ListingDeletion, 'where' | 'at' | 'unlinked'>, now?: number) => d.unlinked
  ? `Set before the unlink on ${deletedOn(d.at, now)}. ${relinkHow(d.where)}`
  : `Set before the delete on ${deletedOn(d.at, now)}. To list it again, set Status to Active.`

/** The Status choice Not listed on an unlinked row: Publish leaves it out (it is never listed as new). */
export const UNLINKED_NOT_LISTED = 'Publish leaves it out. Nexus no longer updates it on the channel.'

/**
 * The Shared scope never lists a removed market again: "Deleted on Amazon · IT. To list it again, set its Status in the
 * Amazon · IT sheet." — or, unlinked: "Unlinked from eBay · IT: the item may still be live there, and Nexus no longer
 * updates it. Link its Item ID again in the eBay · IT sheet."
 */
export const sharedRemovedRefusal = (d: Pick<ListingDeletion, 'where' | 'unlinked'>) => d.unlinked
  ? `Unlinked from ${d.where}: the ${unlinkWords(d.where).thing} may still be live there, and Nexus no longer updates it. Link its ${unlinkWords(d.where).id} again in the ${d.where} sheet.`
  : `Deleted on ${d.where}. To list it again, set its Status in the ${d.where} sheet.`

/** A Delete's result sentence: "Deleted on Amazon · IT. To list it again, set Status to Active and Publish." */
export const deleteDoneSentence = (where: string) =>
  `Deleted on ${where}. To list it again, set Status to Active and Publish.`

/** "just now", "12 minutes ago", "2 hours ago", "3 days ago". */
export function agoText(at: string | Date, now: number = Date.now()): string {
  const ms = now - new Date(at).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Amazon's FBA units of one SKU in one marketplace, as Nexus last read them (`FbaInventoryDetail`). */
export interface FbaUnits { sellable: number; inbound: number; reserved: number; other: number; readAt: string | null }
export const fbaUnitTotal = (u: FbaUnits) => u.sellable + u.inbound + u.reserved + u.other

/**
 * The FBA Delete warning with Amazon's unit count: "Amazon holds 14 FBA units for this SKU here (12 sellable, 2 on the
 * way), read 2 hours ago. They cannot sell until you list this SKU here again, and Amazon still charges storage."
 * Null units (Nexus holds no count) fall back to `AMAZON_FBA_DELETE_WARNING`.
 */
export function fbaDeleteWarning(units: FbaUnits | null, now: number = Date.now()): string {
  if (!units) return AMAZON_FBA_DELETE_WARNING
  const total = fbaUnitTotal(units)
  const read = units.readAt ? `, read ${agoText(units.readAt, now)}` : ''
  if (!total) return `Nexus read 0 FBA units for this SKU here${read}. If Amazon still holds any, they cannot sell until you list this SKU here again, and Amazon still charges storage.`
  const parts = [units.sellable ? `${units.sellable} sellable` : null, units.inbound ? `${units.inbound} on the way` : null,
    units.reserved ? `${units.reserved} reserved` : null, units.other ? `${units.other} not sellable` : null].filter(Boolean)
  return `Amazon holds ${total} FBA unit${total === 1 ? '' : 's'} for this SKU here (${parts.join(', ')})${read}. They cannot sell until you list this SKU here again, and Amazon still charges storage.`
}
