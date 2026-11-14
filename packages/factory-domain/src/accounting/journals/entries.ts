import type { BusinessDate } from '../../core/time'
import type { ExportCell } from '../../views/exports'
import { documentOf, type DocumentRows, type Row, type VatEntry } from '../journals'
import { mappingInForce, partyGroupOf, PURCHASED_ITEM_KINDS, salesTaxKey, type MappingKind, type MappingRow, type TaxCodeFacts, type VarianceCategory } from '../mapping/keys'
import type { AccountingPackage } from '../packages'

/**
 * The journals with mapped accounts (B-W2b-408; FIN-151; design finance.accounting "3 · Contents": sales journal,
 * purchases journal, payments, cost of goods sold and variances), pure. Each document of a journal package becomes ONE
 * entry whose lines name what they post (a mapping kind and key, mapping/keys.ts) and the amount on the debit or the
 * credit side; the account comes from the company's mapping in force on the document's day. A file first (the entries
 * CSV beside the package's register), an API later (FIN-151). Nothing is posted anywhere by Nexus: the accountant's
 * software imports the file (GATE-ACCOUNTANT: the shapes below are Nexus's reading, UNVERIFIED until the accountant's).
 *
 *   sales invoice (TD01, TD24)  the customer's receivable (its party group) in debit for the gross total; in credit each
 *                               group of lines (garments, services, each charge kind; a deposit deducted takes the
 *                               customers' deposits back) and the output VAT of each VAT rate (its tax code's key)
 *   deposit invoice (TD02)      as an invoice, its lines on the customers' deposits (an advance is not revenue)
 *   credit note (TD04)          the invoice's entry the other way round
 *   supplier invoice            in debit each group of lines (the purchase account of the material's item kind,
 *                               subcontract, services, charges), the input VAT and the stamp duty it charges; in credit
 *                               the supplier's payable (gross less the tax withheld) and the tax withheld; a supplier's
 *                               credit note the other way round
 *   payment / refund            the money's account (its payment method) against the customer's receivable
 *   cost of goods sold          cost of goods sold against finished goods (a reversal the other way round)
 *   a work order's variance     the variance's account against work in progress (above 0: unfavourable, in debit)
 *   purchase price variance     the variance against the material's purchase account (above 0: paid more, in debit)
 * Amounts are minor units, never negative in a line: a negative figure goes to the other side. A line of 0 is left out.
 * An entry balances when its debits equal its credits (the integrity check LEDGER_BALANCES and the export's
 * ENTRIES_BALANCE say when one does not: totals that are not the sums of their lines).
 */

export const ENTRY_SIDES = ['DEBIT', 'CREDIT'] as const
export type EntrySide = (typeof ENTRY_SIDES)[number]

export interface EntryLine {
  readonly side: EntrySide
  readonly kind: MappingKind
  readonly key: string
  /** Minor units, above 0. */
  readonly amount: number
}

export interface JournalEntry {
  readonly package: AccountingPackage
  readonly recordType: string
  readonly recordId: string
  readonly number: string | null
  readonly version: number | null
  readonly day: BusinessDate
  readonly currency: string
  readonly partyCode: string | null
  readonly partyName: string | null
  readonly lines: readonly EntryLine[]
}

const other = (side: EntrySide): EntrySide => (side === 'DEBIT' ? 'CREDIT' : 'DEBIT')

/** The lines of signed figures: a negative one on the other side, a zero one left out. */
function linesOf(figures: readonly { readonly side: EntrySide; readonly kind: MappingKind; readonly key: string; readonly amount: number }[]): EntryLine[] {
  return figures.filter((figure) => figure.amount !== 0).map((figure) => (figure.amount < 0 ? { ...figure, side: other(figure.side), amount: -figure.amount } : figure))
}

/** Sums by key, in the order the keys first come. */
function grouped<Key extends string>(items: readonly { readonly key: Key; readonly amount: number }[]): { key: Key; amount: number }[] {
  const sums = new Map<Key, number>()
  for (const item of items) sums.set(item.key, (sums.get(item.key) ?? 0) + item.amount)
  return [...sums.entries()].map(([key, amount]) => ({ key, amount }))
}

// ---- sales --------------------------------------------------------------------------------------------------------------

export interface SalesLineFacts {
  readonly kind: string
  readonly chargeKind: string | null
  readonly netAmount: number
}

export interface SalesEntryFacts {
  readonly id: string
  readonly number: string
  readonly version: number
  readonly docType: string
  readonly issueDate: BusinessDate
  readonly currency: string
  readonly netTotal: number
  readonly grossTotal: number
  readonly summary: readonly VatEntry[]
  /** Σ the VAT summary's roundings (the lines' net amounts plus them make the net total). */
  readonly rounding: number
  readonly lines: readonly SalesLineFacts[]
  readonly partyCode: string
  readonly partyName: string
  readonly partyCountry: string | null
}

/** The revenue key of a sales line (a deposit invoice's lines are all the customers' deposits). */
export function salesLineKey(docType: string, line: Pick<SalesLineFacts, 'kind' | 'chargeKind'>): string {
  if (docType === 'TD02' || line.kind === 'DEPOSIT_DEDUCTION') return 'CUSTOMER_DEPOSITS'
  if (line.kind === 'SERVICE') return 'SALES_SERVICES'
  if (line.kind === 'CHARGE') return `SALES_${line.chargeKind ?? 'OTHER'}`
  return 'SALES_GARMENTS'
}

export function salesEntry(invoice: SalesEntryFacts, codes: readonly TaxCodeFacts[]): JournalEntry {
  // A credit note takes back what an invoice posted: every line the other way round.
  const receivable: EntrySide = invoice.docType === 'TD04' ? 'CREDIT' : 'DEBIT'
  const revenue = other(receivable)
  const groups = invoice.lines.length > 0 ? grouped(invoice.lines.map((line) => ({ key: salesLineKey(invoice.docType, line), amount: line.netAmount }))) : [{ key: invoice.docType === 'TD02' ? 'CUSTOMER_DEPOSITS' : 'SALES_GARMENTS', amount: invoice.netTotal - invoice.rounding }]
  if (groups[0]) groups[0].amount += invoice.rounding
  const vat = grouped(invoice.summary.filter((entry) => entry.vat !== 0).map((entry) => ({ key: salesTaxKey(codes, entry, invoice.issueDate), amount: entry.vat })))
  return {
    package: 'SALES_JOURNAL',
    recordType: 'Invoice',
    recordId: invoice.id,
    number: invoice.number,
    version: invoice.version,
    day: invoice.issueDate,
    currency: invoice.currency,
    partyCode: invoice.partyCode,
    partyName: invoice.partyName,
    lines: linesOf([
      { side: receivable, kind: 'PARTY_GROUP', key: partyGroupOf('CUSTOMERS', invoice.partyCountry), amount: invoice.grossTotal },
      ...groups.map((group) => ({ side: revenue, kind: 'ITEM_GROUP' as const, key: group.key, amount: group.amount })),
      ...vat.map((entry) => ({ side: revenue, kind: 'TAX_CODE' as const, key: entry.key, amount: entry.amount })),
    ]),
  }
}

// ---- purchases ----------------------------------------------------------------------------------------------------------

export interface PurchaseLineFacts {
  readonly kind: string
  /** The item kind of the purchase order line's item (GOODS mapped to an order line), else null. */
  readonly itemKind: string | null
  readonly netAmount: number
}

export interface PurchaseEntryFacts {
  readonly id: string
  readonly number: string
  readonly version: number
  readonly kind: string
  readonly docType: string | null
  readonly receivedOn: BusinessDate
  readonly currency: string
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly withholdingAmount: number | null
  readonly stampDutyAmount: number | null
  readonly lines: readonly PurchaseLineFacts[]
  readonly supplierCode: string
  readonly supplierName: string
  readonly supplierCountry: string | null
}

/** What a supplier invoice line posts to. */
export function purchaseLineTarget(line: Pick<PurchaseLineFacts, 'kind' | 'itemKind'>): { kind: MappingKind; key: string } {
  switch (line.kind) {
    case 'SUBCONTRACT':
      return { kind: 'COST_CATEGORY', key: 'SUBCONTRACT' }
    case 'SERVICE':
      return { kind: 'COST_CATEGORY', key: 'SERVICES' }
    case 'CHARGE':
      return { kind: 'COST_CATEGORY', key: 'CHARGES' }
    default:
      return { kind: 'ITEM_GROUP', key: line.itemKind && (PURCHASED_ITEM_KINDS as readonly string[]).includes(line.itemKind) ? line.itemKind : 'MATERIALS' }
  }
}

export const isSupplierCreditNote = (invoice: Pick<PurchaseEntryFacts, 'kind' | 'docType'>): boolean => invoice.kind === 'CREDIT_NOTE' || invoice.docType === 'TD04'

export function purchaseEntry(invoice: PurchaseEntryFacts): JournalEntry {
  const cost: EntrySide = isSupplierCreditNote(invoice) ? 'CREDIT' : 'DEBIT'
  const payable = other(cost)
  const targets = new Map<string, { kind: MappingKind; key: string; amount: number }>()
  const lines = invoice.lines.length > 0 ? invoice.lines : [{ kind: 'GOODS', itemKind: null, netAmount: invoice.netTotal }]
  for (const line of lines) {
    const target = purchaseLineTarget(line)
    const id = `${target.kind}|${target.key}`
    const found = targets.get(id) ?? { ...target, amount: 0 }
    found.amount += line.netAmount
    targets.set(id, found)
  }
  const withheld = invoice.withholdingAmount ?? 0
  // Stamp duty is posted only when the supplier's total carries it (ImportoBollo is otherwise not part of the total).
  const stamp = invoice.stampDutyAmount && invoice.grossTotal === invoice.netTotal + invoice.vatTotal + invoice.stampDutyAmount ? invoice.stampDutyAmount : 0
  return {
    package: 'PURCHASES_JOURNAL',
    recordType: 'SupplierInvoice',
    recordId: invoice.id,
    number: `${invoice.supplierCode} ${invoice.number}`,
    version: invoice.version,
    day: invoice.receivedOn,
    currency: invoice.currency,
    partyCode: invoice.supplierCode,
    partyName: invoice.supplierName,
    lines: linesOf([
      ...[...targets.values()].map((target) => ({ side: cost, kind: target.kind, key: target.key, amount: target.amount })),
      { side: cost, kind: 'COST_CATEGORY', key: 'STAMP_DUTY', amount: stamp },
      { side: cost, kind: 'TAX_CODE', key: 'VAT_INPUT', amount: invoice.vatTotal },
      { side: payable, kind: 'PARTY_GROUP', key: partyGroupOf('SUPPLIERS', invoice.supplierCountry), amount: invoice.grossTotal - withheld },
      { side: payable, kind: 'TAX_CODE', key: 'WITHHOLDING', amount: withheld },
    ]),
  }
}

// ---- payments -----------------------------------------------------------------------------------------------------------

export interface MoneyEntryFacts {
  readonly id: string
  readonly reference: string | null
  readonly version: number
  readonly day: BusinessDate
  readonly method: string
  readonly currency: string
  readonly amount: number
  readonly partyCode: string
  readonly partyName: string
  readonly partyCountry: string | null
}

/** A customer's payment: the money's account in debit, the receivable in credit (a refund the other way round). */
export function moneyEntry(recordType: 'Payment' | 'Refund', money: MoneyEntryFacts): JournalEntry {
  const into: EntrySide = recordType === 'Payment' ? 'DEBIT' : 'CREDIT'
  return {
    package: 'PAYMENTS',
    recordType,
    recordId: money.id,
    number: money.reference,
    version: money.version,
    day: money.day,
    currency: money.currency,
    partyCode: money.partyCode,
    partyName: money.partyName,
    lines: linesOf([
      { side: into, kind: 'PAYMENT_METHOD', key: money.method, amount: money.amount },
      { side: other(into), kind: 'PARTY_GROUP', key: partyGroupOf('CUSTOMERS', money.partyCountry), amount: money.amount },
    ]),
  }
}

// ---- cost of goods sold and variances -------------------------------------------------------------------------------------

/** One posted figure of the cost bridge (the register's document, cost-of-sales.ts). */
export interface CostFigureFacts {
  readonly recordType: 'CostOfSalesEntry' | 'WorkOrderVariance' | 'PurchasePriceVariance'
  readonly id: string
  readonly reference: string | null
  readonly day: BusinessDate
  readonly currency: string
  /** Signed minor units (a reversal or a favourable variance below 0). */
  readonly amount: number
  readonly partyCode: string | null
  readonly partyName: string | null
  /** A variance's category. */
  readonly category: VarianceCategory | null
  /** A purchase price variance's material's item kind. */
  readonly itemKind: string | null
}

export function costEntry(figure: CostFigureFacts): JournalEntry {
  const pair = ((): readonly [{ kind: MappingKind; key: string }, { kind: MappingKind; key: string }] => {
    switch (figure.recordType) {
      case 'CostOfSalesEntry':
        return [{ kind: 'COST_CATEGORY', key: 'COST_OF_SALES' }, { kind: 'COST_CATEGORY', key: 'FINISHED_GOODS' }]
      case 'WorkOrderVariance':
        return [{ kind: 'COST_CATEGORY', key: `VARIANCE_${figure.category ?? 'OVERHEAD'}` }, { kind: 'COST_CATEGORY', key: 'WIP' }]
      default:
        return [{ kind: 'COST_CATEGORY', key: 'PPV' }, purchaseLineTarget({ kind: 'GOODS', itemKind: figure.itemKind })]
    }
  })()
  return {
    package: 'COST_OF_SALES',
    recordType: figure.recordType,
    recordId: figure.id,
    number: figure.reference,
    version: null,
    day: figure.day,
    currency: figure.currency,
    partyCode: figure.partyCode,
    partyName: figure.partyName,
    lines: linesOf([
      { side: 'DEBIT', kind: pair[0].kind, key: pair[0].key, amount: figure.amount },
      { side: 'CREDIT', kind: pair[1].kind, key: pair[1].key, amount: figure.amount },
    ]),
  }
}

// ---- accounts, balance and the file -------------------------------------------------------------------------------------

export interface ResolvedLine extends EntryLine {
  /** The account in force on the entry's day, or null: not mapped. */
  readonly accountCode: string | null
}

export function resolveEntry(entry: JournalEntry, mapping: readonly MappingRow[]): ResolvedLine[] {
  return entry.lines.map((line) => ({ ...line, accountCode: mappingInForce(mapping, line.kind, line.key, entry.day)?.accountCode ?? null }))
}

/** Σ debit and Σ credit of an entry (one currency per entry). */
export function balanceOf(entry: Pick<JournalEntry, 'lines'>): { debit: number; credit: number } {
  let debit = 0
  let credit = 0
  for (const line of entry.lines) {
    if (line.side === 'DEBIT') debit += line.amount
    else credit += line.amount
  }
  return { debit, credit }
}

export const balances = (entry: Pick<JournalEntry, 'lines'>): boolean => {
  const { debit, credit } = balanceOf(entry)
  return debit === credit
}

/** The keys of an entry with no account in force on its day. */
export const unmappedOf = (entry: JournalEntry, mapping: readonly MappingRow[]): { kind: MappingKind; key: string }[] =>
  resolveEntry(entry, mapping)
    .filter((line) => line.accountCode === null)
    .map((line) => ({ kind: line.kind, key: line.key }))

export const ENTRY_HEADINGS = {
  en: ['Date', 'Document', 'Number', 'Party code', 'Party', 'Line', 'Account', 'Mapped as', 'Key', 'Debit', 'Credit', 'Change'],
  it: ['Data', 'Documento', 'Numero', 'Codice soggetto', 'Soggetto', 'Riga', 'Conto', 'Tipo di mappatura', 'Chiave', 'Dare', 'Avere', 'Variazione'],
} as const
/** The number's column in the entries file (a document that left the period: its row names only the number). */
export const ENTRY_NUMBER_COLUMN = 2

/** An entry's file rows, one per line, as a document of its package (the register's change marks it in the file). */
export function entryDocument(entry: JournalEntry, mapping: readonly MappingRow[]): DocumentRows {
  const money = (amount: number): ExportCell => ({ minor: amount, currency: entry.currency })
  const rows: Row[] = resolveEntry(entry, mapping).map((line, index) => [
    { day: entry.day },
    entry.recordType,
    entry.number,
    entry.partyCode,
    entry.partyName,
    index + 1,
    line.accountCode,
    line.kind,
    line.key,
    line.side === 'DEBIT' ? money(line.amount) : null,
    line.side === 'CREDIT' ? money(line.amount) : null,
  ])
  return documentOf(entry.package, { recordType: entry.recordType, recordId: entry.recordId, number: entry.number, version: entry.version }, rows)
}
