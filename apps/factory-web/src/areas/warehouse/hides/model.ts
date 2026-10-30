import type { LabelBlock, LabelLayout, LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import { composeLabel, labelProblems } from '@nexus/factory-domain/labels/model'
import type { Locale } from '../../../lib/i18n/locales'
import type { LiveState } from '../../_shared/buying/hooks'
import type { HideQuery, HideRecord, HideRow, HidesPage, LabelRequest, PrinterOption, PrintJob, StateCount } from '../../_shared/stock/api'
import { quantity, type StockCan } from '../../_shared/stock/model'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import type { SiteChoice } from '../lots/model'
import type { Loaded, Part } from '../lots/shared/model'
import type { MovesPart } from '../lots/shared/parts'
import type { DailyCan, HoldsBySubject } from '../lots/shared/daily'
import type { PickerReason } from '../../_shared/reasons/api'
import type { ReserveActions, ReserveDialogModel, WriteOffActions, WriteOffDialogModel } from '../stock/daily/dialog-model'

/**
 * Warehouse › Hides (SCR-200 the list, SCR-200-record a hide), pure: the saved views and tiles ⇄ the address and the
 * API's own filters, the one exact hit of a scanned tag, which hides a tag can be printed for (and why not), the HIDE
 * label a tag prints (factory-domain labels: article, colour, grade, area, thickness, lot), the print jobs' state, and a
 * hide's next step in words.
 */

export const HIDE_VIEWS = ['inStock', 'full', 'partlyCut', 'remnants', 'quarantine', 'reserved', 'consumed', 'all'] as const
export type HideView = (typeof HIDE_VIEWS)[number]
export const DEFAULT_HIDE_VIEW: HideView = 'inStock'

export function hideViewOf(params: { get(name: string): string | null } | null): HideView {
  const asked = params?.get('view') ?? ''
  if ((HIDE_VIEWS as readonly string[]).includes(asked)) return asked as HideView
  if (params?.get('state') === 'REMNANT') return 'remnants'
  if (params?.get('state') === 'CONSUMED') return 'consumed'
  if (params?.get('quality') === 'QUARANTINE') return 'quarantine'
  if (params?.get('reserved') === 'true') return 'reserved'
  if (params?.get('inStock') === 'true') return 'inStock'
  return DEFAULT_HIDE_VIEW
}

/** The filters beside the view that the address carries (`?lot=` `?grade=` `?shade=` `?location=`). */
export interface HideFilters {
  lotId: string | null
  grade: string | null
  shade: string | null
  locationId: string | null
}
export const filtersOf = (params: { get(name: string): string | null } | null): HideFilters => ({
  lotId: params?.get('lot') || null,
  grade: params?.get('grade') || null,
  shade: params?.get('shade') || null,
  locationId: params?.get('location') || null,
})

/** A view and the filters as the API's query. */
export function hideQuery(view: HideView, q: string, siteId: string | null, filters: HideFilters, cursor: string | null = null): HideQuery {
  const base: HideQuery = { siteId, q: q.trim() || null, cursor, limit: 50, ...filters }
  switch (view) {
    case 'inStock':
      return { ...base, inStock: true }
    case 'full':
      return { ...base, state: 'FULL' }
    case 'partlyCut':
      return { ...base, state: 'PARTLY_CUT' }
    case 'remnants':
      return { ...base, state: 'REMNANT' }
    case 'quarantine':
      return { ...base, inStock: true, quality: 'QUARANTINE' }
    case 'reserved':
      // B-W2a-64: the hides an ACTIVE reservation holds whole (design hd-grid "Reserved").
      return { ...base, reserved: true }
    case 'consumed':
      return { ...base, state: 'CONSUMED' }
    default:
      return base
  }
}

export interface HideTile {
  id: 'full' | 'partlyCut' | 'remnant' | 'quarantine' | 'reserved'
  view: HideView
  count: (counts: HidesPage['counts'] | null) => StateCount | null
}
export const HIDE_TILES: readonly HideTile[] = [
  { id: 'full', view: 'full', count: (counts) => counts?.full ?? null },
  { id: 'partlyCut', view: 'partlyCut', count: (counts) => counts?.partlyCut ?? null },
  { id: 'remnant', view: 'remnants', count: (counts) => counts?.remnant ?? null },
  { id: 'quarantine', view: 'quarantine', count: (counts) => counts?.quarantine ?? null },
  // B-W2a-64 (design hd-metrics "Reserved"): an API without the count says "—", never 0.
  { id: 'reserved', view: 'reserved', count: (counts) => counts?.reserved ?? null },
]

/** A tag typed or scanned that is the one hit: open its hide (design R7, "one hit opens the hide"). */
export function exactHide(q: string, rows: readonly Pick<HideRow, 'id' | 'code' | 'supplierCode'>[] | null): string | null {
  const needle = q.trim().toLowerCase()
  if (!needle || !rows) return null
  const hits = rows.filter((row) => row.code.toLowerCase() === needle)
  return hits.length === 1 ? hits[0]!.id : null
}

/** A hide with nothing of it left gets no tag: the reason as a key of `warehouse-lots`, or null when it may. */
export function tagHeldKey(hide: Pick<HideRow, 'state'>): string | null {
  if (hide.state === 'CONSUMED') return 'hd.print.consumed'
  if (hide.state === 'SCRAPPED') return 'hd.print.scrapped'
  return null
}

/**
 * The HIDE label of a tag (factory-domain labels LABEL_FIELDS.HIDE): its tag as the scannable id, the article as the
 * title, and the colour, grade, area (unit of entry), thickness and lot as fields, in the person's language.
 */
export function hideLabel(hide: HideRow, locale: Locale, unitWord: (uom: HideRow['areaUom']) => string): LabelRequest {
  return {
    kind: 'HIDE',
    language: locale === 'en' ? 'en' : 'it',
    scanId: hide.code,
    title: `${hide.item.code} ${hide.item.name}`.slice(0, 200),
    fields: {
      article: hide.item.code,
      colour: hide.colour ? `${hide.colour.code} ${hide.colour.name}` : null,
      grade: hide.grade,
      area: `${quantity(hide.area, locale)} ${unitWord(hide.areaUom)}`,
      thickness: hide.thicknessMm ? `${quantity(hide.thicknessMm, locale)} mm` : null,
      lot: hide.lot.code,
    },
  }
}

/**
 * The tag as it prints (factory-domain composeLabel: the heading, the article, the fields in the label's language and
 * the tag as Code 128 under them), 100 × 50 mm, for the DS LabelPreview; null when the label cannot be printed as it is
 * (a tag that is not this factory's code: the API refuses it too).
 */
export function tagLayout(label: LabelRequest, name: string): LabelLayout | null {
  if (labelProblems(label).length > 0) return null
  const composed = composeLabel(label)
  const blocks: LabelBlock[] = [
    { kind: 'text', text: composed.heading, size: 'sm', bold: true },
    { kind: 'title', text: composed.title, size: 'md' },
    { kind: 'fields', columns: 3, fields: composed.fields.map((field) => ({ label: field.label, value: field.value })) },
    { kind: 'fill' },
    { kind: 'barcode', value: composed.scanId, heightMm: 9 },
  ]
  return { name, widthMm: 100, heightMm: 50, blocks }
}

/** A print job's state as the DS LabelPreview draws it (always icon and word). */
export function printStateOf(job: PrintJob | null, words: (status: string) => string): LabelPrintState | undefined {
  if (!job) return undefined
  const status = job.status === 'QUEUED' ? 'queued' : job.status === 'SENT' ? 'sent' : job.status === 'PRINTED' ? 'printed' : 'failed'
  return { status, label: words(job.status) }
}

/** One tag's print: queued on a label printer (its job's state), or refused / failed with its words (a key of `stock`). */
export interface TagPrint {
  hideId: string
  code: string
  job: PrintJob | null
  problem: string | null
}

/** A print job that may still move (the page polls it): queued or sent, not printed or failed yet. */
export const jobMoving = (job: PrintJob | null): boolean => !!job && (job.status === 'QUEUED' || job.status === 'SENT')

export interface PrintDialog {
  /** The hides whose tags print. */
  hideIds: readonly string[]
  printers: Part<readonly PrinterOption[]>
  printerId: string | null
  copies: number
  busy: boolean
  /** Null: not sent yet; then one line per tag. */
  prints: readonly TagPrint[] | null
  problem: string | null
}

/** The print button is held while: busy, no printer chosen (and some exist), copies out of 1–5. */
export function printHeldKey(dialog: PrintDialog): string | null {
  if (dialog.busy) return 'hd.print.busy'
  if (dialog.problem === 'hd.print.oneSite') return 'hd.print.oneSite'
  if (dialog.printers.value === null) return dialog.printers.problem ? null : 'hd.print.loadingPrinters'
  if (dialog.printers.value.length > 0 && !dialog.printerId) return 'hd.print.pickPrinter'
  if (dialog.copies < 1 || dialog.copies > 5) return 'hd.print.copiesRange'
  return null
}

/**
 * A hide's next step in words (a key of `warehouse-lots`): read only, held with the lot's reason, held by a quality hold
 * (B-W2a-64, its reason), at a work order, reserved for a work order or an order line (B-W2a-64), ready.
 */
export function nextStepKey(record: Pick<HideRecord, 'hide'>, onHold = false): string {
  const hide = record.hide
  if (hide.state === 'CONSUMED') return 'hd.next.consumed'
  if (hide.state === 'SCRAPPED') return 'hd.next.scrapped'
  if (onHold) return 'hd.next.onHold'
  if (hide.lot.qualityStatus !== 'RELEASED') return 'hd.next.held'
  if (hide.onHand === '0.0000') return 'hd.next.atWorkOrder'
  if (hide.reservedFor) return hide.reservedFor.stale ? 'hd.next.reservedStale' : 'hd.next.reserved'
  return hide.state === 'REMNANT' ? 'hd.next.remnant' : 'hd.next.ready'
}

export interface HidesListModel {
  prefix: string
  can: StockCan
  view: HideView
  q: string
  filters: HideFilters
  sites: readonly SiteChoice[]
  siteId: string | null
  rows: { items: readonly HideRow[] | null; more: boolean; problem: string | null }
  counts: HidesPage['counts'] | null
  matching: StateCount | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  print: PrintDialog | null
  /** B-W2a-64: reserve, scrap, holds, NCR, photos, work orders, the cost grain. */
  daily: DailyCan
  /** B-W2a-64: the ACTIVE quality holds of the site's lots and hides (quality.holds.view; empty without it). */
  holds: HoldsBySubject
  /** The HOLD reasons' words. */
  holdReasons: readonly PickerReason[]
  reserve: ReserveDialogModel | null
  writeOff: WriteOffDialogModel | null
  /** Design cases: rows selected, the keys panel open. */
  selected?: readonly string[]
  helpOpen?: boolean
}

export interface HidesListActions {
  onView?: (view: HideView) => void
  onSearch?: (q: string) => void
  onSite?: (siteId: string | null) => void
  onClearFilter?: (filter: keyof HideFilters) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: readonly string[]) => void
  print?: PrintActions
  /** B-W2a-64: Reserve to a work order… and Scrap… on the selection. */
  onReserve?: (ids: readonly string[]) => void
  onScrap?: (ids: readonly string[]) => void
  reserve?: ReserveActions
  writeOff?: WriteOffActions
}

export interface PrintActions {
  onOpen?: (hideIds: readonly string[]) => void
  onClose?: () => void
  onPrinter?: (printerId: string | null) => void
  onCopies?: (copies: number) => void
  onPrint?: () => void
  onPdf?: () => void
  onRetry?: (jobId: string) => void
}

// ---- the record ------------------------------------------------------------------------------------------------------------

export const HIDE_TABS = ['overview', 'cuts', 'moves'] as const
export type HideTab = (typeof HIDE_TABS)[number]
export const hideTabOf = (value: string | null | undefined): HideTab => ((HIDE_TABS as readonly string[]).includes(value ?? '') ? (value as HideTab) : 'overview')

export interface HideRecordModel {
  prefix: string
  can: StockCan
  tab: HideTab
  record: Loaded<HideRecord>
  moves: Part<MovesPart>
  live: LiveState
  asOf: string | null
  timeZone: string
  print: PrintDialog | null
  /** B-W2a-64: abilities, the hold of the hide (its own or its lot's) and the HOLD reasons' words, the dialogs. */
  daily: DailyCan
  holds: HoldsBySubject
  holdReasons: readonly PickerReason[]
  reserve: ReserveDialogModel | null
  writeOff: WriteOffDialogModel | null
  /** Design cases: the record panels drawn without the API. */
  panelsPreview?: RecordPanelsViewModel | null
}

export interface HideRecordActions {
  onRetry?: () => void
  onRetryMoves?: () => void
  onMoreMoves?: () => void
  print?: PrintActions
  onReserve?: () => void
  onScrap?: () => void
  reserve?: ReserveActions
  writeOff?: WriteOffActions
}

/** The CSV columns of Export N (header words: `hd.csv.<column>`). */
export const HIDE_CSV_COLUMNS = ['tag', 'tannery', 'article', 'colour', 'lot', 'quality', 'dyeBatch', 'shade', 'grade', 'area', 'areaUnit', 'baseArea', 'left', 'unit', 'state', 'location', 'thickness', 'defects', 'received', 'reservedFor'] as const
