import { ROUTING_ISSUE_CODES } from '../routing/rules'
import { sameMinutes } from '../routing/operations'
import { decimalText } from '../units/units'
import { BOM_CHECK_CODES, type BomCheckCell, type BomCheckItem, type BomCheckSeverity } from '../bom-structure/check'
import { isApproved, type MaterialApproval } from '../bom-structure/rules'
import type { CellStatus } from '../compliance/rules'
import { labelCheck, type LabelFacts } from '../../production/work-orders/release'
import { isWhole, SCOPE_PROBLEMS, scopeWithout, type ReleaseScope, type ScopeProblem, type ScopeStyle } from './scope'

/**
 * THE release gate of a style revision (B-W2b-231; PRD-190 "Release gate", PRD-232 "Completeness score"; design
 * products.styles `styles.release` "Release check (GateChecklist) with 'Fix' per item"), pure. One list answers the Release
 * modal's checklist, the completeness score (the share of the list that is done), the styles list's column and the release
 * command's refusal, so a screen never says a release would pass that the release refuses:
 *
 *   BOM           THE BOM check (B-W2b-223: W1's BOM findings and the structure's), each finding with its cell
 *   ROUTING       W1's routing findings: operations, minutes above 0, a scan point
 *   SMV           every step of an operation whose SMV is governed (B-W2b-215: an approved version exists) has the approved
 *                 SMV in force today, and no SMV change waits for approval
 *   MATERIALS     every line's material is approved for use (APPROVED or CONDITIONAL); a BLOCKED one blocks (B-W2b-223)
 *   PRICES        every material the factory buys for a line has a standard cost (a customer-supplied line costs nothing)
 *   LABEL         the revision names a garment label template and it is ACTIVE (it is frozen with the revision)
 *   CERTIFICATE   PPE of category II or III: a valid certificate covers every switched-on colourway × size the release takes
 *   MEASUREMENTS  the revision's measurement spec is APPROVED (B-W2b-224; frozen with the revision)
 *   ATTRIBUTES    every attribute its product type requires is filled (B-W2b-221)
 *   CHANGE_ORDERS a live change order that proposes this draft is APPROVED and in effect (B-W2b-226); any other open one on the
 *                 style is named
 *   SCOPE         what the release takes (PRD-191): colourways of the style, active, sizes of the range, something to make
 *   DRIFT         open quotes and orders on the revision that becomes obsolete (B-W2b-220's drift, read only)
 *
 * Who decides: a person (the plan: "W1's legal gate is QHS-051 at the label; the product release gate is a person"). Only
 * what would make the release wrong blocks it: W1's BOM and routing blockers, the structure's (a draft sub-assembly, a
 * blocked material), a change order not yet approved, and a scope that cannot be made. Everything else is a WARNING the
 * person sees before releasing and the audit row keeps: a certificate comes after a certification sample that needs a
 * released revision; the garment label, the work-order release and shipping keep the legal gates (certificate, label, DoC).
 *
 * The completeness score = the items done (OK) over the items that apply (not NOT_REQUIRED), SCOPE and DRIFT left out (they
 * are about the release, not the revision), in percent with two decimals, rounded half up; it is stored once with the
 * release (StyleRevision.completenessPct). A frozen revision is not checked again: its gate shows the stored score, what it
 * is released for and the certificate coverage of a later release's cells.
 */

export const GATE_ITEMS = ['BOM', 'ROUTING', 'SMV', 'MATERIALS', 'PRICES', 'LABEL', 'CERTIFICATE', 'MEASUREMENTS', 'ATTRIBUTES', 'CHANGE_ORDERS', 'SCOPE', 'DRIFT'] as const
export type GateItemCode = (typeof GATE_ITEMS)[number]

export const GATE_STATES = ['OK', 'WARNING', 'BLOCKED', 'NOT_REQUIRED'] as const
export type GateState = (typeof GATE_STATES)[number]

/** Where an item's "Fix" goes: a tab of the style, or the product type, or the release itself. */
export const GATE_FIXES = ['bom', 'routing', 'minutes', 'materials', 'labels', 'compliance', 'measurements', 'type', 'changes', 'release', 'versions'] as const
export type GateFix = (typeof GATE_FIXES)[number]

const FIX_OF: Readonly<Record<GateItemCode, GateFix>> = Object.freeze({
  BOM: 'bom',
  ROUTING: 'routing',
  SMV: 'minutes',
  MATERIALS: 'materials',
  PRICES: 'materials',
  LABEL: 'labels',
  CERTIFICATE: 'compliance',
  MEASUREMENTS: 'measurements',
  ATTRIBUTES: 'type',
  CHANGE_ORDERS: 'changes',
  SCOPE: 'release',
  DRIFT: 'versions',
})

/** Items about the release, not the revision: shown, never in the completeness score. */
export const UNSCORED_ITEMS: readonly GateItemCode[] = Object.freeze(['SCOPE', 'DRIFT'])

/** The gate's own finding codes (beside the BOM check's and the scope's). */
export const GATE_CODES = [
  'SMV_NOT_APPROVED',
  'SMV_CHANGE_WAITING',
  'MATERIAL_PENDING',
  'MATERIAL_NO_STANDARD_COST',
  'LABEL_MISSING',
  'LABEL_NOT_ACTIVE',
  'CELL_NOT_COVERED',
  'CERTIFICATE_NO_CELLS',
  'SPEC_MISSING',
  'SPEC_NOT_APPROVED',
  'ATTRIBUTE_MISSING',
  'CHANGE_ORDER_NOT_APPROVED',
  'CHANGE_ORDER_NOT_EFFECTIVE',
  'CHANGE_ORDER_OPEN',
  'OPEN_QUOTES',
  'OPEN_ORDERS',
] as const
export const GATE_FINDING_CODES = [...BOM_CHECK_CODES, ...SCOPE_PROBLEMS, ...GATE_CODES] as const
export type GateFindingCode = (typeof GATE_FINDING_CODES)[number]

/** Where "Show me" lands: the BOM check's cell, plus a record (an operation, a material, a change order, a spec) or a field. */
export interface GateCell extends BomCheckCell {
  readonly recordId: string | null
  readonly field: string | null
}

export interface GateFinding {
  readonly code: GateFindingCode
  readonly severity: BomCheckSeverity
  readonly message: string
  readonly cell: GateCell
}

export interface GateItem {
  readonly code: GateItemCode
  readonly state: GateState
  /** It counts in the completeness score (when it applies). */
  readonly scored: boolean
  readonly fix: GateFix
  /** One sentence for the person: what holds, or what is in place. */
  readonly message: string
  readonly findings: readonly GateFinding[]
}

// ---- facts ------------------------------------------------------------------------------------------------------------------

/** One routing step with its operation's SMV governance (B-W2b-215) on the day. */
export interface GateStep {
  readonly stepId: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly operationId: string
  readonly standardMinutes: string
  /** The operation has an approved SMV version (its SMV changes only by a new version). */
  readonly governed: boolean
  /** The operation's SMV in force on the day (the approved version's, else its own), and that version's number. */
  readonly library: { readonly standardMinutes: string; readonly versionNumber: number | null }
  /** The SMV change waiting for approval, if any. */
  readonly waiting: { readonly number: number; readonly standardMinutes: string } | null
}

/** One BOM line as the materials and prices items read it. */
export interface GateLine {
  readonly lineId: string
  readonly seq: number
  readonly itemId: string
  readonly code: string
  readonly approval: MaterialApproval
  /** The material is supplied by the customer (no cost, no purchase). */
  readonly customerSupplied: boolean
  readonly hasStandardCost: boolean
}

/** One colourway × size the release takes, with the certificate gate's answer on the day (B-W1-12, B-W1-20's coverage). */
export interface GateCertificateCell {
  readonly colourwayId: string
  readonly size: string
  /** "BLK 52". */
  readonly label: string
  readonly status: CellStatus
  readonly message: string
}

export interface GateCertificate {
  /** PPE of category II or III. */
  readonly required: boolean
  /** Why none is needed (not PPE, category I). */
  readonly notRequiredMessage: string | null
  /** The switched-on cells the release takes (every cell while the style has no SKU on). */
  readonly cells: readonly GateCertificateCell[]
}

export interface GateOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  /** The revision number it proposes (null: none yet). */
  readonly toRevision: number | null
}

export interface GateDrift {
  /** The style's RELEASED revision, which becomes OBSOLETE. */
  readonly previous: number
  /** Counts the reader may see (null: not in the reader's role). */
  readonly workOrdersInProgress: number | null
  readonly draftWorkOrders: number | null
  readonly openQuotes: number | null
  readonly openOrders: number | null
}

export interface GateFacts {
  readonly revision: { readonly revision: number; readonly status: string }
  readonly styleStatus: string
  /** THE BOM check (B-W2b-223) of a draft; null for a frozen revision (not checked again). */
  readonly check: { readonly blockers: readonly BomCheckItem[]; readonly warnings: readonly BomCheckItem[] } | null
  readonly steps: readonly GateStep[]
  readonly lines: readonly GateLine[]
  readonly label: { readonly named: boolean; readonly template: LabelFacts | null }
  readonly certificate: GateCertificate
  readonly spec: { readonly id: string; readonly status: string } | null
  readonly attributes: { readonly typeCode: string | null; readonly required: number; readonly missing: readonly string[] }
  readonly changeOrders: {
    /** The live change order that proposes this revision, and why it refuses the release now (null: it allows it). */
    readonly proposing: (GateOrder & { readonly refusal: { readonly code: 'NOT_APPROVED' | 'NOT_YET_EFFECTIVE'; readonly message: string } | null }) | null
    readonly others: readonly GateOrder[]
  }
  readonly scope: {
    /** What the release takes (the planned scope, or the one asked). */
    readonly asked: ReleaseScope
    readonly problems: readonly ScopeProblem[]
    readonly words: string
    /** What waits for a later release ("RED and sizes 56–60"); null: nothing. */
    readonly waiting: string | null
    readonly style: ScopeStyle
  }
  /** Null: the first release (or a frozen revision). */
  readonly drift: GateDrift | null
  /** A frozen revision's score as stored at its release. */
  readonly storedCompletenessPct: string | null
}

export interface ReleaseGate {
  /** A draft is checked; a frozen revision shows only what it is released for and the coverage of the cells asked. */
  readonly checked: boolean
  readonly items: readonly GateItem[]
  readonly blockers: readonly GateFinding[]
  readonly warnings: readonly GateFinding[]
  /** "87.5": the share of the list that is done, two decimals (a frozen revision: the score stored at its release). */
  readonly completenessPct: string | null
  /** A draft of a style that is not archived, with no blocker. */
  readonly releasable: boolean
  /** The first blocking reason: the Release button is held with it. */
  readonly heldBy: string | null
  /** A suggested scope that leaves out the cells no certificate covers (null: none needed or none possible). */
  readonly suggestedScope: ReleaseScope | null
}

// ---- the items --------------------------------------------------------------------------------------------------------------

const cell = (at: Partial<GateCell> = {}): GateCell => ({
  lineId: at.lineId ?? null,
  column: at.column ?? null,
  size: at.size ?? null,
  colourwayId: at.colourwayId ?? null,
  alternateId: at.alternateId ?? null,
  stepId: at.stepId ?? null,
  recordId: at.recordId ?? null,
  field: at.field ?? null,
})

const finding = (code: GateFindingCode, severity: BomCheckSeverity, message: string, at: Partial<GateCell> = {}): GateFinding => ({ code, severity, message, cell: cell(at) })
const fromCheck = (item: BomCheckItem): GateFinding => ({ code: item.code, severity: item.severity, message: item.message, cell: cell(item.cell) })

const item = (code: GateItemCode, state: GateState, message: string, findings: readonly GateFinding[] = []): GateItem => ({
  code,
  state,
  scored: !UNSCORED_ITEMS.includes(code),
  fix: FIX_OF[code],
  message,
  findings,
})

const ROUTING_CODES: ReadonlySet<string> = new Set(ROUTING_ISSUE_CODES)
/** The BOM check's findings about a material's approval go to MATERIALS. */
const MATERIAL_CODES: ReadonlySet<string> = new Set(['MATERIAL_BLOCKED', 'ALTERNATE_BLOCKED', 'PPE_MATERIAL_NOT_APPROVED'])
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** An item from some of the BOM check's findings: BLOCKED with a blocker, WARNING with a warning, else OK. */
function checkItem(code: 'BOM' | 'ROUTING', findings: readonly GateFinding[], words: { ok: string; what: string }): GateItem {
  const blockers = findings.filter((entry) => entry.severity === 'BLOCKER').length
  const warnings = findings.length - blockers
  if (blockers > 0) return item(code, 'BLOCKED', `${words.what} has ${plural(blockers, 'problem')} to fix first${warnings > 0 ? ` (and ${plural(warnings, 'thing')} to look at)` : ''}.`, findings)
  if (warnings > 0) return item(code, 'WARNING', `${words.what} is ready; ${plural(warnings, 'thing')} to look at.`, findings)
  return item(code, 'OK', words.ok)
}

function smvItem(steps: readonly GateStep[]): GateItem {
  if (steps.length === 0) return item('SMV', 'NOT_REQUIRED', 'The routing has no step yet: there is no SMV to check.')
  const findings: GateFinding[] = []
  for (const step of steps) {
    if (step.governed && !sameMinutes(step.standardMinutes, step.library.standardMinutes)) {
      const version = step.library.versionNumber === null ? '' : ` (version ${step.library.versionNumber})`
      findings.push(
        finding(
          'SMV_NOT_APPROVED',
          'WARNING',
          `Step ${step.seq} ${step.code} (${step.name}) takes ${decimalText(step.standardMinutes)} min here; the approved SMV of ${step.code} is ${decimalText(step.library.standardMinutes)} min${version}. Use the library value in Routing › Times, or keep it on purpose.`,
          { stepId: step.stepId, column: 'routing', recordId: step.operationId },
        ),
      )
    }
  }
  const waiting = new Map<string, GateStep>()
  for (const step of steps) if (step.waiting && !waiting.has(step.operationId)) waiting.set(step.operationId, step)
  for (const step of waiting.values()) {
    findings.push(
      finding('SMV_CHANGE_WAITING', 'WARNING', `${step.code}: an SMV change to ${decimalText(step.waiting!.standardMinutes)} min (version ${step.waiting!.number}) waits for approval.`, {
        stepId: step.stepId,
        column: 'routing',
        recordId: step.operationId,
      }),
    )
  }
  if (findings.length === 0) return item('SMV', 'OK', 'Every step takes the approved SMV (an operation without an approved version keeps its own).')
  const differ = findings.filter((entry) => entry.code === 'SMV_NOT_APPROVED').length
  const parts = [...(differ > 0 ? [`${plural(differ, 'step')} ${differ === 1 ? 'differs' : 'differ'} from the approved SMV`] : []), ...(waiting.size > 0 ? [`${plural(waiting.size, 'SMV change')} ${waiting.size === 1 ? 'waits' : 'wait'} for approval`] : [])]
  return item('SMV', 'WARNING', `${parts.join('; ')}.`, findings)
}

function materialsItem(lines: readonly GateLine[], fromChecks: readonly GateFinding[]): GateItem {
  if (lines.length === 0 && fromChecks.length === 0) return item('MATERIALS', 'NOT_REQUIRED', 'The BOM has no line yet.')
  const flagged = new Set(fromChecks.map((entry) => entry.cell.lineId).filter((id): id is string => id !== null))
  const pending = lines.filter((line) => line.approval === 'PENDING' && !flagged.has(line.lineId))
  const findings = [
    ...fromChecks,
    ...pending.map((line) =>
      finding('MATERIAL_PENDING', 'WARNING', `Line ${line.seq} (${line.code}): the material is not approved for use yet. Approve it in Products › Materials, or take another.`, {
        lineId: line.lineId,
        column: 'itemId',
        recordId: line.itemId,
      }),
    ),
  ]
  const blocked = findings.filter((entry) => entry.severity === 'BLOCKER').length
  if (blocked > 0) return item('MATERIALS', 'BLOCKED', `${plural(blocked, 'material')} ${blocked === 1 ? 'is' : 'are'} blocked for use: take another.`, findings)
  if (findings.length > 0) return item('MATERIALS', 'WARNING', `${plural(findings.length, 'line')} ${findings.length === 1 ? 'takes' : 'take'} a material not approved for use yet.`, findings)
  // A BLOCKED material is always the BOM check's MATERIAL_BLOCKED; a PENDING one is a finding above.
  const conditional = lines.filter((line) => line.approval === 'CONDITIONAL').length
  return item('MATERIALS', lines.every((line) => isApproved(line.approval)) ? 'OK' : 'WARNING', `Every material is approved for use${conditional > 0 ? ` (${plural(conditional, 'line')} on a condition)` : ''}.`)
}

function pricesItem(lines: readonly GateLine[]): GateItem {
  const bought = lines.filter((line) => !line.customerSupplied)
  if (bought.length === 0) return item('PRICES', 'NOT_REQUIRED', lines.length === 0 ? 'The BOM has no line yet.' : 'Every line is supplied by the customer: nothing to cost.')
  const missing = new Map<string, GateLine>()
  for (const line of bought) if (!line.hasStandardCost && !missing.has(line.itemId)) missing.set(line.itemId, line)
  if (missing.size === 0) return item('PRICES', 'OK', 'Every material the factory buys has a standard cost.')
  return item(
    'PRICES',
    'WARNING',
    `${plural(missing.size, 'material')} ${missing.size === 1 ? 'has' : 'have'} no standard cost yet: the cost sheet stays an estimate.`,
    [...missing.values()].map((line) =>
      finding('MATERIAL_NO_STANDARD_COST', 'WARNING', `Line ${line.seq} (${line.code}): the material has no standard cost yet.`, { lineId: line.lineId, column: 'itemId', recordId: line.itemId }),
    ),
  )
}

function labelItem(revision: number, label: GateFacts['label']): GateItem {
  const check = labelCheck({ revision }, label.named ? label.template : null)
  if (check.state === 'OK') return item('LABEL', 'OK', check.message)
  const frozen = label.named
    ? ' It is frozen with the revision: activate it before the first work order (the work-order release asks for it).'
    : ` Once released, revision ${revision} never names one, so no work order of it can be released (the work-order release asks for it).`
  return item('LABEL', 'WARNING', `${check.message}${frozen}`, [
    finding(label.named ? 'LABEL_NOT_ACTIVE' : 'LABEL_MISSING', 'WARNING', `${check.message}${frozen}`, { recordId: label.template?.id ?? null, field: 'labelTemplateId' }),
  ])
}

function certificateItem(certificate: GateCertificate): GateItem {
  if (!certificate.required) return item('CERTIFICATE', 'NOT_REQUIRED', certificate.notRequiredMessage ?? 'No certificate is needed for this style.')
  if (certificate.cells.length === 0) {
    return item('CERTIFICATE', 'WARNING', 'There is no colourway in a size to check against a certificate yet.', [finding('CERTIFICATE_NO_CELLS', 'WARNING', 'There is no colourway in a size to check against a certificate yet.')])
  }
  const open = certificate.cells.filter((entry) => entry.status !== 'COVERED' && entry.status !== 'NOT_REQUIRED')
  if (open.length === 0) return item('CERTIFICATE', 'OK', `A valid certificate covers every switched-on colourway and size the release takes (${plural(certificate.cells.length, 'cell')}).`)
  const labels = open.map((entry) => entry.label)
  const shown = labels.length > 6 ? `${labels.slice(0, 6).join(', ')} and ${labels.length - 6} more` : labels.join(', ')
  return item(
    'CERTIFICATE',
    'WARNING',
    `No valid certificate covers ${shown} today (${open.length} of ${certificate.cells.length}): their garment labels and work orders stay refused until one does (Reg. (EU) 2016/425). Release only the covered ones, or add the certificate in Compliance › Certificates.`,
    open.map((entry) => finding('CELL_NOT_COVERED', 'WARNING', `${entry.label}: ${entry.message}`, { colourwayId: entry.colourwayId, size: entry.size })),
  )
}

function measurementsItem(revision: number, spec: GateFacts['spec']): GateItem {
  if (spec?.status === 'APPROVED') return item('MEASUREMENTS', 'OK', 'The measurement spec is approved: samples, the release and the final inspection measure against it.')
  const words = spec
    ? `The measurement spec of revision ${revision} is not approved yet: once released it stays a draft, and the final inspection measures sizes only against an approved spec. Approve it in Sizes & measurements first.`
    : `Revision ${revision} has no measurement spec: once released it never has one, and the final inspection has no size spec to measure against. Start one in Sizes & measurements.`
  return item('MEASUREMENTS', 'WARNING', words, [finding(spec ? 'SPEC_NOT_APPROVED' : 'SPEC_MISSING', 'WARNING', words, { recordId: spec?.id ?? null })])
}

/** Words for a style field a type may require. */
const ATTRIBUTE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  nameI18n: 'names per language',
  description: 'description',
  season: 'season',
  brandPartyId: 'brand',
  sizes: 'size range',
  baseSize: 'base size',
  ppeStandard: 'PPE standard',
  ppeClass: 'PPE class',
  measurementTemplateId: 'measurement template',
  hsCode: 'HS code',
  originCountry: 'country of origin',
  netMassKg: 'net mass',
  gender: 'gender',
})

function attributesItem(attributes: GateFacts['attributes']): GateItem {
  if (attributes.typeCode === null) return item('ATTRIBUTES', 'NOT_REQUIRED', 'The style has no product type: no attribute is required.')
  if (attributes.required === 0) return item('ATTRIBUTES', 'NOT_REQUIRED', `Product type ${attributes.typeCode} requires no attribute.`)
  if (attributes.missing.length === 0) return item('ATTRIBUTES', 'OK', `Every attribute product type ${attributes.typeCode} requires is filled.`)
  const words = attributes.missing.map((name) => ATTRIBUTE_WORDS[name] ?? name)
  return item(
    'ATTRIBUTES',
    'WARNING',
    `Product type ${attributes.typeCode} requires ${words.join(', ')}: fill ${attributes.missing.length === 1 ? 'it' : 'them'} in the style's details.`,
    attributes.missing.map((name) => finding('ATTRIBUTE_MISSING', 'WARNING', `Product type ${attributes.typeCode} requires the ${ATTRIBUTE_WORDS[name] ?? name}.`, { field: name, column: 'style' })),
  )
}

function changeOrdersItem(orders: GateFacts['changeOrders']): GateItem {
  const findings: GateFinding[] = []
  const proposing = orders.proposing
  if (proposing?.refusal) {
    findings.push(finding(proposing.refusal.code === 'NOT_APPROVED' ? 'CHANGE_ORDER_NOT_APPROVED' : 'CHANGE_ORDER_NOT_EFFECTIVE', 'BLOCKER', proposing.refusal.message, { recordId: proposing.id }))
  }
  for (const order of orders.others) {
    const proposes = order.toRevision === null ? 'proposes no revision yet' : `proposes revision ${order.toRevision}`
    findings.push(
      finding('CHANGE_ORDER_OPEN', 'WARNING', `Change order ${order.number} (${order.status.toLowerCase()}) is open on this style and ${proposes}: releasing this revision outside it leaves it to be decided again.`, {
        recordId: order.id,
      }),
    )
  }
  if (findings.some((entry) => entry.severity === 'BLOCKER')) return item('CHANGE_ORDERS', 'BLOCKED', proposing!.refusal!.message, findings)
  if (findings.length > 0) return item('CHANGE_ORDERS', 'WARNING', `${plural(orders.others.length, 'other change order')} ${orders.others.length === 1 ? 'is' : 'are'} open on this style.`, findings)
  if (proposing) return item('CHANGE_ORDERS', 'OK', `It is released through change order ${proposing.number} (approved).`)
  return item('CHANGE_ORDERS', 'OK', 'No change order is open on this style.')
}

function scopeItem(scope: GateFacts['scope']): GateItem {
  if (scope.problems.length > 0) {
    return item(
      'SCOPE',
      'BLOCKED',
      `What the release takes is not right: ${plural(scope.problems.length, 'problem')} to fix first.`,
      scope.problems.map((entry) => finding(entry.code, 'BLOCKER', entry.message, { colourwayId: entry.colourwayId, size: entry.size, field: entry.path })),
    )
  }
  if (isWhole(scope.asked)) return item('SCOPE', 'OK', 'It is released for every colourway and size.')
  return item('SCOPE', 'OK', `It is released for ${scope.words}${scope.waiting ? `; ${scope.waiting} wait for a later release of this revision` : ''}.`)
}

function driftItem(drift: GateDrift | null): GateItem {
  if (!drift) return item('DRIFT', 'NOT_REQUIRED', 'This is the first release: no quote or order is on an older revision.')
  if (drift.openQuotes === null && drift.openOrders === null) return item('DRIFT', 'NOT_REQUIRED', 'Open quotes and orders are not in your role.')
  const findings: GateFinding[] = []
  if ((drift.openQuotes ?? 0) > 0) {
    findings.push(finding('OPEN_QUOTES', 'WARNING', `${plural(drift.openQuotes!, 'open quote')} ${drift.openQuotes === 1 ? 'was' : 'were'} costed from revision ${drift.previous} and keep${drift.openQuotes === 1 ? 's' : ''} ${drift.openQuotes === 1 ? 'its' : 'their'} price.`))
  }
  if ((drift.openOrders ?? 0) > 0) {
    findings.push(finding('OPEN_ORDERS', 'WARNING', `${plural(drift.openOrders!, 'open order')} ${drift.openOrders === 1 ? 'was' : 'were'} taken on revision ${drift.previous}.`))
  }
  if (findings.length === 0) return item('DRIFT', 'OK', `No open quote or order is on revision ${drift.previous}.`)
  return item('DRIFT', 'WARNING', `Quotes and orders on revision ${drift.previous} stay on it (Versions & changes › Orders on older revisions).`, findings)
}

// ---- the gate ----------------------------------------------------------------------------------------------------------------

/** OK items over the items that apply, in percent, two decimals, half up ("87.5", "100"); null when nothing applies. */
export function completenessOf(items: readonly GateItem[]): string | null {
  const counted = items.filter((entry) => entry.scored && entry.state !== 'NOT_REQUIRED')
  if (counted.length === 0) return null
  const done = counted.filter((entry) => entry.state === 'OK').length
  // Hundredths of a percent, rounded half up with whole numbers only.
  const hundredths = Math.floor((done * 20000 + counted.length) / (2 * counted.length))
  return decimalText(`${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`)
}

export function releaseGate(facts: GateFacts): ReleaseGate {
  const frozen = facts.check === null
  const scope = scopeItem(facts.scope)
  const certificate = certificateItem(facts.certificate)
  const uncovered = facts.certificate.cells.filter((entry) => entry.status !== 'COVERED' && entry.status !== 'NOT_REQUIRED')
  const suggestedScope = facts.certificate.required && facts.scope.problems.length === 0 ? scopeWithout(facts.scope.asked, facts.scope.style, uncovered) : null
  if (frozen) {
    const items = [scope, certificate]
    const all = items.flatMap((entry) => entry.findings)
    return {
      checked: false,
      items,
      blockers: all.filter((entry) => entry.severity === 'BLOCKER'),
      warnings: all.filter((entry) => entry.severity === 'WARNING'),
      completenessPct: facts.storedCompletenessPct,
      releasable: false,
      heldBy: all.find((entry) => entry.severity === 'BLOCKER')?.message ?? null,
      suggestedScope,
    }
  }
  const checks = [...facts.check!.blockers, ...facts.check!.warnings].map(fromCheck)
  const items = [
    checkItem(
      'BOM',
      checks.filter((entry) => !ROUTING_CODES.has(entry.code) && !MATERIAL_CODES.has(entry.code)),
      { ok: 'The BOM is complete: quantities, colours per colourway and sizes.', what: 'The BOM' },
    ),
    checkItem('ROUTING', checks.filter((entry) => ROUTING_CODES.has(entry.code)), { ok: 'The routing has its operations, each with its minutes, and a scan point.', what: 'The routing' }),
    smvItem(facts.steps),
    materialsItem(facts.lines, checks.filter((entry) => MATERIAL_CODES.has(entry.code))),
    pricesItem(facts.lines),
    labelItem(facts.revision.revision, facts.label),
    certificate,
    measurementsItem(facts.revision.revision, facts.spec),
    attributesItem(facts.attributes),
    changeOrdersItem(facts.changeOrders),
    scope,
    driftItem(facts.drift),
  ]
  const all = items.flatMap((entry) => entry.findings)
  const blockers = all.filter((entry) => entry.severity === 'BLOCKER')
  return {
    checked: true,
    items,
    blockers,
    warnings: all.filter((entry) => entry.severity === 'WARNING'),
    completenessPct: completenessOf(items),
    releasable: facts.revision.status === 'DRAFT' && facts.styleStatus !== 'ARCHIVED' && blockers.length === 0,
    heldBy: facts.styleStatus === 'ARCHIVED' ? 'The style is archived: reactivate it before a release.' : (blockers[0]?.message ?? null),
    suggestedScope,
  }
}

/**
 * What happens, in words (design styles.release): "Revision 4 becomes the one every new work order uses. Revision 3 becomes
 * obsolete; 1 work order in progress keeps revision 3. 2 open quotes were costed from revision 3 and keep their price."
 */
export function effectsOf(facts: Pick<GateFacts, 'revision' | 'styleStatus' | 'drift' | 'scope'>): string[] {
  const n = facts.revision.revision
  const words: string[] = []
  if (!facts.drift) {
    words.push(`Revision ${n} becomes the style's current revision: every new work order uses it.`)
    if (facts.styleStatus === 'DRAFT') words.push('The style becomes active: it can be sold.')
  } else {
    const p = facts.drift.previous
    words.push(`Revision ${n} becomes the one every new work order uses. Revision ${p} becomes obsolete.`)
    if ((facts.drift.workOrdersInProgress ?? 0) > 0) words.push(`${plural(facts.drift.workOrdersInProgress!, 'work order')} in progress keep${facts.drift.workOrdersInProgress === 1 ? 's' : ''} revision ${p}.`)
    if ((facts.drift.draftWorkOrders ?? 0) > 0) words.push(`${plural(facts.drift.draftWorkOrders!, 'draft work order')} on revision ${p} take${facts.drift.draftWorkOrders === 1 ? 's' : ''} revision ${n} before ${facts.drift.draftWorkOrders === 1 ? 'its' : 'their'} release.`)
    if ((facts.drift.openQuotes ?? 0) > 0) words.push(`${plural(facts.drift.openQuotes!, 'open quote')} ${facts.drift.openQuotes === 1 ? 'was' : 'were'} costed from revision ${p} and keep${facts.drift.openQuotes === 1 ? 's' : ''} ${facts.drift.openQuotes === 1 ? 'its' : 'their'} price.`)
    if ((facts.drift.openOrders ?? 0) > 0) words.push(`${plural(facts.drift.openOrders!, 'open order')} ${facts.drift.openOrders === 1 ? 'was' : 'were'} taken on revision ${p}.`)
  }
  if (!isWhole(facts.scope.asked) && facts.scope.problems.length === 0) {
    words.push(`It is released for ${facts.scope.words}${facts.scope.waiting ? `; ${facts.scope.waiting} wait for a later release of revision ${n}` : ''}.`)
  }
  return words
}
