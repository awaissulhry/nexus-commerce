/**
 * Google Ads programme 2, G12 (2026-10-16) — a product's input in a supplemental data source Nexus made (pure): set it
 * (the whole input Nexus last wrote, with the attributes asked changed, added or taken out) or delete it. ONE product
 * input per change: the Merchant API takes one per call (productInputs.insert / .delete, products_v1), so a change of many
 * products is a change plan.
 *
 * A supplemental data source adds attributes to products a PRIMARY data source sends (here: Shopify's Google channel). It
 * reaches a product only when the product's primary data source links it in a rule; in the default rule, the source
 * listed first wins an attribute both send ("Attributes are taken from the first data source in the list that provides
 * them", guides/data-sources/api-sources). Nexus never changes a primary's rules: a person links the source in Merchant
 * Center. The preview says, from the live rule, whether the next fetch of the primary feed overwrites a value.
 */
import { changeLines } from '../google-ads/change-draft.js'
import { attributeProblem, MERCHANT_PRODUCT_ATTRIBUTES } from '../../gateway/google-merchant-calls.js'
import { NOT_NEXUS_DATA_SOURCE, shownValue, type MerchantDraftResult } from './change-draft.js'
import { encodedKey, productKey, type MerchantDataSource } from './live.js'

export type ProductAttributes = Record<string, unknown>

/** What Nexus can fill from its own product (its master data) — Nexus is the product master. */
export const FROM_NEXUS_FIELDS = ['title', 'description', 'brand', 'gtins'] as const
export type FromNexusField = typeof FROM_NEXUS_FIELDS[number]

export interface ProductRequest {
  action: 'set' | 'delete'
  dataSourceId: string
  offerId: string
  contentLanguage: string
  feedLabel: string
  attributes?: ProductAttributes
  clear?: string[]
  fromNexus?: FromNexusField[]
}

export interface ProductFacts {
  merchantCenterId: string
  /** Every data source of the account, live. */
  dataSources: MerchantDataSource[]
  /** The data sources Nexus made (records.ts). */
  nexusMade: Set<string>
  /**
   * What Nexus last wrote for this product in this data source (null state: deleted), or null with no record. `outcome`
   * unknown: Merchant Center did not answer that change, so the input may or may not hold `state`.
   */
  recorded: { state: ProductAttributes | null; at: string; outcome?: 'done' | 'unknown' } | null
  /** The processed product, live: whether Merchant Center has it, its primary data source and its attribute values. */
  live: { exists: boolean; dataSourceId: string | null; values: ProductAttributes }
  /** The Nexus product whose SKU is the offer id (null: none), with the values Nexus holds for it. */
  nexus: { sku: string; name: string; values: Partial<Record<FromNexusField, unknown>> } | null
}

/** The marketing methods that are ads (a product shown there is paid per click). */
const AD_DESTINATIONS = new Set(['SHOPPING_ADS', 'DISPLAY_ADS', 'LOCAL_INVENTORY_ADS'])

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null)
const sorted = (o: ProductAttributes): ProductAttributes => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * The attributes Shopping and Performance Max product groups and inventory filters split by (listing dimensions: custom
 * label 0–4, brand, product type, Google product category, condition, item group id): a change of one can move the
 * product into a group or filter that bids.
 */
export const GROUP_DIMENSIONS = ['customLabel0', 'customLabel1', 'customLabel2', 'customLabel3', 'customLabel4', 'brand', 'productTypes', 'googleProductCategory', 'condition', 'itemGroupId']

/** The money line of a change of a listing dimension, or none. */
export function groupMoved(names: string[], what: string): string[] {
  const dims = names.filter((n) => GROUP_DIMENSIONS.includes(n))
  return dims.length
    ? [`SPENDS MONEY: ${what} changes ${dims.join(', ')} — what Shopping and Performance Max product groups and inventory filters split by — so it can move the product into a product group or inventory filter that bids, where enabled campaigns pay for its clicks.`]
    : []
}

/** The attributes that decide whether a product may show in ads at all. */
const SERVING = ['pause', 'excludedDestinations', 'includedDestinations', 'shoppingAdsExcludedCountries'] as const

/**
 * When this source wins the rule (it comes before the primary feed), the product's ads serving after the change, from
 * what it shows LIVE: an attribute this source sets is its value; one it takes out falls back to the primary feed's value,
 * which Nexus cannot see apart from the live value (so it counts as absent: the cautious reading); any other stays live.
 */
export function servingAfter(live: ProductAttributes, recorded: ProductAttributes | null, state: ProductAttributes | null): ProductAttributes {
  const out: ProductAttributes = {}
  for (const name of SERVING) {
    if (state && name in state) out[name] = state[name]
    else if (recorded && name in recorded) continue
    else if (name in live) out[name] = live[name]
  }
  return out
}
const servingOf = (o: ProductAttributes): ProductAttributes => Object.fromEntries(SERVING.filter((n) => n in o).map((n) => [n, o[n]]))

/** The ways a change of this source's input lets the product show in paid ads again (each a sentence). */
export function adsReopened(before: ProductAttributes | null, after: ProductAttributes | null, what: string): string[] {
  const b = before ?? {}
  const a = after ?? {}
  const out: string[] = []
  if (b.pause && !a.pause) out.push(`SPENDS MONEY: ${what} no longer pauses the product (it was paused for ${b.pause === 'ALL' ? 'everything' : 'ads'}): it can show in Shopping ads again, and enabled Shopping and Performance Max campaigns pay for its clicks.`)
  const reopened = asList(b.excludedDestinations).filter((d) => AD_DESTINATIONS.has(d) && !asList(a.excludedDestinations).includes(d))
  if (reopened.length) out.push(`SPENDS MONEY: ${what} no longer excludes the product from ${reopened.join(', ')}: enabled campaigns can pay for its clicks there.`)
  const included = asList(a.includedDestinations).filter((d) => AD_DESTINATIONS.has(d) && !asList(b.includedDestinations).includes(d))
  if (included.length) out.push(`SPENDS MONEY: ${what} includes the product in ${included.join(', ')}: enabled campaigns can pay for its clicks there.`)
  const countries = asList(b.shoppingAdsExcludedCountries).filter((c) => !asList(a.shoppingAdsExcludedCountries).includes(c))
  if (countries.length) out.push(`SPENDS MONEY: ${what} no longer excludes the product from Shopping ads in ${countries.join(', ')}: enabled campaigns there can pay for its clicks.`)
  return out
}

/** The plain text of an HTML description (Google wants plain text): tags out, entities of the common kind decoded. */
export function plainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}

/**
 * Whether the values of supplemental data source `sourceId` reach the product, and win over its primary feed, as the live
 * default rule of the product's primary data source says. One warning, or none when the product is unknown.
 */
/** Whether this supplemental source wins the default rule of the product's primary data source (it comes before `self`). */
export function sourceWins(source: MerchantDataSource, primary: MerchantDataSource | null): boolean {
  if (!primary || !source.linkedFrom.includes(primary.dataSourceId)) return false
  const self = primary.defaultRule.indexOf('self')
  const mine = primary.defaultRule.indexOf(source.dataSourceId)
  return mine >= 0 && (self < 0 || mine < self)
}

export function reachWarning(source: MerchantDataSource, primary: MerchantDataSource | null, exists: boolean): string {
  if (!source.linkedFrom.length) {
    return `Data source ${source.dataSourceId} is not linked to any primary data source yet: these values reach no product until a person links it `
      + 'in Merchant Center (Data sources › the primary data source › Rules: add it as a supplemental source). Nexus never changes the rules '
      + 'of the primary feed that Shopify\'s Google channel owns.'
  }
  if (!exists || !primary) return 'Merchant Center has no product with this offer id, language and feed label yet: the values reach nothing until a primary data source sends that product.'
  if (!source.linkedFrom.includes(primary.dataSourceId)) {
    return `The product's primary data source (${primary.dataSourceId}${primary.displayName ? `, "${primary.displayName}"` : ''}) does not link data source ${source.dataSourceId}: these values do not reach this product until a person links it there in Merchant Center.`
  }
  const self = primary.defaultRule.indexOf('self')
  const mine = primary.defaultRule.indexOf(source.dataSourceId)
  if (mine < 0) return `The product's primary data source links data source ${source.dataSourceId} through a custom rule: Merchant Center's rules decide which value wins, and Nexus does not read custom rules.`
  if (self >= 0 && self < mine) {
    return `In the rule of the product's primary data source (${primary.dataSourceId}), the primary feed comes FIRST: where it sends the same attribute (Shopify's feed sends title, description, `
      + 'brand, GTIN …), ITS value wins and the next feed update keeps it — this change would be overwritten by the next Shopify feed fetch. This '
      + 'source only fills attributes the feed leaves empty. A person can move it before the primary feed in Merchant Center (Rules).'
  }
  return `In the rule of the product's primary data source (${primary.dataSourceId}), this source comes before the primary feed: its values win, and the next fetch of the feed does not overwrite them.`
}

export function productDraft(req: ProductRequest, facts: ProductFacts): MerchantDraftResult {
  const source = facts.dataSources.find((d) => d.dataSourceId === req.dataSourceId) ?? null
  if (!source) return { refusal: `Merchant Center has no data source ${req.dataSourceId} (google-merchant-live view data-sources lists them). Nothing was changed.` }
  if (!facts.nexusMade.has(source.dataSourceId)) return { refusal: NOT_NEXUS_DATA_SOURCE(source.dataSourceId) }
  if (source.type !== 'supplemental') return { refusal: `Data source ${source.dataSourceId} is a ${source.type} data source: Nexus writes product inputs into its supplemental data sources only. Nothing was changed.` }
  if (source.input !== 'API') return { refusal: `Data source ${source.dataSourceId} does not take products through the API (its input is ${source.input ?? 'unknown'}): the Merchant API writes only into API data sources. Nothing was changed.` }
  if (source.feedLabel && source.contentLanguage && (source.feedLabel !== req.feedLabel || source.contentLanguage !== req.contentLanguage)) {
    return { refusal: `Data source ${source.dataSourceId} takes only products in language ${source.contentLanguage} with feed label ${source.feedLabel}. Nothing was changed.` }
  }
  const key = productKey(req.contentLanguage, req.feedLabel, req.offerId)
  const recorded = facts.recorded?.state ?? null
  const primary = facts.live.dataSourceId ? facts.dataSources.find((d) => d.dataSourceId === facts.live.dataSourceId) ?? null : null
  const where = `data source ${source.dataSourceId}${source.displayName ? ` ("${source.displayName}")` : ''}`
  const record = { action: req.action, merchantCenterId: facts.merchantCenterId, dataSourceId: source.dataSourceId, key, offerId: req.offerId, contentLanguage: req.contentLanguage, feedLabel: req.feedLabel }
  const stands = {
    source: { id: source.dataSourceId, type: source.type, input: source.input, linkedFrom: [...source.linkedFrom].sort() },
    rule: primary?.defaultRule ?? null,
    recorded,
    outcome: facts.recorded?.outcome ?? null,
    live: { exists: facts.live.exists, dataSourceId: facts.live.dataSourceId },
  }
  const unknown = facts.recorded?.outcome === 'unknown'
  const unknownWarning = unknown
    ? `Nexus's last change of this input (${facts.recorded!.at.slice(0, 16).replace('T', ' ')} UTC) has an unknown outcome — Merchant Center did not answer — so the input `
      + 'Merchant Center holds may differ from Nexus\'s record (the Merchant API cannot read an input back: productInputs has no get). This change replaces it whole.'
    : null
  const wins = facts.live.exists && sourceWins(source, primary)
  /** What can make the product show in paid ads: from Nexus's record, and — when this source wins the rule — from the live product. */
  const money = (state: ProductAttributes | null, what: string): string[] => {
    const lines = adsReopened(recorded, state, what)
    if (wins) lines.push(...adsReopened(servingOf(facts.live.values), servingAfter(facts.live.values, recorded, state), what))
    return [...new Set(lines)]
  }
  const query = { dataSource: `accounts/${facts.merchantCenterId}/dataSources/${source.dataSourceId}` }

  if (req.action === 'delete') {
    if (!recorded && !unknown) {
      return { refusal: `Nexus has no record of a product input it wrote for ${req.offerId} (${req.contentLanguage}, ${req.feedLabel}) in ${where}, so there is nothing of Nexus's to delete. Nothing was changed.` }
    }
    const held = recorded ?? {}
    const lines = changeLines(Object.keys(held).sort().map((name) => [name, shownValue(held[name]), '(no longer from this source)']))
    const what = `Deleting this input of ${where}`
    return {
      summary: `Delete the product input of ${req.offerId} (${req.contentLanguage}, ${req.feedLabel}) from ${where}: the product keeps what its primary feed sends.`,
      changes: lines.changes,
      totals: { attributes: Object.keys(held).length, ...(lines.more ? { moreLines: lines.more } : {}) },
      warnings: [
        ...(unknownWarning ? [unknownWarning] : []),
        ...(!recorded ? ['Nexus does not know what the input holds, so undo cannot write it back.'] : []),
        'It can take a few minutes before Merchant Center shows the change (google-merchant-live view product).',
      ],
      spendsMoney: [...money(null, what), ...groupMoved(Object.keys(held), what)],
      call: { method: 'DELETE', path: `products/v1/accounts/${facts.merchantCenterId}/productInputs/${encodedKey(key)}`, query },
      stands,
      before: { ...record, state: recorded },
      after: { ...record, state: null },
    }
  }

  const given: ProductAttributes = { ...(req.attributes ?? {}) }
  for (const field of req.fromNexus ?? []) {
    if (!facts.nexus) return { refusal: `No Nexus product has the SKU ${req.offerId}, so Nexus cannot fill ${field} from its own product data. Nothing was changed.` }
    const value = facts.nexus.values[field]
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) {
      return { refusal: `Nexus's product ${facts.nexus.sku} has no ${field === 'gtins' ? 'GTIN' : field}: set it in Nexus first. Nothing was changed.` }
    }
    if (field in given) return { refusal: `${field} is given and also asked from Nexus: one or the other. Nothing was changed.` }
    given[field] = value
  }
  const clear = [...new Set(req.clear ?? [])]
  for (const name of clear) {
    if (!(name in MERCHANT_PRODUCT_ATTRIBUTES)) return { refusal: `${name} is not an attribute Nexus writes. Nothing was changed.` }
    if (name in given) return { refusal: `${name} is both set and taken out. Nothing was changed.` }
  }
  for (const [name, value] of Object.entries(given)) {
    const problem = attributeProblem(name, value)
    if (problem) return { refusal: `Not sent: ${problem}. Nothing was changed.` }
  }
  const next: ProductAttributes = { ...(recorded ?? {}), ...given }
  for (const name of clear) delete next[name]
  const state = sorted(next)
  if (!Object.keys(state).length) return { refusal: 'A product input holds at least one attribute: to take everything out, use action delete. Nothing was changed.' }
  if (recorded && !unknown && same(state, sorted(recorded))) {
    return { refusal: `Nothing to change: ${where} already holds exactly these values for ${req.offerId} (Nexus's record of ${facts.recorded?.at.slice(0, 16).replace('T', ' ')} UTC). Nothing was sent.` }
  }
  const names = [...new Set([...Object.keys(recorded ?? {}), ...Object.keys(state)])].sort().filter((n) => !same(recorded?.[n], state[n]))
  const lines = changeLines(names.map((name) => [name, shownValue(name in facts.live.values ? facts.live.values[name] : recorded?.[name]), name in state ? shownValue(state[name]) : '(no longer from this source)']))
  const warnings = [reachWarning(source, primary, facts.live.exists)]
  if (unknownWarning) {
    const sent = Object.keys(recorded ?? {})
    const shows = sent.filter((n) => same(facts.live.values[n], recorded![n])).length
    warnings.push(facts.live.exists && sent.length
      ? `${unknownWarning} The live product shows ${shows} of the ${sent.length} values it sent (a value can also come from the primary feed, so this does not prove it was made).`
      : unknownWarning)
  }
  if (facts.nexus) {
    const differs = (['title', 'description', 'brand', 'gtins'] as const).filter((f) => f in given && !(req.fromNexus ?? []).includes(f) && facts.nexus!.values[f] != null && !same(facts.nexus!.values[f], given[f]))
    if (differs.length) {
      warnings.push(`Nexus is the product master: ${differs.join(', ')} differ${differs.length === 1 ? 's' : ''} from Nexus's own for SKU ${facts.nexus.sku}. A change made in Nexus reaches every channel (and Shopify's Google feed); fromNexus fills these from Nexus instead.`)
    }
  } else {
    warnings.push(`No Nexus product has the SKU ${req.offerId}: Nexus cannot check these values against its own product data.`)
  }
  if (names.includes('pause') && state.pause) warnings.push(`The product is paused for ${state.pause === 'ALL' ? 'every Google surface (ads and free listings)' : 'ads'} once Merchant Center takes this input.`)
  warnings.push('It can take a few minutes before Merchant Center shows the change (google-merchant-live view product).')
  return {
    summary: names.length
      ? `${recorded ? 'Change' : 'Add'} ${names.length} attribute${names.length === 1 ? '' : 's'} of ${req.offerId} (${req.contentLanguage}, ${req.feedLabel}) in ${where}.`
      : `Send the input of ${req.offerId} (${req.contentLanguage}, ${req.feedLabel}) in ${where} again (${Object.keys(state).length} attribute${Object.keys(state).length === 1 ? '' : 's'}): its last change was not confirmed.`,
    changes: lines.changes,
    totals: { attributesChanged: names.length, attributesInInput: Object.keys(state).length, ...(lines.more ? { moreLines: lines.more } : {}) },
    warnings,
    spendsMoney: [...money(state, `This input of ${where}`), ...groupMoved(names, `This input of ${where}`)],
    call: {
      method: 'POST',
      path: `products/v1/accounts/${facts.merchantCenterId}/productInputs:insert`,
      query,
      body: { offerId: req.offerId, contentLanguage: req.contentLanguage, feedLabel: req.feedLabel, productAttributes: state },
    },
    stands,
    before: { ...record, state: recorded },
    after: { ...record, state },
  }
}

/**
 * The undo of a product change: the input that was there before (its whole state, the attributes it did not hold taken
 * out), or a delete when there was none. Pure.
 */
export function productUndoArgs(before: Record<string, unknown>, after: Record<string, unknown>): { args: Record<string, unknown> } | { refusal: string } {
  const base = { dataSourceId: before.dataSourceId, offerId: before.offerId, contentLanguage: before.contentLanguage, feedLabel: before.feedLabel }
  if (typeof base.dataSourceId !== 'string' || typeof base.offerId !== 'string') return { refusal: 'This change does not record which product input it wrote.' }
  const was = before.state && typeof before.state === 'object' ? before.state as ProductAttributes : null
  const now = after.state && typeof after.state === 'object' ? after.state as ProductAttributes : null
  if (!was && !now) return { refusal: 'Nexus did not know what this product input held before the delete (its earlier change had an unknown outcome), so it cannot write it back.' }
  if (!was) return { args: { ...base, action: 'delete' } }
  const clear = Object.keys(now ?? {}).filter((k) => !(k in was))
  return { args: { ...base, action: 'set', attributes: was, ...(clear.length ? { clear } : {}) } }
}
