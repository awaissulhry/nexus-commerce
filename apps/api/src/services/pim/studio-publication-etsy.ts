/**
 * E1 (Etsy publisher, 2026-10-05) — what Studio Publish would send to Etsy for one listing, and every problem with it.
 * E1 sends nothing: this builds the listing (`studio-publication-etsy-build.ts`), checks it, and reads the live Etsy
 * listing when there is one and sending to Etsy is live, so the review can compare field by field
 * (`studio-publication-etsy-changes.ts`).
 *
 * Mirrors the eBay publisher (`prepareEbayPublication`): one listing per selection, no product of it held by another
 * selection, every problem named at once by SKU and column label. One difference on purpose (lead amendment A1): the
 * review is built in every mode, so the change plan and the exact request show even while sending is off; only the
 * live READ waits for live mode (eBay's rule, audit P9: Nexus reads a channel only when it really sends to it).
 *
 * E2 — a listing Etsy already holds is sent (`studio-publication-etsy-send.ts`), so the review also says what that send
 * would do on Etsy: a new variation carries Nexus's stock, which needs Etsy order import (Owner 2026-10-01), a category
 * change can make Etsy drop attributes, and automatic renewal turned on costs a fee on each renewal.
 */
import { ETSY_VARIATION_HIDDEN_REASON } from '@nexus/shared/listing-actions'
import prisma from '../../db.js'
import { getEtsyPublishMode } from '../etsy-publish-gate.service.js'
import { etsyStockWriteRefusal } from '../etsy/order-ingest-switch.js'
import { liveChannelSku, wantedChannelSku } from '../listings/channel-sku.pure.js'
import { loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
import { NO_LISTING_PRICE_FACTS, currencyCode, listingSendPrice } from './follower-price.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import { channelAxisValues, loadStoredVariationProjection } from './stored-variation-projection.js'
import { variationCollisionGroups } from './variation-collisions.js'
import { resolveVariationProjection, variationReadinessItems } from './variation-rules.service.js'
import { andList, buildEtsyListing, etsyAxisValues, etsyFitReadiness, etsyKeptRules, etsyNewRowChecks, etsyOwnRules, etsySameRule, etsyVariationsNexusLacks, ETSY_AUTO_RENEW_NOTE,
  ETSY_NEEDS_READINESS, type EtsyBuildAxis, type EtsyBuildRow } from './studio-publication-etsy-build.js'
import { etsyProblems, stripNothingSent } from './studio-publication-etsy-problems.js'
import type { EtsyCreateState, EtsyLiveListing, EtsyLiveReader, EtsyPublication, ProductIdentity } from './studio-publication-etsy-types.js'

export interface PrepareEtsyOptions {
  /** How a NEW listing starts (the main row's Status: Inactive = an Etsy draft). Default: draft. */
  createState?: EtsyCreateState | null
  /** The live read (B2's `readEtsyLive`); called only in live mode, for a listing that exists. */
  readLive: EtsyLiveReader
  /**
   * The rows created Inactive (the eBay publisher's option, same name and meaning). On Etsy only a variation new on a
   * listing already on Etsy can be: it is sent switched off (`is_enabled: false`). A new listing is a draft as a whole.
   */
  inactiveProductIds?: ReadonlySet<string>
}

/** Why an existing listing's changes cannot be compared while sending is off (A1): every one of them is refused with it. */
export const ETSY_LIVE_SKIPPED = 'The review reads the live Etsy listing only when sending to Etsy is on.'
export const ETSY_PHOTOS_LATER = 'Photos are not sent to Etsy yet; they come in a later Nexus update.'
export const ETSY_NO_SHIPPING_PROFILE = 'Shipping profile is not set. Etsy needs one before the listing can go live.'
/** E2 — a listing that exists, whose Etsy category Publish would change (R1 §4: properties belong to a category). */
export const ETSY_CATEGORY_CHANGE = 'Changing the Etsy category can make Etsy drop attributes and variation properties the new category does not have. Check the listing on Etsy after the publish.'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const textOf = (error: unknown) => error instanceof Error ? error.message : String(error)
/** A builder sentence that starts with the SKU; the review shows the SKU in its own column. */
const stripSku = (message: string, sku: string) => message.startsWith(`${sku}: `) ? message.slice(sku.length + 2) : message
/** A language by its primary subtag, lower case: "en-US" and "EN" are "en". */
const language = (code: string | null | undefined) => (code ?? '').trim().toLowerCase().split(/[-_]/)[0]

export async function prepareEtsyPublication(facts: PublicationFacts, options: PrepareEtsyOptions): Promise<EtsyPublication> {
  const { scope, parent, products, listings } = facts
  const aliasKey = facts.destination.aliasKey ?? ''
  // 1 — one Etsy listing, and no product outside this selection on it (a send replaces the listing's whole inventory).
  const listingIds = [...new Set(listings.map(listing => listing.externalListingId).filter((id): id is string => !!id))]
  if (listingIds.length > 1) throw new Error('These products belong to different Etsy listings. Choose one listing alias before publishing.')
  const listingId = listingIds[0] ?? null
  if (listingId) {
    const other = await prisma.channelListing.findFirst({ where: { channel: 'ETSY', channelConnectionId: scope.accountId, externalListingId: listingId,
      OR: [{ productId: { notIn: products.map(product => product.id) } }, { aliasKey: { not: aliasKey } }] }, select: { id: true } })
    if (other) throw new Error('This Etsy listing is also used by products outside this selection. Review its complete shared listing before publishing.')
  }
  // 2 — the main row owns the listing; the Etsy products are a family's variations, or the single product.
  const cellsOf = (productId: string, locale = 0) => facts.resolved[locale]?.products.find(row => row.productId === productId)?.cells
  if (!products.some(product => product.id === parent.id)) {
    // The main row is not in this publication: say why, never "could not be read". A skipped main row carries the
    // whole listing's reason (another row's, when a variation is ended or discontinued), so only its OWN reason is
    // named (the facts' one row rule, loaded on this path only); the facts already list every row's.
    const skip = (facts.skipped ?? []).find(entry => entry.productId === parent.id)
    if (!skip) throw new Error('This Etsy listing is not reviewed: its main row is not included here (excluded, or Not listed).')
    const { existingRowRule } = await import('./studio-publication-plan.js')
    const own = existingRowRule(listings.find(listing => listing.productId === parent.id))
    throw new Error(`This Etsy listing is not reviewed: its main row ${skip.sku} is skipped.${own ? ` ${own}` : ''}`)
  }
  if (!cellsOf(parent.id)) throw new Error('No row of this Etsy listing could be read. Refresh the product, then review again.')
  const family = products.length > 1 || parent.isParent
  const variants = family ? products.filter(product => product.id !== parent.id) : [parent]
  if (!variants.length) throw new Error('This Etsy listing has no variation to send. Include a variation of this family first.')
  const problems = etsyProblems()
  const listingOf = (productId: string) => listings.find(listing => listing.productId === productId)

  // 3 — the SKU each row sends (the rule the review's SKU moves read, studio-publication.service.ts `skuMoveRows`): a row
  // on Etsy sends the SKU Etsy holds; a draft or a row not on Etsy yet sends its wanted SKU; no listing, the product SKU.
  const skus = new Map<string, string>()
  for (const product of products) {
    const listing = listingOf(product.id)
    const at = { productId: product.id, sku: product.sku, field: 'sku' }
    const row = listing ? { ...listing, channel: 'ETSY' } : null
    // `liveChannelSku` is null only for a still-draft, which has no Etsy id: the `??` covers the type, not a case.
    const answer = !row ? (product.sku?.trim() ? { sku: product.sku.trim() } : null)
      : (row.externalListingId ? liveChannelSku(row, product.sku) : null) ?? wantedChannelSku(row, product.sku)
    if (!answer?.sku) {
      const conflict = answer && 'conflict' in answer ? answer.conflict : undefined
      problems.add(!conflict || conflict.code === 'NO_SKU' ? 'Seller SKU is empty. Set this row\'s SKU.' : stripNothingSent(stripSku(conflict.sentence, product.sku)), at)
      continue
    }
    skus.set(product.id, answer.sku)
  }
  const holders = new Map<string, string>()
  for (const product of variants) {
    const sku = skus.get(product.id)
    if (!sku) continue
    if (holders.has(sku)) problems.add(`${sku} is the SKU of more than one row; each Etsy variation needs its own.`, { productId: product.id, sku: product.sku, field: 'sku' })
    else holders.set(sku, product.id)
  }

  // 4 — each Etsy product's price and stock. Only a row NOT on Etsy is judged on them (a create, or a new variation of a
  // live listing): a live row's price and stock go through the existing price and stock pushes (D3).
  const ledgers = await loadSyncLedgers(prisma, variants.map(product => product.id))
  const marketCurrency = currencyCode(facts.destination.currency)
  const rows: EtsyBuildRow[] = []
  for (const product of variants) {
    const cells = cellsOf(product.id)
    if (!cells) { problems.add('Nexus could not read this row. Refresh the product, then review again.', { productId: product.id, sku: product.sku }); continue }
    const listing = listingOf(product.id)
    const send = listingSendPrice(listing ?? NO_LISTING_PRICE_FACTS, { masterPrice: product.basePrice, marketCurrency, where: 'Etsy' })
    // Stock as the eBay publisher computes it: the pool a pooled product sells from, else its own count or the listing's
    // fixed number, never above what is available after the listing's buffer.
    const ledger = ledgers.get(product.id)
    const tracked = !!ledger && (ledger.ledger.length > 0 || ledger.uncountedIsZero)
    const following = listing?.followMasterQuantity !== false
    const requested = following && ledger?.source.kind === 'pool' ? ledger.quantity
      : Number(cells.quantity?.value ?? (!following ? listing!.quantityOverride ?? listing!.quantity : product.totalStock))
    const available = Math.max(0, (tracked ? ledger!.available : product.totalStock) - (listing?.stockBuffer ?? 0))
    const quantity = Number.isFinite(requested) ? Math.min(Math.max(0, Math.trunc(requested)), available) : 0
    const onEtsy = !!listing?.externalListingId
    // M2 — Inactive is honoured only for a variation new on a listing already on Etsy (a new listing is a draft as a whole).
    // E2 review m7 — so is a row Nexus holds hidden on Etsy (`ETSY_VARIATION_HIDDEN_REASON`): should Etsy no longer hold
    // it, Publish adds it back hidden, never for sale while Nexus holds its stock pushes.
    const hidden = onEtsy && !!listing?.offerClosedAt && listing.offerCloseReason === ETSY_VARIATION_HIDDEN_REASON
    const inactive = !!listingId && (hidden || !!options.inactiveProductIds?.has(product.id))
    rows.push({ productId: product.id, sku: skus.get(product.id) ?? product.sku, sheetSku: product.sku, cells, price: send.price,
      ...(send.price === null ? { priceReason: stripSku(send.reason, product.sku) } : {}), quantity, axisValues: {}, onEtsy, ...(inactive ? { inactive } : {}) })
  }

  // 5 — the variation properties (a family only), from the listing's variation projection with the channel's own values.
  let axes: EtsyBuildAxis[] = [], structureNamed = false
  if (family) {
    const fields = facts.resolved[0]?.catalogue?.fields ?? []
    const { input, cell } = await loadStoredVariationProjection({ productId: parent.id, channel: 'ETSY', market: scope.marketplace, accountId: scope.accountId, aliasKey })
    input.family.variants = input.family.variants?.map(variant => {
      const cells = cellsOf(variant.id) ?? {}
      return { ...variant, included: variants.some(product => product.id === variant.id),
        axisValues: etsyAxisValues(channelAxisValues(variant.axisValues, cell.axes, cells, fields), cell.axes, cells) }
    })
    const projection = resolveVariationProjection(input)
    const included = projection.axes.filter(axis => axis.included)
    const structure = variationReadinessItems(projection, `ETSY ${scope.marketplace}`).filter(item => item.severity === 'error')
    for (const item of structure) {
      // Etsy takes two properties: when a third left out makes two variations alike, say which (E13).
      const pair = item.kind === 'collision' && projection.dropped.length
        ? variationCollisionGroups(included.map(axis => axis.familyKey), input.family.variants ?? [])[0]?.members : undefined
      if (pair && pair.length > 1) {
        const dropped = projection.axes.filter(axis => !axis.included).map(axis => axis.label)
        problems.add(`Etsy takes at most 2 variation properties; ${andList(dropped)} left out makes ${pair[0].sku} and ${pair[1].sku} the same variation.`, { field: 'variationTheme' })
      } else problems.add(item.message, { field: 'variationTheme' })
    }
    structureNamed = structure.some(item => item.kind === 'value-missing' || item.kind === 'collision')
    axes = included.map(axis => ({ familyKey: axis.familyKey, label: axis.label, channelName: axis.channelName, target: axis.target, custom: !!axis.own?.custom }))
    for (const row of rows) row.axisValues = input.family.variants?.find(variant => variant.id === row.productId)?.axisValues ?? {}
  }

  // 6 — build it all with one collector, then the checks that need the account or the market.
  // A single product is its own main row (its cells were read above, so it is `rows[0]`).
  const owner: EtsyBuildRow = family
    ? { productId: parent.id, sku: skus.get(parent.id) ?? parent.sku, sheetSku: parent.sku, cells: cellsOf(parent.id)!, price: null, quantity: 0, axisValues: {} }
    : rows[0]
  const built = buildEtsyListing({ owner, rows, axes, fields: facts.resolved[0]?.catalogue?.fields ?? [], createState: options.createState ?? null, listingId, structureNamed,
    translations: facts.languages.slice(1).map((code, index) => ({ language: code, cells: cellsOf(parent.id, index + 1) ?? {} })) }, problems)
  // A price is never converted (Round 6): wherever Publish sends a price (a create, a new variation), the shop's currency
  // must be the one Nexus holds Etsy prices in. The live read's shop currency stands in when the account has none.
  const currencyCheck = (shopCurrency: string | null) => {
    const shop = currencyCode(record(record(facts.account.identity).extra).currencyCode) ?? currencyCode(shopCurrency)
    if (!shop) problems.add('Nexus does not know this Etsy shop\'s currency. Reconnect the Etsy account, then review again.')
    else if (!marketCurrency) problems.add(`This Etsy shop sells in ${shop}, and the Etsy market has no currency in Nexus. Set the Etsy market's currency to ${shop}.`)
    else if (shop !== marketCurrency) problems.add(`This Etsy shop sells in ${shop} and Nexus holds Etsy prices in ${marketCurrency}. A price is never converted: set the Etsy market's currency to ${shop}.`)
  }
  if (!listingId || rows.some(row => !row.onEtsy)) currencyCheck(null)
  problems.note(ETSY_PHOTOS_LATER)
  problems.throwIfAny()

  // 7–8 — the live listing, read only when sending to Etsy is live (A1: the review is built in every mode; without the
  // read every change of an existing listing is refused, and a new listing needs no read).
  let live: EtsyLiveListing | null = null, liveReadError: string | undefined, liveSkipped: string | undefined, newVariationStockRefusal: string | undefined
  if (listingId) {
    if (getEtsyPublishMode() !== 'live') liveSkipped = ETSY_LIVE_SKIPPED
    else {
      try { live = await options.readLive({ accountId: scope.accountId, listingId }) }
      catch (error) { liveReadError = textOf(error) }
    }
  }
  let translations = built.translations
  const structure = built.structure
  if (live) {
    const shopLanguage = live.shop.languages[0], ours = facts.languages[0]
    if (shopLanguage && ours && language(shopLanguage) !== language(ours))
      problems.add(`This Etsy shop's main language is ${shopLanguage}, but Nexus's first language for Etsy is ${ours}. Put ${shopLanguage} first in the Etsy market's languages.`)
    if (live.shop.languages.length) {
      const offered = new Set(live.shop.languages.map(language))
      for (const translation of translations) if (!offered.has(language(translation.language)))
        problems.note(`${translation.language}: this Etsy shop does not offer that language, so its translation is not sent.`)
      translations = translations.filter(translation => offered.has(language(translation.language)))
    }
    // m1 — a row Nexus records on the listing whose SKU Etsy does not hold is a NEW variation to Etsy: the send gives it
    // Nexus's price and stock, so they are judged like a create's (and its price's currency, below).
    const unheld = rows.filter(row => row.onEtsy && !live!.offerings[row.sku])
    for (const row of unheld) {
      // N5 — said before the variations line (ticked by default) puts it back on Etsy.
      problems.note(`Etsy no longer holds ${row.sku}; Publish adds it back as a new variation.`)
      etsyNewRowChecks(row, problems)
    }
    if (unheld.length && rows.every(row => row.onEtsy)) currencyCheck(live.shop.currencyCode)
    // E2 — a variation Etsy does not hold is sent with Nexus's stock, and a stock number sent while Etsy's own sales do
    // not reach Nexus puts back units Etsy already sold (Owner 2026-10-01, D3): its order import must be on and activated.
    // One sent hidden (Inactive, §10.6) cannot sell, so it needs neither; showing it later asks (listing actions). The
    // switch is asked only when there is such a variation; a failed read throws (the review fails, never "on").
    const adds = rows.filter(row => !live!.offerings[row.sku] && !row.inactive)
    // E2 review R2-n4 — so is a send that changes which variations share a stock number (Etsy's "every property" rule
    // mapped onto Nexus's other properties): the inventory writer counts it as stock, and the review says so first.
    const ids = structure.properties.map(property => property.property_id)
    const keptStock = etsyKeptRules(live.inventory, live.inventory.properties.map(property => property.property_id), ids, etsyOwnRules(ids, []))
    const stockRuleChanges = 'rules' in keptStock && !etsySameRule(keptStock.rules.quantity_on_property, live.inventory.quantity_on_property)
    if (adds.length || stockRuleChanges) {
      const refusal = await etsyStockWriteRefusal(scope.accountId)
      if (refusal) {
        newVariationStockRefusal = [...(adds.length ? [`${andList(adds.map(row => row.sheetSku ?? row.sku))}: new on Etsy, so Publish would send ${adds.length === 1 ? 'its' : 'their'} stock.`] : []),
          ...(stockRuleChanges ? ['Publish would change which variations share a stock number on Etsy, which counts as sending stock.'] : []), refusal.sentence].join(' ')
        problems.note(newVariationStockRefusal)
      }
    }
    // E2 — what this send would do on Etsy beyond the fields themselves.
    if (built.values.should_auto_renew === true && live.values.should_auto_renew !== true) problems.note(ETSY_AUTO_RENEW_NOTE)
    if (built.values.taxonomy_id !== null && built.values.taxonomy_id !== live.values.taxonomy_id) problems.note(ETSY_CATEGORY_CHANGE)
    // A send replaces Etsy's whole inventory: what Etsy holds and Nexus does not would be deleted. The `inventory` line is
    // refused with the same sentences (studio-publication-etsy-changes.ts).
    for (const sentence of etsyVariationsNexusLacks(live, structure)) problems.note(sentence)
    const otherCurrencies = live.priceCurrencies.filter(code => code !== marketCurrency)
    if (marketCurrency && otherCurrencies.length)
      problems.note(`Etsy prices this listing in ${andList(otherCurrencies)}; Nexus holds ${marketCurrency}. Prices of the variations already on Etsy go through the price push, which refuses a different currency; prices of new variations go with Publish.`)
    // A processing profile empty in Nexus keeps Etsy's for that SKU: a send never clears it by accident. A variation
    // still without one refuses the `inventory` line (M1, studio-publication-etsy-changes.ts).
    for (const product of structure.products) if (product.readiness_state_id === null) {
      const held = live.offerings[product.sku]?.readiness_state_id ?? live.inventory.products.find(entry => entry.sku === product.sku)?.readiness_state_id ?? null
      if (held !== null) product.readiness_state_id = held
    }
    problems.throwIfAny()
  } else if (listingId) {
    // Without the read nothing of the inventory is sent (every line is refused); a new variation without a processing
    // profile is said now, so it can be set before the review that sends.
    for (const row of rows) if (!row.onEtsy && structure.products.find(product => product.sku === row.sku)?.readiness_state_id === null)
      problems.note(ETSY_NEEDS_READINESS, { sku: row.sheetSku ?? row.sku })
  }
  // E2 review B1 — the listing's `*_on_property` rules, always stated (ids ascending, `[]` = one shared value), as the
  // live read states Etsy's: a listing that exists keeps Etsy's own (Nexus never changes them; a variation that would
  // break one is refused, studio-publication-etsy-changes.ts); a new listing, or one Etsy was not read for, Nexus's own.
  const nexusIds = structure.properties.map(property => property.property_id)
  const own = etsyOwnRules(nexusIds, structure.products.map(product => product.readiness_state_id))
  const keptRules = live ? etsyKeptRules(live.inventory, live.inventory.properties.map(property => property.property_id), nexusIds, own) : null
  // R2-n3 — processing profiles that differ widen that one rule (as the send does), never price, stock or SKU.
  Object.assign(structure, keptRules && 'rules' in keptRules
    ? etsyFitReadiness(keptRules.rules, structure.products.map(product => ({ values: product.values, readiness: product.readiness_state_id })), nexusIds).rules : own)
  // W4 — a new listing, or a live one whose shipping profile Etsy does not hold either.
  if (built.values.shipping_profile_id === null && (!listingId || (live && live.values.shipping_profile_id === null))) problems.note(ETSY_NO_SHIPPING_PROFILE)

  const identities: ProductIdentity[] = products.filter(product => skus.has(product.id)).map(product => ({ productId: product.id, sku: skus.get(product.id)! }))
  const notices = [...problems.notes]
  return {
    kind: 'etsy', marketplace: scope.marketplace, listingId, products: identities,
    inventoryProducts: rows.map(row => ({ productId: row.productId, sku: row.sku })), ownerProductId: parent.id,
    values: built.values, form: built.form, inventory: built.inventory, structure, properties: built.properties, translations,
    create: listingId ? null : built.create, live, liveRevision: live?.revision ?? null, currency: marketCurrency,
    ...(liveReadError ? { liveReadError } : {}), ...(liveSkipped ? { liveSkipped } : {}), ...(notices.length ? { notices } : {}),
    ...(newVariationStockRefusal ? { newVariationStockRefusal } : {}),
  }
}
