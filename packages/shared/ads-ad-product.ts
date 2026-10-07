/**
 * ads-ad-product.ts — WHICH AMAZON AD PRODUCT A CAMPAIGN IS, and the one sentence that refuses a change Nexus cannot make.
 *
 * 6a (2026-10-04; review G.1, Owner decision S8). Nexus changes Sponsored Products campaigns only. Every update path
 * sends to a Sponsored Products endpoint (/sp/campaigns, /sp/adGroups, /sp/keywords, /sp/targets, /sp/productAds,
 * /sp/negativeKeywords), and a Sponsored Brands or Display id is unknown there: a budget lands nowhere, and a keyword
 * Amazon answers "not found" for is marked orphaned although it is healthy. Native SB/SD updates are not built, so
 * those changes are refused before Nexus or Amazon changes, with the sentence below — everywhere the same words.
 *
 * Creating SB/SD campaigns, ad groups, keywords and ads is NOT refused here: those calls go to their own endpoints.
 *
 * W4-11 (2026-10-07; reverses S8 for these writes) — Nexus now sends some changes to an EXISTING Sponsored Brands or
 * Display campaign through their own endpoints (ads-api-client.ts): its daily budget and on/off state, the bid and on/off
 * state of its keywords and targets, adding a negative (SB: a negative keyword in an ad group; SD: a negative product
 * target) and retiring one. `adWriteRefusal` says, for one write, whether it is one of them. `adProductRefusal` stays the
 * sentence for every path that is still Sponsored Products only (placements, the bulk sheet, the engines), and for a
 * write that does not say what it is.
 */

export type AdProduct = 'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS' | 'SPONSORED_DISPLAY' | 'SPONSORED_TELEVISION' | 'DSP'

export const SPONSORED_PRODUCTS: AdProduct = 'SPONSORED_PRODUCTS'
export const SPONSORED_BRANDS: AdProduct = 'SPONSORED_BRANDS'
export const SPONSORED_DISPLAY: AdProduct = 'SPONSORED_DISPLAY'

/** The write gate's `deniedAt` (and a placement refusal's) for a change to a campaign that is not Sponsored Products. */
export const AD_PRODUCT_UNSUPPORTED = 'ad_product_unsupported'

/** The two columns a Campaign row carries: v1 `adProduct` (may be null on old rows) and the legacy `type` enum (required). */
export interface AdProductSource {
  adProduct?: string | null
  type?: string | null
  name?: string | null
  /** W4-11 — Amazon's budget object (`Campaign.budgetJson`): a Sponsored Brands lifetime budget is not set from Nexus. */
  budgetJson?: unknown
}

/** The legacy `CampaignType` codes, also accepted in the `adProduct` column. */
const FROM_CODE: Record<string, AdProduct> = {
  SP: 'SPONSORED_PRODUCTS',
  SB: 'SPONSORED_BRANDS',
  SD: 'SPONSORED_DISPLAY',
  DSP: 'DSP',
}

const LABEL: Record<string, string> = {
  SPONSORED_PRODUCTS: 'Sponsored Products',
  SPONSORED_BRANDS: 'Sponsored Brands',
  SPONSORED_DISPLAY: 'Sponsored Display',
  SPONSORED_TELEVISION: 'Sponsored TV',
  DSP: 'Amazon DSP',
}

/**
 * The campaign's ad product: the v1 `adProduct` column when set, else the legacy `type` enum. Null when neither says
 * (a select that left both out). An unrecognised value is returned as given, upper-cased, so it is never mistaken for
 * Sponsored Products.
 */
export function adProductOf(campaign: AdProductSource | null | undefined): string | null {
  const read = (v: string | null | undefined) => {
    const s = (v ?? '').trim().toUpperCase()
    return s ? (FROM_CODE[s] ?? s) : null
  }
  return read(campaign?.adProduct) ?? read(campaign?.type)
}

/** Plain name of an ad product for a sentence ("Sponsored Brands"); null when unknown. */
export function adProductLabel(adProduct: string | null | undefined): string | null {
  return adProduct ? (LABEL[adProduct] ?? adProduct) : null
}

/**
 * The one sentence that refuses a change to a campaign that is not Sponsored Products; null when Nexus may make it.
 *
 * `unknown` decides a campaign whose ad product neither column states: `'refuse'` (the default, fail closed — Claude's
 * change tools) or `'allow'` (the mutation layer and the write gate: `Campaign.type` is a required column, so a real row
 * always states it, and a partial select must not refuse a Sponsored Products write).
 */
export function adProductRefusal(
  campaign: AdProductSource | null | undefined,
  opts: { unknown?: 'refuse' | 'allow' } = {},
): string | null {
  const product = adProductOf(campaign)
  if (product === SPONSORED_PRODUCTS) return null
  if (product == null && opts.unknown === 'allow') return null
  const who = campaign?.name?.trim() || 'This campaign'
  const what = product ? ` (it is ${adProductLabel(product)})` : ''
  return `${who} is not a Sponsored Products campaign${what}. Nexus changes Sponsored Products campaigns only for now, so nothing was sent to Amazon; make this change in Amazon's advertising console.`
}

// ── W4-11 — the Sponsored Brands and Display changes Nexus can send ──────────────────────────────────────────────────

/** W4-11 — one write, as the mutation layer, the write gate and the change tools describe it. */
export interface AdWrite {
  /** What is written. `NEGATIVE_CREATE`: a new negative. `PLACEMENT`: a placement adjustment (Sponsored Products only). */
  entity: 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'PRODUCT_AD' | 'PORTFOLIO' | 'PLACEMENT' | 'NEGATIVE_CREATE'
  /** Every field it changes (`dailyBudget`, `status`, `bid`, …). */
  fields?: ReadonlyArray<string | null | undefined> | null
  /** The state a `status` change sets: ENABLED | PAUSED | ARCHIVED (any case). */
  toStatus?: string | null
  /** A target's or a new negative's kind (`AdTarget.kind`: KEYWORD | PRODUCT | CATEGORY | AUDIENCE | AUTO). */
  kind?: string | null
  /** The target is a negative. */
  isNegative?: boolean | null
  /** A negative's level: AD_GROUP (or null) | CAMPAIGN. */
  negativeLevel?: string | null
}

const SBSD_CAMPAIGN_FIELDS = new Set(['dailyBudget', 'dailyBudgetCurrency', 'status'])
const SBSD_TARGET_FIELDS = new Set(['bid', 'status'])
const ON_OFF = new Set(['ENABLED', 'PAUSED'])
const ENTITY_WORDS: Record<AdWrite['entity'], string> = {
  CAMPAIGN: 'the campaign', AD_GROUP: 'an ad group', AD_TARGET: 'a target', PRODUCT_AD: 'an ad',
  PORTFOLIO: 'a portfolio', PLACEMENT: 'the placement adjustments', NEGATIVE_CREATE: 'a new negative',
}

/** The negatives Nexus adds and retires: SB a negative keyword in an ad group, SD a negative product target (an ASIN). */
function negativeSupported(product: string, kind: string, level: string): boolean {
  if (level === 'CAMPAIGN') return false
  return product === SPONSORED_BRANDS ? kind === 'KEYWORD' : product === SPONSORED_DISPLAY ? kind === 'PRODUCT' : false
}

/** What of this write Nexus cannot send for an SB or SD campaign, in a few words; null when it can send all of it. */
function sbSdProblem(product: string, w: AdWrite): string | null {
  const fields = (w.fields ?? []).filter((f): f is string => !!f)
  const status = (w.toStatus ?? '').trim().toUpperCase()
  const kind = (w.kind ?? '').trim().toUpperCase()
  const level = (w.negativeLevel ?? '').trim().toUpperCase()
  const negativeWords = product === SPONSORED_BRANDS ? 'a negative other than a keyword in an ad group' : 'a negative other than a product target (an ASIN) in an ad group'
  switch (w.entity) {
    case 'CAMPAIGN': {
      const other = fields.filter((f) => !SBSD_CAMPAIGN_FIELDS.has(f))
      if (other.length) return `the campaign's ${other.join(', ')}`
      if (fields.includes('status') && !ON_OFF.has(status)) return status === 'ARCHIVED' ? 'archiving the campaign' : 'that campaign state'
      return null
    }
    case 'AD_TARGET': {
      if (w.isNegative === true) {
        if (!negativeSupported(product, kind, level)) return negativeWords
        if (fields.some((f) => f !== 'status') || status !== 'ARCHIVED') return 'a change to a negative other than retiring it'
        return null
      }
      if (product === SPONSORED_BRANDS && kind !== 'KEYWORD' && kind !== 'PRODUCT' && kind !== 'CATEGORY') return 'that kind of target'
      if (product === SPONSORED_DISPLAY && (kind === 'KEYWORD' || !kind)) return 'that kind of target'
      const other = fields.filter((f) => !SBSD_TARGET_FIELDS.has(f))
      if (other.length) return `a target's ${other.join(', ')}`
      if (fields.includes('status') && !ON_OFF.has(status)) return status === 'ARCHIVED' ? 'archiving a target' : 'that target state'
      return null
    }
    case 'NEGATIVE_CREATE':
      return negativeSupported(product, kind, level) ? null : negativeWords
    default:
      return `a change to ${ENTITY_WORDS[w.entity] ?? 'it'}`
  }
}

/** The changes Nexus sends for each ad product it changes besides Sponsored Products, in one sentence. */
function sbSdCan(product: string): string {
  return product === SPONSORED_BRANDS
    ? 'its daily budget and on/off state, the bids and on/off state of its keywords and product targets, and its negative keywords in an ad group (add and retire)'
    : 'its daily budget and on/off state, the bids and on/off state of its targets, and its negative product targets in an ad group (add and retire)'
}

/**
 * W4-11 — the one sentence that refuses this write to this campaign; null when Nexus can send it.
 *
 * Sponsored Products: never refused here. Sponsored Brands and Display: refused unless the write is one of the changes
 * Nexus sends through their own endpoints (sbSdProblem), and refused with `adProductRefusal`'s sentence when the caller
 * does not say what the write is (`write` null): a caller that does not describe its write is a Sponsored Products path.
 * Any other ad product (Sponsored TV, DSP): `adProductRefusal`'s sentence. `unknown` as for `adProductRefusal`.
 */
export function adWriteRefusal(
  campaign: AdProductSource | null | undefined,
  write: AdWrite | null | undefined,
  opts: { unknown?: 'refuse' | 'allow' } = {},
): string | null {
  const product = adProductOf(campaign)
  if (product === SPONSORED_PRODUCTS) return null
  if (product == null && opts.unknown === 'allow') return null
  if (!write || (product !== SPONSORED_BRANDS && product !== SPONSORED_DISPLAY)) return adProductRefusal(campaign, opts)
  const problem = sbSdProblem(product, write)
  const who = campaign?.name?.trim() || 'This campaign'
  if (!problem) {
    const budget = write.entity === 'CAMPAIGN' && (write.fields ?? []).includes('dailyBudget')
    if (budget && product === SPONSORED_BRANDS && isLifetimeBudget(campaign?.budgetJson)) {
      return `${who} is a Sponsored Brands campaign with a lifetime budget at Amazon. Nexus sets a daily budget only, so nothing was sent to Amazon; change it in Amazon's advertising console.`
    }
    return null
  }
  return `${who} is a ${adProductLabel(product)} campaign. Nexus changes ${sbSdCan(product)} — not ${problem} — so nothing was sent to Amazon; make this change in Amazon's advertising console.`
}

/**
 * W4-11 — a Sponsored Brands campaign whose budget at Amazon is a LIFETIME budget (SB v4 `budgetType`; the v1 sync keeps
 * Amazon's budget object in `Campaign.budgetJson`). Nexus counts a daily budget, so it does not set one there.
 */
export function isLifetimeBudget(budgetJson: unknown): boolean {
  const b = (budgetJson ?? {}) as { budgetType?: unknown; recurrenceTimePeriod?: unknown }
  return [b.budgetType, b.recurrenceTimePeriod].some((v) => typeof v === 'string' && v.trim().toUpperCase() === 'LIFETIME')
}
