import { planBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import { itemPlanningProblems, mergeItemPlanning, type ItemPlanningPatch, type ItemPlanningValues } from '@nexus/factory-domain/planning/settings/items'
import { efficiencyPctOf, SETTINGS_LIMITS, settingsProblems } from '@nexus/factory-domain/planning/settings/settings'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { ITEM_SOURCINGS } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { EditSettingsBody, ItemDefaults, ItemEntry, ItemParameters, ItemParametersFields, Lane, PlanBucket, PlanningMethod, PlanningSettings, PlanningSite, PlanningSource } from '../api'
import { PLANNING_SETTINGS_NAMESPACES, writeProblem } from '../model'

/**
 * Planning settings › Item parameters, Reorder rules, Horizon & fences, Line efficiency (SCR-127; design
 * planning.settings sec:items, sec:reorder, sec:horizon, sec:efficiency), pure: the grids' rows, what a typed cell
 * sends — checked with factory-domain's own rules (`mergeItemPlanning`, `itemPlanningProblems`, `settingsProblems`,
 * `efficiencyPctOf`) BEFORE anything is sent, the refusal in this page's words (keys of `planning-params`, prefix `pp.`;
 * the shared states are `planning-settings`' `ps.`) —, the bulk edit's review, the horizon's draft and its bucket
 * preview, the line efficiency's sparkline. Quantities are decimal strings in the item's BASE unit; days whole numbers.
 * Nothing here names a person or carries money: efficiency and people are per line or work centre (Statuto art. 4).
 */

export const PARAMS_NAMESPACES = ['planning-params', ...PLANNING_SETTINGS_NAMESPACES] as const

/** A word of this page: a key (`pp.` or `ps.`) and its values. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** A cell's own save (design: autosave per cell; DS CellSaveMark shapes). */
export type MarkState = 'saving' | 'saved' | 'refused' | 'unknown'
export interface Mark {
  readonly state: MarkState
  /** Why it was refused, or what is not known. */
  readonly problem?: Words
}
export const markKey = (rowKey: string, field: string): string => `${rowKey}:${field}`

export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly words: Words
  /** Rows a bulk change refused, each with its reason. */
  readonly refused?: readonly { readonly name: string; readonly words: Words }[]
}

export const SOURCINGS = ITEM_SOURCINGS
export const UNITS = UOMS
export const WC_KINDS = WORK_CENTRE_KINDS

// ---- the fields -------------------------------------------------------------------------------------------------------

export const DAY_FIELDS = ['buyLeadTimeDays', 'makeLeadTimeDays', 'safetyLeadTimeDays'] as const
export type DayField = (typeof DAY_FIELDS)[number]
/** The quantities the Item parameters grid edits. */
export const ITEM_QTY_FIELDS = ['safetyStock', 'minOrderQty', 'orderMultiple', 'maxOrderQty'] as const
/** The quantities the Reorder rules grid edits. */
export const REORDER_QTY_FIELDS = ['reorderPoint', 'lotSize', 'minStock', 'maxStock', 'safetyStock'] as const
export const QTY_FIELDS = ['safetyStock', 'reorderPoint', 'lotSize', 'minStock', 'maxStock', 'minOrderQty', 'orderMultiple', 'maxOrderQty'] as const
export type QtyField = (typeof QTY_FIELDS)[number]
export type NumberField = DayField | QtyField
/** A cell of the two grids: a number, or a choice made in a dialog (method, source with supplier or make site). */
export type CellField = NumberField | 'method' | 'source'

export const isDayField = (field: string): field is DayField => (DAY_FIELDS as readonly string[]).includes(field)
export const isQtyField = (field: string): field is QtyField => (QTY_FIELDS as readonly string[]).includes(field)

/** The two fields a reorder method needs (a reorder point and a lot size; a minimum and a maximum stock). */
export const METHOD_PAIR: Readonly<Record<'REORDER_POINT' | 'MIN_MAX', readonly [QtyField, QtyField]>> = Object.freeze({ REORDER_POINT: ['reorderPoint', 'lotSize'], MIN_MAX: ['minStock', 'maxStock'] })
export const REORDER_METHODS = ['REORDER_POINT', 'MIN_MAX'] as const
export type ReorderMethod = (typeof REORDER_METHODS)[number]
export const isReorderMethod = (method: PlanningMethod): method is ReorderMethod => method === 'REORDER_POINT' || method === 'MIN_MAX'

/** A row's values as factory-domain counts them (null: no row yet, the item plans by its defaults). */
export function valuesOf(row: ItemParameters | null): ItemPlanningValues | null {
  if (!row) return null
  return {
    method: row.method,
    source: row.source,
    supplierId: row.supplier?.id ?? null,
    makeSiteId: row.makeSite?.id ?? null,
    buyLeadTimeDays: row.buyLeadTimeDays,
    makeLeadTimeDays: row.makeLeadTimeDays,
    safetyLeadTimeDays: row.safetyLeadTimeDays,
    safetyStock: row.safetyStock,
    reorderPoint: row.reorderPoint,
    lotSize: row.lotSize,
    minStock: row.minStock,
    maxStock: row.maxStock,
    minOrderQty: row.minOrderQty,
    orderMultiple: row.orderMultiple,
    maxOrderQty: row.maxOrderQty,
    note: row.note,
  }
}

// ---- reading a typed cell ---------------------------------------------------------------------------------------------

const DAYS = /^\d{1,4}$/
const QUANTITY = /^\d+(\.\d+)?$/

/** A quantity as typed: an Italian comma is a decimal point; spaces dropped. */
export const typedNumber = (raw: unknown): string => String(raw ?? '').trim().replace(/\s/g, '').replace(',', '.')

/** A typed cell: '' clears it (null); days are whole numbers; quantities decimals (the domain checks the rest). */
export function parseCell(field: NumberField, raw: unknown): { value: number | string | null } | { problem: Words } {
  const text = typedNumber(raw)
  if (text === '') return { value: null }
  if (isDayField(field)) return DAYS.test(text) ? { value: Number(text) } : { problem: { key: 'pp.problem.days', params: { field: `pp.field.${field}` } } }
  return QUANTITY.test(text) ? { value: text } : { problem: { key: 'pp.problem.quantity', params: { field: `pp.field.${field}` } } }
}

/** Two values of a field are the same (quantities by number: "100.0000" = "100"). */
export function sameValue(field: keyof ItemPlanningValues, a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null)
  if (isQtyField(field)) return Number(a) === Number(b)
  return a === b
}

// ---- what a change sends --------------------------------------------------------------------------------------------

export type WritePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly field: string; readonly words: Words }
  | { readonly kind: 'write'; readonly patch: ItemParametersFields; readonly values: ItemPlanningValues; readonly cleared: readonly string[] }

/**
 * What a change of a row does: nothing (the same values), a refusal before sending (factory-domain's rules, said in our
 * words at the field), or the write with the fields a method or source switch clears (`cleared`: said in words).
 */
export function planPatch(current: ItemParameters | null, patch: ItemPlanningPatch): WritePlan {
  const before = valuesOf(current)
  const named = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof ItemPlanningValues, unknown][]
  if (named.length === 0) return { kind: 'none' }
  if (before && named.every(([field, value]) => sameValue(field, before[field], value))) return { kind: 'none' }
  if (!before && named.every(([field, value]) => (field === 'method' ? value === 'ORDERS' : value === null))) return { kind: 'none' }
  const { values, cleared } = mergeItemPlanning(before, patch)
  const problems = itemPlanningProblems(values)
  const first = problems.find((issue) => named.some(([field]) => issue.path === `body/${field}`)) ?? problems[0]
  if (first) {
    const field = first.path.replace(/^body\//, '')
    return { kind: 'refused', field, words: issueWords(field, values) }
  }
  return { kind: 'write', patch: Object.fromEntries(named) as ItemParametersFields, values, cleared }
}

/** A factory-domain refusal of one field in this page's words (the rule the field broke, recomputed from the values). */
/** A quantity as people write it: "50.0000" → "50", "12.5000" → "12.5". */
const plainQuantity = (value: string): string => (value.includes('.') ? value.replace(/\.?0+$/, '') : value)

export function issueWords(field: string, values: ItemPlanningValues): Words {
  const fieldWord = `pp.field.${field}`
  if (isDayField(field)) return { key: 'pp.problem.days', params: { field: fieldWord } }
  if (isQtyField(field)) {
    const value = values[field]
    if (value !== null && !QUANTITY.test(value)) return { key: 'pp.problem.quantity', params: { field: fieldWord } }
    if (value !== null && /\.\d{5,}$/.test(value)) return { key: 'pp.problem.decimals', params: { field: fieldWord } }
    const size = field === 'lotSize' || field === 'maxStock' || field === 'minOrderQty' || field === 'orderMultiple' || field === 'maxOrderQty'
    if (value !== null && size && Number(value) <= 0) return { key: 'pp.problem.aboveZero', params: { field: fieldWord } }
    if (field === 'maxStock' && values.minStock !== null && values.maxStock !== null && Number(values.maxStock) <= Number(values.minStock)) return { key: 'pp.problem.maxStock', params: { min: plainQuantity(values.minStock) } }
    if (field === 'maxOrderQty' && values.minOrderQty !== null && values.maxOrderQty !== null && Number(values.maxOrderQty) < Number(values.minOrderQty)) return { key: 'pp.problem.maxOrder', params: { min: plainQuantity(values.minOrderQty) } }
    if (field === 'reorderPoint' || field === 'lotSize') return values.method === 'REORDER_POINT' ? { key: 'pp.problem.ropNeeds' } : { key: 'pp.problem.ropOnly', params: { field: fieldWord } }
    if (field === 'minStock' || field === 'maxStock') return values.method === 'MIN_MAX' ? { key: 'pp.problem.minMaxNeeds' } : { key: 'pp.problem.minMaxOnly', params: { field: fieldWord } }
    return { key: 'pp.problem.quantity', params: { field: fieldWord } }
  }
  if (field === 'supplierId') return { key: 'pp.problem.supplierBuy' }
  if (field === 'makeSiteId') return { key: 'pp.problem.makeSiteMake' }
  if (field === 'note') return { key: 'pp.problem.note' }
  return { key: 'pp.problem.invalidField', params: { field: fieldWord } }
}

/** An API refusal of a write in words: at its field when the API named one (400), else the kind's sentence. */
export function refusalWords(error: unknown): { words: Words; conflict: boolean; unknown: boolean } {
  const problem = writeProblem(error)
  if (problem.key === 'ps.problem.invalid' && problem.field) return { words: { key: 'pp.problem.refusedField', params: { field: `pp.field.${problem.field}` } }, conflict: false, unknown: false }
  return { words: { key: problem.key }, conflict: problem.conflict, unknown: problem.unknown }
}

/** "The reorder point and the lot size were cleared" for a method or source switch (none: null). */
export function clearedWords(cleared: readonly string[]): Words | null {
  if (cleared.length === 0) return null
  return { key: cleared.length === 1 ? 'pp.cleared_one' : 'pp.cleared_other', params: { count: cleared.length, fields: cleared.map((field) => `pp.field.${field}`).join('|') } }
}

// ---- the item grid's rows -----------------------------------------------------------------------------------------------

export interface Named {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface ItemRow {
  /** The grid row (stable across the first save): item and colour. */
  readonly key: string
  readonly item: ItemEntry['item']
  readonly defaults: ItemDefaults
  /** The colour the row plans (null: every colour of the item). */
  readonly colour: Named | null
  /** The site's row; null: planned by the item's defaults. */
  readonly row: ItemParameters | null
}

export const rowKeyOf = (itemId: string, colourId: string | null): string => `${itemId}:${colourId ?? '*'}`

/** One grid row per site row of each item (the one for every colour first), or one row of defaults when it has none. */
export function itemRowsOf(entries: readonly ItemEntry[]): ItemRow[] {
  return entries.flatMap((entry): ItemRow[] =>
    entry.parameters.length === 0
      ? [{ key: rowKeyOf(entry.item.id, null), item: entry.item, defaults: entry.defaults, colour: null, row: null }]
      : entry.parameters.map((row) => ({ key: rowKeyOf(entry.item.id, row.colour?.id ?? null), item: entry.item, defaults: entry.defaults, colour: row.colour, row })),
  )
}

/** The entries with one row put in (made or changed). */
export function withRow(entries: readonly ItemEntry[], row: ItemParameters): ItemEntry[] {
  return entries.map((entry) => {
    if (entry.item.id !== row.item.id) return entry
    const others = entry.parameters.filter((existing) => existing.id !== row.id && (existing.colour?.id ?? null) !== (row.colour?.id ?? null))
    const parameters = [...others, row].sort((a, b) => (a.colour === null ? -1 : b.colour === null ? 1 : a.colour.code.localeCompare(b.colour.code)))
    return { ...entry, parameters }
  })
}

/** The entries with one row taken out (the item plans by its defaults again). */
export function withoutRow(entries: readonly ItemEntry[], itemId: string, rowId: string): ItemEntry[] {
  return entries.map((entry) => (entry.item.id === itemId ? { ...entry, parameters: entry.parameters.filter((row) => row.id !== rowId) } : entry))
}

/** A quantity as people read it: "100.0000" → "100", "12.5000" → "12,5" in Italian. */
export function qtyText(value: string | null, locale: string): string {
  if (value === null) return ''
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4, useGrouping: true }).format(number)
}

/** What a cell shows when the site keeps nothing for it: the item's own value (faint), else null (nothing). */
export function defaultWords(field: CellField, defaults: ItemDefaults): Words | null {
  if (field === 'buyLeadTimeDays' && defaults.leadTimeDays !== null) return { key: 'pp.default.days', params: { count: defaults.leadTimeDays } }
  if ((field === 'minOrderQty' || field === 'orderMultiple') && defaults[field] !== null) return { key: 'pp.default.qty', params: { qty: defaults[field]!, unit: `pp.uom.${defaults.purchaseUom}` } }
  return null
}

/** The rows a bulk "Plan N by defaults" removes (those with a site row). */
export const rowsWithParameters = (rows: readonly ItemRow[]): ItemRow[] => rows.filter((row) => row.row !== null)

// ---- the bulk edit -----------------------------------------------------------------------------------------------------

export const BULK_FIELDS = [...DAY_FIELDS, ...ITEM_QTY_FIELDS] as const
export type BulkField = (typeof BULK_FIELDS)[number]
/** The fields to change and their new text ('' clears); a method for all (Orders or Manual only: a reorder rule needs its own values). */
export interface BulkDraft {
  readonly fields: Readonly<Partial<Record<BulkField, string>>>
  readonly method: 'ORDERS' | 'MANUAL' | null
}
export const EMPTY_BULK: BulkDraft = Object.freeze({ fields: {}, method: null })

export interface BulkLine {
  readonly row: ItemRow
  readonly changes: readonly { readonly field: BulkField | 'method'; readonly before: string | null; readonly after: string | null }[]
  readonly plan: WritePlan
}

/** The draft as a patch, or the first field's problem as typed. */
export function bulkPatch(draft: BulkDraft): { patch: ItemPlanningPatch } | { field: BulkField; words: Words } {
  const patch: Record<string, unknown> = {}
  for (const [field, text] of Object.entries(draft.fields) as [BulkField, string][]) {
    const parsed = parseCell(field, text)
    if ('problem' in parsed) return { field, words: parsed.problem }
    patch[field] = parsed.value
  }
  if (draft.method) patch.method = draft.method
  return { patch: patch as ItemPlanningPatch }
}

/** The review: per row old → new and what will be sent, refused or left as it is. */
export function bulkLines(rows: readonly ItemRow[], patch: ItemPlanningPatch): BulkLine[] {
  return rows.map((row) => {
    const before = valuesOf(row.row)
    const changes = (Object.entries(patch) as [BulkField | 'method', unknown][]).map(([field, value]) => ({
      field,
      before: before ? (before[field] === null ? null : String(before[field])) : field === 'method' ? 'ORDERS' : null,
      after: value === null || value === undefined ? null : String(value),
    }))
    return { row, changes, plan: planPatch(row.row, patch) }
  })
}

export const bulkCounts = (lines: readonly BulkLine[]) => ({
  write: lines.filter((line) => line.plan.kind === 'write').length,
  refused: lines.filter((line) => line.plan.kind === 'refused').length,
  same: lines.filter((line) => line.plan.kind === 'none').length,
})

/** "8 saved · 1 refused" after a bulk change. */
export function bulkResult(saved: number, refused: readonly { name: string; words: Words }[]): Notice {
  if (refused.length === 0) return { tone: 'success', words: { key: 'pp.bulk.done', params: { count: saved } } }
  return { tone: saved > 0 ? 'warning' : 'danger', words: { key: 'pp.bulk.partly', params: { saved, refused: refused.length } }, refused }
}

export const rowName = (row: Pick<ItemRow, 'item' | 'colour'>): string => (row.colour ? `${row.item.code} · ${row.colour.name}` : row.item.code)

// ---- the reorder rules ---------------------------------------------------------------------------------------------------

/** A reorder grid cell: open (its method's own fields and the safety stock), or not for this method. */
export function reorderCellOpen(row: Pick<ItemParameters, 'method'>, field: QtyField): boolean {
  if (field === 'safetyStock') return true
  if (row.method === 'REORDER_POINT') return field === 'reorderPoint' || field === 'lotSize'
  if (row.method === 'MIN_MAX') return field === 'minStock' || field === 'maxStock'
  return false
}

/** The patch of a reorder method with its two values (the dialog's), as typed. */
export function methodPatch(method: PlanningMethod, first: string, second: string): { patch: ItemPlanningPatch } | { field: QtyField; words: Words } {
  if (!isReorderMethod(method)) return { patch: { method } }
  const [a, b] = METHOD_PAIR[method]
  const one = parseCell(a, first)
  if ('problem' in one) return { field: a, words: one.problem }
  const two = parseCell(b, second)
  if ('problem' in two) return { field: b, words: two.problem }
  return { patch: { method, [a]: one.value, [b]: two.value } as ItemPlanningPatch }
}

/** The row a new rule changes: the item's row for that colour (edited), else none (made). */
export function ruleTarget(entry: ItemEntry, colourId: string | null): ItemParameters | null {
  return entry.parameters.find((row) => (row.colour?.id ?? null) === colourId) ?? null
}

/** The source dialog's patch: the item's own sourcing (null), bought from a supplier, or made at a plant. */
export function sourcePatch(source: PlanningSource | null, supplierId: string | null, makeSiteId: string | null): ItemPlanningPatch {
  if (source === 'BUY') return { source, supplierId, makeSiteId: null }
  if (source === 'MAKE') return { source, makeSiteId, supplierId: null }
  return { source: null, supplierId: null, makeSiteId: null }
}

/** The plants an item may be made at: the ACTIVE plants of the site's company (the API's rule). */
export const makeSitesOf = (sites: readonly PlanningSite[], companyId: string): PlanningSite[] => sites.filter((site) => site.companyId === companyId && site.kind === 'PLANT')

// ---- horizon & fences ----------------------------------------------------------------------------------------------------

export const HORIZON_FIELDS = ['horizonWeeks', 'dayBucketWeeks', 'weekBucketWeeks', 'defaultEfficiencyPct', 'scheduledRunTime'] as const
export type HorizonField = (typeof HORIZON_FIELDS)[number]

/** The form as typed ('' run time: runs on demand only). */
export interface HorizonDraft {
  readonly horizonWeeks: number | ''
  readonly dayBucketWeeks: number | ''
  readonly weekBucketWeeks: number | ''
  readonly defaultEfficiencyPct: string
  readonly scheduledRunTime: string
}

const pctText = (value: string): string => {
  const number = Number(value)
  return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : value
}

export const horizonDraftOf = (settings: PlanningSettings): HorizonDraft => ({
  horizonWeeks: settings.horizonWeeks,
  dayBucketWeeks: settings.dayBucketWeeks,
  weekBucketWeeks: settings.weekBucketWeeks,
  defaultEfficiencyPct: pctText(settings.defaultEfficiencyPct),
  scheduledRunTime: settings.scheduledRunTime ?? '',
})

/** The fields the form changed. */
export function horizonChanged(read: PlanningSettings, draft: HorizonDraft): HorizonField[] {
  const before = horizonDraftOf(read)
  return HORIZON_FIELDS.filter((field) => (field === 'defaultEfficiencyPct' ? Number(typedNumber(before[field])) !== Number(typedNumber(draft[field])) || typedNumber(draft[field]) === '' : String(before[field]).trim() !== String(draft[field]).trim()))
}

/** What is wrong with the form, per field, in our words (factory-domain's settingsProblems decides). */
export function horizonProblems(draft: HorizonDraft): Partial<Record<HorizonField, Words>> {
  const out: Partial<Record<HorizonField, Words>> = {}
  for (const field of ['horizonWeeks', 'dayBucketWeeks', 'weekBucketWeeks'] as const) if (draft[field] === '') out[field] = { key: 'pp.horizon.problem.required' }
  if (typedNumber(draft.defaultEfficiencyPct) === '') out.defaultEfficiencyPct = { key: 'pp.horizon.problem.required' }
  const values = {
    horizonWeeks: Number(draft.horizonWeeks),
    dayBucketWeeks: Number(draft.dayBucketWeeks),
    weekBucketWeeks: Number(draft.weekBucketWeeks),
    defaultEfficiencyPct: typedNumber(draft.defaultEfficiencyPct),
    scheduledRunTime: draft.scheduledRunTime.trim() === '' ? null : draft.scheduledRunTime.trim(),
  }
  for (const issue of settingsProblems(values) as Issue[]) {
    const field = issue.path.replace(/^body\//, '') as HorizonField
    if (out[field]) continue
    out[field] = horizonIssueWords(field, values)
  }
  return out
}

function horizonIssueWords(field: HorizonField, values: { horizonWeeks: number; dayBucketWeeks: number; weekBucketWeeks: number }): Words {
  const { min, max } = SETTINGS_LIMITS.horizonWeeks
  switch (field) {
    case 'horizonWeeks':
      return { key: 'pp.horizon.problem.horizon', params: { min, max } }
    case 'dayBucketWeeks':
      return values.dayBucketWeeks < 0 || !Number.isSafeInteger(values.dayBucketWeeks) ? { key: 'pp.horizon.problem.weeks' } : { key: 'pp.horizon.problem.dayAfterWeek', params: { days: values.dayBucketWeeks, weeks: values.weekBucketWeeks } }
    case 'weekBucketWeeks':
      return values.weekBucketWeeks < 0 || !Number.isSafeInteger(values.weekBucketWeeks) ? { key: 'pp.horizon.problem.weeks' } : { key: 'pp.horizon.problem.weekAfterHorizon', params: { weeks: values.weekBucketWeeks, horizon: values.horizonWeeks } }
    case 'defaultEfficiencyPct':
      return { key: 'pp.problem.percent' }
    case 'scheduledRunTime':
      return { key: 'pp.horizon.problem.runTime' }
  }
}

/** The changed fields as the PATCH body, with the version read (none for a site still on the defaults). */
export function horizonBody(read: PlanningSettings, draft: HorizonDraft): EditSettingsBody {
  const body: Record<string, unknown> = {}
  if (read.version !== null) body.version = read.version
  for (const field of horizonChanged(read, draft)) {
    if (field === 'defaultEfficiencyPct') body[field] = efficiencyPctOf(typedNumber(draft[field])) ?? typedNumber(draft[field])
    else if (field === 'scheduledRunTime') body[field] = draft[field].trim() === '' ? null : draft[field].trim()
    else body[field] = draft[field]
  }
  return body as EditSettingsBody
}

export interface BucketPreview {
  readonly days: { readonly count: number; readonly to: string } | null
  readonly weeks: { readonly count: number; readonly to: string } | null
  readonly months: { readonly count: number; readonly to: string } | null
  readonly to: string
}

/** The plan's buckets in words: how many days, weeks and months, and where each ends. */
export function previewOfBuckets(buckets: readonly Pick<PlanBucket, 'kind' | 'to'>[], to: string): BucketPreview {
  const part = (kind: PlanBucket['kind']) => {
    const of = buckets.filter((bucket) => bucket.kind === kind)
    return of.length ? { count: of.length, to: of[of.length - 1]!.to } : null
  }
  return { days: part('DAY'), weeks: part('WEEK'), months: part('MONTH'), to }
}

/** The preview of the form as typed, from the site's today (null while the form has a problem). */
export function draftPreview(draft: HorizonDraft, today: string): BucketPreview | null {
  const problems = horizonProblems(draft)
  if (problems.horizonWeeks || problems.dayBucketWeeks || problems.weekBucketWeeks) return null
  try {
    const plan = planBuckets({ horizonWeeks: Number(draft.horizonWeeks), dayBucketWeeks: Number(draft.dayBucketWeeks), weekBucketWeeks: Number(draft.weekBucketWeeks) }, today as never)
    return previewOfBuckets(plan.buckets, plan.to)
  } catch {
    return null
  }
}

/** An API refusal of the form at its field (`body/<field>`), in our words. */
export function horizonRefusal(error: unknown): { field: HorizonField | null; words: Words; conflict: boolean } {
  const problem = writeProblem(error)
  const field = problem.field && (HORIZON_FIELDS as readonly string[]).includes(problem.field) ? (problem.field as HorizonField) : null
  if (problem.key === 'ps.problem.invalid' && field) return { field, words: { key: 'pp.horizon.problem.refused' }, conflict: false }
  return { field: null, words: { key: problem.key }, conflict: problem.conflict }
}

// ---- line efficiency ------------------------------------------------------------------------------------------------------

export const laneKey = (lane: Pick<Lane, 'kind' | 'id'>): string => `${lane.kind}:${lane.id}`
export type LaneField = 'plannedEfficiencyPct' | 'people'

/** A typed planned percent: stored with two decimals ("85" → "85.00"), above 0 and at most 200. */
export function percentEdit(lane: Lane, raw: unknown): { kind: 'none' } | { kind: 'refused'; words: Words } | { kind: 'write'; value: string } {
  const text = typedNumber(raw)
  const value = efficiencyPctOf(text)
  if (value === null) return { kind: 'refused', words: { key: 'pp.problem.percent' } }
  if (Number(value) === Number(lane.effective.efficiencyPct) && lane.effective.efficiencySource === 'LANE') return { kind: 'none' }
  return { kind: 'write', value }
}

/** Typed people per shift (a line) or units at once (a work centre): 1 to 500, or empty for one per active station. */
export function peopleEdit(lane: Lane, raw: unknown): { kind: 'none' } | { kind: 'refused'; words: Words } | { kind: 'write'; value: number | null } {
  const text = typedNumber(raw)
  const current = lane.capacity?.people ?? null
  if (text === '') return current === null ? { kind: 'none' } : { kind: 'write', value: null }
  if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 500) return { kind: 'refused', words: { key: 'pp.problem.people' } }
  return Number(text) === current ? { kind: 'none' } : { kind: 'write', value: Number(text) }
}

/** The four weeks' actual efficiency, oldest first, for the Sparkline (an unknown week keeps its place). */
export const sparkOf = (lane: Pick<Lane, 'actual'>): (number | null)[] => (lane.actual ?? []).map((week) => (week.pct === null ? null : Number(week.pct)))

/** The last whole week's actual efficiency (null: the line had nothing available, or no history). */
export function latestActual(lane: Pick<Lane, 'actual'>): { week: string; pct: string | null } | null {
  const weeks = lane.actual ?? []
  const last = weeks[weeks.length - 1]
  return last ? { week: last.week, pct: last.pct } : null
}

/** A percent as people read it ("85.00" → "85", "92.50" → "92,5"). */
export const pctOf = (value: string, locale: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(value))

// ---- live: our own writes are not "changed by someone else" -------------------------------------------------------------

/** How long a write's own live message is expected after its answer. */
export const ECHO_MS = 6000
