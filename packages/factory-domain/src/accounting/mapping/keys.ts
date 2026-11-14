import { Dec } from '../../tax/decimal'
import { isEuMemberState } from '../../tax/eu'
import type { BusinessDate } from '../../core/time'

/**
 * The account mapping in one place (B-W2b-408; FIN-152; design finance.accounting "Account mapping (W2b)", Finance ›
 * Settings "Account mapping"; factory-db bank.prisma AccountMapping): per company, what Nexus posts — an item group, a tax
 * code, a cost category, a payment method or a party group (its key) — to an account of the accountant's chart, from a
 * day. The row in force for a document is the one of its key with the latest first day on or before the document's day;
 * a row is fixed from its first day (the database's rule): a change is a new row from a later day.
 *
 * GATE-ACCOUNTANT (Q21): every key below and how the journals use it is Nexus's own reading, UNVERIFIED until the
 * accountant names their chart; the seeds' accounts are made up. The keys are codes; the screens say them in words.
 *
 *   ITEM_GROUP      what is sold (the revenue accounts: SALES_… and the customers' deposits) or bought (the purchase
 *                   accounts: one per item kind, LEATHER … PACKAGING; MATERIALS for a goods line matched to no order)
 *   TAX_CODE        the output VAT of a sales tax code (its account key, else its code; with no code in force the Natura,
 *                   else the rate); VAT_INPUT (the VAT of the supplier invoices) and WITHHOLDING (the tax withheld from a
 *                   supplier, paid on its behalf)
 *   COST_CATEGORY   what a purchase that is not material is (SUBCONTRACT, SERVICES, CHARGES, STAMP_DUTY), and the cost
 *                   bridge's accounts: COST_OF_SALES against FINISHED_GOODS, a variance (VARIANCE_…) against WIP, the
 *                   purchase price variance (PPV) against the material's purchase account
 *   PAYMENT_METHOD  where the money of a payment lands (the bank, the card acquirer, the direct debit)
 *   PARTY_GROUP     the receivable of a customer and the payable of a supplier, by where the party is established (Italy,
 *                   another EU member state, the rest of the world)
 */

export const MAPPING_KINDS = ['ITEM_GROUP', 'TAX_CODE', 'COST_CATEGORY', 'PAYMENT_METHOD', 'PARTY_GROUP'] as const
export type MappingKind = (typeof MAPPING_KINDS)[number]

/** The database's shapes (the …_bank_bridge_w2b_guards): a key 1 to 80 characters on one line, an account code. */
export const MAPPING_KEY_MAX = 80
export const ACCOUNT_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/
export const MAPPING_NOTE_MAX = 500

export interface KeyWords {
  readonly en: string
  readonly it: string
}

const words = (en: string, it: string): KeyWords => Object.freeze({ en, it })

/** The item kinds of the purchase accounts (factory-db ItemKind; FINISHED is never bought: it is made). */
export const PURCHASED_ITEM_KINDS = ['LEATHER', 'TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'THREAD', 'TRIM', 'HARDWARE', 'PROTECTOR', 'LABEL', 'PACKAGING', 'COMPONENT'] as const

/** The charge kinds of a sales invoice's CHARGE line (factory-db InvoiceChargeKind). */
export const SALES_CHARGE_KINDS = ['FREIGHT', 'PACKAGING', 'SAMPLES', 'FEE', 'OTHER', 'STAMP_DUTY'] as const

/** The categories of a work order's variance (factory-db WorkOrderVarianceCategory, B-W2b-411). */
export const VARIANCE_CATEGORIES = ['MATERIAL_PRICE', 'MATERIAL_USAGE', 'LABOUR_EFFICIENCY', 'LABOUR_RATE', 'SCRAP', 'REWORK', 'SUBCONTRACT_PRICE', 'LOT_SIZE', 'OVERHEAD'] as const
export type VarianceCategory = (typeof VARIANCE_CATEGORIES)[number]

export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CARD', 'SEPA_DEBIT'] as const

export const PARTY_GROUPS = ['CUSTOMERS_IT', 'CUSTOMERS_EU', 'CUSTOMERS_WORLD', 'SUPPLIERS_IT', 'SUPPLIERS_EU', 'SUPPLIERS_WORLD'] as const
export type PartyGroup = (typeof PARTY_GROUPS)[number]

const ITEM_KIND_WORDS: Readonly<Record<(typeof PURCHASED_ITEM_KINDS)[number], KeyWords>> = {
  LEATHER: words('Leather bought', 'Acquisto pelli'),
  TEXTILE: words('Textiles bought', 'Acquisto tessuti'),
  LINING: words('Linings bought', 'Acquisto fodere'),
  MEMBRANE: words('Membranes bought', 'Acquisto membrane'),
  PADDING: words('Padding bought', 'Acquisto imbottiture'),
  THREAD: words('Thread bought', 'Acquisto filati'),
  TRIM: words('Trims bought (zips, snaps…)', 'Acquisto accessori (zip, bottoni…)'),
  HARDWARE: words('Hardware bought', 'Acquisto minuteria'),
  PROTECTOR: words('Protectors bought', 'Acquisto protezioni'),
  LABEL: words('Labels bought', 'Acquisto etichette'),
  PACKAGING: words('Packaging bought', 'Acquisto imballaggi'),
  COMPONENT: words('Components bought', 'Acquisto componenti'),
}

const VARIANCE_WORDS: Readonly<Record<VarianceCategory, KeyWords>> = {
  MATERIAL_PRICE: words('Variance: material price', 'Scostamento: prezzo materiali'),
  MATERIAL_USAGE: words('Variance: material usage', 'Scostamento: consumo materiali'),
  LABOUR_EFFICIENCY: words('Variance: labour efficiency', 'Scostamento: efficienza manodopera'),
  LABOUR_RATE: words('Variance: labour rate', 'Scostamento: costo orario manodopera'),
  SCRAP: words('Variance: scrap', 'Scostamento: scarti'),
  REWORK: words('Variance: rework', 'Scostamento: rilavorazioni'),
  SUBCONTRACT_PRICE: words('Variance: subcontract price', 'Scostamento: prezzo terzisti'),
  LOT_SIZE: words('Variance: lot size', 'Scostamento: dimensione lotto'),
  OVERHEAD: words('Variance: overhead', 'Scostamento: spese generali'),
}

/** The keys Nexus posts, kind by kind, with their words (the company's sales tax codes add their own TAX_CODE keys). */
export const MAPPING_KEYS: Readonly<Record<MappingKind, Readonly<Record<string, KeyWords>>>> = Object.freeze({
  ITEM_GROUP: Object.freeze({
    SALES_GARMENTS: words('Sales of garments', 'Vendite di capi'),
    SALES_SERVICES: words('Sales of services', 'Prestazioni di servizi'),
    SALES_FREIGHT: words('Transport charged to customers', 'Spese di trasporto addebitate'),
    SALES_PACKAGING: words('Packaging charged to customers', 'Imballi addebitati'),
    SALES_SAMPLES: words('Samples charged to customers', 'Campionature addebitate'),
    SALES_FEE: words('Fees charged to customers', 'Diritti e supplementi addebitati'),
    SALES_OTHER: words('Other charges to customers', 'Altri addebiti ai clienti'),
    SALES_STAMP_DUTY: words('Stamp duty charged to customers', 'Bolli addebitati ai clienti'),
    CUSTOMER_DEPOSITS: words("Customers' deposits (advances)", 'Clienti c/anticipi'),
    ...Object.fromEntries(PURCHASED_ITEM_KINDS.map((kind) => [kind, ITEM_KIND_WORDS[kind]])),
    MATERIALS: words('Goods bought, matched to no order line', 'Merci acquistate non abbinate a un ordine'),
  }),
  TAX_CODE: Object.freeze({
    VAT_INPUT: words('VAT on purchases (input VAT)', 'IVA su acquisti (IVA a credito)'),
    WITHHOLDING: words('Tax withheld from suppliers', 'Ritenute d’acconto da versare'),
  }),
  COST_CATEGORY: Object.freeze({
    SUBCONTRACT: words("Subcontractors' work", 'Lavorazioni di terzi'),
    SERVICES: words('Services bought', 'Servizi acquistati'),
    CHARGES: words('Accessory charges on purchases (freight, duty…)', 'Oneri accessori su acquisti (trasporti, dazi…)'),
    STAMP_DUTY: words('Stamp duty on purchases', 'Imposta di bollo su acquisti'),
    COST_OF_SALES: words('Cost of goods sold', 'Costo del venduto'),
    FINISHED_GOODS: words('Finished goods in stock', 'Prodotti finiti'),
    WIP: words('Work in progress', 'Semilavorati e lavori in corso'),
    PPV: words('Purchase price variance', 'Scostamento prezzo di acquisto'),
    ...Object.fromEntries(VARIANCE_CATEGORIES.map((category) => [`VARIANCE_${category}`, VARIANCE_WORDS[category]])),
  }),
  PAYMENT_METHOD: Object.freeze({
    BANK_TRANSFER: words('Bank (transfers received)', 'Banca (bonifici ricevuti)'),
    CARD: words('Card payments', 'Incassi con carta'),
    SEPA_DEBIT: words('SEPA direct debits', 'Addebiti diretti SEPA'),
  }),
  PARTY_GROUP: Object.freeze({
    CUSTOMERS_IT: words('Customers in Italy', 'Clienti Italia'),
    CUSTOMERS_EU: words('Customers in the EU', 'Clienti UE'),
    CUSTOMERS_WORLD: words('Customers outside the EU', 'Clienti extra UE'),
    SUPPLIERS_IT: words('Suppliers in Italy', 'Fornitori Italia'),
    SUPPLIERS_EU: words('Suppliers in the EU', 'Fornitori UE'),
    SUPPLIERS_WORLD: words('Suppliers outside the EU', 'Fornitori extra UE'),
  }),
})

/** The party group of a customer or a supplier, by the country it is established in. */
export function partyGroupOf(side: 'CUSTOMERS' | 'SUPPLIERS', country: string | null): PartyGroup {
  const where = !country || country === 'IT' ? 'IT' : isEuMemberState(country) ? 'EU' : 'WORLD'
  return `${side}_${where}` as PartyGroup
}

/** A sales tax code as the mapping reads it (factory-db TaxCode, B-W2b-392). */
export interface TaxCodeFacts {
  readonly code: string
  readonly label: string
  readonly ratePct: string
  readonly natura: string | null
  readonly accountCodeKey: string | null
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
}

/** The key of a tax code: its account key (B-W2b-392's column for this mapping), else its code. */
export const taxCodeKey = (code: Pick<TaxCodeFacts, 'code' | 'accountCodeKey'>): string => code.accountCodeKey ?? code.code

const sameRate = (a: string, b: string): boolean => new Dec(a).equals(new Dec(b))

/**
 * The TAX_CODE key of a VAT summary entry of a sales invoice: the company's tax code in force on the day with the same
 * rate (and the same Natura when there is one; a code named exactly as the Natura first); with none, the Natura, else
 * the rate as a number ("22").
 */
export function salesTaxKey(codes: readonly TaxCodeFacts[], entry: { readonly rate: string | null; readonly nature: string | null }, day: BusinessDate): string {
  const rate = entry.rate ?? '0'
  const inForce = codes.filter((code) => code.validFrom <= day && (code.validTo === null || code.validTo >= day) && sameRate(code.ratePct, rate) && (code.natura ?? null) === (entry.nature ?? null))
  const found = inForce.find((code) => code.code === entry.nature) ?? [...inForce].sort((a, b) => a.code.localeCompare(b.code))[0]
  if (found) return taxCodeKey(found)
  return entry.nature ?? new Dec(rate).toString()
}

/** One mapping row as the reader keeps it. */
export interface MappingRow {
  readonly id: string
  readonly kind: MappingKind
  readonly key: string
  readonly accountCode: string
  readonly validFrom: BusinessDate
}

/** The row of a key in force on a day (the latest first day on or before it), or null: not mapped then. */
export function mappingInForce<Row extends MappingRow>(rows: readonly Row[], kind: MappingKind, key: string, day: BusinessDate): Row | null {
  let found: Row | null = null
  for (const row of rows) {
    if (row.kind !== kind || row.key !== key || row.validFrom > day) continue
    if (!found || row.validFrom > found.validFrom) found = row
  }
  return found
}

/** The words of a key (a tax code of the company: its label), or null for a key Nexus does not post. */
export function keyWords(kind: MappingKind, key: string, codes: readonly TaxCodeFacts[] = []): KeyWords | null {
  const fixed = MAPPING_KEYS[kind][key]
  if (fixed) return fixed
  if (kind === 'TAX_CODE') {
    const code = codes.find((entry) => taxCodeKey(entry) === key)
    if (code) return words(`Output VAT: ${code.label}`, `IVA a debito: ${code.label}`)
  }
  return null
}

/** Every key of a kind Nexus may post for this company (the fixed ones and, for TAX_CODE, its tax codes' keys). */
export function keysOf(kind: MappingKind, codes: readonly TaxCodeFacts[] = []): string[] {
  const fixed = Object.keys(MAPPING_KEYS[kind])
  if (kind !== 'TAX_CODE') return fixed
  return [...new Set([...codes.map(taxCodeKey), ...fixed])]
}

/** The words every answer of the mapping carries (GATE-ACCOUNTANT). */
export const MAPPING_WORDS =
  "The account mapping is Nexus's reading of the accountant's chart, to confirm with the accountant (GATE-ACCOUNTANT, Q21): the keys and the accounts are made up until then. A row applies from its first day and is fixed from then on: a change is a new row from a later day."
