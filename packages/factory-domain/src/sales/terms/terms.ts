import type { Issue } from '../../core/errors'
import { fitsDecimal, INT_MAX, isCurrencyCode, minorPlaces, type CurrencyCode, type MinorUnits } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { formatPercent } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import { decimalText } from '../../product/units/units'
import { Dec, HUNDRED, parseDecimal, ZERO, type Decimal } from '../../tax/decimal'

/**
 * Payment terms and the customer's commercial terms (B-W2a-19; FIN-075 "Payment terms library", SAL-012 "Commercial
 * terms on the account"; design finance.settings "Payment terms", sales.customers customer.tax.terms), pure.
 *
 * A payment terms entry (factory-db pricing.prisma PaymentTerms) is how a customer pays: the name printed on its
 * documents (in the company's language, others in nameI18n), the FatturaPA payment method (ModalitaPagamento MP01…MP23:
 * MP05 bank transfer, MP12 Ri.Ba. …) and its instalments: what share falls due when, the shares totalling 100.
 *
 *   from              the event an instalment counts from
 *   ORDER             the order: a deposit, asked at acceptance (at most one instalment; its days are the deposit's due
 *                     days, else DEPOSIT_DUE_DAYS of sales/quotes/terms)
 *   BEFORE_SHIPPING   before the goods leave (the balance before shipping)
 *   DELIVERY          the delivery
 *   INVOICE           the invoice's date: "30 gg d.f.f.m." is INVOICE, 30 days, end of month
 *
 * A due date is the event's day + days, then, with endOfMonth, the last day of that month (the factory-db comment's
 * rule). An amount is split by share in minor units, the last instalment taking what rounding left, so the parts always
 * total the whole. FatturaPA CondizioniPagamento: one instalment TP02 (complete), TP03 when it is an advance (ORDER),
 * more TP01 (in instalments). The early-payment discount (ScontoPagamentoAnticipato) is a percent for paying within
 * that many days of the invoice.
 *
 * The customer's commercial terms (factory-db parties.prisma Party): its payment terms and price list from the libraries,
 * its default deposit, how its goods are invoiced (per shipment: an immediate invoice TD01; monthly: one deferred invoice
 * TD24 for the month's DDTs), its Incoterms 2020 rule, preferred carrier and minimum order. A new quote copies them
 * (`quoteDefaultsOf`); a quote version and an order keep their own copy.
 */

export const INSTALMENT_EVENTS = ['ORDER', 'BEFORE_SHIPPING', 'DELIVERY', 'INVOICE'] as const
export type InstalmentEvent = (typeof INSTALMENT_EVENTS)[number]

/** The FatturaPA payment methods (ModalitaPagamento, Allegato A, tracciato 1.2.x), in words. */
export const PAYMENT_METHODS = {
  MP01: { it: 'Contanti', en: 'Cash' },
  MP02: { it: 'Assegno', en: 'Cheque' },
  MP03: { it: 'Assegno circolare', en: "Banker's draft" },
  MP04: { it: 'Contanti presso Tesoreria', en: 'Cash at the Treasury' },
  MP05: { it: 'Bonifico bancario', en: 'Bank transfer' },
  MP06: { it: 'Vaglia cambiario', en: 'Promissory note' },
  MP07: { it: 'Bollettino bancario', en: 'Bank payment slip' },
  MP08: { it: 'Carta di pagamento', en: 'Payment card' },
  MP09: { it: 'RID', en: 'Direct debit (RID)' },
  MP10: { it: 'RID utenze', en: 'Utility direct debit (RID)' },
  MP11: { it: 'RID veloce', en: 'Fast direct debit (RID)' },
  MP12: { it: 'Ri.Ba.', en: 'Bank receipt (Ri.Ba.)' },
  MP13: { it: 'MAV', en: 'Payment notice (MAV)' },
  MP14: { it: 'Quietanza erario', en: 'Tax office receipt' },
  MP15: { it: 'Giroconto su conti di contabilità speciale', en: 'Transfer to a special account' },
  MP16: { it: 'Domiciliazione bancaria', en: 'Bank direct debit order' },
  MP17: { it: 'Domiciliazione postale', en: 'Postal direct debit order' },
  MP18: { it: 'Bollettino di c/c postale', en: 'Postal account slip' },
  MP19: { it: 'SEPA Direct Debit', en: 'SEPA Direct Debit' },
  MP20: { it: 'SEPA Direct Debit CORE', en: 'SEPA Direct Debit CORE' },
  MP21: { it: 'SEPA Direct Debit B2B', en: 'SEPA Direct Debit B2B' },
  MP22: { it: 'Trattenuta su somme già riscosse', en: 'Deduction from sums already collected' },
  MP23: { it: 'PagoPA', en: 'PagoPA' },
} as const satisfies Record<string, { it: string; en: string }>
export type PaymentMethod = keyof typeof PAYMENT_METHODS
export const PAYMENT_METHOD_CODES = Object.freeze(Object.keys(PAYMENT_METHODS) as PaymentMethod[])
export const isPaymentMethod = (value: unknown): value is PaymentMethod => typeof value === 'string' && Object.hasOwn(PAYMENT_METHODS, value)

export const TERMS_LIMITS = { code: 20, name: 200, instalments: 12, languages: 10, days: 366 } as const
const CODE = /^[A-Z0-9][A-Z0-9._-]*$/
const LANGUAGE = /^[a-z]{2}$/

/** One instalment as stored (PaymentTerms.instalments): the share with 4 places, as the database guard reads it. */
export interface Instalment {
  readonly sharePct: string
  readonly from: InstalmentEvent
  readonly days: number
  readonly endOfMonth: boolean
}

export interface InstalmentInput {
  readonly sharePct: string
  readonly from: InstalmentEvent
  readonly days: number
  readonly endOfMonth?: boolean | undefined
}

export interface PaymentTermsInput {
  readonly code: string
  readonly name: string
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly method: string
  readonly instalments: readonly InstalmentInput[]
  readonly earlyPaymentDiscountPct?: string | null | undefined
  readonly earlyPaymentDays?: number | null | undefined
}

/** Payment terms as written to the table. */
export interface PaymentTermsFields {
  readonly code: string
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
  readonly method: PaymentMethod
  readonly instalments: readonly Instalment[]
  readonly earlyPaymentDiscountPct: string | null
  readonly earlyPaymentDays: number | null
}

const share = (value: Decimal): string => value.toFixed(4)
const isDays = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TERMS_LIMITS.days

/** The terms as given, checked and normalised (codes in capitals, shares with 4 places), or what is wrong, in words. */
export function checkPaymentTerms(input: PaymentTermsInput): { ok: true; terms: PaymentTermsFields } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = []
  const code = input.code.trim().toUpperCase()
  if (code === '' || code.length > TERMS_LIMITS.code || !CODE.test(code)) issues.push({ path: 'code', message: `A code of 1 to ${TERMS_LIMITS.code} letters, digits, dots, dashes or underscores (BB30FM).` })
  const name = input.name.trim()
  if (name === '' || name.length > TERMS_LIMITS.name) issues.push({ path: 'name', message: `The printed name, 1 to ${TERMS_LIMITS.name} characters.` })
  let nameI18n: Record<string, string> | null = null
  if (input.nameI18n) {
    const entries = Object.entries(input.nameI18n).map(([language, text]) => [language.trim().toLowerCase(), text.trim()] as const).filter(([, text]) => text !== '')
    if (entries.length > TERMS_LIMITS.languages) issues.push({ path: 'nameI18n', message: `At most ${TERMS_LIMITS.languages} other languages.` })
    for (const [language, text] of entries) {
      if (!LANGUAGE.test(language)) issues.push({ path: `nameI18n/${language}`, message: 'A language is its ISO 639-1 code (en, de, fr…).' })
      if (text.length > TERMS_LIMITS.name) issues.push({ path: `nameI18n/${language}`, message: `The printed name, at most ${TERMS_LIMITS.name} characters.` })
    }
    nameI18n = entries.length > 0 ? Object.fromEntries(entries) : null
  }
  if (!isPaymentMethod(input.method)) issues.push({ path: 'method', message: 'A FatturaPA payment method, MP01 to MP23 (MP05 bank transfer, MP12 Ri.Ba.).' })

  const instalments: Instalment[] = []
  if (input.instalments.length === 0 || input.instalments.length > TERMS_LIMITS.instalments) issues.push({ path: 'instalments', message: `1 to ${TERMS_LIMITS.instalments} instalments.` })
  let total = ZERO
  for (const [index, item] of input.instalments.entries()) {
    const at = `instalments/${index}`
    const value = parseDecimal(item.sharePct)
    if (value === null || !fitsDecimal(item.sharePct, 7, 4) || value.lte(0) || value.gt(100)) issues.push({ path: `${at}/sharePct`, message: 'A share above 0 and at most 100 percent, with at most 4 decimals.' })
    if (!(INSTALMENT_EVENTS as readonly string[]).includes(item.from)) issues.push({ path: `${at}/from`, message: 'The event it counts from: ORDER, BEFORE_SHIPPING, DELIVERY or INVOICE.' })
    if (!isDays(item.days)) issues.push({ path: `${at}/days`, message: `Whole days after it, 0 to ${TERMS_LIMITS.days}.` })
    if (value !== null && value.gt(0)) total = total.plus(value)
    instalments.push({ sharePct: value === null ? '0.0000' : share(value), from: item.from, days: item.days, endOfMonth: item.endOfMonth === true })
  }
  if (input.instalments.length > 0 && !total.eq(HUNDRED)) issues.push({ path: 'instalments', message: `The shares total ${decimalText(total.toFixed(4))}%: they must total 100%.` })
  if (instalments.filter((item) => item.from === 'ORDER').length > 1) issues.push({ path: 'instalments', message: 'At most one instalment on the order: it is the deposit asked at acceptance.' })

  const discount = input.earlyPaymentDiscountPct === undefined || input.earlyPaymentDiscountPct === null || input.earlyPaymentDiscountPct.trim() === '' ? null : input.earlyPaymentDiscountPct.trim()
  const days = input.earlyPaymentDays ?? null
  if ((discount === null) !== (days === null)) issues.push({ path: 'earlyPaymentDiscountPct', message: 'An early-payment discount has its percent and its days, both or neither.' })
  if (discount !== null) {
    const value = parseDecimal(discount)
    if (value === null || !fitsDecimal(discount, 7, 4) || value.lte(0) || value.gte(100)) issues.push({ path: 'earlyPaymentDiscountPct', message: 'An early-payment discount above 0 and below 100 percent.' })
  }
  if (days !== null && !isDays(days)) issues.push({ path: 'earlyPaymentDays', message: `Pay within 0 to ${TERMS_LIMITS.days} days of the invoice.` })
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    terms: {
      code,
      name,
      nameI18n,
      method: input.method as PaymentMethod,
      instalments,
      earlyPaymentDiscountPct: discount === null ? null : share(parseDecimal(discount)!),
      earlyPaymentDays: days,
    },
  }
}

/** The stored instalments (Json) read back; a malformed entry is dropped (the database guard never stores one). */
export function instalmentsOf(value: unknown): Instalment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const entry = item as Partial<Record<keyof Instalment, unknown>> | null
    if (!entry || typeof entry.sharePct !== 'string' || !(INSTALMENT_EVENTS as readonly unknown[]).includes(entry.from) || !isDays(entry.days)) return []
    return [{ sharePct: entry.sharePct, from: entry.from as InstalmentEvent, days: entry.days, endOfMonth: entry.endOfMonth === true }]
  })
}

/** The printed name in a document's language: its own text in nameI18n, else the name (the company's language). */
export function termsNameIn(terms: { readonly name: string; readonly nameI18n: unknown }, language: string): string {
  const texts = terms.nameI18n
  if (texts !== null && typeof texts === 'object' && !Array.isArray(texts)) {
    const text = (texts as Record<string, unknown>)[language]
    if (typeof text === 'string' && text.trim() !== '') return text.trim()
  }
  return terms.name
}

/** The deposit the terms ask on the order: its share and its due days after the acceptance; null: none. */
export function depositOf(instalments: readonly Instalment[]): { readonly sharePct: string; readonly days: number } | null {
  const order = instalments.find((item) => item.from === 'ORDER')
  return order ? { sharePct: decimalText(order.sharePct), days: order.days } : null
}

/** The last day of a calendar day's month. */
export function endOfMonth(day: BusinessDate): BusinessDate {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  date.setUTCDate(0)
  return date.toISOString().slice(0, 10)
}

/** An instalment's due day from its event's day: + days, then the month's last day with endOfMonth. */
export function dueDateOf(eventDay: BusinessDate, item: Pick<Instalment, 'days' | 'endOfMonth'>): BusinessDate {
  if (!isBusinessDate(eventDay)) throw new RangeError(`not a calendar day: ${eventDay}`)
  const date = new Date(`${eventDay}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + item.days)
  const day = date.toISOString().slice(0, 10)
  return item.endOfMonth ? endOfMonth(day) : day
}

/** `amount` split by the shares, in minor units: each share rounded half up, the last part takes the rest. */
export function splitByShare(amount: MinorUnits, shares: readonly string[]): MinorUnits[] {
  if (shares.length === 0) return []
  const total = shares.reduce((sum, value) => sum.plus(new Dec(value)), ZERO)
  const parts: MinorUnits[] = []
  let left = amount
  for (const [index, value] of shares.entries()) {
    if (index === shares.length - 1) {
      parts.push(left)
      break
    }
    const part = Number.parseInt(new Dec(amount).times(new Dec(value)).dividedBy(total).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10)
    parts.push(part)
    left -= part
  }
  return parts
}

export interface ScheduledInstalment extends Instalment {
  /** 10, 20, 30 … */
  readonly seq: number
  /** The amount due, VAT included, in minor units. */
  readonly amount: MinorUnits
}

/** What the whole of a gross amount falls due as (an order's payment schedule, SAL-216): one part per instalment. */
export function scheduleOf(instalments: readonly Instalment[], gross: MinorUnits): ScheduledInstalment[] {
  const amounts = splitByShare(gross, instalments.map((item) => item.sharePct))
  return instalments.map((item, index) => ({ ...item, seq: (index + 1) * 10, amount: amounts[index]! }))
}

/** FatturaPA CondizioniPagamento of the instalments an invoice carries. */
export type PaymentCondition = 'TP01' | 'TP02' | 'TP03'

export interface InvoiceDue {
  /** FatturaPA DatiPagamento/CondizioniPagamento. */
  readonly condition: PaymentCondition
  readonly method: PaymentMethod
  /** One DettaglioPagamento per instalment: its due day and amount. */
  readonly instalments: readonly { readonly dueDate: BusinessDate; readonly amount: MinorUnits }[]
  /** ScontoPagamentoAnticipato + DataLimitePagamentoAnticipato, when the terms give one. */
  readonly earlyPayment: { readonly discountPct: string; readonly byDate: BusinessDate } | null
}

/**
 * When an invoice of `amount` (what is left to pay on it, VAT included) falls due under the terms: the instalments that
 * count from the invoice, their shares taken among themselves; terms whose instalments all come before the invoice
 * (a deposit and the balance before shipping) leave one instalment due on the invoice's day.
 */
export function invoiceDueOf(terms: { readonly method: string; readonly instalments: readonly Instalment[]; readonly earlyPaymentDiscountPct: string | null; readonly earlyPaymentDays: number | null }, invoiceDay: BusinessDate, amount: MinorUnits): InvoiceDue {
  const onInvoice = terms.instalments.filter((item) => item.from === 'INVOICE')
  const items = onInvoice.length > 0 ? onInvoice : [{ sharePct: '100.0000', from: 'INVOICE' as const, days: 0, endOfMonth: false }]
  const amounts = splitByShare(amount, items.map((item) => item.sharePct))
  return {
    condition: items.length > 1 ? 'TP01' : 'TP02',
    method: isPaymentMethod(terms.method) ? terms.method : 'MP05',
    instalments: items.map((item, index) => ({ dueDate: dueDateOf(invoiceDay, item), amount: amounts[index]! })),
    earlyPayment:
      terms.earlyPaymentDiscountPct !== null && terms.earlyPaymentDays !== null
        ? { discountPct: decimalText(terms.earlyPaymentDiscountPct), byDate: dueDateOf(invoiceDay, { days: terms.earlyPaymentDays, endOfMonth: false }) }
        : null,
  }
}

/** FatturaPA CondizioniPagamento of a deposit invoice (TD02): an advance. */
export const DEPOSIT_PAYMENT_CONDITION: PaymentCondition = 'TP03'

const EVENT_WORDS: Readonly<Record<DocumentLanguage, Readonly<Record<InstalmentEvent, (days: number, endOfMonth: boolean) => string>>>> = {
  it: {
    ORDER: (days) => (days === 0 ? "all'ordine" : `entro ${days} gg dall'ordine`),
    BEFORE_SHIPPING: (days) => (days === 0 ? 'prima della spedizione' : `${days} gg prima della spedizione`),
    DELIVERY: (days, eom) => (days === 0 && !eom ? 'alla consegna' : `a ${days} gg dalla consegna${eom ? ' fine mese' : ''}`),
    INVOICE: (days, eom) => (days === 0 && !eom ? 'a vista fattura' : `a ${days} gg data fattura${eom ? ' fine mese' : ''}`),
  },
  en: {
    ORDER: (days) => (days === 0 ? 'with the order' : `within ${days} days of the order`),
    BEFORE_SHIPPING: (days) => (days === 0 ? 'before shipping' : `${days} days before shipping`),
    DELIVERY: (days, eom) => (days === 0 && !eom ? 'on delivery' : `${days} days from delivery${eom ? ', end of month' : ''}`),
    INVOICE: (days, eom) => (days === 0 && !eom ? 'on the invoice' : `${days} days from the invoice${eom ? ', end of month' : ''}`),
  },
}

/** The terms in words, for the library's list and the screens: "Bonifico bancario: 30% all'ordine · 70% prima della spedizione". */
export function termsSummary(terms: { readonly method: string; readonly instalments: readonly Instalment[]; readonly earlyPaymentDiscountPct: string | null; readonly earlyPaymentDays: number | null }, language: DocumentLanguage): string {
  const words = EVENT_WORDS[language]
  const parts = terms.instalments.map((item) => `${formatPercent(decimalText(item.sharePct), language)} ${words[item.from](item.days, item.endOfMonth)}`)
  const method = isPaymentMethod(terms.method) ? PAYMENT_METHODS[terms.method][language] : terms.method
  const early =
    terms.earlyPaymentDiscountPct !== null && terms.earlyPaymentDays !== null
      ? language === 'it'
        ? ` · sconto ${formatPercent(decimalText(terms.earlyPaymentDiscountPct), language)} entro ${terms.earlyPaymentDays} gg`
        : ` · ${formatPercent(decimalText(terms.earlyPaymentDiscountPct), language)} off within ${terms.earlyPaymentDays} days`
      : ''
  return `${method}: ${parts.join(' · ')}${early}`
}

// ---- the customer's commercial terms (SAL-012) ---------------------------------------------------------------------

/** The Incoterms 2020 rules (ICC). */
export const INCOTERMS_2020 = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'] as const
export type Incoterm = (typeof INCOTERMS_2020)[number]

/** How a customer's goods are invoiced (Party.invoiceTiming). */
export const INVOICE_TIMINGS = ['PER_SHIPMENT', 'MONTHLY'] as const
export type InvoiceTiming = (typeof INVOICE_TIMINGS)[number]

/**
 * The invoice a customer's shipped goods get by default (the W1 "TD01 / TD24" preset): per shipment an immediate invoice
 * (TD01, within 12 days of the DDT), monthly one deferred invoice (TD24) for the month's DDTs by the 15th of the next
 * month (DPR 633/1972 art. 21 c.4 lett. a). The invoicing module may still pick the other while it is in time.
 */
export const invoiceTypePreset = (timing: InvoiceTiming): 'TD01' | 'TD24' => (timing === 'MONTHLY' ? 'TD24' : 'TD01')

export const CARRIER_CODE_MAX = 50

export interface CommercialTermsPatch {
  readonly defaultDepositPct?: string | null | undefined
  readonly incoterm?: string | null | undefined
  readonly preferredCarrierCode?: string | null | undefined
  readonly minimumOrderAmount?: number | null | undefined
  readonly currency?: string | undefined
  readonly language?: string | undefined
}

/** The plain fields of a change of the commercial terms, checked (the references are the module's: they need the tables). */
export function commercialTermsProblems(patch: CommercialTermsPatch): Issue[] {
  const issues: Issue[] = []
  if (patch.defaultDepositPct !== undefined && patch.defaultDepositPct !== null) {
    const value = parseDecimal(patch.defaultDepositPct)
    if (value === null || !fitsDecimal(patch.defaultDepositPct, 7, 4) || value.lte(0) || value.gt(100)) issues.push({ path: 'defaultDepositPct', message: 'A default deposit above 0 and at most 100 percent of the gross total, or none.' })
  }
  if (patch.incoterm !== undefined && patch.incoterm !== null && !(INCOTERMS_2020 as readonly string[]).includes(patch.incoterm)) {
    issues.push({ path: 'incoterm', message: `An Incoterms 2020 rule: ${INCOTERMS_2020.join(', ')}.` })
  }
  if (patch.preferredCarrierCode !== undefined && patch.preferredCarrierCode !== null && (patch.preferredCarrierCode.trim() === '' || patch.preferredCarrierCode.trim().length > CARRIER_CODE_MAX)) {
    issues.push({ path: 'preferredCarrierCode', message: `The carrier's code as on a shipment, 1 to ${CARRIER_CODE_MAX} characters, or none.` })
  }
  if (patch.minimumOrderAmount !== undefined && patch.minimumOrderAmount !== null && (!Number.isInteger(patch.minimumOrderAmount) || patch.minimumOrderAmount < 0 || patch.minimumOrderAmount > INT_MAX)) {
    issues.push({ path: 'minimumOrderAmount', message: 'A minimum order of 0 or more, in minor units, or none.' })
  }
  if (patch.currency !== undefined && !isCurrencyCode(patch.currency)) issues.push({ path: 'currency', message: 'An ISO 4217 currency (EUR, CHF…).' })
  if (patch.language !== undefined && !LANGUAGE.test(patch.language)) issues.push({ path: 'language', message: 'The language of its documents, ISO 639-1 (it, en…).' })
  return issues
}

/** A minimum order checked against a quote's or an order's net total (the same currency): null when it is met or none. */
export function belowMinimum(minimum: MinorUnits | null, net: MinorUnits, currency: CurrencyCode): { readonly minimum: MinorUnits; readonly short: MinorUnits; readonly currency: CurrencyCode } | null {
  if (minimum === null || net >= minimum) return null
  minorPlaces(currency) // a currency code, or a RangeError
  return { minimum, short: minimum - net, currency }
}

export interface QuoteDefaultsInput {
  /** The customer's own default deposit, percent; null: none of its own. */
  readonly partyDepositPct: string | null
  /** The customer's library terms, when it has terms its quote's company may use; null: none. */
  readonly terms: { readonly id: string; readonly name: string; readonly nameI18n: unknown; readonly instalments: readonly Instalment[] } | null
  /** The customer's printed terms (the W1 free text), used without library terms. */
  readonly partyTermsText: string | null
  /** The sales settings' default deposit, percent; null: none. */
  readonly settingsDepositPct: string | null
  /** The document's language. */
  readonly language: string
}

export interface QuoteDefaults {
  readonly paymentTermsId: string | null
  /** The text printed on the quote (and the order made from it). */
  readonly paymentTerms: string | null
  readonly depositPct: string | null
}

/**
 * What a new quote starts with from its customer (SAL-012: "defaults copied to new quotes and orders"): its library
 * terms and their printed name in the document's language (else its printed text); the deposit: its own default, else
 * the share its terms ask on the order (none when its terms ask none), else the sales settings' default.
 */
export function quoteDefaultsOf(input: QuoteDefaultsInput): QuoteDefaults {
  const depositPct = input.partyDepositPct ?? (input.terms ? (depositOf(input.terms.instalments)?.sharePct ?? null) : input.settingsDepositPct)
  return {
    paymentTermsId: input.terms?.id ?? null,
    paymentTerms: input.terms ? termsNameIn(input.terms, input.language) : input.partyTermsText,
    depositPct: depositPct === null ? null : decimalText(depositPct),
  }
}

/** The days a deposit is due after the acceptance under these terms: their order instalment's, else `fallback`. */
export const depositDueDaysOf = (instalments: readonly Instalment[] | null, fallback: number): number => (instalments ? (depositOf(instalments)?.days ?? fallback) : fallback)
