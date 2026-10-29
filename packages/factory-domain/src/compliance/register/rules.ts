import type { Issue } from '../../core/errors'
import { businessDate } from '../../core/time'
import { defineMachine } from '../../state/machine'

/**
 * The PPE register (B-W1-43; QHS-118): the maker's register of complaints, of non-conforming PPE and of recalls
 * (Reg. (EU) 2016/425 art. 8(4)), with the investigation, the corrective action (art. 8(8): bring the PPE into
 * conformity, withdraw it or recall it), the information to distributors (art. 8(4): "keep distributors informed") and,
 * where the PPE presents a risk, the notice to the market surveillance authorities of the Member States where it was
 * made available (art. 8(8)). With a brand label the brand is the legal maker and keeps its register; the factory keeps
 * the same entries to hand over (PLAN §2.8).
 *
 * An entry is OPEN, then CLOSED; it is never deleted, and a closed entry never changes (the …_quality_shipping_guards
 * trigger). Closing needs, in plain words (closeProblems): a reason; the risk decided (yes or no, not "assessing"); the
 * corrective action recorded and done; when garments it concerns have left for customers, the distributors informed;
 * when the PPE may present a risk, the authorities told, with the date and their reference.
 *
 * Pure: the facts are passed in (apps/factory-api's modules/compliance/register reads them).
 */

export const REGISTER_KINDS = ['COMPLAINT', 'NON_CONFORMITY', 'RECALL'] as const
export type RegisterKind = (typeof REGISTER_KINDS)[number]

export const REGISTER_STATUSES = ['OPEN', 'CLOSED'] as const
export type RegisterStatus = (typeof REGISTER_STATUSES)[number]

/** May the PPE present a risk? ASSESSING until someone decides (the design's "Yes / No / Assessing"). */
export const REGISTER_RISKS = ['NO', 'ASSESSING', 'YES'] as const
export type RegisterRisk = (typeof REGISTER_RISKS)[number]

/**
 * Where an entry came from, when another record opened it: a release reversal whose garments had already left
 * (B-W1-45, "shipped ones go to the PPE register"), a final inspection, a shipment. A person's own entry has none.
 * The complaint (SAL-416) and the NCR (W2a) join with their modules.
 */
export const REGISTER_SOURCE_TYPES = ['QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment'] as const
export type RegisterSourceType = (typeof REGISTER_SOURCE_TYPES)[number]

export const KIND_WORDS: Readonly<Record<RegisterKind, string>> = Object.freeze({ COMPLAINT: 'complaint', NON_CONFORMITY: 'non-conformity', RECALL: 'recall' })
export const RISK_WORDS: Readonly<Record<RegisterRisk, string>> = Object.freeze({ NO: 'no risk', ASSESSING: 'risk being assessed', YES: 'may present a risk' })

/** The law each duty rests on, for the screens' LawRef chips. */
export const REGISTER_LAW = Object.freeze({
  register: 'Reg. (EU) 2016/425 art. 8(4)',
  distributors: 'Reg. (EU) 2016/425 art. 8(4)',
  correctiveAction: 'Reg. (EU) 2016/425 art. 8(8)',
  authority: 'Reg. (EU) 2016/425 art. 8(8)',
})

/** The most of each list one entry names. */
export const REGISTER_LIMITS = Object.freeze({
  batchNumbers: 50,
  serials: 500,
  lotIds: 50,
  workOrderIds: 50,
  shipmentIds: 50,
  code: 60,
  description: 4000,
  text: 4000,
  reason: 1000,
  authorityReference: 120,
})

/** What an entry concerns: the style, and the batches, serials, material lots, work orders and shipments as reported or found. */
export interface RegisterConcern {
  readonly styleId: string
  /** The style revision the garments were made to, when known. */
  readonly styleRevisionId: string | null
  /** Work orders' batch numbers (WorkOrder.batchNumber), as printed on the garment labels. */
  readonly batchNumbers: readonly string[]
  /** Garment serials (GarmentSerial.serial) of a serial-tracked style. */
  readonly serials: readonly string[]
  /** Material lots (a hide lot, a protector lot): every work order they were issued to. */
  readonly lotIds: readonly string[]
  /** Work orders named directly (the release reversal's). */
  readonly workOrderIds: readonly string[]
  /** Shipments named directly: their garments of the style (the shipments a reversed release's garments left on). */
  readonly shipmentIds: readonly string[]
}

export interface RegisterSource {
  readonly type: RegisterSourceType
  readonly id: string
}

/** One entry as the domain sees it: every fact, wherever the API keeps it. */
export interface RegisterEntryState extends RegisterConcern {
  readonly kind: RegisterKind
  readonly status: RegisterStatus
  readonly reportedAt: Date
  readonly description: string
  readonly investigation: string | null
  readonly risk: RegisterRisk
  readonly actionTaken: string | null
  readonly actionCompletedAt: Date | null
  readonly distributorsInformedAt: Date | null
  readonly authorityNotifiedAt: Date | null
  readonly authorityReference: string | null
  readonly closeReason: string | null
}

/** A problem in plain words, with a stable code for the screen. */
export interface RegisterProblem {
  readonly code: string
  readonly message: string
}

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''

/** Trimmed, without empty strings and repeats, in the order given. */
export function cleanList(values: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Names the concern has beyond the style: a recall must name what it calls back. */
export const namesGarments = (concern: Pick<RegisterConcern, 'batchNumbers' | 'serials' | 'lotIds' | 'workOrderIds' | 'shipmentIds'>): boolean =>
  concern.batchNumbers.length + concern.serials.length + concern.lotIds.length + concern.workOrderIds.length + concern.shipmentIds.length > 0

/**
 * What is wrong with an entry as written (empty: nothing), with paths under `body/`: a description, the report time not
 * in the future, the lists within their limits, a recall naming the garments it calls back, a closed-out corrective
 * action not rewritten.
 */
export function entryProblems(
  entry: Pick<RegisterEntryState, 'kind' | 'reportedAt' | 'description' | 'investigation' | 'actionTaken' | 'batchNumbers' | 'serials' | 'lotIds' | 'workOrderIds' | 'shipmentIds'>,
  now: Date,
): Issue[] {
  const problems: Issue[] = []
  if (blank(entry.description)) problems.push({ path: 'body/description', message: 'Say what happened.' })
  if (entry.reportedAt.getTime() > now.getTime()) problems.push({ path: 'body/reportedAt', message: 'The report time is in the future.' })
  for (const [field, limit] of [
    ['batchNumbers', REGISTER_LIMITS.batchNumbers],
    ['serials', REGISTER_LIMITS.serials],
    ['lotIds', REGISTER_LIMITS.lotIds],
    ['workOrderIds', REGISTER_LIMITS.workOrderIds],
    ['shipmentIds', REGISTER_LIMITS.shipmentIds],
  ] as const) {
    if (entry[field].length > limit) problems.push({ path: `body/${field}`, message: `At most ${limit}.` })
  }
  for (const [field, list] of [
    ['batchNumbers', entry.batchNumbers],
    ['serials', entry.serials],
  ] as const) {
    list.forEach((value, index) => {
      if (value.length > REGISTER_LIMITS.code) problems.push({ path: `body/${field}/${index}`, message: `At most ${REGISTER_LIMITS.code} characters.` })
    })
  }
  if (entry.kind === 'RECALL' && !namesGarments(entry)) {
    problems.push({ path: 'body/batchNumbers', message: 'A recall names what it calls back: batch numbers, serials, material lots, work orders or shipments.' })
  }
  return problems
}

/** Editing an OPEN entry: once the corrective action is marked done, its text stays as it was done. */
export function editProblems(before: Pick<RegisterEntryState, 'status' | 'actionTaken' | 'actionCompletedAt'>, after: Pick<RegisterEntryState, 'actionTaken'>): RegisterProblem[] {
  const problems: RegisterProblem[] = []
  if (before.status !== 'OPEN') problems.push({ code: 'CLOSED', message: 'A closed register entry never changes.' })
  if (before.actionCompletedAt !== null && (after.actionTaken ?? '') !== (before.actionTaken ?? '')) {
    problems.push({ code: 'ACTION_DONE', message: 'The corrective action is recorded as done; add a note to the entry instead of rewriting it.' })
  }
  return problems
}

/**
 * A date a duty was met on (the corrective action done, distributors informed, the authority told): not in the future,
 * and not before the business day the entry was reported.
 */
export function dutyDateProblems(at: Date, reportedAt: Date, now: Date, path: string): Issue[] {
  if (at.getTime() > now.getTime()) return [{ path, message: 'This date is in the future.' }]
  if (businessDate(at) < businessDate(reportedAt)) return [{ path, message: `This is before the entry was reported (${businessDate(reportedAt)}).` }]
  return []
}

/** Marking the corrective action done: there is one, and it is not done yet. */
export function completeActionProblems(entry: Pick<RegisterEntryState, 'status' | 'actionTaken' | 'actionCompletedAt'>): RegisterProblem[] {
  if (entry.status !== 'OPEN') return [{ code: 'CLOSED', message: 'A closed register entry never changes.' }]
  if (blank(entry.actionTaken)) return [{ code: 'NO_CORRECTIVE_ACTION', message: 'Record the corrective action taken (or why none is needed) first.' }]
  if (entry.actionCompletedAt !== null) return [{ code: 'ACTION_DONE', message: 'The corrective action is already marked done.' }]
  return []
}

/** What closing needs to know beyond the entry: whether garments it concerns have left for customers, and which. */
export interface CloseFacts {
  readonly entry: Pick<
    RegisterEntryState,
    'status' | 'risk' | 'actionTaken' | 'actionCompletedAt' | 'distributorsInformedAt' | 'authorityNotifiedAt' | 'authorityReference'
  >
  readonly reason: string | null
  /** Garments the entry concerns are on shipments that left (SHIPPED or DELIVERED). */
  readonly shippedGoods: boolean
  /** Those shipments' numbers, for the message. */
  readonly shipmentNumbers?: readonly string[]
}

export const CLOSE_PROBLEM_CODES = [
  'CLOSED',
  'NO_REASON',
  'RISK_NOT_ASSESSED',
  'NO_CORRECTIVE_ACTION',
  'CORRECTIVE_ACTION_NOT_DONE',
  'DISTRIBUTORS_NOT_INFORMED',
  'AUTHORITY_NOT_NOTIFIED',
  'AUTHORITY_REFERENCE_MISSING',
] as const

const listed = (numbers: readonly string[] | undefined): string => {
  if (!numbers || numbers.length === 0) return ''
  const shown = numbers.slice(0, 5).join(', ')
  return ` (${shown}${numbers.length > 5 ? ` and ${numbers.length - 5} more` : ''})`
}

/**
 * What stops an entry from closing, in plain words (empty: it may close). The rules: a reason; the risk decided; the
 * corrective action recorded and done (art. 8(8)); distributors informed when garments it concerns have left for
 * customers (art. 8(4)); when the PPE may present a risk, the authorities told, with the date and their reference
 * (art. 8(8)).
 */
export function closeProblems(facts: CloseFacts): RegisterProblem[] {
  const { entry } = facts
  if (entry.status !== 'OPEN') return [{ code: 'CLOSED', message: 'This register entry is already closed.' }]
  const problems: RegisterProblem[] = []
  if (blank(facts.reason)) problems.push({ code: 'NO_REASON', message: 'Say why the entry is closed.' })
  if (entry.risk === 'ASSESSING') problems.push({ code: 'RISK_NOT_ASSESSED', message: 'Decide whether the PPE may present a risk (yes or no) before closing.' })
  if (blank(entry.actionTaken)) problems.push({ code: 'NO_CORRECTIVE_ACTION', message: `Record the corrective action taken, or why none is needed (${REGISTER_LAW.correctiveAction}).` })
  else if (entry.actionCompletedAt === null) problems.push({ code: 'CORRECTIVE_ACTION_NOT_DONE', message: 'Mark the corrective action as done before closing.' })
  if (facts.shippedGoods && entry.distributorsInformedAt === null) {
    problems.push({
      code: 'DISTRIBUTORS_NOT_INFORMED',
      message: `Garments this entry concerns have left for customers${listed(facts.shipmentNumbers)}: keep the distributors informed first (${REGISTER_LAW.distributors}).`,
    })
  }
  if (entry.risk === 'YES') {
    if (entry.authorityNotifiedAt === null) {
      problems.push({
        code: 'AUTHORITY_NOT_NOTIFIED',
        message: `The PPE may present a risk: tell the market surveillance authorities where it was made available, and record the date and their reference (${REGISTER_LAW.authority}).`,
      })
    } else if (blank(entry.authorityReference)) {
      problems.push({ code: 'AUTHORITY_REFERENCE_MISSING', message: "Record the authority's reference of the notice." })
    }
  }
  return problems
}

/** The machine (A1 §2.5): OPEN → CLOSED, guarded by closeProblems. CLOSED is final. */
export const registerEntryMachine = defineMachine<RegisterStatus, CloseFacts>({
  name: 'PPE register entry',
  states: REGISTER_STATUSES,
  transitions: { OPEN: ['CLOSED'] },
  guards: { CLOSED: (facts) => closeProblems(facts).map((problem) => problem.message) },
})

/** One duty of an open entry, for the record page and the register's tiles. */
export interface RegisterDuty {
  readonly code: 'RISK_ASSESSMENT' | 'CORRECTIVE_ACTION' | 'DISTRIBUTORS' | 'AUTHORITY'
  readonly done: boolean
  /** Whether the law asks it of this entry now (distributors: shipped goods; authority: a risk). */
  readonly required: boolean
  readonly law: string
}

/** The entry's duties and whether each is met. */
export function dutiesOf(entry: Pick<RegisterEntryState, 'risk' | 'actionTaken' | 'actionCompletedAt' | 'distributorsInformedAt' | 'authorityNotifiedAt' | 'authorityReference'>, shippedGoods: boolean): RegisterDuty[] {
  return [
    { code: 'RISK_ASSESSMENT', done: entry.risk !== 'ASSESSING', required: true, law: REGISTER_LAW.authority },
    { code: 'CORRECTIVE_ACTION', done: !blank(entry.actionTaken) && entry.actionCompletedAt !== null, required: true, law: REGISTER_LAW.correctiveAction },
    { code: 'DISTRIBUTORS', done: entry.distributorsInformedAt !== null, required: shippedGoods, law: REGISTER_LAW.distributors },
    { code: 'AUTHORITY', done: entry.authorityNotifiedAt !== null && !blank(entry.authorityReference), required: entry.risk === 'YES', law: REGISTER_LAW.authority },
  ]
}

/** The register's own reference while it has no number series (interim): `REG-<year>-<4 digits>`. */
export const REFERENCE_PREFIX = 'REG'
export function formatReference(year: string, value: number): string {
  return `${REFERENCE_PREFIX}-${year}-${String(value).padStart(4, '0')}`
}

/** The number of a reference of that year (`REG-2026-0007` → 7), or null for another form. */
export function referenceNumber(reference: string, year: string): number | null {
  const match = new RegExp(`^${REFERENCE_PREFIX}-${year}-(\\d{4,9})$`).exec(reference)
  return match ? Number.parseInt(match[1]!, 10) : null
}
