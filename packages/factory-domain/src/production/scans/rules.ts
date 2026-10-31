import type { WorkCentreKind } from '../../product/routing/operations'
import { NO_DPIA_NOTE, NO_WORKER_NOTICE_NOTE, type FloorReadiness } from '../../privacy/readiness'
import { scannedBundleRefusal } from '../bundles/rules'
import { CUTTABLE_STATUSES } from '../cutting/rules'
import type { ScanSubject } from '../settings/monitoring'
import type { WorkOrderStatus } from '../work-orders/machine'
import type { DefectKind, ScanReason } from './reasons'

/**
 * Operation scans on the floor (B-W1-42; MES-069, MES-090, MES-095, MES-096, MES-308; PLAN §4.7 stage 12-scans; A2
 * SCR-090; design floor.operation, floor.sync), pure. The API (apps/factory-api modules/production/scans) reads the
 * facts inside its command, under the work order's scan lock (shared), the bundle's row lock (FOR SHARE: a void waits)
 * and the bundle's scan lock (one scan write per bundle at a time), and writes the OperationScan rows; the
 * …_production_guards scan trigger stays the last word (counts from 1 to the bundle, one standing report per bundle and
 * operation, an undo or correction of the same bundle, operation, worker and station, the subject rule).
 *
 *   operations  the work order's FROZEN operations (B-W1-38), in routing order. A bundle is reported at each operation
 *               whose `scanRequired` is set; an operation without it may be reported too, but no count waits for it.
 *               The final operation is the last scanned one (product/routing finalStepOf, B-W1-14): its good garments
 *               are "finished". "Sewn" is the last scanned operation whose work centre does sewing work (SEWING or
 *               ASSEMBLY): its good garments are sewn; a routing without one counts no sewn garments (null).
 *   report      one REPORT per bundle and operation (MES-069): good + scrap + rework from 1 up to what the previous
 *               scanned operation PASSED for that bundle (its standing report's good; the bundle's garments at the
 *               first one), so a bundle is never counted twice and scrap never comes out of nowhere. The previous
 *               operation must have passed the bundle first (strict order through the scanned operations in W1;
 *               MES-025's warn/free per site is W2b). The operation must be one of the bundle's work order; a station
 *               reports the operations of its work centre's kind, any other only with a reason (kept on the row).
 *               Scrap and rework count one garment per reason tap (reason-first counting); good is what is left.
 *   undo        the reporter's own last scan on this device, until the next scan on it or UNDO_WINDOW_MS after the
 *               report (measured on the device's clock when both times are known: an offline queue sends both late),
 *               and only while no later operation took the bundle (MES-095). An UNDO row voids the report, which stays.
 *   correction  an older own report is corrected by asking (MES-096): the asked counts follow the same caps, and the
 *               good may not fall below what the next scanned operation already took; a lead or the office decides,
 *               never the person who took or asked it (four eyes; c.c. art. 2101: the original stays, a CORRECTION row
 *               voids it).
 *   own         "own" is the site's floor subject (B-W1-37): at a WORKER site the signed-in worker's scans, at a STATION
 *               site the device's station's (no worker is recorded there).
 *   refusals    every refusal has a stable code, its words, ONE fix in words and whether it is final (a queued scan
 *               refused for a reason that may pass by itself, like an earlier operation still in another tablet's
 *               queue, is sent again; a final one waits for a person's discard). The words never name another worker:
 *               "another person" (Statuto dei Lavoratori art. 4; design floor.operation "Already reported").
 */

/** A report stays undoable on the floor for this long, or until the next scan on the device (design floor.operation; MES-095; a site setting is W2b, MES-294). */
export const UNDO_WINDOW_MS = 2 * 60_000
/** A device clock this far from the server's is shown as off (PLT-240: "This tablet's clock is 7 minutes off. Tell the office."). */
export const CLOCK_WARN_MS = 5 * 60_000
/** A device clock this far from the server's is flagged on its scans' answers (OperationScan.deviceTime: more than 24 h). */
export const CLOCK_FLAG_MS = 24 * 3_600_000
/** The most queued scans one batch sends (a longer queue goes in several batches, in order). */
export const MAX_BATCH_ITEMS = 200
/** The work centre kinds whose operations sew the garment: the last scanned one of them counts the sewn garments. */
export const SEWING_KINDS: readonly WorkCentreKind[] = Object.freeze(['SEWING', 'ASSEMBLY'])
/** A device's id for one action (A1 §3.8 clientEventId): 8 to 64 letters, digits, dots, colons, underscores or hyphens. */
export const CLIENT_SCAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/

export const SCAN_KINDS = ['REPORT', 'UNDO', 'CORRECTION'] as const
export type ScanKind = (typeof SCAN_KINDS)[number]
/**
 * W2b (B-W2b-12, schema wave 7/7): the database's ScanKind also holds the timing of an operation (START, PAUSE, RESUME,
 * HAND_BACK, PARTIAL), which carries no counts. SCAN_KINDS is the count ledger: every count, WIP and progress read
 * filters on it (`kind: { in: [...SCAN_KINDS] }`) and reads the kind back through countKindOf.
 */
export function countKindOf(kind: string): ScanKind {
  if ((SCAN_KINDS as readonly string[]).includes(kind)) return kind as ScanKind
  throw new Error(`production: scan kind ${kind} is a timing kind, not a count; the read filters on SCAN_KINDS`)
}

// ---- refusals -------------------------------------------------------------------------------------------------------------------

export const SCAN_REFUSALS = [
  'FLOOR_NOT_READY',
  'NOT_SIGNED_IN',
  'NOTICE_NOT_ACKNOWLEDGED',
  'NO_STATION',
  'OTHER_WORKER',
  'UNKNOWN_BUNDLE',
  'REPLACED',
  'VOIDED',
  'WORK_ORDER_NOT_OPEN',
  'NOT_AN_OPERATION',
  'CHOOSE_OPERATION',
  'NO_OPERATION_HERE',
  'OTHER_KIND',
  'ALREADY_REPORTED',
  'PREVIOUS_NOT_REPORTED',
  'MORE_THAN_BUNDLE',
  'MORE_THAN_PASSED',
  'LESS_THAN_TAKEN',
  'NO_COUNT',
  'UNKNOWN_REASON',
  'CLIENT_ID_REUSED',
  'UNKNOWN_SCAN',
  'NOT_A_REPORT',
  'NOT_YOURS',
  'NOT_LAST',
  'UNDO_TOO_LATE',
  'VOIDED_ALREADY',
  'NEXT_REPORTED',
  'ASKED_ALREADY',
  'SAME_COUNTS',
  'DECIDED_ALREADY',
  'SELF_APPROVAL',
  'TARGET_VOIDED',
  // B-W2a-26 (MES-008): the bundle or its work order is on hold (apps/factory-api modules/quality/holds/checks.ts holdOnScan).
  'ON_HOLD',
  // B-W2a-35b (Owner answer H1): every machine at the scanning station is do-not-use (apps/factory-api modules/plant/checks.ts stationBlock).
  'MACHINE_UNSAFE',
] as const
export type ScanRefusalCode = (typeof SCAN_REFUSALS)[number]

export interface ScanRefusal {
  readonly code: ScanRefusalCode
  /** What happened and why, in words (never another worker's name). */
  readonly message: string
  /** The one thing to do about it. */
  readonly fix: string
  /** False: a queued scan refused for this may pass when it is sent again later (it stays in the queue). */
  readonly final: boolean
}

const refusal = (code: ScanRefusalCode, message: string, fix: string, final = true): ScanRefusal => ({ code, message, fix, final })

// ---- operations -----------------------------------------------------------------------------------------------------------------

export interface ScanOperation {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly scanRequired: boolean
  /** The kind of the site's work centre it is mapped to. */
  readonly workCentreKind: WorkCentreKind
}

const bySeq = <Op extends Pick<ScanOperation, 'seq'>>(operations: readonly Op[]): Op[] => [...operations].sort((a, b) => a.seq - b.seq)

/** "Op 30 Final inspection". */
export const operationLabel = (operation: Pick<ScanOperation, 'seq' | 'name'>): string => `Op ${operation.seq} ${operation.name}`

/** The scanned operations in routing order. */
export function scannedOperations<Op extends ScanOperation>(operations: readonly Op[]): Op[] {
  return bySeq(operations).filter((operation) => operation.scanRequired)
}

/** The scanned operation before this one (the one whose good it takes), or null for the first. */
export function previousScanned<Op extends ScanOperation>(operations: readonly Op[], operationId: string): Op | null {
  const self = operations.find((operation) => operation.id === operationId)
  if (!self) return null
  return scannedOperations(operations).filter((operation) => operation.seq < self.seq).at(-1) ?? null
}

/** The scanned operation after this one (the one that takes its good), or null for the last. */
export function nextScanned<Op extends ScanOperation>(operations: readonly Op[], operationId: string): Op | null {
  const self = operations.find((operation) => operation.id === operationId)
  if (!self) return null
  return scannedOperations(operations).find((operation) => operation.seq > self.seq) ?? null
}

/** The final operation: the last scanned one (B-W1-14 finalStepOf). Its good garments are finished. */
export function finalOperationOf<Op extends ScanOperation>(operations: readonly Op[]): Op | null {
  return scannedOperations(operations).at(-1) ?? null
}

/** The sewn operation: the last scanned one whose work centre sews (SEWING, ASSEMBLY), or null. Its good garments are sewn. */
export function sewnOperationOf<Op extends ScanOperation>(operations: readonly Op[]): Op | null {
  return scannedOperations(operations).filter((operation) => SEWING_KINDS.includes(operation.workCentreKind)).at(-1) ?? null
}

// ---- scans --------------------------------------------------------------------------------------------------------------------

export interface ScanFact {
  readonly id: string
  readonly kind: ScanKind
  readonly bundleId: string
  readonly workOrderOperationId: string
  readonly correctsId: string | null
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  readonly workerId: string | null
  readonly stationId: string | null
  readonly deviceId: string | null
  readonly clientScanId: string
  readonly deviceTime: Date | null
  readonly serverTime: Date
}

export const totalOf = (scan: Pick<ScanFact, 'goodQuantity' | 'scrapQuantity' | 'reworkQuantity'>): number => scan.goodQuantity + scan.scrapQuantity + scan.reworkQuantity

/** The scans some later row voids (an UNDO or a CORRECTION names them). */
export function voidedIds(scans: readonly Pick<ScanFact, 'correctsId'>[]): Set<string> {
  return new Set(scans.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
}

/**
 * The standing report of each bundle at each operation: the REPORT or CORRECTION no later row voids (MES-069: at most
 * one; the trigger holds it). Keyed `bundleId|operationId`.
 */
export function standingScans<Scan extends ScanFact>(scans: readonly Scan[]): Map<string, Scan> {
  const voided = voidedIds(scans)
  const standing = new Map<string, Scan>()
  for (const scan of scans) {
    if (scan.kind === 'UNDO' || voided.has(scan.id)) continue
    standing.set(standingKey(scan.bundleId, scan.workOrderOperationId), scan)
  }
  return standing
}

export const standingKey = (bundleId: string, operationId: string): string => `${bundleId}|${operationId}`

// ---- counts and reasons ------------------------------------------------------------------------------------------------------------

export interface DefectLine {
  readonly kind: DefectKind
  readonly reason: string
  readonly quantity: number
}

export interface Counts {
  readonly good: number
  readonly scrap: number
  readonly rework: number
}

export const countsTotal = (counts: Counts): number => counts.good + counts.scrap + counts.rework

/**
 * The scrap and rework lines a screen sends (one garment per reason tap, so a reason may come once with its count),
 * merged per kind and reason, sorted, every reason one of the active list's of that kind; or the refusal UNKNOWN_REASON.
 */
export function normaliseDefects(lines: readonly DefectLine[], reasons: readonly ScanReason[]): { readonly ok: true; readonly lines: DefectLine[]; readonly scrap: number; readonly rework: number } | { readonly ok: false; readonly refusal: ScanRefusal } {
  const merged = new Map<string, DefectLine>()
  for (const line of lines) {
    const known = reasons.find((reason) => reason.kind === line.kind && reason.code === line.reason && reason.active)
    if (!known) {
      return { ok: false, refusal: refusal('UNKNOWN_REASON', `${line.reason} is not a ${line.kind === 'SCRAP' ? 'scrap' : 'rework'} reason of this factory.`, 'Pick a reason from the list on the screen.') }
    }
    const key = `${line.kind}|${line.reason}`
    merged.set(key, { kind: line.kind, reason: line.reason, quantity: (merged.get(key)?.quantity ?? 0) + line.quantity })
  }
  const sorted = [...merged.values()].sort((a, b) => (a.kind === b.kind ? a.reason.localeCompare(b.reason) : a.kind === 'SCRAP' ? -1 : 1))
  const sum = (kind: DefectKind) => sorted.filter((line) => line.kind === kind).reduce((total, line) => total + line.quantity, 0)
  return { ok: true, lines: sorted, scrap: sum('SCRAP'), rework: sum('REWORK') }
}

/** OperationScan.scrapReason: the one scrap reason of a scan, or null (none, or several: the scan's defect lines hold them). */
export function scrapReasonColumn(lines: readonly DefectLine[]): string | null {
  const scrap = lines.filter((line) => line.kind === 'SCRAP')
  return scrap.length === 1 ? scrap[0]!.reason : null
}

const sameLines = (a: readonly DefectLine[], b: readonly DefectLine[]): boolean =>
  a.length === b.length && a.every((line, index) => line.kind === b[index]!.kind && line.reason === b[index]!.reason && line.quantity === b[index]!.quantity)

// ---- words ---------------------------------------------------------------------------------------------------------------------------

/** "10:41" on the site's wall clock. */
export function clockText(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(instant)
}

const garments = (count: number) => `${count} garment${count === 1 ? '' : 's'}`

/** Who a scan is, as the person on this device may hear it: never another worker's name. */
export interface Viewer {
  readonly scanSubject: ScanSubject
  /** The signed-in worker (WORKER site). */
  readonly workerId: string | null
  /** The device's station. */
  readonly stationId: string | null
}

/** The scan is the viewer's own: their own at a WORKER site, the device's station's at a STATION site. */
export function isOwn(scan: Pick<ScanFact, 'workerId' | 'stationId'>, viewer: Viewer): boolean {
  if (viewer.scanSubject === 'STATION') return scan.workerId === null && viewer.stationId !== null && scan.stationId === viewer.stationId
  return viewer.workerId !== null && scan.workerId === viewer.workerId
}

export interface Place {
  readonly operation: Pick<ScanOperation, 'seq' | 'name'>
  readonly stationCode: string | null
  readonly timeZone: string
}

/** 'Already reported at Op 30 at 10:41 on SEW-01, by you.' — the station and time, the person only when it is the viewer. */
export function alreadyReported(bundleCode: string, standing: ScanFact, viewer: Viewer, place: Place): ScanRefusal {
  const at = `Op ${place.operation.seq} at ${clockText(standing.serverTime, place.timeZone)}${place.stationCode ? ` on ${place.stationCode}` : ''}`
  if (isOwn(standing, viewer)) {
    return refusal(
      'ALREADY_REPORTED',
      viewer.scanSubject === 'STATION' ? `Bundle ${bundleCode} is reported already at ${at}, from this station.` : `You reported bundle ${bundleCode} already at ${at}.`,
      'Discard this one. If the counts are wrong, undo the report (right after it) or ask a correction.',
    )
  }
  const who = viewer.scanSubject === 'STATION' || standing.workerId === null ? '' : ', by another person (your team leader can see who)'
  return refusal('ALREADY_REPORTED', `Bundle ${bundleCode} is reported already at ${at}${who}: one report per bundle per operation.`, 'Discard this one: it was reported on another tablet.')
}

/** The scan gate's refusal (B-W1-36 privacy, B-W1-37 floor rules), in the gate's words; null when the floor is ready. */
export function scansReadyRefusal(readiness: FloorReadiness | null): ScanRefusal | null {
  if (readiness?.readyForFloor) return null
  const missing = readiness
    ? [...(readiness.privacy.ready ? [] : readiness.privacy.notes.filter((note) => note === NO_DPIA_NOTE || note === NO_WORKER_NOTICE_NOTE)), ...(readiness.rules.readyForFloor ? [] : readiness.rules.notes)]
    : []
  const words = missing.length > 0 ? missing : (readiness?.notes ?? ['The floor rules of this site are not set up.'])
  return refusal('FLOOR_NOT_READY', `Scans are held at this site until its floor is ready: ${words.join(' ')}`, 'Ask the office to finish the floor set-up; the queue sends the scan again by itself.', false)
}

/** Who a new floor scan may name at the site (production/settings floorRecordSubject's cases), with the fix for each. */
export function subjectRefusal(facts: { readonly scanSubject: ScanSubject; readonly workerId: string | null; readonly acknowledged: boolean; readonly stationId: string | null }): ScanRefusal | null {
  if (facts.scanSubject === 'STATION') {
    return facts.stationId
      ? null
      : refusal('NO_STATION', 'This tablet has no station, and this site names the station on every scan.', 'Ask the office to give this tablet a station (Admin › Devices).', false)
  }
  if (!facts.workerId) return refusal('NOT_SIGNED_IN', 'Nobody is signed in on this tablet, and this site names the signed-in worker on every scan.', 'Sign in with your badge; the queue sends it again.', false)
  if (!facts.acknowledged) {
    return refusal(
      'NOTICE_NOT_ACKNOWLEDGED',
      'No scan names you before you read and acknowledge the information notice in force (L. 300/1970 art. 4 c.3; GDPR art. 13).',
      'Read and acknowledge the notice on this tablet; the queue sends it again.',
      false,
    )
  }
  return null
}

/** A queued scan that names the worker who took it, sent while another worker is signed in on the device. */
export const otherWorkerRefusal = (): ScanRefusal =>
  refusal('OTHER_WORKER', 'This scan was taken on this tablet by another person; a scan is recorded only under the name of the person who took it.', 'It is sent when that person signs in on this tablet again.', false)

export const unknownBundleRefusal = (words = 'This is not a bundle ticket of this site.'): ScanRefusal => refusal('UNKNOWN_BUNDLE', words, "Scan the bundle's ticket again, or ask your team leader.")

export const clientIdReusedRefusal = (clientScanId: string): ScanRefusal =>
  refusal('CLIENT_ID_REUSED', `This tablet already sent scan id ${clientScanId} for another action.`, 'Discard it: the tablet sent two actions under one id.')

export const unknownScanRefusal = (): ScanRefusal => refusal('UNKNOWN_SCAN', 'The report it names is not on record (it may have been refused).', 'Discard it.')

const workOrderNotOpen = (workOrder: { readonly number: string; readonly status: WorkOrderStatus }): ScanRefusal =>
  refusal('WORK_ORDER_NOT_OPEN', `Work order ${workOrder.number} is ${workOrder.status}; its bundles are scanned only while it is released or in progress.`, 'Ask your team leader.')

export const isOpen = (status: WorkOrderStatus): boolean => CUTTABLE_STATUSES.includes(status)

// ---- the cap ---------------------------------------------------------------------------------------------------------------------------

export interface BundleFacts {
  readonly code: string
  readonly quantity: number
  readonly status: 'ACTIVE' | 'VOID'
  readonly replacedCodes: readonly string[]
}

/**
 * How many garments of the bundle may be reported at the operation: what the previous scanned operation passed (its
 * standing report's good), or the bundle's garments at the first one; or PREVIOUS_NOT_REPORTED.
 */
export function capAt(
  operations: readonly ScanOperation[],
  operation: ScanOperation,
  bundle: Pick<BundleFacts, 'code' | 'quantity'>,
  standing: ReadonlyMap<string, ScanFact>,
  bundleId: string,
): { readonly ok: true; readonly cap: number; readonly previous: ScanOperation | null } | { readonly ok: false; readonly refusal: ScanRefusal } {
  const previous = previousScanned(operations, operation.id)
  if (!previous) return { ok: true, cap: bundle.quantity, previous: null }
  const passed = standing.get(standingKey(bundleId, previous.id))
  if (!passed) {
    return {
      ok: false,
      refusal: refusal('PREVIOUS_NOT_REPORTED', `${operationLabel(previous)} has not passed bundle ${bundle.code} yet.`, `Report it at Op ${previous.seq} first; if it waits in another tablet's queue, this one is sent again by itself.`, false),
    }
  }
  return { ok: true, cap: passed.goodQuantity, previous }
}

function overCap(bundle: Pick<BundleFacts, 'code' | 'quantity'>, previous: ScanOperation | null, cap: number, total: number): ScanRefusal | null {
  if (total <= cap) return null
  if (!previous) return refusal('MORE_THAN_BUNDLE', `Bundle ${bundle.code} carries ${garments(bundle.quantity)}; ${total} reported.`, `Count again: at most ${cap}.`)
  return refusal('MORE_THAN_PASSED', `${operationLabel(previous)} passed ${garments(cap)} of bundle ${bundle.code}; ${total} reported here.`, `Count again: at most ${cap}, or ask a correction of Op ${previous.seq} first.`)
}

/** What the next scanned operation already took of the bundle (its standing report's garments), with that operation. */
function takenNext(operations: readonly ScanOperation[], operation: ScanOperation, standing: ReadonlyMap<string, ScanFact>, bundleId: string): { readonly next: ScanOperation; readonly taken: number } | null {
  const next = nextScanned(operations, operation.id)
  if (!next) return null
  const scan = standing.get(standingKey(bundleId, next.id))
  return scan ? { next, taken: totalOf(scan) } : null
}

const noCount = (): ScanRefusal => refusal('NO_COUNT', 'Nothing to report: good, scrap and rework add up to 0.', 'Count at least one garment.')

// ---- report ------------------------------------------------------------------------------------------------------------------------------

export interface ReportFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly bundleId: string
  readonly bundle: BundleFacts
  /** The code the device read (an old ticket is REPLACED). */
  readonly scanned: string
  readonly operations: readonly ScanOperation[]
  /** The operation the device named, or null: the one this station does next. */
  readonly operationId: string | null
  /** The device's station (its work centre's kind), or null (a tablet that moves around). */
  readonly station: { readonly code: string; readonly kind: WorkCentreKind } | null
  /** Why a station reports an operation of another kind (covering for another line …). */
  readonly kindReason: string | null
  /** The standing scans of the bundle (standingScans). */
  readonly standing: ReadonlyMap<string, ScanFact>
  readonly counts: Counts
  readonly viewer: Viewer
  /** The station codes of the standing scans (for "on SEW-01"). */
  readonly stationCodes: ReadonlyMap<string, string>
  readonly timeZone: string
}

export type ReportDecision = { readonly ok: true; readonly operation: ScanOperation; readonly cap: number; readonly previous: ScanOperation | null } | { readonly ok: false; readonly refusal: ScanRefusal }

const kindWords = (kind: WorkCentreKind): string => kind.toLowerCase()
const aKind = (kind: WorkCentreKind): string => `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kindWords(kind)}`

/**
 * The operation a scan at this station means when the device names none: its kind's next scanned one not yet reported
 * (two or more: the device picks); when every one of its kind is reported, the last of them (so the scan is answered
 * "already reported", with when and where); a tablet without a station: the bundle's next scanned operation.
 */
export function operationFor(facts: Pick<ReportFacts, 'operations' | 'station' | 'standing' | 'bundleId' | 'bundle'>): { readonly ok: true; readonly operation: ScanOperation } | { readonly ok: false; readonly refusal: ScanRefusal } {
  const scanned = scannedOperations(facts.operations)
  const open = scanned.filter((operation) => !facts.standing.has(standingKey(facts.bundleId, operation.id)))
  const candidates = facts.station ? open.filter((operation) => operation.workCentreKind === facts.station!.kind) : open.slice(0, 1)
  if (candidates.length === 1) return { ok: true, operation: candidates[0]! }
  if (candidates.length > 1) {
    return { ok: false, refusal: refusal('CHOOSE_OPERATION', `${candidates.map(operationLabel).join(' · ')} of bundle ${facts.bundle.code} are done at this station.`, 'Pick the operation.') }
  }
  const reportedHere = facts.station ? scanned.filter((operation) => operation.workCentreKind === facts.station!.kind).at(-1) : undefined
  if (reportedHere) return { ok: true, operation: reportedHere }
  const next = open[0]
  return {
    ok: false,
    refusal: next
      ? refusal('NO_OPERATION_HERE', `Bundle ${facts.bundle.code} has nothing left to do at ${aKind(facts.station!.kind)} station: its next operation is ${operationLabel(next)}.`, `Take the bundle to Op ${next.seq}.`)
      : refusal('NO_OPERATION_HERE', `Bundle ${facts.bundle.code} is reported at every operation.`, 'Discard it: nothing is left to report.'),
  }
}

/** Whether a REPORT of the bundle at the operation is taken, and its cap; or the refusal. */
export function reportDecision(facts: ReportFacts): ReportDecision {
  const ticket = scannedBundleRefusal(facts.bundle, facts.scanned)
  if (ticket) {
    return ticket.code === 'REPLACED'
      ? { ok: false, refusal: refusal('REPLACED', ticket.message, `Discard it and scan the new ticket ${facts.bundle.code}.`) }
      : { ok: false, refusal: refusal('VOIDED', ticket.message, 'Discard it: the bundle was voided.') }
  }
  if (!isOpen(facts.workOrder.status)) return { ok: false, refusal: workOrderNotOpen(facts.workOrder) }
  const total = countsTotal(facts.counts)
  if (total < 1) return { ok: false, refusal: noCount() }

  let operation: ScanOperation
  if (facts.operationId !== null) {
    const named = facts.operations.find((candidate) => candidate.id === facts.operationId)
    if (!named) {
      return { ok: false, refusal: refusal('NOT_AN_OPERATION', `This is not an operation of work order ${facts.workOrder.number}.`, 'Scan the bundle again and pick one of its operations.') }
    }
    operation = named
  } else {
    const found = operationFor(facts)
    if (!found.ok) return found
    operation = found.operation
  }
  if (facts.station && facts.station.kind !== operation.workCentreKind && !facts.kindReason) {
    return {
      ok: false,
      refusal: refusal('OTHER_KIND', `${facts.station.code} is ${aKind(facts.station.kind)} station; ${operationLabel(operation)} is ${kindWords(operation.workCentreKind)} work.`, `Report it at ${aKind(operation.workCentreKind)} station, or give the reason it is done here.`),
    }
  }
  const standing = facts.standing.get(standingKey(facts.bundleId, operation.id))
  if (standing) {
    return { ok: false, refusal: alreadyReported(facts.bundle.code, standing, facts.viewer, { operation, stationCode: standing.stationId ? (facts.stationCodes.get(standing.stationId) ?? null) : null, timeZone: facts.timeZone }) }
  }
  const cap = capAt(facts.operations, operation, facts.bundle, facts.standing, facts.bundleId)
  if (!cap.ok) return cap
  const over = overCap(facts.bundle, cap.previous, cap.cap, total)
  if (over) return { ok: false, refusal: over }
  return { ok: true, operation, cap: cap.cap, previous: cap.previous }
}

// ---- undo -------------------------------------------------------------------------------------------------------------------------------

export interface UndoFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly target: ScanFact | null
  readonly operations: readonly ScanOperation[]
  /** Every scan of the target's bundle. */
  readonly scans: readonly ScanFact[]
  /** The newest scan this device wrote (by server time), or null. */
  readonly latestOnDevice: string | null
  readonly deviceId: string
  readonly viewer: Viewer
  /** The undo's own time on the device's clock (an offline queue's), or null. */
  readonly deviceTime: Date | null
  readonly now: Date
}

/** How long after the report the undo comes: on the device's clock when both times are known, else on the server's. */
export function undoDelay(target: Pick<ScanFact, 'deviceTime' | 'serverTime'>, deviceTime: Date | null, now: Date): number {
  if (target.deviceTime && deviceTime) return deviceTime.getTime() - target.deviceTime.getTime()
  return now.getTime() - target.serverTime.getTime()
}

/** Why the device's undo of this report is refused, or null. */
export function undoRefusal(facts: UndoFacts): ScanRefusal | null {
  const target = facts.target
  if (!target) return unknownScanRefusal()
  if (target.kind !== 'REPORT') return refusal('NOT_A_REPORT', 'Only a report is undone on the floor; this is an undo or an office correction.', 'Ask a correction instead.')
  if (!isOpen(facts.workOrder.status)) return workOrderNotOpen(facts.workOrder)
  if (voidedIds(facts.scans).has(target.id)) return refusal('VOIDED_ALREADY', 'This report was undone or corrected already.', 'Discard it.')
  if (target.deviceId !== facts.deviceId || !isOwn(target, facts.viewer)) {
    return refusal('NOT_YOURS', facts.viewer.scanSubject === 'STATION' ? 'This report was taken at another station or on another tablet.' : 'This report is not yours on this tablet.', 'Ask your team leader.')
  }
  if (facts.latestOnDevice !== target.id) return refusal('NOT_LAST', 'Another scan on this tablet came after it: only the last one is undone.', 'Ask a correction instead.')
  if (undoDelay(target, facts.deviceTime, facts.now) > UNDO_WINDOW_MS) {
    return refusal('UNDO_TOO_LATE', `More than ${UNDO_WINDOW_MS / 60_000} minutes passed since the report: it is undone only right after it.`, 'Ask a correction instead.')
  }
  const taken = takenNext(facts.operations, facts.operations.find((operation) => operation.id === target.workOrderOperationId)!, standingScans(facts.scans), target.bundleId)
  if (taken) return refusal('NEXT_REPORTED', `${operationLabel(taken.next)} took this bundle already.`, 'Ask a correction instead.')
  return null
}

// ---- corrections ----------------------------------------------------------------------------------------------------------------------

export interface CorrectionCountFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly bundle: Pick<BundleFacts, 'code' | 'quantity'>
  /** The scan to correct (a REPORT or CORRECTION), or null. */
  readonly target: ScanFact | null
  readonly operations: readonly ScanOperation[]
  /** Every scan of the target's bundle. */
  readonly scans: readonly ScanFact[]
  /** The asked counts and their defect lines (normaliseDefects). */
  readonly counts: Counts
  readonly lines: readonly DefectLine[]
  /** The target's own defect lines. */
  readonly targetLines: readonly DefectLine[]
  /**
   * W2b (B-W2b-10; B-W2a-13's follow-up): the bundle's standing scans as the cap reads them (../bundles/split
   * bundleFlow): a split parent's reports count at most its live garments, a child's stand in its parent's place. Pass
   * it with `bundle.quantity` = the flow's live garments, so a correction of a split parent is capped at the garments
   * still in it (the database caps at the bundle as cut). Left out: the bundle's own standing scans.
   */
  readonly standing?: ReadonlyMap<string, ScanFact> | undefined
}

/** The counts a correction asks, against the same caps as a report and what the next operation already took. */
function correctionCountsRefusal(facts: CorrectionCountFacts, target: ScanFact): ScanRefusal | null {
  const total = countsTotal(facts.counts)
  if (total < 1) return noCount()
  if (facts.counts.good === target.goodQuantity && facts.counts.scrap === target.scrapQuantity && facts.counts.rework === target.reworkQuantity && sameLines(facts.lines, facts.targetLines)) {
    return refusal('SAME_COUNTS', 'The counts and reasons are the same as the report’s.', 'Change a count or a reason, or discard it.')
  }
  const operation = facts.operations.find((candidate) => candidate.id === target.workOrderOperationId)!
  const standing = facts.standing ?? standingScans(facts.scans)
  const cap = capAt(facts.operations, operation, facts.bundle, standing, target.bundleId)
  if (!cap.ok) return cap.refusal
  const over = overCap(facts.bundle, cap.previous, cap.cap, total)
  if (over) return over
  const taken = takenNext(facts.operations, operation, standing, target.bundleId)
  if (taken && facts.counts.good < taken.taken) {
    return refusal(
      'LESS_THAN_TAKEN',
      `${operationLabel(taken.next)} took ${garments(taken.taken)} of bundle ${facts.bundle.code} already; ${facts.counts.good} good is fewer.`,
      `Count again (at least ${taken.taken} good), or correct Op ${taken.next.seq} first.`,
    )
  }
  return null
}

export interface CorrectionAskFacts extends CorrectionCountFacts {
  readonly viewer: Viewer
  /** A correction of the target waits for a decision already. */
  readonly pending: boolean
}

/** Why the floor's ask of a correction of its own older report is refused, or null. */
export function correctionAskRefusal(facts: CorrectionAskFacts): ScanRefusal | null {
  const target = facts.target
  if (!target) return unknownScanRefusal()
  if (target.kind === 'UNDO') return refusal('NOT_A_REPORT', 'An undo is not corrected; the report it undid is gone from the counts.', 'Report the bundle again instead.')
  if (!isOpen(facts.workOrder.status)) return workOrderNotOpen(facts.workOrder)
  if (voidedIds(facts.scans).has(target.id)) return refusal('VOIDED_ALREADY', 'This report was undone or corrected already.', 'Ask a correction of the report that stands now.')
  if (!isOwn(target, facts.viewer)) {
    return refusal('NOT_YOURS', facts.viewer.scanSubject === 'STATION' ? "This report is another station's." : 'This report is not yours.', 'Ask your team leader: the person who took it asks its correction.')
  }
  if (facts.pending) return refusal('ASKED_ALREADY', 'A correction of this report waits for a decision already.', "Wait for your team leader's answer.")
  return correctionCountsRefusal(facts, target)
}

export interface CorrectionApprovalFacts extends CorrectionCountFacts {
  readonly status: 'PENDING' | 'APPROVED' | 'REFUSED'
  /** The approver took the scan or asked its correction (or is the office user of the worker who did). */
  readonly approverInvolved: boolean
}

/** Why an approval of a correction request is refused, or null (the refusal of a request is always allowed while PENDING). */
export function correctionApprovalRefusal(facts: CorrectionApprovalFacts): ScanRefusal | null {
  if (facts.status !== 'PENDING') return refusal('DECIDED_ALREADY', `This correction was ${facts.status.toLowerCase()} already.`, 'Reload the list.')
  if (facts.approverInvolved) return refusal('SELF_APPROVAL', 'You took this scan or asked its correction: another person decides it (four eyes, MES-096).', 'Ask another lead or the production manager.')
  const target = facts.target
  if (!target) return unknownScanRefusal()
  if (!isOpen(facts.workOrder.status)) return workOrderNotOpen(facts.workOrder)
  if (voidedIds(facts.scans).has(target.id)) return refusal('TARGET_VOIDED', 'The scan it corrects was undone or corrected since it was asked.', 'Refuse it; the floor asks again on the scan that stands now.')
  return correctionCountsRefusal(facts, target)
}

/** A request decided already, as a refusal of its refusal. */
export function decidedRefusal(status: 'PENDING' | 'APPROVED' | 'REFUSED'): ScanRefusal | null {
  return status === 'PENDING' ? null : refusal('DECIDED_ALREADY', `This correction was ${status.toLowerCase()} already.`, 'Reload the list.')
}

// ---- the device's clock -----------------------------------------------------------------------------------------------------------------

/** The device's clock against the server's at the moment it sent (PLT-240): off beyond CLOCK_WARN_MS, flagged beyond CLOCK_FLAG_MS. */
export function clockCheck(deviceSentAt: Date, serverNow: Date): { readonly skewSeconds: number; readonly off: boolean; readonly flagged: boolean } {
  const skew = serverNow.getTime() - deviceSentAt.getTime()
  return { skewSeconds: Math.round(skew / 1000), off: Math.abs(skew) > CLOCK_WARN_MS, flagged: Math.abs(skew) > CLOCK_FLAG_MS }
}
