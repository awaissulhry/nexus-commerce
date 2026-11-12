import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { isOpenStage, type SampleDecision, type SampleKind, type SampleStage } from '../samples/rules'

/**
 * Sample decisions (B-W2b-252; SAL-312 the approval record, SAL-314 leather swatch and colour approval, PRD-070 sample
 * measurement entry, PRD-158 certification test samples; design products.samples › the round's "Fit & comments" and
 * "Approval" tabs, "Decide on the sample"), pure. factory-db samples.prisma (B-W2b-212) keeps the rows and its
 * …_changes_samples_w2b_guards triggers repeat every rule below for every login; this file says each refusal FIRST, in
 * words, so a person never meets the database's message.
 *
 *   decision      a round is decided once: APPROVED, APPROVED_WITH_COMMENTS or REJECTED (comments say why for the last two),
 *                 on its pinned revision, recorded by the office (OFFICE: who recorded it) or the brand's answer to its
 *                 approval request of kind SAMPLE (PORTAL: the partner person; LINK: the link, nobody named). Its stage goes
 *                 DECIDED with it. While the brand is asked (an OPEN request), the office does not decide over it: it
 *                 withdraws the request first. A rejected round may be followed by the next round of its kind.
 *   swatches      a colour or leather swatch is sent to the brand once, then asked (COLOUR or LEATHER request) or decided in
 *                 the office, once. What was sent (the colour, the lot) changes only until it is sent.
 *   fit           per point of measure of the round's revision spec and size of the round: the nominal and tolerances frozen
 *                 from the spec when the value is first written, the measured value, its difference, inside or outside
 *                 the tolerance (inclusive bounds, as the database checks it), a note; fit comments per point or body
 *                 area with photos (StoredFile of record type SampleComment). Written only while the round is open.
 *   certification a CE test sample (CERTIFICATION round) has the sizes and zones sent to the notified body (B-W2b-246's
 *                 testZones), then the body's result and the certificate it led to, each written once (also after the
 *                 decision), the certificate one that covers the round's style.
 */

export const DECISION_LIMITS = Object.freeze({
  comments: 4000,
  fitNote: 1000,
  commentText: 2000,
  bodyArea: 100,
  swatchNote: 500,
  /** Fit cells saved at once (a pasted column of the grid). */
  fitCells: 600,
  list: 200,
})

/** What each decision is called. */
export const DECISION_WORDS: Readonly<Record<SampleDecision, { readonly it: string; readonly en: string }>> = Object.freeze({
  APPROVED: { it: 'Approvato', en: 'Approved' },
  APPROVED_WITH_COMMENTS: { it: 'Approvato con commenti', en: 'Approved with comments' },
  REJECTED: { it: 'Respinto', en: 'Rejected' },
})

/** The brand's answer to its approval request, as the round's or swatch's decision (the database's own mapping). */
export function decisionOfAnswer(status: string): SampleDecision | null {
  if (status === 'APPROVED') return 'APPROVED'
  if (status === 'APPROVED_WITH_CHANGES') return 'APPROVED_WITH_COMMENTS'
  if (status === 'REFUSED') return 'REJECTED'
  return null
}

/** Every refusal of the module, a code with its words (a 409 whose issue is `refusal/<CODE>`). */
export const DECISION_REFUSALS = [
  'ROUND_CLOSED',
  'NOTHING_MADE',
  'BRAND_ASKED',
  'INTERNAL_ROUND',
  'NOT_REJECTED',
  'CERTIFICATION_ONLY',
  'RESULT_ONCE',
  'CERTIFICATE_ONCE',
  'CERTIFICATE_NOT_COVERING',
  'NOTHING_TO_RECORD',
  'FIT_CLOSED',
  'NO_SPEC',
  'POINT_NOT_IN_SPEC',
  'SIZE_NOT_IN_ROUND',
  'SWATCH_NOT_SENT',
  'SWATCH_DECIDED',
  'SWATCH_SENT',
  'SENT_ONCE',
  'SWATCH_ROUND_CANCELLED',
  'SWATCH_KIND',
  'LEATHER_ONLY',
  'NOT_THE_ROUNDS_PARTY',
  'NO_COMPANY',
] as const
export type DecisionRefusalCode = (typeof DECISION_REFUSALS)[number]
export interface DecisionRefusal {
  readonly code: DecisionRefusalCode
  readonly message: string
}
const refusal = (code: DecisionRefusalCode, message: string): DecisionRefusal => ({ code, message })

export interface DecidableRound {
  readonly number: string
  readonly stage: SampleStage
  readonly partyId: string | null
}

/** An approval request that waits for the brand (OPEN), as the refusals name it. */
export interface WaitingRequest {
  readonly dueAt: Date
}

const day = (value: Date): string => value.toISOString().slice(0, 10)
const closedWords = (round: { readonly number: string; readonly stage: SampleStage }): string => `Sample round ${round.number} is ${round.stage === 'DECIDED' ? 'decided' : 'cancelled'}`

/** Why the office cannot record a round's decision now (null: it can). */
export function decisionRefusal(round: DecidableRound, waiting: WaitingRequest | null): DecisionRefusal | null {
  if (!isOpenStage(round.stage)) return refusal('ROUND_CLOSED', `${closedWords(round)}: its decision is recorded once.`)
  if (round.stage === 'REQUESTED') return refusal('NOTHING_MADE', `Sample round ${round.number} is only requested: it is decided once its sample is made (move it on, or make its sample work order).`)
  if (waiting) return refusal('BRAND_ASKED', `Sample round ${round.number} waits for the brand's answer (by ${day(waiting.dueAt)}): withdraw the request first, then record the decision.`)
  return null
}

/** Why the brand cannot be asked to decide the round now (null: it can). */
export function askRefusal(round: DecidableRound, waiting: WaitingRequest | null): DecisionRefusal | null {
  if (!isOpenStage(round.stage)) return refusal('ROUND_CLOSED', `${closedWords(round)}: nobody is asked to decide it.`)
  if (round.partyId === null) return refusal('INTERNAL_ROUND', `Sample round ${round.number} is internal: record the decision yourself (Decide on the sample).`)
  if (round.stage === 'REQUESTED') return refusal('NOTHING_MADE', `Sample round ${round.number} is only requested: the brand is asked once its sample is made.`)
  if (waiting) return refusal('BRAND_ASKED', `The brand is asked already (answer by ${day(waiting.dueAt)}).`)
  return null
}

/** Why the brand's answer is not taken on this round any more (null: it is), in the reader's words. */
export function answerHeldWords(round: { readonly stage: SampleStage; readonly approvalRequestId: string | null }, requestId: string, locale: 'it' | 'en'): string | null {
  if (round.stage === 'DECIDED') return locale === 'it' ? 'Questo campione è già stato deciso.' : 'This sample is decided already.'
  if (round.stage === 'CANCELLED') return locale === 'it' ? 'Questo giro di campioni è stato annullato.' : 'This sample round was cancelled.'
  if (round.approvalRequestId !== null && round.approvalRequestId !== requestId) return locale === 'it' ? 'Vi abbiamo mandato una richiesta più recente per questo campione.' : 'We sent you a newer request for this sample.'
  return null
}

/** "Make round 3": only after a rejection. */
export function nextRoundRefusal(round: { readonly number: string; readonly decision: SampleDecision | null }): DecisionRefusal | null {
  return round.decision === 'REJECTED' ? null : refusal('NOT_REJECTED', `Sample round ${round.number} is ${round.decision === null ? 'not decided' : DECISION_WORDS[round.decision].en.toLowerCase()}: the next round follows a rejection (ask for a new round otherwise).`)
}

/** What a decision must say (400 at the field): the comments for APPROVED_WITH_COMMENTS and REJECTED. */
export function decisionProblems(decision: SampleDecision, comments: string | null | undefined, path = 'body/comments'): Issue[] {
  if ((decision === 'APPROVED_WITH_COMMENTS' || decision === 'REJECTED') && !comments?.trim()) {
    return [{ path, message: decision === 'REJECTED' ? 'Say why it is rejected.' : 'Say what the comments are.' }]
  }
  return []
}

// ---- certification (PRD-158) ---------------------------------------------------------------------------------------------

export interface CertificationFacts {
  readonly number: string
  readonly kind: SampleKind
  readonly testResult: string | null
  readonly certificateId: string | null
}

/** Why the notified body's result or the certificate cannot be recorded (null: they can). Each is written once. */
export function testResultRefusal(round: CertificationFacts, change: { readonly testResult?: string | undefined; readonly certificateId?: string | undefined }): DecisionRefusal | null {
  if (round.kind !== 'CERTIFICATION') return refusal('CERTIFICATION_ONLY', `Sample round ${round.number} is not a CE test sample: only a certification round has a test result and a certificate.`)
  const result = change.testResult !== undefined && change.testResult !== round.testResult
  const certificate = change.certificateId !== undefined && change.certificateId !== round.certificateId
  if (result && round.testResult !== null) return refusal('RESULT_ONCE', `The notified body's result of sample round ${round.number} is recorded (${round.testResult.toLowerCase()}): it stays as it was.`)
  if (certificate && round.certificateId !== null) return refusal('CERTIFICATE_ONCE', `Sample round ${round.number} names its certificate already: it stays as it was.`)
  if (!result && !certificate) return refusal('NOTHING_TO_RECORD', `Sample round ${round.number} already holds this: say the result or the certificate to record.`)
  return null
}

/** The certificate a CE test sample led to covers the round's style (a coverage row of the style). */
export const certificateCoverRefusal = (certificateNumber: string, styleCode: string): DecisionRefusal =>
  refusal('CERTIFICATE_NOT_COVERING', `Certificate ${certificateNumber} does not cover style ${styleCode}: add the style to its coverage (Compliance › Certificates) first.`)

// ---- the fit (PRD-070) ----------------------------------------------------------------------------------------------------

/** Why the fit of a round is not written now (null: it is): only while the round is open. */
export function fitRefusal(round: { readonly number: string; readonly stage: SampleStage }): DecisionRefusal | null {
  return isOpenStage(round.stage) ? null : refusal('FIT_CLOSED', `${closedWords(round)}: its fit and comments are kept as they were.`)
}

export const noSpecRefusal = (revision: number): DecisionRefusal =>
  refusal('NO_SPEC', `Revision ${revision} has no measurement spec: start one (Products › Styles › Sizes & measurements) before measuring the fit against it.`)

export const pointRefusal = (code: string, size: string, revision: number): DecisionRefusal =>
  refusal('POINT_NOT_IN_SPEC', `The measurement spec of revision ${revision} has no value for ${code} in size ${size}: add it to the spec first.`)

/** A fit comment about a point names one of the revision spec's points. */
export const specPointRefusal = (code: string, revision: number): DecisionRefusal =>
  refusal('POINT_NOT_IN_SPEC', `${code} is not a point of the measurement spec of revision ${revision}: comment on one of its points, or on a body area.`)

/**
 * B-W2b-284: a point id that is none of the spec's points (an unknown id too: SampleMeasurement / SampleComment.pointOfMeasureId
 * are foreign keys since W2b-5 wave 34, so the module reads the points from the spec alone, no library look-up of its own).
 */
export const notASpecPointRefusal = (revision: number): DecisionRefusal =>
  refusal('POINT_NOT_IN_SPEC', `That point of measure is not in the measurement spec of revision ${revision}: pick one of its points.`)

export const sizeRefusal = (size: string, number: string): DecisionRefusal => refusal('SIZE_NOT_IN_ROUND', `Size ${size} is not made in sample round ${number}: measure one of its sizes.`)

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 })

/** A measure as stored (Decimal(8,2)), above 0, written plainly ("65.8"). */
export const MEASURED = /^\d{1,6}(?:\.\d{1,2})?$/

export function measuredProblems(value: string, path: string): Issue[] {
  const text = value.trim()
  if (!MEASURED.test(text) || !fitsDecimal(text, 8, 2)) return [{ path, message: 'A measure with at most 6 digits and 2 decimals ("65.8").' }]
  if (!new D(text).gt(0)) return [{ path, message: 'A measure above 0.' }]
  return []
}

/** Written plainly, without trailing zeros: "65.80" → "65.8". */
export function plain(value: string | { toString(): string }): string {
  const text = new D(value.toString()).toFixed()
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
  return trimmed === '-0' ? '0' : trimmed
}

/** Inside the tolerance: nominal − minus ≤ measured ≤ nominal + plus (both bounds included, as the database checks it). */
export function passOf(measured: string, nominal: string, minus: string, plus: string): boolean {
  const value = new D(measured)
  return value.gte(new D(nominal).minus(new D(minus))) && value.lte(new D(nominal).plus(new D(plus)))
}

/** measured − nominal, signed ("+1.3", "-0.5", "0"). */
export function differenceOf(measured: string, nominal: string): string {
  const difference = new D(measured).minus(new D(nominal))
  return difference.gt(0) ? `+${plain(difference)}` : plain(difference)
}

/** "SLEEVE_LEN 52: 65.8 cm, 1.3 over 64.5 −1/+1" — a value outside its tolerance, listed above the grid. */
export function outsideWords(cell: { readonly pomCode: string; readonly size: string; readonly measured: string; readonly nominal: string; readonly toleranceMinus: string; readonly tolerancePlus: string; readonly uom: string }): string {
  const unit = cell.uom.toLowerCase()
  const difference = new D(cell.measured).minus(new D(cell.nominal))
  const how = `${plain(difference.abs())} ${difference.gt(0) ? 'over' : 'under'}`
  const band = plain(cell.toleranceMinus) === plain(cell.tolerancePlus) ? `± ${plain(cell.tolerancePlus)}` : `−${plain(cell.toleranceMinus)}/+${plain(cell.tolerancePlus)}`
  return `${cell.pomCode} ${cell.size}: ${plain(cell.measured)} ${unit}, ${how} ${plain(cell.nominal)} ${band}`
}

// ---- swatches (SAL-314) ---------------------------------------------------------------------------------------------------

export const SWATCH_KINDS = ['COLOUR', 'LEATHER'] as const
export type SwatchKind = (typeof SWATCH_KINDS)[number]

export interface SwatchFacts {
  readonly kind: SwatchKind
  readonly sentAt: Date | null
  readonly decision: SampleDecision | null
}

/** What was sent (its colour, its lot) changes only until it is sent; it is removed only before. */
export function swatchSentRefusal(swatch: SwatchFacts, what: 'change' | 'remove'): DecisionRefusal | null {
  if (swatch.sentAt === null) return null
  return refusal('SWATCH_SENT', what === 'remove' ? 'The swatch was sent: it is kept (only a swatch not sent yet is removed).' : 'The swatch was sent: what was sent (its colour, its lot) stays as it was.')
}

export function swatchSentOnceRefusal(swatch: SwatchFacts, sentAt: Date): DecisionRefusal | null {
  return swatch.sentAt !== null && swatch.sentAt.getTime() !== sentAt.getTime() ? refusal('SENT_ONCE', 'The swatch was already sent: when it was sent stays as it was.') : null
}

/** Why a swatch's decision cannot be recorded in the office now (null: it can). */
export function swatchDecisionRefusal(swatch: SwatchFacts, waiting: WaitingRequest | null): DecisionRefusal | null {
  if (swatch.decision !== null) return refusal('SWATCH_DECIDED', `The swatch is decided (${DECISION_WORDS[swatch.decision].en.toLowerCase()}): its decision is recorded once.`)
  if (swatch.sentAt === null) return refusal('SWATCH_NOT_SENT', 'The swatch is not sent yet: it is decided once the brand has it.')
  if (waiting) return refusal('BRAND_ASKED', `The swatch waits for the brand's answer (by ${day(waiting.dueAt)}): withdraw the request first, then record the decision.`)
  return null
}

/** Why the brand cannot be asked about a swatch now (null: it can); `asked`: the request's kind (COLOUR or LEATHER). */
export function swatchAskRefusal(swatch: SwatchFacts, asked: string, waiting: WaitingRequest | null): DecisionRefusal | null {
  if (asked !== swatch.kind) return refusal('SWATCH_KIND', `This is a ${swatch.kind.toLowerCase()} swatch: ask with ${swatch.kind === 'LEATHER' ? 'Leather' : 'Colour'}.`)
  if (swatch.decision !== null) return refusal('SWATCH_DECIDED', `The swatch is decided (${DECISION_WORDS[swatch.decision].en.toLowerCase()}): nobody is asked again.`)
  if (swatch.sentAt === null) return refusal('SWATCH_NOT_SENT', 'The swatch is not sent yet: send it, then ask the brand.')
  if (waiting) return refusal('BRAND_ASKED', `The brand is asked already (answer by ${day(waiting.dueAt)}).`)
  return null
}

/** The brand's answer is no longer taken on this swatch (null: it is). */
export function swatchAnswerHeldWords(swatch: { readonly decision: string | null; readonly approvalRequestId: string | null }, requestId: string, locale: 'it' | 'en'): string | null {
  if (swatch.decision !== null) return locale === 'it' ? 'Questo campione di colore o pellame è già stato deciso.' : 'This swatch is decided already.'
  if (swatch.approvalRequestId !== null && swatch.approvalRequestId !== requestId) return locale === 'it' ? 'Vi abbiamo mandato una richiesta più recente per questo campione.' : 'We sent you a newer request for this swatch.'
  return null
}

/** A swatch of a round goes to that round's brand; a cancelled round takes none. */
export function swatchRoundRefusal(round: { readonly number: string; readonly stage: SampleStage; readonly partyId: string | null }, partyId: string): DecisionRefusal | null {
  if (round.stage === 'CANCELLED') return refusal('SWATCH_ROUND_CANCELLED', `Sample round ${round.number} is cancelled: attach the swatch to the style, or to another round.`)
  if (round.partyId !== null && round.partyId !== partyId) return refusal('NOT_THE_ROUNDS_PARTY', `Sample round ${round.number} is for another customer: its swatches go to its own brand.`)
  return null
}

export const leatherOnlyRefusal = (itemCode: string, itemKind: string): DecisionRefusal =>
  refusal('LEATHER_ONLY', `${itemCode} is ${itemKind.toLowerCase().replace(/_/g, ' ')}, not leather: a leather swatch is of a leather material (or make it a colour swatch).`)

export const noCompanyRefusal = (styleCode: string): DecisionRefusal =>
  refusal('NO_COMPANY', `Style ${styleCode} is shared by every company and the swatch belongs to no round: ask on a swatch of a round, or record the decision yourself.`)
