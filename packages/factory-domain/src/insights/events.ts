import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Today's actions (B-W1-52 actions; apps/factory-api modules/insights actions.ts; design home.today "alert →
 * Acknowledge · Assign · Resolve"). Each says what a person did about one row of Today, in the condition the row was in;
 * every person who sees Today in the row's company reads it again (the web's GET /live filter lists them beside the
 * kinds' own events). A notification centre (W2a) may tell the assignee.
 *
 *   attention.assigned       a row was assigned to a person who may act on it, or taken back (assigneeId null)
 *   attention.resolved       a row was resolved with a note: it leaves Today for everyone until its condition changes
 *   attention.acknowledged   a row was acknowledged: it stays, marked, while its condition holds
 *   attention.snoozed        (W2a) a row was snoozed until a time, or until its condition changes: it leaves Today
 *   attention.nudged         (W2a) a person reminded the people they wait on (Waiting on others › Nudge): the
 *                            notification centre tells those who may decide; once a day at most
 *   kpi.changed              (B-W2b-428) a KPI version drafted, edited, deleted, put in force or the KPI withdrawn
 *   kpi.uses_changed         (B-W2b-428) where KPIs are used kept in step with the readers' registries
 *   facts.rebuilt            (B-W2b-428) a company's daily and hourly facts of some days rebuilt from the records
 */

const row = {
  actionId: z.uuid(),
  /** `<kind>:<record id>[:<sub key>]`. */
  key: z.string(),
  kind: z.string(),
  recordType: z.string(),
  recordId: z.uuid(),
  /** The row's condition when it was done (insights/attention conditionOf). */
  condition: z.string(),
}

const live = { permission: 'home.view', fields: ['key', 'kind'] } as const

export const events = [
  defineEvent({
    type: 'attention.assigned',
    context: 'insights',
    description: 'A row of Today was assigned to a person who may act on it, or taken back.',
    payload: z.strictObject({ ...row, assigneeId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'attention.resolved',
    context: 'insights',
    description: 'A row of Today was resolved with a note: it leaves Today until its condition changes.',
    payload: z.strictObject(row),
    live,
  }),
  defineEvent({
    type: 'attention.acknowledged',
    context: 'insights',
    description: 'A row of Today was acknowledged: it stays, marked, while its condition holds.',
    payload: z.strictObject(row),
    live,
  }),
  defineEvent({
    type: 'attention.snoozed',
    context: 'insights',
    description: 'A row of Today was snoozed until a time, or until its condition changes: it leaves Today meanwhile.',
    payload: z.strictObject({ ...row, until: z.string().nullable() }),
    live,
  }),
  defineEvent({
    type: 'attention.nudged',
    context: 'insights',
    description: 'A person reminded the people they wait on (an approval they asked for): those who may decide are told.',
    payload: z.strictObject({
      /** The waiting row's key (`<kind>:<record id>`). */
      key: z.string(),
      kind: z.string(),
      recordType: z.string(),
      recordId: z.uuid(),
      /** The note the reminder wrote on the record's thread. */
      messageId: z.uuid(),
      /** Who nudged (the asker). */
      byId: z.uuid(),
    }),
    live,
  }),
  // B-W2b-428 (ANA-012, ANA-069, ANA-070): the metric layer. A KPI version written, changed, deleted, put in force or
  // withdrawn; where KPIs are used kept in step with the readers' registries; a company's facts rebuilt from the records
  // (the KPI library and every number on it read again). Live to the people who read the KPI library.
  defineEvent({
    type: 'kpi.changed',
    context: 'insights',
    description: 'A version of a KPI was written, changed or deleted as a draft, put in force (the one before it superseded), or the KPI was withdrawn.',
    payload: z.strictObject({
      kpiKey: z.string(),
      kpiVersion: z.number().int().min(1),
      /** The version's row (KpiDefinition). */
      definitionId: z.uuid(),
      action: z.enum(['DRAFTED', 'EDITED', 'DELETED', 'ACTIVATED', 'RETIRED', 'INSTALLED']),
      /** ACTIVATED: the version it superseded, if one was in force. */
      supersededId: z.uuid().nullable(),
    }),
    live: { permission: 'home.kpis.view', fields: ['kpiKey', 'kpiVersion', 'action'] },
  }),
  defineEvent({
    type: 'kpi.uses_changed',
    context: 'insights',
    description: 'Where KPIs are used was kept in step with the readers that read them (uses added and removed).',
    payload: z.strictObject({ added: z.number().int().min(0), removed: z.number().int().min(0), kpiKeys: z.array(z.string()) }),
    live: { permission: 'home.kpis.view', fields: ['kpiKeys'] },
  }),
  defineEvent({
    type: 'facts.rebuilt',
    context: 'insights',
    description: "A company's daily and hourly facts of some days were rebuilt from the records (by the hour, after an event, or by a person).",
    payload: z.strictObject({
      companyId: z.uuid(),
      from: z.string(),
      to: z.string(),
      /** The sources rebuilt (factory-domain insights/kpis/measures MEASURE_SOURCES). */
      sources: z.array(z.string()),
      daily: z.number().int().min(0),
      hourly: z.number().int().min(0),
      trigger: z.enum(['HOURLY', 'NIGHTLY', 'EVENT', 'PERSON']),
    }),
    live: { permission: 'home.kpis.view', fields: ['companyId', 'from', 'to', 'sources'] },
  }),
] as const
