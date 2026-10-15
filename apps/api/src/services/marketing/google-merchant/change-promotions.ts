/**
 * Google Ads programme 2, G12 (2026-10-16) — a promotion in a promotion data source Nexus made (pure): set it (new, or the
 * one Nexus last wrote with the fields asked changed) or end it. promotions_v1 has insert, get and list only: an insert of
 * an existing promotion "overwrites the entire promotions resource" (guides/promotions/overview), and there is no delete —
 * a promotion is ended by moving its end to the moment the change runs.
 *
 * Checked 2026-10-16 (curl of developers.google.com/merchant/api/reference/rest/promotions_v1 and the promotions data
 * specification, support.google.com/merchants/answer/2906014): promotion id up to 50 characters, long title up to 60,
 * generic redemption code up to 20, percent off an integer, item id up to 50; "All shipping promotions must include a
 * valid redemption code"; redemption channel ONLINE; destinations SHOPPING_ADS and FREE_LISTINGS ("your promotion will
 * display in Shopping ads and free listings by default"). A promotion changes the price buyers see: the preview says so,
 * as its money line.
 */
import { changeLines } from '../google-ads/change-draft.js'
import { COUPON_VALUE_TYPES, PROMOTION_DESTINATIONS } from '../../gateway/google-merchant-calls.js'
import { byRun, byRunMinute, isRunMarker, resolveRunTime } from './client.js'
import { NOT_NEXUS_DATA_SOURCE, shownValue, type MerchantDraftResult } from './change-draft.js'
import type { MerchantDataSource, MerchantPromotion } from './live.js'

export type CouponValueType = typeof COUPON_VALUE_TYPES[number]
export type PromotionDestination = typeof PROMOTION_DESTINATIONS[number]

/** A promotion as the tool takes it and as Nexus records it (amounts in cents of `currency`, times in UTC). */
export interface PromotionState {
  title: string
  type: CouponValueType
  percentOff?: number
  moneyOffCents?: number
  minimumPurchaseCents?: number
  currency?: string
  code?: string
  appliesTo: 'all' | 'specific'
  itemIds?: string[]
  excludedItemIds?: string[]
  brands?: string[]
  productTypes?: string[]
  startsAt: string
  endsAt: string
  displayStartsAt?: string
  displayEndsAt?: string
  destinations?: PromotionDestination[]
  url?: string
}
export const PROMOTION_FIELDS = [
  'title', 'type', 'percentOff', 'moneyOffCents', 'minimumPurchaseCents', 'currency', 'code', 'appliesTo', 'itemIds', 'excludedItemIds',
  'brands', 'productTypes', 'startsAt', 'endsAt', 'displayStartsAt', 'displayEndsAt', 'destinations', 'url',
] as const
type Field = typeof PROMOTION_FIELDS[number]

export interface PromotionRequest {
  action: 'set' | 'end'
  dataSourceId: string
  promotionId: string
  /** set: the fields to set; null takes an optional one out. */
  fields?: Partial<Record<Field, unknown>>
}

export interface PromotionFacts {
  merchantCenterId: string
  dataSources: MerchantDataSource[]
  nexusMade: Set<string>
  /** The promotion with this id in the data source's country and language, live (null: none). */
  live: MerchantPromotion | null
  /** Nexus's last record of it; `outcome` unknown: Merchant Center did not answer that change. */
  recorded: { state: PromotionState | null; at: string; outcome?: 'done' | 'unknown' } | null
  now: Date
}

const utc = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.000Z$/, 'Z')
}
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
const money = (cents: number | undefined, currency: string | undefined) => (cents === undefined ? undefined : `${currency ?? ''} ${(cents / 100).toFixed(2)}`.trim())
const micros = (cents: number, currency: string) => ({ amountMicros: String(cents * 10_000), currencyCode: currency })

/** The offer in words ("15% off", "EUR 10.00 off", "free shipping"). */
export const offerWords = (s: PromotionState): string =>
  s.type === 'PERCENT_OFF' ? `${s.percentOff}% off` : s.type === 'MONEY_OFF' ? `${money(s.moneyOffCents, s.currency)} off` : 'free standard shipping'

/** Why a whole promotion is not one Nexus sends (Google's rules for its type), or null. */
export function promotionStateProblem(s: Partial<PromotionState>): string | null {
  if (typeof s.title !== 'string' || !s.title.trim() || s.title.length > 60 || /[\r\n]/.test(s.title)) return 'the title is 1 to 60 characters on one line'
  if (!(COUPON_VALUE_TYPES as readonly unknown[]).includes(s.type)) return `the type is ${COUPON_VALUE_TYPES.join(', ')}`
  if (s.type === 'PERCENT_OFF' ? !(Number.isInteger(s.percentOff) && s.percentOff! >= 1 && s.percentOff! <= 99) : s.percentOff !== undefined) return 'a PERCENT_OFF promotion (only) has percentOff, a whole 1 to 99'
  if (s.type === 'MONEY_OFF' ? !(Number.isInteger(s.moneyOffCents) && s.moneyOffCents! >= 1) : s.moneyOffCents !== undefined) return 'a MONEY_OFF promotion (only) has moneyOffCents'
  if (s.minimumPurchaseCents !== undefined && !(Number.isInteger(s.minimumPurchaseCents) && s.minimumPurchaseCents >= 1)) return 'minimumPurchaseCents is whole cents'
  const amounts = s.moneyOffCents !== undefined || s.minimumPurchaseCents !== undefined
  if (amounts !== (typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency))) return 'an amount names its currency (and a currency comes with an amount)'
  if (s.code !== undefined && !(typeof s.code === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(s.code))) return 'the code is 1 to 20 of A-Z, a-z, 0-9, - and _'
  if (s.type === 'FREE_SHIPPING_STANDARD' && !s.code) return 'a free shipping promotion needs a code (Google: "All shipping promotions must include a valid redemption code")'
  const filters = (['itemIds', 'brands', 'productTypes'] as const).filter((k) => s[k] !== undefined)
  if (s.appliesTo === 'all' && (filters.length || s.excludedItemIds !== undefined)) return 'a promotion for all products names no items, brands or product types'
  if (s.appliesTo === 'specific' && !filters.length) return 'a promotion for specific products names its items, brands or product types'
  if (s.appliesTo !== 'all' && s.appliesTo !== 'specific') return 'appliesTo is all or specific'
  if (!s.startsAt || !s.endsAt || Date.parse(s.startsAt) >= Date.parse(s.endsAt)) return 'the promotion has a start and an end after it'
  if (!!s.displayStartsAt !== !!s.displayEndsAt || (s.displayStartsAt && Date.parse(s.displayStartsAt) >= Date.parse(s.displayEndsAt!))) return 'the display period has a start and an end after it, or neither'
  if (s.url !== undefined && !(typeof s.url === 'string' && /^https:\/\/\S{1,1990}$/.test(s.url))) return 'the promotion page is an https link'
  return null
}

/** The Google body of a whole promotion (InsertPromotionRequest.promotion.attributes). */
export function promotionAttributes(s: PromotionState): Record<string, unknown> {
  return {
    longTitle: s.title,
    couponValueType: s.type,
    ...(s.type === 'PERCENT_OFF' ? { percentOff: String(s.percentOff) } : {}),
    ...(s.type === 'MONEY_OFF' ? { moneyOffAmount: micros(s.moneyOffCents!, s.currency!) } : {}),
    ...(s.minimumPurchaseCents !== undefined ? { minimumPurchaseAmount: micros(s.minimumPurchaseCents, s.currency!) } : {}),
    offerType: s.code ? 'GENERIC_CODE' : 'NO_CODE',
    ...(s.code ? { genericRedemptionCode: s.code } : {}),
    productApplicability: s.appliesTo === 'all' ? 'ALL_PRODUCTS' : 'SPECIFIC_PRODUCTS',
    ...(s.itemIds ? { itemIdInclusion: s.itemIds } : {}),
    ...(s.excludedItemIds ? { itemIdExclusion: s.excludedItemIds } : {}),
    ...(s.brands ? { brandInclusion: s.brands } : {}),
    ...(s.productTypes ? { productTypeInclusion: s.productTypes } : {}),
    promotionEffectiveTimePeriod: { startTime: s.startsAt, endTime: s.endsAt },
    ...(s.displayStartsAt ? { promotionDisplayTimePeriod: { startTime: s.displayStartsAt, endTime: s.displayEndsAt } } : {}),
    promotionDestinations: s.destinations ?? [...PROMOTION_DESTINATIONS],
    ...(s.url ? { promotionUrl: s.url } : {}),
  }
}

export function promotionDraft(req: PromotionRequest, facts: PromotionFacts): MerchantDraftResult {
  const source = facts.dataSources.find((d) => d.dataSourceId === req.dataSourceId) ?? null
  if (!source) return { refusal: `Merchant Center has no data source ${req.dataSourceId} (google-merchant-live view data-sources lists them). Nothing was changed.` }
  if (!facts.nexusMade.has(source.dataSourceId)) return { refusal: NOT_NEXUS_DATA_SOURCE(source.dataSourceId) }
  if (source.type !== 'promotion' || !source.countries[0] || !source.contentLanguage) {
    return { refusal: `Data source ${source.dataSourceId} is a ${source.type} data source, not a promotion one (set-google-merchant-data-sources action create-promotions makes one). Nothing was changed.` }
  }
  const country = source.countries[0]
  const language = source.contentLanguage
  const key = `${country}~${language}~${req.promotionId}`
  if (facts.live && facts.live.dataSourceId && facts.live.dataSourceId !== source.dataSourceId) {
    return { refusal: `Promotion ${req.promotionId} (${country}, ${language}) already lives in data source ${facts.live.dataSourceId}, which Nexus did not make it in: Nexus changes promotions only in its own data sources. Nothing was changed.` }
  }
  const recorded = facts.recorded?.state ?? null
  if (facts.live && !recorded) {
    return { refusal: `Merchant Center has promotion ${req.promotionId} in data source ${source.dataSourceId}, but Nexus has no record of what it holds, so a change would replace it blind and could not be undone. Nothing was changed.` }
  }
  const now = facts.now.getTime()
  let state: PromotionState
  if (req.action === 'end') {
    if (!recorded) return { refusal: `Nexus has no promotion ${req.promotionId} (${country}, ${language}) in data source ${source.dataSourceId} to end. Nothing was changed.` }
    if (Date.parse(recorded.endsAt) <= now) return { refusal: `Promotion ${req.promotionId} already ended at ${recorded.endsAt}. Nothing was sent.` }
    // Settled when it runs, from the recorded times only: it ends then (or at its own end, if earlier); one that has not
    // started by then starts a minute before (its period must start before it ends). The plan does not move if it
    // starts between the preview and the run.
    state = {
      ...recorded,
      startsAt: byRunMinute(recorded.startsAt),
      endsAt: byRun(recorded.endsAt),
      ...(recorded.displayStartsAt && recorded.displayEndsAt ? { displayStartsAt: byRunMinute(recorded.displayStartsAt), displayEndsAt: byRun(recorded.displayEndsAt) } : {}),
    }
  } else {
    const next: Record<string, unknown> = { ...(recorded ?? {}) }
    for (const [field, value] of Object.entries(req.fields ?? {})) {
      if (!(PROMOTION_FIELDS as readonly string[]).includes(field) || value === undefined) continue
      if (value === null) { delete next[field]; continue }
      if (['startsAt', 'endsAt', 'displayStartsAt', 'displayEndsAt'].includes(field)) {
        const at = utc(value)
        if (!at) return { refusal: `${field} is not a date-time (YYYY-MM-DDTHH:MM:SSZ). Nothing was changed.` }
        next[field] = at
      } else next[field] = Array.isArray(value) ? [...new Set(value)] : value
    }
    const problem = promotionStateProblem(next as Partial<PromotionState>)
    if (problem) return { refusal: `Not sent: ${problem}. Nothing was changed.` }
    state = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]])) as unknown as PromotionState
    if (recorded && facts.recorded?.outcome !== 'unknown' && canonical(state) === canonical(recorded)) return { refusal: `Nothing to change: promotion ${req.promotionId} already is exactly this (Nexus's record). Nothing was sent.` }
    if (Date.parse(state.endsAt) <= now) return { refusal: `The promotion would end at ${state.endsAt}, which has passed: use action end to stop it now. Nothing was changed.` }
  }
  // The lines a person reads: as the change would settle if it ran now (a start already passed stays as it is).
  const settled = resolveRunTime(state, facts.now) as unknown as Record<string, unknown>
  const names = PROMOTION_FIELDS.filter((f) => canonical(recorded?.[f] ?? null) !== canonical(settled[f] ?? null))
  const shown = (f: Field, s: PromotionState | null) => {
    const v = s ? (s as unknown as Record<string, unknown>)[f] : undefined
    if (!isRunMarker(v)) return shownValue(v)
    return f === 'startsAt' || f === 'displayStartsAt' ? 'a minute before this change runs (it had not started)' : 'when this change runs'
  }
  const lines = changeLines(names.map((f) => [f, recorded ? shown(f, recorded) : '(none)', shown(f, state)]))
  const record = { action: req.action, merchantCenterId: facts.merchantCenterId, dataSourceId: source.dataSourceId, key, promotionId: req.promotionId, targetCountry: country, contentLanguage: language }
  const scope = state.appliesTo === 'all' ? 'all products' : [
    state.itemIds ? `${state.itemIds.length} item${state.itemIds.length === 1 ? '' : 's'}` : null,
    state.brands ? `brand ${state.brands.join(', ')}` : null,
    state.productTypes ? `product type ${state.productTypes.join(', ')}` : null,
  ].filter(Boolean).join(', ')
  const destinations = (state.destinations ?? [...PROMOTION_DESTINATIONS]).map((d) => (d === 'SHOPPING_ADS' ? 'Shopping ads' : 'free listings')).join(' and ')
  const spends = req.action === 'set'
    ? [`CHANGES THE PRICE BUYERS SEE: "${state.title}" — ${offerWords(state)}${state.minimumPurchaseCents ? ` from ${money(state.minimumPurchaseCents, state.currency)}` : ''} on ${scope}, for buyers in ${country}, ${state.startsAt} to ${state.endsAt} (UTC), in Google's ${destinations}${state.code ? `, with the code ${state.code}` : ''}. The shop gives this discount at checkout: it is money off every sale it applies to.`]
    : []
  return {
    summary: req.action === 'end'
      ? `End promotion ${req.promotionId} ("${recorded!.title}", ${offerWords(recorded!)}) for ${country} when this change runs.`
      : `${recorded ? 'Change' : 'Make'} promotion ${req.promotionId} for ${country} (${language}): "${state.title}", ${offerWords(state)} on ${scope}.`,
    changes: lines.changes,
    totals: { fieldsChanged: names.length, ...(lines.more ? { moreLines: lines.more } : {}) },
    warnings: [
      ...(facts.recorded?.outcome === 'unknown' ? [`Nexus's last change of this promotion (${facts.recorded.at.slice(0, 16).replace('T', ' ')} UTC) has an unknown outcome — Merchant Center did not answer — so it may differ from Nexus's record; this change replaces it whole.`] : []),
      ...(req.action === 'end'
      ? ['Google stops showing it once it takes the new end; the shop\'s own discount (in Shopify) is not changed here.']
      : [
        'Google reviews every promotion before it shows (it can take up to a day; google-merchant-live view promotions shows its status).',
        `The shop must give the same offer at checkout${state.code ? ` with the code ${state.code}` : ''}: Nexus does not make the Shopify discount here, and Google disapproves a promotion the shop does not honour.`,
        'Promotions show only when the Merchant Center account takes part in the Promotions program.',
      ]),
    ],
    spendsMoney: spends,
    call: {
      method: 'POST',
      path: `promotions/v1/accounts/${facts.merchantCenterId}/promotions:insert`,
      body: {
        dataSource: `accounts/${facts.merchantCenterId}/dataSources/${source.dataSourceId}`,
        promotion: { promotionId: req.promotionId, contentLanguage: language, targetCountry: country, redemptionChannel: ['ONLINE'], attributes: promotionAttributes(state) },
      },
    },
    stands: { source: { id: source.dataSourceId, type: source.type, country, language }, recorded, outcome: facts.recorded?.outcome ?? null, live: facts.live ? { dataSourceId: facts.live.dataSourceId } : null },
    before: { ...record, state: recorded },
    after: { ...record, state },
  }
}

/** The undo of a promotion change: the promotion as it was (the fields it did not hold taken out), or an end when it was new. */
export function promotionUndoArgs(before: Record<string, unknown>, after: Record<string, unknown>): { args: Record<string, unknown> } | { refusal: string } {
  if (typeof before.dataSourceId !== 'string' || typeof before.promotionId !== 'string') return { refusal: 'This change does not record which promotion it wrote.' }
  const base = { dataSourceId: before.dataSourceId, promotionId: before.promotionId }
  const was = before.state && typeof before.state === 'object' ? before.state as Record<string, unknown> : null
  if (!was) return { args: { ...base, action: 'end' } }
  const now = after.state && typeof after.state === 'object' ? after.state as Record<string, unknown> : {}
  const fields: Record<string, unknown> = { ...was }
  for (const k of Object.keys(now)) if (!(k in was)) fields[k] = null
  return { args: { ...base, action: 'set', ...fields } }
}
