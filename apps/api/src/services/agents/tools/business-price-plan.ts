/**
 * Amazon Business (B2B) step 6 — the business price as Claude asks for it, for `set-listing-price` (action `business`,
 * `businessPrice`, Matrix targets) and `bulk-listing-price-change` (`businessPrices`, listing ids): one input shape, one plan of what a change
 * does, and one undo shape. The write is the Matrix's own (`writeBusinessPrices`, the business price door), behind a
 * person's approval in Nexus.
 *
 * The plan is the door's own dry run (`writeBusinessPrices({ dryRun: true })`): Amazon only, never a family parent, the
 * B2B audience Amazon lists for the listing's account, market and product type, and Amazon's rules (a business price
 * above the normal price, below the minimum or above the maximum price, tiers that are not cheaper …) refuse a listing
 * with the door's sentence; its warnings, and why a change would be kept in Nexus until the listing can be sent to
 * (paused, a draft, Inactive), come with it. Beside the door, from the pull's copy of Amazon's offer:
 *   - a business price Amazon shows that Nexus never kept (set outside Nexus) is never removed by a `null`: nothing here
 *     is read as a removal but an explicit `remove: true`, and a removal where Nexus keeps none is refused with the reason;
 *   - #602 — a FIRST business offer (Amazon holds none) is sent with the normal offer, so it is not sent while Amazon's
 *     shopper price is not Nexus's: the preview says so with both prices (the send waits, and goes by itself once the two
 *     agree).
 *
 * The approval card shows a preview's `summary` and each line's from → to labels, never its `warning(s)`: so what a person
 * must know before approving — it replaces Amazon's own business price (an undo can never bring that back), it waits for
 * the shopper prices to agree, it is kept in Nexus (paused, draft, Inactive), a warning from Amazon's rules, a removal at
 * Amazon — is said in the summary (`businessCardSummary`), and Amazon's own price is the line's `from` label.
 *
 * A change stands on the fields it changes (#609): each listing's business setting before and after, never the listing's
 * version (an order's stock cascade moves it) nor the normal price a percent follows (a PERCENT_OFF rule follows it by
 * design; the door refuses at the write whatever the normal price would make invalid then).
 */
import { z } from 'zod'
import { businessPriceOf, type BusinessPriceSetting } from '@nexus/shared/business-price'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import prisma from '../../../db.js'
import { liveBusinessInstance, liveNormalInstance, storedBusinessSetting } from '../../amazon/business-offer.js'
import { amazonMarketplaceIdOf } from '../../amazon/offer-facts.js'
import { listingMarketCurrency } from '../../pim/follower-price.js'
import type { MarketCurrencyRow } from '../../pim/market-currency.js'

/** A yes/no argument; the words true and false count as one (z.coerce.boolean would read "false" as true). */
const yes = z.preprocess((value) => (value === 'true' ? true : value), z.literal(true))

export const BUSINESS_TIERS_INPUT = z.object({
  type: z.enum(['percent', 'fixed']).describe('percent: each discount is a percent off the business price; fixed: each is a price per unit (with an exact business price only)'),
  levels: z.array(z.object({
    minQty: z.coerce.number().int().min(1).max(1_000_000).describe('from this many units of the SKU in one order: at least 2, each higher than the one before'),
    value: z.coerce.number().positive().max(1_000_000).describe('percent: the percent off the business price (0.01 to 99, each bigger than the one before); fixed: the price per unit (each lower)'),
  })).min(1).max(5).describe('1 to 5 quantity discounts, lowest quantity first'),
})

/** The fields of one business price change (Amazon Business, one Amazon listing in one market). */
export const BUSINESS_FIELDS = {
  rule: z.enum(['PERCENT_OFF', 'FIXED']).optional()
    .describe('PERCENT_OFF: the normal price minus percent, following every normal price change; FIXED: an exact business price. Left out: implied by percent or price, else the rule the listing has'),
  percent: z.coerce.number().min(0).max(100).optional()
    .describe('PERCENT_OFF: the percent below the normal price, 0 to 99 with at most two decimals (0 = the normal price itself, for quantity discounts only)'),
  price: z.coerce.number().positive().max(1_000_000).optional()
    .describe('FIXED: the exact business price in the market\'s currency, VAT included like the normal price'),
  tiers: BUSINESS_TIERS_INPUT.nullable().optional().describe('the quantity discounts; null removes them; left out keeps the ones the listing has'),
  remove: yes.optional().describe('true removes the business price and its quantity discounts, in Nexus and on Amazon; give nothing else with it'),
}
export const BUSINESS_INPUT = z.object(BUSINESS_FIELDS)

export interface BusinessInput {
  rule?: 'PERCENT_OFF' | 'FIXED'
  percent?: number
  price?: number
  tiers?: { type: 'percent' | 'fixed'; levels: Array<{ minQty: number; value: number }> } | null
  remove?: true
}

/** The door's one shape per meaning (`business-price-write.service.ts` normalised): what is stored and read back. */
export function normalisedSetting(s: BusinessPriceSetting | null): BusinessPriceSetting | null {
  if (!s) return null
  const tiers = s.tiers ? { type: s.tiers.type, levels: (s.tiers.levels ?? []).map((l) => ({ minQty: l.minQty, value: l.value })) } : null
  return s.rule === 'PERCENT_OFF'
    ? { rule: 'PERCENT_OFF', percent: s.percent ?? null, price: null, tiers }
    : { rule: 'FIXED', percent: null, price: s.price ?? null, tiers }
}

export const sameSetting = (a: BusinessPriceSetting | null, b: BusinessPriceSetting | null) =>
  JSON.stringify(normalisedSetting(a)) === JSON.stringify(normalisedSetting(b))

/**
 * PURE — the setting a change asks for, from the listing's setting now: `remove: true` is the only removal; a rule is
 * the one named, else implied by a percent (PERCENT_OFF) or a price (FIXED), else the listing's own; tiers left out keep
 * the listing's. A shape that cannot be read is refused with the sentence, never half read.
 */
export function resolveBusinessSetting(now: BusinessPriceSetting | null, input: BusinessInput): { setting: BusinessPriceSetting | null } | { error: string } {
  const named = input.rule !== undefined || input.percent !== undefined || input.price !== undefined || input.tiers !== undefined
  if (input.remove) return named ? { error: 'remove goes alone: leave rule, percent, price and tiers out.' } : { setting: null }
  if (!named) return { error: 'Name the business price: rule PERCENT_OFF with a percent, rule FIXED with a price, tiers, or remove: true.' }
  const rule = input.rule ?? (input.percent !== undefined ? 'PERCENT_OFF' : input.price !== undefined ? 'FIXED' : now?.rule)
  if (!rule) return { error: 'This listing has no business price yet: name rule PERCENT_OFF with a percent, or FIXED with a price.' }
  const tiers = input.tiers === undefined ? now?.tiers ?? null : input.tiers
  if (rule === 'PERCENT_OFF') {
    if (input.price !== undefined) return { error: 'A price goes with rule FIXED; PERCENT_OFF takes a percent.' }
    const percent = input.percent ?? (now?.rule === 'PERCENT_OFF' ? now.percent : null)
    if (percent == null) return { error: 'PERCENT_OFF needs a percent (below the normal price).' }
    return { setting: normalisedSetting({ rule, percent, price: null, tiers }) }
  }
  if (input.percent !== undefined) return { error: 'A percent goes with rule PERCENT_OFF; FIXED takes a price.' }
  const price = input.price ?? (now?.rule === 'FIXED' ? now.price : null)
  if (price == null) return { error: 'FIXED needs a price (the exact business price).' }
  return { setting: normalisedSetting({ rule, percent: null, price, tiers }) }
}

/** The arguments that set this setting again (an undo puts a setting back by value; `null` = remove). */
export function businessArgsOf(setting: BusinessPriceSetting | null): BusinessInput {
  const s = normalisedSetting(setting)
  if (!s) return { remove: true }
  return s.rule === 'PERCENT_OFF'
    ? { rule: 'PERCENT_OFF', percent: s.percent ?? 0, tiers: s.tiers }
    : { rule: 'FIXED', price: s.price ?? 0, tiers: s.tiers }
}

const moneyOf = (currency: string | null | undefined) => (v: number) => `${currency ? `${currency} ` : ''}${v.toFixed(2)}`

/**
 * PURE — one setting in words, from the setting alone (never a computed price: the line a person approves stands on the
 * setting, not on the normal price a percent follows): `5 % below the normal price · quantity discounts 2+ 3 %, 5+ 5 %`,
 * `EUR 48.50 (exact)`, `No business price`.
 */
export function businessSettingWords(setting: BusinessPriceSetting | null, currency: string | null): string {
  const s = normalisedSetting(setting)
  if (!s) return 'No business price'
  const money = moneyOf(currency)
  const base = s.rule === 'FIXED' ? `${money(s.price ?? 0)} (exact)` : !s.percent ? 'The normal price itself' : `${s.percent} % below the normal price`
  if (!s.tiers?.levels.length) return base
  const levels = s.tiers.levels.map((l) => (s.tiers!.type === 'percent' ? `${l.minQty}+ ${l.value} %` : `${l.minQty}+ ${money(l.value)}`))
  return `${base} · quantity discounts ${levels.join(', ')}`
}

/** The pull's copy of Amazon's offer for this market: its business and normal instances (`platformAttributes.attributes`). */
function pulledOffer(platformAttributes: unknown, marketplace: string) {
  const pa = platformAttributes && typeof platformAttributes === 'object' ? (platformAttributes as Record<string, unknown>) : null
  const attrs = pa?.attributes && typeof pa.attributes === 'object' ? (pa.attributes as Record<string, unknown>) : null
  const instances = Array.isArray(attrs?.purchasable_offer) ? (attrs!.purchasable_offer as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []
  const id = amazonMarketplaceIdOf(marketplace) ?? ''
  return { business: liveBusinessInstance(instances as never, id), normal: liveNormalInstance(instances as never, id) }
}

/** An offer instance's price (`our_price[0].schedule[0]`, VAT included where Amazon says so). */
function amountOf(instance: Record<string, unknown> | null): number | null {
  const ours = Array.isArray(instance?.our_price) ? (instance!.our_price[0] as Record<string, unknown> | undefined) : undefined
  const schedule = Array.isArray(ours?.schedule) ? (ours!.schedule[0] as Record<string, unknown> | undefined) : undefined
  const v = schedule?.value_with_tax ?? schedule?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The sentence for a removal where Nexus keeps no business price and Amazon shows its own. */
export const amazonOwnRemoveReason = (price: string) =>
  `Nexus keeps no business price here; Amazon shows one of ${price}, set outside Nexus. Nexus removes only a business price it keeps: `
  + 'remove this one in Seller Central, or set one in Nexus first.'

/** #602 — a first business offer goes with the normal offer: not sent while the two shopper prices differ. */
export const firstOfferWaits = (amazon: string, nexus: string) =>
  `Not sent yet: Amazon's shopper price is ${amazon} and Nexus's is ${nexus}. A first business price is sent with the shopper `
  + 'price, so it would change what shoppers pay. Make the two prices the same; the business price is then sent by itself.'

export const REMOVAL_REACHES_AMAZON = 'Removing it also removes the business price and its quantity discounts from Amazon.'

/** What a person must read on the approval card, per listing, most serious first (`businessCardSummary`). */
export type BusinessNoteKind = 'amazonOwn' | 'firstOffer' | 'kept' | 'amazonRule' | 'removal'
export interface BusinessNote { kind: BusinessNoteKind; text: string }
const NOTE_ORDER: readonly BusinessNoteKind[] = ['amazonOwn', 'firstOffer', 'kept', 'amazonRule', 'removal']
/** The card's words for many listings with the same note. */
export const BUSINESS_NOTE_GROUP: Readonly<Record<BusinessNoteKind, string>> = {
  amazonOwn: 'Replaces Amazon\'s own business price (an undo cannot bring it back)',
  firstOffer: 'Waits until Amazon\'s shopper price is Nexus\'s',
  kept: 'Kept in Nexus, not sent yet (paused, draft or Inactive)',
  amazonRule: 'Saved with a warning (hidden by Amazon, or a sale below it)',
  removal: 'Removed at Amazon too',
}
/** The approval card shows at most this much of a summary (approval-queue.service.ts clips it). */
export const CARD_SUMMARY_MAX = 400

/** The `from` label of a line: Amazon's own business price where Nexus keeps none and Amazon shows one. */
export function businessFromWords(line: Pick<BusinessLine, 'from' | 'amazonOwn' | 'currency'>): string {
  return !line.from && line.amazonOwn ? `Amazon's own ${moneyOf(line.currency)(line.amazonOwn.price)} (set outside Nexus)` : businessSettingWords(line.from, line.currency)
}

/**
 * PURE — the card's summary of a business price change: `head`, then what a person must know before approving, most
 * serious first. One listing: each note in full. Several: per kind, how many and the first listings (`where` names one).
 * It fits the card: fewer names, then none, then the short words, then the short opening line (`shortHead`) — never a
 * note left out or cut to fit (the five kinds' short words with a short opening line always fit).
 */
export function businessCardSummary(head: string, lines: readonly BusinessLine[], where: (line: BusinessLine) => string, shortHead: string = head): string {
  if (!lines.some((l) => l.notes.length)) return head.length <= CARD_SUMMARY_MAX ? head : shortHead
  const grouped = (opening: string, names: number) => `${opening} ${NOTE_ORDER.flatMap((kind) => {
    const hit = lines.filter((l) => l.notes.some((n) => n.kind === kind))
    if (!hit.length) return []
    const named = names ? ` (${hit.slice(0, names).map(where).join(', ')}${hit.length > names ? ` and ${hit.length - names} more` : ''})` : ''
    return [`${BUSINESS_NOTE_GROUP[kind]}: ${hit.length}${named}`]
  }).join('. ')}.`
  const full = (opening: string) => {
    const words = NOTE_ORDER.flatMap((kind) => lines[0]!.notes.filter((n) => n.kind === kind).map((n) => n.text)).join('; ')
    return `${opening} ${words.charAt(0).toUpperCase()}${words.slice(1)}.`
  }
  const versions = (opening: string) => (lines.length === 1 ? [full(opening), grouped(opening, 0)] : [3, 2, 1, 0].map((names) => grouped(opening, names)))
  const candidates = [...versions(head), ...versions(shortHead)]
  return candidates.find((c) => c.length <= CARD_SUMMARY_MAX) ?? candidates.at(-1)!
}

/** The door's "not sent yet" sentence, as the card says it: `kept in Nexus, not sent yet: this listing's sync is paused`. */
function keptWords(notSent: string): string {
  const why = /Nothing was sent(?: yet)?: ([^.]+)\./.exec(notSent)?.[1]
  return why ? `kept in Nexus, not sent yet: ${why}` : 'kept in Nexus, not sent yet'
}

export interface BusinessPlanItem {
  listingId: string
  input: BusinessInput
  /** Matrix targets name the row and coordinate (set-listing-price); a bulk change names the listing only. */
  rowId?: string
  coordinateKey?: string
}

export interface BusinessLine {
  listingId: string
  productId: string
  sku: string
  marketplace: string
  rowId?: string
  coordinateKey?: string
  version: number
  from: BusinessPriceSetting | null
  to: BusinessPriceSetting | null
  currency: string | null
  /** The normal price the business price follows and is checked against (the door's). */
  normalPrice: number | null
  /** The business price the setting gives now, and the one it would give. */
  priceNow: number | null
  priceAfter: number | null
  /** Saved but worth a word: the door's warnings, why it is not sent yet, Amazon's own price it replaces, a removal. */
  warnings: string[]
  /** Amazon shows a business price Nexus never kept (set outside Nexus), when Nexus keeps none. */
  amazonOwn: { price: number } | null
  /** The same, as the approval card says it (`businessCardSummary`). */
  notes: BusinessNote[]
}

export interface BusinessPlanRefusal { listingId: string; sku: string; marketplace: string | null; rowId?: string; coordinateKey?: string; reason: string }

export interface BusinessPlan {
  lines: BusinessLine[]
  unchanged: number
  refused: BusinessPlanRefusal[]
}

/**
 * The plan of a business price change: each listing's setting now and after, refused (with the door's sentence) or
 * unchanged where the door says so. Reads only: the door runs as a dry run.
 */
export async function planBusinessPrices(items: readonly BusinessPlanItem[], actor: string): Promise<BusinessPlan> {
  const ids = [...new Set(items.map((i) => i.listingId))]
  const [rows, kept, currencyRows] = await Promise.all([
    prisma.channelListing.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, productId: true, channel: true, marketplace: true, version: true, platformAttributes: true,
        businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true, product: { select: { sku: true } },
      },
    }),
    prisma.channelListingOverride.findMany({ where: { channelListingId: { in: ids }, fieldName: 'businessPrice' }, distinct: ['channelListingId'], select: { channelListingId: true } }),
    prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { channel: true, code: true, currency: true } }) as Promise<MarketCurrencyRow[]>,
  ])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const everKept = new Set(kept.map((k) => k.channelListingId))
  const plan: BusinessPlan = { lines: [], unchanged: 0, refused: [] }
  const where = (item: BusinessPlanItem) => ({ ...(item.rowId ? { rowId: item.rowId } : {}), ...(item.coordinateKey ? { coordinateKey: item.coordinateKey } : {}) })
  const asked: Array<{ item: BusinessPlanItem; row: (typeof rows)[number]; from: BusinessPriceSetting | null; to: BusinessPriceSetting | null; amazonOwn: { price: number } | null; amazonHasOne: boolean; shopperPrice: number | null }> = []

  for (const item of items) {
    const row = byId.get(item.listingId)
    const refuse = (reason: string) => plan.refused.push({ listingId: item.listingId, sku: row?.product?.sku ?? item.listingId, marketplace: row?.marketplace ?? null, ...where(item), reason })
    if (!row) { refuse('This listing no longer exists.'); continue }
    if (row.channel !== 'AMAZON') { refuse('Only an Amazon listing has a business price.'); continue }
    const from = normalisedSetting(storedBusinessSetting(row))
    const resolved = resolveBusinessSetting(from, item.input)
    if ('error' in resolved) { refuse(resolved.error); continue }
    const offer = pulledOffer(row.platformAttributes, row.marketplace)
    const amazonOwnPrice = !from && !everKept.has(row.id) ? amountOf(offer.business) : null
    const amazonOwn = amazonOwnPrice != null ? { price: amazonOwnPrice } : null
    if (sameSetting(from, resolved.setting)) {
      // A removal where Nexus keeps none: nothing for Nexus to remove — and never Amazon's own price by a `null`.
      if (!resolved.setting && amazonOwn) refuse(amazonOwnRemoveReason(moneyOf(listingMarketCurrency(row, currencyRows))(amazonOwn.price)))
      else plan.unchanged++
      continue
    }
    asked.push({ item, row, from, to: resolved.setting, amazonOwn, amazonHasOne: !!offer.business, shopperPrice: amountOf(offer.normal) })
  }
  if (!asked.length) return plan

  const { writeBusinessPrices } = await import('../../pim/business-price-write.service.js')
  const dry = await writeBusinessPrices({ targets: asked.map((a) => ({ listingId: a.row.id, setting: a.to, expectedVersion: a.row.version })), actor, dryRun: true })
  asked.forEach((a, i) => {
    const out = dry.results[i]!
    const refuse = (reason: string) => plan.refused.push({ listingId: a.row.id, sku: a.row.product?.sku ?? a.row.id, marketplace: a.row.marketplace, ...where(a.item), reason })
    if (out.outcome === 'refused') { refuse(out.reason ?? 'The business price door refused it.'); return }
    if (out.outcome === 'conflict') { refuse(MATRIX_COPY.changedElsewhere); return }
    if (out.outcome === 'noop') { plan.unchanged++; return }
    const currency = out.currency ?? null
    const money = moneyOf(currency)
    const normalPrice = out.normalPrice ?? null
    const warnings: string[] = []
    const notes: BusinessNote[] = []
    const note = (kind: BusinessNoteKind, warning: string, text: string) => { warnings.push(warning); notes.push({ kind, text }) }
    if (a.to && a.amazonOwn) {
      note('amazonOwn', `Amazon shows a business price of ${money(a.amazonOwn.price)} set outside Nexus: this replaces it, and Nexus keeps the business price from now on. An undo cannot bring Amazon's own price back.`,
        `replaces Amazon's own business price ${money(a.amazonOwn.price)} (set outside Nexus; an undo cannot bring it back)`)
    }
    // #602 — a FIRST business offer (Amazon holds none, whatever Nexus keeps) is sent with the normal offer.
    if (a.to && !a.amazonHasOne && a.shopperPrice != null && normalPrice != null && Math.abs(a.shopperPrice - normalPrice) >= 0.005) {
      note('firstOffer', firstOfferWaits(money(a.shopperPrice), money(normalPrice)),
        `not sent while Amazon's shopper price ${money(a.shopperPrice)} is not Nexus's ${money(normalPrice)}`)
    }
    if (out.notSent) note('kept', out.notSent, keptWords(out.notSent))
    for (const w of out.warnings) note('amazonRule', w, w.replace(/\.$/, ''))
    if (!a.to) note('removal', REMOVAL_REACHES_AMAZON, 'removes the business price at Amazon too')
    plan.lines.push({
      listingId: a.row.id, productId: a.row.productId, sku: a.row.product?.sku ?? a.row.productId, marketplace: a.row.marketplace, ...where(a.item),
      version: a.row.version, from: a.from, to: a.to, currency, normalPrice,
      priceNow: a.from ? businessPriceOf(a.from, normalPrice) : null, priceAfter: out.businessPrice,
      warnings, amazonOwn: a.amazonOwn, notes,
    })
  })
  return plan
}

/** The undo's record of one listing's business setting: as it was (with Amazon's own price, when Nexus kept none). */
export interface BusinessRecord { listingId: string; rowId?: string; coordinateKey?: string; sku?: string; setting: BusinessPriceSetting | null; amazonOwn?: { price: number } }

/** What each listing keeps now, in the shape of a change's `after` (undo's compare-and-swap). */
export async function currentBusinessRecords(after: readonly BusinessRecord[]): Promise<BusinessRecord[]> {
  const rows = after.length ? await prisma.channelListing.findMany({
    where: { id: { in: after.map((r) => r.listingId) } },
    select: { id: true, businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true },
  }) : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  return after.map(({ amazonOwn: _own, sku: _sku, ...r }) => {
    const row = byId.get(r.listingId)
    return { ...r, setting: row ? normalisedSetting(storedBusinessSetting(row)) : null }
  })
}

/** The Matrix's own refusal of an undo over a business price that was Amazon's own (`matrixUndo.ts` amazonOwn). */
export const AMAZON_OWN_UNDO = 'Not put back: the business price before this change was set at Amazon, outside Nexus. Nexus never removes it to undo — '
  + 'set the business price again instead.'

/**
 * The undo of a business price change: each listing back to its setting by value, through bulk-listing-price-change
 * (one approval; a listing that moved since is refused there). Never a removal over Amazon's own price.
 */
export function businessUndoRequest(before: readonly BusinessRecord[]): { tool: string; args: Record<string, unknown> } | { refusal: string } {
  if (!before.length) return { refusal: 'This change does not name the business prices it replaced.' }
  if (before.some((r) => !r.setting && r.amazonOwn)) return { refusal: AMAZON_OWN_UNDO }
  return { tool: 'bulk-listing-price-change', args: { businessPrices: before.map((r) => ({ listingId: r.listingId, ...businessArgsOf(r.setting) })) } }
}
