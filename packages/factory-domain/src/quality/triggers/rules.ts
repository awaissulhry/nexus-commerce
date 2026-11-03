import { createHash } from 'node:crypto'
import type { Issue } from '../../core/errors'
import { isUuid } from '../../core/ids'
import { CHIP_KIND_WORDS, chipsMatch, chipsProblems, FREQUENCIES, PLAN_LIMITS, type Chip, type ChipFacts, type ChipKind, type Frequency, type PlanStage } from '../plans/rules'

/**
 * Inspection triggers (B-W2b-101; QHS-010 plan assignment and triggers, QHS-011 inspection frequency; design quality.plans
 * "When inspections are created": "Ordered rules: when · for · plan · frequency" and the preview "This rule would have
 * created 14 inspections last month"). Pure rules, figures by hand in rules.vitest.test.ts. The database keeps the rule's
 * chips and its frequency's number (…_inspection_plans_w2b_guards InspectionTrigger_guard); everything else is said here.
 *
 *   a rule        a company's: WHEN (an event), FOR WHAT (the same chips as a plan's "Applies to"; none = everything),
 *                 WHICH PLAN (its APPROVED version is taken when the inspection opens) and HOW OFTEN; active or switched
 *                 off; a place in the company's list.
 *   the order     for each kind of record (an incoming inspection, a cutting check, a first piece, a roving check, an
 *                 end-of-line check) the FIRST rule in the list that fits the subject decides: it opens one when its
 *                 frequency picks the subject, else nothing of that kind opens. A broad rule at the end is the fallback
 *                 ("everything else: every 10th bundle"); rules of different kinds never shadow each other.
 *   fits          the rule's chips AND the plan's own chips (chipsMatch, B-W2b-92): a kind the event never knows fails
 *                 (a rule naming a material never fits a bundle scan), so such a chip is refused when the rule is saved.
 *   how often     every lot (each lot received; at an operation, once per work order: its first bundle), a share of the
 *                 operations (a fixed draw per rule, bundle and operation: unpredictable on the floor, the same on a
 *                 repeat and in the preview), the first piece (the first bundle at the operation; it holds the run until
 *                 approved, so it is opened only while that bundle is the only one scanned there), every Nth bundle
 *                 (the Nth, 2Nth … bundle at the operation of the work order).
 *
 * What each event can open now: goods received → an incoming inspection (a supplier's lot, or a workshop's receipt);
 * operation finished and bundle scanned → an in-process check (cutting, in-line, end of line). Packing (a final
 * inspection) and return received (no record yet) are held, in words: see EVENT_RULES.
 */

type Words = Readonly<{ it: string; en: string }>
const w = (it: string, en: string): Words => Object.freeze({ it, en })
const lang = (language: string): 'it' | 'en' => (language === 'it' ? 'it' : 'en')

export const TRIGGER_EVENTS = ['GOODS_RECEIPT', 'OPERATION_FINISHED', 'BUNDLE_SCAN', 'PACKING', 'RETURN_RECEIVED'] as const
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number]

export const EVENT_WORDS: Readonly<Record<TriggerEvent, Words>> = Object.freeze({
  GOODS_RECEIPT: w('Merce ricevuta', 'Goods received'),
  OPERATION_FINISHED: w('Operazione finita', 'Operation finished'),
  BUNDLE_SCAN: w("Pacco scansionato a un'operazione", 'Bundle scanned at an operation'),
  PACKING: w('Imballo', 'Packing'),
  RETURN_RECEIVED: w('Reso ricevuto', 'Return received'),
})

/** The kinds of record a rule opens: one decision per kind (see the order above). */
export const RECORD_KINDS = ['INCOMING', 'CUTTING', 'FIRST_PIECE', 'ROVING', 'END_OF_LINE'] as const
export type RecordKind = (typeof RECORD_KINDS)[number]

export const RECORD_KIND_WORDS: Readonly<Record<RecordKind, Words>> = Object.freeze({
  INCOMING: w('Ispezione in arrivo', 'Incoming inspection'),
  CUTTING: w('Controllo al taglio', 'Cutting check'),
  FIRST_PIECE: w('Primo capo', 'First piece'),
  ROVING: w('Controllo itinerante', 'Roving check'),
  END_OF_LINE: w('Controllo fine linea', 'End-of-line check'),
})

/** The record a rule of this plan stage and frequency opens; null: the stage has no record a rule may open. */
export function recordKindOf(stage: PlanStage, frequency: Frequency): RecordKind | null {
  switch (stage) {
    case 'INCOMING':
      return 'INCOMING'
    case 'CUTTING':
      return 'CUTTING'
    case 'END_OF_LINE':
      return 'END_OF_LINE'
    case 'IN_LINE':
      return frequency === 'FIRST_PIECE' ? 'FIRST_PIECE' : 'ROVING'
    default:
      return null
  }
}

export interface EventRule {
  /** The plan stages a rule of this event may name (none: the event cannot open a record yet). */
  readonly stages: readonly PlanStage[]
  readonly frequencies: readonly Frequency[]
  /** The chip kinds the event knows about its subject: a chip of another kind would never fit. */
  readonly chipKinds: readonly ChipKind[]
  /** Why a rule of this event cannot be kept yet, in words; null: it can. */
  readonly held: Words | null
  /** What the preview counts, in words ("lots received"). */
  readonly counts: Words
}

const IN_PROCESS: Pick<EventRule, 'stages' | 'frequencies' | 'chipKinds' | 'held'> = {
  stages: ['CUTTING', 'IN_LINE', 'END_OF_LINE'],
  frequencies: FREQUENCIES,
  chipKinds: ['STYLE', 'CATEGORY', 'OPERATION', 'CUSTOMER'],
  held: null,
}

export const EVENT_RULES: Readonly<Record<TriggerEvent, EventRule>> = Object.freeze({
  GOODS_RECEIPT: {
    stages: ['INCOMING'],
    frequencies: ['EVERY_LOT'],
    // A supplier's lot: material, its kind, the supplier. A workshop's receipt: the style, its kind, the workshop, the
    // operations it did, the work order's customers.
    chipKinds: ['STYLE', 'CATEGORY', 'MATERIAL', 'SUPPLIER', 'OPERATION', 'CUSTOMER'],
    held: null,
    counts: w('lotti ricevuti', 'lots received'),
  },
  OPERATION_FINISHED: { ...IN_PROCESS, counts: w('operazioni finite su un pacco', 'operations finished on a bundle') },
  BUNDLE_SCAN: { ...IN_PROCESS, counts: w("pacchi scansionati a un'operazione", 'bundles scanned at an operation') },
  PACKING: {
    stages: [],
    frequencies: [],
    chipKinds: [],
    held: w(
      "Non ancora: un'ispezione finale nomina il suo ispettore quando si apre, quindi una regola non può aprirla da sola. L'ispettore la apre al banco.",
      'Not yet: a final inspection names its inspector when it opens, so a rule cannot open one by itself. The inspector opens it at the bench.',
    ),
    counts: w('spedizioni imballate', 'shipments packed'),
  },
  RETURN_RECEIVED: {
    stages: [],
    frequencies: [],
    chipKinds: [],
    held: w(
      "Non ancora: un reso non ha un record d'ispezione; la sua valutazione resta sul reso.",
      'Not yet: a return has no inspection record; its grading stays on the return.',
    ),
    counts: w('resi ricevuti', 'returns received'),
  },
})

/** The outbox events each trigger event follows, and the scan kinds that count (a bundle's first one at an operation). */
export const SOURCE_EVENTS: Readonly<Record<TriggerEvent, readonly string[]>> = Object.freeze({
  GOODS_RECEIPT: ['inventory.receipt_posted', 'subcontract_order.received'],
  OPERATION_FINISHED: ['production.scan_recorded'],
  BUNDLE_SCAN: ['production.scan_recorded', 'production.operation_timed'],
  PACKING: [],
  RETURN_RECEIVED: [],
})
export const SCAN_KINDS: Readonly<Partial<Record<TriggerEvent, readonly string[]>>> = Object.freeze({
  OPERATION_FINISHED: ['REPORT'],
  BUNDLE_SCAN: ['START', 'REPORT'],
})

export const TRIGGER_LIMITS = Object.freeze({ rulesPerCompany: 200, everyNth: PLAN_LIMITS.everyNth, previewScans: 20_000, previewLots: 5_000 })

// ---- a rule -------------------------------------------------------------------------------------------------------------

export interface RuleDraft {
  readonly event: TriggerEvent
  /** The stage of the plan the rule names; null when the plan was not found (its own problem is told apart). */
  readonly stage: PlanStage | null
  readonly appliesTo: readonly Chip[]
  readonly frequency: Frequency
  readonly frequencyValue?: number | null | undefined
}

/** The frequency's number: a percent 1 to 100, an N from 1, or none (paths `frequencyValue`). */
export function frequencyValueProblems(frequency: Frequency, value: number | null | undefined): Issue[] {
  const n = value ?? null
  if (frequency === 'PERCENT_OF_OPERATIONS') return n === null || !Number.isInteger(n) || n < 1 || n > 100 ? [{ path: 'frequencyValue', message: 'A share of the operations is 1 to 100 %.' }] : []
  if (frequency === 'EVERY_NTH_BUNDLE') return n === null || !Number.isInteger(n) || n < 1 || n > TRIGGER_LIMITS.everyNth ? [{ path: 'frequencyValue', message: `Every Nth bundle: N is 1 to ${TRIGGER_LIMITS.everyNth}.` }] : []
  return n === null ? [] : [{ path: 'frequencyValue', message: 'This frequency takes no number.' }]
}

/** Every problem of a rule at once: the event can open something, the plan's stage fits it, chips, frequency. */
export function ruleProblems(draft: RuleDraft): Issue[] {
  const problems: Issue[] = []
  if (!(TRIGGER_EVENTS as readonly string[]).includes(draft.event)) return [{ path: 'event', message: 'Pick when the rule acts: goods received, operation finished or bundle scanned.' }]
  const rule = EVENT_RULES[draft.event]
  if (rule.held) return [{ path: 'event', message: rule.held.en }]
  if (draft.stage !== null && !rule.stages.includes(draft.stage)) {
    problems.push({ path: 'planId', message: draft.event === 'GOODS_RECEIPT' ? 'Goods received open an incoming inspection: pick an incoming plan.' : 'An operation or a bundle opens an in-process check: pick a cutting, in-line or end-of-line plan.' })
  }
  if (!(FREQUENCIES as readonly string[]).includes(draft.frequency) || !rule.frequencies.includes(draft.frequency)) {
    problems.push({ path: 'frequency', message: draft.event === 'GOODS_RECEIPT' ? 'Goods received are inspected lot by lot: every lot.' : 'Pick how often: every lot, a share of the operations, the first piece or every Nth bundle.' })
  } else {
    if (draft.frequency === 'FIRST_PIECE' && draft.stage !== null && draft.stage !== 'IN_LINE') problems.push({ path: 'frequency', message: 'The first piece is an in-line check: pick an in-line plan, or another frequency.' })
    problems.push(...frequencyValueProblems(draft.frequency, draft.frequencyValue))
  }
  problems.push(...chipsProblems(draft.appliesTo))
  draft.appliesTo.forEach((chip, index) => {
    if (rule.chipKinds.length > 0 && (CHIP_KIND_WORDS as Record<string, Words>)[chip.kind] && !rule.chipKinds.includes(chip.kind)) {
      problems.push({ path: `appliesTo/${index}/kind`, message: `${EVENT_WORDS[draft.event].en} does not know the ${CHIP_KIND_WORDS[chip.kind].en.toLowerCase()}: this chip would never fit.` })
    }
  })
  return problems
}

/** A new order of the company's rules: every rule once, nothing else (paths `order/<i>`). */
export function orderProblems(ids: readonly string[], existing: readonly string[]): Issue[] {
  const problems: Issue[] = []
  const known = new Set(existing)
  const seen = new Set<string>()
  ids.forEach((id, index) => {
    if (!isUuid(id) || !known.has(id)) problems.push({ path: `order/${index}`, message: 'Not a rule of this company.' })
    else if (seen.has(id)) problems.push({ path: `order/${index}`, message: 'This rule is in the list twice.' })
    seen.add(id)
  })
  const missing = existing.filter((id) => !seen.has(id))
  if (missing.length > 0) problems.push({ path: 'order', message: `The new order leaves out ${missing.length} ${missing.length === 1 ? 'rule' : 'rules'}: send the whole list.` })
  return problems
}

// ---- how often (QHS-011) ------------------------------------------------------------------------------------------------

/** One subject the event saw: its place among the bundles of its work order at the operation (1, 2, 3 …), and its key. */
export interface Occurrence {
  /** A lot received is always 1 (each lot is its own); a bundle: its place at the operation, by its first scan there. */
  readonly ordinal: number
  /** What the draw of a share is made on: the bundle and the operation (a repeat and the preview draw the same). */
  readonly sampleKey: string
}

/** The draw of a share: 0 to 9 999, fixed for a rule and a subject, spread evenly. */
export function drawOf(ruleId: string, sampleKey: string): number {
  return Number.parseInt(createHash('sha256').update(`${ruleId}|${sampleKey}`, 'utf8').digest('hex').slice(0, 8), 16) % 10_000
}

/** Does the rule's frequency pick this subject? */
export function selects(rule: { readonly id: string; readonly frequency: Frequency; readonly frequencyValue: number | null }, occurrence: Occurrence): boolean {
  switch (rule.frequency) {
    case 'EVERY_LOT':
    case 'FIRST_PIECE':
      return occurrence.ordinal === 1
    case 'EVERY_NTH_BUNDLE':
      return rule.frequencyValue !== null && rule.frequencyValue >= 1 && occurrence.ordinal % rule.frequencyValue === 0
    case 'PERCENT_OF_OPERATIONS':
      return rule.frequencyValue !== null && drawOf(rule.id, occurrence.sampleKey) < rule.frequencyValue * 100
    default:
      return false
  }
}

/** Each frequency as the rule form offers it, before its number is typed. */
export const FREQUENCY_FORM_WORDS: Readonly<Record<Frequency, Words>> = Object.freeze({
  EVERY_LOT: w('Ogni lotto', 'Every lot'),
  PERCENT_OF_OPERATIONS: w('x% delle operazioni', 'x% of operations'),
  FIRST_PIECE: w('Primo capo', 'First piece'),
  EVERY_NTH_BUNDLE: w('Un pacco ogni N', 'Every Nth bundle'),
})

const englishOrdinal = (n: number): string => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`
}

/** How often, in words: "Every lot", "10% of operations", "First piece", "Every 5th bundle". */
export function frequencyText(frequency: Frequency, value: number | null | undefined, language: string): string {
  const l = lang(language)
  const n = value ?? 0
  switch (frequency) {
    case 'EVERY_LOT':
      return l === 'it' ? 'Ogni lotto' : 'Every lot'
    case 'PERCENT_OF_OPERATIONS':
      return l === 'it' ? `${n}% delle operazioni` : `${n}% of operations`
    case 'FIRST_PIECE':
      return l === 'it' ? 'Primo capo' : 'First piece'
    case 'EVERY_NTH_BUNDLE':
      if (n === 1) return l === 'it' ? 'Ogni pacco' : 'Every bundle'
      return l === 'it' ? `Un pacco ogni ${n}` : `Every ${englishOrdinal(n)} bundle`
    default:
      return String(frequency)
  }
}

// ---- the order: which rule decides ---------------------------------------------------------------------------------------

export interface RuleFacts {
  readonly id: string
  readonly sortOrder: number
  readonly recordKind: RecordKind
  readonly chips: readonly Chip[]
  /** The plan's own "Applies to". */
  readonly planChips: readonly Chip[]
}

/** The company's rules in their order: by place, then by id (two rules at one place keep a fixed order). */
export const inOrder = <T extends { readonly id: string; readonly sortOrder: number }>(rules: readonly T[]): T[] => [...rules].sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

export interface Decision<T extends RuleFacts = RuleFacts> {
  readonly rule: T
  /** The chips that matched, the rule's then the plan's: "applies because …". */
  readonly because: readonly Chip[]
}

/** For each kind of record, the first rule (in order) whose chips and plan's chips fit the facts. */
export function decide<T extends RuleFacts>(rules: readonly T[], facts: ChipFacts): Map<RecordKind, Decision<T>> {
  const decided = new Map<RecordKind, Decision<T>>()
  for (const rule of inOrder(rules)) {
    if (decided.has(rule.recordKind)) continue
    const own = chipsMatch(rule.chips, facts)
    if (!own.matches) continue
    const plan = chipsMatch(rule.planChips, facts)
    if (!plan.matches) continue
    decided.set(rule.recordKind, { rule, because: [...own.because, ...plan.because] })
  }
  return decided
}

/** "applies because: category Jackets, customer P1 Moto" (labels from the caller), or "applies to everything". */
export function becauseText(because: readonly { readonly kind: ChipKind; readonly label: string }[], language: string): string {
  const l = lang(language)
  if (because.length === 0) return l === 'it' ? 'si applica a tutto' : 'applies to everything'
  const parts = because.map((chip) => `${CHIP_KIND_WORDS[chip.kind][l].toLowerCase()} ${chip.label}`)
  return `${l === 'it' ? 'si applica perché' : 'applies because'}: ${parts.join(', ')}`
}

// ---- scans: a bundle's first scan at an operation ------------------------------------------------------------------------

export interface ScanFact {
  readonly id: string
  readonly workOrderId: string
  readonly workOrderOperationId: string
  readonly bundleId: string
  readonly kind: string
  /** The server time (ISO, or a Date): scans are taken in this order, then by id. */
  readonly at: string | Date
}

export interface ScanOccurrence extends Occurrence {
  readonly scanId: string
  readonly workOrderId: string
  readonly workOrderOperationId: string
  readonly bundleId: string
  readonly at: string | Date
}

const timeOf = (value: string | Date): number => (typeof value === 'string' ? Date.parse(value) : value.getTime())

/**
 * Each bundle's FIRST scan of `kinds` at each operation of each work order, numbered 1, 2, 3 … in the order the bundles
 * reached the operation. Later scans of a bundle already counted there (a report after an undo, a resume) count nothing.
 */
export function occurrencesOf(scans: readonly ScanFact[], kinds: readonly string[]): ScanOccurrence[] {
  const wanted = new Set(kinds)
  const ordered = scans.filter((scan) => wanted.has(scan.kind)).sort((a, b) => timeOf(a.at) - timeOf(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const counted = new Map<string, Set<string>>()
  const found: ScanOccurrence[] = []
  for (const scan of ordered) {
    const group = `${scan.workOrderId}|${scan.workOrderOperationId}`
    const bundles = counted.get(group) ?? new Set<string>()
    counted.set(group, bundles)
    if (bundles.has(scan.bundleId)) continue
    bundles.add(scan.bundleId)
    found.push({ scanId: scan.id, workOrderId: scan.workOrderId, workOrderOperationId: scan.workOrderOperationId, bundleId: scan.bundleId, at: scan.at, ordinal: bundles.size, sampleKey: `${scan.bundleId}|${scan.workOrderOperationId}` })
  }
  return found
}

// ---- why a rule opened nothing (kept on the rule's audit trail) ----------------------------------------------------------

export const SKIP_REASONS = ['ALREADY_OPEN', 'FIRST_PIECE_DONE', 'FIRST_PIECE_LATE', 'NO_APPROVED_VERSION', 'NO_SERIES', 'LOT_NOT_COUNTED', 'LOT_EMPTY'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

/** Why nothing was opened, in words (the subject's words come from the caller). */
export function skipWords(reason: SkipReason, facts: { readonly subject: string; readonly plan?: string; readonly count?: number; readonly uom?: string }): Words {
  switch (reason) {
    case 'ALREADY_OPEN':
      return w(`${facts.subject}: c'è già un controllo aperto dello stesso tipo; non se ne apre un secondo.`, `${facts.subject}: a check of the same kind is open already; a second one is never opened.`)
    case 'FIRST_PIECE_DONE':
      return w(`${facts.subject}: il primo capo ha già il suo controllo (in attesa o approvato); la produzione non si ferma di nuovo.`, `${facts.subject}: its first piece has a check already (waiting or approved); the run is not held again.`)
    case 'FIRST_PIECE_LATE':
      return w(
        `${facts.subject}: la produzione era andata avanti (${facts.count ?? 0} pacchi scansionati all'operazione) prima che la regola potesse fermarla; il primo capo si controlla prima, quindi non è stato aperto.`,
        `${facts.subject}: the run had gone on (${facts.count ?? 0} bundles scanned at the operation) before the rule could hold it; a first piece is checked before the run, so none was opened.`,
      )
    case 'NO_APPROVED_VERSION':
      return w(`Il piano ${facts.plan ?? ''} non ha una versione approvata: nessun controllo aperto per ${facts.subject}.`, `Plan ${facts.plan ?? ''} has no approved version: no check opened for ${facts.subject}.`)
    case 'NO_SERIES':
      return w(`L'azienda non ha la serie dei numeri delle ispezioni in arrivo: nessuna ispezione aperta per ${facts.subject}. Un amministratore la imposta in Numerazione.`, `The company has no incoming inspection number series: no inspection opened for ${facts.subject}. An admin sets it up under numbering.`)
    case 'LOT_NOT_COUNTED':
      return w(
        `${facts.subject} è in ${facts.uom ?? '?'}: un campione AQL conta unità (pelli, rotoli, pezzi). Date al piano un campione fisso.`,
        `${facts.subject} is in ${facts.uom ?? '?'}: an AQL sample counts units (hides, rolls, pieces). Give the plan a fixed sample.`,
      )
    case 'LOT_EMPTY':
      return w(`${facts.subject} non ha quantità da ispezionare.`, `${facts.subject} has nothing to inspect.`)
    default:
      return w(String(reason), String(reason))
  }
}

// ---- the preview ---------------------------------------------------------------------------------------------------------

export interface PreviewCounts {
  readonly event: TriggerEvent
  /** The subjects the event saw in the window (lots received, bundles finished or scanned at an operation). */
  readonly considered: number
  /** Those the rule and its plan fit. */
  readonly fits: number
  /** Of those, the ones an earlier rule of the same kind took. */
  readonly earlier: number
  /** What the rule would have opened. */
  readonly opened: number
  /** Business days, YYYY-MM-DD. */
  readonly from: string
  readonly to: string
  /** More subjects than the preview reads: the numbers are a floor. */
  readonly truncated: boolean
}

/** "This rule would have created 14 inspections in the last month (2026-10-04 – 2026-11-03): 40 of 120 lots received fit it." */
export function previewWords(counts: PreviewCounts, language: string): string {
  const l = lang(language)
  const counted = EVENT_RULES[counts.event].counts[l]
  const n = counts.opened
  if (l === 'it') {
    const head = `Questa regola avrebbe creato ${counts.truncated ? 'almeno ' : ''}${n} ${n === 1 ? 'ispezione' : 'ispezioni'} nell'ultimo mese (${counts.from} – ${counts.to})`
    const earlier = counts.earlier > 0 ? `; ${counts.earlier} ${counts.earlier === 1 ? 'è andato' : 'sono andati'} a una regola precedente` : ''
    return `${head}: ${counts.fits} su ${counts.considered} ${counted} le corrispondono${earlier}.`
  }
  const head = `This rule would have created ${counts.truncated ? 'at least ' : ''}${n} ${n === 1 ? 'inspection' : 'inspections'} in the last month (${counts.from} – ${counts.to})`
  const earlier = counts.earlier > 0 ? `; ${counts.earlier} went to an earlier rule` : ''
  return `${head}: ${counts.fits} of ${counts.considered} ${counted} fit it${earlier}.`
}
