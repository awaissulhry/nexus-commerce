import type { Issue } from '../../core/errors'
import type { StepData } from '../../product/routing/rules'
import type { WorkCentreKind } from '../../product/routing/operations'
import type { ReleaseCheck, ReleaseCheckCode } from './release'
import { planOperations, type PlannedOperation, type SiteWorkCentre } from './spec'

/**
 * A repair work order (B-W2a-12; MES-019 "Repair work order from a return"; design sales.returns "Repair order" › Work ›
 * "Make repair work order"), pure. A repair order (wave 2: a repair or an alteration of ONE customer garment) gets a work
 * order of kind REPAIR at its site, made by the office:
 *
 *   the garment  one cell of one garment: the sold sales order line and size it names — asked, else its RMA line's, else
 *                the cell its serial was made in (a serial read from the label of one of our garments); the line is the
 *                repair's customer's, of its company, its style and colourway when the repair names them; a size-grid
 *                line's size is one it sold, a made-to-measure unit keeps its line's profile (one unit).
 *   the steps    the routing steps of the revision the repair needs (not the whole routing), at least one, each at an
 *                ACTIVE work centre of its kind on the site (factory-db: a REPAIR is released with at least one
 *                operation). They are stored on the DRAFT and frozen by the release as they are.
 *   the release  THE release check with a repair's own answers: revision, label template, the steps' work centres,
 *                the cell's size and the batch series as for any work order; no certificate (a repair puts no new
 *                garment on the market: the repair order's safety check confirms the certificate still covers it), no
 *                BOM and no material plan (what a repair uses is issued to it by hand), no deposit (no new sale).
 *   the stage    a repair order still before its repair is done: AWAITING_GOODS, RECEIVED, ESTIMATED, APPROVED or
 *                IN_REPAIR, without a live (not CANCELLED) repair work order already.
 * A repair work order is not production of the sold line: it never counts against what is open on the line, and its
 * garment never goes into finished goods (modules/production/completion refuses it).
 */

export const REPAIRABLE_STAGES = ['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR'] as const

/** At most this many steps on one repair. */
export const MAX_REPAIR_STEPS = 50

export function repairStageProblem(number: string, stage: string): string | null {
  if ((REPAIRABLE_STAGES as readonly string[]).includes(stage)) return null
  if (stage === 'REPAIRED') return `Repair ${number} is REPAIRED: its work is done (back to IN_REPAIR first if it needs more).`
  return `Repair ${number} is ${stage}: it gets no repair work order any more.`
}

export function liveWorkOrderProblem(number: string, workOrder: { readonly number: string; readonly status: string } | null): string | null {
  if (!workOrder || workOrder.status === 'CANCELLED') return null
  return `Repair ${number} already has repair work order ${workOrder.number} (${workOrder.status}); cancel it first to make another.`
}

// ---- the garment -----------------------------------------------------------------------------------------------------

export type GarmentSource = 'ASKED' | 'RETURN_LINE' | 'SERIAL'

export interface GarmentRef {
  readonly salesOrderLineId: string
  readonly size: string | null
}

export interface RepairGarment extends GarmentRef {
  readonly from: GarmentSource
}

/** Where the repair's garment was sold: asked, else the RMA line's, else the serial's cell; null when none says it. */
export function repairGarmentOf(input: { readonly asked: GarmentRef | null; readonly returnLine: GarmentRef | null; readonly serialCell: GarmentRef | null }): RepairGarment | null {
  if (input.asked) return { ...input.asked, from: 'ASKED' }
  if (input.returnLine) return { ...input.returnLine, from: 'RETURN_LINE' }
  if (input.serialCell) return { ...input.serialCell, from: 'SERIAL' }
  return null
}

export const NO_GARMENT_WORDS =
  'The repair names no RMA line and no serial of one of our garments: name the sales order line (and size) the garment was sold on.'

export interface SoldLineFacts {
  readonly id: string
  readonly seq: number
  readonly orderNumber: string
  readonly companyId: string
  readonly partyId: string
  readonly styleId: string
  readonly colourwayId: string
  readonly kind: string
  readonly measurementProfileId: string | null
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
}

export interface RepairFacts {
  readonly number: string
  readonly companyId: string
  readonly partyId: string
  readonly styleId: string | null
  readonly colourwayId: string | null
  /** The size the repair order names (as read from the label). */
  readonly size: string | null
}

/** The size the cell repairs: the garment's, else the repair's, else a made-to-measure line's only one. */
export function repairSizeOf(garment: GarmentRef, repair: RepairFacts, line: SoldLineFacts): string | null {
  const size = garment.size ?? repair.size
  if (size) return size
  return line.kind === 'MADE_TO_MEASURE' && line.sizes.length === 1 ? line.sizes[0]!.size : null
}

/** The sold line against the repair (400 issues at `path`). */
export function repairLineProblems(repair: RepairFacts, line: SoldLineFacts, size: string | null, path: string): Issue[] {
  const problems: Issue[] = []
  const what = `${line.orderNumber} line ${line.seq}`
  if (line.companyId !== repair.companyId) problems.push({ path, message: `${what} is another company's than repair ${repair.number}.` })
  if (line.partyId !== repair.partyId) problems.push({ path, message: `${what} was sold to another customer than repair ${repair.number}'s.` })
  if (repair.styleId && repair.styleId !== line.styleId) problems.push({ path, message: `${what} is another style than repair ${repair.number} names.` })
  if (repair.colourwayId && repair.colourwayId !== line.colourwayId) problems.push({ path, message: `${what} is another colourway than repair ${repair.number} names.` })
  if (!size) problems.push({ path: `${path}/size`, message: `Name the garment's size (${what}).` })
  else if (line.kind !== 'MADE_TO_MEASURE' && !line.sizes.some((entry) => entry.size === size && entry.quantity > 0)) {
    problems.push({ path: `${path}/size`, message: `${what} sold no size ${size}.` })
  }
  return problems
}

// ---- the steps -------------------------------------------------------------------------------------------------------

/** The routing steps the repair needs, at the site's work centres (400 issues at `path/<i>`). */
export function repairStepPlan(steps: readonly StepData[], seqs: readonly number[], centres: readonly SiteWorkCentre[], revision: number, path: string): { readonly operations: PlannedOperation[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  if (seqs.length === 0) problems.push({ path, message: 'Choose at least one routing step the repair needs.' })
  if (seqs.length > MAX_REPAIR_STEPS) problems.push({ path, message: `At most ${MAX_REPAIR_STEPS} steps.` })
  const bySeq = new Map(steps.map((step) => [step.seq, step]))
  const chosen: StepData[] = []
  const seen = new Set<number>()
  seqs.forEach((seq, index) => {
    const step = bySeq.get(seq)
    if (seen.has(seq)) problems.push({ path: `${path}/${index}`, message: 'Name each step once.' })
    else if (!step) problems.push({ path: `${path}/${index}`, message: `Revision ${revision}'s routing has no step ${seq}.` })
    else chosen.push(step)
    seen.add(seq)
  })
  const { operations, missing } = planOperations(chosen, centres)
  for (const gap of missing) {
    for (const step of gap.steps) {
      const index = seqs.indexOf(step.seq)
      problems.push({ path: `${path}/${index}`, message: `Step ${step.seq} ${step.code} (${step.name}) needs an active ${gap.kind} work centre on the site; it has none.` })
    }
  }
  return { operations, problems }
}

// ---- the release ------------------------------------------------------------------------------------------------------

/** What a repair does not check, in words (design 02 "Release check": every line says why). */
export const REPAIR_NOT_REQUIRED: Readonly<Partial<Record<ReleaseCheckCode, string>>> = Object.freeze({
  CERTIFICATE: "A repair puts no new garment on the market: the repair order's safety check confirms the certificate still covers it.",
  BOM: 'A repair plans no BOM material: what it uses is issued to it by hand.',
  DEPOSIT: 'A repair is no new sale: no deposit is checked.',
  MATERIAL: 'A repair plans no material.',
})

export function repairNotRequired(code: 'CERTIFICATE' | 'BOM' | 'DEPOSIT' | 'MATERIAL'): ReleaseCheck {
  return { code, state: 'NOT_REQUIRED', message: REPAIR_NOT_REQUIRED[code]!, problems: [] }
}

/** A stored step of a repair DRAFT with its work centre as it is now. */
export interface RepairStep {
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly workCentreKind: WorkCentreKind
  readonly workCentreCode: string | null
  readonly workCentreStatus: string | null
}

/** The repair's steps: at least one, each at an ACTIVE work centre of the site. */
export function repairWorkCentreCheck(siteCode: string, steps: readonly RepairStep[]): ReleaseCheck {
  if (steps.length === 0) {
    const message = 'The repair names no step: choose the routing steps it needs.'
    return { code: 'WORK_CENTRES', state: 'BLOCKED', message, problems: [{ path: 'checks/WORK_CENTRES', message }] }
  }
  const idle = steps.filter((step) => step.workCentreStatus !== 'ACTIVE')
  if (idle.length > 0) {
    return {
      code: 'WORK_CENTRES',
      state: 'BLOCKED',
      message: `${idle.length} step(s) of the repair run at a work centre of site ${siteCode} that is not active: choose the steps again.`,
      problems: idle.map((step) => ({ path: `checks/WORK_CENTRES/${step.seq}`, message: `Step ${step.seq} ${step.code} (${step.name}): work centre ${step.workCentreCode ?? '?'} is not active.` })),
    }
  }
  return { code: 'WORK_CENTRES', state: 'OK', message: `The repair's ${steps.length} step(s) run at active work centres of site ${siteCode}.`, problems: [] }
}
