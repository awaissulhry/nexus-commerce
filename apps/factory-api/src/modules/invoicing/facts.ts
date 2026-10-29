import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { PostalAddress } from '@nexus/factory-domain/documents/model'
import { issueProblems, type IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { billToOf, fatturaPaInputOf, sellerOf, type BillTo, type CompanySellerFacts, type ViesProof } from '@nexus/factory-domain/invoicing/document'
import { checkFatturaPaInput } from '@nexus/factory-domain/invoicing/fatturapa/build'
import type { FatturaPaSeller } from '@nexus/factory-domain/invoicing/fatturapa/types'
import { computeInvoiceTotals, lineProblems, treatmentOf, type CoreLine, type InvoiceTotals } from '@nexus/factory-domain/invoicing/invoices'
import type { PartyKind, PartyRole, PartyStatus } from '@nexus/factory-domain/parties/rules'
import { customerTaxProfile, identityAt, type TaxIdentityFields } from '@nexus/factory-domain/parties/tax'
import { viesStanding, type ViesStanding } from '@nexus/factory-domain/parties/vies'
import { partyWarnings, type PartyWarning } from '@nexus/factory-domain/parties/warnings'
import type { CustomerTaxProfile } from '@nexus/factory-domain/tax/vat-treatment'
import { ADDRESS_COLUMNS, CONTACT_COLUMNS, dateText, TAX_COLUMNS, taxFieldsOf, VIES_COLUMNS, viesFactsOf } from '../parties/store'
import { issueReferences, shippedAndMoneyProblems } from './from-shipment/checks'
import type { InvoiceRow, LineRow, Reader } from './store'

/**
 * What the invoice core reads besides the invoice (B-W1-28; B-W1-07's party rules): the seller from the company's row,
 * the buyer as it stands at the invoice date (the tax identity in force, its registered office, the VIES proof, the
 * record's warnings that stop an invoice), and the facts the checks before issue need. Read in one client: a request's
 * (the pre-check) or the issuing command's transaction (the issue reads them again under its locks).
 */

export interface PartyFacts {
  readonly party: { readonly id: string; readonly companyId: string | null; readonly status: PartyStatus; readonly kind: PartyKind; readonly roles: readonly PartyRole[]; readonly legalName: string; readonly country: string; readonly language: string }
  readonly identity: TaxIdentityFields | null
  readonly vies: ViesStanding
  /** The VAT rules' view of the customer (null without a tax identity). */
  readonly profile: CustomerTaxProfile | null
  readonly address: PostalAddress | null
  readonly warnings: readonly PartyWarning[]
  /** The VIES check that proves a zero-rated EU sale, when there is one. */
  readonly viesProof: ViesProof | null
}

/** The party as it stands on `date` (its identity in force) at `instant` (the VIES window). Null: not visible. */
export async function partyFacts(db: Reader, partyId: string, date: BusinessDate, instant: Date): Promise<PartyFacts | null> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, status: true, kind: true, roles: true, legalName: true, country: true, language: true } })
  if (!party) return null
  // One query after the other: Prisma runs a select with several relations at once on one connection.
  const identities = await db.partyTaxIdentity.findMany({ where: { partyId }, select: TAX_COLUMNS })
  const addresses = await db.partyAddress.findMany({ where: { partyId, status: 'ACTIVE' }, select: ADDRESS_COLUMNS, orderBy: { createdAt: 'asc' } })
  const contacts = await db.partyContact.findMany({ where: { partyId, status: 'ACTIVE' }, select: CONTACT_COLUMNS })
  const current = identityAt(identities.map((row) => ({ row, validFrom: dateText(row.validFrom) })), date)?.row ?? null
  const identity = current ? taxFieldsOf(current) : null
  const checks = current ? await db.viesCheck.findMany({ where: { taxIdentityId: current.id }, select: VIES_COLUMNS }) : []
  const vies = viesStanding(identity, checks.map(viesFactsOf), instant)
  const registered = addresses.find((address) => address.kinds.includes('REGISTERED')) ?? addresses.find((address) => address.isDefaultBillTo) ?? null
  const warnings = partyWarnings({
    party: { kind: party.kind, roles: party.roles, country: party.country, legalName: party.legalName },
    identity,
    vies,
    addresses: addresses.map((address) => ({ kinds: address.kinds, isDefaultBillTo: address.isDefaultBillTo, isDefaultShipTo: address.isDefaultShipTo, line1: address.line1, line2: address.line2, city: address.city })),
    contacts: contacts.map((contact) => ({ email: contact.email, roles: contact.roles })),
  })
  const proof = vies.state === 'VALID' && vies.proof && vies.proof.consultationNumber ? { checkId: vies.proof.id, consultationNumber: vies.proof.consultationNumber, checkedAt: toUtcIso(vies.proof.requestedAt) } : null
  return {
    party,
    identity,
    vies,
    profile: identity ? customerTaxProfile(party, identity, vies.state === 'VALID') : null,
    address: registered ? { line1: registered.line1, line2: registered.line2, postalCode: registered.postalCode, city: registered.city, province: registered.province, country: registered.country } : null,
    warnings,
    viesProof: identity?.taxMode === 'EU_B2B' ? proof : null,
  }
}

/** The buyer snapshot of these facts (FatturaPA's buyer and the VIES proof), or its problems. */
export const billToFrom = (facts: PartyFacts): { readonly billTo: BillTo | null; readonly issues: readonly { path: string; message: string }[] } =>
  billToOf({ legalName: facts.party.legalName, identity: facts.identity, address: facts.address, vies: facts.viesProof })

/** The company's seller data (Company row). */
export async function companyFacts(db: Reader, companyId: string): Promise<CompanySellerFacts | null> {
  const row = await db.company.findUnique({
    where: { id: companyId },
    select: { legalName: true, vatNumber: true, fiscalCode: true, regimeFiscale: true, reaOffice: true, reaNumber: true, shareCapital: true, soleShareholder: true, inLiquidation: true, address: true },
  })
  if (!row) return null
  const address = row.address as Partial<PostalAddress> | null
  return {
    legalName: row.legalName,
    vatNumber: row.vatNumber,
    fiscalCode: row.fiscalCode,
    regimeFiscale: row.regimeFiscale,
    reaOffice: row.reaOffice,
    reaNumber: row.reaNumber,
    shareCapital: row.shareCapital === null ? null : row.shareCapital.toFixed(2),
    soleShareholder: row.soleShareholder,
    inLiquidation: row.inLiquidation,
    address:
      address && typeof address === 'object' && typeof address.line1 === 'string' && typeof address.city === 'string'
        ? { line1: address.line1, line2: address.line2 ?? null, postalCode: address.postalCode ?? '', city: address.city, province: address.province ?? null, country: address.country ?? 'IT' }
        : null,
  }
}

/** A stored line as the core computes it. Null when its VAT is not one the core builds (a problem of its own). */
export function coreLineOf(line: LineRow): CoreLine | null {
  const vat = treatmentOf({ vatRatePct: line.vatRatePct.toFixed(2), vatNature: line.vatNature, vatLegalRef: line.vatLegalRef })
  if (vat === null) return null
  return {
    kind: line.kind,
    description: line.description,
    itemCode: line.itemCode,
    quantity: line.quantity.toFixed(4),
    uom: line.uom,
    unitPrice: line.unitPrice.toFixed(6),
    discountPct: line.discountPct === null ? null : line.discountPct.toFixed(4),
    vat,
    deduction: line.kind === 'DEPOSIT_DEDUCTION' ? { netAmount: line.netAmount, grossAmount: line.grossAmount ?? line.netAmount } : null,
  }
}

/** The totals the lines compute now, or the problems of the lines that cannot be computed. */
export function linesTotals(invoice: Pick<InvoiceRow, 'priceBasis' | 'currency'>, lines: readonly LineRow[]): { readonly computed: InvoiceTotals | null; readonly lineIssues: { path: string; message: string }[] } {
  const lineIssues: { path: string; message: string }[] = []
  const core = lines.map((line, index) => {
    const value = coreLineOf(line)
    if (value === null) lineIssues.push({ path: `lines/${index}/vat`, message: `Line ${line.seq} has a VAT rate the invoice cannot carry: an Italian rate (22, 10, 5, 4), or 0 with its Natura and law.` })
    else lineIssues.push(...lineProblems(value, `lines/${index}`))
    return value
  })
  if (lineIssues.length > 0 || core.some((line) => line === null)) return { computed: null, lineIssues }
  return { computed: computeInvoiceTotals(core as CoreLine[], invoice.priceBasis, invoice.currency), lineIssues }
}

export interface IssueReview {
  readonly problems: readonly IssueProblem[]
  readonly seller: FatturaPaSeller | null
  readonly billTo: BillTo | null
  readonly party: PartyFacts | null
}

/**
 * The checks before issue (domain invoicing/checks), from what the invoice, its lines, the company, the buyer and (for a
 * TD02) its deposit request say now, at the invoice date `date` and the instant `instant`.
 */
export async function reviewIssue(db: Reader, invoice: InvoiceRow, lines: readonly LineRow[], date: BusinessDate, instant: Date): Promise<IssueReview> {
  const party = await partyFacts(db, invoice.buyerPartyId, date, instant)
  const company = await companyFacts(db, invoice.companyId)
  const seller = company ? sellerOf(company) : { seller: null, issues: [{ path: 'company', message: 'The company is not found.' }] }
  const buyer = party ? billToFrom(party) : { billTo: null, issues: [{ path: 'party', message: 'The customer is not found.' }] }
  const { computed, lineIssues } = linesTotals(invoice, lines)
  let deposit: { status: string; currency: string; amount: number; invoicedGross: number } | null = null
  if (invoice.docType === 'TD02' && invoice.depositRequestId) {
    const request = await db.depositRequest.findUnique({ where: { id: invoice.depositRequestId }, select: { status: true, currency: true, amount: true } })
    if (request) deposit = { ...request, invoicedGross: await depositInvoicedGross(db, invoice.depositRequestId, invoice.id) }
  }
  // FatturaPA's own rules, offline, with a stand-in number and the date (the real number is taken at issue), and the
  // DDTs, the credited invoice and the deposit invoices as the file will cite them (B-W1-51).
  let fatturaPa: readonly { path: string; code: string; message: string }[] = []
  if (seller.seller && buyer.billTo && computed) {
    const refs = await issueReferences(db, invoice, lines)
    try {
      fatturaPa = checkFatturaPaInput(
        fatturaPaInputOf({
          id: invoice.id,
          docType: invoice.docType,
          number: 'CHECK-1',
          issueDate: date,
          currency: invoice.currency,
          priceBasis: invoice.priceBasis,
          seller: seller.seller,
          billTo: buyer.billTo,
          lines: lines.map((line, index) => ({
            ...storedLineOf(line),
            netAmount: computed.lines[index]!.netAmount,
            grossAmount: computed.lines[index]!.grossAmount,
            ddtNumber: refs.ddtNumbers.get(line.id) ?? null,
            deposit: line.depositInvoiceId ? (refs.deposits.get(line.depositInvoiceId) ?? { number: 'CHECK-0', issueDate: date }) : null,
          })),
          netTotal: computed.netTotal,
          vatTotal: computed.vatTotal,
          grossTotal: computed.grossTotal,
          vatSummary: computed.vatSummary,
          stampDutyAmount: computed.stampDutyAmount,
          causale: invoice.causale,
          purchaseOrders: purchaseOrdersOf(invoice.documentRefs),
          ddts: refs.ddts,
          credits: refs.credits,
          paymentTerms: paymentTermsOf(invoice.paymentTerms),
        }),
      )
    } catch (error) {
      fatturaPa = [{ path: 'lines', code: 'LINE', message: (error as Error).message }]
    }
  }
  const problems = [...issueProblems({
    docType: invoice.docType,
    currency: invoice.currency,
    party: party ? { status: party.party.status, legalName: party.party.legalName } : { status: 'MISSING', legalName: 'The customer' },
    taxMode: party?.identity?.taxMode ?? null,
    warnings: party?.warnings ?? [],
    vies: party ? { state: party.vies.state, message: party.vies.message } : { state: 'NOT_APPLICABLE', message: '' },
    lineNatures: lines.map((line) => line.vatNature),
    stored: { netTotal: invoice.netTotal, vatTotal: invoice.vatTotal, grossTotal: invoice.grossTotal, vatSummary: invoice.vatSummary, stampDutyAmount: invoice.stampDutyAmount, lines },
    computed,
    lineIssues,
    dataIssues: [...seller.issues, ...buyer.issues],
    fatturaPa,
    deposit,
  }), ...(await shippedAndMoneyProblems(db, invoice, lines))]
  return { problems, seller: seller.seller, billTo: buyer.billTo, party }
}

/** The gross of a request's issued TD02s, less their credit notes, but `except` (the invoice being issued). */
export async function depositInvoicedGross(db: Reader, depositRequestId: string, except: string | null): Promise<number> {
  const invoices = await db.invoice.findMany({ where: { depositRequestId, docType: 'TD02', status: { not: 'DRAFT' }, ...(except ? { id: { not: except } } : {}) }, select: { id: true, grossTotal: true } })
  if (invoices.length === 0) return 0
  const credits = await db.invoice.aggregate({ where: { creditOfId: { in: invoices.map((row) => row.id) }, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } })
  return invoices.reduce((sum, row) => sum + row.grossTotal, 0) - (credits._sum.grossTotal ?? 0)
}

/** A line row as the document mapping reads it. */
export function storedLineOf(line: LineRow) {
  return {
    seq: line.seq,
    kind: line.kind,
    description: line.description,
    itemCode: line.itemCode,
    quantity: line.quantity.toFixed(4),
    uom: line.uom,
    unitPrice: line.unitPrice.toFixed(6),
    discountPct: line.discountPct === null ? null : line.discountPct.toFixed(4),
    vatRatePct: line.vatRatePct.toFixed(2),
    vatNature: line.vatNature,
    vatLegalRef: line.vatLegalRef,
    netAmount: line.netAmount,
    grossAmount: line.grossAmount,
  }
}

/** The customer's purchase orders the invoice cites (documentRefs of kind PURCHASE_ORDER). */
export function purchaseOrdersOf(refs: unknown): { number: string; date: string | null }[] {
  if (!Array.isArray(refs)) return []
  return refs
    .filter((ref): ref is { kind?: unknown; number: string; date?: unknown } => typeof ref === 'object' && ref !== null && typeof (ref as { number?: unknown }).number === 'string')
    .filter((ref) => ref.kind === undefined || ref.kind === 'PURCHASE_ORDER')
    .map((ref) => ({ number: ref.number, date: typeof ref.date === 'string' ? ref.date : null }))
}

/** The payment terms as stored (Invoice.paymentTerms), or null. */
export function paymentTermsOf(value: unknown): { condition: 'TP01' | 'TP02' | 'TP03'; installments: { method: string; amount: number; dueDate?: string | null; iban?: string | null }[] } | null {
  if (!value || typeof value !== 'object') return null
  const terms = value as { condition?: unknown; installments?: unknown }
  if ((terms.condition !== 'TP01' && terms.condition !== 'TP02' && terms.condition !== 'TP03') || !Array.isArray(terms.installments)) return null
  return { condition: terms.condition, installments: terms.installments as { method: string; amount: number; dueDate?: string | null; iban?: string | null }[] }
}
