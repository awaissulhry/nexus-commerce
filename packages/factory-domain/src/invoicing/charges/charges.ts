import type { Issue } from '../../core/errors'
import { fromMinorUnits, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { DocumentLanguage } from '../../documents/model'
import { treatmentKey, type VatTreatment } from '../../tax/vat-treatment'
import { formatDateIt } from '../fatturapa/format'
import type { IssueProblem } from '../checks'
import { amountText, type CoreLine } from '../invoices'

/**
 * Charge lines (B-W2a-54; FIN-060 "Charge lines for freight, samples and fees"; design finance.invoices rec:Invoice
 * lines "Charge lines (W2a): freight, packaging, samples, pattern or tooling, rush fee"), pure.
 *
 * A charge is an invoice line of kind CHARGE (factory-db money.prisma InvoiceLineKind, wave 7/7) that says what it bills
 * (InvoiceChargeKind): the transport of the goods (FREIGHT: the shipment's freight, B-W2a-48's Shipment.freightCharge),
 * their packaging, samples at the customer's charge, a fee (an urgent order, a small-order surcharge), anything else in
 * its words. It bills no order line or size (the shipped-not-invoiced queue and the order's settlement count GOODS lines
 * only); a FREIGHT charge names the DDT whose transport it bills, and on an invoice of several DDTs every charge names
 * the DDT it belongs to (FatturaPA DatiDDT/RiferimentoNumeroLinea: the builder asks every line for its DDT then).
 * Amounts are 0 or more (the database's rule for every line but a deposit deducted): a discount is a line's discount
 * percent, or a credit note.
 *
 * VAT (CHARGE_RULES, UNVERIFIED): an accessory charge follows the supply it goes with (DPR 633/1972 art. 12 c.1: the
 * transport, the packaging and the other accessory supplies are taxed as the main supply). Our reading: a charge without
 * its own VAT takes the treatment of the invoice's goods when they all share one (22 % in Italy, N3.2 to an EU business
 * with its VIES proof, N3.1 on an export), else the treatment the VAT rules give the buyer's goods. The office may give
 * a charge its own VAT on the line. The accountant confirms it (setting `vat` of ChargeRulesConfig).
 *
 * FREIGHT at issue (`freightProblems`): the freight of a shipment is billed once (no other issued invoice bills a
 * FREIGHT line of the same DDT), and at the figure the shipment holds when the invoice is issued (the freight stays
 * editable after the goods left, B-W2a-48: the issue reads it again).
 */

export const CHARGE_KINDS = ['FREIGHT', 'PACKAGING', 'SAMPLES', 'FEE', 'OTHER'] as const
export type ChargeKind = (typeof CHARGE_KINDS)[number]
export const isChargeKind = (value: unknown): value is ChargeKind => typeof value === 'string' && (CHARGE_KINDS as readonly string[]).includes(value)

/** The kinds in words, for the screens and a line's default description. */
export const CHARGE_KIND_WORDS: Readonly<Record<DocumentLanguage, Readonly<Record<ChargeKind, string>>>> = Object.freeze({
  it: { FREIGHT: 'Spese di trasporto', PACKAGING: 'Spese di imballaggio', SAMPLES: 'Campionatura', FEE: 'Maggiorazione', OTHER: 'Altre spese' },
  en: { FREIGHT: 'Freight', PACKAGING: 'Packaging', SAMPLES: 'Samples', FEE: 'Fee', OTHER: 'Other charge' },
})

/** The charge rules and their law; UNVERIFIED ones wait for the accountant (HANDOFF "For the accountant"). */
export const CHARGE_RULES = Object.freeze({
  ACCESSORY_FOLLOWS_GOODS: {
    id: 'ACCESSORY_FOLLOWS_GOODS',
    law: 'DPR 633/1972 art. 12 c.1',
    summary: "A charge without its own VAT takes the treatment of the invoice's goods (one shared treatment), else the one the VAT rules give the buyer's goods.",
    status: 'UNVERIFIED',
    accountantToConfirm: "that freight, packaging, samples and fees charged with garments follow the garments' VAT (setting vat: FOLLOW_GOODS), and whether samples sold on their own are a supply of their own.",
  },
  FREIGHT_ONCE_AT_ISSUE: {
    id: 'FREIGHT_ONCE_AT_ISSUE',
    law: 'DPR 633/1972 art. 21 c.2 lett. g',
    summary: "A shipment's freight is billed once, at the figure the shipment holds when the invoice is issued.",
    status: 'VERIFIED',
  },
} as const)

/** Settings for the UNVERIFIED charge rules; DEFAULT_CHARGE_RULES_CONFIG holds our reading. */
export interface ChargeRulesConfig {
  /** ACCESSORY_FOLLOWS_GOODS. FOLLOW_GOODS: as the goods (above); BUYER_GOODS: always the buyer's goods treatment. */
  readonly vat: 'FOLLOW_GOODS' | 'BUYER_GOODS'
}

export const DEFAULT_CHARGE_RULES_CONFIG: ChargeRulesConfig = Object.freeze({ vat: 'FOLLOW_GOODS' })

/**
 * The VAT of a charge without its own: the one treatment the invoice's goods share (FOLLOW_GOODS), else `buyerGoods`
 * (the VAT rules for the buyer's goods, or the problem they found).
 */
export function chargeVat(goods: readonly VatTreatment[], buyerGoods: VatTreatment | Issue, config: ChargeRulesConfig = DEFAULT_CHARGE_RULES_CONFIG): VatTreatment | Issue {
  if (config.vat === 'FOLLOW_GOODS' && goods.length > 0) {
    const keys = new Set(goods.map(treatmentKey))
    if (keys.size === 1) return goods[0]!
  }
  return buyerGoods
}

/** A charge line's shape as the API prepares it (the core line plus what the charge bills). */
export interface ChargeShape {
  readonly kind: string
  readonly chargeKind: string | null
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly milestoneId?: string | null
}

/**
 * Everything wrong with the charge fields of a line (paths under `at`): a CHARGE says what it bills, and only a CHARGE
 * does; a charge bills no order line, size or schedule step.
 */
export function chargeLineProblems(line: ChargeShape, at: string): Issue[] {
  const issues: Issue[] = []
  if (line.kind === 'CHARGE') {
    if (!isChargeKind(line.chargeKind)) issues.push({ path: `${at}/chargeKind`, message: 'Say what the charge bills: FREIGHT, PACKAGING, SAMPLES, FEE or OTHER.' })
    if (line.salesOrderLineId !== null || line.size !== null) issues.push({ path: `${at}/salesOrderLineId`, message: "A charge bills no order line or size: the garments are the order's goods lines." })
    if (line.milestoneId) issues.push({ path: `${at}/milestoneId`, message: 'A charge bills no step of the payment schedule.' })
  } else if (line.chargeKind !== null) {
    issues.push({ path: `${at}/chargeKind`, message: 'Only a charge line (kind CHARGE) says what charge it is.' })
  }
  return issues
}

// ---- freight --------------------------------------------------------------------------------------------------------

/** What the invoice knows of a shipment's freight, through the DDT the goods travelled with. */
export interface ShipmentFreight {
  readonly ddtId: string
  readonly ddtNumber: string
  readonly ddtDate: BusinessDate
  readonly shipmentNumber: string
  /** Shipment.freightCharge: minor units in `currency`; null = not decided yet; 0 = no freight. */
  readonly amount: MinorUnits | null
  /** The order's currency (the freight's). */
  readonly currency: string
}

/** The description of a freight line: "Spese di trasporto DDT n. 144/2026 del 24/11/2026". */
export const freightDescription = (freight: Pick<ShipmentFreight, 'ddtNumber' | 'ddtDate'>): string =>
  `${CHARGE_KIND_WORDS.it.FREIGHT} DDT n. ${freight.ddtNumber} del ${formatDateIt(freight.ddtDate)}`

/**
 * The freight line of a shipment on an invoice in `currency` (NET basis), or why there is none: no freight (0), not
 * decided yet (null: the site's rule sets it when the goods leave), another currency (typed by hand, B-W2a-48).
 */
export function freightLine(freight: ShipmentFreight, currency: string, vat: VatTreatment): { readonly line: CoreLine } | { readonly skipped: string } {
  if (freight.amount === null) return { skipped: `The freight of shipment ${freight.shipmentNumber} is not decided yet: set it on the shipment, then add the line.` }
  if (freight.amount === 0) return { skipped: `Shipment ${freight.shipmentNumber} carries no freight.` }
  if (freight.currency !== currency) return { skipped: `The freight of shipment ${freight.shipmentNumber} is in ${freight.currency}, the invoice in ${currency}: type the line.` }
  const unitPrice = fromMinorUnits(freight.amount, currency).toFixed(6)
  return { line: { kind: 'CHARGE', description: freightDescription(freight), itemCode: null, quantity: '1.0000', uom: null, unitPrice, discountPct: null, vat } }
}

/** A FREIGHT line of the invoice being issued. */
export interface FreightLine {
  readonly index: number
  readonly ddtId: string
  readonly netAmount: MinorUnits
}

/** A FREIGHT line of ANOTHER issued invoice on the same DDT. */
export interface FreightBilled {
  readonly ddtId: string
  readonly invoiceNumber: string | null
}

/**
 * The problems of an invoice's FREIGHT lines at issue (paths `lines/<i>`): a DDT's freight billed twice on this invoice
 * or already by another issued invoice, and a line whose figure is not the shipment's now (NET basis; a GROSS invoice's
 * freight is the office's own figure).
 */
export function freightProblems(lines: readonly FreightLine[], freights: ReadonlyMap<string, ShipmentFreight>, others: readonly FreightBilled[], basis: 'NET' | 'GROSS', currency: string): IssueProblem[] {
  const problems: IssueProblem[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const freight = freights.get(line.ddtId)
    const label = freight ? `DDT ${freight.ddtNumber}` : 'its DDT'
    if (seen.has(line.ddtId)) {
      problems.push({ code: 'CHARGE_FREIGHT_TWICE', path: `lines/${line.index}`, message: `Line ${line.index + 1} bills the freight of ${label} a second time on this invoice.` })
      continue
    }
    seen.add(line.ddtId)
    const billed = others.filter((other) => other.ddtId === line.ddtId)
    if (billed.length > 0) {
      problems.push({
        code: 'CHARGE_FREIGHT_INVOICED',
        path: `lines/${line.index}`,
        message: `The freight of ${label} is invoiced already (${billed.map((other) => other.invoiceNumber ?? 'an issued invoice').join(', ')}): a shipment's freight is billed once.`,
      })
      continue
    }
    if (!freight || basis !== 'NET') continue
    if (freight.amount === null || freight.currency !== currency || freight.amount !== line.netAmount) {
      const now = freight.amount === null ? 'not decided' : freight.currency !== currency ? `in ${freight.currency}` : amountText(freight.amount, currency)
      problems.push({
        code: 'CHARGE_FREIGHT_CHANGED',
        path: `lines/${line.index}/unitPrice`,
        message: `The freight of shipment ${freight.shipmentNumber} (${label}) is now ${now}; line ${line.index + 1} bills ${amountText(line.netAmount, currency)}. Change the line, or the shipment's freight.`,
      })
    }
  }
  return problems
}
