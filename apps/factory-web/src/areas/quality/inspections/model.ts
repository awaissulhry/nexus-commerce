import { CHECKLIST_GROUPS, CHECKLIST_ITEMS, computedResult, type ChecklistGroup, type InspectionResult } from '@nexus/factory-domain/quality/final/rules'
import { isFourEyesLoosening, type FourEyesRule, type ReleaseCheckCode, type SecondPersonReason } from '@nexus/factory-domain/quality/release/rules'
import type { Lot } from '../_shared/lots'
import type { LiveState, Notice, QualityCan, Read } from '../_shared/model'
import type { Assigned, DefectBody, FinalCell, FinalState, Inspection, InspectionPhoto, InspectionRead, InspectionRow, Inspectors, InspectorPick, PickedDefect, Release, ReleaseDetail, ReleaseRule, ReturnPick, ReturnRecord, ReverseImpact, Who, WorkOrderCells, WorkOrderPick, PartyPick } from './api'

/**
 * The rules of Inspections (SCR-075) and the inspection record (SCR-076), without React and without the API: the views
 * and tiles (Owner answer Q3: what is on hold is reached from here), held reasons said before the click, the sign and
 * release and reversal drafts, the four-eyes rule draft (Owner answer Q1), CSV. Message keys are the `quality`
 * catalogue's.
 */

// ---- the list's views and tiles ---------------------------------------------------------------------------------------------

/**
 * The list's views. W2a (B-W2a-67; Owner answer Q3): goods on hold left this page for Quality › Holds (SCR-078) — the W1
 * "On hold" view and tile are gone, an old address is sent there (`holdsAddressFor`); "Failed - not decided" and "Waiting
 * for me" (assigned to me) joined.
 */
export const VIEWS = ['all', 'open', 'mine', 'overdue', 'waiting', 'failed', 'reversed', 'lots'] as const
export type View = (typeof VIEWS)[number]
export type ViewKind = 'inspections' | 'releases' | 'lots'

export const viewKind = (view: View): ViewKind => (view === 'reversed' ? 'releases' : view === 'lots' ? 'lots' : 'inspections')

/**
 * The view an address asks for: `?view=`, else the API's own filters a link may carry (Today, LIST_PAGES):
 * `?onHold=true`, `?waitingRelease=true`, `?status=OPEN`, `?reversed=true`.
 */
export function viewFromAddress(params: { get(name: string): string | null } | null | undefined): View {
  const asked = params?.get('view')
  if (asked && (VIEWS as readonly string[]).includes(asked)) return asked as View
  if (params?.get('failedUndecided') === 'true') return 'failed'
  if (params?.get('assigned') === 'me') return 'mine'
  if (params?.get('overdue') === 'true') return 'overdue'
  if (params?.get('waitingRelease') === 'true') return 'waiting'
  if (params?.get('reversed') === 'true') return 'reversed'
  if (params?.get('status') === 'OPEN') return 'open'
  return 'all'
}

/**
 * W1's "On hold" address (`?view=onHold`, `?onHold=true`, Today's links): the held work orders now live on Quality › Holds
 * (Owner answer Q3: "until the Holds page exists"). The page sends such an address there.
 */
export function holdsAddressFor(params: { get(name: string): string | null } | null | undefined): string | null {
  return params?.get('view') === 'onHold' || params?.get('onHold') === 'true' ? '/quality/holds?subjectType=WorkOrder' : null
}

/** The tiles: each a named saved filter (pressing one shows its view; the count and the list agree). */
export const TILES = ['open', 'overdue', 'waiting', 'failed', 'reversed', 'lots'] as const satisfies readonly View[]
export type TileId = (typeof TILES)[number]

/** A tile's count: the rows its read gave, "at least" when the read was cut at its limit; null = it could not count. */
export interface TileCount {
  readonly count: number | null
  readonly capped: boolean
}

export const PAGE = 50
export const MAX = 200

/** The next page size of a list without a cursor ("Show more" reads a larger page, up to 200). */
export const nextLimit = (limit: number): number => Math.min(MAX, limit + PAGE)

// ---- words of a row -------------------------------------------------------------------------------------------------------------

/** Who signed, released or opened, in words: "you", "at the bench", "in the office" (no person's name in a list: W1 rule). */
export function whoKey(who: Who, me: string): { key: string; you: boolean } {
  if (who.kind === 'FLOOR') return { key: 'who.bench', you: false }
  return who.userId === me ? { key: 'who.you', you: true } : { key: 'who.office', you: false }
}

/** Who, inside a sentence: "by you", "at the bench", "in the office". */
export const whereKey = (who: Who, me: string): string => `whereSigned.${whoKey(who, me).key.split('.')[1]}`

/** An inspection's status in words (with the override and the hold), and its tone. */
export function statusOf(row: Pick<InspectionRow, 'status' | 'overridden' | 'onHold' | 'reversed'>): { key: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' } {
  if (row.status === 'OPEN') return { key: 'status.OPEN', tone: 'info' }
  if (row.status === 'CANCELLED') return { key: 'status.CANCELLED', tone: 'neutral' }
  if (row.status === 'FAILED') return { key: 'status.FAILED', tone: 'danger' }
  if (row.onHold && row.reversed > 0) return { key: 'status.REVERSED', tone: 'warning' }
  return { key: row.overridden ? 'status.PASSED_OVERRIDE' : 'status.PASSED', tone: 'success' }
}

/** Why its garments are on hold, in our words (the API's `holdWords` are English): null when they are not. */
export function holdOf(row: Pick<InspectionRow, 'status' | 'onHold' | 'reversed'>): { key: string; params?: Record<string, number> } | null {
  if (!row.onHold) return null
  if (row.status === 'FAILED') return { key: 'hold.failed' }
  return { key: 'hold.reversed', params: { count: row.reversed } }
}

/**
 * Who an inspection is assigned to, in words (W2a): you, an office user by name, "a bench inspector" for a worker in a
 * list (named only inside one inspection: Owner answer W1), or nobody.
 */
export function assignedWords(assigned: Assigned | null, me: string, inside = false): { key: string; params?: Record<string, string> } {
  if (!assigned) return { key: 'assign.nobody' }
  if (assigned.kind === 'USER') return assigned.userId === me ? { key: 'assign.you' } : assigned.name ? { key: 'assign.named', params: { name: assigned.name } } : { key: 'assign.office' }
  return inside && assigned.name ? { key: 'assign.benchNamed', params: { name: assigned.name } } : { key: 'assign.bench' }
}

/** The picker's value of an assignee (`USER:<id>`, `WORKER:<id>`, '' for nobody). */
export const assigneeValue = (assigned: Pick<Assigned, 'kind' | 'userId' | 'workerId'> | null): string =>
  !assigned ? '' : assigned.kind === 'USER' ? `USER:${assigned.userId ?? ''}` : `WORKER:${assigned.workerId ?? ''}`

/** A picker value as the assign body. */
export function assigneeBody(value: string): { assigneeId: string | null; assigneeWorkerId: string | null } {
  const [kind, id] = value.split(':')
  return { assigneeId: kind === 'USER' && id ? id : null, assigneeWorkerId: kind === 'WORKER' && id ? id : null }
}

/** Why a row cannot be assigned (it is decided or cancelled), or null. */
export const assignRowHeld = (row: Pick<InspectionRow, 'status'>): string | null => (row.status === 'OPEN' ? null : 'assign.held.notOpen')

/** Why "Assign N inspections" is held for these rows, or null: no right, a decided one, more than one site. */
export function assignHeld(rows: readonly Pick<InspectionRow, 'status' | 'siteId'>[], can: Pick<QualityCan, 'inspectionsRecord'>): string | null {
  if (!can.inspectionsRecord) return 'assign.held.noRight'
  if (rows.length === 0) return 'assign.held.none'
  if (rows.some((row) => row.status !== 'OPEN')) return 'assign.held.notOpen'
  if (new Set(rows.map((row) => row.siteId)).size > 1) return 'assign.held.sites'
  return null
}

/** The assign dialog's state (qi-assign): which inspections, the people of their site, the pick, what went wrong. */
export interface AssignState {
  readonly ids: readonly string[]
  readonly siteId: string
  readonly people: Read<Inspectors>
  readonly value: string
  readonly busy: boolean
  readonly problem: string | null
  readonly lines: readonly string[]
}

/** A person of the picker in words (a worker's name is shown inside the dialog: a picker, never a list). */
export const inspectorHeld = (person: Pick<InspectorPick, 'made'>): { key: string; params: Record<string, string> } | null =>
  person.made.length > 0 ? { key: 'assign.made', params: { orders: person.made.join(', ') } } : null

/** A release's name: its number, or "WO-0003 · release" for one made before the series existed. */
export const releaseLabel = (release: Pick<Release, 'releaseNumber' | 'number'>): { key: string; params: Record<string, string> } =>
  release.releaseNumber ? { key: 'release.number', params: { number: release.releaseNumber } } : { key: 'release.unnumbered', params: { workOrder: release.number } }

/** Garments of a release taken back, and of those still on hold. */
export const reversedOf = (release: Pick<Release, 'reversals'>): number => release.reversals.reduce((sum, reversal) => sum + reversal.quantity, 0)

/** The newest reversal of a release (its reason shows in the list). */
export function lastReversal(release: Pick<Release, 'reversals'>): Release['reversals'][number] | null {
  return [...release.reversals].sort((a, b) => b.reversedAt.localeCompare(a.reversedAt))[0] ?? null
}

// ---- the record: what this person may do, held reasons said before the click ---------------------------------------------------

export const RECORD_TABS = ['checks', 'defects', 'decision'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export interface ChecklistRow {
  readonly code: string
  readonly group: ChecklistGroup
  readonly ok: boolean | null
  readonly note: string | null
  /** Answered at all (passed, failed or not applicable); an answer of "not applicable" is `ok: null` AND answered. */
  readonly answered: boolean
}

/** The checklist of an inspection in the plan's order: every item, answered or not. */
export function checklistRows(inspection: Pick<Inspection, 'checklist'>): ChecklistRow[] {
  return CHECKLIST_ITEMS.map((item) => {
    const answer = inspection.checklist.find((entry) => entry.code === item.code)
    return { code: item.code, group: item.group, ok: answer?.ok ?? null, note: answer?.note ?? null, answered: answer !== undefined }
  })
}

export const checklistGroups = (rows: readonly ChecklistRow[]): { group: ChecklistGroup; rows: ChecklistRow[] }[] =>
  CHECKLIST_GROUPS.map((group) => ({ group, rows: rows.filter((row) => row.group === group) }))

/** "11 of 12 checked · 1 failed". */
export function checklistCounts(rows: readonly ChecklistRow[]): { answered: number; total: number; failed: number } {
  return { answered: rows.filter((row) => row.answered).length, total: rows.length, failed: rows.filter((row) => row.answered && row.ok === false).length }
}

/** The answers to send: every answered row (a failed one with its note). */
export const checklistBody = (rows: readonly ChecklistRow[]) => rows.filter((row) => row.answered).map((row) => ({ code: row.code, ok: row.ok, note: row.note }))

/** One answer changed (Pass, Fail, Not applicable, or its note): the whole row set with it. */
export function answer(rows: readonly ChecklistRow[], code: string, change: { ok?: boolean | null; note?: string | null }): ChecklistRow[] {
  return rows.map((row) => (row.code === code ? { ...row, answered: true, ok: change.ok !== undefined ? change.ok : row.ok, note: change.note !== undefined ? change.note : row.note } : row))
}

/** A failed check says what is wrong: the rows whose note is missing. */
export const failedWithoutNote = (rows: readonly ChecklistRow[]): string[] => rows.filter((row) => row.answered && row.ok === false && !(row.note ?? '').trim()).map((row) => row.code)

/** What the rules compute now (the domain's own rule), and whether only the acceptance numbers made it fail. */
export function resultNow(inspection: Pick<Inspection, 'counts' | 'plan' | 'checklist'>) {
  return computedResult({ counts: inspection.counts, plan: inspection.plan, checklist: inspection.checklist })
}

export interface RecordAbilities {
  /** Record the plan, checklist and defects (null) or why not. */
  readonly recordHeld: string | null
  /** Sign the result (null) or why not. */
  readonly signHeld: string | null
  /** Cancel the inspection (null) or why not. */
  readonly cancelHeld: string | null
}

/** What the viewer may do on the record, each with its reason when held (never a silent grey button). */
export function recordAbilities(read: Pick<InspectionRead, 'inspection' | 'maker' | 'yours'>, can: Pick<QualityCan, 'inspectionsRecord'>): RecordAbilities {
  const inspection = read.inspection
  const base = !can.inspectionsRecord
    ? 'held.noRecord'
    : inspection.status !== 'OPEN'
      ? inspection.status === 'CANCELLED'
        ? 'held.cancelled'
        : 'held.decided'
      : !read.yours
        ? inspection.assigned
          ? 'held.assignedOther'
          : 'held.notYours'
        : null
  const counts = checklistCounts(checklistRows(inspection))
  const signHeld = base ?? (read.maker.made ? 'held.maker' : counts.answered < counts.total ? 'held.unanswered' : null)
  return { recordHeld: base, signHeld, cancelHeld: base }
}

/** The sign dialog's draft: the decision (the computed result unless overridden), the override's reason, the statement. */
export interface SignDraft {
  readonly result: InspectionResult
  readonly overrideReason: string
  readonly statement: boolean
  readonly note: string
}

export const signDraftOf = (inspection: Pick<Inspection, 'counts' | 'plan' | 'checklist' | 'notMakerStatement'>): SignDraft => ({
  result: resultNow(inspection).result,
  overrideReason: '',
  statement: inspection.notMakerStatement,
  note: '',
})

/** The sign dialog's problems, every one at once (message keys). */
export function signProblems(draft: SignDraft, inspection: Pick<Inspection, 'counts' | 'plan' | 'checklist'>, statementNeeded: boolean): string[] {
  const computed = resultNow(inspection)
  const problems: string[] = []
  if (draft.result !== computed.result) {
    if (draft.result === 'PASS' && !computed.byCountsOnly) problems.push('sign.problem.passOverHard')
    else if (draft.overrideReason.trim().length < 3) problems.push('sign.problem.reason')
  }
  if (statementNeeded && !draft.statement) problems.push('sign.problem.statement')
  return problems
}

// ---- release per cell -----------------------------------------------------------------------------------------------------------

/** The check names the release gate uses, in our words (the API's sentences are data). */
export const GATE_CODES: readonly ReleaseCheckCode[] = ['WORK_ORDER', 'INSPECTION', 'QUANTITY', 'SERIALS', 'LABELS', 'CERTIFICATE', 'DOCUMENTS', 'LOTS', 'MAKER', 'SECOND_PERSON']

/** A cell's release, said before the click: the first open check (its code), or nothing to release, or no right. */
export function releaseHeld(cell: Pick<FinalCell, 'releasable' | 'checks'>, can: Pick<QualityCan, 'garmentsRelease'>): { key: string; params?: Record<string, string | number> } | null {
  if (!can.garmentsRelease) return { key: 'held.noRelease' }
  const open = cell.checks.filter((check) => check.state === 'OPEN' && check.code !== 'QUANTITY')
  if (cell.releasable === 0) return { key: 'held.nothingToRelease' }
  if (open.length > 0) return { key: 'held.gateOpen', params: { count: open.length, check: open[0]!.code } }
  return null
}

/** The release dialog's draft. */
export interface ReleaseDraft {
  readonly quantity: string
  readonly serialIds: readonly string[]
  readonly note: string
}

export const releaseDraftOf = (cell: Pick<FinalCell, 'releasable' | 'readySerials'>): ReleaseDraft => ({
  quantity: String(cell.releasable),
  serialIds: cell.readySerials.slice(0, cell.releasable).map((serial) => serial.id),
  note: '',
})

/** Whether the style traces each garment by serial (the cell has serials ready, or the gate names serials). */
export const isSerialCell = (cell: Pick<FinalCell, 'readySerials' | 'checks'>): boolean =>
  cell.readySerials.length > 0 || cell.checks.some((check) => check.code === 'SERIALS' && check.state !== 'NOT_NEEDED')

/** The release dialog's problems (message keys): a whole number from 1 up to what the cell may release; serials one each. */
export function releaseProblems(draft: ReleaseDraft, cell: Pick<FinalCell, 'releasable' | 'readySerials' | 'checks'>): string[] {
  const problems: string[] = []
  const quantity = Number(draft.quantity)
  if (!/^\d+$/.test(draft.quantity.trim()) || quantity < 1) problems.push('release.problem.quantity')
  else if (quantity > cell.releasable) problems.push('release.problem.tooMany')
  if (isSerialCell(cell) && draft.serialIds.length !== quantity) problems.push('release.problem.serials')
  return problems
}

/** Why a release needs a second person, in our words by its code. */
export const secondPersonKeys = (reasons: readonly SecondPersonReason[]): string[] => reasons.map((reason) => `secondPerson.${reason}`)

// ---- the reversal --------------------------------------------------------------------------------------------------------------

export interface ReverseDraft {
  readonly quantity: string
  readonly serialIds: readonly string[]
  readonly serialsTo: 'MADE' | 'VOID' | null
  readonly reasonCode: 'WRONG_RESULT' | 'DEFECT_FOUND_LATER' | 'CERTIFICATE_PROBLEM' | 'CUSTOMER_COMPLAINT' | 'RECALL' | null
  readonly reason: string
}

export const REVERSE_DRAFT: ReverseDraft = Object.freeze({ quantity: '', serialIds: [], serialsTo: null, reasonCode: null, reason: '' })

/** The serials of a release that can be taken back: still released, not packed. */
export const reversibleSerials = (release: Pick<Release, 'serials'>) => release.serials.filter((serial) => serial.status === 'RELEASED' && !serial.packed)

/** A serial-tracked release (its serials are named). */
export const isSerialRelease = (release: Pick<Release, 'serials'>): boolean => release.serials.length > 0

/** What a reversal does now, in our words from the API's numbers (the API's `words` are English). */
export function impactLines(impact: ReverseImpact): { key: string; params: Record<string, number> }[] {
  const lines = [{ key: 'reverse.impact.house', params: { count: impact.reversible } }]
  if (impact.onDraft + impact.packed > 0) lines.push({ key: 'reverse.impact.onShipment', params: { count: impact.onDraft + impact.packed } })
  if (impact.shipped > 0) lines.push({ key: 'reverse.impact.shipped', params: { count: impact.shipped } })
  return lines
}

/** Taking back is held before the click: no right, or nothing of the release can be taken back now. */
export function reverseHeld(detail: Pick<ReleaseDetail, 'reverseImpact'> | null, can: Pick<QualityCan, 'garmentsReverse'>): string | null {
  if (!can.garmentsReverse) return 'held.noReverse'
  if (detail && detail.reverseImpact.reversible === 0) return 'held.nothingToReverse'
  return null
}

/** The reversal dialog's problems (message keys), every one at once. */
export function reverseProblems(draft: ReverseDraft, detail: Pick<ReleaseDetail, 'release' | 'reverseImpact'>): string[] {
  const problems: string[] = []
  const serial = isSerialRelease(detail.release)
  const quantity = serial ? draft.serialIds.length : Number(draft.quantity)
  if (serial ? draft.serialIds.length === 0 : !/^\d+$/.test(draft.quantity.trim()) || quantity < 1) problems.push('reverse.problem.quantity')
  else if (quantity > detail.reverseImpact.reversible) problems.push('reverse.problem.tooMany')
  if (serial && !draft.serialsTo) problems.push('reverse.problem.serialsTo')
  if (!draft.reasonCode) problems.push('reverse.problem.reasonCode')
  if (draft.reason.trim().length < 3) problems.push('reverse.problem.reason')
  return problems
}

// ---- the four-eyes rule (Owner answer Q1) -------------------------------------------------------------------------------------

export interface RuleDraft {
  /** null: follow the rule set for every company (or the default). */
  readonly rule: FourEyesRule | null
  readonly customers: readonly { id: string; code: string; name: string; listedOn: 'COMPANY' | 'TENANT' }[]
  readonly reason: string
}

export const ruleDraftOf = (rule: ReleaseRule): RuleDraft => ({ rule: rule.own?.releaseFourEyes ?? null, customers: rule.customers, reason: '' })

/** The company's own list (the tenant-wide customers stay listed: they are not edited here). */
export const ownCustomerIds = (draft: Pick<RuleDraft, 'customers'>): string[] => draft.customers.filter((customer) => customer.listedOn === 'COMPANY').map((customer) => customer.id)

/** Whether the draft loosens the rule (the domain's rule: ALWAYS given up, or a listed customer taken off). */
export function ruleLoosens(rule: ReleaseRule, draft: RuleDraft): boolean {
  const before = { releaseFourEyes: rule.own?.releaseFourEyes ?? null, secondPersonPartyIds: rule.customers.filter((customer) => customer.listedOn === 'COMPANY').map((customer) => customer.id) }
  const after = { releaseFourEyes: draft.rule, secondPersonPartyIds: ownCustomerIds(draft) }
  // "Follow every company" while every company's rule is ALWAYS does not loosen; the domain compares rows, so do too.
  if (before.releaseFourEyes === null && after.releaseFourEyes === null) return isFourEyesLoosening({ ...before, releaseFourEyes: null }, after)
  return isFourEyesLoosening(before, after)
}

export const ruleChanged = (rule: ReleaseRule, draft: RuleDraft): boolean => {
  const before = rule.customers.filter((customer) => customer.listedOn === 'COMPANY').map((customer) => customer.id).sort().join(',')
  return (rule.own?.releaseFourEyes ?? null) !== draft.rule || before !== ownCustomerIds(draft).sort().join(',')
}

/** The rule dialog's problems: a looser rule needs the reason (the code is asked by the API after). */
export function ruleProblems(rule: ReleaseRule, draft: RuleDraft): string[] {
  if (!ruleChanged(rule, draft)) return ['rules.problem.nothing']
  return ruleLoosens(rule, draft) && draft.reason.trim().length < 3 ? ['rules.problem.reason'] : []
}

/** A party's name as the rule lists it. */
export const partyName = (party: PartyPick): string => party.tradeName ?? party.legalName

// ---- New inspection ---------------------------------------------------------------------------------------------------------------

/** New inspection's kind (design qi-new RadioCard): incoming lot, final, in-line (W2b), return (W2a). */
export const NEW_KINDS = ['LOT', 'FINAL', 'INLINE', 'RETURN'] as const
export type NewKind = (typeof NEW_KINDS)[number]

/** Why a kind is held here, or null: in-line inspections come with W2b; a return needs the right to inspect returns. */
export function kindHeld(kind: NewKind, can: Pick<QualityCan, 'inspectionsRecord' | 'workOrdersView' | 'returnsView' | 'returnsInspect' | 'lotsView'>): string | null {
  if (kind === 'INLINE') return 'new.kind.held.inline'
  if (kind === 'RETURN') return !can.returnsView || !can.returnsInspect ? 'new.kind.held.return' : null
  if (kind === 'LOT') return !can.lotsView ? 'new.kind.held.lot' : null
  return !can.inspectionsRecord ? 'held.noRecord' : !can.workOrdersView ? 'held.noWorkOrders' : null
}

/** The Return kind's grades per line (design qi-new "Return"; B-W2a-43's grading: grade, cause, the condition). */
export interface ReturnDraft {
  readonly returnId: string | null
  readonly lines: Readonly<Record<string, { readonly grade: string; readonly cause: string; readonly note: string }>>
}
export const RETURN_DRAFT: ReturnDraft = Object.freeze({ returnId: null, lines: {} })

/** The grading's problems (message keys): every received line graded. */
export function returnProblems(draft: ReturnDraft, record: Pick<ReturnRecord, 'lines'> | null): string[] {
  if (!draft.returnId) return ['new.return.problem.pick']
  if (!record) return ['new.return.problem.reading']
  const received = record.lines.filter((line) => line.receivedQuantity > 0)
  if (received.length === 0) return ['new.return.problem.nothingReceived']
  if (received.some((line) => !draft.lines[line.id]?.grade)) return ['new.return.problem.grade']
  if (received.some((line) => (draft.lines[line.id]?.note.length ?? 0) > 1000)) return ['new.return.problem.note']
  return []
}

/** The grading body: every received line with its grade (cause and note when given). */
export const returnBody = (draft: ReturnDraft, record: Pick<ReturnRecord, 'lines' | 'version'>) => ({
  version: record.version,
  lines: record.lines
    .filter((line) => line.receivedQuantity > 0 && draft.lines[line.id]?.grade)
    .map((line) => ({
      lineId: line.id,
      grade: draft.lines[line.id]!.grade as ReturnRecord['lines'][number]['grade'] & string,
      cause: (draft.lines[line.id]!.cause || null) as ReturnRecord['lines'][number]['cause'],
      conditionNote: draft.lines[line.id]!.note.trim() || null,
    })),
})

export interface NewDraft {
  readonly kind: NewKind
  /** B-W2b-17: by when it is due (an ISO instant, '' for none; the office only). */
  readonly dueAt: string
  /** The inspector it is assigned to at once ('' nobody; `USER:<id>` / `WORKER:<id>`). */
  readonly assignee: string
  readonly workOrderId: string | null
  readonly lotSize: string
  readonly sampleSize: string
  readonly inspectionLevel: string
  readonly aqlMajor: string
  readonly aqlMinor: string
  readonly acceptMajor: string
  readonly acceptMinor: string
  readonly note: string
}

export const NEW_DRAFT: NewDraft = Object.freeze({ kind: 'FINAL', dueAt: '', assignee: '', workOrderId: null, lotSize: '', sampleSize: '', inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: '', acceptMinor: '', note: '' })

/** The finished garments of a work order (good at the final operation): null while unknown. */
export function finishedOf(workOrder: Pick<WorkOrderCells, 'cells'> | null): number | null {
  if (!workOrder) return null
  if (workOrder.cells.some((cell) => cell.progress.finished === null)) return null
  return workOrder.cells.reduce((sum, cell) => sum + (cell.progress.finished ?? 0), 0)
}

const whole = (text: string, min: number) => /^\d+$/.test(text.trim()) && Number(text) >= min

/** New inspection's problems (message keys), every one at once; the API checks the same again. */
export function newProblems(draft: NewDraft, finished: number | null, now: Date = new Date()): string[] {
  const problems: string[] = []
  if (!draft.workOrderId) return ['new.problem.workOrder']
  const due = dueProblemKey(draft.dueAt || null, now)
  if (due) problems.push(due)
  if (finished === 0) problems.push('new.problem.nothingFinished')
  if (!whole(draft.lotSize, 1)) problems.push('new.problem.lotSize')
  else if (finished !== null && Number(draft.lotSize) > finished) problems.push('new.problem.lotOverFinished')
  if (!whole(draft.sampleSize, 1)) problems.push('new.problem.sampleSize')
  else if (whole(draft.lotSize, 1) && Number(draft.sampleSize) > Number(draft.lotSize)) problems.push('new.problem.sampleOverLot')
  for (const value of [draft.acceptMajor, draft.acceptMinor]) {
    if (!whole(value, 0)) {
      problems.push('new.problem.accept')
      break
    }
  }
  if (![draft.aqlMajor, draft.aqlMinor].every((value) => /^\d{1,3}([.,]\d{1,3})?$/.test(value.trim()))) problems.push('new.problem.aql')
  if (!draft.inspectionLevel.trim()) problems.push('new.problem.level')
  return [...new Set(problems)]
}

/** A work order as the picker names it. */
export const workOrderWords = (workOrder: Pick<WorkOrderPick, 'number' | 'styleCode' | 'styleName'>): string => `${workOrder.number} · ${workOrder.styleCode} ${workOrder.styleName}`

// ---- the models the views draw ---------------------------------------------------------------------------------------------------

export interface InspectionsListModel {
  readonly prefix: string
  readonly me: string
  /** The company the page works in (the rule dialog names it). */
  readonly companyName: string
  readonly can: QualityCan
  readonly view: View
  readonly rows: Read<readonly InspectionRow[]>
  readonly releases: Read<readonly Release[]>
  readonly lots: Read<readonly Lot[]>
  /** The page size read (no cursor: Show more reads a larger page). */
  readonly limit: number
  readonly tiles: Partial<Record<TileId, TileCount>>
  readonly rule: Read<ReleaseRule>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly selected: readonly string[]
  readonly notice?: Notice | null
  /** `?open=<release id>`: the release in its DetailModal. */
  readonly open?: { readonly id: string; readonly detail: Read<ReleaseDetail>; readonly tab?: 'release' | 'gate' | 'reversal' } | null
  readonly dialog?: ListDialog | null
  readonly busy?: boolean
  readonly dialogProblem?: string | null
  readonly dialogLines?: readonly string[]
  readonly reverseAnswer?: ReverseAnswerWords | null
  /** New inspection: the work orders to pick from and the picked one's cells. */
  readonly pick?: { readonly workOrders: Read<readonly WorkOrderPick[]>; readonly cells: Read<WorkOrderCells> | null }
  readonly newDraft?: NewDraft
  readonly ruleDraft?: RuleDraft
  readonly customerSearch?: Read<readonly PartyPick[]> | null
  readonly reverseDraft?: ReverseDraft
  /** W2a: Assign inspector (qi-assign) for the rows it names. */
  readonly assign?: AssignState | null
  /** W2a: the inline Inspector cell's people per site (read when a cell is first focused) and each row's save mark. */
  readonly people?: Readonly<Record<string, Read<Inspectors>>>
  readonly marks?: Readonly<Record<string, CellMark>>
  /** W2a: New inspection's Return kind — the returns waiting, the picked one, its grades. */
  readonly returns?: Read<readonly ReturnPick[]> | null
  readonly returnRecord?: Read<ReturnRecord> | null
  readonly returnDraft?: ReturnDraft
  /** New inspection's inspector picker (the work order's site). */
  readonly newPeople?: Read<Inspectors> | null
  /** B-W2b-17: Set due date for the rows it names (the bulk action). */
  readonly due?: DueState | null
  /** Design cases: the focused row, the keys panel open. */
  readonly focusRow?: number
}

export type ListDialog = { kind: 'new' } | { kind: 'rules' } | { kind: 'reverse'; releaseId: string } | { kind: 'shortcuts' }

/** A cell's save mark (CellSaveMark: saving, saved, unknown) or a refusal with its words. */
export type CellMark = { readonly state: 'saving' | 'saved' | 'unknown' } | { readonly state: 'refused'; readonly problem: string; readonly lines?: readonly string[] }

/** A reversal's receipt: what it did and what the PPE register did, in our words with the API's facts. */
export interface ReverseAnswerWords {
  readonly quantity: number
  readonly register: { readonly opened: boolean; readonly entryId: string | null; readonly reference: string | null; readonly words: string }
}

export interface InspectionRecordModel {
  readonly prefix: string
  readonly me: string
  readonly can: QualityCan
  readonly tab: RecordTab
  readonly read: InspectionRead
  /** The checklist as edited here (answers save per row). */
  readonly checklist: readonly ChecklistRow[]
  /** Rows saving now / saved / failed (CellSaveMark words). */
  readonly saving?: Readonly<Record<string, 'saving' | 'saved' | 'failed'>>
  readonly final: Read<FinalState>
  readonly releases: Read<readonly Release[]>
  readonly style: Read<{ code: string; name: string }> | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly notice?: Notice | null
  readonly dialog?: RecordDialog | null
  readonly busy?: boolean
  readonly dialogProblem?: string | null
  readonly dialogLines?: readonly string[]
  readonly signDraft?: SignDraft
  readonly releaseDraft?: ReleaseDraft
  readonly planDraft?: PlanDraft
  readonly cancelReason?: string
  /** A changed record while a dialog holds unsaved work: "changed at 10:42 · Reload". */
  readonly stale?: string | null
  /** W2a Defects & photos: the defects as shown (saved after each change), the save state, the library, the photos. */
  readonly defects?: DefectsTabModel
  /** W2a: Assign inspector from the record's band. */
  readonly assign?: AssignState | null
}

/** The Defects & photos tab (design ins-defects): the lines, their save state, the library picker, the photos, the picks for an NCR. */
export interface DefectsTabModel {
  readonly lines: readonly DefectBody[]
  readonly saving: 'idle' | 'saving' | 'saved' | 'failed'
  readonly problem?: string | null
  readonly lines_refused?: readonly string[]
  readonly library: Read<readonly PickedDefect[]>
  readonly photos: Read<readonly InspectionPhoto[]>
  /** A photo's address once read (presigned, short-lived). */
  readonly photoSrc: Readonly<Record<string, string>>
  /** A photo being uploaded for this line's code. */
  readonly uploading?: string | null
  /** B-W2b-17: the lines picked for "Create NCR from N defects" (their keys, `<class>|<code>`). */
  readonly selected?: readonly string[]
}

export type RecordDialog =
  | { kind: 'sign' }
  | { kind: 'release'; workOrderSizeId: string }
  | { kind: 'plan' }
  | { kind: 'cancel' }
  | { kind: 'shortcuts' }
  // W2a: add a defect from the library; place a line on the garment; take its photo with markup.
  | { kind: 'pick' }
  | { kind: 'zone'; index: number }
  | { kind: 'photo'; index: number }

export interface PlanDraft {
  readonly lotSize: string
  readonly sampleSize: string
  readonly inspectionLevel: string
  readonly aqlMajor: string
  readonly aqlMinor: string
  readonly acceptMajor: string
  readonly acceptMinor: string
}

export const planDraftOf = (inspection: Pick<Inspection, 'plan'>): PlanDraft => ({
  lotSize: String(inspection.plan.lotSize),
  sampleSize: String(inspection.plan.sampleSize),
  inspectionLevel: inspection.plan.inspectionLevel,
  aqlMajor: inspection.plan.aqlMajor,
  aqlMinor: inspection.plan.aqlMinor,
  acceptMajor: String(inspection.plan.acceptMajor),
  acceptMinor: String(inspection.plan.acceptMinor),
})

/** The plan dialog's problems (the same rules as New inspection, without the work order). */
export const planProblems = (draft: PlanDraft): string[] => newProblems({ ...NEW_DRAFT, ...draft, workOrderId: 'x' }, null)

export const planBody = (draft: PlanDraft) => ({
  lotSize: Number(draft.lotSize),
  sampleSize: Number(draft.sampleSize),
  inspectionLevel: draft.inspectionLevel.trim(),
  aqlMajor: draft.aqlMajor.trim().replace(',', '.'),
  aqlMinor: draft.aqlMinor.trim().replace(',', '.'),
  acceptMajor: Number(draft.acceptMajor),
  acceptMinor: Number(draft.acceptMinor),
})

// ---- Defects & photos (W2a, B-W2a-67; design ins-defects): the list saved whole (PUT), one change at a time ----------------

/** The defects as the API takes them back (the list is saved whole: one line per class and code). */
export const defectLinesOf = (inspection: Pick<Inspection, 'defects'>): DefectBody[] =>
  inspection.defects.map((defect) => ({
    defectClass: defect.defectClass,
    code: defect.code,
    quantity: defect.quantity,
    workOrderSizeId: defect.workOrderSizeId,
    note: defect.note,
    defectCodeId: defect.defectCodeId,
    zone: defect.zone,
  }))

/** A defect picked from the library: a new line with its default class and zone, or one more garment on its line. */
export function withPicked(lines: readonly DefectBody[], picked: Pick<PickedDefect, 'id' | 'code' | 'severity' | 'zone'>): DefectBody[] {
  const at = lines.findIndex((line) => line.code === picked.code && line.defectClass === picked.severity)
  if (at >= 0) return lines.map((line, index) => (index === at ? { ...line, quantity: line.quantity + 1 } : line))
  return [...lines, { defectClass: picked.severity, code: picked.code, quantity: 1, workOrderSizeId: null, note: null, defectCodeId: picked.id, zone: picked.zone }]
}

/** One line changed (class, garments, zone, cell, note). */
export const changedLine = (lines: readonly DefectBody[], index: number, change: Partial<DefectBody>): DefectBody[] => lines.map((line, at) => (at === index ? { ...line, ...change } : line))

export const withoutLine = (lines: readonly DefectBody[], index: number): DefectBody[] => lines.filter((_, at) => at !== index)

/** The list's problems before it is sent (message keys of `quality`), every one at once; the API checks the same again. */
export function defectLineProblems(lines: readonly DefectBody[], sampleSize: number): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const perClass = new Map<string, number>()
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) problems.push('defects.problem.quantity')
    else if (line.quantity > sampleSize) problems.push('defects.problem.overSample')
    const key = `${line.defectClass}|${line.code}`
    if (seen.has(key)) problems.push('defects.problem.twice')
    seen.add(key)
    perClass.set(line.defectClass, (perClass.get(line.defectClass) ?? 0) + Math.max(0, line.quantity))
  }
  if ([...perClass.values()].some((count) => count > sampleSize)) problems.push('defects.problem.classOverSample')
  return [...new Set(problems)]
}

/** The photos of a line (files named after its code). */
export const photosOf = (photos: readonly InspectionPhoto[], code: string): InspectionPhoto[] => photos.filter((photo) => photo.name.startsWith(`defect-${code}-`))

/** The library's word for a code in the person's language (else the code). */
export function defectWords(code: string, library: readonly Pick<PickedDefect, 'code' | 'labelIt' | 'labelEn'>[] | null, locale: string): string | null {
  const found = library?.find((entry) => entry.code === code)
  if (!found) return null
  return locale.startsWith('it') ? found.labelIt : found.labelEn
}

/** What the viewer may do with the defects: record (null) or why not (the record's own reason). */
export const defectsHeld = (abilities: Pick<RecordAbilities, 'recordHeld'>): string | null => abilities.recordHeld

// ---- CSV ------------------------------------------------------------------------------------------------------------------------------

export const INSPECTION_CSV_HEAD = ['csv.inspection', 'csv.workOrder', 'csv.status', 'csv.due', 'csv.lot', 'csv.sample', 'csv.released', 'csv.reversed', 'csv.toRelease', 'csv.onHold', 'csv.decidedAt'] as const

export function inspectionCsvRow(row: InspectionRow, t: (key: string, params?: Record<string, string | number>) => string): (string | number)[] {
  return [row.label, row.number, t(statusOf(row).key), row.dueAt ?? '', row.lotSize, row.sampleSize, row.released, row.reversed, row.toRelease, row.onHold ? t('csv.yes') : t('csv.no'), row.decidedAt ?? '']
}

// ---- live --------------------------------------------------------------------------------------------------------------------------

/** The live events that change these lists (B-W1-34, B-W1-45 events). */
export const LIST_EVENTS = ['quality.inspection_', 'quality.garments_released', 'quality.release_reversed', 'quality.release_rule_changed', 'lot.'] as const

// ---- B-W2b-17: by when an inspection is due (design qi-grid inline "Due"; Inspection.dueAt) ----------------------------

/** How far ahead a due time may be set (the API's INSPECTION_DUE_MAX_DAYS). */
export const DUE_MAX_DAYS = 366
/** The most inspections one "Set due date" names (the API's limit). */
export const DUE_LIMIT = 50

/** A due time's problem before it is sent (a `quality` key), or null: later than now and at most a year ahead. */
export function dueProblemKey(dueAt: string | null, now: Date): string | null {
  if (!dueAt) return null
  const at = new Date(dueAt).getTime()
  if (Number.isNaN(at)) return 'due.problem.invalid'
  if (at <= now.getTime()) return 'due.problem.past'
  if (at > now.getTime() + DUE_MAX_DAYS * 86_400_000) return 'due.problem.far'
  return null
}

const pad2 = (value: number) => String(value).padStart(2, '0')

/** An ISO instant as a `datetime-local` value in the reader's time ("2026-10-31T16:00"); '' for none. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/** A `datetime-local` value back as an ISO instant; null for '' (cleared) or an unreadable value. */
export function fromLocalInput(value: string): string | null {
  if (!value.trim()) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** Why the Due of one row cannot be changed here (a `quality` key), or null: the right, and an open inspection. */
export function dueRowHeld(row: Pick<InspectionRow, 'status'>, can: Pick<QualityCan, 'inspectionsRecord'>): string | null {
  if (!can.inspectionsRecord) return 'due.held.noRight'
  return row.status === 'OPEN' ? null : 'due.held.notOpen'
}

/** Why "Set due date N" is held for these rows (a `quality` key), or null. */
export function dueBulkHeld(rows: readonly Pick<InspectionRow, 'status'>[], can: Pick<QualityCan, 'inspectionsRecord'>): string | null {
  if (!can.inspectionsRecord) return 'due.held.noRight'
  if (rows.length === 0) return 'due.held.none'
  if (rows.length > DUE_LIMIT) return 'due.held.tooMany'
  if (rows.some((row) => row.status !== 'OPEN')) return 'due.held.notOpenSome'
  return null
}

/** The due time in words with its tone: none, due (when), overdue (when; danger, said in words, never colour only). */
export function dueState(item: Pick<InspectionRow, 'dueAt' | 'overdue' | 'status'>): { key: string; tone: 'neutral' | 'info' | 'danger' } {
  if (!item.dueAt) return { key: 'due.none', tone: 'neutral' }
  if (item.status === 'OPEN' && item.overdue) return { key: 'due.overdue', tone: 'danger' }
  return { key: 'due.at', tone: 'info' }
}

/** The Set due date dialog's state: which inspections, the time picked (ISO, '' to clear), what went wrong. */
export interface DueState {
  readonly ids: readonly string[]
  readonly value: string
  readonly busy: boolean
  readonly problem: string | null
  readonly lines: readonly string[]
}

/** The dialog's held reason (a `quality` key), or null. */
export function dueDialogHeld(state: Pick<DueState, 'value' | 'busy'>, now: Date): string | null {
  if (state.busy) return 'common.working'
  return dueProblemKey(state.value || null, now)
}

// ---- B-W2b-17: "Create NCR from N defects" (design ins-defects; the NCR prefill reads the picked lines) ------------------

/** A defect line's key in the list (one line per class and code). */
export const defectKey = (line: Pick<DefectBody, 'defectClass' | 'code'>): string => `${line.defectClass}|${line.code}`

/** The saved lines' ids by key: what the NCR is raised from (a line not saved yet has none). */
export const savedDefectIds = (inspection: Pick<Inspection, 'defects'>): Readonly<Record<string, string>> =>
  Object.fromEntries(inspection.defects.map((defect) => [defectKey(defect), defect.id]))

/** The picked lines' saved ids, in the list's order. */
export const pickedDefectIds = (picked: readonly string[], saved: Readonly<Record<string, string>>): string[] => picked.flatMap((key) => (saved[key] ? [saved[key]!] : []))

/** Why "Create NCR from N defects" is held (a `quality` key), or null. */
export function ncrFromDefectsHeld(picked: readonly string[], saved: Readonly<Record<string, string>>, canRaise: boolean): string | null {
  if (!canRaise) return 'raiseNcr.held.noRight'
  if (picked.length === 0) return 'defects.ncr.held.none'
  if (pickedDefectIds(picked, saved).length !== picked.length) return 'defects.ncr.held.unsaved'
  return null
}

/** New NCR's address with the picked lines (B-W2a-68's New NCR + `&defects=`): `newNcrAddress(…)` + the ids. */
export const ncrFromDefectsAddress = (base: string, ids: readonly string[]): string => (ids.length > 0 ? `${base}${base.includes('?') ? '&' : '?'}defects=${ids.map(encodeURIComponent).join(',')}` : base)
