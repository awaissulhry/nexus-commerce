import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CLIENT_SCAN_ID } from '@nexus/factory-domain/production/scans/rules'
import { STEP_STATES } from '@nexus/factory-domain/production/baskets/steps'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The basket on a phone (owb- order workflow, S5 fl1; LF _owb-fl-common.md § 3 "fl1" is the contract, the web builders write
 * their zod from it; `output()` strips unknown keys, so every field the web reads is here). A basket is a Bundle.
 *
 *   GET  /production/baskets/:bundleId            one basket: the scan card's facts (scans/views bundleCard, called) plus its
 *                                                 route and place (factory-domain production/baskets: the ONE pure pair), its
 *                                                 department against the phone's, its flags, hold, notes, history, rights.
 *                                                 `:bundleId` takes the basket's id OR its ticket's code (a scan opens it)
 *   GET  /production/baskets/home                 the worker's home: For you, In this department, Coming next
 *   POST /floor/session/department                the phone's "where am I": the department pick, and the station it takes
 *   POST /production/baskets/:bundleId/checklist/:stepCode/photo               a quality step's photo announced (presigned PUT)
 *   POST /production/baskets/:bundleId/checklist/:stepCode/photo/:fileId/complete  the photo confirmed AND the step ticked
 *                                                 with it (OperationChecklistResult.fileId: the row never changes, so the
 *                                                 photo is written with its tick)
 *
 * Fields beyond the § 3 sketch (asked by the web builders, owb-fl5/fl8): `picture.expiresAt`, `quality.steps`,
 * `flags.problem.spot`, `history`, `hold.fix`, `changedDesign.at`, `basket.team.picture`, `stationId` on the department pick.
 */

/** A department as every screen draws it (the base's useDepartments / DeptChip). */
export const departmentView = output({
  id: id(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string(),
  tone: z.string(),
  icon: z.string(),
  nameI18n: z.record(z.string(), z.string()),
})

/** The basket's picture: the order's picture as the floor of its site may see it (never the office's file); null with no small address. */
export const pictureView = output({ fileId: id(), src: z.string(), expiresAt: instant().nullable() })

const callView = output({
  callId: id(),
  typeCode: z.string(),
  state: z.enum(['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED', 'CANCELLED']),
  minutes: z.number().int(),
  escalated: z.boolean(),
  /** The place on the basket's picture, 0-8 (a 3 x 3 grid), or null. */
  spot: z.number().int().nullable(),
})

export const WORK_STATES = ['WAITING', 'WORKING', 'PAUSED'] as const
export const HOLD_KINDS = ['HOLD', 'QUALITY_HOLD', 'FIRST_PIECE'] as const
export const RESTRICTIONS = ['RESTRICTED', 'OTHER_TEAM'] as const
export const HISTORY_KINDS = ['DONE', 'MOVED_FORWARD', 'MOVED_BACK', 'TAKEN_HERE', 'MOVE_UNDONE', 'STEP_SKIPPED', 'STEP_PUT_BACK', 'STEP_ADDED', 'ROUTE_NORMAL'] as const
export const WHO_ON_FLOOR = ['YOU', 'OFFICE', 'DEPARTMENT', 'SYSTEM'] as const

export const basketView = output({
  /** A scan opened the page (`?via=scan`): the words of "another department" say so. */
  scanned: z.boolean(),
  refusal: output({ code: z.string(), message: z.string() }).nullable(),
  basket: output({
    id: id(),
    code: z.string(),
    quantity: z.number().int(),
    /** A small-parts line: one basket holds every piece of the cell. */
    smallParts: z.boolean(),
    workOrderId: id(),
    workOrderNumber: z.string(),
    salesOrderId: id().nullable(),
    /** The customer's CODE, never its name (factory-domain production/floor-customer); '' for no customer. */
    customerCode: z.string(),
    due: businessDate().nullable(),
    words: output({ size: z.string(), colour: z.string(), label: z.string().nullable(), leather: z.string().nullable() }),
    team: output({ id: id(), name: z.string(), picture: output({ kind: z.enum(['LETTERS', 'ICON']), icon: z.string().nullable(), colour: z.string().nullable() }) }).nullable(),
    rush: z.boolean(),
  }),
  picture: pictureView.nullable(),
  route: output({
    /** The basket has a route of its own (a route edit stands). */
    own: z.boolean(),
    steps: z.array(output({ operationId: id(), seq: z.number(), name: z.string(), department: departmentView.nullable(), state: z.enum(STEP_STATES), added: z.boolean() })),
  }),
  place: output({
    /** The step it is at; null: Ready to ship. */
    operationId: id().nullable(),
    how: z.enum(['SCANS', 'MOVE']),
    /** Made at print, no report and no move yet: "Waiting for the first step". */
    waitingFirst: z.boolean(),
  }),
  work: output({ state: z.enum(WORK_STATES), mine: z.boolean() }),
  here: output({ departmentId: id().nullable(), sameDepartment: z.boolean(), onRoute: z.boolean(), takeHereOperationId: id().nullable() }),
  /** Pick B: a hold still refuses the scan; the page says why and offers "Ask your team leader". */
  hold: output({ kind: z.enum(HOLD_KINDS), words: z.string(), fix: z.string() }).nullable(),
  /** The newest "The design changed: …" note for the floor of its work order; `seen` lives on the device (always false here). */
  changedDesign: output({ words: z.string(), at: instant(), seen: z.boolean() }).nullable(),
  flags: output({
    /** "Do this first" stands. */
    first: z.boolean(),
    late: output({ days: z.number().int(), reason: z.enum(['MATERIAL', 'MACHINE', 'PEOPLE', 'REDO']) }).nullable(),
    problem: callView.nullable(),
    ask: callView.nullable(),
    /** "An answer for you": the newest answered ask (its resolution note). */
    answer: output({ words: z.string(), at: instant() }).nullable(),
  }),
  restricted: z.enum(RESTRICTIONS).nullable(),
  quality: output({
    operationId: id(),
    ticks: output({ required: z.number().int(), done: z.number().int() }),
    photos: output({ required: z.number().int(), done: z.number().int() }),
    steps: z.array(output({ code: z.string(), words: z.string(), icon: z.string().nullable(), required: z.boolean(), photo: z.boolean(), done: z.boolean() })),
  }).nullable(),
  next: output({ operationId: id().nullable(), department: departmentView.nullable() }),
  /** The office's notes for the floor of its work order (read only); a note carries no file on the floor. */
  notes: z.array(output({ at: instant(), words: z.string(), fileIds: z.array(id()) })),
  /** What happened to the basket, in the floor's words: "You", "Office", a department, never a name (the base's floorFaceOf). */
  history: z.array(output({ at: instant(), what: z.enum(HISTORY_KINDS), operationId: id().nullable(), toOperationId: id().nullable(), who: output({ face: z.enum(WHO_ON_FLOOR), departmentNo: z.number().int().nullable() }) })),
  designPageHref: z.string().nullable(),
  can: output({ start: z.boolean(), done: z.boolean(), moveForward: z.boolean(), moveBack: z.boolean(), route: z.boolean(), give: z.boolean(), flag: z.boolean(), late: z.boolean() }),
})
export type BasketView = z.infer<typeof basketView>

export const basketContract = defineContract({
  params: input({ bundleId: z.string().trim().min(1).max(80) }),
  /** `via=scan`: a scan opened the page (the web's own note; nothing changes here). */
  querystring: input({ via: z.enum(['scan', 'tap']).optional() }),
  response: { 200: basketView },
})

// ---- the worker's home ---------------------------------------------------------------------------------------------------------

export const FOR_YOU_KINDS = ['CHANGED_DESIGN', 'ANSWER', 'SOLVED', 'HANDOVER', 'PROBLEM', 'ASK'] as const

export const homeRowView = output({
  bundleId: id(),
  code: z.string(),
  picture: pictureView.nullable(),
  customerCode: z.string(),
  step: output({ operationId: id().nullable(), department: departmentView.nullable() }),
  state: z.enum(WORK_STATES),
  flags: output({ first: z.boolean(), late: z.boolean(), problem: z.boolean() }),
})

export const homeView = output({
  department: departmentView.nullable(),
  /** A HANDOVER line names no basket (bundleId and code null). */
  forYou: z.array(output({ kind: z.enum(FOR_YOU_KINDS), bundleId: id().nullable(), code: z.string().nullable(), words: z.string(), at: instant() })),
  here: z.array(homeRowView),
  comingNext: z.array(homeRowView),
})
export type HomeView = z.infer<typeof homeView>

export const homeContract = defineContract({ response: { 200: homeView } })

// ---- the department pick ---------------------------------------------------------------------------------------------------------

export const sessionDepartmentContract = defineContract({
  body: input({
    departmentId: id(),
    /** The second tap when `choose` listed several stations of the department at the site. */
    stationId: id().optional(),
  }),
  response: { 200: output({ department: departmentView, station: output({ id: id(), name: z.string() }).nullable(), choose: z.array(output({ id: id(), name: z.string() })) }) },
})

// ---- the quality step's photo ------------------------------------------------------------------------------------------------------

const photoParams = input({ bundleId: id(), stepCode: z.string().trim().min(1).max(64).regex(/^\S+$/, 'A step code has no spaces.') })

export const photoAnnounceContract = defineContract({
  params: photoParams,
  body: input({
    workOrderOperationId: id(),
    originalName: z.string().trim().min(1).max(200),
    /** A picture only (the database refuses anything else as a step's photo). */
    contentType: z.string().trim().regex(/^image\//i, 'A step photo is a picture.'),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected the SHA-256 in lower-case hex.'),
  }),
  // The answer of the files platform's announce (as floornotes'), with the photo step's reminder ("Keep faces out of the picture").
  response: { 201: output({ file: fileView, upload: presignedView, reminder: output({ code: z.string(), it: z.string(), en: z.string() }) }) },
})

export const photoCompleteContract = defineContract({
  params: input({ bundleId: id(), stepCode: photoParams.shape.stepCode, fileId: id() }),
  body: input({
    workOrderOperationId: id(),
    /** The device's id for the tick (A1 §3.8): one tick, once. */
    clientEventId: z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.'),
    occurredAt: instant().optional(),
  }),
  response: { 200: output({ file: fileView, tick: output({ id: id(), stepCode: z.string(), outcome: z.string(), fileId: id(), at: instant() }) }) },
})
