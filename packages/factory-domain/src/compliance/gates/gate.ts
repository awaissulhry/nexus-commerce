import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import {
  byGateOrder,
  checkOf,
  GATE_WORDS,
  needsMarket,
  notApplying,
  ownerOf,
  type CheckKey,
  type ComplianceGate,
  type FixPlace,
  type RequirementRow,
  type RequirementSubject,
  type Who,
} from '../requirements/rules'

/**
 * THE compliance gate (B-W2b-254; PRD-272, PRD-271; design compliance.status › cs-gates, cs-cell, cs-override), pure.
 * Work-order release, label print, final release and shipment ask it the same question: for this style, each of the
 * targets (a colourway × size, for the market it goes to), which requirements apply, which of them block this gate, and
 * is each one there? It answers with every line (the checklist) and refuses with the FIRST missing requirement that
 * blocks the gate (by the requirement's seq, then code, then the targets' order), in words that say what is missing, who
 * can fix it and how, and the law (the design's GateExplainer). An override in force for the same gate, subject and
 * requirement lets it pass (never at a gate the law locks).
 *
 * Markets (decided against the plan's silence, see the step's notes): the market of a target is the goods' destination
 * (the order's delivery country, the shipment's) when a market profile names it. A requirement for one market applies
 * to goods going there, its language checks included. A requirement for every market whose check reads a market's
 * languages (DoC, user information, label) applies only where the style is set to sell in the market (`sellsThere`):
 * the style × market link is a schema need, so at the gates those checks wait (NOT_NEEDED, said in words) and W1's own
 * language checks (the buyer's language on the label, the documents that travel with a shipment) stay where they are.
 * The status board asks every market (sellsThere: true).
 *
 * The API reads the facts and computes each check (`CheckResult`); this file only decides.
 */

export const CHECK_STATES = ['PRESENT', 'MISSING', 'EXPIRING', 'NOT_NEEDED', 'MANUAL'] as const
export type CheckState = (typeof CHECK_STATES)[number]
export const LINE_STATES = ['OK', 'MISSING', 'EXPIRING', 'NOT_NEEDED', 'MANUAL', 'OVERRIDDEN'] as const
export type LineState = (typeof LINE_STATES)[number]

/** A check's answer for one requirement and target. */
export interface CheckResult {
  readonly state: CheckState
  /** One sentence: what is there, or what is missing and where. */
  readonly message: string
  /** How to fix it, in words (null when nothing is missing). */
  readonly fix: string | null
  /** The facts behind it, to say it again in another language ({ code, language, certificate, … }). */
  readonly facts: Readonly<Record<string, string | number | boolean | null | readonly string[]>>
  /** The record that proves it, when there is one (a certificate, a DoC). */
  readonly evidence: { readonly recordType: string; readonly recordId: string; readonly label: string } | null
}

/** The market a target goes to, as a profile names it. */
export interface GateMarket {
  readonly code: string
  readonly name: string
  readonly switchedOn: boolean
  readonly labelLanguages: readonly string[]
  readonly docLanguages: readonly string[]
  readonly userInfoLanguages: readonly string[]
  readonly importerNeeded: boolean
  readonly gpsrContactNeeded: boolean
}

/** One thing the gate stands before: a colourway × size (or the whole subject), for a market. */
export interface GateTarget {
  /** Stable within the question (a work-order cell id, a shipment line). */
  readonly key: string
  /** "BLK 52", "BLK 52 for DE". */
  readonly label: string
  readonly colourwayId: string | null
  readonly colourwayCode: string | null
  readonly size: string | null
  /** The destination's country code as stored (null: unknown). */
  readonly destination: string | null
  /** The market profile of the destination (null: none names it). */
  readonly market: GateMarket | null
  /** The style is set to sell in that market (a language check applies). */
  readonly sellsThere: boolean
}

/** An override in force: a person with a named role let the subject pass this requirement at this gate, until a time. */
export interface OverrideInForce {
  readonly eventId: string
  readonly refusedEventId: string
  readonly requirementId: string
  readonly gate: ComplianceGate
  readonly until: Date
  readonly reason: string
  readonly byId: string | null
}

export interface GateQuestion {
  readonly gate: ComplianceGate
  /** "Work order WO-00012", "Shipment SHP-0091": how the refusal names what it stands before. */
  readonly subjectWords: string
  readonly style: RequirementSubject & { readonly code: string }
  readonly targets: readonly GateTarget[]
  /** Every requirement of the tenant (ACTIVE or not: the gate says why one does not apply). */
  readonly requirements: readonly RequirementRow[]
  /** The check of a requirement for a target (only asked for lines that apply and are computed). */
  readonly check: (requirement: RequirementRow, check: CheckKey, target: GateTarget) => CheckResult
  readonly overrides: readonly OverrideInForce[]
  readonly day: BusinessDate
  readonly now: Date
}

export interface GateLine {
  readonly requirement: RequirementRow
  readonly check: CheckKey | 'MANUAL'
  readonly target: GateTarget
  readonly state: LineState
  readonly message: string
  readonly fix: string | null
  readonly facts: CheckResult['facts']
  readonly evidence: CheckResult['evidence']
  /** It blocks this gate (a MISSING line that blocks refuses). */
  readonly blocks: boolean
  /** The law locks it at this gate (no override). */
  readonly locked: boolean
  readonly who: Who
  readonly fixPlace: FixPlace
  readonly override: OverrideInForce | null
}

export interface GateRefusal {
  readonly line: GateLine
  /** The GateExplainer's words: what, where, who can fix it, how, the law. */
  readonly words: string
}

export interface GateDecision {
  readonly gate: ComplianceGate
  readonly allowed: boolean
  /** Every requirement that applies, per target, in the gate's order. */
  readonly lines: readonly GateLine[]
  /** The first missing requirement that blocks this gate (null: allowed). */
  readonly refusal: GateRefusal | null
  /** Per target, its first blocking missing line (label print refuses a size and prints the others). */
  readonly refusedTargets: readonly GateRefusal[]
  readonly overridden: readonly GateLine[]
}

const WHO_WORDS: Readonly<Record<Who, string>> = { COMPLIANCE: 'compliance', QUALITY: 'quality', PRODUCTION: 'production', SALES: 'sales' }

/** The GateExplainer sentence for a refused line. */
export function explain(gate: ComplianceGate, subjectWords: string, line: Pick<GateLine, 'requirement' | 'target' | 'message' | 'fix' | 'who'>): string {
  const where = line.target.market ? ` for ${line.target.market.name} (${line.target.market.code})` : ''
  const what = line.target.label ? ` (${line.target.label})` : ''
  const how = line.fix ? ` How: ${line.fix}` : ''
  return `${subjectWords}${what}${where} cannot ${GATE_WORDS[gate].verb}: ${stripStop(line.message)}. Who can fix it: ${WHO_WORDS[line.who]}.${how} Requirement ${line.requirement.code} (${line.requirement.legalReference}).`
}

const stripStop = (text: string): string => text.replace(/[.\s]+$/u, '')

const NO_MARKET_RESULT = (requirement: RequirementRow, target: GateTarget): CheckResult => ({
  state: 'NOT_NEEDED',
  message: target.market
    ? `The style is not set to sell in ${target.market.name}: its ${requirement.kind === 'LABEL' ? 'label' : 'document'} languages are checked once it is.`
    : target.destination
      ? `No market profile names ${target.destination}: its languages are not known (add the market in Rules & markets).`
      : 'No market is known here: its languages are checked where the goods go.',
  fix: null,
  facts: { code: 'market.unknown', destination: target.destination },
  evidence: null,
})

const OFF_MARKET_RESULT = (market: GateMarket): CheckResult => ({
  state: 'NOT_NEEDED',
  message: `Market ${market.name} (${market.code}) is switched off: its rules wait until it is on.`,
  fix: null,
  facts: { code: 'market.off', market: market.code },
  evidence: null,
})

/** The gate's lines for one target, in the gate's order (requirements that do not apply are left out). */
export function linesOf(question: Pick<GateQuestion, 'gate' | 'style' | 'requirements' | 'check' | 'overrides' | 'day' | 'now'>, target: GateTarget): GateLine[] {
  const lines: GateLine[] = []
  for (const requirement of byGateOrder(question.requirements)) {
    const marketCode = target.market?.code ?? null
    if (notApplying(requirement, question.style, marketCode, question.day) !== null) continue
    const check = checkOf(requirement)
    const blocks = requirement.blocks.includes(question.gate)
    const locked = requirement.lockedBlocks.includes(question.gate)
    const owner = ownerOf(requirement)
    let result: CheckResult
    if (requirement.marketCode !== null && target.market && !target.market.switchedOn) result = OFF_MARKET_RESULT(target.market)
    else if (needsMarket(check) && !(target.market && target.market.switchedOn && (target.sellsThere || requirement.marketCode === target.market.code))) {
      result = target.market && !target.market.switchedOn ? OFF_MARKET_RESULT(target.market) : NO_MARKET_RESULT(requirement, target)
    }
    else if (check === 'MANUAL') result = { state: 'MANUAL', message: 'Checked by a person: no check computes it here.', fix: null, facts: { code: 'manual' }, evidence: null }
    else result = question.check(requirement, check, target)
    const override = blocks && !locked && result.state === 'MISSING' && requirement.id !== null
      ? (question.overrides.find((entry) => entry.requirementId === requirement.id && entry.gate === question.gate && entry.until.getTime() > question.now.getTime()) ?? null)
      : null
    const state: LineState = override ? 'OVERRIDDEN' : result.state === 'PRESENT' ? 'OK' : result.state
    lines.push({ requirement, check, target, state, message: result.message, fix: result.fix, facts: result.facts, evidence: result.evidence, blocks, locked, who: owner.who, fixPlace: owner.fix, override })
  }
  return lines
}

/** The gate's answer: every line, and the first missing requirement that blocks this gate. */
export function decide(question: GateQuestion): GateDecision {
  const perTarget = question.targets.map((target) => linesOf(question, target))
  // The gate's order: requirement first (seq, code), then the target.
  const order = new Map(byGateOrder(question.requirements).map((requirement, index) => [requirement.code, index]))
  const lines = perTarget.flat().sort((a, b) => (order.get(a.requirement.code) ?? 0) - (order.get(b.requirement.code) ?? 0) || question.targets.indexOf(a.target) - question.targets.indexOf(b.target))
  const refusing = (line: GateLine) => line.blocks && line.state === 'MISSING'
  const toRefusal = (line: GateLine): GateRefusal => ({ line, words: explain(question.gate, question.subjectWords, line) })
  const first = lines.find(refusing) ?? null
  const refusedTargets = perTarget.flatMap((targetLines) => {
    const line = targetLines.find(refusing)
    return line ? [toRefusal(line)] : []
  })
  return {
    gate: question.gate,
    allowed: first === null,
    lines,
    refusal: first ? toRefusal(first) : null,
    refusedTargets,
    overridden: lines.filter((line) => line.state === 'OVERRIDDEN'),
  }
}

/** The facts a GateEvent keeps to say the refusal again (GateEvent.explanation). */
export function explanationOf(line: GateLine): Record<string, unknown> {
  return {
    ...line.facts,
    requirement: line.requirement.code,
    check: line.check,
    target: line.target.key,
    ...(line.target.colourwayCode ? { colourway: line.target.colourwayCode } : {}),
    ...(line.target.size ? { size: line.target.size } : {}),
    ...(line.target.destination ? { destination: line.target.destination } : {}),
  }
}

/** The 409's issues for a refusal: `gate/<CODE>` with the words (and the target, for a screen to point at it). */
export function refusalIssues(refusal: GateRefusal): Issue[] {
  return [{ path: `gate/${refusal.line.requirement.code}`, message: refusal.words }, ...(refusal.line.target.key ? [{ path: `gate/${refusal.line.requirement.code}/${refusal.line.target.key}`, message: refusal.line.message }] : [])]
}
