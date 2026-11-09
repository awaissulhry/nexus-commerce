import type { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { MINUTES_INPUT_SCALE, MINUTES_PRECISION, MINUTES_SCALE, minutesOf } from '../routing/operations'
import { decimalOf, decimalText, roundTo } from '../units/units'

/**
 * Standard minutes and their governance (B-W2b-215; features PRD-111, PRD-113, PRD-114, PRD-126; design products.operations
 * "Minutes" tab, pop-up "Propose SMV change", products.styles › Operations (routing) "Setup / run / wait / move" and "Extra
 * minutes for big sizes"), pure.
 *
 *   allowances   an SMV is basic minutes × (1 + (personal + fatigue + delay allowance) / 100), to the thousandth, a half away
 *                from 0 (the database's `factory_minutes_from_allowances`: numeric round). Basic minutes as a typed SMV (above
 *                0, rounded half up to 3 decimals once); each allowance from 0 to below 100 percent, at most 4 decimals.
 *   versions     an SMV change is an OperationTimeVersion: PROPOSED with its reason, source and first day; APPROVED or
 *                REJECTED (with why) by a second person, never its proposer; one PROPOSED per operation (a new proposal
 *                replaces the waiting one only when it says so: the old one SUPERSEDED with no decision).
 *   in force     on a day: the approved version (APPROVED, or SUPERSEDED after a decision) with the latest first day on or
 *                before it, the higher number on the same day; none: the operation's own numbers (W1's typed SMV, or the
 *                numbers it had before its first version's day).
 *   settling     when an approved version's day comes (at its approval when that day has come, else the hourly job), the
 *                operation's five numbers become its numbers and the APPROVED versions before it become SUPERSEDED; an
 *                APPROVED version shadowed by a later-numbered one of the same day never takes effect (SUPERSEDED too).
 *   days         a proposal starts today or later, and not before the day of an APPROVED version (one waiting to take
 *                effect included): the order of first days is the order of approvals. A proposal that waited past its
 *                day takes effect at its approval.
 *   governed     an operation with an approved version: its SMV changes only by a new version (the database holds it);
 *                W1's typed SMV (PATCH) is refused in words, so is a typed SMV while a proposal waits.
 *   the routing  a step's run is its SMV per garment: copied from an approved version of its operation (VERSION: the step
 *                names it and carries its five numbers), its own basic minutes and allowances (ALLOWANCES), or typed
 *                (TYPED, W1). Beside it per work order: set-up, wait and move minutes (PRD-126, each from 0 or empty),
 *                and extra minutes per size (PRD-114: not 0, may be negative; the step in that size stays above 0).
 *   planning     a garment of a size takes Σ (run + its size's extra) over the steps it goes through (a step only for some
 *                sizes skips the others, B-W2b-225's column); a work order of n garments takes Σ set-up + Σ run × n + Σ
 *                wait + Σ move. Exact until the one rounding the caller names.
 *
 * Option-dependent minutes are OptionEffect MINUTES (B-W2b-229), not here. No money: minutes only.
 */

export const TIME_SOURCES = ['TIME_STUDY', 'PREDETERMINED', 'ESTIMATE'] as const
export type TimeSource = (typeof TIME_SOURCES)[number]

export const TIME_VERSION_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const
export type TimeVersionStatus = (typeof TIME_VERSION_STATUSES)[number]

/** Allowances: Decimal(7,4) percent, from 0, below 100. */
export const ALLOWANCE_PRECISION = 7
export const ALLOWANCE_SCALE = 4
export const MAX_ALLOWANCE = 100
export const MAX_REASON = 2000

/** The three allowances, in the order the screens show them. */
export const ALLOWANCES = ['personalPct', 'fatiguePct', 'delayPct'] as const
export type AllowanceField = (typeof ALLOWANCES)[number]

/** Basic minutes and the three allowances, as plain decimal strings. */
export interface Allowances {
  readonly basicMinutes: string
  readonly personalPct: string
  readonly fatiguePct: string
  readonly delayPct: string
}

/** The five numbers of an SMV built from allowances: what an operation, a step and a version carry together. */
export interface BuiltMinutes extends Allowances {
  readonly standardMinutes: string
}

/** An operation's or a step's minutes as stored: the SMV, with its basic minutes and allowances or none of them. */
export interface StoredMinutes {
  readonly standardMinutes: string
  readonly basicMinutes: string | null
  readonly personalPct: string | null
  readonly fatiguePct: string | null
  readonly delayPct: string | null
}

const PLAIN = /^\d+(?:\.\d+)?$/
const SIGNED = /^-?\d+(?:\.\d+)?$/

const minutesRound = { scale: MINUTES_SCALE, rounding: 'HALF_UP' } as const

/** The SMV basic minutes and allowances give: basic × (1 + (p + f + d) / 100), to 3 decimals, a half away from 0. */
export function smvOf(allowances: Allowances): string {
  const extra = decimalOf(allowances.personalPct, 'personalPct').plus(decimalOf(allowances.fatiguePct, 'fatiguePct')).plus(decimalOf(allowances.delayPct, 'delayPct'))
  return decimalText(roundTo(decimalOf(allowances.basicMinutes, 'basicMinutes').times(extra.div(100).plus(1)), minutesRound))
}

/** A typed allowance as stored: a plain decimal from 0, below 100, at most 4 decimals ("5" stays "5"). */
export function allowanceProblem(value: string): string | null {
  if (!PLAIN.test(value) || !fitsDecimal(value, ALLOWANCE_PRECISION, ALLOWANCE_SCALE)) return `Expected a percentage from 0 to below ${MAX_ALLOWANCE}, with at most ${ALLOWANCE_SCALE} decimals.`
  return decimalOf(value).gte(MAX_ALLOWANCE) ? `An allowance is below ${MAX_ALLOWANCE} percent.` : null
}

export type MinutesOutcome = { readonly ok: true; readonly minutes: BuiltMinutes } | { readonly ok: false; readonly issues: readonly Issue[] }

/** Basic minutes (rounded like a typed SMV) and the allowances checked, and the SMV they give (it must fit Decimal(10,3)). */
export function minutesFromAllowances(input: Allowances, at = ''): MinutesOutcome {
  const path = (field: string) => (at === '' ? field : `${at}/${field}`)
  const issues: Issue[] = []
  const basic = minutesOf(input.basicMinutes)
  if (!basic.ok) issues.push({ path: path('basicMinutes'), message: basic.message })
  for (const field of ALLOWANCES) {
    const problem = allowanceProblem(input[field])
    if (problem) issues.push({ path: path(field), message: problem })
  }
  if (issues.length > 0 || !basic.ok) return { ok: false, issues }
  const normalised = { basicMinutes: basic.minutes, personalPct: decimalText(input.personalPct), fatiguePct: decimalText(input.fatiguePct), delayPct: decimalText(input.delayPct) }
  const standardMinutes = smvOf(normalised)
  if (!fitsDecimal(standardMinutes, MINUTES_PRECISION, MINUTES_SCALE)) {
    return { ok: false, issues: [{ path: path('basicMinutes'), message: `The SMV would be ${standardMinutes}: at most ${MINUTES_PRECISION - MINUTES_SCALE} digits before the point.` }] }
  }
  return { ok: true, minutes: { ...normalised, standardMinutes } }
}

/** The five numbers are the same ("14.000" is "14"; null is null). */
export function sameStoredMinutes(a: StoredMinutes, b: StoredMinutes): boolean {
  const same = (x: string | null, y: string | null) => (x === null || y === null ? x === y : decimalOf(x).eq(decimalOf(y)))
  return same(a.standardMinutes, b.standardMinutes) && same(a.basicMinutes, b.basicMinutes) && same(a.personalPct, b.personalPct) && same(a.fatiguePct, b.fatiguePct) && same(a.delayPct, b.delayPct)
}

// ---- versions -----------------------------------------------------------------------------------------------------------

/** What the rules read about a version. */
export interface VersionFacts extends BuiltMinutes {
  readonly id: string
  readonly number: number
  readonly status: TimeVersionStatus
  readonly effectiveFrom: BusinessDate
  readonly proposedById: string
  /** A decision was written (APPROVED, REJECTED, or SUPERSEDED after one). */
  readonly decided: boolean
}

/** An approved version, in force or once: APPROVED, or SUPERSEDED after a decision (not one replaced before any). */
export const wasApproved = (version: Pick<VersionFacts, 'status' | 'decided'>): boolean => version.status === 'APPROVED' || (version.status === 'SUPERSEDED' && version.decided)

/** The operation's SMV is governed: some version was approved (its SMV now changes only by a new version). */
export const isGoverned = (versions: readonly Pick<VersionFacts, 'status' | 'decided'>[]): boolean => versions.some(wasApproved)

/** a comes after b in the order of first days (the higher number on the same day). */
const after = (a: Pick<VersionFacts, 'effectiveFrom' | 'number'>, b: Pick<VersionFacts, 'effectiveFrom' | 'number'>): boolean =>
  a.effectiveFrom > b.effectiveFrom || (a.effectiveFrom === b.effectiveFrom && a.number > b.number)

const latest = <V extends Pick<VersionFacts, 'effectiveFrom' | 'number'>>(versions: readonly V[]): V | null => versions.reduce<V | null>((best, version) => (best === null || after(version, best) ? version : best), null)

/** The approved version in force on a day, or null (the operation's own numbers apply). */
export function inForceOn<V extends VersionFacts>(versions: readonly V[], day: BusinessDate): V | null {
  return latest(versions.filter((version) => wasApproved(version) && version.effectiveFrom <= day))
}

/** The waiting proposal (one per operation), or null. */
export const pendingOf = <V extends Pick<VersionFacts, 'status'>>(versions: readonly V[]): V | null => versions.find((version) => version.status === 'PROPOSED') ?? null

/** The APPROVED versions whose day has not come (they will take effect), in the order they will. */
export function waitingToTakeEffect<V extends VersionFacts>(versions: readonly V[], today: BusinessDate): V[] {
  const shadowed = shadowedOf(versions)
  return versions
    .filter((version) => version.status === 'APPROVED' && version.effectiveFrom > today && !shadowed.has(version.id))
    .sort((a, b) => (after(a, b) ? 1 : after(b, a) ? -1 : 0))
}

/** APPROVED versions that never take effect: a later-numbered APPROVED version has the same first day. */
function shadowedOf(versions: readonly VersionFacts[]): Set<string> {
  const approved = versions.filter((version) => version.status === 'APPROVED')
  return new Set(approved.filter((version) => approved.some((other) => other.effectiveFrom === version.effectiveFrom && other.number > version.number)).map((version) => version.id))
}

export interface Settlement<V> {
  /** The APPROVED version in force today, whose numbers the operation takes; null: none has come (the operation keeps its own). */
  readonly inForce: V | null
  /** The APPROVED versions that become SUPERSEDED now: those before it, and those shadowed on their own day. */
  readonly supersede: readonly V[]
}

/** What settles today (the approval of a version whose day has come, the hourly job). */
export function settlementOn<V extends VersionFacts>(versions: readonly V[], today: BusinessDate): Settlement<V> {
  const approved = versions.filter((version) => version.status === 'APPROVED')
  const inForce = latest(approved.filter((version) => version.effectiveFrom <= today))
  const shadowed = shadowedOf(versions)
  const supersede = approved.filter((version) => version !== inForce && ((inForce !== null && after(inForce, version)) || shadowed.has(version.id)))
  return { inForce, supersede }
}

/** Something settles today: an operation the hourly job takes a command for. */
export function settles(versions: readonly VersionFacts[], today: BusinessDate, operation: StoredMinutes): boolean {
  const { inForce, supersede } = settlementOn(versions, today)
  return supersede.length > 0 || (inForce !== null && !sameStoredMinutes(operation, inForce))
}

// ---- proposals and decisions ----------------------------------------------------------------------------------------------

export interface ProposalInput extends Allowances {
  readonly source: TimeSource
  readonly effectiveFrom: string
  readonly reason: string
}

export interface Proposal extends BuiltMinutes {
  readonly source: TimeSource
  readonly effectiveFrom: BusinessDate
  readonly reason: string
}

export type ProposalOutcome = { readonly ok: true; readonly proposal: Proposal } | { readonly ok: false; readonly issues: readonly Issue[] }

/**
 * A proposal checked: its minutes, a source, a reason, and a first day from today and not before the day of an APPROVED
 * version of the operation (`approved`: the operation's versions, any status).
 */
export function planProposal(input: ProposalInput, today: BusinessDate, versions: readonly VersionFacts[]): ProposalOutcome {
  const issues: Issue[] = []
  const minutes = minutesFromAllowances(input)
  if (!minutes.ok) issues.push(...minutes.issues)
  if (!(TIME_SOURCES as readonly string[]).includes(input.source)) issues.push({ path: 'source', message: `Expected one of ${TIME_SOURCES.join(', ')}.` })
  const reason = input.reason.trim()
  if (reason === '') issues.push({ path: 'reason', message: 'Say why the SMV changes.' })
  else if (reason.length > MAX_REASON) issues.push({ path: 'reason', message: `At most ${MAX_REASON} characters.` })
  if (!isBusinessDate(input.effectiveFrom)) issues.push({ path: 'effectiveFrom', message: 'Expected a day as YYYY-MM-DD.' })
  else if (input.effectiveFrom < today) issues.push({ path: 'effectiveFrom', message: `A new SMV applies from today (${today}) or a later day.` })
  else {
    const last = latest(versions.filter((version) => version.status === 'APPROVED'))
    if (last && input.effectiveFrom < last.effectiveFrom) {
      issues.push({ path: 'effectiveFrom', message: `Version ${last.number} is approved from ${last.effectiveFrom}: a new version applies from that day or later.` })
    }
  }
  if (issues.length > 0 || !minutes.ok) return { ok: false, issues }
  return { ok: true, proposal: { ...minutes.minutes, source: input.source, effectiveFrom: input.effectiveFrom, reason } }
}

export const DECISION_REFUSALS = ['NOT_WAITING', 'OWN_PROPOSAL', 'OUT_OF_ORDER'] as const
export type DecisionRefusalCode = (typeof DECISION_REFUSALS)[number]
export interface DecisionRefusal {
  readonly code: DecisionRefusalCode
  readonly message: string
}

const STATUS_WORDS: Readonly<Record<TimeVersionStatus, string>> = { PROPOSED: 'waiting for approval', APPROVED: 'approved', REJECTED: 'rejected', SUPERSEDED: 'superseded' }

/**
 * Why this person cannot decide this version now, or null: it waits for a decision, it is not their own proposal (four
 * eyes), and an approval keeps the order of first days (another version approved since from a later day: propose again).
 */
export function decisionRefusal(version: VersionFacts, deciderId: string, decision: 'APPROVE' | 'REJECT', versions: readonly VersionFacts[]): DecisionRefusal | null {
  if (version.status !== 'PROPOSED') return { code: 'NOT_WAITING', message: `SMV version ${version.number} is ${STATUS_WORDS[version.status]}: it waits for no decision.` }
  if (version.proposedById === deciderId) return { code: 'OWN_PROPOSAL', message: `You proposed SMV version ${version.number}: another person ${decision === 'APPROVE' ? 'approves' : 'rejects'} it (four eyes).` }
  if (decision === 'APPROVE') {
    const last = latest(versions.filter((other) => other.id !== version.id && other.status === 'APPROVED'))
    if (last && version.effectiveFrom < last.effectiveFrom) {
      return { code: 'OUT_OF_ORDER', message: `Version ${last.number} is approved from ${last.effectiveFrom}, after this one's ${version.effectiveFrom}: reject it and propose it again from that day or later.` }
    }
  }
  return null
}

/** A rejection says why. */
export function rejectionProblems(note: string | null | undefined): Issue[] {
  const text = note?.trim() ?? ''
  if (text === '') return [{ path: 'note', message: 'Say why the proposal is rejected.' }]
  return text.length > MAX_REASON ? [{ path: 'note', message: `At most ${MAX_REASON} characters.` }] : []
}

/**
 * Why a typed SMV (W1's PATCH of an operation, its import) cannot change this operation's minutes, or null: governed by an
 * approved version, built from allowances, or a proposal waits.
 */
export function typedSmvRefusal(code: string, operation: StoredMinutes, versions: readonly VersionFacts[]): string | null {
  const pending = pendingOf(versions)
  if (isGoverned(versions)) {
    return `Operation ${code} has an approved SMV: it changes only by a new version. Propose the SMV change (Products › Operations › Minutes); another person approves it.`
  }
  if (operation.basicMinutes !== null) return `The SMV of operation ${code} is built from basic minutes and allowances: propose the change as a new version.`
  if (pending) return `SMV version ${pending.number} of operation ${code} waits for approval: approve or reject it before the SMV is typed again.`
  return null
}

// ---- the routing step ---------------------------------------------------------------------------------------------------

export const STEP_RUN_SOURCES = ['VERSION', 'ALLOWANCES', 'TYPED'] as const
export type StepRunSource = (typeof STEP_RUN_SOURCES)[number]

/** Where a step's run (its SMV per garment) comes from. */
export const stepRunSourceOf = (step: { readonly basicMinutes: string | null; readonly timeVersionId: string | null }): StepRunSource =>
  step.timeVersionId !== null ? 'VERSION' : step.basicMinutes !== null ? 'ALLOWANCES' : 'TYPED'

/** The step's run as stored: its five numbers and the version it names. */
export interface StepRun extends StoredMinutes {
  readonly timeVersionId: string | null
}

/** W1's PATCH of a step's SMV: refused in words when the step's minutes are built (a version or allowances). */
export function typedStepRefusal(seq: number, step: { readonly basicMinutes: string | null; readonly timeVersionId: string | null }, versionNumber: number | null): string | null {
  const source = stepRunSourceOf(step)
  if (source === 'TYPED') return null
  const built = source === 'VERSION' ? `copied from SMV version ${versionNumber ?? '?'} of its operation` : 'built from basic minutes and allowances'
  return `The SMV of routing step ${seq} is ${built}: change it in the step's minutes (copy another version, change the allowances, or type an SMV there).`
}

/** Set-up, wait and move minutes per work order (PRD-126): empty, or from 0, rounded half up to 3 decimals once. */
export function sideMinutesOf(value: string): { readonly ok: true; readonly minutes: string } | { readonly ok: false; readonly message: string } {
  if (!PLAIN.test(value) || !fitsDecimal(value, MINUTES_PRECISION - MINUTES_SCALE + MINUTES_INPUT_SCALE, MINUTES_INPUT_SCALE)) {
    return { ok: false, message: `Expected minutes from 0 with at most ${MINUTES_PRECISION - MINUTES_SCALE} digits and ${MINUTES_INPUT_SCALE} decimals.` }
  }
  const text = decimalText(roundTo(value, minutesRound))
  return fitsDecimal(text, MINUTES_PRECISION, MINUTES_SCALE) ? { ok: true, minutes: text } : { ok: false, message: `At most ${MINUTES_PRECISION - MINUTES_SCALE} digits before the point.` }
}

/** A size's extra minutes on a step (PRD-114). */
export interface SizeTime {
  readonly size: string
  readonly extraMinutes: string
}

export const MAX_SIZE_TIMES = 60

/**
 * A step's extra minutes per size, checked against the style's sizes and the step's SMV: each a size of the range, once;
 * not 0 (rounded half up to 3 decimals); the step in that size stays above 0. Answers them normalised, in range order.
 */
export function planSizeTimes(entries: readonly SizeTime[], styleSizes: readonly string[], stepMinutes: string, at = 'sizeTimes'): { readonly ok: true; readonly sizeTimes: SizeTime[] } | { readonly ok: false; readonly issues: Issue[] } {
  if (entries.length > MAX_SIZE_TIMES) return { ok: false, issues: [{ path: at, message: `At most ${MAX_SIZE_TIMES} sizes.` }] }
  const issues: Issue[] = []
  const seen = new Set<string>()
  const planned: SizeTime[] = []
  entries.forEach((entry, index) => {
    const path = `${at}/${index}`
    const size = entry.size.trim()
    if (!styleSizes.includes(size)) issues.push({ path: `${path}/size`, message: `Size ${size} is not in the style's range (${styleSizes.join(', ')}).` })
    else if (seen.has(size)) issues.push({ path: `${path}/size`, message: `Size ${size} is named twice.` })
    seen.add(size)
    if (!SIGNED.test(entry.extraMinutes) || !fitsDecimal(entry.extraMinutes.replace(/^-/, ''), MINUTES_PRECISION - MINUTES_SCALE + MINUTES_INPUT_SCALE, MINUTES_INPUT_SCALE)) {
      issues.push({ path: `${path}/extraMinutes`, message: `Expected minutes (a minus for less) with at most ${MINUTES_PRECISION - MINUTES_SCALE} digits and ${MINUTES_INPUT_SCALE} decimals.` })
      return
    }
    const extra = roundTo(entry.extraMinutes, minutesRound)
    if (extra.isZero()) issues.push({ path: `${path}/extraMinutes`, message: 'Extra minutes are not 0 (leave the size out: it takes the step\'s minutes).' })
    else if (!fitsDecimal(decimalText(extra.abs()), MINUTES_PRECISION, MINUTES_SCALE)) issues.push({ path: `${path}/extraMinutes`, message: `At most ${MINUTES_PRECISION - MINUTES_SCALE} digits before the point.` })
    else if (decimalOf(stepMinutes).plus(extra).lte(0)) {
      issues.push({ path: `${path}/extraMinutes`, message: `Size ${size} would take ${decimalText(decimalOf(stepMinutes).plus(extra))} minutes: a size takes more than 0 (the step takes ${decimalText(stepMinutes)}).` })
    } else planned.push({ size, extraMinutes: decimalText(extra) })
  })
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, sizeTimes: [...planned].sort((a, b) => styleSizes.indexOf(a.size) - styleSizes.indexOf(b.size)) }
}

/** Kept size times that no longer fit a new SMV (the step in that size at 0 or less): their sizes. */
export const sizesBelowZero = (sizeTimes: readonly SizeTime[], stepMinutes: string): string[] =>
  sizeTimes.filter((entry) => decimalOf(stepMinutes).plus(decimalOf(entry.extraMinutes)).lte(0)).map((entry) => entry.size)

// ---- planning ------------------------------------------------------------------------------------------------------------

/** What planning reads about a step. */
export interface TimedStep {
  readonly standardMinutes: string
  readonly setupMinutes: string | null
  readonly waitMinutes: string | null
  readonly moveMinutes: string | null
  readonly sizeTimes: readonly SizeTime[]
  /** B-W2b-225's cells: a step only for these sizes (empty: every size). */
  readonly appliesToSizes?: readonly string[] | undefined
}

/** The step's run for one garment of a size, exact: 0 when the step is not for that size. */
export function stepMinutesIn(step: TimedStep, size: string | null): Decimal {
  if (size !== null && step.appliesToSizes && step.appliesToSizes.length > 0 && !step.appliesToSizes.includes(size)) return decimalOf('0')
  const extra = size === null ? undefined : step.sizeTimes.find((entry) => entry.size === size)
  return decimalOf(step.standardMinutes, 'standardMinutes').plus(extra ? decimalOf(extra.extraMinutes, 'extraMinutes') : 0)
}

const sum = (values: readonly (string | null)[]): Decimal => values.reduce((total, value) => (value === null ? total : total.plus(decimalOf(value))), decimalOf('0'))

/** One garment of each size, every step it goes through, rounded once to the minutes' scale. */
export function minutesBySize(steps: readonly TimedStep[], sizes: readonly string[]): { readonly size: string; readonly minutes: string }[] {
  return sizes.map((size) => ({ size, minutes: decimalText(roundTo(steps.reduce((total, step) => total.plus(stepMinutesIn(step, size)), decimalOf('0')), minutesRound)) }))
}

export interface LeadMinutes {
  readonly setup: string
  readonly run: string
  readonly wait: string
  readonly move: string
  readonly total: string
}

/**
 * A work order's minutes for planning (PRD-126): set-up once per step, the run per garment of each size × its quantity,
 * wait and move once per step. Each figure rounded once to the minutes' scale.
 */
export function leadMinutes(steps: readonly TimedStep[], quantities: readonly { readonly size: string | null; readonly quantity: number }[]): LeadMinutes {
  const setup = sum(steps.map((step) => step.setupMinutes))
  const wait = sum(steps.map((step) => step.waitMinutes))
  const move = sum(steps.map((step) => step.moveMinutes))
  const run = quantities.reduce((total, { size, quantity }) => total.plus(steps.reduce((each, step) => each.plus(stepMinutesIn(step, size)), decimalOf('0')).times(quantity)), decimalOf('0'))
  const shown = (value: Decimal) => decimalText(roundTo(value, minutesRound))
  return { setup: shown(setup), run: shown(run), wait: shown(wait), move: shown(move), total: shown(setup.plus(run).plus(wait).plus(move)) }
}
