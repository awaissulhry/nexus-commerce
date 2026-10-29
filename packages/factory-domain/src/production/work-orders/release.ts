import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { NOT_COUNTED_WORDS, type UnusableReason } from '../../planning/usable'
import { decimalOf, decimalText } from '../../product/units/units'
import type { BomGap, MissingWorkCentre } from './spec'

/**
 * The release check of a work order (B-W1-38; plan A1 §2.5 "Work order": release needs the style revision RELEASED,
 * the frozen spec written, the deposit gate passed, material available or a planner override with a reason, and a
 * certificate covering style, colour and size for PPE; design 02 "Release check": every failed condition in plain
 * words), pure. One function answers both the record's checklist and the release command, so the screen never says a
 * release would pass that the command refuses. The API loads the facts (in the release's transaction for the release).
 *
 *   REVISION        a RELEASED revision of the work order's own style is chosen (the style's current one is named
 *                   when the chosen one is not)
 *   LABEL_TEMPLATE  the revision names a garment label template, and it is ACTIVE (it is frozen with the revision)
 *   CERTIFICATE     PPE of category II or III: a VALID certificate covers the style in every cell's colourway and
 *                   size on the day (the certificate gate); not PPE or category I: not required
 *   WORK_CENTRES    every kind of work the routing needs has an ACTIVE work centre on the site
 *   BOM             every cell's size and colourway is in the revision's BOM
 *   CELLS           at least one cell, every size in the style's range
 *   DEPOSIT         every order of the cells that requires a deposit has it PAID or WAIVED, and none still open
 *                   (the deposit gate, ported: "Production waits for a PAID or WAIVED deposit request of the order")
 *   MATERIAL        for each material and colour: what the work order still needs (planned less already issued to
 *                   it) is covered by the site's usable stock (a RELEASED lot, with Cr VI PASS when the leather needs
 *                   the test; stock without a lot) less what the site's other released work orders still need of it;
 *                   a shortage passes only with the planner's override and its reason (OVERRIDDEN)
 *   BATCH_NUMBER    the company has an active batch number series (the number is given at the release, MES-076)
 *
 * Automatic blockers (MES-004, holds) are W2a; the release is by hand (PLAN D1).
 */

export const RELEASE_CHECKS = ['REVISION', 'LABEL_TEMPLATE', 'CERTIFICATE', 'WORK_CENTRES', 'BOM', 'CELLS', 'DEPOSIT', 'MATERIAL', 'BATCH_NUMBER'] as const
export type ReleaseCheckCode = (typeof RELEASE_CHECKS)[number]

export const CHECK_STATES = ['OK', 'BLOCKED', 'NOT_REQUIRED', 'OVERRIDDEN'] as const
export type CheckState = (typeof CHECK_STATES)[number]

export interface ReleaseCheck {
  readonly code: ReleaseCheckCode
  readonly state: CheckState
  /** One sentence for the person: what holds, or what is in place. */
  readonly message: string
  /** Each problem (BLOCKED) or each passed shortage (OVERRIDDEN), with where it is. */
  readonly problems: readonly Issue[]
}

const ok = (code: ReleaseCheckCode, message: string): ReleaseCheck => ({ code, state: 'OK', message, problems: [] })
const blocked = (code: ReleaseCheckCode, message: string, problems: readonly Issue[] = []): ReleaseCheck => ({
  code,
  state: 'BLOCKED',
  message,
  problems: problems.length > 0 ? problems : [{ path: `checks/${code}`, message }],
})

// ---- revision and label -------------------------------------------------------------------------------------------

export interface RevisionFacts {
  readonly id: string
  readonly revision: number
  readonly status: string
  readonly styleId: string
}

export function revisionCheck(styleId: string, revision: RevisionFacts | null, current: Pick<RevisionFacts, 'id' | 'revision'> | null): ReleaseCheck {
  const hint = current ? ` The style's released revision now is ${current.revision}: choose it on the work order.` : ' The style has no released revision: release one in Product › Styles first.'
  if (!revision) return blocked('REVISION', `No released revision of the style is chosen.${hint}`)
  if (revision.styleId !== styleId) return blocked('REVISION', `Revision ${revision.revision} is another style's.${hint}`)
  if (revision.status !== 'RELEASED') return blocked('REVISION', `Revision ${revision.revision} is ${revision.status}; a work order is released only with a RELEASED revision.${hint}`)
  return ok('REVISION', `Revision ${revision.revision} is released; the release freezes it.`)
}

export interface LabelFacts {
  readonly id: string
  readonly code: string
  readonly revision: number
  readonly status: string
}

export function labelCheck(revision: Pick<RevisionFacts, 'revision'> | null, label: LabelFacts | null): ReleaseCheck {
  if (!revision) return blocked('LABEL_TEMPLATE', 'No revision is chosen, so no garment label template either.')
  if (!label) return blocked('LABEL_TEMPLATE', `Revision ${revision.revision} names no garment label template: set one on the revision before it is released (Product › Labels).`)
  if (label.status !== 'ACTIVE') return blocked('LABEL_TEMPLATE', `Garment label template ${label.code} v${label.revision} is ${label.status}; the release needs it ACTIVE.`)
  return ok('LABEL_TEMPLATE', `Garment label template ${label.code} v${label.revision} is active.`)
}

// ---- certificate ----------------------------------------------------------------------------------------------------

/** The certificate gate's answer for one cell (apps/factory-api compliance/certificates certificateGateFor). */
export interface CellGate {
  readonly cellId: string
  /** "BLK 52". */
  readonly label: string
  readonly outcome: 'covered' | 'not_required' | 'refused'
  readonly certificateNumber: string | null
  readonly validTo: BusinessDate | null
  /** Why it is refused, in words. */
  readonly reasons: readonly string[]
  /** The gate's message when not required. */
  readonly message: string | null
}

export function certificateCheck(cells: readonly CellGate[]): ReleaseCheck {
  if (cells.length === 0) return blocked('CERTIFICATE', 'There are no cells to check against a certificate.')
  if (cells.every((cell) => cell.outcome === 'not_required')) {
    return { code: 'CERTIFICATE', state: 'NOT_REQUIRED', message: cells[0]!.message ?? 'No certificate is needed for this style.', problems: [] }
  }
  const refused = cells.filter((cell) => cell.outcome === 'refused')
  if (refused.length > 0) {
    return blocked(
      'CERTIFICATE',
      `No valid certificate covers ${refused.map((cell) => cell.label).join(', ')} today (Reg. (EU) 2016/425): ${refused.length} of ${cells.length} cell(s).`,
      refused.map((cell) => ({ path: `cells/${cell.cellId}/certificate`, message: `${cell.label}: ${cell.reasons.join(' ') || 'not covered.'}` })),
    )
  }
  const numbers = [...new Set(cells.flatMap((cell) => (cell.certificateNumber ? [`${cell.certificateNumber}${cell.validTo ? ` (valid to ${cell.validTo})` : ''}`] : [])))]
  return ok('CERTIFICATE', `Certificate ${numbers.join(', ')} covers every cell's colourway and size.`)
}

// ---- site, BOM, cells -----------------------------------------------------------------------------------------------

export function workCentreCheck(siteCode: string, steps: number, missing: readonly MissingWorkCentre[]): ReleaseCheck {
  if (steps === 0) return blocked('WORK_CENTRES', "The revision's routing has no step: the floor would have nothing to scan.")
  if (missing.length > 0) {
    return blocked(
      'WORK_CENTRES',
      `Site ${siteCode} has no active work centre for ${missing.map((entry) => entry.kind).join(', ')}: add one, or release a routing the site can make.`,
      missing.map((entry) => ({
        path: `checks/WORK_CENTRES/${entry.kind}`,
        message: `No active ${entry.kind} work centre on site ${siteCode} for ${entry.steps.map((step) => `step ${step.seq} ${step.code} (${step.name})`).join(', ')}.`,
      })),
    )
  }
  return ok('WORK_CENTRES', `Every step of the routing has an active work centre on site ${siteCode}.`)
}

export function bomCheck(revision: Pick<RevisionFacts, 'revision'> | null, gaps: readonly BomGap[]): ReleaseCheck {
  if (!revision) return blocked('BOM', 'No revision is chosen, so no BOM to plan the materials from.')
  if (gaps.length > 0) {
    return blocked(
      'BOM',
      `Revision ${revision.revision}'s BOM does not cover ${gaps.length} cell line(s): a size or colourway added after its release needs a new revision.`,
      gaps.map((gap) => ({ path: `cells/${gap.cellId}/bom/${gap.bomLineId}`, message: gap.message })),
    )
  }
  return ok('BOM', `Revision ${revision.revision}'s BOM covers every cell.`)
}

export function cellsCheck(cells: readonly { readonly id: string; readonly label: string; readonly inRange: boolean }[]): ReleaseCheck {
  if (cells.length === 0) return blocked('CELLS', 'The work order has no cells: add sizes from its order lines.')
  const outside = cells.filter((cell) => !cell.inRange)
  if (outside.length > 0) {
    return blocked(
      'CELLS',
      `${outside.map((cell) => cell.label).join(', ')} ${outside.length === 1 ? 'is' : 'are'} no longer in the style's size range.`,
      outside.map((cell) => ({ path: `cells/${cell.id}/size`, message: `${cell.label}: the size is not in the style's size range.` })),
    )
  }
  return ok('CELLS', `${cells.length} cell(s) to make.`)
}

// ---- the deposit gate -------------------------------------------------------------------------------------------------

export const DEPOSIT_STATUSES = ['OPEN', 'PAID', 'WAIVED', 'CANCELLED'] as const
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number]

export interface DepositFacts {
  readonly orderId: string
  readonly orderNumber: string
  /** SalesOrder.depositRequired. */
  readonly depositRequired: boolean
  /** The order's deposit requests (by the order, or by the accepted version it was made from). */
  readonly requests: readonly { readonly status: DepositStatus; readonly dueDate: BusinessDate }[]
}

/** One order's deposit gate: passed, or why not. */
export function depositGate(order: DepositFacts): { readonly passed: boolean; readonly message: string } {
  if (!order.depositRequired) return { passed: true, message: `${order.orderNumber} requires no deposit.` }
  const live = order.requests.filter((request) => request.status !== 'CANCELLED')
  if (live.length === 0) return { passed: false, message: `${order.orderNumber} requires a deposit and has no deposit request: ask for it first.` }
  const open = live.filter((request) => request.status === 'OPEN')
  if (open.length > 0) {
    const due = open.map((request) => request.dueDate).sort()[0]!
    return { passed: false, message: `${order.orderNumber} waits for its deposit (due ${due}): production starts when it is paid or waived.` }
  }
  return { passed: true, message: `${order.orderNumber}'s deposit is ${live.every((request) => request.status === 'WAIVED') ? 'waived' : 'paid'}.` }
}

export function depositCheck(orders: readonly DepositFacts[]): ReleaseCheck {
  if (orders.length === 0) return blocked('DEPOSIT', 'The work order makes no order line, so no deposit can be checked.')
  const gates = orders.map((order) => ({ order, gate: depositGate(order) }))
  const failed = gates.filter((entry) => !entry.gate.passed)
  if (failed.length > 0) {
    return blocked(
      'DEPOSIT',
      failed.map((entry) => entry.gate.message).join(' '),
      failed.map((entry) => ({ path: `orders/${entry.order.orderId}/deposit`, message: entry.gate.message })),
    )
  }
  if (orders.every((order) => !order.depositRequired)) return { code: 'DEPOSIT', state: 'NOT_REQUIRED', message: gates.map((entry) => entry.gate.message).join(' '), problems: [] }
  return ok('DEPOSIT', gates.map((entry) => entry.gate.message).join(' '))
}

// ---- material availability ------------------------------------------------------------------------------------------

/** One material in one colour: what the work order needs and what the site has for it (base unit, decimal text). */
export interface MaterialFacts {
  readonly itemId: string
  readonly itemColourId: string | null
  /** "Leather BLK". */
  readonly label: string
  readonly baseUom: string
  /** Planned for this work order. */
  readonly planned: string
  /** Already issued to it, net of returns (0 for a draft). */
  readonly issued: string
  /** Usable on hand at the site. */
  readonly usable: string
  /** Still to issue to the site's other released work orders. */
  readonly committed: string
  /** On hand at the site but not usable, per reason. */
  readonly held: readonly { readonly reason: UnusableReason; readonly quantity: string }[]
}

export interface MaterialLine extends MaterialFacts {
  /** Planned less issued (never below 0). */
  readonly needed: string
  /** Usable less committed (never below 0). */
  readonly available: string
  /** Needed less available (never below 0). */
  readonly short: string
}

/** Each material with what is needed, available and short. */
export function materialLines(materials: readonly MaterialFacts[]): MaterialLine[] {
  const max0 = (value: ReturnType<typeof decimalOf>) => (value.isNegative() ? decimalOf('0') : value)
  return materials.map((material) => {
    const needed = max0(decimalOf(material.planned).minus(decimalOf(material.issued)))
    const available = max0(decimalOf(material.usable).minus(decimalOf(material.committed)))
    return { ...material, needed: decimalText(needed), available: decimalText(available), short: decimalText(max0(needed.minus(available))) }
  })
}

const isShort = (line: MaterialLine): boolean => decimalOf(line.short).gt(0)

/** The sentence for one short material: the numbers, and the stock that is there but not usable. */
export function shortageMessage(line: MaterialLine): string {
  const held = line.held.filter((entry) => decimalOf(entry.quantity).gt(0))
  const waiting = held.length > 0 ? ` On hand but not usable: ${held.map((entry) => `${decimalText(entry.quantity)} ${line.baseUom} ${NOT_COUNTED_WORDS[entry.reason]}`).join('; ')}.` : ''
  return (
    `${line.label}: ${line.needed} ${line.baseUom} needed, ${line.usable} usable on hand and ${line.committed} promised to other released work orders, ` +
    `so ${line.short} ${line.baseUom} short.${waiting}`
  )
}

export function materialCheck(lines: readonly MaterialLine[], override: { readonly reason: string } | null): ReleaseCheck {
  const short = lines.filter(isShort)
  if (short.length === 0) return ok('MATERIAL', lines.length === 0 ? 'The work order plans no material.' : `Usable stock at the site covers every material (${lines.length}).`)
  const problems = short.map((line) => ({ path: `materials/${line.itemId}${line.itemColourId ? `/${line.itemColourId}` : ''}`, message: shortageMessage(line) }))
  const reason = override?.reason.trim() ?? ''
  if (reason !== '') {
    return { code: 'MATERIAL', state: 'OVERRIDDEN', message: `${short.length} material(s) short, released by the planner's override: ${reason}`, problems }
  }
  return blocked('MATERIAL', `${short.length} material(s) short at the site: wait for stock, or release with a planner's override and its reason.`, problems)
}

// ---- batch number ---------------------------------------------------------------------------------------------------

export function batchCheck(hasSeries: boolean): ReleaseCheck {
  return hasSeries
    ? ok('BATCH_NUMBER', 'The batch number is given at the release, from the company\'s batch series, and never changes.')
    : blocked('BATCH_NUMBER', 'The company has no active batch number series: an admin sets one up under Numbering (kind BATCH).')
}

// ---- the checklist --------------------------------------------------------------------------------------------------

export interface ReleaseChecklist {
  readonly checks: readonly ReleaseCheck[]
  readonly releasable: boolean
  /** Every BLOCKED check's problems, as the release's refusal lists them. */
  readonly blockers: readonly Issue[]
}

/** The checks in the order the record shows them; releasable when none is BLOCKED. */
export function releaseChecklist(checks: readonly ReleaseCheck[]): ReleaseChecklist {
  const order = new Map(RELEASE_CHECKS.map((code, index) => [code, index]))
  const sorted = [...checks].sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0))
  const blockers = sorted.filter((check) => check.state === 'BLOCKED').flatMap((check) => check.problems)
  return { checks: sorted, releasable: blockers.length === 0, blockers }
}

/** The release's refusal message (409): how many problems, for the work order. */
export function releaseRefusal(number: string, checklist: ReleaseChecklist): string {
  const held = checklist.checks.filter((check) => check.state === 'BLOCKED').map((check) => check.code.toLowerCase().replace(/_/g, ' '))
  return `Work order ${number} cannot be released yet: ${checklist.blockers.length} problem(s) to fix first (${held.join(', ')}).`
}
