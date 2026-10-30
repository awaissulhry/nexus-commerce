import { CR6_LEGAL_LIMIT_MG_KG, ITEM_KINDS, kindDefaults, newMaterial, type ItemKind, type ItemSourcing, type ItemTracking, type Tannage } from '@nexus/factory-domain/product/materials/rules'
import { dimensionOf, fixedRatio, UOMS, type Uom } from '@nexus/factory-domain/product/units/units'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { csvOf, type LibraryCan } from '../library/model'
import type { MaterialQuery, MaterialRow, MaterialView, NewMaterialBody } from './api'

/**
 * Materials & trims rules (SCR-047/048), pure: the saved views and tiles (each a filter the API applies, so a tile's
 * number is the list's total under it), the units in words with the live converter ("1 hide = 52.5 ft² = 487.7 dm²"),
 * the New material draft checked by the domain's own rules as it is typed, the held reasons, the CSV.
 */

export { ITEM_KINDS, UOMS }
export type { ItemKind, Uom }

// ---- saved views and tiles ----------------------------------------------------------------------------------------------

export const MATERIAL_VIEWS = ['open', 'leather', 'textiles', 'trims', 'protectors', 'labels', 'missingCost', 'crvi', 'ppe', 'archived', 'all'] as const
export type MaterialListView = (typeof MATERIAL_VIEWS)[number]

/** The tiles (design materials.tiles): a named saved filter each; "Missing cost" only for the cost grain. */
export const MATERIAL_TILES = ['leather', 'missingCost', 'crvi', 'ppe'] as const satisfies readonly MaterialListView[]
export type MaterialTile = (typeof MATERIAL_TILES)[number]

const KIND_GROUPS: Partial<Record<MaterialListView, readonly ItemKind[]>> = {
  leather: ['LEATHER'],
  textiles: ['TEXTILE', 'LINING', 'MEMBRANE', 'PADDING'],
  trims: ['TRIM', 'HARDWARE', 'THREAD', 'COMPONENT'],
  protectors: ['PROTECTOR'],
  labels: ['LABEL', 'PACKAGING'],
}

/** The views a person may pick (Missing cost needs the cost grain: the API refuses it otherwise). */
export const viewsFor = (can: Pick<LibraryCan, 'seesCost'>): MaterialListView[] => MATERIAL_VIEWS.filter((view) => view !== 'missingCost' || can.seesCost)
export const tilesFor = (can: Pick<LibraryCan, 'seesCost'>): MaterialTile[] => MATERIAL_TILES.filter((tile) => tile !== 'missingCost' || can.seesCost)

export function viewOf(value: string | null | undefined): MaterialListView {
  return (MATERIAL_VIEWS as readonly string[]).includes(value ?? '') ? (value as MaterialListView) : 'open'
}

/** The API's own filters for a saved view. */
export function viewQuery(view: MaterialListView): MaterialQuery {
  const kinds = KIND_GROUPS[view]
  if (kinds) return { kind: kinds }
  switch (view) {
    case 'missingCost':
      return { missingCost: true }
    case 'crvi':
      return { requiresCrViTest: true }
    case 'ppe':
      return { ppeComponent: true }
    case 'archived':
      return { status: 'ARCHIVED' }
    case 'all':
      return { status: 'ALL' }
    default:
      return {}
  }
}

export interface MaterialFilters {
  view: MaterialListView
  q: string
  /** One kind on top of the view, or ''. */
  kind: '' | ItemKind
}

export const NO_FILTERS: MaterialFilters = { view: 'open', q: '', kind: '' }

/** The list's query: the view's filters, the kind (narrowed inside the view's kinds) and the search. */
export function listQuery(filters: MaterialFilters, cursor: string | null): MaterialQuery {
  const base = viewQuery(filters.view)
  const kind = filters.kind ? (base.kind ? (base.kind.includes(filters.kind) ? [filters.kind] : base.kind) : [filters.kind]) : base.kind
  return { ...base, kind, q: filters.q, cursor }
}

export const isFiltered = (filters: MaterialFilters): boolean => filters.view !== 'open' || filters.kind !== '' || filters.q.trim() !== ''

// ---- units in words ----------------------------------------------------------------------------------------------------

/** "1 hide = 52.5 ft² = 487.74 dm²": what one purchase unit holds in the base and the consumption unit. */
export interface Converter {
  purchase: { uom: Uom; inBase: number } | null
  consumption: { uom: Uom; inBase: number; perPurchase: number | null } | null
}

/** The factor of a unit for this base: 1, the fixed ratio, or the typed factor (null when unknown). */
export function factorOf(unit: Uom, base: Uom, typed: string | null | undefined): number | null {
  if (unit === base) return 1
  const fixed = fixedRatio(unit, base)
  if (fixed) return fixed.toNumber()
  const value = typed === null || typed === undefined || typed === '' ? NaN : Number(typed)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Whether a unit's factor must be typed (another dimension than the base unit's, or an item unit). */
export const needsFactor = (unit: Uom, base: Uom): boolean => unit !== base && fixedRatio(unit, base) === null

export function converterOf(units: { baseUom: Uom; purchaseUom: Uom; purchaseFactor: string | null; consumptionUom: Uom; consumptionFactor: string | null }): Converter {
  const purchase = units.purchaseUom === units.baseUom ? null : factorOf(units.purchaseUom, units.baseUom, units.purchaseFactor)
  const consumption = units.consumptionUom === units.baseUom ? null : factorOf(units.consumptionUom, units.baseUom, units.consumptionFactor)
  return {
    purchase: purchase === null ? null : { uom: units.purchaseUom, inBase: purchase },
    consumption: consumption === null ? null : { uom: units.consumptionUom, inBase: consumption, perPurchase: purchase === null ? null : purchase / consumption },
  }
}

/** A number as the person reads it, at most `decimals` places ("52,5" in Italian). */
export function numberText(value: number, locale: 'it' | 'en', decimals = 4): string {
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: decimals }).format(value)
}

/** The base unit's dimension decides which units convert by themselves. */
export const isArea = (uom: Uom): boolean => dimensionOf(uom) === 'AREA'

// ---- the New material draft ---------------------------------------------------------------------------------------------

export interface NewMaterialDraft {
  companyId: string | null
  kind: ItemKind
  code: string
  name: string
  baseUom: Uom
  purchaseUom: Uom
  purchaseFactor: string
  consumptionUom: Uom
  consumptionFactor: string
  sourcing: ItemSourcing
  tracking: ItemTracking
  supplier: { id: string; code: string; name: string } | null
  supplierArticleCode: string
  animalSpecies: string
  tannage: Tannage | ''
  grade: string
  thicknessMinMm: string
  thicknessMaxMm: string
  requiresCrViTest: boolean
  crViLimitMgKg: string
  standardCost: string
}

/** Units a kind starts with: leather bought by the hide, stocked in ft², cut in dm²; thread by the cone in metres … */
const KIND_UNITS: Record<ItemKind, { base: Uom; purchase: Uom; consumption: Uom }> = {
  LEATHER: { base: 'FT2', purchase: 'HIDE', consumption: 'DM2' },
  TEXTILE: { base: 'M', purchase: 'ROLL', consumption: 'M' },
  LINING: { base: 'M', purchase: 'ROLL', consumption: 'M' },
  MEMBRANE: { base: 'M', purchase: 'ROLL', consumption: 'M' },
  PADDING: { base: 'M', purchase: 'ROLL', consumption: 'M' },
  THREAD: { base: 'M', purchase: 'CONE', consumption: 'M' },
  TRIM: { base: 'PCS', purchase: 'PCS', consumption: 'PCS' },
  HARDWARE: { base: 'PCS', purchase: 'PCS', consumption: 'PCS' },
  PROTECTOR: { base: 'PCS', purchase: 'PCS', consumption: 'PCS' },
  LABEL: { base: 'PCS', purchase: 'PCS', consumption: 'PCS' },
  PACKAGING: { base: 'PCS', purchase: 'PCS', consumption: 'PCS' },
  COMPONENT: { base: 'PCS', purchase: 'PCS', consumption: 'PCS' },
}

/** A fresh draft of a kind: its units, make or buy, tracking and Cr VI defaults (leather: the legal 3 mg/kg). */
export function draftFor(kind: ItemKind, companyId: string | null, keep?: Partial<NewMaterialDraft>): NewMaterialDraft {
  const units = KIND_UNITS[kind]
  const defaults = kindDefaults(kind)
  return {
    companyId,
    code: keep?.code ?? '',
    name: keep?.name ?? '',
    supplier: defaults.sourcing === 'MAKE' ? null : (keep?.supplier ?? null),
    supplierArticleCode: defaults.sourcing === 'MAKE' ? '' : (keep?.supplierArticleCode ?? ''),
    standardCost: keep?.standardCost ?? '',
    kind,
    baseUom: units.base,
    purchaseUom: units.purchase,
    purchaseFactor: '',
    consumptionUom: units.consumption,
    consumptionFactor: '',
    sourcing: defaults.sourcing,
    tracking: defaults.tracking,
    animalSpecies: '',
    tannage: '',
    grade: '',
    thicknessMinMm: '',
    thicknessMaxMm: '',
    requiresCrViTest: kind === 'LEATHER',
    crViLimitMgKg: kind === 'LEATHER' ? CR6_LEGAL_LIMIT_MG_KG : '',
  }
}

/** A typed decimal as the API wants it ("52,5" → "52.5"); '' stays '' (left out). */
export const plain = (text: string): string => text.trim().replace(/\s/g, '').replace(',', '.')
const orNull = (text: string): string | null => (plain(text) === '' ? null : plain(text))

/** The body the dialog sends: the cost only for a person who may set it. */
export function bodyOf(draft: NewMaterialDraft, can: Pick<LibraryCan, 'materialsCost'>): NewMaterialBody {
  const leather = draft.kind === 'LEATHER'
  return {
    companyId: draft.companyId,
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    kind: draft.kind,
    baseUom: draft.baseUom,
    purchaseUom: draft.purchaseUom,
    purchaseFactor: needsFactor(draft.purchaseUom, draft.baseUom) ? orNull(draft.purchaseFactor) : null,
    consumptionUom: draft.consumptionUom,
    consumptionFactor: needsFactor(draft.consumptionUom, draft.baseUom) ? orNull(draft.consumptionFactor) : null,
    sourcing: draft.sourcing,
    tracking: draft.tracking,
    defaultSupplierId: draft.sourcing === 'MAKE' ? null : (draft.supplier?.id ?? null),
    supplierArticleCode: draft.sourcing === 'MAKE' ? null : draft.supplierArticleCode.trim() || null,
    animalSpecies: leather ? draft.animalSpecies.trim() || null : null,
    tannage: leather ? draft.tannage || null : null,
    grade: leather ? draft.grade.trim() || null : null,
    thicknessMinMm: leather ? orNull(draft.thicknessMinMm) : null,
    thicknessMaxMm: leather ? orNull(draft.thicknessMaxMm) : null,
    animalOrigin: kindDefaults(draft.kind).animalOrigin,
    isPpeComponent: kindDefaults(draft.kind).isPpeComponent,
    requiresCrViTest: draft.requiresCrViTest,
    crViLimitMgKg: draft.requiresCrViTest ? orNull(draft.crViLimitMgKg) : null,
    ...(can.materialsCost && plain(draft.standardCost) !== '' ? { standardCost: plain(draft.standardCost) } : {}),
  }
}

/**
 * What the domain's own rules say about the draft as typed (the same check the API runs), as field paths and the
 * domain's sentence; the dialog names the field in our words and keeps the sentence as data.
 */
export function draftProblems(draft: NewMaterialDraft): Issue[] {
  const body = bodyOf(draft, { materialsCost: false })
  const outcome = newMaterial({
    code: body.code,
    name: body.name,
    kind: body.kind,
    baseUom: body.baseUom as Uom,
    purchaseUom: body.purchaseUom as Uom,
    purchaseFactor: body.purchaseFactor,
    consumptionUom: body.consumptionUom as Uom,
    consumptionFactor: body.consumptionFactor,
    sourcing: body.sourcing as ItemSourcing,
    tracking: body.tracking as ItemTracking,
    defaultSupplierId: body.defaultSupplierId,
    supplierArticleCode: body.supplierArticleCode,
    animalSpecies: body.animalSpecies,
    tannage: body.tannage as Tannage | null,
    grade: body.grade,
    thicknessMinMm: body.thicknessMinMm,
    thicknessMaxMm: body.thicknessMaxMm,
    animalOrigin: body.animalOrigin,
    isPpeComponent: body.isPpeComponent,
    requiresCrViTest: body.requiresCrViTest,
    crViLimitMgKg: body.crViLimitMgKg,
  })
  return outcome.ok ? [] : [...outcome.issues]
}

/** The field a domain path belongs to, for the form (`thicknessMaxMm`, `crViLimitMgKg`, `purchaseFactor` …). */
export const fieldOfPath = (path: string): string => path.split('/')[0] ?? path

/** Create is held with the first reason a person can act on (code, name, then the domain's first problem). */
export function createHeld(draft: NewMaterialDraft, problems: readonly Issue[], busy: boolean): string | null {
  if (draft.code.trim() === '') return 'newMaterial.held.code'
  if (draft.name.trim() === '') return 'newMaterial.held.name'
  if (plain(draft.standardCost) !== '' && !/^\d+(?:\.\d{1,6})?$/.test(plain(draft.standardCost))) return 'newMaterial.held.cost'
  if (problems.length > 0) return 'newMaterial.held.problems'
  if (busy) return 'held.busy'
  return null
}

// ---- held reasons and words -------------------------------------------------------------------------------------------

/** Why archiving these rows is held, or null. */
export function archiveHeld(rows: readonly MaterialRow[], can: Pick<LibraryCan, 'materialsManage'>): string | null {
  if (!can.materialsManage) return 'held.noManage'
  if (rows.some((row) => row.status === 'ARCHIVED')) return 'list.bulk.archiveHeld'
  return null
}

/** Why setting the standard cost is held, or null. */
export function costHeld(rows: readonly MaterialRow[], can: Pick<LibraryCan, 'materialsCost'>): string | null {
  if (!can.materialsCost) return 'held.noCost'
  if (rows.some((row) => row.status === 'ARCHIVED')) return 'list.bulk.costArchived'
  return null
}

/** The new cost a person typed for one material: '' keeps it, a plain decimal sets it; anything else is refused. */
export function costInput(text: string): string | null | undefined {
  const value = plain(text)
  if (value === '') return null
  return /^\d{1,12}(?:\.\d{1,6})?$/.test(value) ? value : undefined
}

/** The material's Cr VI rule in words: none, or "≤ 3 mg/kg". */
export const crViText = (material: Pick<MaterialRow, 'requiresCrViTest' | 'crViLimitMgKg'>, locale: 'it' | 'en'): string | null =>
  material.requiresCrViTest && material.crViLimitMgKg ? `≤ ${numberText(Number(material.crViLimitMgKg), locale, 3)} mg/kg` : null

/** The standard cost per base unit with its currency, for the cost grain only (else undefined). */
export function costOf(material: Pick<MaterialRow, 'standardCost' | 'currency'>): { value: string | null; currency: string } | undefined {
  return 'standardCost' in material && material.standardCost !== undefined ? { value: material.standardCost, currency: material.currency } : undefined
}

export const STATUS_TONE = { ACTIVE: 'success', ARCHIVED: 'neutral' } as const

// ---- the record's tabs ------------------------------------------------------------------------------------------------

export const MATERIAL_TABS = ['overview', 'colours', 'properties', 'suppliers', 'compliance', 'stock'] as const
export type MaterialTab = (typeof MATERIAL_TABS)[number]

/** The tabs a person may read: Stock needs inventory.stock.view (Warehouse owns it). */
export const tabsFor = (can: Pick<LibraryCan, 'stock'>): MaterialTab[] => MATERIAL_TABS.filter((tab) => tab !== 'stock' || can.stock)

export function tabOf(value: string | null | undefined, can: Pick<LibraryCan, 'stock'>): MaterialTab {
  const tabs = tabsFor(can)
  return (tabs as readonly string[]).includes(value ?? '') ? (value as MaterialTab) : 'overview'
}

/** Composition per fibre adds up to 100 (decimal strings typed with a comma or a point); null when nothing is typed. */
export function compositionSum(rows: ReadonlyArray<{ percent: string }>): number | null {
  const typed = rows.filter((row) => plain(row.percent) !== '')
  if (typed.length === 0) return null
  return Math.round(typed.reduce((sum, row) => sum + Number(plain(row.percent)), 0) * 100) / 100
}

/** A changed unit is refused once the material is in stock or on a BOM line (the API says which). */
export const unitsLocked = (material: Pick<MaterialView, 'status'>): boolean => material.status === 'ARCHIVED'

// ---- CSV ----------------------------------------------------------------------------------------------------------------

export function materialsCsv(
  rows: readonly MaterialRow[],
  words: { header: readonly string[]; kind: (kind: string) => string; unit: (uom: string) => string; status: (status: string) => string; seesCost: boolean },
): string {
  return csvOf(
    words.seesCost ? words.header : words.header.filter((_, index) => index !== 7),
    rows.map((row) => {
      const cells: (string | number | null)[] = [
        row.code,
        row.name,
        words.kind(row.kind),
        words.unit(row.baseUom),
        words.unit(row.purchaseUom),
        words.unit(row.consumptionUom),
        row.defaultSupplier ? `${row.defaultSupplier.code} ${row.defaultSupplier.name}` : '',
        row.standardCost ?? '',
        row.currency,
        row.colourCount,
        row.requiresCrViTest ? (row.crViLimitMgKg ?? '') : '',
        row.isPpeComponent ? 'PPE' : '',
        words.status(row.status),
      ]
      return words.seesCost ? cells : cells.filter((_, index) => index !== 7)
    }),
  )
}
