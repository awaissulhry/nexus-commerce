/**
 * E5a (Etsy publisher, 2026-10-05) — what Etsy HOLDS for one listing, against what Nexus WOULD SEND, for the 4-hourly
 * sweep (`jobs/etsy-content-refresh.job.ts` → `etsy-content-pass.ts`). The result feeds the ONE drift writer
 * (`channel-drift.service.ts`) as source `etsy-content`.
 *
 * Pure. The comparison is the publish review's own (`prepareEtsyChanges` with an empty baseline, whose statuses are then
 * exactly SAME / DIFFERS / CANNOT_COMPARE), so "differs on Etsy" here is the review's "Differs on channel" — one rule,
 * never a second opinion of it. A field the review cannot compare is one of two kinds:
 *   · settled on Nexus's side — empty in Nexus (Etsy keeps its value, nothing would be sent), or photos of a family not on
 *     the media plan: the review can never show a difference there, whatever Etsy holds, so the field is recorded as
 *     COMPARED with no difference (an older difference of it clears);
 *   · unread on Etsy's side — translations, images or attributes Etsy did not return, production partners Etsy never
 *     reports: NOT COMPARED with the reason, never clean and never drift (an older difference is kept, with its own time).
 * A listing the live review would refuse to build at all is not compared (`etsyLiveRefusal`).
 *
 * "Theirs" is the sweep's own `getListingsByShop` row (with `includes=Inventory,Images,Translations`), the shop and the
 * listing's properties, put in the shape the live reader takes (`etsyPageRaw`) and normalised by it
 * (`normaliseEtsyListing`, live-read/etsy.ts), so a sweep and a review read the same Etsy state the same way.
 *
 * Photos are compared by COUNT only (Q4): Nexus's Etsy gallery from the media plan against the images Etsy returned.
 * Which Nexus photo each Etsy image is comes with E4; until then the images are kept as the channel's side of a difference.
 */
import type { DriftField } from '../channel-drift.service.js'
import type { EtsyLiveRaw } from '../live-read/etsy.js'
import { NO_LISTING_PRICE_FACTS, currencyCode, listingSendPrice } from '../pim/follower-price.js'
import { etsyFitReadiness, etsyKeptRules, etsyNewRowChecks, etsyOwnRules } from '../pim/studio-publication-etsy-build.js'
import { ETSY_EMPTY_KEPT, prepareEtsyChanges } from '../pim/studio-publication-etsy-changes.js'
import { EtsyPublicationProblems, etsyProblems } from '../pim/studio-publication-etsy-problems.js'
import type { EtsyLiveListing, EtsyPublication } from '../pim/studio-publication-etsy-types.js'
import type { PublicationFacts } from '../pim/studio-publication-plan.js'
import type { Comparison } from './amazon-content-compare.js'

// ── E5 §2 — shared constants and types (E5a-B2 imports them) ──────────────────────────────────────────────────────
export const ETSY_CONTENT_SOURCE = 'etsy-content'
/** States whose listings are compared; expired/removed listings ended on Etsy (recorded not compared). */
export const ETSY_COMPARED_STATES: ReadonlySet<string> = new Set(['active', 'sold_out', 'inactive', 'draft'])
/** Added to the sweep's existing getListingsByShop pages: no extra call (R1 §14). Comma form BELIEVED (LR:7). */
export const ETSY_PAGE_INCLUDES = 'Inventory,Images,Translations'
/** Photos are compared by COUNT only until E4 records which Nexus photo each Etsy image is (Q4). */
export const PHOTO_COUNT_FIELD = 'photo_count'
export interface EtsyLiveImage { listing_image_id: string; rank: number; url: string | null }
export interface EtsyContentTally { listings: number; compared: number; drifted: number; notCompared: number
  reasons: Record<string, number>; extraCalls: number; errors: number }
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ETSY_PROPERTIES_UNREAD = 'Etsy attributes were not read in this sweep.'
export const ETSY_IMAGES_UNREAD = 'Etsy did not return this listing\'s images.'
/** Nexus's side, settled: a family not on the media plan has no Etsy photo list (etsy-content-ours.ts reports it). */
export const ETSY_NOT_ON_MEDIA_PLAN = 'this family is not on the media plan, so Nexus has no Etsy photo list to count'
/** Etsy's own maximum (R1 §7): more is never a listing's gallery. */
const MAX_IMAGES = 20

type Json = Record<string, unknown>
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** A language by its primary subtag, lower case: "en-US" and "EN" are "en" (the review's own rule, studio-publication-etsy.ts:56). */
const language = (code: string | null | undefined) => (code ?? '').trim().toLowerCase().split(/[-_]/)[0]
/** A builder sentence that starts with the SKU (studio-publication-etsy.ts:54). */
const stripSku = (text: string, sku: string) => text.startsWith(`${sku}: `) ? text.slice(sku.length + 2) : text

/**
 * One `getListingsByShop` row (with its includes) as the live reader's raw answers. The row is the listing without its
 * embedded `inventory` and `images` (its `translations` stay: the reader takes them from the listing). An inventory is
 * read only when it is an object with a `products` list (the argument — the batch read — first, else the row's own);
 * otherwise `inventoryRead` is false and the caller must not compare. Properties are `{ results: [] }` when not read
 * (`propertiesRead` false: the comparison then leaves every attribute uncompared). Translations missing from the row are
 * "not read" (null in the normalised listing), never "none".
 */
export function etsyPageRaw(row: Record<string, unknown>, shop: Record<string, unknown>, properties: Record<string, unknown> | null,
  inventory?: Record<string, unknown>): { raw: EtsyLiveRaw; inventoryRead: boolean; propertiesRead: boolean } {
  const { inventory: embedded, images: _images, ...listing } = row
  const readable = (v: unknown): v is Json => isObj(v) && Array.isArray(v.products)
  const held = readable(inventory) ? inventory : readable(embedded) ? embedded : null
  return {
    raw: { listing, inventory: held ?? {}, properties: properties ?? { results: [] }, shop, translationsRead: Array.isArray(row.translations) },
    inventoryRead: held !== null,
    propertiesRead: properties !== null,
  }
}

/**
 * The images Etsy returned on the row, in Etsy's order (`rank`), at most 20; null when the row carries no image list
 * (Images was not returned — unknown, never "no photos"). An image whose id is not an Etsy id is skipped; one without a
 * numeric rank keeps its place in the list.
 */
export function etsyLiveImages(row: Record<string, unknown>): EtsyLiveImage[] | null {
  if (!Array.isArray(row.images)) return null
  const url = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null
  return row.images.map(obj).flatMap((image, index) => {
    const id = String(image.listing_image_id ?? '')
    if (!/^[1-9]\d*$/.test(id)) return []
    const rank = typeof image.rank === 'number' && Number.isFinite(image.rank) ? image.rank : index + 1
    return [{ listing_image_id: id, rank, url: url(image.url_570xN) ?? url(image.url_fullxfull) }]
  }).map((image, index) => ({ image, index }))
    .sort((a, b) => a.image.rank - b.image.rank || a.index - b.index)
    .map(({ image }) => image)
    .slice(0, MAX_IMAGES)
}

/**
 * The publication as the review holds it once Etsy was read — the review's live-only steps, repeated here so drift does
 * not depend on the publish switch (with sending off, `prepareEtsyPublication` reads nothing and skips them). Pinned
 * against a live-mode `prepareEtsyPublication` by etsy-content-compare.vitest.test.ts; a change to one of these steps
 * there must change this function too.
 *   · studio-publication-etsy.ts:205-210 — translations only for the languages the shop offers (by primary subtag; a
 *     shop that lists none keeps every one);
 *   · studio-publication-etsy.ts:249-252 — a variation whose processing profile is empty in Nexus keeps Etsy's;
 *   · studio-publication-etsy.ts:263-268 — the listing keeps Etsy's own `*_on_property` rules (Nexus's own when Etsy has
 *     no variation property, or when a rule cannot be kept — the change plan then refuses the variations line), and
 *     processing profiles that differ inside a group Etsy keeps as one widen that one rule (`etsyFitReadiness`).
 * The live steps that THROW (the language, a variation Etsy no longer holds, the shop's currency) are `etsyLiveRefusal`.
 * Not repeated: the order-import refusal of a send that adds stock (studio-publication-etsy.ts:220-235, a database
 * read). It changes whether the variations line can be SENT, never its SAME / DIFFERS (the pin test shows it).
 * The publication is not changed: the structure is copied.
 */
export function withEtsyLive(publication: EtsyPublication, live: EtsyLiveListing): EtsyPublication {
  const { liveSkipped: _skipped, liveReadError: _error, ...rest } = publication
  const offered = new Set(live.shop.languages.map(language))
  const translations = live.shop.languages.length
    ? publication.translations.filter(translation => offered.has(language(translation.language))) : publication.translations
  const structure = { ...publication.structure, properties: publication.structure.properties.map(property => ({ ...property })),
    products: publication.structure.products.map(product => ({ ...product, values: product.values.map(value => ({ ...value, values: [...value.values] })) })) }
  for (const product of structure.products) if (product.readiness_state_id === null) {
    const held = live.offerings[product.sku]?.readiness_state_id ?? live.inventory.products.find(entry => entry.sku === product.sku)?.readiness_state_id ?? null
    if (held !== null) product.readiness_state_id = held
  }
  const nexusIds = structure.properties.map(property => property.property_id)
  const own = etsyOwnRules(nexusIds, structure.products.map(product => product.readiness_state_id))
  const kept = etsyKeptRules(live.inventory, live.inventory.properties.map(property => property.property_id), nexusIds, own)
  Object.assign(structure, 'rules' in kept
    ? etsyFitReadiness(kept.rules, structure.products.map(product => ({ values: product.values, readiness: product.readiness_state_id })), nexusIds).rules : own)
  return { ...rest, translations, structure, live, liveRevision: live.revision }
}

/**
 * Why the live review would refuse to build this listing at all (`problems.throwIfAny()`, studio-publication-etsy.ts:252),
 * in its own words — or null. The review's live checks that can refuse, in its order and with its own functions:
 *   · :202-204 — the shop's main language is not Nexus's first Etsy language;
 *   · :213-218 — a variation Nexus records on the listing whose SKU Etsy no longer holds is sent as a new one, so its price
 *     is judged like a create's (`listingSendPrice`, as :123, then `etsyNewRowChecks`);
 *   · :219 with :179-184 — then the shop's currency must be the one Nexus holds Etsy prices in.
 * A refused review has no change lines, so drift shows no difference the review would not show.
 */
export function etsyLiveRefusal(facts: PublicationFacts, publication: EtsyPublication, live: EtsyLiveListing): string | null {
  const problems = etsyProblems()
  const shopLanguage = live.shop.languages[0], ours = facts.languages[0]
  if (shopLanguage && ours && language(shopLanguage) !== language(ours))
    problems.add(`This Etsy shop's main language is ${shopLanguage}, but Nexus's first language for Etsy is ${ours}. Put ${shopLanguage} first in the Etsy market's languages.`)
  const marketCurrency = currencyCode(facts.destination.currency)
  const rows = publication.inventoryProducts.map(row => {
    const listing = facts.listings.find(entry => entry.productId === row.productId)
    return { ...row, listing, product: facts.products.find(product => product.id === row.productId), onEtsy: !!listing?.externalListingId }
  })
  const unheld = rows.filter(row => row.onEtsy && !live.offerings[row.sku])
  for (const row of unheld) {
    const sheetSku = row.product?.sku ?? row.sku
    const send = listingSendPrice(row.listing ?? NO_LISTING_PRICE_FACTS, { masterPrice: row.product?.basePrice, marketCurrency, where: 'Etsy' })
    etsyNewRowChecks({ productId: row.productId, sku: row.sku, sheetSku, cells: {}, price: send.price, quantity: 0, axisValues: {}, onEtsy: true,
      ...(send.price === null ? { priceReason: stripSku(send.reason, sheetSku) } : {}) }, problems)
  }
  if (unheld.length && rows.every(row => row.onEtsy)) {
    const extra = obj(obj(facts.account?.identity).extra)
    const shop = currencyCode(extra.currencyCode) ?? currencyCode(live.shop.currencyCode)
    if (!shop) problems.add('Nexus does not know this Etsy shop\'s currency. Reconnect the Etsy account, then review again.')
    else if (!marketCurrency) problems.add(`This Etsy shop sells in ${shop}, and the Etsy market has no currency in Nexus. Set the Etsy market's currency to ${shop}.`)
    else if (shop !== marketCurrency) problems.add(`This Etsy shop sells in ${shop} and Nexus holds Etsy prices in ${marketCurrency}. A price is never converted: set the Etsy market's currency to ${shop}.`)
  }
  if (!problems.issues.length) return null
  return `the Etsy review refused: ${new EtsyPublicationProblems([...problems.issues]).message.replace(/\n/g, ' ')}`
}

/** Why a change the review could not compare was not compared: its unknown side's own reason, not a send refusal. */
function notComparedReason(change: { current: { state: string; reason?: string }; channel: { state: string; reason?: string }; reason: string }): string {
  if (change.current.state === 'unknown' && change.current.reason) return change.current.reason
  if (change.channel.state === 'unknown' && change.channel.reason) return change.channel.reason
  return change.reason
}

/**
 * One listing's comparison. Every change line of the review is compared (SAME or DIFFERS, or settled on Nexus's side)
 * or not compared with its reason; attributes are not compared when this sweep did not read them. A review that cannot be
 * built against this read (`etsyLiveRefusal`), or a change plan that throws, leaves the whole listing not compared,
 * photos included.
 */
export function compareEtsyContent(facts: PublicationFacts, publication: EtsyPublication, live: EtsyLiveListing,
  options: { propertiesRead: boolean; photos: { nexus: number | null; reason?: string; etsy: EtsyLiveImage[] | null } }): Comparison {
  const whole = (reason: string): Comparison => ({ compared: [], differing: [], notCompared: [{ field: 'listing', reason }] })
  const refusal = etsyLiveRefusal(facts, publication, live)
  if (refusal) return whole(refusal)
  let changes: ReturnType<typeof prepareEtsyChanges>['changes']
  try {
    changes = prepareEtsyChanges(facts, withEtsyLive(publication, live), new Map()).changes
  } catch (error) {
    return whole(`the Etsy review could not compare: ${message(error)}`)
  }

  const out: Comparison = { compared: [], differing: [], notCompared: [] }
  for (const change of changes) {
    if (change.field.startsWith('property:') && !options.propertiesRead) { out.notCompared.push({ field: change.field, reason: ETSY_PROPERTIES_UNREAD }); continue }
    if (change.status === 'SAME') { out.compared.push(change.field); continue }
    if (change.status === 'DIFFERS') {
      out.compared.push(change.field)
      const differing: DriftField = { field: change.field, ours: change.current.state === 'value' ? change.current.value : null,
        theirs: change.channel.state === 'value' ? change.channel.value : null }
      out.differing.push(differing)
      continue
    }
    // Empty in Nexus: Etsy keeps its value and the review never shows a difference — settled, whatever Etsy holds.
    if (change.current.state === 'unknown' && change.current.reason === ETSY_EMPTY_KEPT) { out.compared.push(change.field); continue }
    out.notCompared.push({ field: change.field, reason: notComparedReason(change) })
  }

  const { nexus, reason, etsy } = options.photos
  if (nexus === null && reason === ETSY_NOT_ON_MEDIA_PLAN) out.compared.push(PHOTO_COUNT_FIELD)
  else if (nexus === null) out.notCompared.push({ field: PHOTO_COUNT_FIELD, reason: reason ?? 'Nexus has no Etsy photo list to count.' })
  else if (etsy === null) out.notCompared.push({ field: PHOTO_COUNT_FIELD, reason: ETSY_IMAGES_UNREAD })
  else {
    out.compared.push(PHOTO_COUNT_FIELD)
    if (nexus !== etsy.length) out.differing.push({ field: PHOTO_COUNT_FIELD, ours: { count: nexus }, theirs: { count: etsy.length, images: etsy } })
  }
  return out
}
