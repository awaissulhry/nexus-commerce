import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PROJECT_OUTCOMES, PROJECT_STATUSES } from './rules'

/**
 * Projects (threads plan TH-5, B-TH-066 … B-TH-068; the code is factory-domain projects). apps/factory-api's modules/product/
 * projects emits them in the command that makes the change; the search index (platform/search/indexers/project.ts) re-reads the
 * project on each, the notification centre tells the person added or removed (platform/notifications/rules/projects.ts).
 *
 *   project.created          a project was made (its number from the company's PROJECT series)
 *   project.changed          its name, goal, lead, target date or season changed
 *   project.status_changed   put on hold, resumed, closed with its outcome, reopened
 *   project.linked           a record was linked to it (both ways: the record's "In project" too)
 *   project.unlinked         a link was removed
 *   project.person_added     an office colleague or a portal person of its outside company was added by hand (reason ADDED)
 *   project.person_removed   someone was taken out of it by the lead (or someone who manages projects)
 *
 * Live on the projects screens for threads.read (who reads a project). Ids, numbers and states only: never a name, a goal or an
 * outcome's words, never money. `partyId` is the project's outside company (null: office-only), so a person limited to other
 * customers never receives the message (events/live.ts, the brand wall).
 */
const live = { permission: 'threads.read' } as const
const party = () => z.uuid().nullable()

export const events = [
  defineEvent({
    type: 'project.created',
    context: 'projects',
    description: 'A project was made: work on several records, or with no record yet, with its own thread.',
    payload: z.strictObject({ projectId: z.uuid(), number: z.string(), partyId: party(), fromRecordType: z.string().nullable(), fromRecordId: z.uuid().nullable() }),
    live: { ...live, fields: ['projectId', 'number'] },
  }),
  defineEvent({
    type: 'project.changed',
    context: 'projects',
    description: "A project's name, goal, lead, target date or season changed.",
    payload: z.strictObject({ projectId: z.uuid(), number: z.string(), partyId: party(), fields: z.array(z.string()).max(10), leadChanged: z.boolean() }),
    live: { ...live, fields: ['projectId', 'number'] },
  }),
  defineEvent({
    type: 'project.status_changed',
    context: 'projects',
    description: 'A project was put on hold, resumed, closed with its outcome, or reopened.',
    payload: z.strictObject({ projectId: z.uuid(), number: z.string(), partyId: party(), from: z.enum(PROJECT_STATUSES), to: z.enum(PROJECT_STATUSES), outcome: z.enum(PROJECT_OUTCOMES).nullable() }),
    live: { ...live, fields: ['projectId', 'number', 'to'] },
  }),
  defineEvent({
    type: 'project.linked',
    context: 'projects',
    description: 'A record was linked to a project.',
    payload: z.strictObject({ projectId: z.uuid(), number: z.string(), partyId: party(), linkId: z.uuid(), recordType: z.string(), recordId: z.uuid() }),
    live: { ...live, fields: ['projectId', 'recordType', 'recordId'] },
  }),
  defineEvent({
    type: 'project.unlinked',
    context: 'projects',
    description: 'A record was unlinked from a project.',
    payload: z.strictObject({ projectId: z.uuid(), number: z.string(), partyId: party(), linkId: z.uuid(), recordType: z.string(), recordId: z.uuid() }),
    live: { ...live, fields: ['projectId', 'recordType', 'recordId'] },
  }),
  defineEvent({
    type: 'project.person_added',
    context: 'projects',
    description: "A person was added to a project by hand: an office colleague, or a portal person of the project's outside company.",
    payload: z.strictObject({ projectId: z.uuid(), number: z.string(), partyId: party(), userId: z.uuid(), outside: z.boolean(), byId: z.uuid() }),
    live: { ...live, fields: ['projectId'] },
  }),
  defineEvent({
    type: 'project.person_removed',
    context: 'projects',
    description: 'A person was taken out of a project by its lead or by someone who manages projects.',
    payload: z.strictObject({ projectId: z.uuid(), number: z.string(), partyId: party(), userId: z.uuid(), outside: z.boolean(), byId: z.uuid() }),
    live: { ...live, fields: ['projectId'] },
  }),
] as const
