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
      cause: z.enum(['REPORT', 'JOB', 'SIGN_SAFE', 'TRIAGE', 'RETIRE']),
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
