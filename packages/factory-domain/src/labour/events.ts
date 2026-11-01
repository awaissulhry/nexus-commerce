import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DISPUTE_OUTCOMES, DISPUTE_RECORD_TYPES } from '../production/labour/rules'

/**
 * Labour records and corrections (B-W2b-45; MES-203, MES-206; labour.prisma; design production.labour "Live": dispute
 * raised in My day → the queue, floor.myday "A dispute answered → a badge on the My day tile"). apps/factory-api's
 * modules/production/labour emits them in the commands that make the change. The module is `labour` (the schema file's
 * name), not `production`: production's events file is another step's.
 *
 *   labour_day.closed       a line's day was closed: its off-standard time coded, its anomalies cleared (feeds pay)
 *   labour_day.reopened     a closed line's day was reopened, with a reason
 *   labour_dispute.raised   a worker disputed one of their own records (My day)
 *   labour_dispute.answered the team leader or HR answered a dispute, upheld or rejected (and corrected its block)
 *   labour_dispute.withdrawn the worker withdrew their dispute
 *
 * Every one reaches Labour & corrections in the office (production.labour.view); the dispute's answer and withdrawal also
 * reach the tablets of the site (floor.work): the signed-in worker's My day reads its own records again. Ids, days and
 * states only: never a worker, an employee, a name, the worker's words or the answer (Statuto dei Lavoratori art. 4;
 * GDPR art. 5): the screens read those from the one record.
 */

const day = z.iso.date()
const labourLive = { permission: 'production.labour.view' } as const

export const events = [
  defineEvent({
    type: 'labour_day.closed',
    context: 'labour',
    description: "A line's day was closed once its off-standard time was coded and its anomalies cleared: closed days feed pay.",
    payload: z.strictObject({ labourDayId: z.uuid(), siteId: z.uuid(), lineId: z.uuid(), workDate: day }),
    live: { ...labourLive, fields: ['labourDayId', 'siteId', 'lineId', 'workDate'] },
  }),
  defineEvent({
    type: 'labour_day.reopened',
    context: 'labour',
    description: "A closed line's day was reopened, with a reason (a change after the close is on record).",
    payload: z.strictObject({ labourDayId: z.uuid(), siteId: z.uuid(), lineId: z.uuid(), workDate: day }),
    live: { ...labourLive, fields: ['labourDayId', 'siteId', 'lineId', 'workDate'] },
  }),
  defineEvent({
    type: 'labour_dispute.raised',
    context: 'labour',
    description: 'A worker disputed one of their own records (a report or an off-standard block) for the team leader or HR to answer.',
    payload: z.strictObject({ disputeId: z.uuid(), siteId: z.uuid(), lineId: z.uuid().nullable(), workDate: day, recordType: z.enum(DISPUTE_RECORD_TYPES) }),
    live: { ...labourLive, fields: ['disputeId', 'siteId', 'lineId', 'workDate', 'recordType'] },
  }),
  defineEvent({
    type: 'labour_dispute.answered',
    context: 'labour',
    description: "A worker's dispute was answered, upheld or rejected, by the team leader or HR; an upheld dispute of an off-standard block corrected it.",
    payload: z.strictObject({ disputeId: z.uuid(), siteId: z.uuid(), lineId: z.uuid().nullable(), workDate: day, outcome: z.enum(DISPUTE_OUTCOMES), corrected: z.boolean() }),
    live: { ...labourLive, floor: 'floor.work', fields: ['disputeId', 'siteId', 'lineId', 'outcome'] },
  }),
  defineEvent({
    type: 'labour_dispute.withdrawn',
    context: 'labour',
    description: 'A worker withdrew their dispute.',
    payload: z.strictObject({ disputeId: z.uuid(), siteId: z.uuid(), lineId: z.uuid().nullable(), workDate: day }),
    live: { ...labourLive, floor: 'floor.work', fields: ['disputeId', 'siteId', 'lineId'] },
  }),
] as const
