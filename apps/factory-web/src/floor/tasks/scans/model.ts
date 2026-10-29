/**
 * SCR-090 Operation (design floor.operation; MES-069, MES-090, MES-095, MES-096; Owner answers F2, F3): the rules of the
 * screen without React or the network, so the tests hold them.
 *
 *   card      what `GET /production/scans/card?code=` answers for a scanned bundle ticket: the bundle, its work order,
 *             each operation with its state and how many a report there may count (`expected`: what the previous
 *             operation passed), the operation this station does next (`next`), or the ones to choose from (`choose`)
 *   opening   what the screen shows for a card: a refusal (an old ticket, a voided bundle, a work order not open), the
 *             operation picker, the counts, or "already reported" (own: Undo or a correction; another person's: the
 *             team leader sees who — never a name, Statuto dei Lavoratori art. 4)
 *   counts    reason-first counting: Good opens at the expected number (one tap on Finish, F3); each tap on a scrap or
 *             rework reason adds one piece with that reason and takes it from Good; Good may be typed (missing pieces)
 *   report    the queued report's body (factory-domain floor-sync `production.scan.report`): the ticket's code, the
 *             operation, good, and one line per reason
 *   undo      a report made on this tablet is undone until the next scan or two minutes (MES-095), then it turns into
 *             "Ask a correction" (MES-096): an older own report gets new counts and a reason; the original stays
 */

export const UNDO_WINDOW_MS = 2 * 60_000

export type DefectKind = 'SCRAP' | 'REWORK'
export type OperationState = 'DONE' | 'OPEN' | 'NOT_REACHED'

export interface CardReason {
  readonly kind: DefectKind
  readonly code: string
  readonly label: { readonly it: string; readonly en: string }
  readonly sortOrder: number
}

export interface CardReport {
  readonly scanId: string
  readonly kind: 'REPORT' | 'UNDO' | 'CORRECTION'
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  readonly serverTime: string
  readonly station: { readonly id: string; readonly code: string } | null
  /** The viewer's own (at a station site: this station's). Never who else. */
  readonly own: boolean
}

export interface CardOperation {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly scanRequired: boolean
  readonly workCentreKind: string
  readonly final: boolean
  readonly sewn: boolean
  readonly state: OperationState
  readonly expected: number | null
  readonly report: CardReport | null
}

export interface BundleCard {
  readonly scanned: string
  readonly refusal: { readonly code: string; readonly message: string } | null
  readonly bundle: {
    readonly id: string
    readonly code: string
    readonly status: 'ACTIVE' | 'VOID'
    readonly quantity: number
    readonly part: string | null
    readonly workOrderSizeId: string
    readonly colourwayCode: string
    readonly colourwayName: string
    readonly size: string
  }
  readonly workOrder: { readonly id: string; readonly number: string; readonly batchNumber: string | null; readonly status: string; readonly siteId: string; readonly style: { readonly code: string; readonly name: string } }
  readonly station: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string } | null
  readonly operations: readonly CardOperation[]
  readonly next: string | null
  readonly choose: readonly string[]
  readonly hint: { readonly code: string; readonly message: string; readonly fix: string } | null
  readonly reasons: readonly CardReason[]
}

// ---- what a card opens ------------------------------------------------------------------------------------------------

export type Opening =
  /** The ticket or its work order is refused (REPLACED, VOIDED, WORK_ORDER_NOT_OPEN …) or the station has nothing to do. */
  | { readonly kind: 'refused'; readonly code: string; readonly message: string; readonly fix: string | null }
  /** Two or more operations fit this station: the picker (first in sequence first). */
  | { readonly kind: 'pick'; readonly options: readonly CardOperation[] }
  /** The counts at this operation. */
  | { readonly kind: 'counts'; readonly operation: CardOperation }
  /** This station's operation is reported already (own: Undo or a correction; another person's: who is never shown). */
  | { readonly kind: 'already'; readonly operation: CardOperation; readonly report: CardReport }

/** The operation reported at this station that is DONE (the last of the station's kind), for "already reported". */
export function doneHere(card: BundleCard): CardOperation | null {
  const done = card.operations.filter((operation) => operation.state === 'DONE' && operation.report !== null)
  const here = card.station ? done.filter((operation) => operation.workCentreKind === card.station!.kind) : done
  return here.at(-1) ?? done.at(-1) ?? null
}

/** The next operation the bundle waits for (where to take it), or null. */
export function nextOpen(card: BundleCard): CardOperation | null {
  return card.operations.find((operation) => operation.scanRequired && operation.state !== 'DONE') ?? null
}

export function openingOf(card: BundleCard, picked: string | null = null): Opening {
  if (card.refusal) return { kind: 'refused', code: card.refusal.code, message: card.refusal.message, fix: null }
  const byId = (id: string) => card.operations.find((operation) => operation.id === id) ?? null
  if (picked) {
    const operation = byId(picked)
    if (operation) return { kind: 'counts', operation }
  }
  if (card.next) {
    const operation = byId(card.next)
    if (operation) return { kind: 'counts', operation }
  }
  if (card.choose.length >= 2) {
    const options = card.choose.map(byId).filter((operation): operation is CardOperation => operation !== null).sort((a, b) => a.seq - b.seq)
    if (options.length >= 2) return { kind: 'pick', options }
    if (options.length === 1) return { kind: 'counts', operation: options[0]! }
  }
  if (card.hint?.code === 'ALREADY_REPORTED') {
    const operation = doneHere(card)
    if (operation?.report) return { kind: 'already', operation, report: operation.report }
  }
  if (card.hint) return { kind: 'refused', code: card.hint.code, message: card.hint.message, fix: card.hint.fix }
  return { kind: 'refused', code: 'NO_OPERATION_HERE', message: '', fix: null }
}

// ---- counts --------------------------------------------------------------------------------------------------------------

export interface Counts {
  /** Pieces per scrap reason. */
  readonly scrap: Readonly<Record<string, number>>
  readonly rework: Readonly<Record<string, number>>
  /** Good as typed on the pad; null: Good balances itself (expected − scrap − rework). */
  readonly typedGood: number | null
}

export const NO_COUNTS: Counts = Object.freeze({ scrap: Object.freeze({}), rework: Object.freeze({}), typedGood: null })

const sum = (lines: Readonly<Record<string, number>>) => Object.values(lines).reduce((total, value) => total + value, 0)

export function scrapOf(counts: Pick<Counts, 'scrap'>): number {
  return sum(counts.scrap)
}
export function reworkOf(counts: Pick<Counts, 'rework'>): number {
  return sum(counts.rework)
}

/** Good as it stands: typed, else what is left of the expected number. */
export function goodOf(counts: Counts, expected: number): number {
  if (counts.typedGood !== null) return counts.typedGood
  return Math.max(0, expected - scrapOf(counts) - reworkOf(counts))
}

export function totalOf(counts: Counts, expected: number): number {
  return goodOf(counts, expected) + scrapOf(counts) + reworkOf(counts)
}

/** Whether anything was changed from the opening counts (a scan then asks "Leave this count?"). */
export function touched(counts: Counts): boolean {
  return counts.typedGood !== null || scrapOf(counts) > 0 || reworkOf(counts) > 0
}

export type CountMove = { readonly ok: true; readonly counts: Counts } | { readonly ok: false; readonly problem: 'atMost' }

const lineKey = (kind: DefectKind): 'scrap' | 'rework' => (kind === 'SCRAP' ? 'scrap' : 'rework')

/** One more piece with this reason: taken from Good; refused when every piece already has a reason. */
export function addReason(counts: Counts, kind: DefectKind, code: string, expected: number): CountMove {
  const key = lineKey(kind)
  const defects = scrapOf(counts) + reworkOf(counts)
  let typedGood = counts.typedGood
  if (typedGood !== null) {
    if (typedGood + defects + 1 > expected) {
      if (typedGood === 0) return { ok: false, problem: 'atMost' }
      typedGood -= 1
    }
  } else if (defects + 1 > expected) return { ok: false, problem: 'atMost' }
  return { ok: true, counts: { ...counts, typedGood, [key]: { ...counts[key], [code]: (counts[key][code] ?? 0) + 1 } } }
}

/** One piece less with this reason (back to Good when Good balances itself). */
export function removeReason(counts: Counts, kind: DefectKind, code: string): Counts {
  const key = lineKey(kind)
  const now = counts[key][code] ?? 0
  if (now <= 0) return counts
  const next = { ...counts[key] }
  if (now === 1) delete next[code]
  else next[code] = now - 1
  return { ...counts, [key]: next }
}

/** Good typed on the pad (null: back to balancing itself). Refused above what Good may be. */
export function setGood(counts: Counts, value: number | null, expected: number): CountMove {
  if (value === null) return { ok: true, counts: { ...counts, typedGood: null } }
  if (value < 0 || value + scrapOf(counts) + reworkOf(counts) > expected) return { ok: false, problem: 'atMost' }
  return { ok: true, counts: { ...counts, typedGood: value } }
}

/** The most Good may be now. */
export function maxGood(counts: Counts, expected: number): number {
  return Math.max(0, expected - scrapOf(counts) - reworkOf(counts))
}

/** Why Finish cannot run with these counts, or null. */
export function finishHeld(counts: Counts, expected: number | null): 'nothing' | 'atMost' | 'unknown' | null {
  if (expected === null || expected <= 0) return 'unknown'
  const total = totalOf(counts, expected)
  if (total < 1) return 'nothing'
  if (total > expected) return 'atMost'
  return null
}

const lines = (record: Readonly<Record<string, number>>) => Object.entries(record).filter(([, quantity]) => quantity > 0).map(([reason, quantity]) => ({ reason, quantity }))

/** The queued report's body (floor-sync `production.scan.report`), empty lines left out. */
export function reportPayload(card: Pick<BundleCard, 'bundle'>, operationId: string, counts: Counts, expected: number): Record<string, unknown> {
  const scrap = lines(counts.scrap)
  const rework = lines(counts.rework)
  return {
    code: card.bundle.code,
    workOrderOperationId: operationId,
    good: goodOf(counts, expected),
    ...(scrap.length > 0 ? { scrap } : {}),
    ...(rework.length > 0 ? { rework } : {}),
  }
}

/**
 * The card as the tablet knows it after its own report (kept for an offline scan of the same bundle): the operation is
 * DONE with the tablet's own report, and the next scanned operation may take what it passed.
 */
export function afterReport(card: BundleCard, operationId: string, counts: Counts, expected: number, at: Date): BundleCard {
  const good = goodOf(counts, expected)
  const index = card.operations.findIndex((operation) => operation.id === operationId)
  if (index < 0) return card
  const operations = card.operations.map((operation, at2) => {
    if (at2 === index) {
      return {
        ...operation,
        state: 'DONE' as const,
        report: { scanId: '', kind: 'REPORT' as const, goodQuantity: good, scrapQuantity: scrapOf(counts), reworkQuantity: reworkOf(counts), serverTime: at.toISOString(), station: card.station ? { id: card.station.id, code: card.station.code } : null, own: true },
      }
    }
    const firstAfter = card.operations.slice(index + 1).find((other) => other.scanRequired)
    if (firstAfter && operation.id === firstAfter.id && operation.state === 'NOT_REACHED') return { ...operation, state: 'OPEN' as const, expected: good }
    return operation
  })
  return { ...card, operations, next: null, choose: [], hint: { code: 'ALREADY_REPORTED', message: '', fix: '' } }
}

// ---- the last action: undo, then a correction -------------------------------------------------------------------------------

export interface LastAction {
  /** The queue's id of the report (an undo or a correction names it while it has no server id). */
  readonly clientEventId: string
  readonly bundleCode: string
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string }
  readonly good: number
  readonly scrap: Readonly<Record<string, number>>
  readonly rework: Readonly<Record<string, number>>
  /** When it was done (ISO, the tablet's clock). */
  readonly at: string
  /** A scan came after it: Undo is over (MES-095). */
  readonly scannedAfter: boolean
  /** The undo's queue id, once undone. */
  readonly undoEventId: string | null
  /** The correction's queue id, once asked. */
  readonly askEventId: string | null
}

/** Undo is open: no scan since, within two minutes, not undone yet. */
export function undoOpen(last: LastAction | null, now: Date): boolean {
  if (!last || last.scannedAfter || last.undoEventId) return false
  return now.getTime() - Date.parse(last.at) < UNDO_WINDOW_MS
}

/** When Undo closes by itself (ms from now), or null. */
export function undoClosesIn(last: LastAction | null, now: Date): number | null {
  if (!undoOpen(last, now)) return null
  return Math.max(0, Date.parse(last!.at) + UNDO_WINDOW_MS - now.getTime())
}

// ---- a correction -----------------------------------------------------------------------------------------------------------

/** A report the person may ask to correct: one of today's own (server id) or the one just made here (queue id). */
export interface CorrectionTarget {
  readonly key: string
  readonly scanId: string | null
  readonly clientScanId: string | null
  readonly bundleCode: string
  readonly operation: { readonly seq: number; readonly code: string; readonly name: string }
  readonly good: number
  readonly scrap: Readonly<Record<string, number>>
  readonly rework: Readonly<Record<string, number>>
  readonly at: string
  /** A correction of it waits for the team leader. */
  readonly pending: boolean
}

export const totalOfTarget = (target: Pick<CorrectionTarget, 'good' | 'scrap' | 'rework'>): number => target.good + sum(target.scrap) + sum(target.rework)

/** The counts a correction opens with: the report's own. */
export function countsOfTarget(target: CorrectionTarget): Counts {
  return { scrap: { ...target.scrap }, rework: { ...target.rework }, typedGood: target.good }
}

const same = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((key) => (a[key] ?? 0) === (b[key] ?? 0))
}

/** Why a correction cannot be sent, or null. */
export function correctionHeld(target: CorrectionTarget, counts: Counts, reason: string | null): 'same' | 'nothing' | 'reason' | null {
  const expected = totalOfTarget(target)
  const good = goodOf(counts, expected)
  if (good + scrapOf(counts) + reworkOf(counts) < 1) return 'nothing'
  if (good === target.good && same(counts.scrap, target.scrap) && same(counts.rework, target.rework)) return 'same'
  if (!reason) return 'reason'
  return null
}

/** The queued ask's body (floor-sync `production.scan.ask`). */
export function askPayload(target: CorrectionTarget, counts: Counts, reason: string): Record<string, unknown> {
  const expected = totalOfTarget(target)
  return {
    ...(target.scanId ? { scanId: target.scanId } : { targetClientScanId: target.clientScanId }),
    good: goodOf(counts, expected),
    scrap: lines(counts.scrap),
    rework: lines(counts.rework),
    reason,
  }
}

/** The reasons a person gives for a correction (their words go to the team leader). */
export const CORRECTION_REASONS = ['count', 'reason', 'found', 'other'] as const
export type CorrectionReason = (typeof CORRECTION_REASONS)[number]

/** The refusal codes the screen has its own words for (the others show the API's). */
export const KNOWN_REFUSALS = [
  'REPLACED',
  'VOIDED',
  'WORK_ORDER_NOT_OPEN',
  'NO_OPERATION_HERE',
  'NO_STATION',
  'PREVIOUS_NOT_REPORTED',
  'FLOOR_NOT_READY',
  'NOTICE_NOT_ACKNOWLEDGED',
  'UNKNOWN_BUNDLE',
  'OTHER_KIND',
] as const
