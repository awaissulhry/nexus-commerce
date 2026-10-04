/**
 * Publish without surprises (2026-10-01, audit P1/P13) — the eBay review names EVERY problem it finds, once, per SKU,
 * with the sheet's column label instead of an internal key, and eBay's own check (VerifyAddFixedPriceItem) answers in the
 * same shape.
 *
 * Before, the eBay builder threw at its first problem: a family with five gaps needed five reviews, one per gap, and the
 * last one came from eBay at the final send, raw and in its own words. The builder now hands every problem it finds to
 * a collector and keeps going; only a problem that leaves nothing to build stops it, and only after the rest are noted.
 */
import type { StudioPublishIssue } from '@nexus/shared/studio-publication'
import { ebaySpecFromCache } from './channel-specs/ebay.js'

type Where = { productId?: string; sku?: string; field?: string }

/** Fields the listing builder reads that are not sheet columns of their own. */
const OTHER_LABELS: Readonly<Record<string, string>> = {
  pictures: 'Photos', itemSpecifics: 'Item specifics', ean: 'EAN', currency: 'Currency', sellerSku: 'Seller SKU',
  package: 'Package type, weight and size', fulfillment: 'Fulfillment',
  compatibility: 'Parts compatibility', regulatory: 'Product safety information', variationPictures: 'Photos by variation',
}

let labels: Map<string, string> | null = null
/** The column label the sheet shows for an eBay listing field (`itemPostalCode` → "Item location postal code"). */
export function ebayFieldLabel(key: string): string {
  labels ??= new Map(ebaySpecFromCache({ marketplace: 'IT', categoryId: '', aspects: [] }).fields.map(f => [f.key, f.englishLabel ?? f.label]))
  return labels.get(key) ?? OTHER_LABELS[key] ?? key
}

const textOf = (error: unknown) => error instanceof Error ? error.message : String(error)
/** "SKU: message" for a reader that sees only the text (the nightly content read, a refused submit). */
const sentence = (issue: StudioPublishIssue) => issue.sku && !issue.message.startsWith(`${issue.sku}:`) ? `${issue.sku}: ${issue.message}` : issue.message

/** Every problem one eBay review found. `message` keeps the old one-line form, so a reader that only logs it still can. */
export class EbayPublicationProblems extends Error {
  readonly issues: StudioPublishIssue[]
  /** Review notes found on the way (they block nothing). */
  readonly notes: string[]
  constructor(issues: StudioPublishIssue[], notes: string[] = []) {
    super(issues.map(sentence).join('\n'))
    this.name = 'EbayPublicationProblems'
    this.issues = issues
    this.notes = notes
  }
}

/**
 * Sending to eBay is off here (dry-run, gated, sandbox, or no real eBay API). The review already says so, once, in its
 * gate message; this marks "the checks ran, there is just nothing to send", so it is never shown as a second message.
 */
export class EbaySendingOff extends Error {
  readonly gateOnly = true
  constructor(readonly notes: string[] = []) { super('Sending to eBay is off here. Nothing was sent.'); this.name = 'EbaySendingOff' }
}

export interface EbayProblems {
  readonly issues: StudioPublishIssue[]
  /** Review notes that block nothing. */
  readonly notes: string[]
  add(message: string, where?: Where): void
  note(message: string): void
  /** Run one check; a refusal it throws becomes one named problem and the review goes on. */
  attempt<T>(step: () => T, where?: Where): T | undefined
  throwIfAny(): void
}

export function ebayProblems(): EbayProblems {
  const issues: StudioPublishIssue[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  const add = (message: string, where: Where = {}) => {
    const key = JSON.stringify([where.sku ?? '', message])
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ ...where, severity: 'error', message })
  }
  return {
    issues, notes, add,
    note: message => { if (!notes.includes(message)) notes.push(message) },
    attempt(step, where) {
      try { return step() } catch (error) {
        if (error instanceof EbayPublicationProblems) for (const issue of error.issues) add(issue.message, issue)
        else add(stripSku(textOf(error), where?.sku), where)
        return undefined
      }
    },
    throwIfAny() { if (issues.length) throw new EbayPublicationProblems([...issues], [...notes]) },
  }
}

/** A builder message often starts with the SKU; the review shows the SKU in its own column. */
export const stripSku = (message: string, sku?: string) => sku && message.startsWith(`${sku}: `) ? message.slice(sku.length + 2) : message

// ── eBay's own check, in the review's words ──────────────────────────────────────────────────────────────────────

/** The `<Item.X>` paths eBay names in its errors, as the sheet's fields. First match wins. */
const TAG_FIELDS: ReadonlyArray<readonly [RegExp, string]> = [
  // E1 — Best Offer auto-accept / auto-decline (Trading `Item.ListingDetails`), as the sheet's columns.
  [/^Item\.ListingDetails\.BestOfferAutoAcceptPrice/i, 'bestOfferCeiling'], [/^Item\.ListingDetails\.MinimumBestOfferPrice/i, 'bestOfferFloor'],
  [/^Item\.PostalCode/i, 'itemPostalCode'], [/^Item\.Location/i, 'itemLocation'], [/^Item\.Country/i, 'itemLocationCountry'],
  [/^Item\.ConditionID/i, 'conditionId'], [/^Item\.PrimaryCategory/i, 'categoryId'], [/^Item\.SubTitle/i, 'subtitle'], [/^Item\.Title/i, 'title'],
  [/^Item\.Description/i, 'description'], [/StartPrice/i, 'price'], [/Quantity(?!Restriction)/i, 'quantity'],
  [/^Item\.(?:PictureDetails|Variations\.Pictures)/i, 'pictures'], [/^Item\.ItemSpecifics/i, 'itemSpecifics'],
  [/SellerShippingProfile|ShippingProfileID/i, 'fulfillmentPolicyId'], [/SellerPaymentProfile|PaymentProfileID/i, 'paymentPolicyId'],
  [/SellerReturnProfile|ReturnProfileID/i, 'returnPolicyId'], [/^Item\.DispatchTimeMax/i, 'handlingTime'], [/^Item\.ShippingPackageDetails/i, 'package'],
  [/^Item\.VATDetails/i, 'vatRate'], [/^Item\.BestOfferDetails/i, 'bestOffer'], [/^Item\.QuantityRestrictionPerBuyer/i, 'quantityLimitPerBuyer'],
  [/EAN/i, 'ean'], [/^Item\.Currency/i, 'currency'], [/^Item\.ListingDuration/i, 'listingDuration'], [/^Item\.Variations/i, 'variationTheme'],
]

/** E1 — eBay's Best Offer price errors often name no `<Item.X>` tag; their words say which price. First match wins. */
const TEXT_FIELDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/MinimumBestOfferPrice|auto[- ]?decline|minimum best offer/i, 'bestOfferFloor'], [/BestOfferAutoAcceptPrice|auto[- ]?accept/i, 'bestOfferCeiling'],
]

const decode = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')

export interface TradingError { code: string; severity: 'error' | 'warning'; short: string; long: string; parameters: string[] }

/** Each `<Errors>` block of a Trading answer, with its own severity (eBay mixes Errors and Warnings in one answer). */
export function tradingErrors(raw: string): TradingError[] {
  return [...raw.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)].map(match => {
    const block = match[1]
    const tag = (name: string) => decode(block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '').trim()
    return { code: tag('ErrorCode'), severity: tag('SeverityCode') === 'Warning' ? 'warning' as const : 'error' as const,
      short: tag('ShortMessage'), long: tag('LongMessage'),
      parameters: [...block.matchAll(/<ErrorParameters\b[^>]*>\s*<Value>([\s\S]*?)<\/Value>/g)].map(m => decode(m[1]).trim()) }
  })
}

const GENERIC = /^(?:input data(?: for tag .*)? is invalid\.?|invalid input\.?|missing input\.?)$/i

/**
 * One eBay error or warning as a review issue: a plain sentence naming the sheet's column when eBay names an `<Item.X>`
 * tag, and eBay's own text (with its code) as the detail. eBay answers in English here (`ErrorLanguage` en_US).
 */
export function ebayCheckIssue(error: TradingError): StudioPublishIssue {
  const said = [error.long, ...error.parameters].join(' ')
  const path = said.match(/<?\b(Item\.[A-Za-z][\w.]*)>?/)?.[1]
  const field = path ? TAG_FIELDS.find(([pattern]) => pattern.test(path))?.[1] : TEXT_FIELDS.find(([pattern]) => pattern.test(`${error.short} ${said}`))?.[1]
  const short = error.short.replace(/\s+/g, ' ').trim()
  const message = field
    ? `${ebayFieldLabel(field)}: ${!short || GENERIC.test(short) ? 'eBay says this is missing or not valid.' : `eBay says: ${short}`}`
    : `eBay says: ${short || error.long || `error ${error.code || 'without a message'}`}`
  const detail = [error.long || error.short, error.code ? `(eBay code ${error.code})` : ''].filter(Boolean).join(' ')
  return { severity: error.severity, message, ...(field ? { field } : {}), ...(detail && detail !== short ? { detail } : {}) }
}
