import { inlineSampleOf } from '../count/model'
import type { Assigned, DefectBody, FinalCell, InspectionRow } from '../api'
import type { AmendField, Amendments, ChartPoint, Correction, IncomingRow, InlineKind, InlineRow, Sheet, SheetCheck, WorkOrderPlans } from './api'

/**
 * B-W2b-127 — the rules of Inspections in depth, without React and without the API: who may do what (the W2b permissions),
 * incoming and in-line rows in the one list with the final ones (design qi-grid; plan §12 "Inspection kinds": the list
 * unions three tables), each row's words, the report verbs and the bulk print, the plan's checks and the measurement chart
 * on the record, the serial and batch check, the photo set, the amendments (draft, problems, the sign-off steps), the
 * release gate as GateExplainer checks, and New inspection's In-line kind and plan. Message keys are `inspections-depth`'s.
 */

// ---- the W2b permissions ------------------------------------------------------------------------------------------------------

export const DEPTH_PERMISSIONS = {
  incomingView: 'quality.incoming.view',
  incomingRecord: 'quality.incoming.record',
  inprocessView: 'quality.inprocess.view',
  inprocessRecord: 'quality.inprocess.record',
  aqlView: 'quality.aql.view',
  amendRequest: 'quality.amendments.request',
  amendSign: 'quality.amendments.sign',
  docsMake: 'quality.documents.make',
  docsShare: 'quality.documents.share',
  shippingManage: 'shipping.manage',
  defectsView: 'quality.defects.view',
} as const

export type DepthAbility = keyof typeof DEPTH_PERMISSIONS
export type DepthCan = Readonly<Record<DepthAbility, boolean>>

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(DEPTH_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as DepthCan
}

export const NO_DEPTH: DepthCan = depthCan([])

// ---- one list: final, incoming and in-line ---------------------------------------------------------------------------------------

/** The kinds of the one list (design qi-grid "Kind (Incoming · In-line · Final · Return)": returns are graded on the return). */
export const KINDS = ['INCOMING', 'INLINE', 'FINAL'] as const
export type Kind = (typeof KINDS)[number]
export type KindFilter = 'all' | Kind

const KIND_TERMS: Readonly<Record<string, Kind>> = { incoming: 'INCOMING', inline: 'INLINE', final: 'FINAL' }

/** `?kind=incoming|inline|final` (the list's own address term; a saved view keeps it). */
export function kindFromAddress(params: { get(name: string): string | null } | null | undefined): KindFilter {
  return KIND_TERMS[params?.get('kind') ?? ''] ?? 'all'
}

export const kindTerm = (kind: KindFilter): string | null => (kind === 'all' ? null : kind.toLowerCase())

/** The views the incoming and in-line rows join (the others are about final inspections: assignees, releases, holds). */
export const UNION_VIEWS = ['all', 'open'] as const

export const viewJoins = (view: string): boolean => (UNION_VIEWS as readonly string[]).includes(view)

/** The kinds a view reads for this person: the union views read every kind the person may see, the others final only. */
export function kindsRead(view: string, filter: KindFilter, can: { inspectionsView: boolean; incomingView: boolean; inprocessView: boolean }): Kind[] {
  const wanted: Kind[] = viewJoins(view) ? (filter === 'all' ? [...KINDS] : [filter]) : filter === 'all' || filter === 'FINAL' ? ['FINAL'] : []
  return wanted.filter((kind) => (kind === 'FINAL' ? can.inspectionsView : kind === 'INCOMING' ? can.incomingView : can.inprocessView))
}

/** Why a kind chip says nothing in this view or for this person (a message key), or null. */
export function kindChipHeld(kind: Kind, view: string, can: { inspectionsView: boolean; incomingView: boolean; inprocessView: boolean }): string | null {
  if (kind === 'FINAL' && !can.inspectionsView) return 'kind.held.final'
  if (kind === 'INCOMING' && !can.incomingView) return 'kind.held.incoming'
  if (kind === 'INLINE' && !can.inprocessView) return 'kind.held.inline'
  if (kind !== 'FINAL' && !viewJoins(view)) return 'kind.held.view'
  return null
}

export type ListRow =
  | { readonly key: string; readonly kind: 'FINAL'; readonly id: string; readonly createdAt: string; readonly row: InspectionRow }
  | { readonly key: string; readonly kind: 'INCOMING'; readonly id: string; readonly createdAt: string; readonly row: IncomingRow }
  | { readonly key: string; readonly kind: 'INLINE'; readonly id: string; readonly createdAt: string; readonly row: InlineRow }

export const rowKey = (kind: Kind, id: string): string => `${kind}:${id}`

export const finalRow = (row: InspectionRow): ListRow => ({ key: rowKey('FINAL', row.id), kind: 'FINAL', id: row.id, createdAt: row.createdAt, row })
export const incomingRow = (row: IncomingRow): ListRow => ({ key: rowKey('INCOMING', row.id), kind: 'INCOMING', id: row.id, createdAt: row.createdAt, row })
export const inlineRow = (row: InlineRow): ListRow => ({ key: rowKey('INLINE', row.id), kind: 'INLINE', id: row.id, createdAt: row.createdAt, row })

/** The three reads in one list: newest first, at most `limit` rows. */
export function unionRows(parts: { final?: readonly InspectionRow[]; incoming?: readonly IncomingRow[]; inline?: readonly InlineRow[] }, limit: number): ListRow[] {
  const all = [...(parts.final ?? []).map(finalRow), ...(parts.incoming ?? []).map(incomingRow), ...(parts.inline ?? []).map(inlineRow)]
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.key.localeCompare(a.key)).slice(0, limit)
}

/** The final rows of a list (the W1/W2a verbs and bulk actions take only those). */
export const finalRowsOf = (rows: readonly ListRow[]): InspectionRow[] => rows.flatMap((entry) => (entry.kind === 'FINAL' ? [entry.row] : []))

/** Where a row opens. */
export function rowHref(prefix: string, entry: Pick<ListRow, 'kind' | 'id'>): string {
  const id = encodeURIComponent(entry.id)
  return entry.kind === 'FINAL' ? `${prefix}/quality/inspections/${id}` : entry.kind === 'INCOMING' ? `${prefix}/quality/inspections/incoming/${id}` : `${prefix}/quality/inspections/inline/${id}`
}

/** Words with their parameters (a message key of `inspections-depth`, or raw text when `text`). */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const UOM_KEYS: Readonly<Record<string, string>> = { HIDE: 'uom.HIDE', PCS: 'uom.PCS', M: 'uom.M', M2: 'uom.M2', FT2: 'uom.FT2', DM2: 'uom.DM2', KG: 'uom.KG', PAIR: 'uom.PAIR' }

/** A quantity in its unit: "12 hides", "35.5 m" (decimals as the API writes them, trailing zeros dropped). */
export function quantityWords(quantity: string | number, uom: string): Words {
  const amount = typeof quantity === 'number' ? quantity : Number(quantity)
  const shown = Number.isFinite(amount) ? amount : quantity
  const key = UOM_KEYS[uom]
  return key ? { key, params: { count: shown } } : { key: 'uom.other', params: { count: shown, uom } }
}

/** The row's number column: its own number; an in-line check has none ("First piece · DEMO-WO-0142"). */
export function numberOf(entry: ListRow): Words {
  if (entry.kind === 'FINAL') return { key: 'text', params: { text: entry.row.label } }
  if (entry.kind === 'INCOMING') return { key: 'text', params: { text: entry.row.number } }
  const where = entry.row.workOrder?.number ?? entry.row.line?.code ?? ''
  return { key: `inline.label.${entry.row.kind}`, params: { where } }
}

/** The row's subject (design "lot L-0231 / WO-0142 / bundle"). */
export function subjectOf(entry: ListRow): Words {
  if (entry.kind === 'FINAL') return { key: 'subject.workOrder', params: { workOrder: entry.row.number } }
  if (entry.kind === 'INCOMING') {
    if (entry.row.lot) return { key: 'subject.lot', params: { lot: entry.row.lot.code, item: entry.row.item?.name ?? '' } }
    return { key: 'subject.workshop' }
  }
  const row = entry.row
  if (row.bundle) return { key: 'subject.bundle', params: { bundle: row.bundle.code, workOrder: row.workOrder?.number ?? '' } }
  if (row.workOrder) return { key: 'subject.workOrder', params: { workOrder: row.workOrder.number } }
  return { key: 'subject.line', params: { line: row.line?.code ?? '' } }
}

/** "Lot or batch size": garments, the lot in its unit, the pieces looked at. */
export function lotOf(entry: ListRow): Words {
  if (entry.kind === 'FINAL') return { key: 'lot.garments', params: { count: entry.row.lotSize } }
  if (entry.kind === 'INCOMING') return quantityWords(entry.row.lotSize, entry.row.uom)
  return entry.row.pieces > 0 ? { key: 'lot.pieces', params: { count: entry.row.pieces } } : { key: 'none' }
}

/** "Sample n of N" (W2b): counted on a plan, or the sample size alone (W1's typed plan); in-line: nothing. */
export function sampleOf(entry: ListRow): Words {
  if (entry.kind === 'FINAL') {
    if (entry.row.inspected !== null && entry.row.inspected !== undefined) return { key: 'sample.nOf', params: { done: entry.row.inspected, sample: entry.row.sampleSize } }
    return { key: 'sample.only', params: { sample: entry.row.sampleSize } }
  }
  if (entry.kind === 'INCOMING') return { key: 'sample.nOf', params: { done: entry.row.done, sample: entry.row.sampleSize } }
  // B-W2b-213: an in-process check's frozen AQL sample, "2 of 3".
  return inlineSampleOf(entry.row)
}

/** "Plan + version" (FIN-JACKET v3): W1's fixed checklist says so. */
export function planOf(entry: ListRow): Words {
  if (entry.kind === 'FINAL') return entry.row.planVersion ? { key: 'plan.version', params: { code: entry.row.planVersion.code, number: entry.row.planVersion.number } } : { key: 'plan.w1' }
  if (entry.kind === 'INCOMING') return entry.row.plan ? { key: 'plan.version', params: { code: entry.row.plan.code, number: entry.row.plan.number } } : { key: 'none' }
  return entry.row.hasPlan ? { key: 'plan.onPlan' } : { key: 'plan.none' }
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** An incoming or in-line row's status in words with its tone (a final row keeps W1's `statusOf`). */
export function otherStatusOf(entry: Exclude<ListRow, { kind: 'FINAL' }>): { key: string; tone: Tone } {
  const row = entry.row
  if (row.status === 'OPEN') return { key: 'status.OPEN', tone: 'info' }
  if (row.status === 'CANCELLED') return { key: 'status.CANCELLED', tone: 'neutral' }
  if (entry.kind === 'INCOMING') return entry.row.computedResult === 'FAIL' ? { key: 'status.DECIDED_FAIL', tone: 'danger' } : { key: 'status.DECIDED_PASS', tone: 'success' }
  const outcome = entry.row.outcome
  const tone: Tone = outcome === 'FAIL' || outcome === 'REJECTED' || outcome === 'RED' ? 'danger' : outcome === 'AMBER' ? 'warning' : 'success'
  return { key: `outcome.${outcome ?? 'none'}`, tone }
}

/** An incoming decision in words: "Accepted 11 · rejected 1 · to sort 0". */
export function decisionWords(decision: { accepted: string; rejected: string; toSort: string } | null, uom: string): Words | null {
  if (!decision) return null
  const n = (text: string) => (Number.isFinite(Number(text)) ? Number(text) : text)
  return { key: 'decision.split', params: { accepted: n(decision.accepted), rejected: n(decision.rejected), toSort: n(decision.toSort), uom: uom === 'HIDE' ? '' : uom } }
}

// ---- the inspection report: one, many, shared --------------------------------------------------------------------------------

export const REPORT_LIMIT = 20

/** Why the report of a row is held (a key), or null: a final inspection whose result is signed. */
export function reportHeld(entry: Pick<ListRow, 'kind'> & { row: { status: string } }): string | null {
  if (entry.kind !== 'FINAL') return 'report.held.kind'
  return entry.row.status === 'PASSED' || entry.row.status === 'FAILED' ? null : 'report.held.notSigned'
}

/** Why "Print N reports" is held for the selection (a key), or null. */
export function printHeld(entries: readonly ListRow[]): string | null {
  if (entries.length === 0) return 'report.held.none'
  if (entries.length > REPORT_LIMIT) return 'report.held.tooMany'
  if (entries.some((entry) => entry.kind !== 'FINAL')) return 'report.held.kindSome'
  if (entries.some((entry) => reportHeld(entry) !== null)) return 'report.held.notSignedSome'
  return null
}

/** The report window of one inspection (a new tab): `?language=` and `?share=1` (open on the share part). */
export const reportAddress = (prefix: string, id: string, options: { share?: boolean } = {}): string =>
  `${prefix}/quality/inspections/report?id=${encodeURIComponent(id)}${options.share ? '&share=1' : ''}`

/** The bulk print window: every report of the selection, one after the other. */
export const reportsAddress = (prefix: string, ids: readonly string[]): string => `${prefix}/quality/inspections/reports?ids=${ids.map(encodeURIComponent).join(',')}`

/** The ids of the bulk print address (`?ids=a,b`), at most REPORT_LIMIT, each once. */
export function idsFromAddress(params: { get(name: string): string | null } | null | undefined): string[] {
  const raw = params?.get('ids') ?? ''
  return [...new Set(raw.split(',').map((id) => id.trim()).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, REPORT_LIMIT)
}

/** Why Keep is held in the report window (a key), or null. */
export function keepHeld(state: { canMake: boolean; signed: boolean; pdf: boolean; busy: boolean }): string | null {
  if (!state.canMake) return 'report.held.noMake'
  if (!state.signed) return 'report.held.notSigned'
  if (state.busy) return 'common.working'
  if (!state.pdf) return 'report.held.reading'
  return null
}

/** Why Share on a shipment is held (a key), or null. */
export function shareHeld(state: { canShare: boolean; versions: number; shareable: boolean; busy: boolean }): string | null {
  if (!state.canShare) return 'share.held.noRight'
  if (state.versions === 0) return 'share.held.noVersion'
  if (!state.shareable) return 'share.held.notShareable'
  if (state.busy) return 'common.working'
  return null
}

// ---- Checks & results on a plan (the sheet's checks) -------------------------------------------------------------------------

/** The units of a sample, 1 … n. */
export const unitsOf = (sampleSize: number): number[] => Array.from({ length: Math.max(0, sampleSize) }, (_, index) => index + 1)

/** A check's answer for one unit, or null (not checked). */
export const answerOf = (check: Pick<SheetCheck, 'results'>, unit: number) => check.results.find((result) => result.sampleIndex === unit) ?? null

/** A check's answers over the sample, counted: "3 passed · 1 failed of 5". */
export function checkCounts(check: Pick<SheetCheck, 'results'>, sampleSize: number): { pass: number; fail: number; na: number; open: number } {
  const pass = check.results.filter((result) => result.outcome === 'PASS').length
  const fail = check.results.filter((result) => result.outcome === 'FAIL').length
  const na = check.results.filter((result) => result.outcome === 'NOT_APPLICABLE').length
  return { pass, fail, na, open: Math.max(0, sampleSize - pass - fail - na) }
}

/** The checks the office answers here (a measurement is answered on the chart, a photo on the bench; an instruction takes none). */
export const recordable = (check: Pick<SheetCheck, 'takesResult' | 'onChart' | 'type'>): boolean => check.takesResult && !check.onChart && check.type !== 'PHOTO'

/** Why the plan's answers cannot be recorded here (a key of `inspections-depth`), or null (the record's own reason first). */
export function planRecordHeld(sheet: Pick<Sheet, 'may' | 'inspection'> | null, recordHeld: string | null): string | null {
  if (recordHeld) return null
  if (!sheet) return 'checks.held.reading'
  if (sheet.inspection.status !== 'OPEN') return 'checks.held.signed'
  return sheet.may.record ? null : 'checks.held.mayNot'
}

/** A value a check takes, said back before it is sent (a key), or null: whole numbers for a count, one of the choices. */
export function valueProblem(check: Pick<SheetCheck, 'type' | 'choices'>, value: string): string | null {
  const text = value.trim()
  if (check.type === 'COUNT' && text && !/^\d+$/.test(text)) return 'checks.problem.count'
  if (check.type === 'CHOICE' && text && check.choices.length > 0 && !check.choices.includes(text)) return 'checks.problem.choice'
  return null
}

// ---- Measurements (the sheet's chart) ----------------------------------------------------------------------------------------

/** The units shown at once on the chart (a large sample turns the page by ten). */
export const CHART_PAGE = 10

export function chartPages(sampleSize: number): { from: number; to: number }[] {
  const pages: { from: number; to: number }[] = []
  for (let from = 1; from <= sampleSize; from += CHART_PAGE) pages.push({ from, to: Math.min(sampleSize, from + CHART_PAGE - 1) })
  return pages
}

/**
 * A point's value for one unit (of the point's size, or any size when the point has none): the newest when a unit holds two
 * (a row keyed by an older point code beside the plan check's own — seen on the seed's SEED-INS-0009).
 */
export const valueAt = (point: Pick<ChartPoint, 'values' | 'size'>, unit: number) => point.values.filter((value) => value.sampleIndex === unit && (point.size === null || value.size === point.size)).at(-1) ?? null

/** A typed measurement as the API takes it ("58,4" → "58.4"), or null when it is no number. */
export function decimalOf(text: string): string | null {
  const value = text.trim().replace(',', '.')
  return /^-?\d{1,8}(\.\d{1,4})?$/.test(value) ? value : null
}

/** The chart cell's write: a plan's check by its code, a profile or typed point by its point code. */
export const measurementBody = (point: Pick<ChartPoint, 'checkCode' | 'pointCode' | 'size'>, unit: number, measured: string | null) => ({
  ...(point.checkCode ? { checkCode: point.checkCode } : { pointCode: point.pointCode }),
  size: point.size,
  sampleIndex: unit,
  measured,
})

/** "Create defect" from an out-of-tolerance cell (design ins-measure-grid): a MAJOR line named after the point, one more on it if it exists. */
export function measurementDefect(lines: readonly DefectBody[], point: Pick<ChartPoint, 'pointCode'>, note: string): DefectBody[] {
  const code = `MEAS-${point.pointCode}`.toUpperCase().replace(/[^A-Z0-9_-]/g, '-').slice(0, 40)
  const at = lines.findIndex((line) => line.code === code && line.defectClass === 'MAJOR')
  if (at >= 0) return lines.map((line, index) => (index === at ? { ...line, quantity: line.quantity + 1 } : line))
  return [...lines, { defectClass: 'MAJOR', code, quantity: 1, workOrderSizeId: null, note: note.slice(0, 500), defectCodeId: null, zone: null }]
}

/** Why a chart cell cannot be typed here (a key), or null. */
export const chartHeld = (sheet: Pick<Sheet, 'may' | 'inspection'> | null, recordHeld: string | null): string | null => planRecordHeld(sheet, recordHeld)

// ---- the serial and batch check, the photo set ---------------------------------------------------------------------------------

/** "Expected 48 · scanned 47 · missing 1 · unknown 0", or the batch read once. */
export function identityWords(identity: Sheet['identity']): Words {
  if (identity.mode === 'BATCH') return identity.done ? { key: 'identity.batchDone', params: { batch: identity.batchNumber ?? '' } } : { key: 'identity.batchOpen' }
  return { key: 'identity.serials', params: { expected: identity.target, scanned: identity.matched, missing: identity.missingCount, unknown: identity.unknown.length, noNumber: identity.noNumber } }
}

export function identityTone(identity: Pick<Sheet['identity'], 'ok' | 'done'>): Tone {
  if (identity.ok === false) return 'danger'
  if (identity.ok === true) return 'success'
  return identity.done ? 'warning' : 'info'
}

/** A slot of the photo set with the files the bench took (the plan's PHOTO check, or a check that asks for its photo). */
export interface PhotoSlot {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly mandatory: boolean
  readonly state: 'TAKEN' | 'MISSING' | 'NOT_APPLICABLE' | 'OPEN'
  readonly fileIds: readonly string[]
  readonly quarantined: number
}

export function photoSlots(sheet: Pick<Sheet, 'photos' | 'checks'>): PhotoSlot[] {
  return sheet.photos.slots.map((slot) => {
    const check = sheet.checks.find((entry) => entry.code === slot.code)
    const photos = (check?.results ?? []).flatMap((result) => result.photos)
    return {
      code: slot.code,
      labelIt: slot.labelIt,
      labelEn: slot.labelEn,
      mandatory: slot.mandatory,
      state: slot.state,
      fileIds: photos.filter((photo) => photo.status === 'AVAILABLE').map((photo) => photo.id),
      quarantined: photos.filter((photo) => photo.status !== 'AVAILABLE').length,
    }
  })
}

/** The photo files of the checks that ask for one (besides the set's slots), for "photo per row" on the checks. */
export const resultPhotoIds = (check: Pick<SheetCheck, 'results'>): string[] => check.results.flatMap((result) => result.photos.filter((photo) => photo.status === 'AVAILABLE').map((photo) => photo.id))

// ---- amendments (pop:ins-amend, dec-amend) ------------------------------------------------------------------------------------

/** One field of the record (or of a row) a correction may take, as a key the dialog's picker keeps. */
export const fieldKey = (field: Pick<AmendField, 'field' | 'row'>): string => `${field.row?.type ?? 'record'}:${field.row?.id ?? ''}:${field.field}`

/** The fields a correction may be asked of now (none waits on it already). */
export const freeFields = (amendments: Pick<Amendments, 'fields'>): AmendField[] => amendments.fields.filter((field) => field.waiting === null)

export interface AmendDraft {
  readonly field: string
  readonly value: string
  readonly reason: string
}

export const AMEND_DRAFT: AmendDraft = Object.freeze({ field: '', value: '', reason: '' })

/** The draft when a field is picked: its value now (what stands), to edit. */
export const draftFor = (field: AmendField, reason = ''): AmendDraft => ({ field: fieldKey(field), value: field.value ?? '', reason })

/** The input a field takes: a long text, a short text, a decimal, one of the choices, a garment zone, a cause code. */
export function inputOf(field: Pick<AmendField, 'kind' | 'choices'>): 'textarea' | 'text' | 'decimal' | 'choice' | 'zone' | 'cause' {
  if (field.kind === 'note' || field.kind === 'text') return 'textarea'
  if (field.kind === 'decimal') return 'decimal'
  if (field.kind === 'zone') return 'zone'
  if (field.kind === 'cause') return 'cause'
  return field.choices && field.choices.length > 0 ? 'choice' : 'text'
}

/** The new value as the API takes it: text, a decimal with a dot, null to clear (a field that may be empty). */
export function afterOf(field: Pick<AmendField, 'kind' | 'nullable'>, value: string): string | null {
  const text = value.trim()
  if (!text) return field.nullable ? null : ''
  return field.kind === 'decimal' ? (decimalOf(text) ?? text) : text
}

/** The dialog's problems (keys), every one at once; the API checks the same again (and the verdict rule). */
export function amendProblems(draft: AmendDraft, field: AmendField | null): string[] {
  if (!field) return ['amend.problem.field']
  const problems: string[] = []
  const after = afterOf(field, draft.value)
  if (after === '' && !field.nullable) problems.push('amend.problem.empty')
  else if (field.kind === 'decimal' && after !== null && decimalOf(after) === null) problems.push('amend.problem.decimal')
  else if ((after ?? null) === (field.value ?? null)) problems.push('amend.problem.same')
  if (draft.reason.trim().length < 3) problems.push('amend.problem.reason')
  return problems
}

/** Why "Amend signed result" is held (a key), or null. */
export function amendHeld(amendments: Pick<Amendments, 'record' | 'may' | 'fields'> | null, can: Pick<DepthCan, 'amendRequest'>): string | null {
  if (!can.amendRequest) return 'amend.held.noRight'
  if (!amendments) return 'amend.held.reading'
  if (!amendments.record.signed) return 'amend.held.notSigned'
  if (!amendments.may.request) return 'amend.held.noRight'
  if (freeFields(amendments).length === 0) return 'amend.held.allWaiting'
  return null
}

/** Why the second signature of a waiting correction is held for the person looking (a key), or null. */
export function answerHeld(correction: Pick<Correction, 'state' | 'mine'>, may: Pick<Amendments['may'], 'sign'>): string | null {
  if (correction.state !== 'WAITING') return 'amend.held.answered'
  if (correction.mine) return 'amend.held.mine'
  if (!may.sign) return 'amend.held.noSign'
  return null
}

/** A correction's place: "A1" once signed, else its state word. */
export const correctionRef = (correction: Pick<Correction, 'ref'>): string | null => (correction.ref === null ? null : `A${correction.ref}`)

// ---- the release gate as GateExplainer checks (design qi-gate) -------------------------------------------------------------------

/** A release cell's gate checks: each named in our words, its state the gate's (the API's sentences are English: not drawn). */
export function gateChecks(cell: Pick<FinalCell, 'checks'>): { id: string; code: string; state: 'pass' | 'fail' | 'notNeeded' }[] {
  return cell.checks.map((check) => ({ id: check.code, code: check.code, state: check.state === 'OK' ? 'pass' : check.state === 'OPEN' ? 'fail' : 'notNeeded' }))
}

// ---- New inspection: In-line (W2b) and the plan of a final one ------------------------------------------------------------------

export const NEW_INLINE_KINDS: readonly InlineKind[] = ['FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE']

/** An in-line check's problems (keys): a work order; a first piece names the bundle it is made from. */
export function inlineProblems(draft: { inlineKind: InlineKind; workOrderId: string | null; bundleCode: string }): string[] {
  const problems: string[] = []
  if (!draft.workOrderId && !draft.bundleCode.trim()) problems.push('new.inline.problem.workOrder')
  if (draft.inlineKind === 'FIRST_PIECE' && !draft.bundleCode.trim()) problems.push('new.inline.problem.bundle')
  return problems
}

/** Why the In-line kind is held for this person (a key of `inspections-depth`), or null. */
export const inlineKindHeld = (can: Pick<DepthCan, 'inprocessRecord'>, workOrdersView: boolean): string | null => (!can.inprocessRecord ? 'new.inline.held.noRight' : !workOrdersView ? 'new.inline.held.noWorkOrders' : null)

/** The plan a final inspection runs on: the picked one, else the suggestion; "another plan" needs the reason. */
export function planPick(plans: Pick<WorkOrderPlans, 'plans' | 'suggestedId'> | null, picked: string | null): { id: string | null; other: boolean } {
  if (!plans) return { id: null, other: false }
  const usable = plans.plans.filter((plan) => plan.usable)
  const id = picked && usable.some((plan) => plan.id === picked) ? picked : (plans.suggestedId ?? null)
  return { id, other: id !== null && plans.suggestedId !== null && id !== plans.suggestedId }
}

/** The plan part's problems (keys): a usable plan, the reason when it is not the one that applies. */
export function planProblems(plans: Pick<WorkOrderPlans, 'plans' | 'suggestedId'> | null, picked: string | null, reason: string): string[] {
  const pick = planPick(plans, picked)
  if (!pick.id) return ['new.plan.problem.none']
  if ((pick.other || plans?.suggestedId === null) && reason.trim().length < 3) return ['new.plan.problem.reason']
  return []
}

// ---- small words ------------------------------------------------------------------------------------------------------------------

/** Who signed a list row, in words, never a person's name (Owner answer W1). */
export const inspectorKindKey = (kind: 'FLOOR' | 'OFFICE' | null): string => (kind === 'FLOOR' ? 'who.bench' : kind === 'OFFICE' ? 'who.office' : 'who.nobody')

/** An assignee named only inside one record (a final row keeps W2a's words). */
export const assignedName = (assigned: Assigned | null): string | null => assigned?.name ?? null

/** The language of a check label for the page. */
export const labelIn = (entry: { labelIt: string; labelEn: string }, locale: string): string => (locale.startsWith('it') ? entry.labelIt : entry.labelEn)

// ---- what holds "Sign result" on a plan, from the sheet's facts (its own reasons are English) -------------------------------

/** The holds of a PASS on a plan, in our words: mandatory checks, the serial or batch check, the photo set, the sample. */
export function signHoldsOf(sheet: Pick<Sheet, 'checksNow' | 'identity' | 'photos' | 'counter' | 'checks'>, locale: string): Words[] {
  const holds: Words[] = []
  const names = (codes: readonly string[]) => codes.map((code) => { const check = sheet.checks.find((entry) => entry.code === code); return check ? labelIn(check, locale) : code }).join(', ')
  if (sheet.checksNow.mandatoryMissing.length > 0) holds.push({ key: 'hold.mandatory', params: { checks: names(sheet.checksNow.mandatoryMissing), count: sheet.checksNow.mandatoryMissing.length } })
  if (!sheet.identity.done) holds.push({ key: sheet.identity.mode === 'BATCH' ? 'hold.batch' : 'hold.serials' })
  else if (sheet.identity.ok === false) holds.push({ key: 'hold.identityFails' })
  if (sheet.photos.mandatoryMissing.length > 0) holds.push({ key: 'hold.photos', params: { slots: sheet.photos.mandatoryMissing.join(', '), count: sheet.photos.mandatoryMissing.length } })
  if (sheet.counter.remaining > 0) holds.push({ key: 'hold.sample', params: { remaining: sheet.counter.remaining, sample: sheet.counter.sampleSize } })
  return holds
}
