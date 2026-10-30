import { convertibleUnits, type ItemUnits, type Uom } from '@nexus/factory-domain/product/units/units'
import { MAX_LEAD_TIME_DAYS, SOURCE_TEXT } from '@nexus/factory-domain/purchasing/sources/sources'
import type { Tone } from '@nexus/ui/primitives'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { MaterialDetail, MaterialOption } from '../../../_shared/buying/api'
import type { LiveState } from '../../../_shared/buying/hooks'
import type { NewSource, Preference, Source, SourceFields, SourceStatus } from './api'

/**
 * Approved sources (SCM-005) on the supplier's Items & prices tab (SCR-057) and the material's Supplier prices (SCR-048):
 * the screens' rules, pure — what this person may do (purchasing.view reads, purchasing.sources.manage keeps, the cost
 * grain shows prices), the views of the list, what a typed cell sends (ONE field per PATCH), the API's refusals in this
 * app's words (a key of `purchasing-sources`, never the API's English), the Add dialog's draft, held reasons, the CSV.
 */

/** Words with their values: a key of `purchasing-sources` and its parameters. */
export interface Say {
  key: string
  params?: Readonly<Record<string, string | number>>
}
export const say = (key: string, params?: Say['params']): Say => (params ? { key, params } : { key })

export interface SourcesCan {
  /** purchasing.view: the sources are Purchasing's. */
  view: boolean
  /** purchasing.sources.manage: add, change, archive and restore. */
  manage: boolean
  /** The cost grain: the supplier's price and the last purchase price. */
  cost: boolean
  /** product.materials.view: the material search of Add a source, the material links. */
  materials: boolean
}

export function sourcesCan(permissions: readonly string[]): SourcesCan {
  const held = new Set(permissions)
  return { view: held.has('purchasing.view'), manage: held.has('purchasing.sources.manage'), cost: held.has('money.cost'), materials: held.has('product.materials.view') }
}

// ---- the list's views ----------------------------------------------------------------------------------------------------

export const SOURCE_VIEWS = ['active', 'archived', 'all'] as const
export type SourceView = (typeof SOURCE_VIEWS)[number]
export const viewStatus = (view: SourceView): SourceStatus | 'ALL' => (view === 'active' ? 'ACTIVE' : view === 'archived' ? 'ARCHIVED' : 'ALL')
export const sourceViewOf = (value: string | null | undefined): SourceView => ((SOURCE_VIEWS as readonly string[]).includes(value ?? '') ? (value as SourceView) : 'active')

export const PREFERENCE_TONE: Readonly<Record<Preference, Tone>> = Object.freeze({ PRIMARY: 'success', BACKUP: 'neutral' })
export const STATUS_TONE: Readonly<Record<SourceStatus, Tone>> = Object.freeze({ ACTIVE: 'success', ARCHIVED: 'neutral' })

/** Primary first, then by material, colour (every colour first) and supplier. */
export function sortedSources(rows: readonly Source[]): Source[] {
  return [...rows].sort(
    (a, b) =>
      a.item.code.localeCompare(b.item.code) ||
      (a.colour?.code ?? '').localeCompare(b.colour?.code ?? '') ||
      (a.preference === b.preference ? 0 : a.preference === 'PRIMARY' ? -1 : 1) ||
      a.supplier.name.localeCompare(b.supplier.name),
  )
}

/** A material's suppliers: active, PRIMARY first, then by supplier. */
export function materialSources(rows: readonly Source[]): Source[] {
  return [...rows]
    .filter((row) => row.status === 'ACTIVE')
    .sort((a, b) => (a.preference === b.preference ? 0 : a.preference === 'PRIMARY' ? -1 : 1) || a.supplier.name.localeCompare(b.supplier.name) || (a.colour?.code ?? '').localeCompare(b.colour?.code ?? ''))
}

/** The rows a search keeps: the material's code or name, the supplier's codes or description (case-insensitive). */
export function sourcesMatching(rows: readonly Source[], q: string): Source[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const text = [row.item.code, row.item.name, row.colour?.code, row.colour?.name, row.supplierArticleCode, row.supplierColourCode, row.description, row.supplier.name].filter(Boolean).join(' ').toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** The lead time in words: the source's own days, else the supplier's usual (or unknown). */
export function leadTimeSay(row: Pick<Source, 'leadTimeDays' | 'supplierLeadTimeDays'>): Say {
  if (row.leadTimeDays !== null) return say('lead.days', { count: row.leadTimeDays })
  if (row.supplierLeadTimeDays !== null) return say('lead.usual', { count: row.supplierLeadTimeDays })
  return say('lead.none')
}

// ---- a cell: what it sends ---------------------------------------------------------------------------------------------------

/** The cells a person types in place (autosave per cell: one field per PATCH). */
export const CELL_FIELDS = ['supplierArticleCode', 'supplierColourCode', 'description', 'purchaseUom', 'unitPrice', 'minOrderQty', 'orderMultiple', 'leadTimeDays', 'preference'] as const
export type CellField = (typeof CELL_FIELDS)[number]

/** A cell's save mark: saving, saved, or refused with its words (composed: the DS CellSaveMark speaks English only). */
export type CellMark = { state: 'saving' } | { state: 'saved' } | { state: 'refused'; words: Say }
export const cellKey = (rowId: string, field: CellField) => `${rowId}:${field}`

/** "12,5" or "12.5" → "12.5"; spaces dropped. */
const plain = (text: string) => text.trim().replace(/\s/g, '').replace(',', '.')
const decimal = (text: string, places: number, min: 'zero' | 'positive'): boolean => {
  if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${places}})?$`).test(text)) return false
  const value = Number(text)
  return min === 'zero' ? value >= 0 : value > 0
}

/** The cell's value as it stands on the row (as text, for the input). */
export function cellText(row: Source, field: CellField): string {
  switch (field) {
    case 'leadTimeDays':
      return row.leadTimeDays === null ? '' : String(row.leadTimeDays)
    case 'unitPrice':
      return row.unitPrice ?? ''
    default:
      return (row[field] as string | null) ?? ''
  }
}

/**
 * What a typed cell sends: the field and its value (null clears it), nothing when it did not change, or why it cannot be
 * sent (a key of `purchasing-sources`). The API checks again (factory-domain purchasing/sources sourceProblems).
 */
export function cellChange(row: Source, field: CellField, typed: string): { fields: SourceFields } | { nothing: true } | { problem: Say } {
  const text = typed.trim()
  if (text === cellText(row, field).trim()) return { nothing: true }
  switch (field) {
    case 'supplierArticleCode':
    case 'supplierColourCode':
      if (text.length > SOURCE_TEXT.code) return { problem: say('cell.tooLong', { max: SOURCE_TEXT.code }) }
      return { fields: { [field]: text === '' ? null : text } }
    case 'description':
      if (text.length > SOURCE_TEXT.description) return { problem: say('cell.tooLong', { max: SOURCE_TEXT.description }) }
      return { fields: { description: text === '' ? null : text } }
    case 'purchaseUom':
      return { fields: { purchaseUom: text as Uom } }
    case 'preference':
      return text === 'PRIMARY' || text === 'BACKUP' ? { fields: { preference: text } } : { nothing: true }
    case 'unitPrice': {
      if (text === '') return { fields: { unitPrice: null } }
      const value = plain(text)
      return decimal(value, 6, 'zero') ? { fields: { unitPrice: value } } : { problem: say('cell.badPrice') }
    }
    case 'minOrderQty':
    case 'orderMultiple': {
      if (text === '') return { fields: { [field]: null } }
      const value = plain(text)
      return decimal(value, 4, 'positive') ? { fields: { [field]: value } } : { problem: say('cell.badQuantity') }
    }
    case 'leadTimeDays': {
      if (text === '') return { fields: { leadTimeDays: null } }
      const value = plain(text)
      if (!/^\d{1,3}$/.test(value) || Number(value) > MAX_LEAD_TIME_DAYS) return { problem: say('cell.badDays', { max: MAX_LEAD_TIME_DAYS }) }
      return { fields: { leadTimeDays: Number(value) } }
    }
  }
}

/** Why a row's cells are text, not inputs (null: they may be typed in). */
export function rowHeld(row: Pick<Source, 'status'>, can: Pick<SourcesCan, 'manage'>): Say | null {
  if (!can.manage) return say('held.noManage')
  if (row.status === 'ARCHIVED') return say('held.archived')
  return null
}

/** The issue paths of a refused write (`body/unitPrice` → `unitPrice`). */
const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath).map((path) => path.replace(/^body[./]/, '')) : [])

/** A refused cell in words: changed by someone else (read again), a field the API refused, archived, no right, no answer. */
export function cellRefusal(error: unknown, field: CellField): { words: Say; reload: boolean } {
  if (!isApiError(error)) return { words: say('problem.write'), reload: false }
  const paths = pathsOf(error)
  if (error.kind === 'conflict' && paths.includes('version')) return { words: say('cell.changed'), reload: true }
  if (error.kind === 'conflict' && error.code === 'invalid_state') return { words: say('cell.archived'), reload: true }
  if (error.kind === 'invalid') {
    if (paths.includes('purchaseUom')) return { words: say('cell.unitNotConverted'), reload: false }
    if (paths.some((path) => path === field || path.startsWith(`${field}.`))) return { words: say(`cell.refused.${field}`), reload: false }
    return { words: say('problem.invalid'), reload: false }
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { words: say('cell.forbidden'), reload: false }
  if (error.kind === 'not_found') return { words: say('problem.gone'), reload: true }
  if (error.kind === 'unavailable') return { words: say('problem.offline'), reload: false }
  return { words: say('problem.write'), reload: false }
}

// ---- Add a source ----------------------------------------------------------------------------------------------------------

export interface AddDraft {
  materialQuery: string
  materials: MaterialOption[] | null
  materialsProblem: string | null
  material: MaterialDetail | null
  materialProblem: string | null
  /** '' every colour. */
  itemColourId: string
  /** 'company' the address's company; 'every' every company of the tenant. */
  scope: 'company' | 'every'
  purchaseUom: string
  unitPrice: string
  currency: string
  minOrderQty: string
  orderMultiple: string
  leadTimeDays: string
  preference: Preference
  supplierArticleCode: string
  supplierColourCode: string
  description: string
  note: string
  busy: boolean
  problem: Say | null
}

export const newAddDraft = (currency: string): AddDraft => ({
  materialQuery: '',
  materials: null,
  materialsProblem: null,
  material: null,
  materialProblem: null,
  itemColourId: '',
  scope: 'company',
  purchaseUom: '',
  unitPrice: '',
  currency,
  minOrderQty: '',
  orderMultiple: '',
  leadTimeDays: '',
  preference: 'BACKUP',
  supplierArticleCode: '',
  supplierColourCode: '',
  description: '',
  note: '',
  busy: false,
  problem: null,
})

/** The material's units as factory-domain reads them (the shared buying read's shape). */
export function unitsOf(material: Pick<MaterialDetail, 'units'>): ItemUnits {
  return {
    baseUom: material.units.base.uom as Uom,
    purchaseUom: material.units.purchase.uom as Uom,
    purchaseFactor: material.units.purchase.factor,
    consumptionUom: material.units.consumption.uom as Uom,
    consumptionFactor: material.units.consumption.factor,
  }
}

/** The units a supplier may sell this material in (the ones it converts to its base unit). */
export const unitsFor = (material: Pick<MaterialDetail, 'units'>): Uom[] => convertibleUnits(unitsOf(material))

/** Why "Add" is held (null: it may be sent), in the order a person fills the dialog. */
export function addHeld(draft: AddDraft, can: Pick<SourcesCan, 'manage' | 'cost'>, supplier: { companyId: string | null; companyIdOfAddress: string | null }): Say | null {
  if (!can.manage) return say('held.noManage')
  if (draft.busy) return say('held.busy')
  if (!draft.material) return say('add.held.material')
  if (draft.scope === 'every' && supplier.companyId !== null) return say('add.held.oneCompany')
  if (draft.scope === 'company' && !supplier.companyIdOfAddress) return say('add.held.noCompany')
  if (draft.purchaseUom && !unitsFor(draft.material).includes(draft.purchaseUom as Uom)) return say('cell.unitNotConverted')
  const checks: [string, string, (value: string) => boolean][] = [
    ['unitPrice', draft.unitPrice, (value) => decimal(plain(value), 6, 'zero')],
    ['minOrderQty', draft.minOrderQty, (value) => decimal(plain(value), 4, 'positive')],
    ['orderMultiple', draft.orderMultiple, (value) => decimal(plain(value), 4, 'positive')],
    ['leadTimeDays', draft.leadTimeDays, (value) => /^\d{1,3}$/.test(plain(value)) && Number(plain(value)) <= MAX_LEAD_TIME_DAYS],
  ]
  for (const [field, value, valid] of checks) if (value.trim() !== '' && !valid(value)) return say(`cell.refused.${field}`)
  if (draft.unitPrice.trim() !== '' && !can.cost) return say('add.held.noCost')
  if (!/^[A-Za-z]{3}$/.test(draft.currency.trim())) return say('add.held.currency')
  return null
}

/** The body of POST /purchasing/supplier-items from the draft (blank fields left out: the API's defaults apply). */
export function addBody(draft: AddDraft, partyId: string, companyIdOfAddress: string | null): NewSource {
  const text = (value: string) => (value.trim() === '' ? undefined : value.trim())
  const number = (value: string) => (value.trim() === '' ? undefined : plain(value))
  return {
    companyId: draft.scope === 'every' ? null : companyIdOfAddress,
    partyId,
    itemId: draft.material!.id,
    ...(draft.itemColourId ? { itemColourId: draft.itemColourId } : {}),
    ...(draft.purchaseUom ? { purchaseUom: draft.purchaseUom as Uom } : {}),
    ...(number(draft.unitPrice) !== undefined ? { unitPrice: number(draft.unitPrice)! } : {}),
    currency: draft.currency.trim().toUpperCase(),
    ...(number(draft.minOrderQty) !== undefined ? { minOrderQty: number(draft.minOrderQty)! } : {}),
    ...(number(draft.orderMultiple) !== undefined ? { orderMultiple: number(draft.orderMultiple)! } : {}),
    ...(number(draft.leadTimeDays) !== undefined ? { leadTimeDays: Number(number(draft.leadTimeDays)) } : {}),
    preference: draft.preference,
    ...(text(draft.supplierArticleCode) ? { supplierArticleCode: text(draft.supplierArticleCode)! } : {}),
    ...(text(draft.supplierColourCode) ? { supplierColourCode: text(draft.supplierColourCode)! } : {}),
    ...(text(draft.description) ? { description: text(draft.description)! } : {}),
    ...(text(draft.note) ? { note: text(draft.note)! } : {}),
  }
}

/** A refused Add in words: a duplicate (409), a role not over every company (403), a field, an archived material or supplier. */
export function addRefusal(error: unknown, scope: AddDraft['scope']): Say {
  if (!isApiError(error)) return say('problem.write')
  const paths = pathsOf(error)
  if (error.kind === 'conflict' && error.code === 'invalid_state') return say('add.refused.archived')
  if (error.kind === 'conflict') return say('add.refused.duplicate')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return scope === 'every' ? say('add.refused.everyCompany') : say('cell.forbidden')
  if (error.kind === 'invalid') {
    if (paths.includes('companyId')) return say('add.refused.company')
    if (paths.includes('partyId')) return say('add.refused.notSupplier')
    if (paths.includes('itemColourId')) return say('add.refused.colour')
    if (paths.includes('purchaseUom')) return say('cell.unitNotConverted')
    const field = (['unitPrice', 'minOrderQty', 'orderMultiple', 'leadTimeDays', 'currency', 'supplierArticleCode', 'supplierColourCode', 'description', 'note'] as const).find((name) => paths.includes(name))
    if (field) return say(`cell.refused.${field}`)
    return say('problem.invalid')
  }
  if (error.kind === 'not_found') return say('add.refused.gone')
  if (error.kind === 'unavailable') return say('problem.offline')
  return say('problem.write')
}

// ---- bulk: archive and restore -----------------------------------------------------------------------------------------------

/** The picked rows each bulk verb reaches: Archive the active ones, Restore the archived ones. */
export function bulkReach(rows: readonly Source[], ids: readonly string[]): { archive: Source[]; restore: Source[] } {
  const picked = rows.filter((row) => ids.includes(row.id))
  return { archive: picked.filter((row) => row.status === 'ACTIVE'), restore: picked.filter((row) => row.status === 'ARCHIVED') }
}

/** A refused archive or restore of one row in words. */
export function bulkRefusal(error: unknown, verb: 'archive' | 'restore'): Say {
  if (!isApiError(error)) return say('problem.write')
  if (error.kind === 'conflict' && pathsOf(error).includes('version')) return say('cell.changed')
  if (error.kind === 'conflict' && error.code === 'invalid_state') return say(`bulk.refused.${verb}State`)
  if (error.kind === 'conflict') return say('bulk.refused.restoreDuplicate')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return say('cell.forbidden')
  if (error.kind === 'not_found') return say('problem.gone')
  if (error.kind === 'unavailable') return say('problem.offline')
  return say('problem.write')
}

export interface BulkOutcome {
  verb: 'archive' | 'restore'
  done: number
  refused: { label: string; words: Say }[]
}

// ---- the CSV -------------------------------------------------------------------------------------------------------------------

const csvCell = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The picked rows as a CSV (semicolons, as Italian spreadsheet programs read them); prices only with the cost grain. */
export function sourcesCsv(rows: readonly Source[], cost: boolean, words: (key: string, params?: Say['params']) => string): string {
  const header = ['material', 'colour', 'company', 'articleCode', 'colourCode', 'description', 'unit', ...(cost ? ['price', 'currency'] : []), 'moq', 'multiple', 'lead', 'preference', 'status'].map((column) => words(`csv.${column}`))
  const body = rows.map((row) => [
    row.item.code,
    row.colour?.code ?? words('everyColour'),
    row.company?.code ?? words('everyCompany'),
    row.supplierArticleCode,
    row.supplierColourCode,
    row.description,
    row.purchaseUom,
    ...(cost ? [row.unitPrice ?? '', row.currency] : []),
    row.minOrderQty,
    row.orderMultiple,
    row.leadTimeDays,
    words(`preference.${row.preference}`),
    words(`status.${row.status}`),
  ])
  return [header, ...body].map((line) => line.map(csvCell).join(';')).join('\r\n')
}

// ---- the view models -------------------------------------------------------------------------------------------------------

export type SourcesRead = { status: 'loading' } | { status: 'ready'; rows: Source[]; more: boolean } | { status: 'error'; problem: string }

export type SourcesDialog = { kind: 'add'; draft: AddDraft } | { kind: 'archive'; ids: string[]; reason: string; busy: boolean } | { kind: 'restore'; ids: string[]; busy: boolean } | { kind: 'keys' }

export interface ApprovedSourcesModel {
  prefix: string
  can: SourcesCan
  supplier: { id: string; name: string; companyId: string | null; currency: string; status: string }
  /** The address's company (a new source holds for it, unless "every company"). */
  company: { id: string; code: string } | null
  view: SourceView
  q: string
  read: SourcesRead
  cells: Readonly<Record<string, CellMark>>
  selected: readonly string[]
  dialog: SourcesDialog | null
  notice: { tone: 'success' | 'danger' | 'info' | 'warning'; words: Say } | null
  bulk: BulkOutcome | null
  updates: number
  live: LiveState
  /** Design cases: the focused row. */
  focusRow?: number
}

export interface ApprovedSourcesActions {
  onView?: (view: SourceView) => void
  onSearch?: (q: string) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onSelect?: (ids: string[]) => void
  onCell?: (row: Source, field: CellField, typed: string) => void
  onDialog?: (dialog: SourcesDialog | null) => void
  onDismissNotice?: () => void
  onExport?: (ids: string[]) => void
  add?: {
    onChange?: (draft: AddDraft) => void
    onMaterialQuery?: (q: string) => void
    onMaterial?: (id: string | null) => void
    onAdd?: () => void
  }
  onArchive?: () => void
  onRestore?: () => void
}

/** A material's Supplier prices: Purchasing's approved sources of it, read only. */
export interface SupplierPricesModel {
  prefix: string
  can: Pick<SourcesCan, 'view' | 'cost'>
  read: SourcesRead
  /** The material's W1 default supplier (said when it has no approved source). */
  defaultSupplier: { id: string; code: string; name: string } | null
}
