import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { JOB_TYPES, PRIORITIES } from '@nexus/factory-domain/plant/rules'
import {
  ACTION_LINKS,
  ACTION_STATUSES,
  BODY_PARTS,
  BODY_SIDES,
  FILING_STATES,
  FILING_STATUSES,
  FILING_TYPES,
  INCIDENT_KINDS,
  INCIDENT_LIMITS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INJURY_NATURES,
  INVOLVEMENTS,
  REPORTED_VIA,
} from '@nexus/factory-domain/safety/incidents/rules'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * Incidents, near misses and hazards (B-W2b-125; QHS-265, QHS-268, QHS-270; design plant.incidents SCR-210: the band's countdown
 * chip, the deadline banner, tiles, the anonymised list, the record's Report / Actions / Authority notice tabs, the pop-ups
 * Report an incident, Record INAIL filing, Close incident; floor.incident SCR-230). Everyone with safety.incidents.view reads
 * the anonymised shapes; the protected ones (people, filings) only come from the …/open routes, after the view is recorded.
 * No money anywhere.
 */

const version = () => z.number().int().min(1)
const words = (longest: number) => z.string().trim().min(1).max(longest)
const codeName = output({ code: z.string(), name: z.string() })
const ref = output({ id: id(), code: z.string(), name: z.string() })

const countdownOut = output({ dueAt: z.string(), minutesLeft: z.number().int(), hoursLeft: z.number().int(), under24h: z.boolean(), late: z.boolean() })
const deadlineOut = output({ id: id(), state: z.enum(FILING_STATES), status: z.enum(FILING_STATUSES), countdown: countdownOut.nullable(), version: z.number().int() })
const whereOut = {
  area: ref.nullable(),
  station: ref.nullable(),
  machine: output({ id: id(), assetNumber: z.string() }).nullable(),
  place: z.string().nullable(),
}
const peopleCount = output({ count: z.number().int(), injured: z.number().int() })

export const listItemOut = output({
  id: id(),
  number: z.string(),
  kind: z.enum(INCIDENT_KINDS),
  companyId: id(),
  siteId: id(),
  site: codeName,
  occurredAt: z.string(),
  reportedAt: z.string(),
  reportedVia: z.enum(REPORTED_VIA),
  anonymous: z.boolean(),
  ...whereOut,
  severity: z.enum(INCIDENT_SEVERITIES).nullable(),
  status: z.enum(INCIDENT_STATUSES),
  seen: z.boolean(),
  actionsOpen: z.number().int(),
  actionsOverdue: z.number().int(),
  people: peopleCount,
  inail: output({ open: z.number().int(), state: z.enum(FILING_STATES).nullable(), countdown: countdownOut.nullable() }),
  photos: z.number().int(),
  version: z.number().int(),
})

export const listContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    siteId: id().optional(),
    /** Rows ▾ (design): Injuries · Near misses · Hazards · INAIL due. */
    rows: z.enum(['INJURY', 'NEAR_MISS', 'HAZARD', 'INAIL_DUE']).optional(),
    /** Default: open and closed (a cancelled one only when asked). */
    status: z.enum([...INCIDENT_STATUSES, 'ALL']).optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    q: z.string().trim().min(1).max(40).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(INCIDENT_LIMITS.page).optional(),
  }),
  response: { 200: output({ now: z.string(), incidents: z.array(listItemOut), nextCursor: z.string().nullable(), canReport: z.boolean() }) },
})

const deadlineBanner = output({ incidentId: id(), number: z.string(), countdown: countdownOut })

export const countsContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: {
    200: output({
      now: z.string(),
      tiles: output({ openIncidents: z.number().int(), inailOpen: z.number().int(), nearMissesThisMonth: z.number().int(), hazardsOpen: z.number().int(), actionsOverdue: z.number().int() }),
      deadline: deadlineBanner.extend({ more: z.number().int() }).nullable(),
      next: deadlineBanner.nullable(),
      law: z.string(),
    }),
  },
})

const incidentParams = input({ incidentId: id() })

const actionOut = output({
  id: id(),
  seq: z.number().int(),
  title: z.string(),
  owner: output({ id: id(), name: z.string() }).nullable(),
  dueOn: z.string().nullable(),
  status: z.enum(ACTION_STATUSES),
  overdue: z.boolean(),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  evidenceNote: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  madeInto: z.enum(ACTION_LINKS).nullable(),
  record: output({ type: z.enum(['MaintenanceJob', 'RiskMeasure', 'TrainingSession']), id: id(), label: z.string(), status: z.string() }).nullable(),
  version: z.number().int(),
})

const ruleOut = output({ law: z.string(), statisticalFromDays: z.number().int(), insuranceAboveDays: z.number().int(), hoursAfterCertificate: z.number().int(), words: output({ en: z.array(z.string()), it: z.array(z.string()) }) })

export const rulesContract = defineContract({
  response: {
    200: output({
      rule: ruleOut,
      reminders: output({ hoursBefore: z.array(z.number().int()) }),
      floor: output({ anonymousKinds: z.array(z.enum(INCIDENT_KINDS)), photos: z.number().int(), photoMinutes: z.number().int(), emergencyNumber: z.string() }),
      law: output({ incident: z.string(), people: z.string() }),
    }),
  },
})

const photoOut = output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), availableAt: z.string().nullable() })
const byOut = output({ at: z.string(), by: z.string().nullable() })

export const recordContract = defineContract({
  params: incidentParams,
  response: {
    200: output({
      now: z.string(),
      incident: output({
        id: id(),
        number: z.string(),
        kind: z.enum(INCIDENT_KINDS),
        companyId: id(),
        siteId: id(),
        site: codeName,
        occurredAt: z.string(),
        reportedAt: z.string(),
        what: z.string(),
        ...whereOut,
        immediateAction: z.string().nullable(),
        maintenanceRequest: output({ id: id(), status: z.string(), unsafe: z.boolean() }).nullable(),
        severity: z.enum(INCIDENT_SEVERITIES).nullable(),
        status: z.enum(INCIDENT_STATUSES),
        reportedVia: z.enum(REPORTED_VIA),
        /** ANONYMOUS (no name stored), WORKER (named only where the site records workers: `hidden` otherwise), USER, SYSTEM (a machine lock). */
        reporter: output({ kind: z.enum(['ANONYMOUS', 'WORKER', 'USER', 'SYSTEM']), name: z.string().nullable(), hidden: z.boolean(), device: output({ id: id(), name: z.string() }).nullable() }),
        seen: byOut.nullable(),
        closed: byOut.nullable(),
        cancelled: byOut.extend({ reason: z.string().nullable() }).nullable(),
        people: peopleCount.extend({ canOpen: z.boolean() }),
        actions: z.array(actionOut),
        inail: output({ deadlines: z.array(deadlineOut), canOpen: z.boolean(), law: z.string(), rule: ruleOut }),
        photos: z.array(photoOut),
        version: z.number().int(),
        canManage: z.boolean(),
        canPeople: z.boolean(),
        canClose: z.boolean(),
        law: output({ incident: z.string(), people: z.string() }),
      }),
    }),
  },
})

// ---- reporting -----------------------------------------------------------------------------------------------------------

const injury = {
  involvement: z.enum(INVOLVEMENTS),
  bodyParts: z.array(z.enum(BODY_PARTS)).max(BODY_PARTS.length).optional(),
  bodySide: z.enum(BODY_SIDES).nullable().optional(),
  nature: z.enum(INJURY_NATURES).nullable().optional(),
  firstAidGiven: z.boolean().optional(),
  sentToHospital: z.boolean().optional(),
}
const personIn = input({ ...injury, employeeId: id().optional(), outsideName: words(INCIDENT_LIMITS.outsideName).optional() })

const reportOut = output({ incident: output({ id: id(), number: z.string(), kind: z.enum(INCIDENT_KINDS), status: z.literal('OPEN'), anonymous: z.boolean(), version: z.number().int() }), replayed: z.boolean() })

export const reportContract = defineContract({
  body: input({
    companyId: id(),
    siteId: id(),
    kind: z.enum(INCIDENT_KINDS),
    occurredAt: instant(),
    what: words(INCIDENT_LIMITS.what),
    areaId: id().optional(),
    stationId: id().optional(),
    machineId: id().optional(),
    place: words(INCIDENT_LIMITS.place).optional(),
    immediateAction: words(INCIDENT_LIMITS.immediateAction).optional(),
    maintenanceRequestId: id().optional(),
    people: z.array(personIn).max(INCIDENT_LIMITS.people).optional(),
  }),
  response: { 200: reportOut, 201: reportOut },
})

/** The tablet's report: kind, where, optional words and people; or without a name (a near miss or a hazard, nobody named). */
export const floorReportBody = input({
  kind: z.enum(INCIDENT_KINDS),
  occurredAt: instant().optional(),
  what: words(INCIDENT_LIMITS.what).optional(),
  language: z.enum(['en', 'it']).optional(),
  here: z.boolean().optional(),
  areaId: id().optional(),
  stationId: id().optional(),
  machineId: id().optional(),
  place: words(INCIDENT_LIMITS.place).optional(),
  immediateAction: words(INCIDENT_LIMITS.immediateAction).optional(),
  anonymous: z.boolean().optional(),
  people: z.array(input({ ...injury, who: z.enum(['ME', 'WORKER', 'OUTSIDE']), workerId: id().optional(), outsideName: words(INCIDENT_LIMITS.outsideName).optional() })).max(INCIDENT_LIMITS.people).optional(),
})

export const floorReportContract = defineContract({ body: floorReportBody, response: { 200: reportOut, 201: reportOut } })

export const floorStartContract = defineContract({
  response: {
    200: output({
      emergency: output({ number: z.string(), firstAiders: z.array(output({ name: z.string(), shift: z.string().nullable() })) }),
      here: output({ station: ref, machines: z.array(output({ id: id(), assetNumber: z.string() })) }).nullable(),
      areas: z.array(ref),
      anonymousKinds: z.array(z.enum(INCIDENT_KINDS)),
    }),
  },
})

export const floorIncidentContract = defineContract({
  params: incidentParams,
  response: { 200: output({ incident: output({ id: id(), number: z.string(), kind: z.enum(INCIDENT_KINDS), seenAt: z.string().nullable(), closed: z.boolean() }) }) },
})

// ---- the incident's own writes -----------------------------------------------------------------------------------------

const changedOut = output({ incident: output({ id: id(), version: z.number().int(), status: z.enum(INCIDENT_STATUSES).optional() }), replayed: z.boolean() })

export const editContract = defineContract({
  params: incidentParams,
  body: input({
    version: version(),
    kind: z.enum(INCIDENT_KINDS).optional(),
    occurredAt: instant().optional(),
    what: words(INCIDENT_LIMITS.what).optional(),
    areaId: id().nullable().optional(),
    stationId: id().nullable().optional(),
    machineId: id().nullable().optional(),
    place: z.string().trim().max(INCIDENT_LIMITS.place).nullable().optional(),
    immediateAction: z.string().trim().max(INCIDENT_LIMITS.immediateAction).nullable().optional(),
    maintenanceRequestId: id().nullable().optional(),
    severity: z.enum(INCIDENT_SEVERITIES).nullable().optional(),
  }),
  response: { 200: changedOut },
})

export const seenContract = defineContract({
  params: incidentParams,
  response: { 200: output({ incident: output({ id: id(), version: z.number().int(), seenAt: z.string(), first: z.boolean() }), replayed: z.boolean() }) },
})

export const versionContract = defineContract({ params: incidentParams, body: input({ version: version() }), response: { 200: changedOut } })
export const cancelContract = defineContract({ params: incidentParams, body: input({ version: version(), reason: words(INCIDENT_LIMITS.reason) }), response: { 200: changedOut } })

// ---- people (protected) --------------------------------------------------------------------------------------------------

const personParams = input({ incidentId: id(), personId: id() })
const personWriteOut = output({ person: output({ id: id(), version: z.number().int().optional(), removed: z.boolean().optional() }), replayed: z.boolean() })

export const addPersonContract = defineContract({ params: incidentParams, body: personIn, response: { 200: personWriteOut, 201: personWriteOut } })
export const editPersonContract = defineContract({ params: personParams, body: personIn.extend({ version: version() }), response: { 200: personWriteOut } })
export const removePersonContract = defineContract({ params: personParams, body: input({ version: version() }), response: { 200: personWriteOut } })

const personOut = output({
  id: id(),
  involvement: z.enum(INVOLVEMENTS),
  employee: output({ id: id(), name: z.string() }).nullable(),
  outsideName: z.string().nullable(),
  bodyParts: z.array(z.enum(BODY_PARTS)),
  bodySide: z.enum(BODY_SIDES).nullable(),
  nature: z.enum(INJURY_NATURES).nullable(),
  firstAidGiven: z.boolean(),
  sentToHospital: z.boolean(),
  filings: z.number().int(),
  version: z.number().int(),
})

export const openPeopleContract = defineContract({
  params: incidentParams,
  response: { 200: output({ incident: output({ id: id(), number: z.string() }), people: z.array(personOut), recorded: z.boolean(), law: z.string() }) },
})

export const showPeopleContract = defineContract({
  body: input({ incidentIds: z.array(id()).min(1).max(INCIDENT_LIMITS.peopleList) }),
  response: { 200: output({ incidents: z.array(output({ id: id(), people: z.array(personOut) })), recorded: z.boolean() }) },
})

export const openFilingsContract = defineContract({
  params: incidentParams,
  response: {
    200: output({
      incident: output({ id: id(), number: z.string(), occurredAt: z.string() }),
      now: z.string(),
      filings: z.array(
        output({
          id: id(),
          personId: id(),
          person: output({ employeeId: id().nullable(), name: z.string() }),
          type: z.enum(FILING_TYPES),
          status: z.enum(FILING_STATUSES),
          state: z.enum(FILING_STATES),
          expectedAbsenceDays: z.number().int().nullable(),
          actualAbsenceDays: z.number().int().nullable(),
          certificateReference: z.string().nullable(),
          certificateReceivedAt: z.string().nullable(),
          dueAt: z.string().nullable(),
          countdown: countdownOut.nullable(),
          filedAt: z.string().nullable(),
          filedBy: z.string().nullable(),
          protocolNumber: z.string().nullable(),
          notNeededAt: z.string().nullable(),
          notNeededBy: z.string().nullable(),
          receipt: output({ fileId: id(), name: z.string() }).nullable(),
          version: z.number().int(),
        }),
      ),
      recorded: z.boolean(),
      rule: output({ law: z.string(), statisticalFromDays: z.number().int(), insuranceAboveDays: z.number().int(), hoursAfterCertificate: z.number().int(), words: output({ en: z.array(z.string()), it: z.array(z.string()) }) }),
    }),
  },
})

// ---- INAIL filings -------------------------------------------------------------------------------------------------------

const filingParams = input({ incidentId: id(), filingId: id() })
const absence = () => z.number().int().min(0).max(INCIDENT_LIMITS.absenceDays)
const filingStateOut = output({ id: id(), version: z.number().int(), status: z.enum(FILING_STATUSES), dueAt: z.string().nullable() })

export const addFilingContract = defineContract({
  params: incidentParams,
  body: input({ incidentPersonId: id(), expectedAbsenceDays: absence(), certificateReference: words(INCIDENT_LIMITS.certificate).optional(), certificateReceivedAt: instant().optional() }),
  response: { 200: output({ filings: z.array(filingStateOut), replayed: z.boolean() }), 201: output({ filings: z.array(filingStateOut), replayed: z.boolean() }) },
})

export const editFilingContract = defineContract({
  params: filingParams,
  body: input({ version: version(), expectedAbsenceDays: absence().nullable().optional(), actualAbsenceDays: absence().nullable().optional(), certificateReference: z.string().trim().max(INCIDENT_LIMITS.certificate).nullable().optional(), certificateReceivedAt: instant().optional() }),
  response: { 200: output({ filing: filingStateOut, added: z.array(filingStateOut), replayed: z.boolean() }) },
})

export const fileFilingContract = defineContract({
  params: filingParams,
  body: input({ version: version(), filedAt: instant(), protocolNumber: words(INCIDENT_LIMITS.protocol) }),
  response: { 200: output({ filing: filingStateOut, replayed: z.boolean() }) },
})

export const neededContract = defineContract({ params: filingParams, body: input({ version: version() }), response: { 200: output({ filing: filingStateOut, replayed: z.boolean() }) } })

// ---- actions -------------------------------------------------------------------------------------------------------------

const makeIn = z.discriminatedUnion('into', [
  input({ into: z.literal('MAINTENANCE_JOB'), machineId: id().optional(), type: z.enum(JOB_TYPES).optional(), priority: z.enum(PRIORITIES).optional(), problem: words(1000).optional(), assigneeId: id().optional(), assigneeWorkerId: id().optional() }),
  input({ into: z.literal('RISK_MEASURE'), assessmentId: id().optional(), risk: words(500).optional() }),
  input({
    into: z.literal('TRAINING_SESSION'),
    courseId: id(),
    heldOn: businessDate(),
    hours: z.string().regex(/^(?:[0-9]|1[0-9]|2[0-4])(?:\.[0-9]{1,2})?$/, 'Hours above 0, at most 24 (up to two decimals).').refine((value) => Number(value) > 0, 'Hours above 0.'),
    language: z.string().regex(/^[a-z]{2}$/, 'A two-letter language (ISO 639-1).'),
    trainerEmployeeId: id().optional(),
    trainerName: words(200).optional(),
    location: words(200).optional(),
  }),
])

const actionParams = input({ incidentId: id(), actionId: id() })
const actionWriteOut = output({ action: output({ id: id(), version: z.number().int(), madeInto: z.enum(ACTION_LINKS).nullable().optional(), recordId: id().nullable().optional(), status: z.enum(ACTION_STATUSES).optional() }), replayed: z.boolean() })

export const addActionContract = defineContract({
  params: incidentParams,
  body: input({ title: words(INCIDENT_LIMITS.title), ownerId: id().optional(), dueOn: businessDate().optional(), make: makeIn.optional() }),
  response: { 200: actionWriteOut, 201: actionWriteOut },
})
export const makeActionContract = defineContract({ params: actionParams, body: input({ version: version(), make: makeIn }), response: { 200: actionWriteOut } })
export const editActionContract = defineContract({
  params: actionParams,
  body: input({ version: version(), title: words(INCIDENT_LIMITS.title).optional(), ownerId: id().nullable().optional(), dueOn: businessDate().nullable().optional(), evidenceNote: z.string().trim().max(INCIDENT_LIMITS.evidence).nullable().optional() }),
  response: { 200: actionWriteOut },
})
export const doneActionContract = defineContract({ params: actionParams, body: input({ version: version(), evidenceNote: words(INCIDENT_LIMITS.evidence).optional() }), response: { 200: actionWriteOut } })
export const cancelActionContract = defineContract({ params: actionParams, body: input({ version: version(), reason: words(INCIDENT_LIMITS.reason) }), response: { 200: actionWriteOut } })

// ---- files ---------------------------------------------------------------------------------------------------------------

const announceIn = input({ originalName: words(500), contentType: z.string().trim().min(1).max(200), sizeBytes: z.number().int().min(1), sha256: z.string() })
const uploadOut = output({ file: fileView, upload: presignedView })
const fileOut = output({ file: fileView })
const downloadOut = output({ download: presignedView })

export const announcePhotoContract = defineContract({ params: incidentParams, body: announceIn, response: { 201: uploadOut } })
export const completePhotoContract = defineContract({ params: input({ incidentId: id(), fileId: id() }), response: { 200: fileOut } })
export const downloadPhotoContract = defineContract({ params: input({ incidentId: id(), fileId: id() }), response: { 200: downloadOut } })
export const announceReceiptContract = defineContract({ params: filingParams, body: announceIn, response: { 201: uploadOut } })
export const completeReceiptContract = defineContract({ params: input({ incidentId: id(), filingId: id(), fileId: id() }), response: { 200: fileOut } })
export const openReceiptContract = defineContract({ params: input({ incidentId: id(), filingId: id(), fileId: id() }), response: { 200: downloadOut } })
