import { z } from 'zod'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { EARNINGS_KINDS, EARNINGS_REFUSALS, HOLD_REASONS, HOLD_STATUSES, LIST_LIMIT, NOTE_MAX, PERIOD_CHECKS, REASON_MAX, REASON_MIN, STATEMENT_STATUSES } from '@nexus/factory-domain/people/earnings/rules'
import { OPEN_NOTE_MAX, OPEN_REASONS } from '@nexus/factory-domain/people/privacy/figures'
import { PERIOD_STATUSES } from '@nexus/factory-domain/people/schemes/rules'

/**
 * Earnings and pay periods (B-W2b-43; MES-256, MES-260, MES-261, MES-264, MES-266; design people.piecerates "Pay periods",
 * "Earnings ledger", "Held scans", "Worker statement"). Every rate and amount is `money.pay` (HR and the worker; the API
 * drops it for everyone else and refuses a body that sends one), labour cost per piece is `money.cost`. A list never names
 * a person nor carries one person's figure (Owner answer W1): its rows are states and counts; a person opens one record at a
 * time. Every write carries the version read.
 */

const version = z.number().int().min(1)
const reason = z.string().trim().min(REASON_MIN).max(REASON_MAX)
const note = z.string().trim().max(NOTE_MAX)
const month = z.string().regex(/^\d{4}-\d{2}$/)
const params = input({ periodId: id() })
const personKey = z.string().max(64).optional()

const refusalView = output({ code: z.enum(EARNINGS_REFUSALS), message: z.string() }).nullable()
const actionView = output({ allowed: z.boolean(), refusal: refusalView })
const ref = output({ code: z.string(), name: z.string() })

const periodRow = output({
  id: id(),
  companyId: id(),
  month,
  periodStart: businessDate(),
  periodEnd: businessDate(),
  status: z.enum(PERIOD_STATUSES),
  /** How many people have entries. */
  people: z.number().int(),
  /** The period's totals: null below the company's minimum group (without the right), or without the pay grain. */
  earnings: money.pay(amountMinor().nullable()),
  makeUp: money.pay(amountMinor().nullable()),
  currency: z.string(),
  tooFew: z.boolean(),
  heldOpen: z.number().int(),
  disputesOpen: z.number().int(),
  statements: output({ draft: z.number().int(), approved: z.number().int() }),
  version: z.number().int(),
})

export const periodsContract = defineContract({
  querystring: input({ companyId: id().optional(), status: z.enum(PERIOD_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(60).optional() }),
  response: { 200: output({ periods: z.array(periodRow), payShown: z.boolean(), words: z.array(z.string()) }) },
})

const lineRow = output({
  line: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  people: z.number().int().nullable(),
  pieces: z.string().nullable(),
  earnings: money.pay(amountMinor().nullable()),
  makeUp: money.pay(amountMinor().nullable()),
  makeUpSharePct: z.string().nullable(),
  tooFew: z.boolean(),
})

const periodDetail = output({
  period: periodRow.extend({ previewedAt: instant().nullable(), reviewStartedAt: instant().nullable(), lockedAt: instant().nullable(), lockNote: z.string().nullable() }),
  /** What stands in the way (blocking) and what is told, each in words. */
  checks: z.array(output({ code: z.enum(PERIOD_CHECKS), blocking: z.boolean(), count: z.number().int(), words: z.string() })),
  /** The period per line: no person; a group under the minimum shows nothing. */
  lines: z.array(lineRow),
  actions: output({ run: actionView, reopen: actionView, startReview: actionView, back: actionView, lock: actionView }),
  /** What "Lock" asks to be typed. */
  lockPhrase: z.string(),
  canManage: z.boolean(),
  payShown: z.boolean(),
})

const runView = output({ people: z.number().int(), added: z.number().int(), reversed: z.number().int() })

export const periodContract = defineContract({ params, response: { 200: periodDetail } })
export const createPeriodContract = defineContract({
  body: input({ companyId: id(), month }),
  response: { 200: periodDetail.extend({ created: z.boolean(), replayed: z.boolean() }), 201: periodDetail.extend({ created: z.boolean(), replayed: z.boolean() }) },
})
export const runContract = defineContract({ params, body: input({ version }), response: { 200: periodDetail.extend({ run: runView }) } })
export const reopenContract = defineContract({ params, body: input({ version }), response: { 200: periodDetail } })
export const backContract = defineContract({ params, body: input({ version, reason }), response: { 200: periodDetail } })
export const lockContract = defineContract({ params, body: input({ version, phrase: z.string().max(40), note: note.optional() }), response: { 200: periodDetail } })

export const statementsContract = defineContract({
  params,
  response: {
    200: output({
      periodId: id(),
      month,
      statements: z.array(output({ id: id(), siteId: id(), status: z.enum(STATEMENT_STATUSES), revision: z.number().int(), leadReviewed: z.boolean(), stale: z.boolean(), version: z.number().int() })),
      words: z.array(z.string()),
    }),
  },
})

const statementLine = output({ operationCode: z.string(), operationName: z.string(), pieces: z.number().int(), minutes: z.string(), sharePct: z.string().nullable(), rate: money.pay(unitPrice()), amount: money.pay(amountMinor()) })
const timeLine = output({ code: z.string(), minutes: z.string(), rate: money.pay(unitPrice()), amount: money.pay(amountMinor()) })
/** B-W2b-84: a standard-minute bonus scheme's figures of the person's period, inside their one record (never a list). */
const bonusView = output({ minutesPresent: z.number().int(), standardMinutes: z.string(), thresholdMinutes: z.string(), efficiencyPct: z.string(), bonusMinutes: z.string(), amount: money.pay(amountMinor()) }).nullable()
const statementParams = input({ statementId: id() })
const statementView = output({
  id: id(),
  periodId: id(),
  month,
  periodStatus: z.enum(PERIOD_STATUSES),
  person: output({ employeeId: id(), name: z.string(), code: z.string().nullable() }),
  revision: z.number().int(),
  status: z.enum(STATEMENT_STATUSES),
  openedAs: z.enum(['HR', 'LEAD']),
  currency: z.string(),
  /** Pieces per operation: the minutes are the standard minutes earned. */
  lines: z.array(statementLine),
  /** Paid time off standard. */
  time: z.array(timeLine),
  /** Adjustments, and work of a locked month paid here. */
  corrections: z.array(output({ kind: z.enum(EARNINGS_KINDS), month: z.string().nullable(), words: z.string().nullable(), amount: money.pay(amountMinor()) })),
  attendance: output({ ordinaryMinutes: z.number().int(), approvedOvertimeMinutes: z.number().int() }).nullable(),
  makeUp: output({ minutes: z.number(), rate: money.pay(unitPrice()), guaranteed: money.pay(amountMinor()), earned: money.pay(amountMinor()), amount: money.pay(amountMinor()) }).nullable(),
  held: output({ open: z.number().int(), counted: z.number().int(), notPaid: z.number().int() }),
  /** othersScrap, othersRework (B-W2b-84): of which their reasons put down to others (paid as time). */
  defects: output({ scrap: z.number().int(), rework: z.number().int(), othersScrap: z.number().int(), othersRework: z.number().int() }),
  /** A standard-minute bonus scheme's period (B-W2b-84); null: none applies. */
  bonus: bonusView,
  disputes: z.array(output({ id: id(), status: z.string(), workDate: businessDate(), recordType: z.string() })),
  earningsAmount: money.pay(amountMinor().nullable()),
  makeUpAmount: money.pay(amountMinor().nullable()),
  stale: z.boolean(),
  leadReview: output({ at: z.string(), byName: z.string().nullable(), note: z.string().nullable() }).nullable(),
  fileId: id().nullable(),
  approvedAt: instant().nullable(),
  canApprove: z.boolean(),
  version: z.number().int(),
  words: z.array(z.string()),
})

export const openStatementContract = defineContract({
  params: statementParams,
  /** A lead's opening says why (recorded); HR's needs nothing. */
  body: input({ reason: z.enum(OPEN_REASONS).optional(), note: z.string().trim().max(OPEN_NOTE_MAX).optional() }),
  response: { 200: statementView },
})
/** The PDF's bytes (B-W2b-62): `response` left open, as every document. */
export const statementPdfContract = defineContract({ params: statementParams, response: {} })
export const approveStatementContract = defineContract({ params: statementParams, body: input({ version }), response: { 200: statementView } })
export const leadReviewContract = defineContract({
  params: statementParams,
  body: input({ version, note: note.optional() }),
  response: { 200: output({ id: id(), status: z.literal('DRAFT'), leadReview: output({ at: z.string(), byName: z.string().nullable(), note: z.string().nullable() }) }) },
})
export const employeeStatementsContract = defineContract({
  params: input({ employeeId: id() }),
  response: {
    200: output({
      employeeId: id(),
      payShown: z.boolean(),
      statements: z.array(output({ id: id(), month, periodStatus: z.enum(PERIOD_STATUSES), status: z.enum(STATEMENT_STATUSES), revision: z.number().int(), currency: z.string(), earningsAmount: money.pay(amountMinor().nullable()), makeUpAmount: money.pay(amountMinor().nullable()), approvedOn: businessDate().nullable() })),
    }),
  },
})

const heldRow = output({
  id: id(),
  siteId: id(),
  periodId: id(),
  at: instant(),
  bundle: z.string(),
  operation: ref,
  lineId: id().nullable(),
  pieces: z.number().int(),
  reason: z.enum(HOLD_REASONS),
  reasonWords: z.string(),
  status: z.enum(HOLD_STATUSES),
  version: z.number().int(),
})
const heldParams = input({ heldScanId: id() })
const heldRecord = heldRow.extend({
  day: businessDate(),
  people: z.array(output({ employeeId: id(), name: z.string(), clockedIn: z.boolean() })),
  peopleShown: z.boolean(),
  attendanceDayId: id().nullable(),
  voided: z.boolean(),
  canCount: z.boolean(),
  resolution: output({ at: instant().nullable(), note: z.string().nullable(), fixRecordType: z.string().nullable(), fixRecordId: id().nullable() }).nullable(),
})

export const heldListContract = defineContract({
  querystring: input({ periodId: id().optional(), siteId: id().optional(), status: z.enum(HOLD_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(LIST_LIMIT).optional(), employeeId: personKey }),
  response: { 200: output({ held: z.array(heldRow), words: z.array(z.string()) }) },
})
export const heldRecordContract = defineContract({ params: heldParams, response: { 200: heldRecord } })
export const countHeldContract = defineContract({ params: heldParams, body: input({ version, note: note.optional() }), response: { 200: heldRecord } })
export const notPaidHeldContract = defineContract({ params: heldParams, body: input({ version, reason }), response: { 200: heldRecord } })

const entryRow = output({
  id: id(),
  workDate: businessDate(),
  siteId: id(),
  periodId: id(),
  kind: z.enum(EARNINGS_KINDS),
  bundle: z.string().nullable(),
  operation: ref.nullable(),
  pieces: z.number().int().nullable(),
  minutes: z.string().nullable(),
  sharePct: z.string().nullable(),
  rate: money.pay(unitPrice().nullable()),
  amount: money.pay(amountMinor()),
  currency: z.string(),
  reversesId: id().nullable(),
  correctsMonth: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: instant(),
})
const entryRecord = entryRow.extend({ person: output({ employeeId: id(), name: z.string(), code: z.string().nullable() }), reversedById: id().nullable(), canCorrect: z.boolean() })

export const ledgerContract = defineContract({
  querystring: input({
    periodId: id().optional(),
    siteId: id().optional(),
    lineId: id().optional(),
    kind: z.enum(EARNINGS_KINDS).optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    /** Refused: a list never filters or groups by person (Owner answer W1). */
    employeeId: personKey,
    groupBy: z.enum(['date', 'line', 'employeeId', 'workerId', 'personId']).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(LIST_LIMIT).optional(),
  }),
  response: { 200: output({ entries: z.array(entryRow), nextCursor: z.string().nullable(), words: z.array(z.string()) }) },
})
export const entryContract = defineContract({ params: input({ entryId: id() }), response: { 200: entryRecord } })
export const correctContract = defineContract({
  params: input({ entryId: id() }),
  /** `amount`: the new line, minor units, any sign; none: the entry is only taken back. */
  body: input({ reason, amount: money.pay(amountMinor()) }),
  response: { 200: entryRecord },
})
export const adjustContract = defineContract({
  body: input({ employeeId: id(), siteId: id(), workDate: businessDate(), amount: money.pay(amountMinor()), currency: currency().optional(), reason }),
  response: { 201: entryRecord, 200: entryRecord },
})

export const countsContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: { 200: output({ heldOpen: z.number().int(), disputesOpen: z.number().int(), asOf: instant() }) },
})

export const labourCostContract = defineContract({
  querystring: input({ companyId: id(), siteId: id().optional(), styleId: id().optional(), from: businessDate().optional(), to: businessDate().optional() }),
  response: {
    200: output({
      companyId: id(),
      from: businessDate(),
      to: businessDate(),
      rows: z.array(
        output({
          style: output({ id: id(), code: z.string(), name: z.string() }),
          operation: ref,
          pieces: z.number().int(),
          standardMinutes: z.string(),
          currency: z.string(),
          labourCost: money.cost(amountMinor()),
          labourCostPerPiece: money.cost(unitPrice().nullable()),
          costingPerPiece: money.cost(unitPrice().nullable()),
          differencePerPiece: money.cost(z.string().nullable()),
          paidPerPiece: money.pay(unitPrice().nullable()),
          paidTotal: money.pay(amountMinor().nullable()),
        }),
      ),
      words: z.array(z.string()),
    }),
  },
})

export const floorMineContract = defineContract({
  querystring: input({ month: month.optional() }),
  response: {
    200: output({
      subject: z.enum(['WORKER', 'STATION']),
      today: businessDate(),
      month,
      status: z.enum(PERIOD_STATUSES).nullable(),
      currency: z.string(),
      todayPieces: z.number().int(),
      todayEarnings: money.pay(amountMinor()),
      periodPieces: z.number().int(),
      periodEarnings: money.pay(amountMinor()),
      held: z.number().int(),
      statement: output({ id: id(), status: z.enum(STATEMENT_STATUSES), revision: z.number().int(), currency: z.string(), lines: z.array(statementLine), time: z.array(timeLine), bonus: bonusView, earningsAmount: money.pay(amountMinor().nullable()), makeUpAmount: money.pay(amountMinor().nullable()) }).nullable(),
      words: z.array(z.string()),
    }),
  },
})

export type PeriodsQuery = z.infer<typeof periodsContract.querystring>
export type CreatePeriodBody = z.infer<typeof createPeriodContract.body>
export type VersionBody = z.infer<typeof runContract.body>
export type ReasonVersionBody = z.infer<typeof backContract.body>
export type LockBody = z.infer<typeof lockContract.body>
export type OpenStatementBody = z.infer<typeof openStatementContract.body>
export type LeadReviewBody = z.infer<typeof leadReviewContract.body>
export type HeldQuery = z.infer<typeof heldListContract.querystring>
export type CountBody = z.infer<typeof countHeldContract.body>
export type NotPaidBody = z.infer<typeof notPaidHeldContract.body>
export type LedgerQuery = z.infer<typeof ledgerContract.querystring>
export type CorrectBody = z.infer<typeof correctContract.body>
export type AdjustBody = z.infer<typeof adjustContract.body>
export type CountsQuery = z.infer<typeof countsContract.querystring>
export type LabourCostQuery = z.infer<typeof labourCostContract.querystring>
