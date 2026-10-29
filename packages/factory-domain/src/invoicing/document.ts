import { createHash } from 'node:crypto'
import type { Issue } from '../core/errors'
import { fromMinorUnits, type MinorUnits } from '../core/money'
import type { BusinessDate } from '../core/time'
import type { DocumentInput, DocumentLanguage, DocumentLine, DocumentReference, PostalAddress } from '../documents/model'
import type { TaxIdentityFields } from '../parties/tax'
import { NO_SDI_CODE, splitEuVatNumber } from '../parties/tax'
import type { PriceBasis } from '../tax/vat-summary'
import type {
  Address,
  DepositDeduction,
  FatturaPaBuyer,
  FatturaPaDocumentType,
  FatturaPaInvoiceInput,
  FatturaPaLineInput,
  FatturaPaSeller,
  RegimeFiscale,
} from './fatturapa/types'
import { treatmentOf, type InvoiceDocType, type InvoiceLineKind, type StoredVat } from './invoices'

/**
 * From the factory's records to the two documents of an issued invoice (B-W1-28; FIN-057, FIN-085), pure:
 *
 *   sellerOf      the company's row (c.c. art. 2250 data, its RegimeFiscale) → FatturaPaSeller: the `seller` snapshot the
 *                 invoice keeps from its issue on
 *   billToOf      the buyer's tax identity in force at the invoice date and its registered office → FatturaPaBuyer: the
 *                 `billTo` snapshot (with the VIES proof a zero-rated EU sale rests on, `vies`)
 *   fatturaPaInputOf   the issued invoice (snapshots, lines, number, date) → the FatturaPA builder's input: the legal XML
 *   invoiceCopyOf      the same → the INVOICE_COPY document (platform/documents prints it with the company's legal data)
 *
 * The XML is rebuilt from the frozen invoice alone, so a retry makes the same file.
 */

// ---- the seller ---------------------------------------------------------------------------------------------------

/** What the Company row holds for the seller (factory-db _core Company). */
export interface CompanySellerFacts {
  readonly legalName: string
  readonly vatNumber: string | null
  readonly fiscalCode: string | null
  readonly regimeFiscale: string | null
  readonly reaOffice: string | null
  readonly reaNumber: string | null
  /** Decimal(18,2) as a string. */
  readonly shareCapital: string | null
  readonly soleShareholder: boolean
  readonly inLiquidation: boolean
  readonly address: PostalAddress | null
}

const REGIME = /^RF(0[1-9]|1[0-9]|20)$/
const ITALIAN_VAT = /^(?:IT)?(\d{11})$/

/** The seller as FatturaPA names it, or the problems (paths `company/...`) the company's row must fix first. */
export function sellerOf(company: CompanySellerFacts): { readonly seller: FatturaPaSeller | null; readonly issues: Issue[] } {
  const issues: Issue[] = []
  const vat = company.vatNumber === null ? null : ITALIAN_VAT.exec(company.vatNumber.replace(/\s+/g, '').toUpperCase())?.[1] ?? null
  if (vat === null) issues.push({ path: 'company/vatNumber', message: 'The company needs its Partita IVA (IT and 11 digits) to issue an invoice.' })
  if (company.regimeFiscale === null || !REGIME.test(company.regimeFiscale)) {
    issues.push({ path: 'company/regimeFiscale', message: 'The company needs its tax regime (RegimeFiscale, RF01 for the ordinary regime): set it in Finance settings.' })
  }
  const address = company.address
  if (!address || !address.line1?.trim() || !address.postalCode?.trim() || !address.city?.trim()) {
    issues.push({ path: 'company/address', message: 'The company needs its registered office: street, postal code and city.' })
  }
  if (issues.length > 0 || vat === null || !address) return { seller: null, issues }
  const hasRea = company.reaOffice !== null && company.reaNumber !== null && company.reaOffice.trim() !== '' && company.reaNumber.trim() !== ''
  const seller: FatturaPaSeller = {
    vatNumber: vat,
    ...(company.fiscalCode && company.fiscalCode !== vat ? { fiscalCode: company.fiscalCode.trim().toUpperCase() } : {}),
    name: company.legalName.trim(),
    taxRegime: company.regimeFiscale as RegimeFiscale,
    address: addressOf(address),
    ...(hasRea
      ? {
          rea: {
            office: company.reaOffice!.trim().toUpperCase(),
            number: company.reaNumber!.trim(),
            ...(company.shareCapital === null ? {} : { shareCapital: company.shareCapital }),
            ...(company.soleShareholder ? { shareholders: 'SU' as const } : {}),
            inLiquidation: company.inLiquidation,
          },
        }
      : {}),
  }
  return { seller, issues }
}

/** A postal address (Company, PartyAddress) as FatturaPA's Sede: the province only in Italy. */
export function addressOf(address: PostalAddress): Address {
  const country = address.country.trim().toUpperCase()
  const italian = country === 'IT'
  return {
    street: [address.line1, address.line2].filter((part): part is string => typeof part === 'string' && part.trim() !== '').map((part) => part.trim()).join(', '),
    ...(address.postalCode?.trim() ? { postcode: address.postalCode.trim() } : {}),
    city: address.city.trim(),
    ...(italian && address.province?.trim() ? { province: address.province.trim().toUpperCase() } : {}),
    country,
  }
}

// ---- the buyer ----------------------------------------------------------------------------------------------------

/** The VIES proof a zero-rated EU sale rests on (B-W1-07 ViesCheck), kept in the billTo snapshot. */
export interface ViesProof {
  readonly checkId: string
  readonly consultationNumber: string
  /** ISO 8601 UTC. */
  readonly checkedAt: string
}

/** The billTo snapshot: FatturaPA's buyer, plus the proof of a zero-rated EU sale. */
export type BillTo = FatturaPaBuyer & { readonly vies?: ViesProof | null }

export interface BuyerFacts {
  readonly legalName: string
  /** The tax identity in force at the invoice date (identityAt), or null. */
  readonly identity: Pick<TaxIdentityFields, 'country' | 'taxMode' | 'vatNumber' | 'fiscalCode' | 'sdiRecipientCode' | 'pec'> | null
  /** The ACTIVE registered office (FatturaPA Sede of the buyer), else its default invoice address. */
  readonly address: PostalAddress | null
  readonly vies?: ViesProof | null
}

/** The buyer as FatturaPA names it, or the problems (paths `party/...`) the customer's record must fix first. */
export function billToOf(facts: BuyerFacts): { readonly billTo: BillTo | null; readonly issues: Issue[] } {
  const issues: Issue[] = []
  const identity = facts.identity
  if (identity === null) issues.push({ path: 'party/taxIdentity', message: 'The customer has no tax identity in force at the invoice date: add it on the customer.' })
  if (facts.address === null) issues.push({ path: 'party/addresses', message: "The customer has no registered office: the invoice names the buyer's seat (sede legale)." })
  if (identity === null || facts.address === null) return { billTo: null, issues }
  const address = addressOf(facts.address)
  const name = facts.legalName.trim()
  const vies = facts.vies ? { vies: facts.vies } : {}
  switch (identity.taxMode) {
    case 'IT_B2B': {
      const vat = identity.vatNumber?.replace(/^IT/, '') ?? null
      if (!vat) return { billTo: null, issues: [{ path: 'party/taxIdentity/vatNumber', message: 'An Italian business is invoiced with its Partita IVA.' }] }
      const sdi = identity.sdiRecipientCode && identity.sdiRecipientCode !== NO_SDI_CODE ? { sdiCode: identity.sdiRecipientCode } : {}
      const pec = !('sdiCode' in sdi) && identity.pec ? { pec: identity.pec } : {}
      const fiscal = identity.fiscalCode && identity.fiscalCode !== vat ? { fiscalCode: identity.fiscalCode } : {}
      return { billTo: { kind: 'IT_BUSINESS', vatNumber: vat, ...fiscal, name, address, ...sdi, ...pec, ...vies }, issues }
    }
    case 'IT_B2C': {
      if (!identity.fiscalCode) return { billTo: null, issues: [{ path: 'party/taxIdentity/fiscalCode', message: 'An Italian consumer is invoiced with the codice fiscale.' }] }
      const sdi = identity.sdiRecipientCode && identity.sdiRecipientCode !== NO_SDI_CODE ? { sdiCode: identity.sdiRecipientCode } : {}
      const pec = !('sdiCode' in sdi) && identity.pec ? { pec: identity.pec } : {}
      return { billTo: { kind: 'IT_CONSUMER', fiscalCode: identity.fiscalCode, name, address, ...sdi, ...pec, ...vies }, issues }
    }
    default: {
      // A buyer outside Italy: CodiceDestinatario XXXXXXX, its tax id in its country (IdCodice, without the prefix).
      const split = identity.vatNumber ? splitEuVatNumber(identity.vatNumber) : null
      const taxId = split ? split.number : (identity.vatNumber ?? identity.fiscalCode)
      if (!taxId) {
        return { billTo: null, issues: [{ path: 'party/taxIdentity/vatNumber', message: "A customer outside Italy is invoiced with its tax id in its country (FatturaPA IdCodice): add it to the customer's tax identity." }] }
      }
      return { billTo: { kind: 'FOREIGN', country: identity.country, taxId, name, address, ...vies }, issues }
    }
  }
}

/** The buyer of a billTo snapshot, without the proof (the builder takes FatturaPA's shape only). */
export function buyerOfBillTo(billTo: BillTo): FatturaPaBuyer {
  const { vies: _vies, ...buyer } = billTo as BillTo & { vies?: unknown }
  return buyer as FatturaPaBuyer
}

// ---- the issued invoice -------------------------------------------------------------------------------------------

/** A line as the InvoiceLine row holds it. */
export interface StoredLine extends StoredVat {
  readonly seq: number
  readonly kind: InvoiceLineKind
  readonly description: string
  readonly itemCode: string | null
  /** Decimal(18,4) / (18,6) / (7,4) as strings. */
  readonly quantity: string
  readonly uom: string | null
  readonly unitPrice: string
  readonly discountPct: string | null
  readonly netAmount: MinorUnits
  readonly grossAmount: MinorUnits | null
  /** TD24 with several DDTs: the DDT's number. */
  readonly ddtNumber?: string | null
  /** DEPOSIT_DEDUCTION: the TD02 deducted, as issued. */
  readonly deposit?: { readonly number: string; readonly issueDate: BusinessDate } | null
}

/** An invoice as issued: what both documents print. */
export interface IssuedInvoice {
  readonly id: string
  readonly docType: InvoiceDocType
  readonly number: string
  readonly issueDate: BusinessDate
  readonly currency: string
  readonly priceBasis: PriceBasis
  readonly seller: FatturaPaSeller
  readonly billTo: BillTo
  readonly lines: readonly StoredLine[]
  readonly netTotal: MinorUnits
  readonly vatTotal: MinorUnits
  readonly grossTotal: MinorUnits
  readonly vatSummary: readonly { readonly rate: string | null; readonly nature: string | null; readonly taxable: MinorUnits; readonly vat: MinorUnits }[]
  readonly stampDutyAmount: MinorUnits | null
  readonly causale: string | null
  /** The customer's purchase orders (DatiOrdineAcquisto). */
  readonly purchaseOrders: readonly { readonly number: string; readonly date?: BusinessDate | null }[]
  /** TD24 (and a TD01 with DDTs): the DDTs. */
  readonly ddts: readonly { readonly number: string; readonly date: BusinessDate }[]
  /** TD04: the invoice it credits. */
  readonly credits?: { readonly number: string; readonly issueDate: BusinessDate } | null
  /** The sales order it bills, for the copy. */
  readonly salesOrder?: { readonly number: string; readonly date: BusinessDate | null } | null
  readonly paymentTerms?: { readonly condition: 'TP01' | 'TP02' | 'TP03'; readonly installments: readonly { readonly method: string; readonly amount: MinorUnits; readonly dueDate?: string | null; readonly iban?: string | null }[] } | null
}

/**
 * ProgressivoInvio: 5 letters or digits from the invoice id, so the file name is fixed by the invoice (a retry makes the
 * same file). The SDI provider (B-W1-50) may name its sends its own way.
 */
export function progressiveOf(invoiceId: string): string {
  const hash = createHash('sha256').update(invoiceId).digest()
  const value = hash.readUInt32BE(0) % 36 ** 5
  return value.toString(36).toUpperCase().padStart(5, '0')
}

const decimalText = (minor: MinorUnits, currency: string): string => fromMinorUnits(minor, currency).toFixed(2)

/** The FatturaPA builder's input for an issued invoice. Throws when a stored line holds a VAT the builder cannot carry. */
export function fatturaPaInputOf(invoice: IssuedInvoice): FatturaPaInvoiceInput {
  const ordinary = invoice.lines.filter((line) => line.kind !== 'DEPOSIT_DEDUCTION')
  const deductions = invoice.lines.filter((line) => line.kind === 'DEPOSIT_DEDUCTION')
  const lines: FatturaPaLineInput[] = ordinary.map((line) => {
    const vat = treatmentOf(line)
    if (vat === null) throw new Error(`line ${line.seq} holds a VAT the invoice cannot carry`)
    return {
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      vat,
      ...(line.uom ? { unitOfMeasure: line.uom } : {}),
      ...(line.discountPct ? { discountPercent: line.discountPct } : {}),
      ...(line.itemCode ? { itemCode: { type: 'SKU', value: line.itemCode } } : {}),
      ...(line.ddtNumber && invoice.ddts.length > 1 ? { ddtNumber: line.ddtNumber } : {}),
    }
  })
  const byDeposit = new Map<string, StoredLine[]>()
  for (const line of deductions) {
    if (!line.deposit) throw new Error(`deduction line ${line.seq} names no issued deposit invoice`)
    const key = `${line.deposit.number}|${line.deposit.issueDate}`
    byDeposit.set(key, [...(byDeposit.get(key) ?? []), line])
  }
  const depositDeductions: DepositDeduction[] = [...byDeposit.values()].map((group) => ({
    invoiceNumber: group[0]!.deposit!.number,
    invoiceDate: group[0]!.deposit!.issueDate,
    amounts: group.map((line) => {
      const vat = treatmentOf(line)
      if (vat === null) throw new Error(`line ${line.seq} holds a VAT the invoice cannot carry`)
      const gross = line.grossAmount ?? line.netAmount
      return { vat, taxable: decimalText(-line.netAmount, invoice.currency), vatAmount: decimalText(-(gross - line.netAmount), invoice.currency) }
    }),
    description: group[0]!.description,
  }))
  const terms = invoice.paymentTerms
  return {
    documentType: invoice.docType as FatturaPaDocumentType,
    number: invoice.number,
    date: invoice.issueDate,
    currency: 'EUR',
    transmission: { progressive: progressiveOf(invoice.id) },
    seller: invoice.seller,
    buyer: buyerOfBillTo(invoice.billTo),
    priceBasis: invoice.priceBasis,
    lines,
    ...(depositDeductions.length > 0 ? { depositDeductions } : {}),
    ...(invoice.ddts.length > 0 ? { ddts: invoice.ddts.map((ddt) => ({ number: ddt.number, date: ddt.date })) } : {}),
    ...(invoice.purchaseOrders.length > 0 ? { purchaseOrders: invoice.purchaseOrders.map((order) => ({ number: order.number, ...(order.date ? { date: order.date } : {}) })) } : {}),
    ...(invoice.credits ? { relatedInvoices: [{ number: invoice.credits.number, date: invoice.credits.issueDate }] } : {}),
    ...(terms && terms.installments.length > 0
      ? {
          payment: {
            condition: terms.condition,
            installments: terms.installments.map((item) => ({
              method: item.method as FatturaPaLineInputMethod,
              amount: decimalText(item.amount, invoice.currency),
              ...(item.dueDate ? { dueDate: item.dueDate } : {}),
              ...(item.iban ? { iban: item.iban } : {}),
            })),
          },
        }
      : {}),
    ...(invoice.causale ? { causale: invoice.causale } : {}),
    stampDuty: invoice.stampDutyAmount === null ? 'NONE' : 'AUTO',
  }
}

type FatturaPaLineInputMethod = NonNullable<FatturaPaInvoiceInput['payment']>['installments'][number]['method']

/** The buyer's lines on the copy: name, address, tax ids, SDI code or PEC. */
function copyParty(billTo: BillTo): DocumentInput['party'] {
  const name = 'name' in billTo && billTo.name ? billTo.name : [('firstName' in billTo && billTo.firstName) || '', ('lastName' in billTo && billTo.lastName) || ''].join(' ').trim()
  const address: PostalAddress = {
    line1: billTo.address.street,
    postalCode: billTo.address.postcode ?? '',
    city: billTo.address.city,
    province: billTo.address.province ?? null,
    country: billTo.address.country,
  }
  if (billTo.kind === 'IT_BUSINESS') return { name, address, vatNumber: `IT${billTo.vatNumber}`, fiscalCode: billTo.fiscalCode ?? null, sdiCode: billTo.sdiCode ?? null, pec: billTo.pec ?? null }
  if (billTo.kind === 'IT_CONSUMER') return { name, address, fiscalCode: billTo.fiscalCode, sdiCode: billTo.sdiCode ?? null, pec: billTo.pec ?? null }
  return { name, address, vatNumber: `${billTo.country === 'GR' ? 'EL' : billTo.country}${billTo.taxId}` }
}

/** The INVOICE_COPY document of an issued invoice (the company's legal data is added by platform/documents). */
export function invoiceCopyOf(invoice: IssuedInvoice, language: DocumentLanguage): Omit<DocumentInput, 'company' | 'sample'> {
  const lines: DocumentLine[] = invoice.lines.map((line) => ({
    code: line.itemCode,
    description: line.description,
    quantity: line.quantity,
    uom: line.uom ?? (language === 'it' ? 'N.' : 'No.'),
    unitPrice: line.unitPrice,
    discountPercent: line.discountPct,
    amountMinor: line.netAmount,
    vatRate: line.vatRatePct,
    vatNature: line.vatNature,
  }))
  const references: DocumentReference[] = [
    ...invoice.purchaseOrders.map((order) => ({ kind: 'CUSTOMER_ORDER' as const, number: order.number, date: order.date ?? null })),
    ...(invoice.salesOrder ? [{ kind: 'SALES_ORDER' as const, number: invoice.salesOrder.number, date: invoice.salesOrder.date }] : []),
    ...invoice.ddts.map((ddt) => ({ kind: 'DDT' as const, number: ddt.number, date: ddt.date })),
    ...(invoice.credits ? [{ kind: 'INVOICE' as const, number: invoice.credits.number, date: invoice.credits.issueDate }] : []),
  ]
  const deposit = invoice.lines.filter((line) => line.kind === 'DEPOSIT_DEDUCTION').reduce((sum, line) => sum - (line.grossAmount ?? line.netAmount), 0)
  const due = invoice.paymentTerms?.installments.map((item) => item.dueDate).filter((date): date is string => typeof date === 'string').sort()[0] ?? null
  return {
    type: 'INVOICE_COPY',
    language,
    number: invoice.number,
    date: invoice.issueDate,
    currency: invoice.currency,
    party: copyParty(invoice.billTo),
    references,
    lines,
    totals: {
      // The lines' amounts include a deposit deducted; the copy shows the goods, then the deposit, then what is due.
      netMinor: invoice.netTotal,
      vat: invoice.vatSummary.map((entry) => ({ rate: entry.rate ?? '0', nature: entry.nature, taxableMinor: entry.taxable, vatMinor: entry.vat })),
      grossMinor: invoice.grossTotal,
      ...(deposit > 0 ? { depositMinor: deposit } : {}),
    },
    invoice: { kind: invoice.docType, dueDate: due },
    notes: invoice.causale,
  }
}
