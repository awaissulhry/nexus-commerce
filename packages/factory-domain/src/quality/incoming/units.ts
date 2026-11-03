import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { isLengthUom, lengthIn, type LengthUom } from '../../inventory/rolls/rolls'
import { Dec, type Decimal } from '../../tax/decimal'
import { decisionShape, INCOMING_LIMITS, type DecisionDraft, type UnitDecision } from './rules'

/**
 * Rolls, components and goods back from a workshop at incoming inspection (B-W2b-111; QHS-032 "Fabric roll inspection
 * (4-point system)", QHS-033 "Component checks (armour, zips, hardware)", QHS-036 "Inspection of goods back from a
 * subcontractor"; design floor.incoming "Fabric rolls (4-point)": counters for 1-, 2-, 3- and 4-point defects, width and
 * length pads, points per 100 sq yd computed, accept or reject per roll; "Armour, zips, hardware": against spec and
 * certificate (EN 1621-1/-2), protector marking, size, type A or B; floor.kits "Finish receipt: goods go to inspection
 * before stock and before the workshop is paid"). Pure rules the API's commands apply before the database
 * (…_inspection_plans_w2b_guards' IncomingRollResult, IncomingComponentResult and IncomingInspection triggers stay the last
 * word: the database writes the points per 100 square yards itself).
 *
 *   rolls        the 4-point system on its own (no lays, no cut order: a roll is its tag or the supplier's number): the
 *                points of the four counters, per 100 square yards of the roll (width × length), against the limit a roll
 *                is accepted under (40 by default, the usual trade figure); the lot's points over the rolls looked at; a
 *                lot counted in a length (m, cm, mm) is decided in that length, and the rolls of the sample bind it.
 *   components   one row per check of the checklist: what was read (marking, a protector's type A or B and size), the
 *                certificate it was checked against, pieces looked at and those not right; what the row suggests.
 *   counters     the AQL counter of a lot not inspected hide by hide (units with a critical, major, minor defect).
 *   a workshop   the pieces back on a subcontract receipt, line by line (an operation and a bundle): the inspector
 *                rejects whole lines (bundles); the quantities follow (accepted = the good pieces of the lines kept;
 *                rejected = every defective piece and the good pieces of the lines rejected); nothing is left to sort.
 */

type Words = { readonly it: string; readonly en: string }

const DECIMAL2 = /^\d{1,10}(\.\d{1,2})?$/

// ---- the 4-point system (QHS-032) -----------------------------------------------------------------------------------------

/** Points per 100 square yards a roll is accepted under, unless the plan's buyer asks a stricter figure. */
export const FOUR_POINT_LIMIT = '40'
/** Square yards in a square metre (1 / 0.83612736), as the database counts them. */
export const SQ_YD_PER_M2 = '1.19599004630108'

export const ROLL_UNIT_LIMITS = Object.freeze({ rollRef: 60, counter: 9999, note: 500, widthCm: '1000', lengthM: '100000', rolls: 500 })

/** How the 4-point system scores a defect by its length (design floor.incoming: one counter per class). */
export const POINT_CLASSES = Object.freeze([
  { points: 1, it: 'fino a 7,5 cm (3")', en: 'up to 7.5 cm (3")' },
  { points: 2, it: 'da 7,5 a 15 cm (3"–6")', en: '7.5 to 15 cm (3"–6")' },
  { points: 3, it: 'da 15 a 23 cm (6"–9")', en: '15 to 23 cm (6"–9")' },
  { points: 4, it: 'oltre 23 cm (9"), o un buco', en: 'over 23 cm (9"), or a hole' },
])

export interface RollCounts {
  readonly onePoint: number
  readonly twoPoint: number
  readonly threePoint: number
  readonly fourPoint: number
}

/** The roll's points: 1 × ones + 2 × twos + 3 × threes + 4 × fours. */
export const pointsOf = (counts: RollCounts): number => counts.onePoint + 2 * counts.twoPoint + 3 * counts.threePoint + 4 * counts.fourPoint

/** The roll's square yards from its width (cm) and length (m). */
export const squareYardsOf = (widthCm: string, lengthM: string): Decimal => new Dec(widthCm).dividedBy(100).times(lengthM).times(SQ_YD_PER_M2)

/** Points per 100 square yards, at two decimals, exactly as the database writes it. */
export function pointsPer100SqYd(counts: RollCounts, widthCm: string, lengthM: string): string {
  const yards = squareYardsOf(widthCm, lengthM)
  if (yards.lessThanOrEqualTo(0)) return '0.00'
  return new Dec(pointsOf(counts)).times(100).dividedBy(yards).toFixed(2)
}

export interface RollDraft {
  readonly rollRef?: string | null | undefined
  readonly onePoint?: number | undefined
  readonly twoPoint?: number | undefined
  readonly threePoint?: number | undefined
  readonly fourPoint?: number | undefined
  /** Text, centimetres at two decimals; left out: the roll's own width when its tag is named. */
  readonly widthCm?: string | null | undefined
  /** Text, metres at two decimals; left out: the roll's own length when its tag is named. */
  readonly lengthM?: string | null | undefined
  readonly decision?: UnitDecision | null | undefined
  readonly note?: string | null | undefined
}

/** What is wrong with a roll's result as sent, in words (paths `<field>`). Width and length are checked once known. */
export function rollDraftProblems(draft: RollDraft): Issue[] {
  const problems: Issue[] = []
  const ref = draft.rollRef?.trim() ?? ''
  if (draft.rollRef !== undefined && draft.rollRef !== null && !ref) problems.push({ path: 'rollRef', message: "Name the roll: its tag or the supplier's roll number." })
  if (ref.length > ROLL_UNIT_LIMITS.rollRef) problems.push({ path: 'rollRef', message: `At most ${ROLL_UNIT_LIMITS.rollRef} characters.` })
  for (const key of ['onePoint', 'twoPoint', 'threePoint', 'fourPoint'] as const) {
    const value = draft[key]
    if (value !== undefined && !(Number.isInteger(value) && value >= 0 && value <= ROLL_UNIT_LIMITS.counter)) problems.push({ path: key, message: `A count of defects: a whole number from 0 to ${ROLL_UNIT_LIMITS.counter}.` })
  }
  const width = draft.widthCm?.trim() ?? ''
  if (width && !(DECIMAL2.test(width) && new Dec(width).greaterThan(0) && new Dec(width).lessThanOrEqualTo(ROLL_UNIT_LIMITS.widthCm))) problems.push({ path: 'widthCm', message: `The width in centimetres: above 0, at most ${ROLL_UNIT_LIMITS.widthCm}, with at most 2 decimals.` })
  const length = draft.lengthM?.trim() ?? ''
  if (length && !(DECIMAL2.test(length) && new Dec(length).greaterThan(0) && new Dec(length).lessThanOrEqualTo(ROLL_UNIT_LIMITS.lengthM))) problems.push({ path: 'lengthM', message: `The length in metres: above 0, at most ${ROLL_UNIT_LIMITS.lengthM}, with at most 2 decimals.` })
  if ((draft.note ?? '').length > ROLL_UNIT_LIMITS.note) problems.push({ path: 'note', message: `At most ${ROLL_UNIT_LIMITS.note} characters.` })
  return problems
}

/** What a roll's points say against the limit: the decision it suggests, in words. */
export function rollVerdict(points100: string, limit: string = FOUR_POINT_LIMIT): { readonly suggested: 'ACCEPTED' | 'REJECTED'; readonly over: boolean; readonly words: Words } {
  const value = new Dec(points100)
  const over = value.greaterThan(limit)
  const it = (n: string) => n.replace('.', ',')
  return over
    ? { suggested: 'REJECTED', over, words: { it: `${it(value.toFixed(2))} punti per 100 yd² oltre il limite di ${limit}: respingere il rotolo.`, en: `${value.toFixed(2)} points per 100 sq yd, over the limit of ${limit}: reject the roll.` } }
    : { suggested: 'ACCEPTED', over, words: { it: `${it(value.toFixed(2))} punti per 100 yd² entro il limite di ${limit}.`, en: `${value.toFixed(2)} points per 100 sq yd, within the limit of ${limit}.` } }
}

export interface RollFact extends RollCounts {
  readonly widthCm: string
  readonly lengthM: string
  readonly decision: UnitDecision | null
}

export interface RollSummary {
  readonly rolls: number
  readonly lengthM: string
  readonly squareYards: string
  readonly points: number
  /** Over every roll looked at (their points per 100 of their square yards together); null: no roll yet. */
  readonly pointsPer100SqYd: string | null
  readonly limit: string
  readonly over: number
  readonly accepted: number
  readonly rejected: number
  readonly toSort: number
  readonly undecided: number
  readonly words: Words
}

/** The rolls of the sample together: points over the square yards looked at, rolls over the limit, decisions. */
export function rollSummary(rolls: readonly RollFact[], limit: string = FOUR_POINT_LIMIT): RollSummary {
  const yards = rolls.reduce<Decimal>((sum, roll) => sum.plus(squareYardsOf(roll.widthCm, roll.lengthM)), new Dec(0))
  const length = rolls.reduce<Decimal>((sum, roll) => sum.plus(roll.lengthM), new Dec(0))
  const points = rolls.reduce((sum, roll) => sum + pointsOf(roll), 0)
  const over = rolls.filter((roll) => new Dec(pointsPer100SqYd(roll, roll.widthCm, roll.lengthM)).greaterThan(limit)).length
  const per100 = yards.greaterThan(0) ? new Dec(points).times(100).dividedBy(yards).toFixed(2) : null
  const count = (decision: UnitDecision | null) => rolls.filter((roll) => roll.decision === decision).length
  const n = rolls.length
  const words: Words =
    n === 0
      ? { it: 'Nessun rotolo controllato.', en: 'No roll inspected yet.' }
      : {
          it: `${n} ${n === 1 ? 'rotolo' : 'rotoli'} · ${length.toFixed(2).replace('.', ',')} m · ${per100!.replace('.', ',')} punti per 100 yd² (limite ${limit})${over > 0 ? ` · ${over} oltre il limite` : ''}.`,
          en: `${n} ${n === 1 ? 'roll' : 'rolls'} · ${length.toFixed(2)} m · ${per100} points per 100 sq yd (limit ${limit})${over > 0 ? ` · ${over} over the limit` : ''}.`,
        }
  return { rolls: n, lengthM: length.toFixed(2), squareYards: yards.toFixed(2), points, pointsPer100SqYd: per100, limit, over, accepted: count('ACCEPTED'), rejected: count('REJECTED'), toSort: count('TO_SORT'), undecided: count(null), words }
}

/** A lot inspected roll by roll: counted in a length (its rolls carry lengths in metres). */
export const isRollLot = (uom: string): uom is LengthUom => isLengthUom(uom)

/** "Inspect 3 rolls of lot 120 m · 1 done" (the sample of a lot counted in a length is a number of rolls). */
export function rollSampleWords(sampleSize: number, lotSize: string, uom: LengthUom, done: number | null): Words {
  const lot = new Dec(lotSize).toFixed()
  const symbol = uom.toLowerCase()
  const it = `Controlla ${sampleSize} ${sampleSize === 1 ? 'rotolo' : 'rotoli'} del lotto di ${lot.replace('.', ',')} ${symbol}`
  const en = `Inspect ${sampleSize} ${sampleSize === 1 ? 'roll' : 'rolls'} of the lot of ${lot} ${symbol}`
  if (done === null) return { it, en }
  return { it: `${it} · ${done} ${done === 1 ? 'fatto' : 'fatti'}`, en: `${en} · ${done} done` }
}

export interface RollDecisionFacts {
  readonly lotSize: string
  readonly uom: LengthUom
  readonly sampleSize: number
  readonly rolls: readonly Pick<RollFact, 'lengthM' | 'decision'>[]
}

/**
 * What the rolls of the sample ask of the decision of a lot counted in a length (QHS-034 with QHS-032), in words: never
 * less rejected (to sort) than the rolls rejected (to sort) measure, up to the lot; nothing accepted beyond the rolls
 * accepted until every roll of the sample is in.
 */
export function rollDecisionProblems(draft: Pick<DecisionDraft, 'accepted' | 'rejected' | 'toSort'>, facts: RollDecisionFacts): Issue[] {
  const problems: Issue[] = []
  const lot = new Dec(facts.lotSize)
  const lengthOf = (decision: UnitDecision) => facts.rolls.filter((roll) => roll.decision === decision).reduce<Decimal>((sum, roll) => sum.plus(lengthIn(roll.lengthM, 'M', facts.uom)), new Dec(0))
  const symbol = facts.uom.toLowerCase()
  const rejectedMin = Dec.min(lot, lengthOf('REJECTED'))
  const toSortMin = Dec.min(lot.minus(rejectedMin), lengthOf('TO_SORT'))
  const acceptedLength = lengthOf('ACCEPTED')
  const value = (text: string): Decimal | null => (/^\d{1,14}(\.\d{1,4})?$/.test(text.trim()) ? new Dec(text.trim()) : null)
  const accepted = value(draft.accepted)
  const rejected = value(draft.rejected)
  const toSort = value(draft.toSort)
  if (!accepted || !rejected || !toSort) return problems
  if (rejected.lessThan(rejectedMin)) problems.push({ path: 'rejected', message: `The rolls rejected in the sample measure ${rejectedMin.toFixed()} ${symbol}: reject at least that much.` })
  if (toSort.lessThan(toSortMin)) problems.push({ path: 'toSort', message: `The rolls to sort in the sample measure ${toSortMin.toFixed()} ${symbol}: sort at least that much.` })
  if (facts.rolls.length < facts.sampleSize && accepted.greaterThan(acceptedLength)) {
    problems.push({ path: 'accepted', message: `Inspect every roll of the sample (${facts.rolls.length} of ${facts.sampleSize} done) before accepting more than the rolls accepted (${acceptedLength.toFixed()} ${symbol}); reject or sort the rest now.` })
  }
  return problems
}

// ---- components (QHS-033) ------------------------------------------------------------------------------------------------

export const COMPONENT_KINDS = ['PROTECTOR', 'ZIP', 'REFLECTIVE', 'HARDWARE', 'OTHER'] as const
export type ComponentKind = (typeof COMPONENT_KINDS)[number]

/** EN 1621-1: type A (the smaller area) or B (the larger) for a limb protector (design: "type A or B"). */
export const PROTECTOR_TYPES = ['A', 'B'] as const

export const COMPONENT_WORDS: Readonly<Record<ComponentKind, Words>> = Object.freeze({
  PROTECTOR: { it: 'Protezione', en: 'Protector' },
  ZIP: { it: 'Cerniera', en: 'Zip' },
  REFLECTIVE: { it: 'Rifrangente', en: 'Reflective' },
  HARDWARE: { it: 'Minuteria', en: 'Hardware' },
  OTHER: { it: 'Altro', en: 'Other' },
})

export const COMPONENT_LIMITS = Object.freeze({ rows: 60, marking: 120, size: 20, note: 500, checked: 100000 })

export interface ComponentDraft {
  readonly kind: ComponentKind
  readonly marking?: string | null | undefined
  readonly protectorType?: string | null | undefined
  readonly size?: string | null | undefined
  readonly certificateId?: string | null | undefined
  readonly checkedQuantity: number
  readonly defectiveQuantity?: number | undefined
  readonly decision?: UnitDecision | null | undefined
  readonly note?: string | null | undefined
}

/** What is wrong with one component row as sent, in words. */
export function componentDraftProblems(draft: ComponentDraft): Issue[] {
  const problems: Issue[] = []
  if (!(COMPONENT_KINDS as readonly string[]).includes(draft.kind)) problems.push({ path: 'kind', message: 'A protector, a zip, a reflective, hardware or another component.' })
  const checked = draft.checkedQuantity
  const defective = draft.defectiveQuantity ?? 0
  if (!(Number.isInteger(checked) && checked >= 1 && checked <= COMPONENT_LIMITS.checked)) problems.push({ path: 'checkedQuantity', message: `Pieces looked at: a whole number from 1 to ${COMPONENT_LIMITS.checked}.` })
  else if (!(Number.isInteger(defective) && defective >= 0 && defective <= checked)) problems.push({ path: 'defectiveQuantity', message: `Pieces not right: a whole number from 0 up to the ${checked} looked at.` })
  const type = draft.protectorType?.trim() ?? ''
  if (type && draft.kind !== 'PROTECTOR') problems.push({ path: 'protectorType', message: 'Only a protector has a type (A or B).' })
  else if (type && !(PROTECTOR_TYPES as readonly string[]).includes(type)) problems.push({ path: 'protectorType', message: 'Type A or B, as marked on the protector (EN 1621-1).' })
  if ((draft.marking ?? '').trim().length > COMPONENT_LIMITS.marking) problems.push({ path: 'marking', message: `At most ${COMPONENT_LIMITS.marking} characters.` })
  if ((draft.size ?? '').trim().length > COMPONENT_LIMITS.size) problems.push({ path: 'size', message: `At most ${COMPONENT_LIMITS.size} characters.` })
  if ((draft.note ?? '').length > COMPONENT_LIMITS.note) problems.push({ path: 'note', message: `At most ${COMPONENT_LIMITS.note} characters.` })
  return problems
}

/** A protector's harmonised standard: EN 1621-1 (limbs) or EN 1621-2 (back), any edition. */
export const isEn1621 = (standard: string): boolean => /EN\s*1621-[12]\b/i.test(standard)

export interface CertificateFact {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly status: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
}

export const CERTIFICATE_CHECKS = ['VALID', 'NOT_IN_FORCE', 'NOT_EN_1621', 'MISSING', 'NOT_NEEDED'] as const
export type CertificateCheck = (typeof CERTIFICATE_CHECKS)[number]

/** The certificate a component was checked against, today: in force, not in force, not an EN 1621 one, none. */
export function certificateCheck(kind: ComponentKind, certificate: CertificateFact | null, today: BusinessDate): { readonly state: CertificateCheck; readonly words: Words } {
  if (!certificate) {
    return kind === 'PROTECTOR'
      ? { state: 'MISSING', words: { it: 'Nessun certificato EN 1621 indicato.', en: 'No EN 1621 certificate named.' } }
      : { state: 'NOT_NEEDED', words: { it: 'Nessun certificato richiesto.', en: 'No certificate needed.' } }
  }
  if (certificate.status !== 'VALID' || certificate.validFrom > today || certificate.validTo < today) {
    return { state: 'NOT_IN_FORCE', words: { it: `Il certificato ${certificate.number} non è in vigore oggi (${certificate.status}, ${certificate.validFrom} – ${certificate.validTo}).`, en: `Certificate ${certificate.number} is not in force today (${certificate.status}, ${certificate.validFrom} – ${certificate.validTo}).` } }
  }
  if (kind === 'PROTECTOR' && !isEn1621(certificate.standard)) {
    return { state: 'NOT_EN_1621', words: { it: `Il certificato ${certificate.number} è ${certificate.standard}, non EN 1621.`, en: `Certificate ${certificate.number} is ${certificate.standard}, not EN 1621.` } }
  }
  return { state: 'VALID', words: { it: `Certificato ${certificate.number} (${certificate.standard}) valido fino al ${certificate.validTo}.`, en: `Certificate ${certificate.number} (${certificate.standard}) is valid to ${certificate.validTo}.` } }
}

/** What a component row suggests, with its reasons in words: rejected when a piece is not right or a protector's certificate does not hold. */
export function componentVerdict(row: Pick<ComponentDraft, 'kind' | 'marking' | 'protectorType' | 'checkedQuantity' | 'defectiveQuantity'>, certificate: CertificateCheck): { readonly suggested: 'ACCEPTED' | 'REJECTED'; readonly reasons: readonly Words[] } {
  const reasons: Words[] = []
  const defective = row.defectiveQuantity ?? 0
  if (defective > 0) reasons.push({ it: `${defective} su ${row.checkedQuantity} non conformi.`, en: `${defective} of ${row.checkedQuantity} not right.` })
  if (row.kind === 'PROTECTOR') {
    if (certificate === 'MISSING') reasons.push({ it: 'Senza certificato EN 1621 la protezione non entra in un DPI.', en: 'Without an EN 1621 certificate the protector goes into no PPE garment.' })
    if (certificate === 'NOT_IN_FORCE') reasons.push({ it: 'Il certificato non è in vigore.', en: 'The certificate is not in force.' })
    if (certificate === 'NOT_EN_1621') reasons.push({ it: 'Il certificato non è EN 1621.', en: 'The certificate is not EN 1621.' })
    if (!row.marking?.trim()) reasons.push({ it: 'Leggi la marcatura (norma, livello, tipo).', en: 'Read the marking (standard, level, type).' })
    if (!row.protectorType?.trim()) reasons.push({ it: 'Indica il tipo A o B come marcato.', en: 'Say the type, A or B, as marked.' })
  } else if (certificate === 'NOT_IN_FORCE') reasons.push({ it: 'Il certificato indicato non è in vigore.', en: 'The certificate named is not in force.' })
  const rejects = defective > 0 || (row.kind === 'PROTECTOR' && certificate !== 'VALID') || certificate === 'NOT_IN_FORCE'
  return { suggested: rejects ? 'REJECTED' : 'ACCEPTED', reasons }
}

// ---- the AQL counter of a lot not inspected hide by hide ------------------------------------------------------------------

export interface CountersDraft {
  readonly critical: number
  readonly major: number
  readonly minor: number
}

/** Units of the sample with a critical, major or minor defect: whole numbers from 0 up to the sample. */
export function counterProblems(found: CountersDraft, sampleSize: number): Issue[] {
  const problems: Issue[] = []
  for (const key of ['critical', 'major', 'minor'] as const) {
    const value = found[key]
    if (!(Number.isInteger(value) && value >= 0 && value <= sampleSize)) problems.push({ path: `found/${key}`, message: `Units of the sample with a ${key} defect: a whole number from 0 to ${sampleSize}.` })
  }
  return problems
}

// ---- goods back from a workshop (QHS-036) ---------------------------------------------------------------------------------

export interface ReceiptLineFact {
  readonly id: string
  readonly seq: number
  readonly bundleCode: string | null
  readonly operationCode: string
  readonly good: number
  readonly defective: number
  readonly scrapped: number
}

/** The pieces a workshop receipt is inspected in: good and defective (what was scrapped there is not in the lot). */
export const receiptLotOf = (lines: readonly Pick<ReceiptLineFact, 'good' | 'defective'>[]): number => lines.reduce((sum, line) => sum + line.good + line.defective, 0)

/** The quantities when these lines (bundles) are rejected: accepted = good of the lines kept; rejected = the rest. */
export function receiptSplit(lines: readonly Pick<ReceiptLineFact, 'id' | 'good' | 'defective'>[], rejectedLineIds: ReadonlySet<string>): { readonly accepted: number; readonly rejected: number } {
  const accepted = lines.filter((line) => !rejectedLineIds.has(line.id)).reduce((sum, line) => sum + line.good, 0)
  return { accepted, rejected: receiptLotOf(lines) - accepted }
}

const lineName = (line: Pick<ReceiptLineFact, 'seq' | 'bundleCode' | 'operationCode'>): string => (line.bundleCode ? `bundle ${line.bundleCode}` : `line ${line.seq}`) + (line.operationCode ? ` (${line.operationCode})` : '')

/**
 * The lines a workshop receipt's decision rejects: the ones named; none named: none when the good pieces are all accepted,
 * all when the whole lot is rejected; else the decision must name them. Answers the lines or the problems in words.
 */
export function receiptDecision(draft: DecisionDraft & { readonly rejectedLines?: readonly string[] | undefined }, lines: readonly ReceiptLineFact[]): { readonly rejected: ReadonlySet<string>; readonly problems: readonly Issue[] } {
  const problems: Issue[] = []
  const lot = receiptLotOf(lines)
  const toSort = /^\d{1,14}(\.0{1,4})?$/.test(draft.toSort.trim()) ? Number(new Dec(draft.toSort.trim()).toFixed(0)) : null
  if (toSort !== 0) problems.push({ path: 'toSort', message: 'Goods back from a workshop are accepted or rejected bundle by bundle: nothing is left to sort.' })
  const known = new Map(lines.map((line) => [line.id, line]))
  let rejected = new Set<string>()
  if (draft.rejectedLines !== undefined) {
    draft.rejectedLines.forEach((id, index) => {
      if (!known.has(id)) problems.push({ path: `rejectedLines/${index}`, message: 'Not a line of this receipt with pieces to inspect.' })
      else if (rejected.has(id)) problems.push({ path: `rejectedLines/${index}`, message: `${lineName(known.get(id)!)} is named twice.` })
      rejected.add(id)
    })
  } else {
    const all = receiptSplit(lines, new Set())
    const shape = decisionShape(draft, String(lot))
    if (shape === 'WHOLE_REJECTED') rejected = new Set(lines.map((line) => line.id))
    else if (!(draft.accepted.trim() !== '' && new Dec(draft.accepted.trim()).equals(all.accepted))) {
      problems.push({ path: 'rejectedLines', message: 'Name the bundles (receipt lines) you reject: the quantities follow from them.' })
    }
  }
  if (problems.length > 0) return { rejected, problems }
  const split = receiptSplit(lines, rejected)
  const given = { accepted: draft.accepted.trim(), rejected: draft.rejected.trim() }
  if (!(/^\d+(\.0+)?$/.test(given.accepted) && new Dec(given.accepted).equals(split.accepted) && /^\d+(\.0+)?$/.test(given.rejected) && new Dec(given.rejected).equals(split.rejected))) {
    const named = lines.filter((line) => rejected.has(line.id)).map(lineName)
    problems.push({
      path: 'accepted',
      message: `${named.length === 0 ? 'With no bundle rejected' : `Rejecting ${named.join(', ')}`}, ${split.accepted} ${split.accepted === 1 ? 'piece is' : 'pieces are'} accepted and ${split.rejected} rejected (every defective piece is rejected).`,
    })
  }
  return { rejected, problems }
}

/** While the inspection is open: the receipt's pieces wait (no report at the operation, no fee, not in the invoice match). */
export function heldWords(pieces: number, number: string): Words {
  return {
    it: `${pieces} ${pieces === 1 ? 'pezzo attende' : 'pezzi attendono'} il controllo in accettazione ${number}: non passano all'operazione successiva e il terzista non è pagato finché non è deciso.`,
    en: `${pieces} ${pieces === 1 ? 'piece waits' : 'pieces wait'} for incoming inspection ${number}: they do not go on to the next operation and the workshop is not paid until it is decided.`,
  }
}

/** After the decision of a workshop receipt, in words: what goes on, what is paid, what is rejected. */
export function receiptNextWords(split: { readonly accepted: number; readonly rejected: number }, rejectedNames: readonly string[], cancelled = false): Words {
  if (cancelled) return { it: 'Ispezione annullata: i pezzi proseguono come ricevuti.', en: 'Inspection cancelled: the pieces go on as received.' }
  const it = [`${split.accepted} ${split.accepted === 1 ? 'pezzo accettato prosegue' : 'pezzi accettati proseguono'} all'operazione successiva e nel compenso del terzista`]
  const en = [`${split.accepted} accepted ${split.accepted === 1 ? 'piece goes' : 'pieces go'} on to the next operation and into the workshop's fee`]
  if (split.rejected > 0) {
    it.push(`${split.rejected} ${split.rejected === 1 ? 'respinto' : 'respinti'}${rejectedNames.length ? ` (${rejectedNames.join(', ')}: non dichiarati all'operazione, da rilavorare o rendere al terzista)` : ''}`)
    en.push(`${split.rejected} rejected${rejectedNames.length ? ` (${rejectedNames.join(', ')}: not reported at the operation; rework them or send them back to the workshop)` : ''}`)
  }
  return { it: `${it.join('; ')}.`, en: `${en.join('; ')}.` }
}

/** A note on an inspection is short. */
export const noteProblem = (note: string | null | undefined): Issue | null => ((note ?? '').length > INCOMING_LIMITS.note ? { path: 'note', message: `At most ${INCOMING_LIMITS.note} characters.` } : null)
