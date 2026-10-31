import { businessDate } from '@nexus/factory-domain/core/time'
import type { ListPartiesQuery } from '@nexus/factory-domain/parties/contracts'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { PARTY_KINDS, type PartyRole } from '@nexus/factory-domain/parties/rules'
import { PARTY_TAX_MODES } from '@nexus/factory-domain/parties/tax'
import { listParties } from '../../../modules/parties/parties'
import { defineExportSource, type ExportColumn } from '../source'

/**
 * Sales › Customers (SCR-032, `/sales/customers`) and Purchasing › Suppliers (SCR-056, `/purchasing/suppliers`): the
 * one parties list seen from each side (apps/factory-web areas/parties/_shared PartiesList + model.ts SIDES and
 * viewQuery). The address keeps the saved filter `?view=` (customers: open|active|prospects|brands|invoice|vies|blocked|
 * archived|all; suppliers: open|active|prospects|suppliers|subcontractors|carriers|blocked|archived|all; nothing: open =
 * every status but archived, the side's roles); the screen keeps its search and kind / tax-mode chips out of the
 * address, so the file reads them only when an address names them (`?q=`, `?kind=`, `?taxMode=`). Read through the
 * module's listParties (parties.view, its companies and parties), which also counts the view before the run. No
 * money: the Customers page's Overdue column comes from the receivables read, a read of its own, and is not part of
 * this file.
 *
 * "Full file for re-import (XLSX)": the parties importer's layout (parties.parties, key: the code) — the same importer
 * the Customers page's Import runs.
 */

type Row = Awaited<ReturnType<typeof listParties>>['parties'][number]
type Query = Omit<ListPartiesQuery, 'cursor' | 'limit'>
type Side = 'customers' | 'suppliers'
type Kind = (typeof PARTY_KINDS)[number]
type TaxMode = (typeof PARTY_TAX_MODES)[number]

const SIDE_ROLES: Readonly<Record<Side, readonly PartyRole[]>> = Object.freeze({ customers: ['CUSTOMER', 'BRAND'], suppliers: ['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'] })
const SIDE_VIEWS: Readonly<Record<Side, readonly string[]>> = Object.freeze({
  customers: ['open', 'active', 'prospects', 'brands', 'invoice', 'vies', 'blocked', 'archived', 'all'],
  suppliers: ['open', 'active', 'prospects', 'suppliers', 'subcontractors', 'carriers', 'blocked', 'archived', 'all'],
})
const VIEW_STATUSES: Readonly<Record<string, NonNullable<Query['status']>>> = Object.freeze({ active: ['ACTIVE'], prospects: ['PROSPECT'], blocked: ['BLOCKED'], archived: ['ARCHIVED'], all: ['ALL'] })
const VIEW_ROLES: Readonly<Record<string, PartyRole[]>> = Object.freeze({ brands: ['BRAND'], suppliers: ['SUPPLIER'], subcontractors: ['SUBCONTRACTOR'], carriers: ['CARRIER'] })
const VIEW_ATTENTION: Readonly<Record<string, NonNullable<Query['attention']>>> = Object.freeze({ invoice: 'INVOICE', vies: 'VIES' })

const isKind = (value: string | null): value is Kind => value !== null && (PARTY_KINDS as readonly string[]).includes(value)
const isTaxMode = (value: string | null): value is TaxMode => value !== null && (PARTY_TAX_MODES as readonly string[]).includes(value)

/** The side's query of an address (web model.ts viewQuery). */
function queryOf(side: Side, address: URLSearchParams): Query {
  const asked = address.get('view') ?? 'open'
  const view = SIDE_VIEWS[side].includes(asked) ? asked : 'open'
  const kind = address.get('kind')
  const taxMode = address.get('taxMode')
  const q = address.get('q')?.trim().slice(0, 100) || undefined
  return {
    role: [...(Object.hasOwn(VIEW_ROLES, view) ? VIEW_ROLES[view]! : SIDE_ROLES[side])],
    status: Object.hasOwn(VIEW_STATUSES, view) ? [...VIEW_STATUSES[view]!] : undefined,
    ...(Object.hasOwn(VIEW_ATTENTION, view) ? { attention: VIEW_ATTENTION[view] } : {}),
    ...(isKind(kind) ? { kind } : {}),
    ...(isTaxMode(taxMode) ? { taxMode } : {}),
    q,
  }
}

const langOf = (words: (code: string) => string): 'it' | 'en' => (words('lang') === 'en' ? 'en' : 'it')

/** A region's or a language's name in the file's language (Intl), else its code. */
function displayName(code: string, type: 'region' | 'language', lang: 'it' | 'en'): string {
  try {
    const name = new Intl.DisplayNames([lang], { type }).of(code) ?? code
    return type === 'language' ? name.charAt(0).toLocaleUpperCase(lang) + name.slice(1) : name
  } catch {
    return code
  }
}

/** The VIES standing in words, with the day it was checked ("Valid 2026-10-12"). */
function viesWords(row: Row, words: (code: string) => string): string {
  const { state, checkedAt } = row.vies
  if (checkedAt && state !== 'UNCHECKED' && state !== 'NOT_APPLICABLE') return words(`vies.stateOn.${state}`).replace('{date}', businessDate(new Date(checkedAt)))
  return words(`vies.state.${state}`)
}

/** The SDI code or PEC of an Italian business customer: set / missing; else not needed (web model.ts sdiState). */
function sdiWords(row: Row, words: (code: string) => string): string {
  if (row.taxMode !== 'IT_B2B' || !row.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) return words('sdi.notNeeded')
  return words(row.attention.includes('FISCAL_DRAWER') ? 'sdi.missing' : 'sdi.set')
}

/** The columns both sides share, by the frame's column ids. */
function sharedColumns(side: Side): Record<string, ExportColumn<Row>> {
  return {
    name: { value: (row) => `${row.tradeName ?? row.legalName} · ${row.code}${row.tradeName && row.tradeName !== row.legalName ? ` · ${row.legalName}` : ''}` },
    roles: { value: (row, words) => row.roles.map((role) => words(`role.${role}`)).join(', ') },
    status: { value: (row, words) => (side === 'customers' && row.invoiceBlocked ? `${words(`status.${row.status}`)} · ${words('cannotInvoice')}` : words(`status.${row.status}`)) },
    country: { value: (row, words) => (row.city ? `${displayName(row.country, 'region', langOf(words))} · ${row.city}` : displayName(row.country, 'region', langOf(words))) },
    language: { value: (row, words) => displayName(row.language, 'language', langOf(words)) },
  }
}

const WORDS = {
  it: {
    lang: 'it',
    'status.PROSPECT': 'Potenziale',
    'status.ACTIVE': 'Attivo',
    'status.BLOCKED': 'Bloccato',
    'status.ARCHIVED': 'Archiviato',
    'role.CUSTOMER': 'Cliente',
    'role.BRAND': 'Marchio',
    'role.SUPPLIER': 'Fornitore',
    'role.SUBCONTRACTOR': 'Terzista',
    'role.CARRIER': 'Corriere',
    'taxMode.IT_B2B': 'Azienda italiana',
    'taxMode.IT_B2C': 'Consumatore italiano',
    'taxMode.EU_B2B': 'Azienda UE',
    'taxMode.EU_B2C': 'Consumatore UE',
    'taxMode.EXTRA_EU': 'Extra UE',
    'vies.state.NOT_APPLICABLE': 'Non serve',
    'vies.state.UNCHECKED': 'Non controllato',
    'vies.state.VALID': 'Valido',
    'vies.state.EXPIRED': 'Scaduto',
    'vies.state.INVALID': 'Non valido',
    'vies.state.HELD': 'Senza risposta',
    'vies.stateOn.VALID': 'Valido {date}',
    'vies.stateOn.EXPIRED': 'Scaduto (controllo del {date})',
    'vies.stateOn.INVALID': 'Non valido {date}',
    'vies.stateOn.HELD': 'Senza risposta {date}',
    'sdi.set': 'Presente',
    'sdi.missing': 'Mancante',
    'sdi.notNeeded': 'Non serve',
    cannotInvoice: 'Non ancora fatturabile',
    noIdentity: 'Nessuna identità fiscale',
  },
  en: {
    lang: 'en',
    'status.PROSPECT': 'Prospect',
    'status.ACTIVE': 'Active',
    'status.BLOCKED': 'Blocked',
    'status.ARCHIVED': 'Archived',
    'role.CUSTOMER': 'Customer',
    'role.BRAND': 'Brand',
    'role.SUPPLIER': 'Supplier',
    'role.SUBCONTRACTOR': 'Subcontractor',
    'role.CARRIER': 'Carrier',
    'taxMode.IT_B2B': 'Italian business',
    'taxMode.IT_B2C': 'Italian consumer',
    'taxMode.EU_B2B': 'EU business',
    'taxMode.EU_B2C': 'EU consumer',
    'taxMode.EXTRA_EU': 'Outside the EU',
    'vies.state.NOT_APPLICABLE': 'Not needed',
    'vies.state.UNCHECKED': 'Not checked',
    'vies.state.VALID': 'Valid',
    'vies.state.EXPIRED': 'Expired',
    'vies.state.INVALID': 'Not valid',
    'vies.state.HELD': 'No answer',
    'vies.stateOn.VALID': 'Valid {date}',
    'vies.stateOn.EXPIRED': 'Expired (checked {date})',
    'vies.stateOn.INVALID': 'Not valid {date}',
    'vies.stateOn.HELD': 'No answer {date}',
    'sdi.set': 'Set',
    'sdi.missing': 'Missing',
    'sdi.notNeeded': 'Not needed',
    cannotInvoice: "Can't invoice yet",
    noIdentity: 'No tax identity',
  },
} as const

async function readParties(caller: Parameters<typeof listParties>[0], query: Query, cursor: string | null, limit: number) {
  const page = await listParties(caller, { ...query, cursor: cursor ?? undefined, limit })
  return { rows: page.parties, next: page.nextCursor }
}

const countParties = async (caller: Parameters<typeof listParties>[0], query: Query): Promise<number> => (await listParties(caller, { ...query, limit: 1 })).count

const reimport = { importer: 'parties.parties', key: (row: Row) => ({ code: row.code }) }

export const customers = defineExportSource<Query, Row>({
  listKey: 'sales.customers',
  permission: PARTIES_VIEW,
  query: (address) => queryOf('customers', address),
  read: readParties,
  count: countParties,
  columns: {
    ...sharedColumns('customers'),
    taxMode: { value: (row, words) => (row.taxMode ? words(`taxMode.${row.taxMode}`) : words('noIdentity')) },
    vies: { value: (row, words) => viesWords(row, words) },
    sdi: { value: (row, words) => sdiWords(row, words) },
  },
  reimport,
  words: WORDS,
})

export const suppliers = defineExportSource<Query, Row>({
  listKey: 'purchasing.suppliers',
  permission: PARTIES_VIEW,
  query: (address) => queryOf('suppliers', address),
  read: readParties,
  count: countParties,
  columns: {
    ...sharedColumns('suppliers'),
    vat: { value: (row, words) => (row.vies.state !== 'NOT_APPLICABLE' ? `${row.vatNumber ?? row.fiscalCode ?? '—'} · ${viesWords(row, words)}` : (row.vatNumber ?? row.fiscalCode)) },
  },
  reimport,
  words: WORDS,
})
