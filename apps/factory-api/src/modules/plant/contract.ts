import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import {
  CLOSE_REASONS,
  JOB_SOURCES,
  JOB_STATUSES,
  JOB_TILES,
  JOB_TYPES,
  MACHINE_AFTER,
  MACHINE_STATUSES,
  MACHINE_TILES,
  MANUAL_JOB_SOURCES,
  PLANT_LIMITS,
  PRIORITIES,
  REQUEST_STATUSES,
  REQUEST_TILES,
  SAFE_AFTER,
} from '@nexus/factory-domain/plant/rules'

/**
 * The plant's routes (B-W2a-35; QHS-162, QHS-178, QHS-184; design plant.machines SCR-150, plant.requests SCR-148,
 * plant.jobs SCR-149, floor.machine SCR-179, plant.settings symptoms SCR-241). Money: only a machine's purchase cost,
 * marked with the cost grain (dropped for whoever lacks it; never on the floor). People: a reporter, a technician, who
 * acknowledged, closed or signed: `{ kind, id, name }` — an office user by name in the office; a floor worker by name
 * only inside one record in the office; the floor sees kinds only. A plant rule's refusal is a 409 with the issues
 * `refusal/<CODE>` (factory-domain plant/rules PLANT_REFUSALS) and `fix`.
 */

const words = z.record(z.string(), z.string())
const wordsChange = z.record(z.string(), z.string().max(PLANT_LIMITS.label).nullable())
const icon = z.string().trim().min(1).max(40)
const colour = z.string().trim().min(7).max(7)
const version = () => z.number().int().min(1)
const text = (max: number = PLANT_LIMITS.text) => z.string().trim().min(1).max(max)
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
    .pipe(z.array(z.enum(values)))
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')

// ---- shared views ----------------------------------------------------------------------------------------------------

const classOut = output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable() })
const symptomOut = output({
  id: id(),
  code: z.string(),
  classId: id().nullable(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: words,
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  unsafe: z.boolean(),
  needsDetail: z.boolean(),
  active: z.boolean(),
})
const place = output({ id: id(), code: z.string(), name: z.string() })
const person = output({ kind: z.enum(['USER', 'WORKER', 'STATION']), id: id().nullable(), name: z.string().nullable() })

export const machineOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  siteCode: z.string(),
  assetNumber: z.string(),
  class: classOut,
  make: z.string().nullable(),
  modelName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  year: z.number().int().nullable(),
  station: place.nullable(),
  line: place.nullable(),
  workCentre: place.nullable(),
  /** Who sold it (office only; null on the floor). */
  supplier: place.nullable(),
  /** What it cost, in the company's currency (minor units): the cost grain only; never on the floor. */
  purchaseCost: money.cost(z.number().int().nullable()),
  status: z.enum(MACHINE_STATUSES),
  statusSince: instant(),
  statusReason: z.string().nullable(),
  /** An unsafe request waits for a technician's sign-safe: the machine stays DO_NOT_USE (Owner answer H1). */
  locked: z.boolean(),
  note: z.string().nullable(),
  openRequests: z.number().int(),
  openJobs: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

export const requestOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  machine: output({ id: id(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), class: classOut }),
  symptom: symptomOut.nullable(),
  description: z.string().nullable(),
  unsafe: z.boolean(),
  reportedAt: instant(),
  ageMinutes: z.number().int(),
  reportedBy: person,
  station: place.nullable(),
  status: z.enum(REQUEST_STATUSES),
  acknowledgedAt: instant().nullable(),
  acknowledgedBy: person.nullable(),
  job: output({ id: id(), number: z.string(), status: z.enum(JOB_STATUSES) }).nullable(),
  mergedIntoId: id().nullable(),
  closedAt: instant().nullable(),
  closedBy: person.nullable(),
  closeReason: z.enum(CLOSE_REASONS).nullable(),
  closeNote: z.string().nullable(),
  signedSafe: output({ at: instant(), by: person, note: z.string().nullable() }).nullable(),
  locking: z.boolean(),
  duplicates: z.number().int(),
  photos: z.number().int(),
  version: z.number().int(),
})

export const jobOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  number: z.string(),
  machine: output({ id: id(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean(), class: classOut, station: place.nullable(), line: place.nullable() }),
  type: z.enum(JOB_TYPES),
  source: z.enum(JOB_SOURCES),
  problem: z.string(),
  symptom: symptomOut.nullable(),
  priority: z.enum(PRIORITIES),
  assignee: person.nullable(),
  ownership: z.enum(['MINE', 'NOBODY', 'OTHER']),
  dueAt: instant().nullable(),
  overdue: z.boolean(),
  status: z.enum(JOB_STATUSES),
  startedAt: instant().nullable(),
  handedBack: output({ at: instant(), by: person, workDone: z.string(), machineAfter: z.enum(MACHINE_AFTER) }).nullable(),
  closedAt: instant().nullable(),
  closedBy: person.nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  requestIds: z.array(id()),
  ageMinutes: z.number().int(),
  open: z.boolean(),
  createdAt: instant(),
  createdBy: person.nullable(),
  version: z.number().int(),
})

const jobBrief = output({ id: id(), number: z.string(), type: z.enum(JOB_TYPES), status: z.enum(JOB_STATUSES), problem: z.string(), createdAt: instant(), closedAt: instant().nullable() })

export const machineCardOut = output({
  machine: machineOut,
  openJob: output({ id: id(), number: z.string(), status: z.enum(JOB_STATUSES) }).nullable(),
  lastJobs: z.array(jobBrief),
  requestsIn30Days: z.number().int(),
  /** The design's "third failure in 30 days" hint. */
  repeatFailure: z.boolean(),
})

const stationWordsOut = output({ blocked: z.boolean(), message: z.string().nullable(), fix: z.string().nullable() })

// ---- classes and symptoms (tenant-wide) ------------------------------------------------------------------------------

const classRow = classOut.extend({ sortOrder: z.number().int(), active: z.boolean(), machines: z.number().int(), version: z.number().int(), updatedAt: instant() })
const symptomRow = symptomOut.extend({ sortOrder: z.number().int(), requests: z.number().int(), version: z.number().int(), updatedAt: instant() })

export const listClassesContract = defineContract({
  querystring: input({ active: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ classes: z.array(classRow), starterMissing: z.array(z.string()), canManage: z.boolean() }) },
})

export const createClassContract = defineContract({
  body: input({ code: z.string().trim().min(2).max(40), labelIt: text(PLANT_LIMITS.label), labelEn: text(PLANT_LIMITS.label), labelI18n: wordsChange.optional(), icon: icon.nullable().optional(), sortOrder: z.number().int().min(0).max(100_000).optional() }),
  response: { 200: output({ class: classRow }), 201: output({ class: classRow }) },
})

export const updateClassContract = defineContract({
  params: input({ classId: id() }),
  body: input({ version: version(), labelIt: text(PLANT_LIMITS.label).optional(), labelEn: text(PLANT_LIMITS.label).optional(), labelI18n: wordsChange.optional(), icon: icon.nullable().optional(), sortOrder: z.number().int().min(0).max(100_000).optional(), active: z.boolean().optional() }),
  response: { 200: output({ class: classRow }) },
})

export const listSymptomsContract = defineContract({
  querystring: input({ classId: id().optional(), active: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ symptoms: z.array(symptomRow), canManage: z.boolean() }) },
})

export const createSymptomContract = defineContract({
  body: input({
    code: z.string().trim().min(2).max(40),
    /** The class it is for; null or absent: every class. */
    classId: id().nullable().optional(),
    labelIt: text(PLANT_LIMITS.label),
    labelEn: text(PLANT_LIMITS.label),
    labelI18n: wordsChange.optional(),
    icon: icon.nullable().optional(),
    colour: colour.nullable().optional(),
    unsafe: z.boolean().optional(),
    needsDetail: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  }),
  response: { 200: output({ symptom: symptomRow }), 201: output({ symptom: symptomRow }) },
})

export const updateSymptomContract = defineContract({
  params: input({ symptomId: id() }),
  body: input({
    version: version(),
    labelIt: text(PLANT_LIMITS.label).optional(),
    labelEn: text(PLANT_LIMITS.label).optional(),
    labelI18n: wordsChange.optional(),
    icon: icon.nullable().optional(),
    colour: colour.nullable().optional(),
    unsafe: z.boolean().optional(),
    needsDetail: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    active: z.boolean().optional(),
  }),
  response: { 200: output({ symptom: symptomRow }) },
})

export const starterContract = defineContract({
  response: { 200: output({ added: output({ classes: z.array(z.string()), symptoms: z.array(z.string()) }) }) },
})

// ---- machines ------------------------------------------------------------------------------------------------------

export const listMachinesContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    /** Comma-separated statuses (RETIRED only when named). */
    status: csv(MACHINE_STATUSES).optional(),
    tile: z.enum(MACHINE_TILES).optional(),
    classId: id().optional(),
    stationId: id().optional(),
    workCentreId: id().optional(),
    /** The asset number, make, model or serial contains it. */
    q: z.string().trim().min(1).max(80).optional(),
    /** A scanned tag: the machine with exactly this asset number, in any state. */
    code: z.string().trim().min(1).max(40).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ machines: z.array(machineOut), nextCursor: id().nullable() }) },
})

export const machineCountsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ tiles: output({ DOWN: z.number().int(), DO_NOT_USE: z.number().int(), UNDER_MAINTENANCE: z.number().int() }), locked: z.number().int(), inUse: z.number().int() }) },
})

export const machineRecordContract = defineContract({
  params: input({ machineId: id() }),
  response: {
    200: output({
      card: machineCardOut,
      openRequests: z.array(requestOut),
      /** Every job of the machine, newest first (at most 100): the maintenance history. */
      history: z.array(jobOut),
      canManage: z.boolean(),
      canReport: z.boolean(),
    }),
  },
})

const machineFields = {
  classId: id(),
  make: z.string().trim().max(PLANT_LIMITS.short).nullable(),
  modelName: z.string().trim().max(PLANT_LIMITS.short).nullable(),
  serialNumber: z.string().trim().max(PLANT_LIMITS.short).nullable(),
  year: z.number().int().min(1900).max(2100).nullable(),
  stationId: id().nullable(),
  workCentreId: id().nullable(),
  supplierId: id().nullable(),
  purchaseCost: money.cost(z.number().int().min(0).nullable()),
  note: z.string().trim().max(PLANT_LIMITS.note).nullable(),
}

export const createMachineContract = defineContract({
  body: input({
    siteId: id(),
    assetNumber: z.string().trim().min(1).max(40),
    classId: machineFields.classId,
    make: machineFields.make.optional(),
    modelName: machineFields.modelName.optional(),
    serialNumber: machineFields.serialNumber.optional(),
    year: machineFields.year.optional(),
    stationId: machineFields.stationId.optional(),
    workCentreId: machineFields.workCentreId.optional(),
    supplierId: machineFields.supplierId.optional(),
    purchaseCost: money.cost(z.number().int().min(0).nullable().optional()),
    note: machineFields.note.optional(),
  }),
  response: { 200: output({ machine: machineOut }), 201: output({ machine: machineOut }) },
})

export const updateMachineContract = defineContract({
  params: input({ machineId: id() }),
  body: input({
    version: version(),
    classId: machineFields.classId.optional(),
    make: machineFields.make.optional(),
    modelName: machineFields.modelName.optional(),
    serialNumber: machineFields.serialNumber.optional(),
    year: machineFields.year.optional(),
    stationId: machineFields.stationId.optional(),
    workCentreId: machineFields.workCentreId.optional(),
    supplierId: machineFields.supplierId.optional(),
    purchaseCost: money.cost(z.number().int().min(0).nullable().optional()),
    note: machineFields.note.optional(),
  }),
  response: { 200: output({ machine: machineOut }) },
})

export const retireMachineContract = defineContract({
  params: input({ machineId: id() }),
  body: input({ version: version(), reason: text(PLANT_LIMITS.note) }),
  response: { 200: output({ machine: machineOut, replayed: z.boolean() }) },
})

// ---- requests ------------------------------------------------------------------------------------------------------

export const listRequestsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    status: csv(REQUEST_STATUSES).optional(),
    /** true: NEW and ACKNOWLEDGED only, unsafe first, then the oldest (the triage queue). */
    open: flag().optional(),
    unsafe: flag().optional(),
    tile: z.enum(REQUEST_TILES).optional(),
    machineId: id().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ requests: z.array(requestOut), nextCursor: id().nullable(), truncated: z.boolean() }) },
})

export const requestCountsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      tiles: output({
        NEW: output({ count: z.number().int(), oldestMinutes: z.number().int().nullable() }),
        UNSAFE: z.number().int(),
        DOWN: z.number().int(),
        WAITING: z.number().int(),
        DUPLICATES: z.number().int(),
      }),
    }),
  },
})

export const requestRecordContract = defineContract({
  params: input({ requestId: id() }),
  response: {
    200: output({
      request: requestOut,
      card: machineCardOut,
      /** The other open requests of the machine (possible duplicates). */
      duplicates: z.array(requestOut),
      photos: z.array(output({ id: id(), originalName: z.string(), contentType: z.string() })),
      canTriage: z.boolean(),
      canSignSafe: z.boolean(),
    }),
  },
})

export const reportContract = defineContract({
  body: input({
    /** The machine: its id, or the asset number scanned from its tag. */
    machineId: id().optional(),
    assetNumber: z.string().trim().min(1).max(40).optional(),
    symptomId: id().optional(),
    description: text().optional(),
    /** Marked unsafe by the reporter (H1: anyone); an unsafe symptom marks it so by itself. */
    unsafe: z.boolean().optional(),
    /** The machine stopped: it shows as down (the floor's main action "Report · machine down"). */
    down: z.boolean(),
    /** When it was reported on the tablet (a queued report sent later); kept when plausible. */
    occurredAt: instant().optional(),
  }),
  response: {
    201: output({ request: requestOut, machine: machineOut, words: stationWordsOut, replayed: z.boolean() }),
    200: output({ request: requestOut, machine: machineOut, words: stationWordsOut, replayed: z.boolean() }),
  },
})

const requestParams = input({ requestId: id() })
const triageAnswer = output({ request: requestOut, machine: machineOut, job: jobOut.nullable(), replayed: z.boolean() })

export const acknowledgeContract = defineContract({ params: requestParams, body: input({ version: version() }), response: { 200: triageAnswer } })

export const makeJobContract = defineContract({
  params: requestParams,
  body: input({
    version: version(),
    /** Add the request to this open job of the machine instead of making a new one. */
    jobId: id().optional(),
    type: z.enum(JOB_TYPES).optional(),
    problem: text().optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: id().nullable().optional(),
    assigneeWorkerId: id().nullable().optional(),
    dueAt: instant().nullable().optional(),
    /** Make it PLANNED (default NEW). */
    plan: z.boolean().optional(),
  }),
  response: { 200: triageAnswer, 201: triageAnswer },
})

export const mergeContract = defineContract({ params: requestParams, body: input({ version: version(), intoId: id() }), response: { 200: triageAnswer } })

export const closeRequestContract = defineContract({
  params: requestParams,
  body: input({
    version: version(),
    reason: z.enum(CLOSE_REASONS),
    note: text(PLANT_LIMITS.note).optional(),
    /** Keep a DOWN machine down (default: it runs again when nothing else open holds it). */
    keepDown: z.boolean().optional(),
  }),
  response: { 200: triageAnswer },
})

export const signSafeContract = defineContract({
  params: requestParams,
  body: input({
    version: version(),
    /** What was checked (D.Lgs. 81/2008 art. 71). */
    note: text(PLANT_LIMITS.note),
    /** The machine's state once no lock is left: running, or under maintenance (default: under maintenance while a job of it is started). */
    machineAfter: z.enum(SAFE_AFTER).optional(),
  }),
  response: { 200: output({ request: requestOut, machine: machineOut, replayed: z.boolean() }) },
})

// ---- jobs ------------------------------------------------------------------------------------------------------------

export const listJobsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    status: csv(JOB_STATUSES).optional(),
    /** true: not closed nor cancelled. */
    open: flag().optional(),
    tile: z.enum(JOB_TILES).optional(),
    machineId: id().optional(),
    /** true: the jobs given to me. */
    mine: flag().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ jobs: z.array(jobOut), nextCursor: id().nullable() }) },
})

export const jobCountsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ tiles: output({ OPEN: z.number().int(), OVERDUE: z.number().int(), UNSAFE: z.number().int(), WAITING_PARTS: z.number().int(), CLOSED_THIS_WEEK: z.number().int() }) }) },
})

export const jobRecordContract = defineContract({
  params: input({ jobId: id() }),
  response: { 200: output({ job: jobOut, card: machineCardOut, requests: z.array(requestOut), canManage: z.boolean(), canWork: z.boolean() }) },
})

export const createJobContract = defineContract({
  body: input({
    machineId: id(),
    type: z.enum(JOB_TYPES),
    problem: text(),
    symptomId: id().nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    source: z.enum(MANUAL_JOB_SOURCES).optional(),
    assigneeId: id().nullable().optional(),
    assigneeWorkerId: id().nullable().optional(),
    dueAt: instant().nullable().optional(),
    plan: z.boolean().optional(),
  }),
  response: { 200: output({ job: jobOut, replayed: z.boolean() }), 201: output({ job: jobOut, replayed: z.boolean() }) },
})

export const updateJobContract = defineContract({
  params: input({ jobId: id() }),
  body: input({
    version: version(),
    type: z.enum(JOB_TYPES).optional(),
    problem: text().optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueAt: instant().nullable().optional(),
    assigneeId: id().nullable().optional(),
    assigneeWorkerId: id().nullable().optional(),
  }),
  response: { 200: output({ job: jobOut, replayed: z.boolean() }) },
})

export const assignJobsContract = defineContract({
  body: input({
    jobs: z.array(input({ id: id(), version: version() })).min(1).max(50),
    /** The office technician; or the floor technician; neither (both null): nobody. */
    assigneeId: id().nullable().optional(),
    assigneeWorkerId: id().nullable().optional(),
  }),
  response: { 200: output({ jobs: z.array(jobOut), replayed: z.boolean() }) },
})

const jobParams = input({ jobId: id() })
const moveAnswer = output({ job: jobOut, machine: machineOut, replayed: z.boolean() })
const versionOnly = input({ version: version() })

export const planJobContract = defineContract({ params: jobParams, body: versionOnly, response: { 200: moveAnswer } })
export const startJobContract = defineContract({ params: jobParams, body: versionOnly, response: { 200: moveAnswer } })
export const waitJobContract = defineContract({ params: jobParams, body: versionOnly, response: { 200: moveAnswer } })
export const reopenJobContract = defineContract({ params: jobParams, body: versionOnly, response: { 200: moveAnswer } })
export const handBackContract = defineContract({
  params: jobParams,
  body: input({ version: version(), workDone: text(), machineAfter: z.enum(MACHINE_AFTER) }),
  response: { 200: moveAnswer },
})
export const closeJobContract = defineContract({ params: jobParams, body: versionOnly, response: { 200: moveAnswer } })
export const cancelJobContract = defineContract({ params: jobParams, body: input({ version: version(), reason: text(PLANT_LIMITS.note) }), response: { 200: moveAnswer } })

// ---- the office screens' pickers (B-W2a-53) ------------------------------------------------------------------------------

const stationPlace = output({ id: id(), code: z.string(), name: z.string(), lineId: id().nullable(), workCentreId: id() })

/** The sites a plant screen works in, each with its active lines, work centres and stations (New machine, inline place). */
export const plantPlacesContract = defineContract({
  response: {
    200: output({
      sites: z.array(output({ id: id(), companyId: id(), code: z.string(), name: z.string(), lines: z.array(place), workCentres: z.array(place), stations: z.array(stationPlace) })),
    }),
  },
})

/**
 * Who a job of the site may be given to (Make a job, New job, Assign jobs, the inline assignee): the ACTIVE office users
 * who work maintenance jobs there, and — for a caller who may see the floor workers (workers.view) — the site's ACTIVE
 * floor workers with a live floor role that works them. Names only, in a picker; never a list, filter or total.
 */
export const plantTechniciansContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      technicians: z.array(output({ kind: z.enum(['USER', 'WORKER']), id: id(), name: z.string(), me: z.boolean() })),
      /** false: the caller may not see the floor workers (workers.view), so none is listed. */
      floorListed: z.boolean(),
    }),
  },
})

// ---- the floor ---------------------------------------------------------------------------------------------------------

const floorMachine = machineOut.extend({ symptoms: z.array(symptomOut) })

export const floorMachinesContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(40).optional() }),
  response: {
    200: output({
      /** The tablet's station (null: none). */
      station: place.nullable(),
      /** The station's machines as tiles, each with its symptoms. */
      machines: z.array(floorMachine),
      /** The scanned tag's machine at this site, in any state (null: no machine has that number here). */
      found: floorMachine.nullable(),
      /** What the station's banner says (a machine marked do-not-use) and whether its work is blocked. */
      words: stationWordsOut,
    }),
  },
})

export const floorMachineContract = defineContract({
  params: input({ machineId: id() }),
  response: { 200: output({ card: machineCardOut, symptoms: z.array(symptomOut), openRequests: z.array(requestOut), words: stationWordsOut }) },
})

export const floorJobsContract = defineContract({
  response: { 200: output({ jobs: z.array(jobOut) }) },
})
