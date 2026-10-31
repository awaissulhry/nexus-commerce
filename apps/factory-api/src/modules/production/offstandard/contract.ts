import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CLIENT_EVENT_ID } from '@nexus/factory-domain/floor-sync/rules'
import { BLOCK_SOURCES, BLOCK_STATUSES, OFF_STANDARD_KINDS, OFF_STANDARD_LIMITS, PAY_RULES, UNUSUAL_REASONS } from '@nexus/factory-domain/production/offstandard/rules'

/**
 * Off-standard and indirect time (B-W2b-29; MES-155 … MES-158; design production.settings "Off-standard codes" (a grid
 * that saves per cell), production.labour "Off-standard blocks to approve" (the inbox: A approve, R reject, "Approve 8
 * normal off-standard blocks"), floor.operation "No bundle: what are you doing?" (tiles; scanning a bundle returns to
 * standard)). Every write takes an Idempotency-Key (the floor's: its client event id) and the office's the version it
 * read. No money: a pay rule is a rule. No list, filter or total by person (Owner answers W1, F2): a list row says whether
 * the block names a person (`named`), never who; one block's record names its worker where the site records workers.
 */

const version = z.number().int().min(1)
const words = () => z.string().max(OFF_STANDARD_LIMITS.label * 2)
const reason = () => z.string().trim().min(1).max(OFF_STANDARD_LIMITS.reason)
const note = () => z.string().trim().max(OFF_STANDARD_LIMITS.note)
const place = output({ id: id(), code: z.string(), name: z.string() })

/** A code as the settings grid shows it. */
export const codeView = output({
  id: id(),
  companyId: id(),
  code: z.string(),
  kind: z.enum(OFF_STANDARD_KINDS),
  payRule: z.enum(PAY_RULES),
  needsApproval: z.boolean(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  /** How many blocks name it (a code in use is set inactive, never deleted). */
  usedCount: z.number().int().min(0),
  /** The active help-call types that book their waiting time to it (MES-148). */
  callTypes: z.array(z.string()),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CodeView = z.infer<typeof codeView>

/** A code as a tile and a block show it (no pay rule on the floor, no usage). */
const tileView = output({
  id: id(),
  code: z.string(),
  kind: z.enum(OFF_STANDARD_KINDS),
  needsApproval: z.boolean(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
})

/** A block as a list shows it: where, which code, when, its state; never who (`named` says a person is on its record). */
export const blockRow = output({
  id: id(),
  version: z.number().int(),
  siteId: id(),
  line: place.nullable(),
  station: place.nullable(),
  code: tileView.extend({ payRule: z.enum(PAY_RULES) }),
  source: z.enum(BLOCK_SOURCES),
  status: z.enum(BLOCK_STATUSES),
  workDate: businessDate(),
  startedAt: instant(),
  endedAt: instant().nullable(),
  /** Whole minutes (a running block: so far). */
  minutes: z.number().int().min(0),
  /** The block names a worker (the site records workers): who, only on its own record. */
  named: z.boolean(),
  helpCallId: id().nullable(),
  /** Why it is not approved with others at once (empty: a normal block). */
  unusual: z.array(z.enum(UNUSUAL_REASONS)),
  /** When it was approved or rejected. */
  decidedAt: instant().nullable(),
})
export type BlockRowView = z.infer<typeof blockRow>

const someone = output({ id: id(), name: z.string() })

/** One block's record: the list's facts, its worker where the site records workers, its decision and its edits (MES-204). */
export const blockRecord = blockRow.extend({
  /** Who it is about: only where the site records workers and its PERFORMANCE legal gate is on (art. 4 c.1). */
  worker: someone.nullable(),
  /** A worker is on the record but not shown: the site's legal gate for one person's work figures is off (the default). */
  workerHidden: z.boolean(),
  note: z.string().nullable(),
  approvedAt: instant().nullable(),
  approvedBy: someone.nullable(),
  rejectedAt: instant().nullable(),
  rejectedBy: someone.nullable(),
  rejectReason: z.string().nullable(),
  /** The tablet's own time when it started (offline), if it sent one. */
  deviceTime: instant().nullable(),
  createdAt: instant(),
  edits: z.array(output({ id: id(), at: instant(), by: someone.nullable(), reason: z.string(), before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()), disputeId: id().nullable() })),
  /** The viewer may approve or reject it now (it waits, they hold the permission, it is not their own time). */
  canDecide: z.boolean(),
  /** It is the viewer's own time (a block they may never decide). */
  own: z.boolean(),
})

// ---- codes (the settings grid) -----------------------------------------------------------------------------------------

export const listCodesContract = defineContract({
  querystring: input({ companyId: id().optional(), active: z.enum(['true', 'false']).optional() }),
  response: {
    200: output({
      codes: z.array(codeView),
      /** The floor languages of the companies' sites besides Italian and English: the grid's word columns. */
      languages: z.array(z.string()),
      /** The caller may keep the codes of at least one of these companies. */
      canManage: z.boolean(),
    }),
  },
})

export const createCodeContract = defineContract({
  body: input({
    companyId: id(),
    code: z.string().trim().max(40),
    kind: z.enum(OFF_STANDARD_KINDS),
    payRule: z.enum(PAY_RULES),
    needsApproval: z.boolean().optional(),
    labelIt: words(),
    labelEn: words(),
    labelI18n: z.record(z.string().max(8), words()).optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(7).nullable().optional(),
  }),
  response: { 201: output({ code: codeView }) },
})
export type CreateCodeBody = z.infer<typeof createCodeContract.body>

export const editCodeContract = defineContract({
  params: input({ codeId: id() }),
  body: input({
    version,
    labelIt: words().optional(),
    labelEn: words().optional(),
    /** The languages changed: words replace, null takes a language out; the others stay. */
    labelI18n: z.record(z.string().max(8), words().nullable()).optional(),
    icon: z.string().max(40).nullable().optional(),
    colour: z.string().max(7).nullable().optional(),
    payRule: z.enum(PAY_RULES).optional(),
    needsApproval: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    active: z.boolean().optional(),
    /** Refused when it differs: a code's kind never changes. */
    kind: z.enum(OFF_STANDARD_KINDS).optional(),
  }),
  response: { 200: output({ code: codeView }) },
})
export type EditCodeBody = z.infer<typeof editCodeContract.body>

// ---- blocks (the office) -------------------------------------------------------------------------------------------------

const statuses = z
  .string()
  .max(60)
  .optional()
  .refine((value) => value === undefined || value.split(',').every((entry) => (BLOCK_STATUSES as readonly string[]).includes(entry.trim())), { message: 'Expected block states, comma-separated (PENDING,OPEN).' })

export const listBlocksContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    lineId: id().optional(),
    stationId: id().optional(),
    codeId: id().optional(),
    kind: z.enum(OFF_STANDARD_KINDS).optional(),
    status: statuses,
    from: businessDate().optional(),
    to: businessDate().optional(),
    /** Only the blocks that may be approved with others at once (PENDING and nothing unusual). */
    normal: z.enum(['true']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  response: { 200: output({ blocks: z.array(blockRow), more: z.boolean() }) },
})
export type ListBlocksQuery = z.infer<typeof listBlocksContract.querystring>

export const countsContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional() }),
  response: {
    200: output({
      /** Waiting for approval (the inbox tile "Off-standard blocks to approve"). */
      pending: z.number().int(),
      /** Of those, approved with others at once; the rest are decided one by one. */
      normal: z.number().int(),
      unusual: z.number().int(),
      /** Running now. */
      running: z.number().int(),
    }),
  },
})

const blockParams = input({ blockId: id() })

export const blockContract = defineContract({
  params: blockParams,
  response: { 200: output({ block: blockRecord }) },
})

export const recordBlockContract = defineContract({
  body: input({
    siteId: id(),
    codeId: id(),
    /** At a site that records workers: the worker (who acknowledged the notice); elsewhere none. */
    workerId: id().optional(),
    /** At a site that records the station: required; elsewhere where it happened, if known. */
    stationId: id().optional(),
    /** The line it was spent for when no station says it. */
    lineId: id().optional(),
    startedAt: instant(),
    endedAt: instant(),
    note: note().optional(),
  }),
  response: { 201: output({ block: blockRecord }) },
})
export type RecordBlockBody = z.infer<typeof recordBlockContract.body>

export const approveContract = defineContract({
  params: blockParams,
  body: input({ version }),
  response: { 200: output({ block: blockRecord }) },
})

export const rejectContract = defineContract({
  params: blockParams,
  body: input({ version, reason: reason() }),
  response: { 200: output({ block: blockRecord }) },
})

export const reopenContract = defineContract({
  params: blockParams,
  body: input({ version, reason: reason() }),
  response: { 200: output({ block: blockRecord }) },
})

export const correctContract = defineContract({
  params: blockParams,
  body: input({ version, reason: reason(), codeId: id().optional(), startedAt: instant().optional(), endedAt: instant().optional() }),
  response: { 200: output({ block: blockRecord }) },
})
export type CorrectBody = z.infer<typeof correctContract.body>

export const endBlockContract = defineContract({
  params: blockParams,
  /** `endedAt`: when it really ended (the worker forgot to end it), with why; none: now. */
  body: input({ version, endedAt: instant().optional(), reason: reason().optional() }),
  response: { 200: output({ block: blockRecord }) },
})

export const bulkApproveContract = defineContract({
  body: input({ blocks: z.array(input({ id: id(), version })).min(1).max(OFF_STANDARD_LIMITS.perBulk) }),
  response: {
    200: output({
      approved: z.array(id()),
      /** Not approved, and why: unusual (decided one by one), not waiting, the viewer's own time, changed since it was read, a closed day. */
      skipped: z.array(output({ id: id(), code: z.string(), message: z.string(), unusual: z.array(z.enum(UNUSUAL_REASONS)) })),
    }),
  },
})

// ---- the floor -----------------------------------------------------------------------------------------------------------

/** A block as the tablet shows it: its code's tile, since when; never a pay rule. */
const floorBlock = output({
  id: id(),
  version: z.number().int(),
  code: tileView,
  status: z.enum(BLOCK_STATUSES),
  startedAt: instant(),
  endedAt: instant().nullable(),
  minutes: z.number().int().min(0),
})

export const floorStateContract = defineContract({
  response: {
    200: output({
      /** Who the site's floor records name: the signed-in worker, or the station. */
      subject: z.enum(['WORKER', 'STATION']),
      station: place.extend({ line: place.nullable() }).nullable(),
      /** The block running now for the worker (or the station); null: none. */
      running: floorBlock.nullable(),
      /** The tiles "No bundle: what are you doing?": the company's active codes in their order. */
      codes: z.array(tileView),
    }),
  },
})

const envelope = {
  /** The tablet's id for the action (A1 §3.8): one action, once, also from the offline queue. */
  clientEventId: z.string().regex(CLIENT_EVENT_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.'),
  /** The tablet's clock when it happened (offline). */
  occurredAt: instant().optional(),
}

export const floorStartContract = defineContract({
  body: input({ ...envelope, codeId: id(), note: note().optional() }),
  response: {
    /** Started (and the block it ended, when another tile was running). */
    201: output({ block: floorBlock, ended: floorBlock.nullable() }),
    /** Sent before, or this code is already running: nothing done again. */
    200: output({ block: floorBlock, ended: floorBlock.nullable() }),
  },
})
export type FloorStartBody = z.infer<typeof floorStartContract.body>

export const floorEndContract = defineContract({
  body: input({ ...envelope }),
  response: { 200: output({ block: floorBlock }) },
})
export type FloorEndBody = z.infer<typeof floorEndContract.body>

/** The team leader's list on the tablet: the site's blocks waiting for approval, per station and code; never who. */
export const floorLeadContract = defineContract({
  response: { 200: output({ blocks: z.array(blockRow.extend({ own: z.boolean() })) }) },
})

export const floorApproveContract = defineContract({
  params: blockParams,
  body: input({ version }),
  response: { 200: output({ block: blockRow }) },
})

export const floorRejectContract = defineContract({
  params: blockParams,
  body: input({ version, reason: reason() }),
  response: { 200: output({ block: blockRow }) },
})
