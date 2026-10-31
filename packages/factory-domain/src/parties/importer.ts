import type { Issue } from '../core/errors'
import { fromMinorUnits, isCurrencyCode, minorPlaces, toMinorUnits } from '../core/money'
import { cell, foldWord, type CellValue } from '../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../imports/importer'
import { checkAddress, type AddressFields, type AddressKind } from './addresses'
import { checkContact, type ContactFields } from './contacts'
import { changeParty, isCustomer, newParty, PARTY_KINDS, PARTY_ROLES, type PartyFields, type PartyRole, type PartyStatus } from './rules'
import { checkTaxIdentity, PARTY_TAX_MODES, suggestTaxMode, type PartyTaxMode, type TaxIdentityFields } from './tax'
import { decimalText } from '../product/units/units'
import { CARRIER_CODE_MAX, commercialTermsProblems, INVOICE_TIMINGS, type InvoiceTiming } from '../sales/terms/terms'

/**
 * The customers and suppliers import (features SAL-001, SCM-001, SCM-289 → PLT-176): a sheet of parties, one per row,
 * keyed by our party code. A new code makes a party; a known one changes the cells the row gives (a blank cell is
 * "not given", never "clear it"). The dry run applies every party rule (./rules, ./tax, ./addresses, ./contacts), so a
 * row that would break one is an error in the review, never a failed apply.
 *
 *   code, legal and trade name, kind, roles,        the party (roles: `cliente; fornitore`, CUSTOMER, BRAND, SUPPLIER,
 *   country, currency, language, payment terms      SUBCONTRACTOR, CARRIER)
 *   tax mode, VAT number, codice fiscale,           its tax identity in force: a new party's first one, or a new identity
 *   SDI code, PEC                                   from the import's day when the row changes it (left out: the tax
 *                                                   mode follows the country and the VAT number)
 *   address, postcode, city, province, country      its registered office (a new party's is also its default invoice
 *                                                   address, and a customer's default delivery address)
 *   contact name, email, phone                      a contact (an email makes it the ORDERS contact): matched by email,
 *                                                   else by name; a new one is added, a known one gets the name and phone
 *   payment terms code, price list, default         W2b (B-W2b-25; the B-W2a-49 gap): a customer's commercial terms, as
 *   deposit %, invoicing, Incoterm, preferred       its Tax & terms card sets them (modules/parties commercial-terms.ts):
 *   carrier, minimum order                          the library terms and the price list by their codes (the adapter's
 *                                                   check finds them: active, of the party's company or every company,
 *                                                   the list in the party's currency, given only by a person who may keep
 *                                                   price lists), the minimum order in the party's currency (the price
 *                                                   grain). Only for a customer (the customer or brand role).
 *
 * Not by import: the company (the job's company is the parties' company: a code of another company's party is an
 * error), the status (a new party is ACTIVE; blocked and archived parties change on their page), several addresses or
 * contacts, older tax identities. Another party's VAT number or codice fiscale is refused when the row is applied (the
 * dry run reads only the parties its codes find): the batch stops with the code of the party that holds it.
 *
 * The adapter (apps/factory-api modules/parties/importer.ts) loads each party as `importRecordValues()`: the columns'
 * current values plus `$record`, the whole party as JSON, which the plan needs for the rules on what the sheet leaves
 * out. Only the columns reach a stored plan row. The contact columns load as empty: a row's contact is added or
 * matched at apply time.
 */

const KIND_ALIASES = { azienda: 'ORGANISATION', societa: 'ORGANISATION', organizzazione: 'ORGANISATION', company: 'ORGANISATION', persona: 'PERSON', privato: 'PERSON', person: 'PERSON', individual: 'PERSON' } as const
const INVOICING_ALIASES = {
  'per spedizione': 'PER_SHIPMENT', 'a spedizione': 'PER_SHIPMENT', immediata: 'PER_SHIPMENT', td01: 'PER_SHIPMENT', 'per shipment': 'PER_SHIPMENT',
  mensile: 'MONTHLY', differita: 'MONTHLY', 'fattura differita': 'MONTHLY', td24: 'MONTHLY', monthly: 'MONTHLY',
} as const
const TAX_MODE_ALIASES = {
  'b2b italia': 'IT_B2B', 'azienda italiana': 'IT_B2B', 'b2c italia': 'IT_B2C', 'privato italiano': 'IT_B2C', consumatore: 'IT_B2C',
  'b2b ue': 'EU_B2B', 'b2b eu': 'EU_B2B', 'intra ue': 'EU_B2B', 'b2c ue': 'EU_B2C', 'b2c eu': 'EU_B2C', 'extra ue': 'EXTRA_EU', 'extra eu': 'EXTRA_EU', export: 'EXTRA_EU',
} as const
const ROLE_WORDS: Readonly<Record<string, PartyRole>> = {
  cliente: 'CUSTOMER', clienti: 'CUSTOMER', customer: 'CUSTOMER',
  marchio: 'BRAND', brand: 'BRAND', committente: 'BRAND',
  fornitore: 'SUPPLIER', fornitori: 'SUPPLIER', supplier: 'SUPPLIER', conceria: 'SUPPLIER',
  terzista: 'SUBCONTRACTOR', contoterzista: 'SUBCONTRACTOR', subcontractor: 'SUBCONTRACTOR', laboratorio: 'SUBCONTRACTOR',
  corriere: 'CARRIER', vettore: 'CARRIER', spedizioniere: 'CARRIER', carrier: 'CARRIER',
  ...Object.fromEntries(PARTY_ROLES.map((role) => [role.toLowerCase(), role])),
}

/** "cliente; fornitore" → ['CUSTOMER', 'SUPPLIER'] in the enum's order; null when a word is not a role. */
export function parseRoles(text: string): PartyRole[] | null {
  const words = text.split(/[;,|/+]|\be\b|\band\b/i).map((word) => foldWord(word)).filter((word) => word !== '')
  if (words.length === 0) return null
  const roles = new Set<PartyRole>()
  for (const word of words) {
    const role = ROLE_WORDS[word]
    if (!role) return null
    roles.add(role)
  }
  return PARTY_ROLES.filter((role) => roles.has(role))
}
export const formatRoles = (roles: readonly PartyRole[]): string => roles.join('; ')

export const PARTY_IMPORTER_KEY = 'parties.parties'

export const partiesImporter = defineImporter({
  key: PARTY_IMPORTER_KEY,
  label: 'Customers and suppliers',
  description: 'Customers, brands, suppliers, subcontractors and carriers with their tax identity, registered office and a contact.',
  columns: {
    code: { label: 'Code', aliases: ['codice', 'codice cliente', 'codice fornitore', 'party code'], required: true, type: cell.code({ upper: true, max: 24 }) },
    legalName: { label: 'Legal name', aliases: ['ragione sociale', 'denominazione', 'nome', 'name', 'company name'], type: cell.text({ max: 200 }), description: 'Needed for a new party.' },
    tradeName: { label: 'Trade name', aliases: ['nome commerciale', 'insegna', 'brand name'], type: cell.text({ max: 200 }) },
    kind: { label: 'Kind', aliases: ['tipo soggetto', 'persona o azienda'], type: cell.oneOf(PARTY_KINDS, KIND_ALIASES) },
    roles: { label: 'Roles', aliases: ['ruoli', 'ruolo', 'tipo', 'type', 'role'], type: cell.text({ max: 200 }), description: 'Needed for a new party: cliente, marchio, fornitore, terzista, corriere (split by ;).' },
    country: { label: 'Country', aliases: ['paese', 'nazione', 'stato'], type: cell.code({ max: 2, upper: true }) },
    currency: { label: 'Currency', aliases: ['valuta', 'divisa'], type: cell.code({ max: 3, upper: true }) },
    language: { label: 'Language', aliases: ['lingua'], type: cell.code({ max: 2 }) },
    paymentTerms: { label: 'Payment terms', aliases: ['condizioni di pagamento', 'pagamento', 'termini di pagamento'], type: cell.text({ max: 500 }) },
    taxMode: { label: 'Tax mode', aliases: ['regime iva', 'tipo cliente iva', 'trattamento iva'], type: cell.oneOf(PARTY_TAX_MODES, TAX_MODE_ALIASES) },
    vatNumber: { label: 'VAT number', aliases: ['partita iva', 'p iva', 'piva', 'p.iva', 'vat', 'vat id', 'ust-idnr'], type: cell.code({ max: 40, upper: true }) },
    fiscalCode: { label: 'Codice fiscale', aliases: ['codice fiscale', 'cf', 'c.f.', 'fiscal code', 'tax code'], type: cell.code({ max: 40, upper: true }) },
    sdiRecipientCode: { label: 'SDI code', aliases: ['codice destinatario', 'codice sdi', 'sdi', 'codice univoco'], type: cell.code({ max: 10, upper: true }) },
    pec: { label: 'PEC', aliases: ['pec', 'indirizzo pec', 'posta certificata'], type: cell.email() },
    addressLine1: { label: 'Address', aliases: ['indirizzo', 'via', 'sede legale', 'street'], type: cell.text({ max: 60 }), description: 'The registered office.' },
    addressLine2: { label: 'Address line 2', aliases: ['indirizzo 2', 'presso'], type: cell.text({ max: 60 }) },
    postalCode: { label: 'Postcode', aliases: ['cap', 'codice postale', 'zip', 'postal code'], type: cell.code({ max: 12, upper: true }) },
    city: { label: 'City', aliases: ['citta', 'comune', 'localita', 'town'], type: cell.text({ max: 60 }) },
    province: { label: 'Province', aliases: ['provincia', 'prov', 'pr', 'region', 'regione'], type: cell.text({ max: 40 }) },
    addressCountry: { label: 'Address country', aliases: ['paese indirizzo', 'nazione sede'], type: cell.code({ max: 2, upper: true }), description: "Left out: the party's country." },
    contactName: { label: 'Contact', aliases: ['referente', 'contatto', 'contact name', 'persona di riferimento'], type: cell.text({ max: 120 }) },
    contactEmail: { label: 'Contact email', aliases: ['email', 'e-mail', 'mail', 'email referente'], type: cell.email() },
    contactPhone: { label: 'Contact phone', aliases: ['telefono', 'tel', 'phone', 'cellulare'], type: cell.text({ max: 30 }) },
    // W2b (B-W2b-25): a customer's commercial terms (after the W1 columns: the layout of older sheets stays).
    paymentTermsCode: { label: 'Payment terms code', aliases: ['codice pagamento', 'codice condizioni di pagamento', 'payment terms code', 'terms code'], type: cell.code({ upper: true, max: 24 }), description: 'The code of payment terms in the library (a customer only).' },
    // The key is `list`, not `priceList`: the money filter hides unmarked keys that look like money (A1 §3.11) from the review.
    list: { label: 'Price list', aliases: ['listino', 'listino prezzi', 'codice listino', 'price list', 'price list code'], type: cell.code({ upper: true, max: 24 }), description: "The code of the price list it is priced from, in the customer's currency (a customer only)." },
    defaultDepositPct: { label: 'Default deposit %', aliases: ['acconto %', 'acconto', 'anticipo %', 'deposit %', 'default deposit'], type: cell.decimal({ precision: 7, scale: 4 }), description: 'Above 0 and at most 100 percent of the gross total (a customer only).' },
    invoicing: { label: 'Invoicing', aliases: ['fatturazione', 'invoice timing', 'tipo fatturazione'], type: cell.oneOf(INVOICE_TIMINGS, INVOICING_ALIASES), description: 'Per shipment (TD01) or monthly (TD24) (a customer only).' },
    incoterm: { label: 'Incoterm', aliases: ['incoterms', 'resa', 'termini di resa'], type: cell.code({ upper: true, max: 3 }), description: 'An Incoterms 2020 rule: EXW, FCA, DAP … (a customer only).' },
    preferredCarrier: { label: 'Preferred carrier', aliases: ['corriere preferito', 'vettore preferito', 'carrier code', 'codice corriere'], type: cell.text({ max: CARRIER_CODE_MAX }), description: "The carrier's code as on a shipment (a customer only)." },
    minimumOrder: { label: 'Minimum order', aliases: ['ordine minimo', 'minimo ordine', "minimo d'ordine", 'minimum order amount'], type: cell.decimal({ precision: 14, scale: 3, min: '0' }), grain: 'price', description: "In the customer's currency (a customer only)." },
  },
  keyColumns: ['code'],
  batchSize: 100,
  validateRow(values) {
    if (typeof values.roles === 'string' && parseRoles(values.roles) === null) return [{ column: 'roles', message: 'Expected roles: cliente, marchio, fornitore, terzista, corriere (split by ;).' }]
    return []
  },
  plan: (values, existing) => planPartyRow(values, existing),
})

type Column = keyof typeof partiesImporter.columns & string
const isColumn = (name: string): name is Column => Object.hasOwn(partiesImporter.columns, name)

const PARTY_COLUMNS = ['legalName', 'tradeName', 'kind', 'roles', 'country', 'currency', 'language', 'paymentTerms'] as const
const TAX_COLUMNS = ['taxMode', 'vatNumber', 'fiscalCode', 'sdiRecipientCode', 'pec'] as const
const ADDRESS_COLUMNS = { addressLine1: 'line1', addressLine2: 'line2', postalCode: 'postalCode', city: 'city', province: 'province', addressCountry: 'country' } as const
const CONTACT_COLUMNS = { contactName: 'name', contactEmail: 'email', contactPhone: 'phone' } as const
/** W2b (B-W2b-25): the commercial terms columns and the Party fields they set. */
export const TERMS_COLUMNS = ['paymentTermsCode', 'list', 'defaultDepositPct', 'invoicing', 'incoterm', 'preferredCarrier', 'minimumOrder'] as const
export type TermsColumn = (typeof TERMS_COLUMNS)[number]

// ---- the record as the adapter loads it -------------------------------------------------------------------------------

/** A party as the import sees it. */
export interface ImportedParty {
  readonly fields: PartyFields
  readonly status: PartyStatus
  /** Of another company than the job's (or tenant-wide for a company's job, or the reverse). */
  readonly foreign: boolean
  /** The identity in force on the import's day. */
  readonly identity: Omit<TaxIdentityFields, 'validFrom'> | null
  /** Its first active registered office. */
  readonly registered: AddressFields | null
  /** Its active contacts. */
  readonly contacts: readonly ContactFields[]
  /** W2b (B-W2b-25): its commercial terms (left out: none set). */
  readonly terms?: ImportedTerms | null | undefined
}

/** A party's commercial terms as the import sees them: the library terms and the price list by their codes. */
export interface ImportedTerms {
  readonly paymentTermsCode: string | null
  readonly priceList: string | null
  /** Percent, a plain decimal string. */
  readonly defaultDepositPct: string | null
  readonly invoiceTiming: InvoiceTiming
  readonly incoterm: string | null
  readonly preferredCarrierCode: string | null
  /** Minor units of the party's currency. */
  readonly minimumOrderAmount: number | null
}

const RECORD = '$record'

export function importRecordValues(party: ImportedParty): RecordValues {
  // The key column too: the engine finds a row's record by it.
  const columns: Record<string, CellValue | null> = { code: party.fields.code }
  for (const name of PARTY_COLUMNS) columns[name] = name === 'roles' ? formatRoles(party.fields.roles) : party.fields[name]
  for (const name of TAX_COLUMNS) columns[name] = party.identity ? party.identity[name] : null
  for (const [column, field] of Object.entries(ADDRESS_COLUMNS)) columns[column] = party.registered ? party.registered[field] : null
  for (const column of Object.keys(CONTACT_COLUMNS)) columns[column] = null
  Object.assign(columns, termsColumnsOf(party.terms ?? null, party.fields.currency))
  return { ...columns, [RECORD]: JSON.stringify(party) }
}

/** A minor-units amount as the sheet writes it: a plain decimal in the currency's units ("150" for 15000 EUR cents). */
const majorText = (amount: number, currency: string): string => decimalText(fromMinorUnits(amount, isCurrencyCode(currency) ? currency : 'EUR').toFixed())

/** The terms columns' current values. */
function termsColumnsOf(terms: ImportedTerms | null, currency: string): Record<TermsColumn, CellValue | null> {
  return {
    paymentTermsCode: terms?.paymentTermsCode ?? null,
    list: terms?.priceList ?? null,
    defaultDepositPct: terms?.defaultDepositPct === null || terms?.defaultDepositPct === undefined ? null : decimalText(terms.defaultDepositPct),
    invoicing: terms?.invoiceTiming ?? 'PER_SHIPMENT',
    incoterm: terms?.incoterm ?? null,
    preferredCarrier: terms?.preferredCarrierCode ?? null,
    minimumOrder: terms?.minimumOrderAmount === null || terms?.minimumOrderAmount === undefined ? null : majorText(terms.minimumOrderAmount, currency),
  }
}

function recordOf(existing: ExistingRecord): ImportedParty {
  const raw = existing.values[RECORD]
  if (typeof raw !== 'string') throw new Error('The parties import needs the record ($record) beside the columns.')
  return JSON.parse(raw) as ImportedParty
}

// ---- what a row gives -------------------------------------------------------------------------------------------------

const given = (values: RowValues, names: readonly string[]): boolean => names.some((name) => values[name] !== undefined)
const str = (value: CellValue | undefined): string | undefined => (value === undefined ? undefined : String(value))

/** A day the rules accept for validFrom; the adapter writes the import's day. */
const ANY_DAY = '2000-01-01'

/** The party fields a row gives, as a patch. */
function partyPatchOf(values: RowValues): Partial<PartyFields> {
  const patch: Record<string, unknown> = {}
  for (const name of PARTY_COLUMNS) {
    const value = values[name]
    if (value === undefined) continue
    patch[name] = name === 'roles' ? (parseRoles(String(value)) ?? []) : value
  }
  return patch as Partial<PartyFields>
}

/** The tax identity a row gives over the one in force (null: the row gives no tax column). */
export function identityOfRow(values: RowValues, party: PartyFields, current: ImportedParty['identity']) {
  if (!given(values, TAX_COLUMNS)) return null
  const vatNumber = values.vatNumber !== undefined ? String(values.vatNumber) : (current?.vatNumber ?? null)
  const taxMode = (str(values.taxMode) as PartyTaxMode | undefined) ?? (values.vatNumber !== undefined || !current ? suggestTaxMode({ country: party.country, hasVatNumber: vatNumber !== null }) : current.taxMode)
  return checkTaxIdentity({
    country: party.country,
    taxMode,
    vatNumber,
    fiscalCode: str(values.fiscalCode) ?? current?.fiscalCode ?? null,
    sdiRecipientCode: str(values.sdiRecipientCode) ?? current?.sdiRecipientCode ?? null,
    pec: str(values.pec) ?? current?.pec ?? null,
    validFrom: ANY_DAY,
  })
}

/** The registered office a row gives over the current one (null: no address column). */
export function addressOfRow(values: RowValues, party: PartyFields, current: AddressFields | null) {
  if (!given(values, Object.keys(ADDRESS_COLUMNS))) return null
  const kinds: AddressKind[] = current ? [...current.kinds] : ['REGISTERED', 'BILL_TO', ...(isCustomer(party.roles) ? (['SHIP_TO'] as const) : [])]
  return checkAddress({
    ...(current ?? {}),
    kinds,
    line1: str(values.addressLine1) ?? current?.line1 ?? '',
    line2: str(values.addressLine2) ?? current?.line2 ?? null,
    postalCode: str(values.postalCode) ?? current?.postalCode ?? '',
    city: str(values.city) ?? current?.city ?? '',
    province: str(values.province) ?? current?.province ?? null,
    country: str(values.addressCountry) ?? current?.country ?? party.country,
  })
}

/** The contact a row gives (null: no contact column); an email makes it the ORDERS contact. */
export function contactOfRow(values: RowValues, match: ContactFields | null) {
  if (!given(values, Object.keys(CONTACT_COLUMNS))) return null
  const email = str(values.contactEmail) ?? match?.email ?? null
  return checkContact({
    name: str(values.contactName) ?? match?.name ?? '',
    email,
    phone: str(values.contactPhone) ?? match?.phone ?? null,
    roles: match ? [...match.roles] : email ? ['ORDERS'] : [],
    language: match?.language ?? null,
  })
}

/** The terms a row gives, as the Party fields they set (only the given ones). */
export interface TermsPatch {
  readonly paymentTermsCode?: string
  /** The price list's code. */
  readonly listCode?: string
  readonly defaultDepositPct?: string
  readonly invoiceTiming?: InvoiceTiming
  readonly incoterm?: string
  readonly preferredCarrierCode?: string
  readonly minimumOrderAmount?: number
}

/**
 * The commercial terms a row gives (null: no terms column), checked as the terms card checks them (factory-domain
 * sales/terms `commercialTermsProblems`), for the party as the row leaves it: a customer only; the minimum order in its
 * currency (at most that currency's decimals). The codes are the adapter's to find.
 */
export function termsOfRow(values: RowValues, party: Pick<PartyFields, 'roles' | 'currency'>): { readonly ok: true; readonly patch: TermsPatch } | { readonly ok: false; readonly issues: readonly RowIssue[] } | null {
  const given = TERMS_COLUMNS.filter((column) => values[column] !== undefined)
  if (given.length === 0) return null
  if (!isCustomer(party.roles)) return { ok: false, issues: [{ column: given[0], message: "Commercial terms are a customer's: give the party the customer or brand role (cliente, marchio), or leave the terms blank." }] }
  const patch: Record<string, unknown> = {}
  const issues: RowIssue[] = []
  if (values.paymentTermsCode !== undefined) patch.paymentTermsCode = String(values.paymentTermsCode)
  if (values.list !== undefined) patch.listCode = String(values.list)
  if (values.defaultDepositPct !== undefined) patch.defaultDepositPct = decimalText(String(values.defaultDepositPct))
  if (values.invoicing !== undefined) patch.invoiceTiming = String(values.invoicing)
  if (values.incoterm !== undefined) patch.incoterm = String(values.incoterm)
  if (values.preferredCarrier !== undefined) patch.preferredCarrierCode = String(values.preferredCarrier).trim()
  if (values.minimumOrder !== undefined) {
    const text = String(values.minimumOrder)
    const places = isCurrencyCode(party.currency) ? minorPlaces(party.currency) : 2
    if ((text.split('.')[1] ?? '').replace(/0+$/, '').length > places) issues.push({ column: 'minimumOrder', message: `At most ${places} decimals in ${party.currency}.` })
    else {
      try {
        patch.minimumOrderAmount = toMinorUnits(text, isCurrencyCode(party.currency) ? party.currency : 'EUR')
      } catch {
        issues.push({ column: 'minimumOrder', message: 'The minimum order is too large.' })
      }
    }
  }
  const at: Readonly<Record<string, TermsColumn>> = { defaultDepositPct: 'defaultDepositPct', incoterm: 'incoterm', preferredCarrierCode: 'preferredCarrier', minimumOrderAmount: 'minimumOrder' }
  for (const issue of commercialTermsProblems(patch as TermsPatch)) issues.push({ column: at[issue.path] ?? given[0], message: issue.message })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, patch: patch as TermsPatch }
}

/** The terms columns a patch sets, as the plan's values (the minimum order back in the currency's units). */
function termsColumnsOfPatch(patch: TermsPatch, currency: string): Partial<Record<TermsColumn, CellValue>> {
  const out: Partial<Record<TermsColumn, CellValue>> = {}
  if (patch.paymentTermsCode !== undefined) out.paymentTermsCode = patch.paymentTermsCode
  if (patch.listCode !== undefined) out.list = patch.listCode
  if (patch.defaultDepositPct !== undefined) out.defaultDepositPct = patch.defaultDepositPct
  if (patch.invoiceTiming !== undefined) out.invoicing = patch.invoiceTiming
  if (patch.incoterm !== undefined) out.incoterm = patch.incoterm
  if (patch.preferredCarrierCode !== undefined) out.preferredCarrier = patch.preferredCarrierCode
  if (patch.minimumOrderAmount !== undefined) out.minimumOrder = majorText(patch.minimumOrderAmount, currency)
  return out
}

/** The active contact a row's contact columns name: by email, else by name (any case). */
export function matchContact(values: RowValues, contacts: readonly ContactFields[]): ContactFields | null {
  const email = str(values.contactEmail)?.toLowerCase()
  if (email !== undefined) return contacts.find((contact) => contact.email === email) ?? null
  const name = str(values.contactName)?.toLowerCase()
  return name === undefined ? null : (contacts.find((contact) => contact.name.toLowerCase() === name) ?? null)
}

// ---- the plan ---------------------------------------------------------------------------------------------------------

const rowIssues = (issues: readonly Issue[], columns: Readonly<Record<string, string>> = {}): RowIssue[] =>
  issues.map((issue) => {
    const field = issue.path.split('/')[0] ?? ''
    const column = Object.entries(columns).find(([, name]) => name === field)?.[0] ?? field
    return isColumn(column) ? { column, message: issue.message } : { message: `${issue.path}: ${issue.message}` }
  })
const refused = (errors: readonly RowIssue[]): RowPlan => ({ action: 'ERROR', errors })

/** What one row does (the importer's `plan`): see the module comment. */
export function planPartyRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    const missing = (['legalName', 'roles'] as const).filter((name) => values[name] === undefined)
    if (missing.length > 0) return refused(missing.map((name) => ({ column: name, message: `${partiesImporter.columns[name].label} is needed for a new party.` })))
    const patch = partyPatchOf(values)
    const outcome = newParty({ ...patch, code: String(values.code), legalName: String(values.legalName), roles: patch.roles ?? [] })
    if (!outcome.ok) return refused(rowIssues(outcome.issues))
    const identity = identityOfRow(values, outcome.party, null)
    const address = addressOfRow(values, outcome.party, null)
    const contact = contactOfRow(values, null)
    const terms = termsOfRow(values, outcome.party)
    const issues = [
      ...(identity && !identity.ok ? rowIssues(identity.issues) : []),
      ...(address && !address.ok ? rowIssues(address.issues, ADDRESS_COLUMNS) : []),
      ...(contact && !contact.ok ? rowIssues(contact.issues, CONTACT_COLUMNS) : []),
      ...(terms && !terms.ok ? terms.issues : []),
    ]
    return issues.length > 0 ? refused(issues) : { action: 'CREATE', after: values }
  }

  const record = recordOf(existing)
  if (record.foreign) return refused([{ column: 'code', message: "This code is another company's party (or one for every company): import it with that company." }])
  if (record.status === 'ARCHIVED') return refused([{ message: 'This party is archived: reactivate it on its page before importing changes.' }])
  const change = changeParty(record.fields, partyPatchOf(values))
  if (!change.ok) return refused(rowIssues(change.issues))
  const party = change.party
  const identity = identityOfRow(values, party, record.identity)
  const address = addressOfRow(values, party, record.registered)
  const match = matchContact(values, record.contacts)
  const contact = contactOfRow(values, match)
  const terms = termsOfRow(values, party)
  const issues = [
    ...(identity && !identity.ok ? rowIssues(identity.issues) : []),
    ...(address && !address.ok ? rowIssues(address.issues, ADDRESS_COLUMNS) : []),
    ...(contact && !contact.ok ? rowIssues(contact.issues, CONTACT_COLUMNS) : []),
    ...(terms && !terms.ok ? terms.issues : []),
  ]
  if (issues.length > 0) return refused(issues)

  const before: Record<string, CellValue | null> = {}
  const after: Record<string, CellValue> = {}
  const note = (column: string, from: CellValue | null, to: CellValue | null) => {
    if (from === to || to === null) return
    before[column] = from
    after[column] = to
  }
  for (const field of change.changed) {
    if (field === 'roles') note('roles', formatRoles(record.fields.roles), formatRoles(party.roles))
    else if (isColumn(field)) note(field, record.fields[field] as CellValue | null, party[field] as CellValue | null)
  }
  if (identity?.ok) for (const name of TAX_COLUMNS) note(name, record.identity ? record.identity[name] : null, identity.identity[name])
  if (address?.ok) for (const [column, field] of Object.entries(ADDRESS_COLUMNS)) note(column, record.registered ? record.registered[field] : null, address.address[field])
  if (contact?.ok) {
    const changes = !match || match.name !== contact.contact.name || match.phone !== contact.contact.phone
    if (changes) for (const [column, field] of Object.entries(CONTACT_COLUMNS)) if (values[column] !== undefined) note(column, null, contact.contact[field])
  }
  if (terms?.ok) {
    // The current terms in the party's currency as the row leaves it (a currency change re-reads the minimum in it).
    const current = termsColumnsOf(record.terms ?? null, party.currency)
    for (const [column, value] of Object.entries(termsColumnsOfPatch(terms.patch, party.currency))) note(column, current[column as TermsColumn], value)
  }
  return Object.keys(after).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before, after }
}

/** The party patch of a planned row's values (the changed party columns). */
export const partyPatchOfRow = partyPatchOf
