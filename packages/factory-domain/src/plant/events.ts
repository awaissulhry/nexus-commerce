import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CLOSE_REASONS, JOB_MOVES, JOB_SOURCES, JOB_STATUSES, JOB_TYPES, MACHINE_AFTER, MACHINE_STATUSES, PRIORITIES, REQUEST_STATUSES } from './rules'

/**
 * The plant's events (B-W2a-35; QHS-162, QHS-178, QHS-184; design plant.requests / plant.jobs / plant.machines "Live",
 * floor.machine "the station sees it"). apps/factory-api's modules/plant emits them in the commands that make the
 * change. Ids, codes, numbers and states only: no cost, no words a person typed, no person's name in a payload (a job's
 * office assignee travels as a user id for the notice to them, never to a screen).
 *
 *   plant.lists_changed               machine classes or symptoms were added, changed or retired, or the starter set
 *                                     added (the station's symptom tiles and the pickers read them again)
 *   machine.registered                a machine was registered at a site
 *   machine.changed                   its facts changed (class, make, model, serial, year, place, supplier, cost, note)
 *   machine.status_changed            its status moved: a report (down, unsafe at once: H1), a job (under maintenance,
 *                                     handed back), a sign-safe, a closed request, a retirement
 *   maintenance_request.reported      a station or the office reported a machine problem (unsafe: the machine is locked)
 *   maintenance_request.triaged       maintenance acknowledged a request, made a job of it, merged or closed it
 *   maintenance_request.signed_safe   a technician signed an unsafe request's machine safe again (H1)
 *   maintenance_job.created           a maintenance job was made, by hand or from requests, with its number
 *   maintenance_job.changed           its problem, type, priority or due time changed
 *   maintenance_job.assigned          it was given to a technician (an office user or a floor worker) or to nobody
 *   maintenance_job.moved             it was planned, started, put to wait for parts, handed back, taken back, closed or
 *                                     cancelled
 *
 * Every one reaches the plant screens of the office (plant.view) and the floor devices of the machine's site (the
 * station's machine card, the technician's My jobs) but plant.lists_changed, which is the whole group's.
 *
 * B-W2b-96 adds `depthEvents` (below): escalated, progressed, locked, the lead's confirmation, plant settings changed.
 */

const by = z.enum(['OFFICE', 'FLOOR', 'SYSTEM'])

export const events = [
  defineEvent({
    type: 'plant.lists_changed',
    context: 'plant',
    description: 'Machine classes or the symptoms the floor reports were added, changed or retired, or the starter set was added.',
    payload: z.strictObject({ list: z.enum(['CLASS', 'SYMPTOM', 'STARTER']), change: z.enum(['ADDED', 'CHANGED', 'RETIRED']), codes: z.array(z.string()) }),
    live: { permission: 'plant.view', fields: ['list', 'change'] },
  }),
  defineEvent({
    type: 'machine.registered',
    context: 'plant',
    description: 'A machine or piece of equipment was registered at a site, with its class, place and asset number (its QR tag).',
    payload: z.strictObject({ machineId: z.uuid(), assetNumber: z.string(), classId: z.uuid(), stationId: z.uuid().nullable(), workCentreId: z.uuid().nullable() }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['machineId', 'assetNumber'] },
  }),
  defineEvent({
    type: 'machine.changed',
    context: 'plant',
    description: "A machine's facts changed: class, make, model, serial, year, station, work centre, supplier, cost or note (the names of the fields only).",
    payload: z.strictObject({ machineId: z.uuid(), assetNumber: z.string(), fields: z.array(z.string()) }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['machineId', 'assetNumber', 'fields'] },
  }),
  defineEvent({
    type: 'machine.status_changed',
    context: 'plant',
    description: "A machine's status moved (a report marked it down or unsafe at once, a job started or handed it back, a technician signed it safe, a request was closed, it was retired); `locked`: an unsafe request still waits for its sign-safe.",
    payload: z.strictObject({
      machineId: z.uuid(),
      assetNumber: z.string(),
      from: z.enum(MACHINE_STATUSES),
      to: z.enum(MACHINE_STATUSES),
      // B-W2b-136: CHANGE = the office's Change status (with its reason; a release from do-not-use by a technician).
      cause: z.enum(['REPORT', 'JOB', 'SIGN_SAFE', 'TRIAGE', 'RETIRE', 'CHANGE']),
      recordType: z.enum(['MaintenanceRequest', 'MaintenanceJob', 'Machine']),
      recordId: z.uuid(),
      locked: z.boolean(),
      by,
    }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['machineId', 'assetNumber', 'from', 'to', 'locked'] },
  }),
  defineEvent({
    type: 'maintenance_request.reported',
    context: 'plant',
    description: 'A station or the office reported a machine problem with its symptom; an unsafe report locked the machine at once (Owner answer H1).',
    payload: z.strictObject({
      requestId: z.uuid(),
      machineId: z.uuid(),
      assetNumber: z.string(),
      symptomId: z.uuid().nullable(),
      symptomCode: z.string().nullable(),
      unsafe: z.boolean(),
      down: z.boolean(),
      stationId: z.uuid().nullable(),
      /** Other open requests of the machine (possible duplicates). */
      openOnMachine: z.number().int().min(0),
      by,
    }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['requestId', 'machineId', 'assetNumber', 'unsafe'] },
  }),
  defineEvent({
    type: 'maintenance_request.triaged',
    context: 'plant',
    description: 'Maintenance acknowledged a machine request, made a job of it (or added it to an open job of the machine), merged it into another request, or closed it without a job with the reason.',
    payload: z.strictObject({
      requestId: z.uuid(),
      machineId: z.uuid(),
      assetNumber: z.string(),
      action: z.enum(['ACKNOWLEDGED', 'JOB_MADE', 'MERGED', 'CLOSED']),
      status: z.enum(REQUEST_STATUSES),
      jobId: z.uuid().nullable(),
      mergedIntoId: z.uuid().nullable(),
      closeReason: z.enum(CLOSE_REASONS).nullable(),
    }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['requestId', 'machineId', 'action', 'status'] },
  }),
  defineEvent({
    type: 'maintenance_request.signed_safe',
    context: 'plant',
    description: "A technician checked a machine that was marked unsafe and signed its request safe (D.Lgs. 81/2008 art. 71; Owner answer H1); `stillLocked`: another unsafe request of the machine still waits.",
    payload: z.strictObject({ requestId: z.uuid(), machineId: z.uuid(), assetNumber: z.string(), machineStatus: z.enum(MACHINE_STATUSES), stillLocked: z.boolean(), by }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['requestId', 'machineId', 'assetNumber', 'machineStatus', 'stillLocked'] },
  }),
  defineEvent({
    type: 'maintenance_job.created',
    context: 'plant',
    description: 'A maintenance job was made with its number from the company series, by hand or from machine requests.',
    payload: z.strictObject({
      jobId: z.uuid(),
      number: z.string(),
      machineId: z.uuid(),
      assetNumber: z.string(),
      type: z.enum(JOB_TYPES),
      source: z.enum(JOB_SOURCES),
      priority: z.enum(PRIORITIES),
      status: z.enum(JOB_STATUSES),
      requestIds: z.array(z.uuid()),
    }),
    live: { permission: 'plant.view', floor: 'plant.jobs.work', fields: ['jobId', 'number', 'machineId', 'priority'] },
  }),
  defineEvent({
    type: 'maintenance_job.changed',
    context: 'plant',
    description: "A maintenance job's problem, type, priority or due time changed (the names of the fields only).",
    payload: z.strictObject({ jobId: z.uuid(), number: z.string(), machineId: z.uuid(), fields: z.array(z.string()) }),
    live: { permission: 'plant.view', floor: 'plant.jobs.work', fields: ['jobId', 'number', 'fields'] },
  }),
  defineEvent({
    type: 'maintenance_job.assigned',
    context: 'plant',
    description: 'A maintenance job was given to a technician (an office user or a floor worker of the site) or to nobody; an office assignee is told.',
    payload: z.strictObject({
      jobId: z.uuid(),
      number: z.string(),
      machineId: z.uuid(),
      assignee: z.enum(['USER', 'WORKER', 'NOBODY']),
      /** The office user it was given to (for the notice to them), else null. */
      assigneeId: z.uuid().nullable(),
      assignedById: z.uuid().nullable(),
    }),
    live: { permission: 'plant.view', floor: 'plant.jobs.work', fields: ['jobId', 'number', 'assignee'] },
  }),
  defineEvent({
    type: 'maintenance_job.moved',
    context: 'plant',
    description: 'A maintenance job was planned, started, put to wait for parts, handed back with the machine state after, taken back to work, closed or cancelled.',
    payload: z.strictObject({
      jobId: z.uuid(),
      number: z.string(),
      machineId: z.uuid(),
      move: z.enum(JOB_MOVES),
      from: z.enum(JOB_STATUSES),
      to: z.enum(JOB_STATUSES),
      machineAfter: z.enum(MACHINE_AFTER).nullable(),
      by,
    }),
    live: { permission: 'plant.view', floor: 'plant.jobs.work', fields: ['jobId', 'number', 'machineId', 'from', 'to'] },
  }),
] as const

// ---- B-W2b-96: the requests and jobs in depth ----------------------------------------------------------------------

/**
 * The events of the requests and jobs in depth (B-W2b-96; QHS-179, QHS-180, QHS-181, QHS-183, QHS-190; design
 * plant.requests "Live": "request.escalated → Age tone", floor.machine "Job acknowledged or fixed → the station sees it",
 * plant.settings "settings.changed → Banner"). apps/factory-api's modules/plant emits them in the commands that make the
 * change. Ids, codes and states only: no words a person typed, no name (an escalation names the employee it went to by id,
 * for the notice to them, never to a screen).
 *
 *   maintenance_request.escalated   nobody acknowledged a routed request in time: it escalated to level 1 or 2 by its rule
 *   maintenance_request.progressed  a technician is on the way, or the reporter confirmed the machine works again
 *   maintenance_request.locked      a request locked its machine as unsafe (a report marked so, or the office's "Lock as
 *                                   unsafe"); `hazardReport`: the site asks for a hazard report in Plant › Incidents
 *   maintenance_job.confirmed       the line lead confirmed the machine works after the hand-back
 *   plant_settings.changed          a site's request routing or its lock settings changed
 */

export const depthEvents = [
  defineEvent({
    type: 'maintenance_request.escalated',
    context: 'plant',
    description: 'Nobody acknowledged a routed machine request in time: it escalated to the person its routing rule names (level 1, then 2).',
    payload: z.strictObject({ requestId: z.uuid(), machineId: z.uuid(), assetNumber: z.string(), level: z.number().int().min(1).max(2), ruleId: z.uuid(), escalatedToId: z.uuid() }),
    live: { permission: 'plant.view', floor: 'plant.jobs.work', fields: ['requestId', 'machineId', 'assetNumber', 'level'] },
  }),
  defineEvent({
    type: 'maintenance_request.progressed',
    context: 'plant',
    description: 'A technician is on the way to a machine request, or the person who reported it confirmed the machine works again.',
    payload: z.strictObject({ requestId: z.uuid(), machineId: z.uuid(), assetNumber: z.string(), step: z.enum(['ON_THE_WAY', 'WORKS_AGAIN']), by }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['requestId', 'machineId', 'assetNumber', 'step'] },
  }),
  defineEvent({
    type: 'maintenance_request.locked',
    context: 'plant',
    description: "A machine request locked its machine as unsafe (Owner answer H1): reported so, or locked from the office's request detail; `hazardReport`: the site's settings ask for a hazard report in Plant › Incidents.",
    payload: z.strictObject({ requestId: z.uuid(), machineId: z.uuid(), assetNumber: z.string(), fromRequestId: z.uuid().nullable(), hazardReport: z.boolean(), by }),
    live: { permission: 'plant.view', floor: 'plant.report', fields: ['requestId', 'machineId', 'assetNumber'] },
  }),
  defineEvent({
    type: 'maintenance_job.confirmed',
    context: 'plant',
    description: 'The line lead confirmed that the machine of a handed-back maintenance job works again.',
    payload: z.strictObject({ jobId: z.uuid(), number: z.string(), machineId: z.uuid(), by }),
    live: { permission: 'plant.view', floor: 'plant.jobs.work', fields: ['jobId', 'number', 'machineId'] },
  }),
  defineEvent({
    type: 'plant_settings.changed',
    context: 'plant',
    description: "A site's machine request routing (a rule added, changed, removed or reordered) or its unsafe-lock settings changed.",
    payload: z.strictObject({ siteId: z.uuid(), part: z.enum(['ROUTING', 'LOCK']), change: z.enum(['ADDED', 'CHANGED', 'REMOVED', 'ORDERED']), ruleId: z.uuid().nullable() }),
    live: { permission: 'plant.view', fields: ['siteId', 'part', 'change'] },
  }),
] as const
