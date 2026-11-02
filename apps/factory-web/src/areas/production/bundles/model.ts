import { WHO_PURPOSES, type ScanPatternKind, type WhoPurpose } from '@nexus/factory-domain/production/bundles/patterns'
import type { BundleTicket } from '@nexus/factory-domain/production/bundles/ticket'
import type { BundlePlace } from '@nexus/factory-domain/production/bundles/where'
import type { LabelBlock, LabelLayout } from '@nexus/ui/components/LabelPreview/index'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { reprintHold, type Phrase } from '../_shared/model'
import type { WorkOrderStatus } from '../_shared/api'
import type { BundleRecord, BundlesQuery, BundleTiles, ChecksState, Finding, FindingsSummary, SummaryRow, TrackedBundle } from './api'

/**
 * Production › Cutting room › Bundles (B-W2b-59; SCR-259; design production.bundles), pure: what this person may do, the
 * address — the Rows ▾ views ARE the API's own filters (`?stuck=true`, `?place=LINE`, `?status=VOID`), which Floor now
 * links to by those names —, the tiles, where a bundle is in words, why each act is held, what a scan-pattern finding saw
 * (counts and times, never a person), the API's refusals in this page's words, and the ticket as LabelPreview data and
 * as the label the browser's PDF prints. Bundles only: no person's output, no ranking (Statuto dei Lavoratori art. 4). The
 * one place names show is "Show who": one finding, the owner's permission, a purpose, written in the audit log. Keys of
 * `production-bundles`.
 */

export const BUNDLES_NAMESPACE = 'production-bundles'
export const BUNDLES_NAMESPACES = [BUNDLES_NAMESPACE, 'production', 'lists'] as const
/** The bundles a page reads at once. */
export const BUNDLES_PAGE = 50

const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- who may do what ------------------------------------------------------------------------------------------------------------

export interface BundlesCan {
  /** production.bundles.view: the page and the record. */
  view: boolean
  /** production.bundles: reprint a ticket, void a bundle. */
  act: boolean
  /** production.bundles.findings: review a finding. */
  findings: boolean
  /** production.bundles.who: "Show who" on one finding (the owner's; a role the owner makes). */
  who: boolean
  /** print.labels: a ticket on a label printer, or as a PDF in the browser. */
  printLabels: boolean
  /** workorders.view: a bundle's scans and the work order's link. */
  workOrders: boolean
  /** production.settings.view: the legal basis on record, read for "Show who". */
  settings: boolean
  /** production.labour.view: Labour & corrections (B-W2b-57), linked from the Scans tab. */
  labour: boolean
}

export function bundlesCanOf(permissions: readonly string[]): BundlesCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.bundles.view'),
    act: held.has('production.bundles'),
    findings: held.has('production.bundles.findings'),
    who: held.has('production.bundles.who'),
    printLabels: held.has('print.labels'),
    workOrders: held.has('workorders.view'),
    settings: held.has('production.settings.view'),
    labour: held.has('production.labour.view'),
  }
}

// ---- the address --------------------------------------------------------------------------------------------------------------

/** Rows ▾. `active` is the default: the bundles still moving, the finished ones of old work orders left out. */
export const BUNDLE_VIEWS = ['active', 'stuck', 'cutting', 'line', 'quality', 'onHold', 'subcontractor', 'finished', 'void', 'all'] as const
export type BundleView = (typeof BUNDLE_VIEWS)[number]

const PLACE_OF_VIEW: Readonly<Partial<Record<BundleView, BundlePlace>>> = Object.freeze({ cutting: 'CUTTING', line: 'LINE', quality: 'QUALITY', subcontractor: 'SUBCONTRACTOR', finished: 'FINISHED' })
const VIEW_OF_PLACE: Readonly<Partial<Record<string, BundleView>>> = Object.freeze({ CUTTING: 'cutting', LINE: 'line', QUALITY: 'quality', SUBCONTRACTOR: 'subcontractor', FINISHED: 'finished', VOID: 'void' })

/** The scan-pattern count a person pressed: its findings open in a dialog (`?check=&checkLine=&checkOp=`). */
export interface FindingsAsk {
  kind: ScanPatternKind
  lineId: string | null
  operationCode: string | null
}

export interface BundlesAddress {
  view: BundleView
  q: string
  ask: FindingsAsk | null
}

interface Params {
  get(name: string): string | null
}

const KINDS: readonly string[] = ['BUNCHED_AT_SHIFT_END', 'MOVED_NOT_SCANNED', 'GAP_BELOW_STANDARD']

/**
 * The view an address asks for, from the API's own filters: `?stuck=true` and `?place=LINE` are Floor now's links
 * (B-W2b-66: the stuck tile and a heat-map cell's Open bundles), `?status=VOID`, `?place=QUALITY&hold=1` (the On hold tile).
 * A list of places is not a view of Rows ▾: its first known place is read.
 */
export function viewOfAddress(params: Params | null | undefined): BundleView {
  if (params?.get('stuck') === 'true') return 'stuck'
  if (params?.get('status') === 'VOID') return 'void'
  const place = (params?.get('place') ?? '')
    .split(',')
    .map((word) => VIEW_OF_PLACE[word.trim().toUpperCase()])
    .find((view) => view !== undefined)
  if (place === 'quality' && params?.get('hold') === '1') return 'onHold'
  if (place) return place
  return params?.get('view') === 'all' ? 'all' : 'active'
}

export function addressOf(params: Params | null | undefined): BundlesAddress {
  const kind = params?.get('check') ?? ''
  return {
    view: viewOfAddress(params),
    q: params?.get('q') ?? '',
    ask: KINDS.includes(kind) ? { kind: kind as ScanPatternKind, lineId: params?.get('checkLine') || null, operationCode: params?.get('checkOp') || null } : null,
  }
}

/** The address of a state: `?stuck=true`, `?place=LINE` … in the API's own words, so a link and a saved view read the same. */
export function addressText(address: BundlesAddress): string {
  const query = new URLSearchParams()
  const place = PLACE_OF_VIEW[address.view]
  if (address.view === 'stuck') query.set('stuck', 'true')
  else if (address.view === 'void') query.set('status', 'VOID')
  else if (address.view === 'onHold') {
    query.set('place', 'QUALITY')
    query.set('hold', '1')
  } else if (address.view === 'all') query.set('view', 'all')
  else if (place) query.set('place', place)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.ask) {
    query.set('check', address.ask.kind)
    if (address.ask.lineId) query.set('checkLine', address.ask.lineId)
    if (address.ask.operationCode) query.set('checkOp', address.ask.operationCode)
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The API's query of a view. A view of places is ACTIVE bundles; "On hold" reads the quality place, `rowsOfView` keeps the holds. */
export function viewQuery(view: BundleView, q: string, siteId: string | null, cursor: string | null = null): BundlesQuery {
  const base: BundlesQuery = { siteId, q: q.trim() || undefined, cursor, limit: BUNDLES_PAGE }
  if (view === 'all') return base
  if (view === 'void') return { ...base, status: 'VOID' }
  if (view === 'stuck') return { ...base, status: 'ACTIVE', stuck: true }
  if (view === 'active') return { ...base, status: 'ACTIVE', place: ['CUTTING', 'LINE', 'QUALITY', 'SUBCONTRACTOR'] }
  if (view === 'onHold') return { ...base, status: 'ACTIVE', place: ['QUALITY'] }
  return { ...base, status: 'ACTIVE', place: [PLACE_OF_VIEW[view]!] }
}

/** What a view shows of the rows read: the API has one place for holds and rework, so On hold keeps the holds. */
export function rowsOfView(view: BundleView, rows: readonly TrackedBundle[]): TrackedBundle[] {
  return view === 'onHold' ? rows.filter((row) => row.qualityReason === 'HOLD') : [...rows]
}

// ---- the tiles -----------------------------------------------------------------------------------------------------------------

/**
 * The tiles (design bd-metrics "Saved filters"): each one a view of Rows ▾, so pressing it shows its rows. "Tickets
 * replaced today" has no filter in the API: it counts and does not press (named in the step's notes).
 */
export const BUNDLE_TILES = [
  { id: 'active', view: 'active', count: (tiles: BundleTiles) => tiles.active },
  { id: 'stuck', view: 'stuck', count: (tiles: BundleTiles) => tiles.stuck },
  { id: 'replaced', view: null, count: (tiles: BundleTiles) => tiles.ticketsReplacedToday },
  { id: 'onHold', view: 'onHold', count: (tiles: BundleTiles) => tiles.onHold },
  { id: 'subcontractor', view: 'subcontractor', count: (tiles: BundleTiles) => tiles.atSubcontractor },
] as const satisfies ReadonlyArray<{ id: string; view: BundleView | null; count: (tiles: BundleTiles) => number }>

/** The stuck tile's words: the site's limit when one site is read ("No scan for 4 h"), else the limit in general. */
export const stuckTile = (tiles: BundleTiles | null): Phrase => (tiles?.stuckLimitHours ? phrase('tile.stuck', { hours: tiles.stuckLimitHours }) : phrase('tile.stuckAny'))

// ---- where a bundle is -----------------------------------------------------------------------------------------------------------

type Placed = Pick<TrackedBundle, 'place' | 'qualityReason' | 'operation' | 'next' | 'subcontract'>

/** Where it is, in words: cutting, a line's operation, a subcontractor, quality (hold or rework), finished, void. */
export function placeWords(row: Placed): Phrase {
  switch (row.place) {
    case 'LINE':
      return row.operation ? phrase('place.line', { seq: row.operation.seq, code: row.operation.code }) : phrase('place.lineAny')
    case 'SUBCONTRACTOR':
      return row.subcontract ? phrase('place.subcontractor', { number: row.subcontract.number }) : phrase('place.subcontractorAny')
    case 'QUALITY':
      return phrase(row.qualityReason === 'REWORK' ? 'place.rework' : 'place.hold')
    case 'CUTTING':
      return phrase('place.cutting')
    case 'FINISHED':
      return phrase('place.finished')
    default:
      return phrase('place.void')
  }
}

/** Where it goes next: only while it moves in the cutting room or on the line (quality and a subcontractor hold it elsewhere). */
export const nextWords = (row: Placed): Phrase | null => ((row.place === 'CUTTING' || row.place === 'LINE') && row.next ? phrase('place.next', { seq: row.next.seq, code: row.next.code }) : null)

export const PLACE_TONE: Readonly<Record<BundlePlace, 'neutral' | 'info' | 'warning' | 'success' | 'danger'>> = Object.freeze({ CUTTING: 'neutral', LINE: 'info', SUBCONTRACTOR: 'info', QUALITY: 'warning', FINISHED: 'success', VOID: 'neutral' })

/** A stuck wait in whole hours of the site's calendar. */
export const stuckWords = (row: Pick<TrackedBundle, 'stuck'>): Phrase | null => (row.stuck.stuck ? phrase('stuck.for', { hours: Math.floor(row.stuck.workingHours), limit: row.stuck.limitHours }) : null)

// ---- held acts ----------------------------------------------------------------------------------------------------------------

type Reprintable = Pick<TrackedBundle, 'status' | 'siteId'> & { workOrder: { status: WorkOrderStatus } }

/** Why "Reprint N tickets" waits, or null: the rights first, then a selection every bundle of which may be reprinted. */
export function reprintHeld(rows: readonly Reprintable[], can: BundlesCan): Phrase | null {
  if (!can.act) return phrase('held.noAct', { permission: 'production.bundles' })
  if (!can.printLabels) return phrase('held.noPrint', { permission: 'print.labels' })
  if (rows.length === 0) return phrase('held.pickFirst')
  if (new Set(rows.map((row) => row.siteId)).size > 1) return phrase('held.oneSite')
  const voided = rows.filter((row) => reprintHold(row, row.workOrder.status) === 'void').length
  if (voided > 0) return phrase('held.reprintVoid', { count: voided })
  const closed = rows.filter((row) => reprintHold(row, row.workOrder.status) === 'notOpen').length
  return closed > 0 ? phrase('held.reprintNotOpen', { count: closed }) : null
}

/** Why "Void bundle" waits, or null: the API's own rule (ACTIVE, an open work order, no scan names it). */
export function voidHeld(record: Pick<BundleRecord, 'bundle' | 'workOrder'>, can: BundlesCan): Phrase | null {
  if (!can.act) return phrase('held.noAct', { permission: 'production.bundles' })
  if (record.bundle.status === 'VOID') return phrase('held.voidAlready')
  if (record.workOrder.status !== 'RELEASED' && record.workOrder.status !== 'IN_PROGRESS') return phrase('held.voidNotOpen')
  return record.bundle.scans > 0 ? phrase('held.voidScanned', { count: record.bundle.scans }) : null
}

export const REASON_LIMITS = Object.freeze({ min: 3, max: 200 })
export const reasonOk = (reason: string): boolean => reason.trim().length >= REASON_LIMITS.min && reason.trim().length <= REASON_LIMITS.max

// ---- scan-pattern checks ------------------------------------------------------------------------------------------------------

/** Why the checks do not run at a site, as a key; null when they do. */
export const checksWords = (state: ChecksState): Phrase | null => (state === 'ON' ? null : phrase(`checks.${state}`))

export interface PatternsState {
  /** The panel shows its counts (at least one site's checks run, or findings are on record). */
  counts: boolean
  /** The sites whose checks do not run, each with why. */
  off: Array<{ site: FindingsSummary['sites'][number]; words: Phrase }>
}

/** What the panel draws: the counts, and why a site has none ("Not available: this site records stations, not people"). */
export function patternsState(summary: FindingsSummary): PatternsState {
  const off = summary.sites.flatMap((site) => {
    const words = checksWords(site.checks)
    return words ? [{ site, words }] : []
  })
  return { counts: summary.rows.length > 0 || off.length < summary.sites.length, off }
}

/** The ask of a summary row: its kind, line and operation. */
export const askOf = (row: SummaryRow): FindingsAsk => ({ kind: row.kind, lineId: row.line?.id ?? null, operationCode: row.operation?.code ?? null })

/** A summary row's key (a line and an operation may be absent). */
export const summaryKey = (row: SummaryRow): string => [row.kind, row.line?.id ?? '-', row.operation?.code ?? '-'].join('|')

/** What was seen, in words: counts and times of the bundle, never a person or a station. */
export function seenWords(finding: Pick<Finding, 'kind' | 'seen'>): Phrase {
  const seen = finding.seen
  const number = (name: string): number => (typeof seen[name] === 'number' ? (seen[name] as number) : 0)
  if (finding.kind === 'BUNCHED_AT_SHIFT_END') return phrase('seen.BUNCHED_AT_SHIFT_END', { scans: number('scansInTheBurst'), minutes: number('windowMinutes') })
  if (finding.kind === 'MOVED_NOT_SCANNED') return phrase('seen.MOVED_NOT_SCANNED', { missing: number('missingSeq'), reached: number('reachedSeq') })
  return phrase('seen.GAP_BELOW_STANDARD', { gap: number('gapMinutes'), standard: number('standardMinutes'), pieces: number('pieces') })
}

/** Why a finding may not be reviewed, or null. */
export function reviewHeld(finding: Pick<Finding, 'status'>, can: BundlesCan, busy = false): Phrase | null {
  if (!can.findings) return phrase('held.noFindings', { permission: 'production.bundles.findings' })
  if (finding.status !== 'OPEN') return phrase('held.findingFinal')
  return busy ? phrase('held.busy') : null
}

/** Why "Mark N reviewed" waits, or null. */
export function reviewManyHeld(findings: readonly Pick<Finding, 'status'>[], can: BundlesCan, busy = false): Phrase | null {
  if (!can.findings) return phrase('held.noFindings', { permission: 'production.bundles.findings' })
  if (busy) return phrase('held.busy')
  return findings.some((finding) => finding.status !== 'OPEN') ? phrase('held.findingFinal') : null
}

/** A finding may be selected while it waits for its review. */
export const findingSelectable = (finding: Pick<Finding, 'status'>): Phrase | null => (finding.status === 'OPEN' ? null : phrase('held.findingFinal'))

/**
 * Why "Show who" waits, or null: the permission (the owner's), then the site's checks: only where the site names workers,
 * its legal basis is on record and its PERFORMANCE purpose is on.
 */
export function whoHeld(finding: Pick<Finding, 'siteId'>, summary: FindingsSummary | null, can: BundlesCan): Phrase | null {
  if (!can.who) return phrase('held.noWho', { permission: 'production.bundles.who' })
  const site = summary?.sites.find((entry) => entry.id === finding.siteId)
  if (!site) return phrase('checks.UNKNOWN')
  return checksWords(site.checks)
}

export { WHO_PURPOSES, type WhoPurpose }

/** Why the dialog's Show waits, or null: a purpose is required (the audit row keeps it). */
export const whoShowHeld = (purpose: WhoPurpose | null, busy: boolean): Phrase | null => (!purpose ? phrase('who.heldPurpose') : busy ? phrase('held.busy') : null)

/** A refused "Show who" in this page's words: the gate closed since the page was read, a station site, no basis, no right. */
export function whoProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('who.failed')
  const paths = error.issues.map(issuePath)
  if (paths.includes('gate/PERFORMANCE')) return phrase('checks.GATE_CLOSED')
  if (paths.includes('who/STATION_SITE')) return phrase('checks.STATION_SITE')
  if (paths.includes('who/NO_BASIS')) return phrase('checks.NO_BASIS')
  if (error.kind === 'forbidden') return phrase('held.noWho', { permission: 'production.bundles.who' })
  return phrase(error.kind === 'not_found' ? 'who.gone' : 'who.failed')
}

/** A refused review in this page's words (a dismissal needs its note; someone reviewed it first). */
export function reviewProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('review.failed')
  if (error.kind === 'conflict') return phrase('review.changed')
  if (error.kind === 'forbidden') return phrase('held.noFindings', { permission: 'production.bundles.findings' })
  if (error.kind === 'invalid') return phrase('review.noteNeeded')
  return phrase('review.failed')
}

// ---- search or scan -------------------------------------------------------------------------------------------------------------

/** A scan or an Enter that names one bundle opens it: true when the read answers exactly one row of what was asked. */
export const oneHit = (asked: string | null, q: string, rows: readonly TrackedBundle[]): boolean => asked !== null && asked.trim() !== '' && asked.trim() === q.trim() && rows.length === 1

// ---- the ticket -----------------------------------------------------------------------------------------------------------------

export interface TicketWords {
  name: (code: string) => string
  workOrder: string
  style: string
  colour: string
  size: string
  pieces: string
  operations: string
}

/** The BUNDLE ticket as LabelPreview data (100 × 50 mm, as factory-domain labels lays it out): the code as QR and Code 128. */
export function ticketLayout(record: Pick<BundleRecord, 'bundle' | 'workOrder' | 'style' | 'progress'>, words: TicketWords): LabelLayout {
  const { bundle, workOrder, style } = record
  const fields = [
    { label: words.workOrder, value: workOrder.batchNumber ? `${workOrder.number} · ${workOrder.batchNumber}` : workOrder.number },
    { label: words.size, value: bundle.size, size: 'xl' as const },
    { label: words.colour, value: `${bundle.colourwayCode} ${bundle.colourwayName}`.trim() },
    { label: words.pieces, value: bundle.part ? `${bundle.quantity} · ${bundle.part}` : String(bundle.quantity), size: 'xl' as const },
  ]
  const blocks: LabelBlock[] = [
    { kind: 'title', text: [style.code, style.name].filter(Boolean).join(' · '), size: 'md' },
    { kind: 'row', blocks: [{ kind: 'fields', columns: 2, fields }, { kind: 'qr', value: bundle.code, sizeMm: 16 }] },
    ...(record.progress.length > 0 ? [{ kind: 'text' as const, text: `${words.operations}: ${record.progress.map((operation) => operation.seq).join(' · ')}`, size: 'sm' as const }] : []),
    { kind: 'fill' },
    { kind: 'barcode', value: bundle.code, heightMm: 9 },
  ]
  return { name: words.name(bundle.code), widthMm: 100, heightMm: 50, blocks }
}

/** The ticket as factory-domain's BundleTicket, for the browser's PDF (`ticketLabel` → POST /print/labels/pdf). */
export function ticketOf(record: Pick<BundleRecord, 'bundle' | 'workOrder' | 'style' | 'progress'>, language: BundleTicket['language'], maker: string | null): BundleTicket {
  const { bundle, workOrder, style } = record
  return {
    code: bundle.code,
    language,
    maker,
    workOrder: { number: workOrder.number, batchNumber: workOrder.batchNumber },
    style: { code: style.code, name: style.name },
    colourway: { code: bundle.colourwayCode, name: bundle.colourwayName },
    size: bundle.size,
    quantity: bundle.quantity,
    part: bundle.part,
    operations: record.progress.map((operation) => ({ seq: operation.seq, code: operation.code, name: operation.name })),
  }
}

/** The record's tabs (design rec:Bundle). */
export const BUNDLE_TABS = ['progress', 'scans', 'quality', 'ticket'] as const
export type BundleTab = (typeof BUNDLE_TABS)[number]
export const bundleTabOf = (value: string | null | undefined): BundleTab => ((BUNDLE_TABS as readonly string[]).includes(value ?? '') ? (value as BundleTab) : 'progress')

/** Live events that move this page: a scan, a bundle made or changed, a finding. */
export const isBundleChange = (type: string): boolean => /^production\.(scan_recorded|scan_correction_decided|bundle_|scan_findings_found|scan_finding_reviewed|rework_|scrap_posted)/.test(type)

/** The line of a CSV row of the selection (Export N: no API export source for this list yet). */
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",;\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
