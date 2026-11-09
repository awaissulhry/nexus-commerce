import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { fitsDecimal } from '../../core/money'
import { notMoney } from '../../money/marked'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { MINUTES_INPUT_SCALE, MINUTES_PRECISION, MINUTES_SCALE, OPERATION_STATUSES, WORK_CENTRE_KINDS } from '../routing/operations'
import { ALLOWANCE_PRECISION, ALLOWANCE_SCALE, MAX_REASON, MAX_SIZE_TIMES, STEP_RUN_SOURCES, TIME_SOURCES, TIME_VERSION_STATUSES } from './rules'

/**
 * Standard minutes and their governance (B-W2b-215; PRD-111, PRD-113, PRD-114, PRD-126): what apps/factory-api's
 * modules/product/minutes accepts and answers, and what the screens of B-W2b-235 (Products › Operations › Minutes, Propose
 * SMV change, the routing's set-up / run / wait / move and extra minutes per size) and B-W2b-244 (Changes & versions: SMV
 * changes) read. Minutes travel as plain decimal strings ("14.5"); allowances in percent ("5", "4.5"). No money.
 *
 *   GET  /product/operations/:operationId/minutes            the operation's SMV, how it is built, its versions, what it feeds
 *   POST /product/operations/:operationId/minutes/proposals  Propose SMV change (Send for approval)
 *   POST …/minutes/versions/:versionId/approve | reject     a second person decides
 *   GET  /product/minutes/waiting                            the SMV changes waiting for approval (the tile, Changes & versions)
 *   GET  /product/styles/:styleId/revisions/:revisionId/routing/times                 run, set-up, wait, move, per size, a lead time
 *   PUT  /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/minutes a draft step's minutes
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const version = () => z.number().int().min(1)
const plain = (precision: number, scale: number, words: string) =>
  z.string().refine((value) => /^\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value, precision, scale), { message: words })
/** Typed minutes: at most 7 digits and 6 decimals (rounded half up to 3 by the rules). */
const minutes = () => plain(MINUTES_PRECISION - MINUTES_SCALE + MINUTES_INPUT_SCALE, MINUTES_INPUT_SCALE, `Expected minutes with at most ${MINUTES_PRECISION - MINUTES_SCALE} digits and ${MINUTES_INPUT_SCALE} decimals.`)
/** An allowance in percent: from 0, below 100 (the rules), at most 4 decimals. */
const percent = () => plain(ALLOWANCE_PRECISION, ALLOWANCE_SCALE, `Expected a percentage with at most ${ALLOWANCE_SCALE} decimals.`)
/** Extra minutes of a size: a minus for less. */
const signedMinutes = () =>
  z.string().refine((value) => /^-?\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value.replace(/^-/, ''), MINUTES_PRECISION - MINUTES_SCALE + MINUTES_INPUT_SCALE, MINUTES_INPUT_SCALE), {
    message: `Expected minutes (a minus for less) with at most ${MINUTES_PRECISION - MINUTES_SCALE} digits and ${MINUTES_INPUT_SCALE} decimals.`,
  })

const allowances = { basicMinutes: minutes(), personalPct: percent(), fatiguePct: percent(), delayPct: percent() }

// ---- the operation's minutes ----------------------------------------------------------------------------------------------

/** Propose SMV change: the new numbers, where they come from, from which day, why; `replaces` the waiting proposal. */
export const proposeBody = input({
  ...allowances,
  source: z.enum(TIME_SOURCES),
  effectiveFrom: businessDate(),
  reason: text(MAX_REASON),
  /** The waiting proposal this one replaces (it becomes SUPERSEDED with no decision); without it a waiting one refuses. */
  replaces: id().optional(),
})
export type ProposeBody = z.output<typeof proposeBody>

/** A decision sends the version's `version` (it was read as it is decided). */
export const approveBody = input({ version: version(), note: text(MAX_REASON).optional() })
export type ApproveBody = z.output<typeof approveBody>
export const rejectBody = input({ version: version(), note: text(MAX_REASON) })
export type RejectBody = z.output<typeof rejectBody>

const person = output({ id: id(), name: z.string() })

/** One version of an operation's SMV (the Minutes tab's timeline). */
export const timeVersionView = output({
  id: id(),
  number: z.number().int(),
  status: z.enum(TIME_VERSION_STATUSES),
  basicMinutes: z.string(),
  personalPct: z.string(),
  fatiguePct: z.string(),
  delayPct: z.string(),
  standardMinutes: z.string(),
  source: z.enum(TIME_SOURCES),
  effectiveFrom: businessDate(),
  reason: z.string(),
  proposedBy: person,
  proposedAt: instant(),
  decidedBy: person.nullable(),
  decidedAt: instant().nullable(),
  decisionNote: z.string().nullable(),
  /** The one whose numbers apply today. */
  inForce: z.boolean(),
  /** Approved, its day not come: it takes effect then. */
  waiting: z.boolean(),
  version: z.number().int(),
})
export type TimeVersionView = z.infer<typeof timeVersionView>

const storedMinutes = output({
  standardMinutes: z.string(),
  basicMinutes: z.string().nullable(),
  personalPct: z.string().nullable(),
  fatiguePct: z.string().nullable(),
  delayPct: z.string().nullable(),
})

const routingUse = output({
  style: output({ id: id(), code: z.string(), name: z.string() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
  stepId: id(),
  seq: z.number().int(),
  standardMinutes: z.string(),
  /** Where the step's SMV comes from: an approved version (its number), its own allowances, or typed. */
  runFrom: z.enum(STEP_RUN_SOURCES),
  timeVersionNumber: z.number().int().nullable(),
})

const pieceRateUse = output({
  table: output({ id: id(), code: z.string(), name: z.string() }),
  versionId: id(),
  versionNo: z.number().int(),
  status: z.string(),
  effectiveFrom: businessDate(),
  sizeBand: z.string(),
  /** The SMV the rate was made with (no pay figure here). */
  standardMinutes: z.string().nullable(),
})

/** The operation's Minutes tab: its SMV and how it is built, governed or not, its versions and what an SMV change reaches. */
export const operationMinutesView = output({
  operation: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), workCentreKind: z.enum(WORK_CENTRE_KINDS), status: z.enum(OPERATION_STATUSES), version: z.number().int() }),
  /** The operation's five numbers as stored now. */
  current: storedMinutes,
  /** Some version was approved: the SMV changes only by a new version, approved by a second person. */
  governed: z.boolean(),
  /** Today in the business time zone, and the SMV that applies today (an approved version, else the operation's own). */
  today: businessDate(),
  inForce: output({ standardMinutes: z.string(), versionId: id().nullable(), number: z.number().int().nullable(), effectiveFrom: businessDate().nullable() }),
  /** The waiting proposal (one per operation), or null. */
  pendingId: id().nullable(),
  /** Newest first. */
  versions: z.array(timeVersionView),
  /** "Routings and piece rates affected": draft and released routing steps made from it, and piece rates on its SMV. */
  impact: output({
    routings: z.array(routingUse),
    /** Rates paid on SMV × rate per minute that name it, in versions not cancelled or superseded; null rows: the caller may not see piece rates. */
    pieceRates: output({ count: z.number().int(), rows: z.array(pieceRateUse).nullable() }),
  }),
  /** What the caller may do now. */
  may: output({ propose: z.boolean(), decide: z.boolean() }),
})
export type OperationMinutesView = z.infer<typeof operationMinutesView>

/** The SMV changes waiting for approval (design products.operations tile; products.changes "SMV change"). */
export const waitingQuery = input({
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type WaitingQuery = z.output<typeof waitingQuery>

export const waitingView = output({
  versions: z.array(
    output({
      operation: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), standardMinutes: z.string() }),
      proposal: timeVersionView,
      /** The caller may decide it (holds product.smv.approve over it and did not propose it). */
      mayDecide: z.boolean(),
    }),
  ),
  count: z.number().int(),
})
export type WaitingView = z.infer<typeof waitingView>

// ---- the routing's times ----------------------------------------------------------------------------------------------------

/** A draft step's run: copy an approved version (the one in force today when none is named), allowances, or a typed SMV. */
const runBody = z.discriminatedUnion('from', [
  input({ from: z.literal('VERSION'), timeVersionId: id().optional() }),
  input({ from: z.literal('ALLOWANCES'), ...allowances }),
  input({ from: z.literal('TYPED'), standardMinutes: minutes() }),
])

/** A draft step's minutes: what is sent changes (null clears a side minute; sizeTimes replaces the step's whole list). */
export const stepMinutesBody = input({
  /** The revision's version (a revision's BOM and routing are one versioned record). */
  version: version(),
  run: runBody.optional(),
  setupMinutes: minutes().nullable().optional(),
  waitMinutes: minutes().nullable().optional(),
  moveMinutes: minutes().nullable().optional(),
  sizeTimes: z.array(input({ size: z.string().trim().min(1).max(20), extraMinutes: signedMinutes() })).max(MAX_SIZE_TIMES).optional(),
})
export type StepMinutesBody = z.output<typeof stepMinutesBody>

/** A lead time for planning: n garments of one size (or of the step's base minutes when no size is named). */
export const routingTimesQuery = input({
  quantity: z.coerce.number().int().min(1).max(1_000_000).optional(),
  size: z.string().trim().min(1).max(20).optional(),
})
export type RoutingTimesQuery = z.output<typeof routingTimesQuery>

const sizeMinutes = output({ size: z.string(), minutes: z.string() })

export const stepTimesView = output({
  stepId: id(),
  seq: z.number().int(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.enum(WORK_CENTRE_KINDS),
  operationId: id(),
  /** The run per garment and how it is built. */
  run: output({
    from: z.enum(STEP_RUN_SOURCES),
    standardMinutes: z.string(),
    basicMinutes: z.string().nullable(),
    personalPct: z.string().nullable(),
    fatiguePct: z.string().nullable(),
    delayPct: z.string().nullable(),
    timeVersion: output({ id: id(), number: z.number().int(), status: z.enum(TIME_VERSION_STATUSES), effectiveFrom: businessDate() }).nullable(),
  }),
  /** The library's SMV today, and whether the step follows it ('Library: 4.20 · Use library value' when it does not). */
  library: output({ standardMinutes: z.string(), governed: z.boolean(), inForceVersionId: id().nullable(), inForceNumber: z.number().int().nullable(), differs: z.boolean() }),
  setupMinutes: z.string().nullable(),
  waitMinutes: z.string().nullable(),
  moveMinutes: z.string().nullable(),
  /** B-W2b-225's cells: a step only for these sizes (empty: every size). */
  appliesToSizes: z.array(z.string()),
  /** Extra minutes per size, in range order, with the step's minutes in that size. */
  sizeTimes: z.array(output({ size: z.string(), extraMinutes: z.string(), minutes: z.string() })),
  version: z.number().int(),
})

export const routingTimesView = output({
  revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES), version: z.number().int() }),
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  sizes: z.array(output({ code: z.string(), label: z.string() })),
  steps: z.array(stepTimesView),
  /** One garment at the steps' base minutes, and per size with the extra minutes (PRD-114). */
  perGarment: z.string(),
  bySize: z.array(sizeMinutes),
  /** Per work order (PRD-126): the steps' set-up, wait and move minutes added up. */
  setup: z.string(),
  wait: z.string(),
  move: z.string(),
  /** With ?quantity (and ?size): set-up + run × quantity + wait + move, in minutes (no money). */
  lead: output({ quantity: z.number().int(), size: z.string().nullable(), setup: z.string(), run: z.string(), wait: z.string(), move: z.string(), total: notMoney(z.string()) }).nullable(),
  /** A DRAFT revision of a style that is not archived. */
  editable: z.boolean(),
})
export type RoutingTimesView = z.infer<typeof routingTimesView>
