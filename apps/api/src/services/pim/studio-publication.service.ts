import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { blockingIssues, isPhotoChangeId, type StudioPublishReview, type StudioPublishResult, type StudioPublishScope, type StudioPublishSelection,
  type StudioPublishStoredReview } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { getEtsyPublishMode } from '../etsy-publish-gate.service.js'
import { readPublicationFacts, publicationDigest, object, type PublicationFacts } from './studio-publication-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import { ensureDraftListings } from './draft-listing.service.js'
import { amazonMovesWithoutPublication, prepareAmazonPublication, sendAmazonPublication, type AmazonPublication } from './studio-publication-amazon.js'
import { withSendQuantities } from './studio-publication-amazon-offer.js'
import { prepareEbayPublication, sendEbayPublication, prepareEbayInventoryPublication, usesEbayInventory, type EbayPublication, type EbayInventoryPublication } from './studio-publication-ebay.js'
import { prepareEbayInventoryChanges } from './studio-publication-ebay-inventory-changes.js'
import { ebayInventoryReads, sendEbayInventoryGroup } from './studio-publication-ebay-inventory.js'
import { prepareEtsyPublication } from './studio-publication-etsy.js'
import { etsyRevisionView, prepareEtsyChanges } from './studio-publication-etsy-changes.js'
import { etsyPublicationResult, sendEtsyPublication } from './studio-publication-etsy-send.js'
import { etsyCreateResult, sendEtsyCreate } from './studio-publication-etsy-create.js'
import { claimEtsyCreate, markEtsyCreateUnknown, releaseEtsyCreate, storeEtsyCreatedListing } from './studio-publication-etsy-marker.js'
import type { EtsyCompiled, EtsyJournalRequest, EtsyPublication } from './studio-publication-etsy-types.js'
import { etsyShopLabel } from '../etsy/shop-label.js'
import { readPublicationOverwrite } from './studio-publication-overwrite.js'
import { recordPublicationRequests, settlePublicationRecords } from './studio-publication-records.js'
import { PUBLICATION_KIND as KIND, IN_FLIGHT, OPEN_PUBLICATION, json, publicationSummary, recordContext, storeResult, reconcileEbayReceipt,
  settleStudioPublication, announcePublication, nextPublicationCheck } from './studio-publication-settle.js'
import { readPublicationBaseline } from './studio-publication-baseline.js'
import { sharedListingWarnings } from '../assortment/shared-listing-warning.js'
import { prepareAmazonChanges } from './studio-publication-amazon-changes.js'
import { prepareEbayChanges } from './studio-publication-ebay-changes.js'
import { blockRowChanges, compileSelection, type EbayInventorySend, type PublicationChangePlan } from './studio-publication-selection.js'
import { explainAmazonRelist, type PublicationRelistRecord, FULL_EBAY_INVENTORY_LATER, FULL_EBAY_VARIATION, fbaNewAsinWarning, relistSentence,
  SHOPIFY_EXISTING_NOT_YET, AMAZON_MOVE_NEEDS_CONFIRM, AMAZON_MOVE_ROLE_CANNOT_DELETE, channelSkuLengthProblem, ebayRenameSentence, etsySkuMoveSentence, oldSkuStaysDeleted,
  FULL_ETSY_VARIATION } from '@nexus/shared/publish-actions'
import { deletedOn, deletedPublishSkip, etsyCreateState, ETSY_NEW_ACTIVE_NEEDS_PHOTO, NOT_LISTED_LEFT_OUT, NOT_LISTED_MAIN_HELD, shopifyCreateStatus,
  type ListingDeletion } from '@nexus/shared/listing-actions'
import type { StudioPublishSkuMove } from '@nexus/shared/studio-publication'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { liveChannelSku, wantedChannelSku } from '../listings/channel-sku.pure.js'
import { amazonMoveReview, claimMoveCoordinates } from './studio-publication-amazon-move.js'
import type { PublishCreateRow, StartAsTarget } from '@nexus/shared/publish-plan'
import { verifyNewEbayListing } from './studio-publication-ebay-verify.js'
import { readFbaUnits } from '../listings/listing-deletions.js'

const publishMode = (channel: string) => channel === 'AMAZON' ? getAmazonPublishMode() : channel === 'EBAY' ? getEbayPublishMode() : channel === 'SHOPIFY' ? getShopifyPublishMode()
  : channel === 'ETSY' ? getEtsyPublishMode() : 'unavailable'
type Prepared = AmazonPublication | EbayPublication | EbayInventoryPublication | EbayInventorySend | EtsyPublication | { kind: 'shopify'; revision: string; remoteRevision: string | null; initialized: boolean; draft: unknown; products: Array<{ productId: string; sku: string }> }

// Sheet publish parity (step 1) — the result counts; they live with the settle core now (step 2).
export { publicationSummary }

/** The destination of a publication as indexed columns (the same values `changes` keeps). `familyId` is the parent. */
export const publicationColumns = (familyId: string, scope: StudioPublishScope, aliasKey: string) => ({
  kind: KIND, productId: familyId, channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey,
})

/**
 * Publish without surprises (audit P1/P9) — what a refused prepare step tells the review. The eBay builder names EVERY
 * problem it found (`issues`) and the notes it made on the way (`notes`); "sending is off" (`gateOnly`) is already the
 * review's one gate message, so it adds nothing but its notes. Any other refusal is one message, as before.
 */
function refusalIssues(error: unknown): StudioPublishReview['issues'] {
  const found = error as { issues?: unknown; notes?: unknown; gateOnly?: unknown } | null
  const notes = Array.isArray(found?.notes) ? (found!.notes as string[]).map(message => ({ severity: 'warning' as const, message })) : []
  if (Array.isArray(found?.issues)) return [...(found!.issues as StudioPublishReview['issues']), ...notes]
  if (found?.gateOnly === true) return notes
  return [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }, ...notes]
}

/**
 * The one sentence a review shows when this server does not send to the channel (audit P9: it was said twice for eBay).
 * Etsy is read only when sending to it is live, so off live its review ran every check but the comparison with Etsy.
 */
const gateMessage = (channel: string, mode: string) => mode === 'unavailable' ? 'Publication is unavailable for this channel.'
  : `Sending is off: publishing to ${channel === 'EBAY' ? 'eBay' : channel === 'AMAZON' ? 'Amazon' : channel === 'SHOPIFY' ? 'Shopify' : channel === 'ETSY' ? 'Etsy' : channel} is ${mode === 'gated' ? 'turned off' : `in ${mode} mode`} on this server. ${channel === 'ETSY'
    ? 'Nexus ran every check it can without reading Etsy (it reads the live listing only when sending is live)' : 'Every check above ran'}; nothing will be sent until live publishing is turned on.`

/**
 * Build shape v2 — which rows of this destination are reviewed as Full update, from the rows the caller asked for
 * (`fullProductIds`; P6 passes the stored Action values). Everything else is Partial update, exactly as before.
 * Amazon: each existing SKU on its own. eBay Trading and Etsy: the whole listing, from its main row (a variation row
 * alone is refused). eBay Inventory and existing Shopify products: refused for now — the row is blocked with the shared sentence.
 * A row not on the channel yet is created whole either way (its mode is Partial: the create).
 */
function sendModes(facts: PublicationFacts, requested: readonly string[] | undefined) {
  const asked = new Set((requested ?? []).filter(id => facts.products.some(product => product.id === id)))
  const onChannel = (productId: string) => facts.listings.some(listing => listing.productId === productId && listing.externalListingId)
  const full = new Set<string>(), blocked = new Map<string, string>()
  const { channel } = facts.scope
  if (channel === 'AMAZON') for (const id of asked) { if (onChannel(id)) full.add(id) }
  else if (channel === 'EBAY' && usesEbayInventory(facts)) for (const id of asked) { if (onChannel(id)) blocked.set(id, FULL_EBAY_INVENTORY_LATER) }
  else if (channel === 'EBAY') {
    const item = facts.listings.some(listing => listing.externalListingId)
    if (asked.has(facts.parent.id) && item) for (const product of facts.products) full.add(product.id)
    else if (item) for (const id of asked) if (id !== facts.parent.id) blocked.set(id, FULL_EBAY_VARIATION)
  } else if (channel === 'ETSY') {
    const listed = facts.listings.some(listing => listing.externalListingId)
    if (asked.has(facts.parent.id) && listed) for (const product of facts.products) full.add(product.id)
    else if (listed) for (const id of asked) if (id !== facts.parent.id) blocked.set(id, FULL_ETSY_VARIATION)
  } else if (channel === 'SHOPIFY') for (const id of asked) { if (onChannel(id)) blocked.set(id, SHOPIFY_EXISTING_NOT_YET) }
  return { asked, full, blocked }
}

/**
 * New listings (Owner 2026-10-04) — what this review does with the rows it would CREATE: every row not on the channel,
 * those Nexus deleted included (simplify: a deleted row is a row not on the channel, default Not listed):
 *  - `held`: a main row whose Status is Not listed holds its family here (eBay, Shopify and Etsy: the whole listing; Amazon: the
 *    main row and every row not on the channel — they need their main product); a standalone product set Not listed is
 *    held too, and so is a deleted row left Not listed. Nothing of a held row is sent and its create is never ticked
 *    (`blocked` says why: a deleted row in the delete's own words). A new variation set Not listed is not in this review at
 *    all (`readPublicationFacts` leaves it out, as an excluded one).
 *  - `relist`: the deleted rows this review lists again (their Status is Active or Inactive): created whole, ticked.
 *  - `inactive`: Amazon, eBay and Etsy rows created Inactive (never a family's main row: it has no offer or stock of its
 *    own) — Amazon without this market's offer, eBay at quantity 0, Etsy a new variation of a listing already on Etsy,
 *    hidden (its offering off, D6); the settle step marks them paused (Etsy: hidden) once the channel accepts.
 *  - `startsAs`: every created row and how it starts ("Creates GALE-M (inactive)").
 *  - `createStatus`: Shopify — the new product's status, from the main row's choice (Active → ACTIVE, Inactive → DRAFT).
 *  - `etsyCreateState`: Etsy — how a listing not on Etsy yet starts, from the main row's choice (Inactive → an Etsy draft;
 *    Active is refused until Nexus sends photos). Null once the listing is on Etsy.
 *  - `choiceIds`: rows whose own stored choice the settle clears once the channel accepted them.
 * `startAs` (the products list's "New listings start as", ND4 B) replaces every row's Active / Inactive, never a Not listed.
 */
function newRowsOf(facts: PublicationFacts, startAs: StartAsTarget | null) {
  const { scope, parent, products } = facts
  // Facts read before New listings (a caller's stand-in) carry no choices: nothing is held or created Inactive.
  const choices: PublicationFacts['createChoices'] = facts.createChoices ?? new Map()
  const deletions: ReadonlyMap<string, ListingDeletion> = facts.deletions ?? new Map()
  // Not on the channel by the selling state's own rule (`newListingChoices` holds exactly those, deleted rows included).
  const isNew = (productId: string) => choices.has(productId)
  const targetOf = (productId: string) => {
    const choice = choices.get(productId)
    if (!choice) return null
    return startAs && choice.target !== 'not_listed' ? startAs : choice.target
  }
  // Shopify, and Etsy while its listing is not on Etsy yet, create (or list again) the whole listing: its main row's choice
  // decides for every variant. A new variation of a listing already on Etsy has its own choice.
  const etsyListed = scope.channel === 'ETSY' && facts.listings.some(listing => listing.externalListingId)
  const effective = (productId: string) => scope.channel === 'SHOPIFY' || (scope.channel === 'ETSY' && !etsyListed) ? targetOf(parent.id) : targetOf(productId)
  // A deleted row says why in the delete's own words ("Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active.").
  const heldWords = (productId: string, reason: string) => deletions.has(productId) ? deletedPublishSkip(deletions.get(productId)!) : reason
  const family = products.length > 1 || products.some(product => product.id !== parent.id)
  const held = new Map<string, string>()
  if (isNew(parent.id) && products.some(product => product.id === parent.id) && targetOf(parent.id) === 'not_listed') {
    const reason = family ? NOT_LISTED_MAIN_HELD : NOT_LISTED_LEFT_OUT
    for (const product of products) if (scope.channel === 'EBAY' || scope.channel === 'SHOPIFY' || scope.channel === 'ETSY' || product.id === parent.id || isNew(product.id)) held.set(product.id, heldWords(product.id, reason))
  }
  // A deleted row left Not listed sends nothing (every Publish skips it until its Status lists it again).
  for (const product of products) if (!held.has(product.id) && deletions.has(product.id) && effective(product.id) === 'not_listed') held.set(product.id, heldWords(product.id, NOT_LISTED_LEFT_OUT))
  // S10 / I1 — an UNLINKED row (Nexus forgot its channel id; the item may still be live there) is never listed as new,
  // whatever its Status says: that would make a second item beside the live one. Its own words say how to link it again.
  for (const product of products) if (deletions.get(product.id)?.unlinked) held.set(product.id, deletedPublishSkip(deletions.get(product.id)!))
  const relist = new Map<string, ListingDeletion>()
  for (const product of products) {
    const deletion = deletions.get(product.id)
    const target = effective(product.id)
    if (deletion && !held.has(product.id) && (target === 'active' || target === 'inactive')) relist.set(product.id, deletion)
  }
  const inactive = new Set<string>()
  const startsAs: PublishCreateRow[] = []
  const choiceIds: string[] = []
  for (const product of products) {
    if (!isNew(product.id) || held.has(product.id)) continue
    const target = effective(product.id)
    if (target !== 'active' && target !== 'inactive') continue
    startsAs.push({ productId: product.id, sku: product.sku, startsAs: target })
    if (choices.get(product.id)?.own) choiceIds.push(product.id)
    const familyMain = family && product.id === parent.id
    if (target === 'inactive' && !familyMain && (scope.channel === 'AMAZON' || scope.channel === 'EBAY' || (scope.channel === 'ETSY' && etsyListed))) inactive.add(product.id)
  }
  const mainTarget = isNew(parent.id) && !held.has(parent.id) ? targetOf(parent.id) : null
  // Wave 2 D4 — the one rule the sheet's "Shopify status" cell and the Media tab read too (`shopifyCreateStatus`).
  const createStatus = scope.channel === 'SHOPIFY' ? shopifyCreateStatus(mainTarget) : null
  // E1 (Owner D1 = A) — the same rule for an Etsy listing not on Etsy yet (`etsyCreateState`): Inactive is an Etsy draft.
  const etsyCreate = scope.channel === 'ETSY' && !etsyListed ? etsyCreateState(mainTarget) : null
  return { held, relist, inactive, startsAs, createStatus, etsyCreateState: etsyCreate, choiceIds, deleted: (productId: string) => deletions.has(productId) }
}

/** One row a review lists again, as the publication keeps it (S3 explains Amazon's refusal with it; the settle clears the choice). */
type PublicationRelist = Required<PublicationRelistRecord>

/**
 * `verify` (the preview only): a NEW eBay listing whose own checks pass is checked by eBay too (VerifyAddFixedPriceItem,
 * which creates nothing), so its problems are in this review, not at the send. The send runs eBay's check again.
 * `fullProductIds` (build shape v2): the rows to review as Full update (`sendModes`).
 */
async function buildReview(productId: string, scope: StudioPublishScope, options: { verify?: boolean; fullProductIds?: readonly string[]; startAs?: StartAsTarget | null } = {}) {
  const facts = await readPublicationFacts(productId, scope)
  const mode = publishMode(scope.channel)
  const issues = [...facts.issues]
  // Sharing studio step 5 — the same shared product already live on this channel in the other business (a warning).
  issues.push(...await sharedListingWarnings(facts.parent.id, scope.channel, scope.marketplace))
  const existingProducts = new Set(facts.listings.filter(listing => listing.externalListingId).map(listing => listing.productId))
  const modes = sendModes(facts, options.fullProductIds)
  for (const [blockedId, reason] of modes.blocked) {
    const product = facts.products.find(p => p.id === blockedId)
    issues.push({ productId: blockedId, sku: product?.sku, severity: 'warning', message: `${product?.sku ?? 'This row'}: ${reason}` })
  }
  // New listings — the rows this review would create (deleted rows included): held (Not listed), listed again, created
  // Inactive, how each starts.
  const creates = newRowsOf(facts, options.startAs ?? null)
  const inactiveOption = creates.inactive.size ? { inactiveProductIds: creates.inactive } : {}
  let prepared: Prepared | null = null
  let changePlan: PublicationChangePlan | null = null
  let baselineRevision: string | null = null
  let locations: StudioPublishReview['locations'], visibility: string | undefined
  try {
    if (scope.channel === 'AMAZON') prepared = await prepareAmazonPublication(facts, { ...(modes.full.size ? { fullProductIds: modes.full } : {}), ...inactiveOption })
    else if (scope.channel === 'EBAY') {
      prepared = usesEbayInventory(facts) ? await prepareEbayInventoryPublication(facts) : await prepareEbayPublication(facts, { ...(modes.full.size ? { full: true } : {}), ...inactiveOption })
      if (prepared.kind === 'ebay') for (const message of prepared.notices ?? []) issues.push({ severity: 'warning', message })
    }
    else if (scope.channel === 'SHOPIFY') {
      if (facts.excluded) throw new Error('This Shopify family has excluded variants. Review the family selection before publishing.')
      const { previewContentSync } = await import('../shopify/content-sync.service.js')
      // Publish's own create status when it decided one (its Status choices, "New listings start as"; null = it holds the
      // product itself): the review reads no other. Facts without choices leave it to the Status column, as the send does.
      const decided = creates.createStatus !== null || creates.held.has(facts.parent.id)
      const preview = await previewContentSync(productId, { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }, true,
        decided ? { createStatus: creates.createStatus } : {})
      if (preview.remote || facts.listings.some(listing => listing.externalListingId))
        issues.push({ severity: 'error', message: SHOPIFY_EXISTING_NOT_YET })
      for (const message of preview.errors) issues.push({ severity: 'error', message })
      locations = preview.locations.filter(l => l.isActive).map(({ id, name }) => ({ id, name }))
      if (!locations.length) issues.push({ severity: 'error', message: 'This Shopify store has no active inventory location.' })
      // New listings — a product Shopify does not hold yet is created with the main row's Status (Active or a Draft).
      // (Held by Not listed: nothing is created, so there is no visibility to name.)
      const status = !preview.remote ? creates.createStatus ?? preview.changes.newProductStatus : preview.changes.newProductStatus
      visibility = status ? String(status) : undefined
      const products = facts.products.map(product => {
        const variants = preview.variants.filter(variant => variant.id === product.id)
        if (variants.length > 1 || (!variants.length && product.id !== facts.parent.id)) throw new Error(`${product.sku}: the Shopify variant identity is unavailable.`)
        // A grouped parent is a family content owner; sellable variants use the SKU actually sent by the native publisher.
        return { productId: product.id, sku: variants[0]?.sku ?? product.sku }
      })
      prepared = { kind: 'shopify', revision: preview.revision, remoteRevision: preview.remoteRevision, initialized: preview.initialized, draft: preview.draft, products }
    } else if (scope.channel === 'ETSY') {
      // E1 — every check and the whole change plan in every mode; Etsy itself is read only when sending to it is live.
      prepared = await prepareEtsyPublication(facts, { createState: creates.etsyCreateState, ...inactiveOption,
        readLive: async input => (await import('../live-read/etsy.js')).readEtsyLive(input),
        // E3 — a create reads the shop (its languages and currency) when sending is live.
        readShop: async accountId => (await import('../live-read/etsy.js')).readEtsyShop(accountId) })
      for (const message of prepared.notices ?? []) issues.push({ severity: 'warning', message })
    } else issues.push({ severity: 'error', message: `Direct publishing to ${scope.channel === 'WOOCOMMERCE' ? 'WooCommerce' : scope.channel} is not available yet. Your product changes are saved in the studio.` })
    if (prepared && prepared.kind !== 'shopify') {
      // An Inventory listing is reviewed and sent by its owner alone (`prepareEbayInventoryChanges` addresses every change
      // to it), so its baseline is the owner's. Judged against all included products, a family failed every review.
      const owner = prepared.kind === 'ebay-inventory' ? prepared.owner.productId : null
      const baselineFacts = owner ? { ...facts, products: facts.products.filter(product => product.id === owner) } : facts
      const baseline = await readPublicationBaseline(baselineFacts, prepared.products)
      baselineRevision = baseline.revision
      changePlan = prepared.kind === 'amazon' ? await prepareAmazonChanges(facts, prepared, baseline.values, { ...(modes.full.size ? { fullProductIds: modes.full } : {}),
        ...(creates.relist.size ? { relist: new Map([...creates.relist].map(([productId, deletion]) => [productId, { deletedAt: deletion.at }])) } : {}) })
        : prepared.kind === 'ebay-inventory' ? prepareEbayInventoryChanges({ owner: prepared.owner, ours: prepared.ours, live: prepared.live, destination: prepared.destination, baselineValues: baseline.values })
        : prepared.kind === 'etsy' ? prepareEtsyChanges(facts, prepared, baseline.values, modes.full.size ? { full: true } : {})
        : await prepareEbayChanges(facts, prepared as EbayPublication, baseline.values, modes.full.size ? { full: true } : {})
      if (changePlan.kind === 'amazon-changes') for (const product of changePlan.products) {
        if (product.newListing === false) existingProducts.add(product.productId)
      }
      // Build shape v2 — a blocked row sends nothing; a Full row's own problems (no live read, another product type…).
      if (modes.blocked.size) changePlan.changes = blockRowChanges(changePlan.changes, modes.blocked)
      // New listings — a row held by Not listed (its own, its main row's, or a deleted row's default) sends nothing: no
      // create, never ticked.
      if (creates.held.size) changePlan.changes = blockRowChanges(changePlan.changes, creates.held)
      if (changePlan.kind !== 'ebay-inventory-changes') issues.push(...changePlan.fullIssues ?? [])
      if (changePlan.kind === 'amazon-changes' && changePlan.changes.some(change => change.field === 'variation_theme' && change.status !== 'SAME'
        && existingProducts.has(change.productId)))
        issues.push({ severity: 'warning', field: 'variation_theme', message: 'Changing a live variation theme can regroup its variants. Review the variation relationships before publishing.' })
    }
  } catch (error) { issues.push(...refusalIssues(error)) }
  // Audit P1 — eBay's own check, only once Nexus's checks found nothing that blocks (else eBay would name the same gaps again).
  if (options.verify && prepared?.kind === 'ebay' && !prepared.itemId && mode === 'live' && !issues.some(issue => issue.severity === 'error'))
    issues.push(...await verifyNewEbayListing(prepared, scope.accountId))
  // E3 — Publish creates a listing not on Etsy yet as an Etsy draft, or updates one Etsy holds (E2). A listing not on Etsy
  // yet set Active is refused here (Etsy needs a photo to go live, and Nexus does not send photos yet). Off live, the one
  // gate sentence, as for every channel (the plan stays visible).
  if (scope.channel === 'ETSY' && creates.etsyCreateState === 'active') issues.push({ severity: 'error', message: ETSY_NEW_ACTIVE_NEEDS_PHOTO })
  if (mode !== 'live') issues.push({ severity: 'error', message: gateMessage(scope.channel, mode) })
  // New listings — a Shopify product is one listing with no field ticks: held by Not listed (a deleted product left Not
  // listed included), nothing of it is sent.
  if (scope.channel === 'SHOPIFY' && creates.held.size) issues.push({ severity: 'error', message: [...creates.held.values()][0] })
  // S10 (per-channel SKU) — the SKU each row sends, and what this review does about a row the channel holds under another
  // SKU (Amazon: create NEW, then delete OLD, typed like Delete; eBay Trading: rename in place; Etsy: cannot yet). A SKU
  // longer than the channel takes is refused here by name (only where the repo shows the channel's limit).
  const sentSkuOf = (productId: string) => sentSku(prepared, productId) ?? facts.products.find(p => p.id === productId)?.sku ?? ''
  const moves = await skuMoveRows(facts, prepared, changePlan)
  issues.push(...moves.issues)
  if (prepared) for (const product of facts.products) {
    if (creates.held.has(product.id) || modes.blocked.has(product.id)) continue
    const problem = channelSkuLengthProblem(scope.channel, sentSkuOf(product.id))
    if (problem) issues.push({ productId: product.id, sku: product.sku, severity: 'error', message: problem })
  }
  for (const row of creates.startsAs) row.sku = sentSkuOf(row.productId) || row.sku
  const relist = await relistRows(facts, prepared, creates.relist, sentSkuOf)
  const startsAsOf = new Map(creates.startsAs.map(row => [row.productId, row.startsAs]))
  const overwrite = await readPublicationOverwrite(facts)
  const removals = changePlan && changePlan.kind !== 'ebay-inventory-changes' ? changePlan.removals : undefined
  const review: StudioPublishReview = {
    id: null, productId, scope, accountLabel: scope.channel === 'ETSY' ? etsyShopLabel(facts.account) : facts.account.displayName, aliasLabel: facts.aliasLabel, mode,
    action: existingProducts.size ? 'update' : 'create', excluded: facts.excluded,
    changes: changePlan?.changes, skipped: facts.skipped,
    rows: facts.products.map(p => ({ productId: p.id, sku: p.sku,
      title: String(facts.resolved[0]?.products.find(r => r.productId === p.id)?.cells.title?.value ?? facts.resolved[0]?.products.find(r => r.productId === p.id)?.cells.item_name?.value ?? p.name ?? p.sku),
      // S10 — a moved Amazon row is neither a Partial nor a Full update: it is sent as the create of NEW, then the delete of
      // OLD ("Move to NEW", `moveModeLabel`).
      existing: existingProducts.has(p.id), mode: moves.rows.get(p.id)?.kind === 'create-delete' ? 'move' as const
        : modes.full.has(p.id) || modes.blocked.has(p.id) ? 'full' as const : 'partial' as const,
      ...(modes.blocked.has(p.id) ? { blocked: modes.blocked.get(p.id) } : {}),
      ...(creates.held.has(p.id) ? { blocked: creates.held.get(p.id)!, ...(creates.deleted(p.id) ? { deleted: true as const } : { notListed: true as const }) } : {}),
      ...(startsAsOf.has(p.id) ? { startsAs: startsAsOf.get(p.id)! } : {}),
      ...(relist.rows.has(p.id) ? { relist: relist.rows.get(p.id)! } : {}),
      ...(prepared && sentSkuOf(p.id) && sentSkuOf(p.id) !== p.sku ? { sendsSku: sentSkuOf(p.id) } : {}),
      ...(moves.rows.has(p.id) ? { skuMove: moves.rows.get(p.id)! } : {}) })),
    issues: [...new Map(issues.map(i => [JSON.stringify(i), i])).values()], expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), locations, visibility, overwrite,
    ...(removals?.length ? { removals } : {}),
    ...(moves.confirm ? { confirm: moves.confirm } : {}),
  }
  return { facts, review, prepared, changePlan, relist: relist.kept, creates: createsRecord(creates, prepared),
    // New listings — only a review that holds, creates Inactive or starts rows a certain way adds them (others keep their digest).
    // Etsy: its plan without the live offering numbers and the sold-out flip (`etsyRevisionView`) — a sale or a stock push
    // between the review and the submit never asks for a new review.
    revision: publicationDigest([facts.revision, changePlan?.kind === 'etsy-changes' ? etsyRevisionView(changePlan) : changePlan ?? prepared, baselineRevision, mode,
      overwrite, [...creates.held.keys()].filter(creates.deleted).sort(), relist.kept,
      ...(creates.held.size || creates.inactive.size || creates.startsAs.length || creates.createStatus || creates.etsyCreateState || options.startAs
        ? [[...creates.held.keys()].sort(), [...creates.inactive].sort(), creates.startsAs, creates.createStatus, options.startAs ?? null,
          // Etsy only: how its new listing starts (the other channels keep their digest).
          ...(creates.etsyCreateState ? [creates.etsyCreateState] : [])] : [])]) }
}

/**
 * New listings — what a publication keeps about the rows it creates: `inactiveProductIds` (the settle marks them paused
 * once accepted; Amazon also keeps each one's product type and FBA fact for the mark), `createChoiceProductIds` (their
 * stored Status choice is cleared once accepted), `creates` (the batch view's "Creates GALE-M (inactive)") and, for
 * Shopify, `createStatus`.
 */
function createsRecord(creates: ReturnType<typeof newRowsOf>, prepared: Prepared | null) {
  const amazon = prepared?.kind === 'amazon' ? prepared : null
  const inactive = [...creates.inactive].filter(productId => prepared?.products.some(product => product.productId === productId))
  const createInactive = amazon ? Object.fromEntries(inactive.map(productId => {
    const sku = amazon.products.find(product => product.productId === productId)?.sku
    const message = amazon.feed.messages.find(entry => entry.sku === sku)
    const fulfilment = (message?.attributes?.fulfillment_availability as Array<{ fulfillment_channel_code?: unknown }> | undefined) ?? []
    return [productId, { productType: message?.productType ?? null, fba: fulfilment.some(entry => String(entry.fulfillment_channel_code ?? '').startsWith('AMAZON')) }]
  })) : {}
  return { inactiveProductIds: inactive, createInactive, createChoiceProductIds: creates.choiceIds, creates: creates.startsAs, createStatus: creates.createStatus }
}

/** S10 — the SKU the prepared publication sends for a row, or null when it names none (no publication, a row it leaves out). */
function sentSku(prepared: Prepared | null, productId: string): string | null {
  if (!prepared) return null
  if (prepared.kind === 'ebay-inventory') return prepared.ours.variants.find(v => v.productId === productId)?.sku ?? (prepared.owner.productId === productId ? prepared.owner.sku : null)
  return (prepared.products as Array<{ productId: string; sku: string }>).find(p => p.productId === productId)?.sku ?? null
}

/**
 * S10 (per-channel SKU) — the rows the channel holds under another SKU than the one this review sends (only rows with
 * their own SKU, `channelSku`: a row without one publishes as before), and what the review does about each: Amazon creates
 * NEW and deletes OLD after Amazon accepts it (typed confirmation); eBay Trading renames in place; Etsy cannot yet (said,
 * never sent: studio Publish keeps the SKU Etsy holds). eBay Inventory refuses in its builder; Shopify renames in place
 * through its own synchronisation (content-sync), which studio Publish leaves to it for a product Shopify holds.
 * F5 (browser check 2026-10-05): an Amazon publication that could not be prepared still names its moves and asks for the
 * typed confirmation (`amazonMovesWithoutPublication`); its problems say why nothing is sent yet. Exported for its test.
 */
export async function skuMoveRows(facts: PublicationFacts, prepared: Prepared | null, changePlan: PublicationChangePlan | null) {
  const rows = new Map<string, StudioPublishSkuMove>()
  const issues: StudioPublishReview['issues'] = []
  let confirm: StudioPublishReview['confirm'] | null = null
  if (prepared?.kind === 'amazon') {
    const review = await amazonMoveReview(facts, prepared)
    for (const [productId, move] of review.rows) rows.set(productId, move)
    confirm = review.confirm
  } else if (!prepared && facts.scope.channel === 'AMAZON') {
    // F5 (browser check 2026-10-05) — the publication could not be prepared (its problem is listed already, so nothing is
    // sent). The rows it would move still read "Move to NEW", and the review still asks for the typed confirmation.
    const found = await amazonMovesWithoutPublication(facts)
    const review = await amazonMoveReview(facts, found)
    for (const [productId, move] of review.rows) rows.set(productId, move)
    confirm = review.confirm
    if (found.refusal) issues.push({ severity: 'error', message: found.refusal })
  } else if (changePlan?.kind === 'ebay-changes') {
    // Only a rename this review matched on eBay (`renames`); a move eBay holds no trace of is a warning, never this line.
    for (const rename of changePlan.renames ?? []) rows.set(rename.productId, { from: rename.from, to: rename.to, kind: 'rename', sentence: ebayRenameSentence(rename.from, rename.to), warning: null })
  } else if (facts.scope.channel === 'ETSY') {
    for (const product of facts.products) {
      const listing = facts.listings.find(l => l.productId === product.id)
      if (!listing || isStillDraftListing(listing) || !listing.channelSku?.trim()) continue
      const row = { ...listing, channel: 'ETSY' }
      const live = liveChannelSku(row, product.sku)?.sku, wanted = wantedChannelSku(row, product.sku).sku
      if (!live || !wanted || live === wanted) continue
      const sentence = etsySkuMoveSentence(live, wanted)
      rows.set(product.id, { from: live, to: wanted, kind: 'none', sentence, warning: null })
      issues.push({ productId: product.id, sku: product.sku, severity: 'warning', message: `${product.sku}: ${sentence}` })
    }
  }
  return { rows, issues, confirm }
}

/**
 * S4 — what the review says about each row it lists again: "Lists GALE-M on ASIN B0NEW (was B0OLD).", and, when Amazon
 * still holds FBA units labelled for the old ASIN, a warning (never a refusal). The ASIN is the one the create names
 * (`merchant_suggested_asin`: the product ID cell, editable on a deleted row). `kept` is what the publication stores.
 */
async function relistRows(facts: PublicationFacts, prepared: Prepared | null, deletions: ReadonlyMap<string, ListingDeletion>,
  sentSkuOf: (productId: string) => string = productId => facts.products.find(p => p.id === productId)?.sku ?? '') {
  const rows = new Map<string, NonNullable<StudioPublishReview['rows'][number]['relist']>>()
  const kept: PublicationRelist[] = []
  if (!deletions.size) return { rows, kept }
  const amazon = prepared?.kind === 'amazon' ? prepared : null
  // S10 — the SKU the relist sends (the listing's own SKU when it has one), named in its sentence.
  const sellerSku = sentSkuOf
  const asinOf = (productId: string) => {
    const message = amazon?.feed.messages.find(m => m.sku === sellerSku(productId))
    const value = (message?.attributes?.merchant_suggested_asin as Array<{ value?: unknown }> | undefined)?.[0]?.value
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  for (const product of facts.products) {
    const deletion = deletions.get(product.id)
    if (!deletion) continue
    const asin = facts.scope.channel === 'AMAZON' ? asinOf(product.id) : null
    let warning: string | null = null
    if (amazon && asin && deletion.oldReference && asin !== deletion.oldReference) {
      const units = (await readFbaUnits(amazon.marketplaceId, [{ productId: product.id, sku: sellerSku(product.id) }], { asin: deletion.oldReference })).get(product.id)
      warning = units ? fbaNewAsinWarning(units, deletion.oldReference) : null
    }
    // S10 — listed again under another SKU than the one deleted: the old one stays deleted, and the line says so.
    const sent = sellerSku(product.id) || product.sku
    const oldSku = deletion.sku?.trim() || null
    const sentence = [relistSentence(sent, asin, deletion.oldReference, facts.scope.channel), oldSku && oldSku !== sent ? oldSkuStaysDeleted(oldSku, deletedOn(deletion.at)) : null].filter(Boolean).join(' ')
    rows.set(product.id, { deletedAt: deletion.at, oldReference: deletion.oldReference, asin, sentence, warning })
    kept.push({ productId: product.id, sku: sellerSku(product.id), deletedAt: deletion.at, oldReference: deletion.oldReference, asin })
  }
  return { rows, kept }
}

/**
 * Step 5 (item 3/6) — a review made for a publication batch. `batchId` ties the review to the batch that will send it;
 * `expiresInMs` lets the batch own the review's lifetime (the revision check at submit stays the real guard). With a
 * `batchId`, a review that cannot be sent is kept as a BLOCKED row (never sent, never in flight, never in the history),
 * so the batch can show why; without one, a blocked review is returned unsaved, as before.
 */
export interface PreviewOptions {
  batchId?: string
  expiresInMs?: number
  /**
   * Build shape v2 — the rows to review as Full update (every field Nexus manages, ticked and locked). Everything else is
   * Partial update, exactly as before. Kept with the review, so its submit rebuilds the same plan.
   */
  fullProductIds?: string[]
  /**
   * New listings (ND4 B) — the products list's "New listings start as": Active or Inactive for every row this review
   * creates (a row set Not listed stays out). Kept with the review, so its submit rebuilds the same plan.
   */
  startAs?: StartAsTarget | null
}

/** A stored "New listings start as", or null. */
const storedStartAs = (value: unknown): StartAsTarget | null => value === 'active' || value === 'inactive' ? value : null

/** New listings — the record a publication keeps about the rows it creates (`createsRecord`), only what is set. */
const createsColumns = (record: ReturnType<typeof createsRecord>, startAs: StartAsTarget | null) => ({
  ...(record.inactiveProductIds.length ? { inactiveProductIds: record.inactiveProductIds, createInactive: record.createInactive } : {}),
  ...(record.createChoiceProductIds.length ? { createChoiceProductIds: record.createChoiceProductIds } : {}),
  ...(record.creates.length ? { creates: record.creates } : {}),
  ...(record.createStatus ? { createStatus: record.createStatus } : {}),
  ...(startAs ? { startAs } : {}),
})

/** The Full update rows a review was asked for, as stored with it: unique, sorted, none = absent. */
const storedFullIds = (ids: unknown): string[] | undefined => {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 200))].sort() : []
  return list.length ? list : undefined
}

/**
 * The review of one destination and what decides whether it may be stored: the publication key, a publication at this
 * destination still waiting for its result (D3: one a person marked checked no longer blocks), and whether only photos
 * may be sent. Reads only (the channel too, through the studio transports); it writes nothing.
 */
async function reviewPlan(productId: string, scope: StudioPublishScope, options: { verify?: boolean; fullProductIds?: readonly string[]; startAs?: StartAsTarget | null } = {}) {
  const plan = await buildReview(productId, scope, options)
  const key = publicationDigest([workspaceIdForQuery(), plan.facts.destination.familyId, scope.channel, scope.accountId, scope.marketplace, plan.facts.destination.aliasKey])
  const unresolved = await prisma.bulkOperation.findFirst({ where: { ...OPEN_PUBLICATION, changes: { path: ['publicationKey'], equals: key } }, select: { id: true, userId: true } })
  // P4c — errors that each name a field (an off-list Season value) block that field, not the listing: on a change-only
  // review the photos can still be sent. Any error that names no field blocks the review as before.
  const errors = plan.review.issues.filter(i => i.severity === 'error')
  const photosOnly = errors.length > 0 && errors.every(i => i.field) && !!plan.changePlan && !!plan.review.changes?.some(c => c.selectable && isPhotoChangeId(c.id))
  return { plan, key, unresolved, errors, photosOnly }
}

/** A durable review also owns retries, across API processes and browser reconnects. */
export async function previewStudioPublication(productId: string, scope: StudioPublishScope, userId: string | null, options: PreviewOptions = {}): Promise<StudioPublishReview> {
  if (scope.channel === 'SHOPIFY') {
    // Materialize the existing content model's default draft so remote identity and revision
    // match the subsequent send. This saves only in Nexus; it makes no Shopify mutation.
    const { getContentWorkspace, saveContentWorkspace } = await import('../shopify/content-workspace.service.js')
    const contentScope = { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }
    const workspace = await getContentWorkspace(productId, contentScope)
    if (!workspace.initialized) await saveContentWorkspace(productId, contentScope, { draft: workspace.draft, expectedRevision: workspace.revision })
  }
  const fullProductIds = storedFullIds(options.fullProductIds)
  const startAs = storedStartAs(options.startAs)
  const { plan, key, unresolved, errors, photosOnly } = await reviewPlan(productId, scope, { verify: true, fullProductIds, startAs })
  if (options.expiresInMs) plan.review.expiresAt = new Date(Date.now() + options.expiresInMs).toISOString()
  const id = randomUUID()
  const columns = { ...publicationColumns(plan.facts.destination.familyId, scope, plan.facts.destination.aliasKey ?? ''), ...(options.batchId ? { batchId: options.batchId } : {}) }
  // Step 5 — inside a batch a review that cannot be sent is kept, BLOCKED, so the batch can say why. It is never sent.
  const blocked = async (review: StudioPublishReview) => {
    if (!options.batchId) return review
    const kept = { ...review, id }
    await prisma.bulkOperation.create({ data: { id, userId, status: 'BLOCKED', productCount: review.rows.length, changeCount: 0, ...columns,
      completedAt: new Date(), summary: json({ message: blockingIssues(review.issues).map(i => i.message).join('\n') || 'This review cannot be sent.', blocked: true }),
      changes: json({ kind: KIND, publicationKey: key, productId, scope, revision: plan.revision, review: kept, ...(fullProductIds ? { fullProductIds } : {}),
        ...createsColumns(plan.creates, startAs) }) } })
    return kept
  }
  // D3 — a publication a person marked checked is closed (`OPEN_PUBLICATION`) and no longer blocks its destination.
  if (unresolved) return blocked({ ...plan.review, ...(unresolved.userId === userId ? { previousPublicationId: unresolved.id } : {}), issues: [...plan.review.issues, { severity: 'error', message: `A previous publication still needs a result (${unresolved.id}). ${unresolved.userId === userId ? 'Check its status before publishing again.' : 'Ask the colleague who submitted it to check its status.'}` }] })
  if (!plan.prepared || (errors.length && !photosOnly)) return blocked(plan.review)
  const review = { ...plan.review, id, ...(photosOnly ? { photosOnly: true } : {}) }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'PREVIEW', productCount: plan.review.rows.length, changeCount: 0,
    ...columns,
    expiresAt: new Date(plan.review.expiresAt), changes: json({ kind: KIND, publicationKey: key, productId, scope, revision: plan.revision,
      changeVersion: plan.changePlan ? 1 : null, changePlan: plan.changePlan, review, ...(fullProductIds ? { fullProductIds } : {}),
      ...(plan.relist.length ? { relistProductIds: plan.relist.map(row => row.productId), relist: plan.relist } : {}),
      ...createsColumns(plan.creates, startAs) }) } })
  return review
}

/**
 * MCP full control L3 — the studio's review of one destination, built exactly as `previewStudioPublication` builds it,
 * WITHOUT saving anything: no BulkOperation row (so no review id: nothing to select or submit from it) and no Shopify
 * content save (an uninitialised Shopify document is reviewed as its default draft — the draft that save would store —
 * and no Shopify family draft listing is started). It reads the channel live, as the studio's review does, through the
 * studio transports (the channel gateway). A publication at this destination still waiting for its result is named,
 * whoever submitted it: its result belongs to the business (`publicationResultFor`).
 */
export async function reviewStudioPublication(productId: string, scope: StudioPublishScope): Promise<StudioPublishReview> {
  const { plan, unresolved, photosOnly } = await reviewPlan(productId, scope)
  if (unresolved) return { ...plan.review, previousPublicationId: unresolved.id, issues: [...plan.review.issues, { severity: 'error', message: `A previous publication still needs a result (${unresolved.id}). Check its status before publishing again.` }] }
  return { ...plan.review, ...(plan.prepared && photosOnly ? { photosOnly: true } : {}) }
}

/** The exact wire preview is compiled from the saved review. No channel reads or writes occur here. */
export async function previewStudioPublicationSelection(productId: string, id: string, body: unknown, userId: string | null): Promise<StudioPublishSelection> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication review not found.', 404)
  if (operation.status !== 'PREVIEW') throw new WorkspaceScopeError('This publication has already started. Check its result.')
  if (!operation.expiresAt || operation.expiresAt.getTime() <= Date.now()) throw new WorkspaceScopeError('This publication review expired. Review the current values again.')
  if (data.changeVersion !== 1 || !data.changePlan) throw new WorkspaceScopeError('Refresh the review to choose the fields to publish.')
  const ids = object(body).selectedIds
  if (!Array.isArray(ids) || ids.length > 50_000 || ids.some(id => typeof id !== 'string' || id.length > 2_000))
    throw new WorkspaceScopeError('Choose valid fields from this review.', 400)
  if (object(data.review).photosOnly === true && !ids.every(value => isPhotoChangeId(value as string)))
    throw new WorkspaceScopeError('Other fields of this listing have problems (listed in the review). Choose only photos, or fix them first.', 422)
  let compiled: ReturnType<typeof compileSelection>
  try { compiled = compileSelection(data.changePlan, ids, id) }
  catch (error) { throw new WorkspaceScopeError(error instanceof Error ? error.message : String(error), 400) }
  const selection = { ...compiled.selection, token: randomUUID() }
  const stored = await prisma.bulkOperation.updateMany({ where: { id, userId, status: 'PREVIEW', changes: { equals: operation.changes! } },
    data: { changeCount: selection.fieldCount, changes: json({ ...data, selection, selectionDigest: publicationDigest(compiled) }) } })
  if (stored.count !== 1) throw new WorkspaceScopeError('The selection changed in another request. Review your selection again.')
  return selection
}

/**
 * Sheet publish parity T1 — a saved review read back, for a row of the many-product dialog: the review the preview
 * returned, the fields ticked so far, and whether they can still change. The creator only, like every read here. It
 * never returns the exact channel request (the selection route prepares that when the ticks change) and makes no
 * channel read.
 */
export async function studioPublicationStoredReview(productId: string, id: string, userId: string | null, now = new Date()): Promise<StudioPublishStoredReview> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId }, select: { status: true, expiresAt: true, changes: true } })
  const data = object(operation?.changes)
  const stored = object(data.review)
  if (!operation || data.kind !== KIND || data.productId !== productId || !Array.isArray(stored.rows)) throw new WorkspaceScopeError('Publication review not found.', 404)
  const selection = object(data.selection)
  const selectedIds = Array.isArray(selection.selectedIds) ? selection.selectedIds.filter((value): value is string => typeof value === 'string') : null
  const expiresAt = operation.expiresAt?.toISOString() ?? (typeof stored.expiresAt === 'string' ? stored.expiresAt : null)
  return {
    review: { ...(stored as unknown as StudioPublishReview), ...(expiresAt ? { expiresAt } : {}) },
    status: operation.status,
    selectedIds,
    fieldCount: typeof selection.fieldCount === 'number' ? selection.fieldCount : null,
    editable: operation.status === 'PREVIEW' && !!operation.expiresAt && operation.expiresAt.getTime() > now.getTime() && data.changeVersion === 1 && !!data.changePlan,
  }
}

/** The submitter's status read. It settles through the shared core (`settleStudioPublication`), which the result sweep also runs. */
export async function studioPublicationResult(productId: string, id: string, userId: string | null): Promise<StudioPublishResult> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication not found.', 404)
  const outcome = await settleStudioPublication(id, { actorUserId: userId })
  if (!outcome) throw new WorkspaceScopeError('Publication not found.', 404)
  return outcome.result
}

/**
 * MCP full control L3 — a publication's result, read in this BUSINESS (row-level security scopes the row), not only by
 * the person who submitted it: the approver of a change Claude asked for and the person who asked may differ, and the
 * settle sweep (`jobs/studio-publication-settle.job.ts`) has no person at all. It settles through the same core as
 * `studioPublicationResult` (`settleStudioPublication`), reading the channel through the gateway, and records in the
 * submitter's name, as the submitter's own read would.
 */
export async function publicationResultFor(id: string): Promise<StudioPublishResult> {
  const outcome = await settleStudioPublication(id, { actorUserId: null })
  if (!outcome) throw new WorkspaceScopeError('Publication not found.', 404)
  return outcome.result
}

/**
 * MCP full control L3 — a publication as it is stored, read in this business (row-level security), whoever submitted it:
 * its product, destination, send time, status and the result recorded so far. A PURE read: it never asks the channel and
 * never settles (`publicationResultFor` and the studio's own read do). Null when there is none.
 */
export async function readStoredPublication(id: string): Promise<{ productId: string; scope: StudioPublishScope; startedAt: string | null
  status: string; result: StudioPublishResult | null } | null> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id }, select: { status: true, changes: true } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND) return null
  return { productId: String(data.productId), scope: data.scope as StudioPublishScope, startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
    status: operation.status, result: data.result ? data.result as StudioPublishResult : null }
}

type BuiltReview = Awaited<ReturnType<typeof buildReview>>
/**
 * Step 5 — a publication whose send this caller owns: the review row moved PREVIEW → PUBLISHING here, and nobody else
 * will send it. The submit is three parts so a batch can share them (`claimPublication` → `deliverPublication` →
 * `finishPublication`); `submitStudioPublication` runs the three in order, exactly as it always did.
 */
export interface ClaimedPublication {
  productId: string
  id: string
  userId: string | null
  data: Record<string, any>
  input: Record<string, any>
  plan: BuiltReview & { prepared: Prepared }
  destinationRow: ReturnType<typeof publicationColumns> & { batchId: string | null }
}
export interface DeliveredPublication { result: StudioPublishResult; receipt?: StudioPublishResult }

/**
 * What the caller may do besides publishing (the route's permission check). `canDelete` false: a selection that deletes
 * an old SKU (an Amazon move) is refused. Absent: not checked here (a batch checked it when the plan was submitted).
 */
export interface ClaimOptions { canDelete?: boolean }

/** Check the review and claim its send. Returns the stored result instead when it was already started or claimed. */
export async function claimPublication(productId: string, id: string, body: unknown, userId: string | null, options: ClaimOptions = {}): Promise<{ result: StudioPublishResult } | { claim: ClaimedPublication }> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication review not found.', 404)
  if (operation.status !== 'PREVIEW') return { result: await studioPublicationResult(productId, id, userId) }
  if (!operation.expiresAt || operation.expiresAt.getTime() <= Date.now()) throw new WorkspaceScopeError('This publication review expired. Review the current saved values again.')
  const originalChanges = json(operation.changes)
  const input = object(body)
  const sparse = ['AMAZON', 'EBAY', 'ETSY'].includes(data.scope?.channel)
  if (sparse && (data.changeVersion !== 1 || !data.changePlan)) throw new WorkspaceScopeError('Refresh this review to choose the fields to publish.')
  if (sparse && (typeof input.selectionToken !== 'string' || input.selectionToken !== data.selection?.token))
    throw new WorkspaceScopeError('Review the exact selected changes before publishing. This selection token is missing or stale.', 400)
  // Build shape v2 — the same rows as Full update as the review (its stored list), so the same plan is rebuilt; New
  // listings — and the same "New listings start as".
  const plan = await buildReview(productId, data.scope as StudioPublishScope, { fullProductIds: storedFullIds(data.fullProductIds), startAs: storedStartAs(data.startAs) })
  if (plan.revision !== data.revision) throw new WorkspaceScopeError('Saved information, the destination, channel settings or content-read evidence changed. Review the current values before publishing.')
  // A photos-only selection is not blocked by other fields' problems (P4c); everything else is, as before.
  const blockers = sparse ? blockingIssues(plan.review.issues, data.selection?.selectedIds) : plan.review.issues.filter(i => i.severity === 'error')
  if (blockers.length || !plan.prepared) throw new WorkspaceScopeError(blockers.map(i => i.message).join('\n') || 'Publication is unavailable.', 422)
  if (sparse) {
    if (!plan.changePlan) throw new WorkspaceScopeError('The change-only review is unavailable. Refresh the review.')
    const compiled = compileSelection(plan.changePlan, data.selection.selectedIds, id)
    if (publicationDigest(compiled) !== data.selectionDigest) throw new WorkspaceScopeError('The selected payload changed. Review the exact changes again.')
    if (!compiled.prepared || !compiled.selection.fieldCount || !compiled.selection.products.length)
      throw new WorkspaceScopeError('No fields are selected. Nothing will be sent.', 400)
    plan.prepared = compiled.prepared
  }
  if (!sparse && plan.review.overwrite?.requiresConfirmation && input.confirmOverwrite !== true) throw new WorkspaceScopeError('Confirm the overwrite warning for this review before publishing.', 400)
  // S10 (Owner D2 = A) — a selection that moves a live Amazon listing to a new SKU deletes the old SKU once Amazon accepts
  // the new one: typed like Delete (`confirm: 'DELETE'`), by someone who may delete. On a shared account the new SKU's
  // coordinate is claimed for this business first; another business holding it refuses the send. Nothing is sent otherwise.
  const moves = plan.prepared.kind === 'amazon' ? plan.prepared.moves ?? [] : []
  if (moves.length) {
    if (input.confirm !== 'DELETE') throw new WorkspaceScopeError(AMAZON_MOVE_NEEDS_CONFIRM, 400)
    if (options.canDelete === false) throw new WorkspaceScopeError(AMAZON_MOVE_ROLE_CANNOT_DELETE, 403)
    try { await claimMoveCoordinates(data.scope, moves) }
    catch (error) { throw new WorkspaceScopeError(`${error instanceof Error ? error.message : String(error)} Nothing was sent.`, 409) }
    data.skuMoves = moves.map(move => ({ ...move, marketplaceId: (plan.prepared as { marketplaceId: string }).marketplaceId }))
  } else delete data.skuMoves
  if (plan.prepared.kind === 'shopify' && !plan.review.locations?.some(l => l.id === input.locationId)) throw new WorkspaceScopeError('Choose an inventory location from this Shopify store.', 400)
  data.confirmOverwrite = !sparse && plan.review.overwrite?.requiresConfirmation === true && input.confirmOverwrite === true
  data.startedAt = new Date().toISOString()
  data.delivery = { productIds: plan.prepared.products.map(p => p.productId), aliasKey: plan.facts.destination.aliasKey ?? '' }
  // An Inventory receipt names its group, not a Trading ItemID: a later status read must not re-verify it as one.
  data.inventory = plan.prepared.kind === 'ebay-inventory-send'
  // E3 — this publication creates a new Etsy listing (as a draft): the marker, the settle and Mark as checked read it.
  if (plan.prepared.kind === 'etsy') data.etsyCreate = !plan.prepared.listingId
  data.captureVersion = 1
  const claimed = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `studio-publication:${data.publicationKey}`)
    const other = await tx.bulkOperation.findFirst({ where: { id: { not: id }, ...OPEN_PUBLICATION, changes: { path: ['publicationKey'], equals: data.publicationKey } }, select: { id: true } })
    if (other) throw new WorkspaceScopeError('Another publication is in progress or awaits verification. Check its result before sending again.')
    // The destination columns again: a review saved before the columns existed gains them when it is sent.
    // Step 2 — a publication sent from now on is swept: `checkCount` 0 marks it as the new code's, and the first look is
    // its 30-minute receipt deadline. Rows from before this step keep both null and are never swept.
    const submittedAt = new Date(data.startedAt)
    return (await tx.bulkOperation.updateMany({ where: { id, userId, status: 'PREVIEW', changes: { equals: originalChanges } }, data: { status: 'PUBLISHING',
      submittedAt, checkCount: 0, nextCheckAt: nextPublicationCheck({ channel: data.scope.channel, status: 'PUBLISHING', inventory: false, reference: false,
        checkCount: 0, submittedAt, now: submittedAt }).nextCheckAt,
      ...publicationColumns(plan.facts.destination.familyId, data.scope, data.delivery.aliasKey), changes: json(data) } })).count === 1
  })
  if (!claimed) {
    const latest = await prisma.bulkOperation.findFirst({ where: { id, userId } })
    if (latest?.status === 'PREVIEW') throw new WorkspaceScopeError('The selection changed while waiting to publish. Review the selected changes again.')
    return { result: await studioPublicationResult(productId, id, userId) }
  }
  const destinationRow = { ...publicationColumns(plan.facts.destination.familyId, data.scope, data.delivery.aliasKey), batchId: operation.batchId ?? null }
  announcePublication(id, destinationRow, data, 'PUBLISHING')
  return { claim: { productId, id, userId, data, input, plan: plan as ClaimedPublication['plan'], destinationRow } }
}

/** The checks every delivery makes first: publishing is still live, and the saved values did not change since the claim. */
export async function checkDeliveryStillValid(claim: ClaimedPublication): Promise<void> {
  const { scope } = claim.plan.facts
  if (publishMode(scope.channel) !== 'live') throw new Error('Live publication was disabled before submission.')
  if ((await readPublicationFacts(claim.productId, scope)).revision !== claim.plan.facts.revision) throw new Error('Saved information changed while this publication was waiting. Review the current values before publishing.')
}

/**
 * Journal FKs name only this destination. These drafts never establish channel presence. The one creator
 * (`ensureDraftListings`) starts exactly the delivered products that have no row here (`family: false`).
 */
export const ensureClaimDrafts = (claim: ClaimedPublication) => prisma.$transaction(tx => ensureDraftListings(tx, { channel: claim.plan.facts.scope.channel,
  market: claim.plan.facts.scope.marketplace, accountId: claim.plan.facts.scope.accountId, aliasKey: claim.plan.facts.destination.aliasKey ?? '',
  productIds: claim.data.delivery.productIds, family: false }))

/** Store the channel's receipt as the publication's status, with its records; the sweep's first look comes with it. */
export async function checkpointPublication(claim: ClaimedPublication, value: StudioPublishResult): Promise<void> {
  const { id, userId, data, destinationRow } = claim
  // Step 2 — the receipt also sets the sweep's first look: an Amazon feed in 2 minutes, an eBay item read back the same.
  const check = nextPublicationCheck({ channel: data.scope.channel, status: value.status, inventory: data.inventory === true,
    reference: !!value.results[0]?.reference, checkCount: 0, submittedAt: new Date(data.startedAt), now: new Date() })
  await prisma.$transaction(async tx => {
    await tx.bulkOperation.update({ where: { id }, data: { status: value.status, summary: json(publicationSummary(value)), nextCheckAt: check.nextCheckAt,
      changes: json({ ...data, result: value }) } })
    await settlePublicationRecords(tx, recordContext(id, data, userId), value)
  })
  if (value.status !== 'PUBLISHING') announcePublication(id, destinationRow, data, value.status)
}

/** Send a claimed publication to its channel. Never throws: a failure becomes the result (FAILED when nothing was sent). */
export async function deliverPublication(claim: ClaimedPublication): Promise<DeliveredPublication> {
  const { productId, id, userId, data, input, plan } = claim
  let result: StudioPublishResult
  let providerStarted = false
  let receipt: StudioPublishResult | undefined
  const context = recordContext(id, data, userId)
  const checkpoint = async (value: StudioPublishResult) => {
    receipt = value
    await checkpointPublication(claim, value)
  }
  const ensureDrafts = () => ensureClaimDrafts(claim)
  try {
    const { scope } = plan.facts
    await checkDeliveryStillValid(claim)
    if (plan.prepared.kind === 'shopify') {
      const shopify = plan.prepared
      const contentScope = { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }
      let revision = plan.prepared.revision
      if (!plan.prepared.initialized) {
        const { saveContentWorkspace } = await import('../shopify/content-workspace.service.js')
        const saved = await saveContentWorkspace(productId, contentScope, { draft: plan.prepared.draft, expectedRevision: revision })
        revision = saved.revision
      }
      const { synchronizeContent } = await import('../shopify/content-sync.service.js')
      let requestIndex = 0
      let journal = Promise.resolve()
      // New listings — a product Shopify does not hold yet is created with the main row's Status (ACTIVE, or a Draft).
      const sent = await synchronizeContent(productId, contentScope, { expectedRevision: revision, expectedRemoteRevision: plan.prepared.remoteRevision,
        locationId: input.locationId, confirmActive: true, ...(plan.creates.createStatus ? { createStatus: plan.creates.createStatus } : {}) }, request => {
          const index = requestIndex++
          // The publisher may start independent mutations together. Their durable ordinals remain ordered.
          journal = journal.then(async () => {
            if (index === 0) await ensureDrafts()
            await recordPublicationRequests(context, shopify.products.map(p => ({ ...p, request })), index)
            providerStarted = true
          })
          return journal
        })
      result = { id, status: 'VERIFIED', message: `Shopify verified the saved product and variants. Visibility: ${plan.review.visibility}.`, results: shopify.products.map(r => ({ sku: r.sku, status: 'VERIFIED', message: 'Verified by Shopify', reference: sent.productId })) }
      receipt = result
    } else if (plan.prepared.kind === 'etsy') {
      const etsy = plan.prepared as EtsyCompiled
      // Each call is journalled (with the change fields it writes) just before it is sent.
      const journal = (index: number, request: EtsyJournalRequest) =>
        recordPublicationRequests(context, etsy.products.map(p => ({ ...p, request: { ...request, intentVersion: 1,
          writes: (etsy.fieldWrites[p.productId] ?? []).filter(write => request.fields.includes(write.field)) } })), index)
      if (etsy.listingId) {
        // E2 — a listing Etsy holds: one call per step, each journalled just before it is sent, then read back.
        let index = 0
        const sent = await sendEtsyPublication(etsy, scope.accountId, id, async request => {
          const at = index++
          if (at === 0) await ensureDrafts()
          await journal(at, request)
          providerStarted = true
        })
        result = etsyPublicationResult(id, etsy, sent)
      } else {
        // E3 — a new Etsy listing, created as a draft: the drafts and the "creating" marker first (a second create of this
        // listing is refused while it is open), then the POST (never repeated), the listing id stored on every delivered
        // row as soon as Etsy answers, then the inventory, properties and translations, then the read-back.
        const where = { marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: plan.facts.destination.aliasKey ?? '', ownerProductId: etsy.ownerProductId }
        let index = 0
        const sent = await sendEtsyCreate(etsy, scope.accountId, id, {
          claim: async marker => { await ensureDrafts(); await claimEtsyCreate(where, { ...marker, userId }) },
          beforeSend: async request => {
            await journal(index++, request)
            providerStarted = true
          },
          landed: async listingId => { await storeEtsyCreatedListing(where, { reviewId: id, productIds: data.delivery.productIds, listingId }) },
          unknown: (message, listingId) => markEtsyCreateUnknown(where, id, message, listingId),
          release: () => releaseEtsyCreate(where, id),
        })
        result = etsyCreateResult(id, etsy, sent)
      }
      receipt = result
    } else {
      // Creation stores a correctly attributed draft. Only provider results can establish publication.
      await ensureDrafts()
      providerStarted = true
      if (plan.prepared.kind === 'amazon') {
        // Amazon sheet gaps — a reviewed fulfilment root goes with the stock job's quantity now; the journal keeps the offer sent.
        const amazon = await withSendQuantities(plan.prepared, { marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: plan.facts.destination.aliasKey ?? '' })
        const reference = await sendAmazonPublication(amazon, scope.accountId, request => recordPublicationRequests(context, request.feed.messages.map(message => {
          const products = amazon.products.filter(product => product.sku === message.sku)
          if (products.length !== 1) throw new Error(`The exact product for Amazon seller SKU ${message.sku} could not be recorded.`)
          const offer = amazon.offers?.[products[0].productId]
          return { productId: products[0].productId, sku: message.sku, request: { feedType: request.feedType, marketplaceIds: request.marketplaceIds, header: request.feed.header, message,
            intentVersion: 1, writes: amazon.fieldWrites?.[products[0].productId] ?? [], ...(offer ? { offer } : {}) } }
        })))
        result = { id, status: 'SUBMITTED', message: `Submitted to Amazon. Feed ${reference} is awaiting processing; the listing is not yet confirmed live.`,
          results: plan.prepared.feed.messages.map(message => ({ sku: message.sku, status: 'SUBMITTED', reference, message: 'Awaiting Amazon processing' })) }
        await checkpoint(result)
      } else if (plan.prepared.kind === 'ebay-inventory-send') {
        // PE P3.4 — one whole-group PUT built from the fresh live group; journal first, read back after. No offer is touched.
        const inventory = plan.prepared
        const receipt = await sendEbayInventoryGroup({ destination: inventory.destination, groupKey: inventory.groupKey, group: inventory.group, items: inventory.items,
          expectedRevision: inventory.expectedRevision, fields: inventory.fields, reads: ebayInventoryReads(scope.accountId, scope.marketplace, inventory.destination.itemId),
          beforeSend: request => recordPublicationRequests(context, inventory.products.map(p => ({ ...p, request: { ...request, intentVersion: 1, writes: inventory.fieldWrites[p.productId] ?? [] } }))) })
        result = { id, status: receipt.verified ? 'VERIFIED' : 'UNVERIFIED', warnings: receipt.warnings,
          message: receipt.verified ? 'eBay applied the change to this Inventory listing, and the read-back matches.'
            : 'eBay accepted the change, but the read-back did not confirm every field. Check the listing before publishing again.',
          results: inventory.products.map(row => ({ sku: row.sku, status: receipt.verified ? 'VERIFIED' : 'ACCEPTED', reference: receipt.reference,
            message: receipt.verified ? 'Read back from eBay' : 'Accepted by eBay; the read-back differs' })) }
        await checkpoint(result)
      } else {
        const ebay = plan.prepared as EbayPublication
        const sent = await sendEbayPublication(ebay, scope.accountId, id,
          request => recordPublicationRequests(context, ebay.products.map(p => ({ ...p, request: { ...request, intentVersion: 1, writes: ebay.fieldWrites?.[p.productId] ?? [] } }))))
        result = { id, status: 'UNVERIFIED', warnings: sent.warnings,
          message: `eBay acknowledged item ${sent.reference}. Its active listing status still needs checking.`,
          results: ebay.products.map(row => ({ sku: row.sku, status: 'ACCEPTED', reference: sent.reference, message: 'Acknowledged by eBay' })) }
        await checkpoint(result)
        result = await reconcileEbayReceipt(data, result, userId)
      }
    }
  } catch (error) {
    const refused = !providerStarted || (error as { notSent?: boolean })?.notSent === true
    const text = error instanceof Error ? error.message : String(error)
    result = receipt ? { ...receipt, status: receipt.status === 'SUBMITTED' ? 'SUBMITTED' : 'UNVERIFIED',
      message: `${receipt.message} Confirmation could not finish: ${text}` }
      // Delete and relist (S3) — Amazon's validation refusal of a relist, in plain words beside Amazon's own.
      : { id, status: refused ? 'FAILED' : 'UNVERIFIED', message: `${refused ? 'Nothing was submitted.' : 'Publication could not be verified. Check the channel before retrying:'} ${refused ? explainAmazonRelist(data, null, [], text) : text}`, results: [] }
  }
  return { result, receipt }
}

/** Store the delivered result once (the settle core's compare-and-set) and return what the caller should show. */
export async function finishPublication(claim: ClaimedPublication, delivered: DeliveredPublication): Promise<StudioPublishResult> {
  const { productId, id, userId, data } = claim
  const { result, receipt } = delivered
  try {
    const stored = await storeResult(id, data, userId, result, IN_FLIGHT)
    // A status read may already have recorded a terminal processing report.
    return stored.count ? result : await studioPublicationResult(productId, id, userId)
  } catch (error) {
    if (!receipt) throw error
    // A database outage cannot erase the acknowledgement already returned by the channel.
    // Keep its reference visible without claiming that Nexus recorded the result durably.
    return { ...receipt, status: 'UNVERIFIED', message: `The channel returned a receipt, but Nexus could not record the final result. Keep this reference and check publication status before retrying: ${receipt.results.map(row => row.reference).filter((reference, index, all) => reference && all.indexOf(reference) === index).join(', ')}.` }
  }
}

export async function submitStudioPublication(productId: string, id: string, body: unknown, userId: string | null, options: ClaimOptions = {}): Promise<StudioPublishResult> {
  const claimed = await claimPublication(productId, id, body, userId, options)
  if ('result' in claimed) return claimed.result
  return finishPublication(claimed.claim, await deliverPublication(claimed.claim))
}
