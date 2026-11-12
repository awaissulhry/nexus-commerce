import { QUANTITY, UNIT_PRICE } from '../../core/money'
import { cell, foldWord, type CellValue } from '../../imports/cells'
import { defineImporter, type RecordValues, type RowIssue, type RowValues } from '../../imports/importer'
import { colourCell, EVERY_COLOUR } from '../../planning/settings/importer'
import { unitCell } from '../../product/materials/importer'
import { TANNAGES, type Tannage } from '../../product/materials/rules'
import { MAX_LEAD_TIME_DAYS, SOURCE_PREFERENCES, SOURCE_TEXT } from '../sources/sources'
import {
  changeProfile,
  cleanReason,
  hasSupplierRole,
  LIMITS,
  normaliseCountries,
  normaliseKinds,
  normaliseTannages,
  REASON_MAX,
  statusChangeProblems,
  SUPPLIER_KINDS,
  SUPPLIER_STATUSES,
  type ProfilePatch,
  type SupplierKind,
  type SupplierProfile,
  type SupplierStatus,
} from './rules'

/**
 * Import of suppliers and their price lists from a sheet, dry run first (B-W2b-311; SCM-289 → PLT-176; design
 * purchasing.suppliers header "Import" and the supplier's Items & prices "Import price list").
 *
 * 1. Suppliers: the customers and suppliers import (`parties.parties`, factory-domain parties/importer) gains the supplier
 *    columns below, after its earlier ones (older sheets keep their layout): supplier kinds, supplier status and its
 *    reason, the default lead time, the origin (country, region, words) and, for a tannery, where its raw hides come from
 *    and its tannages. `supplierOfRow` decides them in the dry run as the supplier record does (./rules): only on a party
 *    with a supplier role; kinds, countries and tannages split by `;`; a status move the lifecycle allows, with its reason
 *    where one is needed. A blank cell is "not given", never "clear it". The Supplier status and Status reason columns
 *    need purchasing.suppliers.status (the adapter's authorize).
 * 2. Price lists: `purchasing.supplierPrices`, one approved source per row (B-W2a-10's SupplierItem: what a supplier sells
 *    us and on what terms), keyed by the supplier's code, the material's code and the colour's code (* for every colour),
 *    in the job's company (none: every company). A new key makes a source (the scope's first is its PRIMARY); a known one
 *    changes the cells the row gives. The price is a cost (the cost grain).
 */

// ---- 1. the supplier columns of the parties import -------------------------------------------------------------------

const KIND_ALIASES: Readonly<Record<string, SupplierKind>> = {
  conceria: 'TANNERY', concerie: 'TANNERY', tannery: 'TANNERY', pelli: 'TANNERY', pellami: 'TANNERY',
  tessitura: 'TEXTILE_MILL', lanificio: 'TEXTILE_MILL', tessuti: 'TEXTILE_MILL', tessile: 'TEXTILE_MILL', 'textile mill': 'TEXTILE_MILL', textile: 'TEXTILE_MILL', fabrics: 'TEXTILE_MILL',
  accessori: 'TRIMS', minuteria: 'TRIMS', 'minuterie metalliche': 'TRIMS', trims: 'TRIMS', zip: 'TRIMS',
  protezioni: 'PROTECTOR_MAKER', protettori: 'PROTECTOR_MAKER', 'protector maker': 'PROTECTOR_MAKER', protectors: 'PROTECTOR_MAKER',
  terzista: 'SUBCONTRACTOR', laboratorio: 'SUBCONTRACTOR', contoterzista: 'SUBCONTRACTOR', subcontractor: 'SUBCONTRACTOR',
  corriere: 'CARRIER', vettore: 'CARRIER', spedizioniere: 'CARRIER', carrier: 'CARRIER',
  servizi: 'SERVICE', servizio: 'SERVICE', service: 'SERVICE', services: 'SERVICE',
  ...Object.fromEntries(SUPPLIER_KINDS.map((kind) => [kind.toLowerCase(), kind])),
}
const STATUS_ALIASES = {
  potenziale: 'PROSPECT', prospect: 'PROSPECT', nuovo: 'PROSPECT', 'in valutazione': 'PROSPECT',
  approvato: 'APPROVED', qualificato: 'APPROVED', omologato: 'APPROVED', approved: 'APPROVED', attivo: 'APPROVED',
  'approvato con riserva': 'CONDITIONAL', condizionato: 'CONDITIONAL', 'con riserva': 'CONDITIONAL', conditional: 'CONDITIONAL',
  sospeso: 'ON_HOLD', 'in attesa': 'ON_HOLD', 'on hold': 'ON_HOLD',
  bloccato: 'BLOCKED', blocked: 'BLOCKED',
  inattivo: 'INACTIVE', 'non attivo': 'INACTIVE', 'non piu usato': 'INACTIVE', inactive: 'INACTIVE',
} as const satisfies Record<string, SupplierStatus>
const TANNAGE_WORDS: Readonly<Record<string, Tannage>> = {
  cromo: 'CHROME', 'al cromo': 'CHROME', chrome: 'CHROME',
  vegetale: 'VEGETABLE', 'al vegetale': 'VEGETABLE', vegetable: 'VEGETABLE',
  'senza cromo': 'CHROME_FREE', 'chrome free': 'CHROME_FREE', 'metal free': 'CHROME_FREE', 'chrome-free': 'CHROME_FREE',
  mista: 'COMBINATION', misto: 'COMBINATION', combinata: 'COMBINATION', combination: 'COMBINATION',
  ...Object.fromEntries(TANNAGES.map((tannage) => [tannage.toLowerCase(), tannage])),
}

/** The parties import's supplier columns (spread after its terms columns). */
export const SUPPLIER_IMPORT_COLUMNS = {
  supplierKinds: { label: 'Supplier kinds', aliases: ['tipo fornitore', 'categoria fornitore', 'tipologia fornitore', 'supplier kind', 'supplier type', 'kinds'], type: cell.text({ max: 200 }), description: 'conceria, tessitura, accessori, protezioni, terzista, corriere, servizi (split by ;); a supplier only.' },
  supplierStatus: { label: 'Supplier status', aliases: ['stato fornitore', 'qualifica fornitore', 'supplier status'], type: cell.oneOf(SUPPLIER_STATUSES, STATUS_ALIASES), description: 'potenziale, approvato, con riserva, sospeso, bloccato, inattivo; needs purchasing.suppliers.status.' },
  supplierStatusReason: { label: 'Status reason', aliases: ['motivo stato', 'motivo', 'status reason'], type: cell.text({ max: REASON_MAX }), description: 'Why: needed for con riserva, sospeso and bloccato (one line).' },
  leadTimeDays: { label: 'Lead time (days)', aliases: ['lead time', 'tempo di consegna', 'giorni di consegna', 'giorni consegna', 'lead time days'], type: cell.integer({ min: 0, max: LIMITS.leadTimeDays }), description: 'Calendar days from the order to the goods at our site (its closed days are added).' },
  originCountry: { label: 'Country of manufacture', aliases: ['paese di produzione', 'origine', 'made in', 'country of origin', 'origin country'], type: cell.code({ max: 2, upper: true }), description: 'Where it makes what it sells us (ISO 3166-1 alpha-2).' },
  originRegion: { label: 'Region of manufacture', aliases: ['regione di produzione', 'distretto', 'zona di produzione', 'origin region'], type: cell.text({ max: LIMITS.region }) },
  originNote: { label: 'Origin note', aliases: ['note origine', 'origine note', 'origin note'], type: cell.text({ max: LIMITS.note }) },
  hideOriginCountries: { label: 'Raw hides from', aliases: ['origine pelli', 'provenienza pelli', 'provenienza pelli grezze', 'hides origin', 'raw hides from'], type: cell.text({ max: 200 }), description: 'Country codes split by ; (a tannery only).' },
  tannages: { label: 'Tannages', aliases: ['concia', 'tipo di concia', 'concie', 'tannage'], type: cell.text({ max: 100 }), description: 'cromo, vegetale, senza cromo, mista (split by ;; a tannery only).' },
} as const

export const SUPPLIER_COLUMN_NAMES = Object.keys(SUPPLIER_IMPORT_COLUMNS) as (keyof typeof SUPPLIER_IMPORT_COLUMNS)[]
export type SupplierColumn = (typeof SUPPLIER_COLUMN_NAMES)[number]
/** The columns that set the supplier status (purchasing.suppliers.status). */
export const STATUS_COLUMNS: readonly SupplierColumn[] = Object.freeze(['supplierStatus', 'supplierStatusReason'])

/** A supplier as the import sees it (the parties adapter loads it beside the party). */
export interface ImportedSupplier extends SupplierProfile {
  readonly supplierStatus: SupplierStatus | null
  readonly supplierStatusReason: string | null
}

const splitList = (text: string): string[] => text.split(/[;,|/]/).map((word) => word.trim()).filter((word) => word !== '')
const joined = (list: readonly string[]): string | null => (list.length === 0 ? null : list.join('; '))

function wordsOf<Value extends string>(text: string, lookup: Readonly<Record<string, Value>>): { readonly values: Value[]; readonly unknown: string[] } {
  const folded = new Map(Object.entries(lookup).map(([word, value]) => [foldWord(word), value]))
  const values: Value[] = []
  const unknown: string[] = []
  for (const word of splitList(text)) {
    const value = folded.get(foldWord(word))
    if (value === undefined) unknown.push(word)
    else if (!values.includes(value)) values.push(value)
  }
  return { values, unknown }
}

/** The supplier columns' current values (a party without a supplier role: none). */
export function supplierColumnsOf(supplier: ImportedSupplier | null | undefined, roles: readonly string[]): Record<SupplierColumn, CellValue | null> {
  if (!supplier || !hasSupplierRole(roles)) return Object.fromEntries(SUPPLIER_COLUMN_NAMES.map((name) => [name, null])) as Record<SupplierColumn, null>
  return {
    // Kinds and tannages in their enum's order (the record may hold another order): a file for re-import reads back the same.
    supplierKinds: joined(normaliseKinds(supplier.kinds)),
    supplierStatus: supplier.supplierStatus,
    supplierStatusReason: supplier.supplierStatusReason,
    leadTimeDays: supplier.leadTimeDays,
    originCountry: supplier.originCountry,
    originRegion: supplier.originRegion,
    originNote: supplier.originNote,
    hideOriginCountries: joined(supplier.hideOriginCountries),
    tannages: joined(normaliseTannages(supplier.tannages)),
  }
}

const EMPTY_PROFILE: SupplierProfile = { kinds: [], leadTimeDays: null, originCountry: null, originRegion: null, originNote: null, hideOriginCountries: [], tannages: [] }
const PROFILE_COLUMN: Readonly<Record<keyof SupplierProfile, SupplierColumn>> = {
  kinds: 'supplierKinds',
  leadTimeDays: 'leadTimeDays',
  originCountry: 'originCountry',
  originRegion: 'originRegion',
  originNote: 'originNote',
  hideOriginCountries: 'hideOriginCountries',
  tannages: 'tannages',
}

/** What a row does to the supplier side of a party. */
export interface SupplierRowPlan {
  readonly profile: SupplierProfile
  readonly profileChanged: readonly (keyof SupplierProfile)[]
  /** The status the row sets (null: none). */
  readonly status: { readonly from: SupplierStatus | null; readonly to: SupplierStatus; readonly reason: string | null } | null
  /** The supplier columns that change, with what they hold now and will hold. */
  readonly changes: Readonly<Partial<Record<SupplierColumn, { readonly before: CellValue | null; readonly after: CellValue }>>>
}

/**
 * The supplier columns a row gives (null: none), checked for the party as the row leaves it (`roles`), against what it
 * holds now (`current`; null for a new party: the status a new supplier gets otherwise is the parties' rule, its W1
 * status read as one, so a status given here is the first one).
 */
export function supplierOfRow(values: RowValues, roles: readonly string[], current: ImportedSupplier | null): { readonly ok: true; readonly plan: SupplierRowPlan } | { readonly ok: false; readonly issues: readonly RowIssue[] } | null {
  const given = SUPPLIER_COLUMN_NAMES.filter((column) => values[column] !== undefined)
  if (given.length === 0) return null
  if (!hasSupplierRole(roles)) return { ok: false, issues: [{ column: given[0], message: 'Supplier columns are a supplier’s: give the party the supplier, subcontractor or carrier role (fornitore, terzista, corriere), or leave them blank.' }] }
  const issues: RowIssue[] = []
  const patch: Record<string, unknown> = {}
  if (values.supplierKinds !== undefined) {
    const { values: kinds, unknown } = wordsOf(String(values.supplierKinds), KIND_ALIASES)
    if (unknown.length > 0) issues.push({ column: 'supplierKinds', message: `Not a supplier kind: ${unknown.join(', ')}. Expected conceria, tessitura, accessori, protezioni, terzista, corriere or servizi.` })
    else patch.kinds = kinds
  }
  if (values.tannages !== undefined) {
    const { values: tannages, unknown } = wordsOf(String(values.tannages), TANNAGE_WORDS)
    if (unknown.length > 0) issues.push({ column: 'tannages', message: `Not a tannage: ${unknown.join(', ')}. Expected cromo, vegetale, senza cromo or mista.` })
    else patch.tannages = tannages
  }
  if (values.hideOriginCountries !== undefined) patch.hideOriginCountries = normaliseCountries(splitList(String(values.hideOriginCountries)))
  if (values.leadTimeDays !== undefined) patch.leadTimeDays = Number(values.leadTimeDays)
  for (const column of ['originCountry', 'originRegion', 'originNote'] as const) if (values[column] !== undefined) patch[column] = String(values[column])
  if (issues.length > 0) return { ok: false, issues }

  const before = current ?? { ...EMPTY_PROFILE, supplierStatus: null, supplierStatusReason: null }
  const change = changeProfile(before, patch as ProfilePatch, roles)
  if (!change.ok) {
    return { ok: false, issues: change.issues.map((issue) => ({ column: PROFILE_COLUMN[issue.path as keyof SupplierProfile] ?? given[0], message: issue.message })) }
  }

  let status: SupplierRowPlan['status'] = null
  if (values.supplierStatus !== undefined || values.supplierStatusReason !== undefined) {
    const from = before.supplierStatus
    const to = (values.supplierStatus as SupplierStatus | undefined) ?? from
    const reason = values.supplierStatusReason !== undefined ? cleanReason(String(values.supplierStatusReason)) : to === from ? before.supplierStatusReason : null
    if (to === null) return { ok: false, issues: [{ column: 'supplierStatusReason', message: 'A status reason needs a supplier status: give the Supplier status column too.' }] }
    if (!(to === from && reason === before.supplierStatusReason)) {
      const problems = statusChangeProblems(from, to, reason)
      if (problems.length > 0) return { ok: false, issues: problems.map((issue) => ({ column: issue.path === 'reason' ? 'supplierStatusReason' : 'supplierStatus', message: issue.message })) }
      status = { from, to, reason }
    }
  }

  const now = supplierColumnsOf(before, roles)
  const next = supplierColumnsOf({ ...change.profile, supplierStatus: status?.to ?? before.supplierStatus, supplierStatusReason: status ? status.reason : before.supplierStatusReason }, roles)
  const changes: Partial<Record<SupplierColumn, { before: CellValue | null; after: CellValue }>> = {}
  for (const column of SUPPLIER_COLUMN_NAMES) {
    const after = next[column]
    if (after !== null && after !== now[column]) changes[column] = { before: now[column], after }
  }
  return { ok: true, plan: { profile: change.profile, profileChanged: change.changed, status, changes } }
}

// ---- 2. a supplier's price list ----------------------------------------------------------------------------------------

export const SUPPLIER_PRICES_IMPORTER_KEY = 'purchasing.supplierPrices'

const PREFERENCE_ALIASES = {
  principale: 'PRIMARY', primario: 'PRIMARY', preferito: 'PRIMARY', primary: 'PRIMARY', main: 'PRIMARY',
  riserva: 'BACKUP', alternativo: 'BACKUP', secondario: 'BACKUP', backup: 'BACKUP', alternate: 'BACKUP',
} as const

export const supplierPricesImporter = defineImporter({
  key: SUPPLIER_PRICES_IMPORTER_KEY,
  label: 'Supplier price lists',
  description: 'What each supplier sells us and on what terms: its article and colour codes, the unit, the price (a cost), minimum, steps and lead time, primary or backup.',
  columns: {
    supplier: { label: 'Supplier', aliases: ['fornitore', 'codice fornitore', 'supplier code'], required: true, type: cell.code({ upper: true, max: 24 }), description: 'The supplier’s code (a supplier or subcontractor).' },
    material: { label: 'Material', aliases: ['materiale', 'articolo', 'codice articolo', 'codice materiale', 'item', 'material code'], required: true, type: cell.code({ upper: true, max: 40 }), description: 'Our material’s code.' },
    colour: { label: 'Colour', aliases: ['colore', 'codice colore', 'colour code', 'color'], required: true, type: colourCell, description: 'The material’s colour code, or * for every colour.' },
    supplierArticleCode: { label: 'Supplier article', aliases: ['articolo fornitore', 'codice articolo fornitore', 'supplier article code', 'supplier code article'], type: cell.text({ max: SOURCE_TEXT.code }) },
    supplierColourCode: { label: 'Supplier colour', aliases: ['colore fornitore', 'codice colore fornitore', 'supplier colour code'], type: cell.text({ max: SOURCE_TEXT.code }) },
    description: { label: 'Description', aliases: ['descrizione', 'descrizione fornitore'], type: cell.text({ max: SOURCE_TEXT.description }) },
    purchaseUom: { label: 'Purchase unit', aliases: ['unita di acquisto', 'um acquisto', 'um', 'unit'], type: unitCell(), description: 'Left out: the material’s purchase unit.' },
    unitPrice: { label: 'Unit price', aliases: ['prezzo', 'prezzo unitario', 'prezzo di acquisto', 'costo', 'unit price', 'price'], type: cell.decimal({ precision: UNIT_PRICE.precision, scale: UNIT_PRICE.scale, min: '0' }), grain: 'cost', description: 'Per purchase unit, in the currency.' },
    currency: { label: 'Currency', aliases: ['valuta', 'divisa'], type: cell.code({ max: 3, upper: true }), description: 'Left out: the supplier’s currency.' },
    minOrderQty: { label: 'Minimum', aliases: ['minimo', 'minimo ordinabile', 'ordine minimo', 'moq', 'minimum order'], type: cell.decimal({ precision: QUANTITY.precision, scale: QUANTITY.scale, min: '0' }), description: 'In the purchase unit.' },
    orderMultiple: { label: 'Step', aliases: ['multiplo', 'confezione', 'passo', 'order multiple', 'pack'], type: cell.decimal({ precision: QUANTITY.precision, scale: QUANTITY.scale, min: '0' }), description: 'In the purchase unit.' },
    leadTimeDays: { label: 'Lead time (days)', aliases: ['lead time', 'tempo di consegna', 'giorni di consegna', 'lead time days'], type: cell.integer({ min: 0, max: MAX_LEAD_TIME_DAYS }) },
    preference: { label: 'Primary or backup', aliases: ['preferenza', 'principale o riserva', 'preference'], type: cell.oneOf(SOURCE_PREFERENCES, PREFERENCE_ALIASES), description: 'principale or riserva; the first source of a material is its primary.' },
    note: { label: 'Note', aliases: ['nota', 'note', 'commento'], type: cell.text({ max: SOURCE_TEXT.note }) },
  },
  keyColumns: ['supplier', 'material', 'colour'],
  batchSize: 100,
})

/** The value columns of the price list import (every column but the key) and the source fields they set. */
export const PRICE_VALUE_COLUMNS = ['supplierArticleCode', 'supplierColourCode', 'description', 'purchaseUom', 'unitPrice', 'currency', 'minOrderQty', 'orderMultiple', 'leadTimeDays', 'preference', 'note'] as const
export type PriceValueColumn = (typeof PRICE_VALUE_COLUMNS)[number]

/** A price row's colour key: null for every colour (*). */
export const colourOfKey = (value: CellValue | undefined): string | null => (value === undefined || value === EVERY_COLOUR ? null : String(value))

/** A source's current values as the price list import compares them (decimals as plain strings). */
export function priceRecordValues(key: { readonly supplier: string; readonly material: string; readonly colour: string | null }, source: Readonly<Record<PriceValueColumn, CellValue | null>>): RecordValues {
  return { supplier: key.supplier, material: key.material, colour: key.colour ?? EVERY_COLOUR, ...source }
}
