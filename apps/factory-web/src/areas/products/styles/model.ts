import type { Tone } from '@nexus/ui/primitives'
import type { BomView, CostCell, CostSheetView, MissingInput, RoutingView, StyleComplianceView, StyleRow, StyleView } from './api'

/**
 * The Styles list and the Style studio's rules, pure (SCR-040 … SCR-045): who may do what (permissions and money
 * grains), the studio's tabs and the revision in view, the list's saved filters, what a change of the size range does
 * to the SKUs, the release check in this app's words (never the API's English), the decimals people type, money and
 * minutes as they read them. The screens and the containers use these; the tests hold them.
 */

// ---- who may do what --------------------------------------------------------------------------------------------------

/** Money grains (A1 §2.6): cost hides every cost figure, margin every margin; a production manager sees no cost. */
export interface Grains {
  cost: boolean
  price: boolean
  margin: boolean
}

export function grainsOf(permissions: readonly string[]): Grains {
  const held = new Set(permissions)
  return { cost: held.has('money.cost'), price: held.has('money.price'), margin: held.has('money.margin') }
}

export interface StyleAbilities {
  view: boolean
  manage: boolean
  bomView: boolean
  bomManage: boolean
  release: boolean
  routingView: boolean
  routingManage: boolean
  costView: boolean
  complianceView: boolean
  /** Upload a signed DoC or leaflet (compliance.declarations.manage and files.upload). */
  declarations: boolean
  /** A draft revision names its garment label (compliance.labels.manage). */
  labels: boolean
  materials: boolean
  brands: boolean
  thread: boolean
}

export function abilitiesOf(permissions: readonly string[]): StyleAbilities {
  const held = new Set(permissions)
  const has = (permission: string) => held.has(permission)
  return {
    view: has('product.styles.view'),
    manage: has('product.styles.manage'),
    bomView: has('product.bom.view'),
    bomManage: has('product.bom.manage'),
    release: has('product.bom.release'),
    routingView: has('product.routing.view'),
    routingManage: has('product.routing.manage'),
    costView: has('costing.view'),
    complianceView: has('compliance.certificates.view'),
    declarations: has('compliance.declarations.manage') && has('files.upload'),
    labels: has('compliance.labels.manage'),
    materials: has('product.materials.view'),
    brands: has('parties.view'),
    thread: has('threads.read'),
  }
}

// ---- the studio's tabs ------------------------------------------------------------------------------------------------

export type StyleTab = 'overview' | 'variants' | 'bom' | 'routing' | 'cost' | 'compliance' | 'activity'
/** The studio's tabs, in the band's order. */
export const STYLE_TABS: readonly StyleTab[] = ['overview', 'variants', 'activity']

export function tabOf(value: string | null | undefined): StyleTab {
  return (STYLE_TABS as readonly string[]).includes(value ?? '') ? (value as StyleTab) : 'overview'
}

/** The tabs a person may open: a tab whose API they cannot read is not drawn (its page is absent, not empty). */
export function tabsFor(can: StyleAbilities): StyleTab[] {
  return STYLE_TABS.filter((tab) => {
    if (tab === 'bom') return can.bomView
    if (tab === 'routing') return can.routingView
    if (tab === 'cost') return can.costView
    if (tab === 'compliance') return can.complianceView
    if (tab === 'activity') return can.thread
    return true
  })
}

export const STATUS_TONE: Record<StyleView['status'], Tone> = { DRAFT: 'info', ACTIVE: 'success', ARCHIVED: 'neutral' }
export const REVISION_TONE: Record<StyleView['revisions'][number]['status'], Tone> = { DRAFT: 'info', RELEASED: 'success', OBSOLETE: 'neutral' }

// ---- the revision in view ---------------------------------------------------------------------------------------------

type Revision = StyleView['revisions'][number]

/**
 * The revision the studio shows: the one asked for in the address when it is the style's, else the open draft (where
 * the work happens), else the released one, else the newest. Null: the style has no revision yet.
 */
export function revisionInView(revisions: readonly Revision[], asked: string | null | undefined): Revision | null {
  if (asked) {
    const found = revisions.find((revision) => revision.id === asked)
    if (found) return found
  }
  return revisions.find((revision) => revision.status === 'DRAFT') ?? revisions.find((revision) => revision.status === 'RELEASED') ?? [...revisions].sort((a, b) => b.revision - a.revision)[0] ?? null
}

export const draftOf = (revisions: readonly Revision[]): Revision | null => revisions.find((revision) => revision.status === 'DRAFT') ?? null
export const releasedOf = (revisions: readonly Revision[]): Revision | null => revisions.find((revision) => revision.status === 'RELEASED') ?? null
export const nextRevisionNumber = (revisions: readonly Revision[]): number => revisions.reduce((top, revision) => Math.max(top, revision.revision), 0) + 1

/** `[` and `]`: the revision before or after the one in view (by number), or null at the ends. */
export function stepRevision(revisions: readonly Revision[], current: string | null, delta: -1 | 1): Revision | null {
  const sorted = [...revisions].sort((a, b) => a.revision - b.revision)
  const index = sorted.findIndex((revision) => revision.id === current)
  if (index < 0) return null
  return sorted[index + delta] ?? null
}

/** Why a new revision cannot start now (a message key), or null. */
export function startRevisionHeld(style: Pick<StyleView, 'status' | 'revisions'>, can: StyleAbilities): string | null {
  if (style.status === 'ARCHIVED') return 'held.archived'
  const draft = draftOf(style.revisions)
  if (draft) return 'held.draftOpen'
  const frozen = style.revisions.length > 0
  if (frozen ? !can.bomManage : !can.manage) return 'held.noManage'
  return null
}

/** A revision's BOM, routing and label are changed only while it is a draft of a style that is not archived. */
export function editableRevision(style: Pick<StyleView, 'status'>, revision: Pick<Revision, 'status'> | null): boolean {
  return !!revision && revision.status === 'DRAFT' && style.status !== 'ARCHIVED'
}

// ---- the list (SCR-040) -----------------------------------------------------------------------------------------------

/** The list's saved filters; the tiles are the same filters (one filter model). */
export const STYLE_VIEWS = ['open', 'drafts', 'waiting', 'active', 'archived', 'all'] as const
export type StyleListView = (typeof STYLE_VIEWS)[number]

export function viewOf(value: string | null | undefined): StyleListView {
  return (STYLE_VIEWS as readonly string[]).includes(value ?? '') ? (value as StyleListView) : 'open'
}

/** The API's filter for a saved filter. */
export function viewQuery(view: StyleListView): { status: 'OPEN' | 'DRAFT' | 'ACTIVE' | 'ARCHIVED' | 'ALL'; draftRevision?: boolean } {
  switch (view) {
    case 'drafts':
      return { status: 'DRAFT' }
    case 'waiting':
      return { status: 'OPEN', draftRevision: true }
    case 'active':
      return { status: 'ACTIVE' }
    case 'archived':
      return { status: 'ARCHIVED' }
    case 'all':
      return { status: 'ALL' }
    default:
      return { status: 'OPEN' }
  }
}

/** The tiles above the list: each a saved filter whose number is the list's total under it. */
export const STYLE_TILES: readonly StyleListView[] = ['drafts', 'waiting', 'active', 'archived']

/** "44–60, base 52" — the range as the list shows it (sizes are in the scale's order). */
export function rangeWords(sizes: readonly string[]): string {
  if (sizes.length === 0) return ''
  return sizes.length === 1 ? sizes[0]! : `${sizes[0]}–${sizes[sizes.length - 1]}`
}

/** Rev chips: "Rev 3 released · Rev 4 draft". */
export function revisionChips(row: Pick<StyleRow, 'releasedRevision' | 'draftRevision'>): Array<{ kind: 'released' | 'draft'; revision: number }> {
  const chips: Array<{ kind: 'released' | 'draft'; revision: number }> = []
  if (row.releasedRevision !== null) chips.push({ kind: 'released', revision: row.releasedRevision })
  if (row.draftRevision !== null) chips.push({ kind: 'draft', revision: row.draftRevision })
  return chips
}

/** What the completeness column counts: the five things a style needs before it can be made. */
export function completenessOf(row: Pick<StyleRow, 'completeness'>): { done: number; of: number; missing: Array<keyof StyleRow['completeness']> } {
  const entries = Object.entries(row.completeness) as Array<[keyof StyleRow['completeness'], boolean]>
  return { done: entries.filter(([, done]) => done).length, of: entries.length, missing: entries.filter(([, done]) => !done).map(([key]) => key) }
}

/** The CSV of the selected rows (no money: the list carries none). */
export function stylesCsv(rows: readonly StyleRow[], words: { header: readonly string[]; status: (status: StyleRow['status']) => string; type: (type: StyleRow['productType']) => string; ppe: (category: StyleRow['ppeCategory']) => string }): string {
  const cell = (value: string | number | null) => {
    const text = value === null ? '' : String(value)
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = rows.map((row) =>
    [row.code, row.name, words.type(row.productType), row.season, row.brand?.name ?? null, words.status(row.status), row.releasedRevision, row.draftRevision, row.sizes.join(' '), row.baseSize, row.colourwayCount, row.skuCount, words.ppe(row.ppeCategory), row.ppeClass].map(cell).join(','),
  )
  return [words.header.map(cell).join(','), ...lines].join('\n')
}

// ---- the size range and the SKU matrix ----------------------------------------------------------------------------------

/**
 * What a new range does to the SKUs before Apply (design: "says how many SKUs it adds or switches off"): once the matrix
 * is generated, every ACTIVE colourway gets a SKU in each size new to the range, and a size taken out has its SKUs
 * switched off (archived, never deleted). Before the matrix is generated nothing moves.
 */
export function rangeEffect(style: Pick<StyleView, 'sizes' | 'colourways' | 'matrix'>, next: readonly string[]): { added: string[]; removed: string[]; skusOn: number; skusOff: number } {
  const before = new Set(style.sizes)
  const after = new Set(next)
  const added = next.filter((size) => !before.has(size))
  const removed = style.sizes.filter((size) => !after.has(size))
  if (!style.matrix.generated) return { added, removed, skusOn: 0, skusOff: 0 }
  const active = style.colourways.filter((colourway) => colourway.status === 'ACTIVE').length
  const removedSet = new Set(removed)
  const skusOff = style.matrix.rows.reduce((sum, row) => sum + row.cells.filter((cell) => removedSet.has(cell.size) && cell.sku?.status === 'ACTIVE').length, 0)
  return { added, removed, skusOn: added.length * active, skusOff }
}

/** The range's codes put in the scale's order (a chip pressed anywhere lands in its place). */
export function inScaleOrder(codes: readonly string[], scale: readonly string[]): string[] {
  const order = new Map(scale.map((code, index) => [code, index]))
  return [...new Set(codes)].sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6))
}

export interface MatrixCellState {
  colourwayId: string
  size: string
  /** on: a SKU is ACTIVE; off: archived; none: no SKU yet (generate); closed: the colourway is archived. */
  state: 'on' | 'off' | 'none' | 'closed'
  sku: StyleView['matrix']['rows'][number]['cells'][number]['sku']
}

export function matrixCells(style: Pick<StyleView, 'matrix'>): MatrixCellState[][] {
  return style.matrix.rows.map((row) =>
    row.cells.map((cell) => ({
      colourwayId: row.colourwayId,
      size: cell.size,
      state: row.status !== 'ACTIVE' ? 'closed' : !cell.sku ? 'none' : cell.sku.status === 'ACTIVE' ? 'on' : 'off',
      sku: cell.sku,
    })),
  )
}

/** Shift+Space on a row: every SKU of the row ON when any is off, else every one off. */
export function rowToggle(cells: readonly MatrixCellState[]): Array<{ skuId: string; version: number; status: 'ACTIVE' | 'ARCHIVED' }> {
  const withSku = cells.filter((cell) => cell.sku && cell.state !== 'closed')
  const anyOff = withSku.some((cell) => cell.state === 'off')
  const status = anyOff ? 'ACTIVE' : 'ARCHIVED'
  return withSku.filter((cell) => (status === 'ACTIVE' ? cell.state === 'off' : cell.state === 'on')).map((cell) => ({ skuId: cell.sku!.id, version: cell.sku!.version, status }))
}

/** The cell an arrow key moves to, held at the edges. */
export function moveCell(at: { row: number; col: number }, key: string, rows: number, cols: number): { row: number; col: number } {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max - 1, value))
  if (key === 'ArrowUp') return { row: clamp(at.row - 1, rows), col: at.col }
  if (key === 'ArrowDown') return { row: clamp(at.row + 1, rows), col: at.col }
  if (key === 'ArrowLeft') return { row: at.row, col: clamp(at.col - 1, cols) }
  if (key === 'ArrowRight') return { row: at.row, col: clamp(at.col + 1, cols) }
  if (key === 'Home') return { row: at.row, col: 0 }
  if (key === 'End') return { row: at.row, col: cols - 1 }
  return at
}

// ---- decimals as people type them -------------------------------------------------------------------------------------

/** "1,8" or "1.8" → "1.8"; "" → null (cleared); anything else → undefined (not a number). At most `scale` decimals. */
export function decimalInput(text: string, scale = 4): string | null | undefined {
  const trimmed = text.trim().replace(/\s/g, '')
  if (trimmed === '') return null
  const normal = trimmed.replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(normal)) return undefined
  const [whole, fraction = ''] = normal.split('.')
  if (fraction.length > scale) return undefined
  const cleanWhole = whole!.replace(/^0+(?=\d)/, '')
  const cleanFraction = fraction.replace(/0+$/, '')
  return cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole
}

/** A decimal string as the person reads it ("1.8" → "1,8" in Italian), trailing zeros dropped. */
export function decimalText(value: string | null | undefined, locale: 'it' | 'en', maxDecimals = 4): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: maxDecimals }).format(number)
}

/** A cost figure (decimal string from the API, rounded once there) in its currency, two decimals for the eye. */
export function moneyText(value: string | null | undefined, currency: string, locale: 'it' | 'en', decimals = 2): string {
  if (value === null || value === undefined) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(number)
}

/** Minutes: "96,5 min". */
export const minutesText = (value: string | null | undefined, locale: 'it' | 'en'): string => decimalText(value, locale, 3)

// ---- the release check in words --------------------------------------------------------------------------------------

type BomIssue = BomView['issues'][number]

export interface Words {
  key: string
  params?: Record<string, string | number>
}

/** A BOM or routing finding in this app's words (the API's message is English and for logs), with where it is. */
export function issueWords(issue: BomIssue, bom: Pick<BomView, 'lines' | 'colourways'> | null, routing: Pick<RoutingView, 'steps'> | null): Words {
  const line = issue.lineId ? bom?.lines.find((entry) => entry.id === issue.lineId) : undefined
  const step = issue.stepId ? routing?.steps.find((entry) => entry.id === issue.stepId) : undefined
  const colourway = issue.colourwayId ? bom?.colourways.find((entry) => entry.id === issue.colourwayId) : undefined
  return {
    key: `issue.${issue.code}`,
    params: {
      line: line ? `${line.seq} · ${line.item.code}` : '—',
      size: issue.size ?? '—',
      colourway: colourway ? colourway.code : '—',
      step: step ? `${step.seq} · ${step.code}` : '—',
    },
  }
}

/** Which tab fixes an issue (routing codes on the routing; the rest on the BOM, the range and colourways on Colourways & sizes). */
export function issueTab(issue: Pick<BomIssue, 'code'>): StyleTab {
  if (['NO_STEPS', 'MINUTES_NOT_POSITIVE', 'NO_SCAN_POINT', 'OPERATION_ARCHIVED', 'LAST_STEP_NOT_SCANNED'].includes(issue.code)) return 'routing'
  if (['NO_SIZE_RANGE', 'NO_ACTIVE_COLOURWAY'].includes(issue.code)) return 'variants'
  return 'bom'
}

/** Why "Release revision N" is held (a message key and params), or null when it would pass. */
export function releaseHeld(style: Pick<StyleView, 'status'>, revision: Pick<Revision, 'status'> | null, bom: BomView | null, can: StyleAbilities): Words | null {
  if (!revision) return { key: 'held.noRevision' }
  if (!can.release) return { key: 'held.noRelease' }
  if (style.status === 'ARCHIVED') return { key: 'held.archived' }
  if (revision.status !== 'DRAFT') return { key: 'held.notDraft' }
  if (!bom) return { key: 'held.checking' }
  if (bom.issues.length > 0) return { key: 'held.blockers', params: { count: bom.issues.length } }
  return null
}

/** The compliance checks that would stop production, labels or shipping after the release (said, not refused). */
export function complianceAfterRelease(compliance: StyleComplianceView | null): StyleComplianceView['checks'] {
  return compliance ? compliance.checks.filter((check) => check.state === 'BLOCKED' && check.code !== 'REVISION') : []
}

// ---- cost -----------------------------------------------------------------------------------------------------------

/** The cell the Cost tab opens on: the base size of the first colourway (else the first cell). */
export function defaultCostCell(sheet: Pick<CostSheetView, 'cells' | 'colourways' | 'sizes' | 'style'>): { colourwayId: string; size: string } | null {
  const colourwayId = sheet.colourways[0]?.id
  if (!colourwayId) return null
  const size = sheet.style.baseSize && sheet.sizes.includes(sheet.style.baseSize) ? sheet.style.baseSize : sheet.sizes[0]
  return size ? { colourwayId, size } : null
}

export function costCellOf(sheet: Pick<CostSheetView, 'cells'>, at: { colourwayId: string; size: string } | null): CostCell | null {
  if (!at) return null
  return sheet.cells.find((cell) => cell.colourwayId === at.colourwayId && cell.size === at.size) ?? null
}

/** A missing input in this app's words: what is missing and where, never a figure. */
export function missingWords(missing: MissingInput, sheet: Pick<CostSheetView, 'inputs'> | null, bom: Pick<BomView, 'lines'> | null): Words {
  const item = missing.itemId ? sheet?.inputs.materials.find((material) => material.itemId === missing.itemId) : undefined
  const line = missing.lineId ? bom?.lines.find((entry) => entry.id === missing.lineId) : undefined
  return {
    key: `missing.${missing.code}`,
    params: {
      material: item ? item.code : line ? line.item.code : '—',
      line: line ? `${line.seq} · ${line.item.code}` : '—',
      size: missing.size ?? '—',
      kind: missing.workCentreKind ?? '—',
    },
  }
}

/** The change of a cell's cost against the released revision, when both are known (else null). */
export function costChange(diff: { cells: ReadonlyArray<{ colourwayId: string; size: string; totalChange?: string | null }> } | null, at: { colourwayId: string; size: string } | null): string | null {
  if (!diff || !at) return null
  const cell = diff.cells.find((entry) => entry.colourwayId === at.colourwayId && entry.size === at.size)
  // A cell left out of the comparison did not change.
  if (!cell) return '0'
  return cell.totalChange ?? null
}

/** A share of a whole for a bar (0 … 100), never NaN. */
export function share(part: string | null | undefined, whole: string | null | undefined): number {
  const p = Number(part)
  const w = Number(whole)
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return 0
  return Math.max(0, Math.min(100, (p / w) * 100))
}

// ---- compliance -------------------------------------------------------------------------------------------------------

export const CELL_TONE: Record<StyleComplianceView['coverage']['cells'][number]['status'], Tone> = {
  COVERED: 'success',
  NOT_COVERED: 'danger',
  EXPIRED: 'danger',
  SUSPENDED: 'warning',
  NOT_REQUIRED: 'neutral',
}

export const CHECK_TONE: Record<StyleComplianceView['checks'][number]['state'], Tone> = { OK: 'success', BLOCKED: 'danger', NOT_REQUIRED: 'neutral' }

/** A SHA-256 of a file the browser read, for the store's check. */
export async function sha256Of(file: Blob): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A file the DoC / leaflet upload takes: a PDF of at most 20 MB. */
export function documentFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return 'compliance.upload.notPdf'
  if (file.size > 20 * 1024 * 1024) return 'compliance.upload.tooBig'
  if (file.size === 0) return 'compliance.upload.empty'
  return null
}

/** Today in Europe/Rome as YYYY-MM-DD (a business date). */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
