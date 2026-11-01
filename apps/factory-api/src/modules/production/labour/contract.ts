import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CLIENT_EVENT_ID } from '@nexus/factory-domain/floor-sync/rules'
import { FIGURE_ACCESS, OPEN_NOTE_MAX, OPEN_REASONS } from '@nexus/factory-domain/people/privacy/figures'
import {
  DAY_BLOCKERS,
  DISPUTE_OUTCOMES,
  DISPUTE_REASONS,
  DISPUTE_RECORD_TYPES,
  EDIT_KINDS,
  INBOX_KINDS,
  LABOUR_LIMITS,
  LINE_DAY_STATES,
  RECORD_STATES,
  SHEET_EXCEPTIONS,
} from '@nexus/factory-domain/production/labour/rules'

/**
 * Labour records and corrections (B-W2b-45; MES-201 … MES-206; design production.labour "Labour & corrections": the
 * legal-basis band, the tiles, one queue "To decide", "Line days", "Changes to labour records", the pop-ups "Daily sheet",
 * "Reject", "Close the day"; floor.myday "Your records", "Dispute an entry"). Every write takes an Idempotency-Key (the
 * floor's: its client event id) and the office's the version it read. No money: minutes are standard minutes, decimal
 * strings with three decimals. No list, filter or total by person (Owner answers W1, F2): a list row says whether a record
 * names a person (`named`), never who; one record names its worker where the site records workers and its legal gate for
 * one person's work figures (PERFORMANCE) is on.
 */

const version = z.number().int().min(1)
const place = output({ id: id(), code: z.string(), name: z.string() })
const someone = output({ id: id(), name: z.string() })
const counts = output({ good: z.number().int(), scrap: z.number().int(), rework: z.number().int() })
/** Standard minutes, a decimal string with three decimals ("12.500"). */
const minutes = z.string().regex(/^\d+\.\d{3}$/)
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
const change = output({ field: z.string(), from: scalar, to: scalar })
const reason = () => z.string().trim().min(1).max(LABOUR_LIMITS.reason)
const note = () => z.string().trim().max(LABOUR_LIMITS.note)
const workOrderRef = output({ id: id(), number: z.string() })
const bundleRef = output({ id: id(), code: z.string() })
const operationRef = output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() })
const disputeStatus = z.enum(['OPEN', 'UPHELD', 'REJECTED', 'WITHDRAWN'])

// ---- line days (MES-203) ---------------------------------------------------------------------------------------------

const blocker = output({ kind: z.enum(DAY_BLOCKERS), count: z.number().int().min(1), words: z.string() })

export const dayView = output({
  /** The row of the day's close (null: never closed, OPEN). */
  labourDayId: id().nullable(),
  version: z.number().int().nullable(),
  siteId: id(),
  line: place,
  workDate: businessDate(),
  state: z.enum(LINE_DAY_STATES),
  /** "Off-standard coded (yes / 3 blocks left)". */
  offStandard: output({ coded: z.boolean(), left: z.number().int().min(0) }),
  /** Anomalies left besides off-standard time. */
  anomalies: z.number().int().min(0),
  /** What holds the close, in words, with the counts. */
  blockers: z.array(blocker),
  /** Reports made on the line that day. */
  records: z.number().int().min(0),
  closedAt: instant().nullable(),
  closedBy: someone.nullable(),
  reopenedAt: instant().nullable(),
  reopenedBy: someone.nullable(),
  reopenReason: z.string().nullable(),
  note: z.string().nullable(),
})

const dayRecord = dayView.extend({
  /** Every close and reopening, oldest first. */
  history: z.array(output({ id: id(), change: z.enum(['CLOSED', 'REOPENED']), at: instant(), by: someone.nullable(), reason: z.string().nullable() })),
  canClose: z.boolean(),
  canReopen: z.boolean(),
})

export const daysContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional(), from: businessDate().optional(), to: businessDate().optional(), state: z.enum(LINE_DAY_STATES).optional() }),
  response: { 200: output({ from: businessDate(), to: businessDate(), days: z.array(dayView) }) },
})
export type DaysQuery = z.infer<typeof daysContract.querystring>

const dayParams = input({ lineId: id(), workDate: businessDate() })

export const dayContract = defineContract({ params: dayParams, response: { 200: output({ day: dayRecord }) } })

export const closeContract = defineContract({
  params: dayParams,
  body: input({ version: version.optional(), note: note().optional() }),
  response: { 200: output({ day: dayRecord }) },
})
export type CloseBody = z.infer<typeof closeContract.body>

export const reopenContract = defineContract({
  params: dayParams,
  body: input({ version, reason: reason() }),
  response: { 200: output({ day: dayRecord }) },
})
export type ReopenBody = z.infer<typeof reopenContract.body>

// ---- the queue and its tiles -----------------------------------------------------------------------------------------

export const countsContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional() }),
  response: {
    200: output({
      /** "Corrections to decide". */
      corrections: z.number().int(),
      /** "Disputes open". */
      disputes: z.number().int(),
      /** "Off-standard blocks to approve". */
      offStandard: z.number().int(),
      /** "Line days to close": ready to close in the last days. */
      lineDays: z.number().int(),
      /** Line days of the last days still held by something open. */
      heldDays: z.number().int(),
    }),
  },
})

/** One item of the queue: where, when, what it is about and what changes; never who. */
const inboxItem = output({
  kind: z.enum(INBOX_KINDS),
  /** The record's id (a line day: `<lineId>:<day>`). */
  id: z.string(),
  version: z.number().int().nullable(),
  siteId: id(),
  line: place.nullable(),
  workDate: businessDate().nullable(),
  workOrder: workOrderRef.nullable(),
  bundle: bundleRef.nullable(),
  operation: operationRef.nullable(),
  /** What changes, from → to (a correction request's counts). */
  changes: z.array(change),
  /** An off-standard block's code; a dispute's reason tile. */
  code: z.string().nullable(),
  /** An off-standard block's minutes. */
  minutes: z.number().int().nullable(),
  /** A dispute's record. */
  recordType: z.string().nullable(),
  recordId: id().nullable(),
  /** Why an off-standard block is decided one by one. */
  unusual: z.array(z.string()),
  /** The item names a person on its record (who: only there). */
  named: z.boolean(),
  raisedAt: instant(),
  ageMinutes: z.number().int().min(0),
})

export const inboxContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional(), kind: z.enum(INBOX_KINDS).optional(), limit: z.coerce.number().int().min(1).max(LABOUR_LIMITS.rows).default(200) }),
  response: { 200: output({ items: z.array(inboxItem), more: z.boolean() }) },
})
export type InboxQuery = z.infer<typeof inboxContract.querystring>

// ---- changes to labour and attendance records (MES-204) --------------------------------------------------------------

const editRow = output({
  id: id(),
  kind: z.enum(EDIT_KINDS),
  at: instant(),
  siteId: id(),
  line: place.nullable(),
  workDate: businessDate(),
  recordType: z.string(),
  recordId: id(),
  changes: z.array(change),
  /** Who made the change: an office user or a team leader. */
  by: someone.nullable(),
  reason: z.string().nullable(),
  disputeId: id().nullable(),
  /** The changed record names a person (who: only on the record). */
  named: z.boolean(),
})

export const editsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    lineId: id().optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    kind: z.enum(EDIT_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(LABOUR_LIMITS.rows).default(200),
  }),
  response: { 200: output({ from: businessDate(), to: businessDate(), edits: z.array(editRow), more: z.boolean() }) },
})
export type EditsQuery = z.infer<typeof editsContract.querystring>

// ---- one labour record (MES-201) -------------------------------------------------------------------------------------

const recordView = output({
  scanId: id(),
  standingScanId: id().nullable(),
  state: z.enum(RECORD_STATES),
  siteId: id(),
  workDate: businessDate(),
  at: instant(),
  workOrder: workOrderRef,
  bundle: bundleRef,
  operation: operationRef.extend({ standardMinutes: z.string() }),
  line: place.nullable(),
  station: place.nullable(),
  reported: counts,
  counts,
  /** Standard minutes earned by what stands. */
  earnedMinutes: minutes,
  steps: z.array(output({ scanId: id(), kind: z.enum(['CORRECTION', 'UNDO']), at: instant(), counts, approvedBy: someone.nullable(), reason: z.string().nullable() })),
  /** Who it is about: only where the site records workers and its PERFORMANCE legal gate is on (art. 4 c.1). */
  worker: someone.nullable(),
  /** A worker is on the record but not shown: the site's legal gate for one person's work figures is off (the default). */
  workerHidden: z.boolean(),
  disputes: z.array(output({ id: id(), status: disputeStatus, reason: z.enum(DISPUTE_REASONS).nullable(), raisedAt: instant() })),
  correctionsWaiting: z.number().int().min(0),
})

export const recordContract = defineContract({ params: input({ scanId: id() }), response: { 200: output({ record: recordView }) } })

// ---- disputes (MES-206) ----------------------------------------------------------------------------------------------

const disputeSummary = output({
  /** A report: its operation and bundle; a block: its code. */
  label: z.string(),
  counts: counts.nullable(),
  code: z.string().nullable(),
  startedAt: instant().nullable(),
  endedAt: instant().nullable(),
  minutes: z.number().int().nullable(),
  status: z.string().nullable(),
  version: z.number().int().nullable(),
})

const disputeView = output({
  id: id(),
  version: z.number().int(),
  siteId: id(),
  line: place.nullable(),
  workDate: businessDate(),
  recordType: z.enum(DISPUTE_RECORD_TYPES),
  recordId: id(),
  reason: z.enum(DISPUTE_REASONS).nullable(),
  /** The worker's own words. */
  words: z.string(),
  status: disputeStatus,
  answer: z.string().nullable(),
  answeredAt: instant().nullable(),
  answeredBy: someone.nullable(),
  withdrawnAt: instant().nullable(),
  raisedAt: instant(),
  raisedOn: z.enum(['FLOOR', 'OFFICE']),
  worker: someone.nullable(),
  workerHidden: z.boolean(),
  record: disputeSummary.nullable(),
  /** The labour edits that answered it. */
  edits: z.array(output({ id: id(), at: instant(), by: someone.nullable(), reason: z.string(), changes: z.array(change) })),
  canAnswer: z.boolean(),
  /** It is about the viewer's own record (they never answer it). */
  own: z.boolean(),
})

const disputeParams = input({ disputeId: id() })

export const disputeContract = defineContract({ params: disputeParams, response: { 200: output({ dispute: disputeView }) } })

export const answerContract = defineContract({
  params: disputeParams,
  body: input({
    version,
    outcome: z.enum(DISPUTE_OUTCOMES),
    /** In words, sent to the worker. */
    answer: z.string().trim().min(1).max(LABOUR_LIMITS.answer),
    /** Upheld, an off-standard block: its right code or times, corrected in the same step (its labour edit names the dispute). */
    correction: input({ version, codeId: id().optional(), startedAt: instant().optional(), endedAt: instant().optional() }).optional(),
  }),
  response: { 200: output({ dispute: disputeView }) },
})
export type AnswerBody = z.infer<typeof answerContract.body>

// ---- the daily sheet (MES-202) ---------------------------------------------------------------------------------------

const sheetView = output({
  workDate: businessDate(),
  pieces: counts,
  records: z.number().int(),
  /** Standard minutes earned. */
  productionMinutes: minutes,
  offStandard: output({ minutes: z.number().int(), byCode: z.array(output({ codeId: id(), code: z.string(), kind: z.string(), minutes: z.number().int(), blocks: z.number().int() })) }),
  attendance: output({ status: z.string(), presentMinutes: z.number().int(), breakMinutes: z.number().int(), ordinaryMinutes: z.number().int(), overtimeMinutes: z.number().int(), absenceMinutes: z.number().int() }).nullable(),
  exceptions: z.array(output({ kind: z.enum(SHEET_EXCEPTIONS), count: z.number().int(), words: z.string() })),
})

export const sheetContract = defineContract({
  body: input({
    employeeId: id(),
    workDate: businessDate(),
    /** Someone else's sheet: why it is opened (recorded). */
    reason: z.enum(OPEN_REASONS).optional(),
    note: z.string().trim().max(OPEN_NOTE_MAX).optional(),
  }),
  response: {
    200: output({
      person: output({ employeeId: id(), name: z.string() }),
      siteId: id(),
      workDate: businessDate(),
      as: z.enum(FIGURE_ACCESS),
      sheet: sheetView,
      /** The person's records that day, inside this one record. */
      records: z.array(output({ scanId: id(), at: instant(), workOrder: workOrderRef, bundle: bundleRef, operation: operationRef, line: place.nullable(), state: z.enum(RECORD_STATES), counts, earnedMinutes: minutes })),
      blocks: z.array(output({ id: id(), code: z.string(), kind: z.string(), startedAt: instant(), endedAt: instant().nullable(), minutes: z.number().int(), status: z.string() })),
      edits: z.array(output({ id: id(), at: instant(), recordType: z.string(), recordId: id(), changes: z.array(change), reason: z.string() })),
      /** Attendance is shown only where the site's ATTENDANCE legal gate is on. */
      attendanceShown: z.boolean(),
      words: z.array(z.string()),
      recorded: z.literal(true),
    }),
  },
})
export type SheetBody = z.infer<typeof sheetContract.body>

// ---- the floor: my records, disputes (MES-205, MES-206) --------------------------------------------------------------

const tile = output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: z.record(z.string(), z.string()), icon: z.string().nullable(), colour: z.string().nullable() })
const disputeRef = output({ id: id(), status: disputeStatus })

const floorDispute = output({
  id: id(),
  version: z.number().int(),
  recordType: z.enum(DISPUTE_RECORD_TYPES),
  recordId: id(),
  workDate: businessDate(),
  reason: z.enum(DISPUTE_REASONS).nullable(),
  words: z.string(),
  status: disputeStatus,
  answer: z.string().nullable(),
  answeredAt: instant().nullable(),
  withdrawnAt: instant().nullable(),
  raisedAt: instant(),
})

export const mineContract = defineContract({
  querystring: input({ from: businessDate().optional(), to: businessDate().optional() }),
  response: {
    200: output({
      subject: z.enum(['WORKER', 'STATION']),
      from: businessDate(),
      to: businessDate(),
      /** The standard minutes of each report are shown only where the site's PERFORMANCE legal gate is on. */
      minutesShown: z.boolean(),
      words: z.array(z.string()),
      records: z.array(
        output({
          scanId: id(),
          at: instant(),
          workDate: businessDate(),
          workOrder: workOrderRef,
          bundle: bundleRef,
          operation: operationRef,
          reported: counts,
          counts,
          state: z.enum(RECORD_STATES),
          minutes: minutes.nullable(),
          disputable: z.boolean(),
          dispute: disputeRef.nullable(),
        }),
      ),
      blocks: z.array(output({ id: id(), code: tile, workDate: businessDate(), startedAt: instant(), endedAt: instant().nullable(), minutes: z.number().int(), status: z.string(), rejectReason: z.string().nullable(), disputable: z.boolean(), dispute: disputeRef.nullable() })),
      disputes: z.array(floorDispute),
      /** Changes made to my records: what, from → to, when and why. */
      edits: z.array(output({ id: id(), at: instant(), recordType: z.string(), recordId: id(), changes: z.array(change), reason: z.string(), disputeId: id().nullable() })),
      /** The reason tiles per record type. */
      reasons: output({ OperationScan: z.array(z.enum(DISPUTE_REASONS)), OffStandardEntry: z.array(z.enum(DISPUTE_REASONS)) }),
    }),
  },
})
export type MineQuery = z.infer<typeof mineContract.querystring>

const clientEventId = z.string().regex(CLIENT_EVENT_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.')

export const raiseContract = defineContract({
  body: input({ clientEventId, recordType: z.enum(DISPUTE_RECORD_TYPES), recordId: id(), reason: z.enum(DISPUTE_REASONS), message: z.string().max(LABOUR_LIMITS.message).optional() }),
  response: {
    201: output({ dispute: floorDispute, existing: z.boolean() }),
    /** Sent before, or this record already has my open dispute: nothing done again. */
    200: output({ dispute: floorDispute, existing: z.boolean() }),
  },
})
export type RaiseBody = z.infer<typeof raiseContract.body>

export const withdrawContract = defineContract({
  params: disputeParams,
  body: input({ clientEventId }),
  response: { 200: output({ dispute: floorDispute }) },
})
export type WithdrawBody = z.infer<typeof withdrawContract.body>
