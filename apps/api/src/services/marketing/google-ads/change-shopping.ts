/**
 * Google Ads Shopping (2026-10-15, G4) — a Standard Shopping campaign's inventory filter and the Shopping settings Google
 * lets change on an existing campaign, built from a request and the live state (live-shopping.ts), without any call: pure.
 *
 *   inventory filter   the campaign's LISTING_SCOPE criterion: the products it may advertise at all (every condition must
 *                      hold). Set, change or clear. CampaignCriterion.listing_scope is Immutable and "only one listing scope
 *                      is allowed per campaign" (samples/add-listing-scope), so a change is remove + create in one
 *                      request, removal first. Up to 7 conditions (Nexus's limit, the Google Ads inventory filter's; Google
 *                      refuses more with CriterionError.LISTING_SCOPE_TOO_MANY_DIMENSIONS — its check judges), each
 *                      dimension once (DUPLICATE_LISTING_DIMENSION_TYPE), product type / category levels in order from 1
 *                      (INVALID_LISTING_DIMENSION_TYPE), every condition with a value (a scope has no "everything else").
 *   Shopping settings  Campaign.ShoppingSetting fields Google lets change (reference/rpc/v25/Campaign.ShoppingSetting,
 *                      docs/shopping-ads/create-campaign): feed_label (≤ 20 of A–Z 0–9 - _; "If not specified, then the
 *                      campaign uses all available feeds in the Merchant Center"), enable_local (local products),
 *                      ignore_brand_exclusion_in_shopping_ads ("If true, brand exclusions are ignored for Shopping ads").
 *                      Not here: campaign_priority (set-google-campaign), merchant_id ("immutable for Shopping campaigns"),
 *                      advertising_partner_ids ("Once set, the field is immutable"; needs an advertising partner link),
 *                      disable_product_feed (Demand Gen only), use_vehicle_inventory (Immutable; Smart Shopping only).
 *
 * Money: what lets more products be advertised — a wider (or no) inventory filter, another or no feed label, local
 * products on, brand exclusions ignored — is said in `spendsMoney`, with a note when the campaign is not enabled.
 * Narrowing is a safe step.
 */
import { changeLines, type GoogleChangeDraft } from './change-draft.js'
import type { ScopeCondition, ShoppingCampaignLive, ShoppingLiveState } from './live-shopping.js'
import { caseValueOf, cleanValue, DIMENSIONS, dimensionWords, valueKey, type Dimension } from './product-tree.js'
import type { GoogleMutateOperation } from './write-client.js'

/** The most conditions one inventory filter holds here. */
export const MAX_FILTER_CONDITIONS = 7

export interface FilterCondition { dimension: Dimension; value: string }
export interface InventoryFilterRequest { campaignId: string; filter?: FilterCondition[]; clear?: boolean }
/** What an inventory filter change replaced and wrote: the conditions (none = no filter) and the criterion that holds them. */
export interface InventoryFilterRecord { campaignId: string; filter: FilterCondition[]; criterionId: string | null }

const lower = (s: string | null) => (s ?? 'not enabled').toLowerCase()
const pausedNote = (c: ShoppingCampaignLive) => (c.status === 'ENABLED' ? '' : ` (the campaign is ${lower(c.status)}: nothing spends until it is enabled)`)
const order = (a: FilterCondition, b: FilterCondition) => DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension)
const conditionKey = (c: FilterCondition) => `${c.dimension}=${valueKey(c.dimension, c.value)}`

/** A filter in words: `brand = "X" and custom label 0 = "top"`. */
export function filterWords(filter: FilterCondition[]): string {
  return filter.length ? filter.map((c) => `${dimensionWords(c.dimension)} = "${c.value}"`).join(' and ') : 'no inventory filter (every product of the feed)'
}

function campaignProblem(c: ShoppingCampaignLive | null, campaignId: string): { refusal: string } | null {
  if (!c) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  if (c.type !== 'SHOPPING') return { refusal: `"${c.name}" is a ${c.type ?? 'non-Shopping'} campaign: the inventory filter and these Shopping settings belong to a Standard Shopping campaign (a Performance Max campaign filters products in its asset groups).` }
  return null
}

/** The live filter as conditions, or why Nexus cannot read it. */
function liveFilter(state: ShoppingLiveState): { filter: FilterCondition[]; criterionIds: string[] } | { refusal: string } {
  const conditions: ScopeCondition[] = state.filters.flatMap((f) => f.conditions)
  if (conditions.some((c) => !c.dimension || c.value === null)) {
    return { refusal: `The inventory filter of "${state.campaign!.name}" holds a condition Nexus cannot read (${conditions.filter((c) => !c.dimension || c.value === null).map((c) => c.raw ?? 'unknown').join(', ')}): change it in Google Ads.` }
  }
  return { filter: conditions.map((c) => ({ dimension: c.dimension!, value: c.value! })).sort(order), criterionIds: state.filters.map((f) => f.criterionId) }
}

/** A filter as asked, checked against Google's rules; or the first problem. */
export function cleanFilter(raw: FilterCondition[]): FilterCondition[] | { refusal: string } {
  if (raw.length > MAX_FILTER_CONDITIONS) return { refusal: `${raw.length} conditions: an inventory filter holds at most ${MAX_FILTER_CONDITIONS}.` }
  const out: FilterCondition[] = []
  for (const [i, c] of raw.entries()) {
    if (!(DIMENSIONS as readonly string[]).includes(c.dimension)) return { refusal: `filter[${i}]: "${c.dimension}" is not a Shopping dimension Nexus knows.` }
    if (out.some((x) => x.dimension === c.dimension)) return { refusal: `filter[${i}]: ${dimensionWords(c.dimension)} is named twice (each dimension once; the conditions all hold together).` }
    const clean = cleanValue(c.dimension, c.value, `filter[${i}]`)
    if ('refusal' in clean) return clean
    out.push({ dimension: c.dimension, value: clean.value })
  }
  for (const c of out) {
    const m = /^(PRODUCT_TYPE|CATEGORY)_(\d)$/.exec(c.dimension)
    if (m && Number(m[2]) > 1 && !out.some((x) => x.dimension === `${m[1]}_${Number(m[2]) - 1}`)) {
      return { refusal: `${dimensionWords(c.dimension)} needs ${dimensionWords(`${m[1]}_${Number(m[2]) - 1}` as Dimension)} in the filter too (Google takes the levels in order from 1).` }
    }
  }
  return out.sort(order)
}

export function inventoryFilterDraft(customer: string, request: InventoryFilterRequest, state: ShoppingLiveState): GoogleChangeDraft | { refusal: string } {
  const bad = campaignProblem(state.campaign, request.campaignId)
  if (bad) return bad
  const c = state.campaign!
  if (!!request.clear === !!request.filter?.length) return { refusal: 'Give filter (the conditions every advertised product must meet) or clear: true — one of the two.' }
  const now = liveFilter(state)
  if ('refusal' in now) return now
  const asked = request.clear ? [] : cleanFilter(request.filter!)
  if (!Array.isArray(asked)) return asked
  const same = asked.length === now.filter.length && asked.every((x) => now.filter.some((y) => conditionKey(x) === conditionKey(y)))
  if (same && now.criterionIds.length <= 1) return { refusal: `Nothing to change: "${c.name}" already has ${filterWords(now.filter)}.` }

  const operations: GoogleMutateOperation[] = now.criterionIds.map((id) => ({ campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${c.campaignId}~${id}` } }))
  if (asked.length) {
    operations.push({ campaignCriterionOperation: { create: { campaign: `${customer}/campaigns/${c.campaignId}`, listingScope: { dimensions: asked.map((x) => caseValueOf(x.dimension, x.value)) } } } })
  }
  const note = pausedNote(c)
  const spends: string[] = []
  const warnings: string[] = []
  const wider = now.filter.some((x) => !asked.some((y) => conditionKey(x) === conditionKey(y)))
  if (!asked.length) spends.push(`Removes the inventory filter of "${c.name}": every product of its Merchant Center feed can be advertised again (as its product groups allow)${note}.`)
  else if (wider) spends.push(`Changes the inventory filter of "${c.name}" so products it left out can be advertised (${filterWords(now.filter)} → ${filterWords(asked)}), as its product groups allow${note}.`)
  if (asked.length) warnings.push(`Only products with ${filterWords(asked)} can be advertised in "${c.name}"; its product groups set the bids among them.`)
  if (asked.length && now.criterionIds.length) warnings.push('Google keeps one inventory filter per campaign and cannot change one: the old one is removed and the new one made in the same request.')
  const { changes } = changeLines([[`inventory filter of "${c.name}"`, filterWords(now.filter), filterWords(asked)]])
  return {
    summary: `Google Ads campaign "${c.name}": ${asked.length ? `${now.filter.length ? 'change' : 'set'} the inventory filter to ${filterWords(asked)}` : 'remove the inventory filter'}.`,
    changes,
    totals: { operations: operations.length, conditions: asked.length },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations,
    stands: { campaignId: c.campaignId, type: c.type, status: c.status, filters: state.filters.map((f) => ({ id: f.criterionId, conditions: f.conditions })) },
    before: { campaignId: c.campaignId, filter: now.filter, criterionId: now.criterionIds[0] ?? null } satisfies InventoryFilterRecord,
    after: { campaignId: c.campaignId, filter: asked, criterionId: asked.length ? `op:${operations.length - 1}` : null } satisfies InventoryFilterRecord,
  }
}

/** The record of a run: the criterion Google made (the result of the operation that made it). */
export function inventoryFilterRecordAfterRun(after: InventoryFilterRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): InventoryFilterRecord {
  const at = /^op:(\d+)$/.exec(after.criterionId ?? '')
  if (!at) return after
  const name = responses[Number(at[1])]?.campaignCriterionResult?.resourceName
  return { ...after, criterionId: name ? name.slice(name.lastIndexOf('~') + 1) : null }
}

/** The filter Google holds now, in the record's shape (values spelled as the record spells them when only the case differs). */
export function inventoryFilterRecordNow(after: InventoryFilterRecord, state: ShoppingLiveState): InventoryFilterRecord {
  const conditions = state.filters.flatMap((f) => f.conditions)
  const filter = conditions.map((x) => {
    const was = after.filter.find((y) => y.dimension === x.dimension && x.value !== null && valueKey(y.dimension, y.value) === valueKey(y.dimension, x.value))
    return { dimension: x.dimension as Dimension, value: was ? was.value : x.value as string }
  }).sort(order)
  return { campaignId: after.campaignId, filter, criterionId: state.filters[0]?.criterionId ?? null }
}

export function inventoryFilterUndoArgs(before: InventoryFilterRecord | null): { args: Record<string, unknown> } | { refusal: string } {
  if (!before?.campaignId || !Array.isArray(before.filter)) return { refusal: 'This change does not record the inventory filter it replaced.' }
  return { args: { campaignId: before.campaignId, ...(before.filter.length ? { filter: before.filter } : { clear: true }) } }
}

// ── Shopping settings ───────────────────────────────────────────────────────────────────────────────────────────

export interface ShoppingSettings {
  /** A feed label, or 'none' (every feed of the Merchant Center account). */
  feedLabel?: string
  localInventory?: boolean
  ignoreBrandExclusions?: boolean
}
export interface ShoppingSettingsRequest extends ShoppingSettings { campaignId: string }
export interface ShoppingSettingsRecord { campaignId: string; settings: ShoppingSettings }

export const shoppingSettingsNow = (c: ShoppingCampaignLive): Required<ShoppingSettings> =>
  ({ feedLabel: c.feedLabel ?? 'none', localInventory: c.localInventory, ignoreBrandExclusions: c.ignoreBrandExclusions })

const FEED_LABEL = /^[A-Z0-9_-]{1,20}$/

export function shoppingSettingsDraft(customer: string, request: ShoppingSettingsRequest, state: ShoppingLiveState): GoogleChangeDraft | { refusal: string } {
  const bad = campaignProblem(state.campaign, request.campaignId)
  if (bad) return bad
  const c = state.campaign!
  const now = shoppingSettingsNow(c)
  const ask: ShoppingSettings = {}
  if (request.feedLabel !== undefined) {
    const label = request.feedLabel.trim()
    if (label.toLowerCase() === 'none') ask.feedLabel = 'none'
    else if (!FEED_LABEL.test(label)) return { refusal: `The feed label "${label.slice(0, 40)}" is not one Google takes (up to 20 of A–Z, 0–9, - and _), or give none (every feed).` }
    else ask.feedLabel = label
  }
  if (request.localInventory !== undefined) ask.localInventory = request.localInventory
  if (request.ignoreBrandExclusions !== undefined) ask.ignoreBrandExclusions = request.ignoreBrandExclusions
  const keys = (Object.keys(ask) as Array<keyof ShoppingSettings>).filter((k) => ask[k] !== now[k])
  if (!Object.keys(ask).length) return { refusal: 'Say what to change: feedLabel, localInventory or ignoreBrandExclusions.' }
  if (!keys.length) return { refusal: `Nothing to change: "${c.name}" already has these Shopping settings.` }

  const note = pausedNote(c)
  const setting: Record<string, unknown> = {}
  const mask: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const before: ShoppingSettings = {}
  const after: ShoppingSettings = {}
  const onOff = (b: boolean | undefined) => (b ? 'on' : 'off')
  for (const k of keys) {
    before[k] = now[k] as never
    after[k] = ask[k] as never
  }
  if (keys.includes('feedLabel')) {
    // A path in the mask with no value in the body is cleared (Google's update rule): 'none' clears the label.
    if (ask.feedLabel !== 'none') setting.feedLabel = ask.feedLabel
    mask.push('shopping_setting.feed_label')
    const words = (l: string) => (l === 'none' ? 'none (every feed of the Merchant Center account)' : l)
    lines.push(['feed label', words(now.feedLabel), words(ask.feedLabel!)])
    spends.push(ask.feedLabel === 'none'
      ? `Removes the feed label of "${c.name}": products of every feed of its Merchant Center account can be advertised${note}.`
      : `Changes the feed label of "${c.name}" to ${ask.feedLabel}: the products of that feed can be advertised${now.feedLabel === 'none' ? '' : `, and those of ${now.feedLabel} stop`}${note}.`)
    warnings.push('A feed label does not target a country: the campaign\'s locations decide where ads show.')
  }
  if (keys.includes('localInventory')) {
    setting.enableLocal = ask.localInventory
    mask.push('shopping_setting.enable_local')
    lines.push(['local products', onOff(now.localInventory), onOff(ask.localInventory)])
    if (ask.localInventory) spends.push(`Turns on local products in "${c.name}": products sold in local stores can be advertised too${note}.`)
  }
  if (keys.includes('ignoreBrandExclusions')) {
    setting.ignoreBrandExclusionInShoppingAds = ask.ignoreBrandExclusions
    mask.push('shopping_setting.ignore_brand_exclusion_in_shopping_ads')
    lines.push(['brand exclusions for Shopping ads', now.ignoreBrandExclusions ? 'ignored' : 'applied', ask.ignoreBrandExclusions ? 'ignored' : 'applied'])
    if (ask.ignoreBrandExclusions) spends.push(`Lets Google ignore the brand exclusions for the Shopping ads of "${c.name}": they can show where the exclusions held them back${note}.`)
  }
  const operations: GoogleMutateOperation[] = [{ campaignOperation: { update: { resourceName: `${customer}/campaigns/${c.campaignId}`, shoppingSetting: setting }, updateMask: mask.join(',') } }]
  const { changes } = changeLines(lines)
  return {
    summary: `Google Ads campaign "${c.name}": change ${lines.map((l) => l[0]).join(', ')}.`,
    changes,
    totals: { operations: 1, settings: lines.length },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations,
    stands: { campaignId: c.campaignId, type: c.type, status: c.status, now },
    before: { campaignId: c.campaignId, settings: before } satisfies ShoppingSettingsRecord,
    after: { campaignId: c.campaignId, settings: after } satisfies ShoppingSettingsRecord,
  }
}
