import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ACTION_CHANGES, ACTION_KINDS, CAPA_CHANGED_FIELDS, CAPA_PRIORITIES, CAPA_STATUSES, CAPA_TYPES, SOURCE_CHANGES, SOURCE_TYPES } from '../quality/capa/rules'

/**
 * Corrective actions, CAPA and 8D (B-W2b-108; QHS-087, QHS-093, QHS-094, QHS-096; design quality.capa "live:
 * capa.action_due / capa.action_overdue → Actions tab, tiles"). apps/factory-api's modules/quality/capa emits them in the
 * commands that make the change. Its own module folder (as quality-plans, quality-incoming): the quality events file is
 * other steps'.
 *
 *   capa.opened           a CAPA or an 8D was opened (numbered), by hand or by escalating records to it
 *   capa.changed          its title, owner, team, due day, priority, customer or problem statement changed (which fields)
 *   capa.stage_changed    it moved inside its stages, was closed (D8) or cancelled
 *   capa.sources_changed  an NCR or a complaint was escalated to it (ADDED) or taken off it (REMOVED)
 *   capa.action_changed   an action was added, changed, recorded done (with its evidence) or cancelled
 *   capa.action_due       an open action was reminded (a task for its owner): its due day is near or today
 *   capa.action_overdue   an overdue action escalated (once): tasks for its escalation path or the rule's audience
 *   capa.report_made      a version of its 8D report was kept (a GeneratedDocument EIGHT_D with its PDF)
 *
 * Reach the CAPA screens of the office (quality.capa.view over the CAPA's company): ids, numbers, codes and counts only;
 * never a person's name, never money. Never the floor.
 */

const live = (fields: readonly string[]) => ({ permission: 'quality.capa.view', fields: ['capaId', 'number', ...fields] }) as const
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const events = [
  defineEvent({
    type: 'capa.opened',
    context: 'quality-capa',
    description: 'A CAPA or an 8D was opened and numbered, by hand or by escalating NCRs and complaints to it.',
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), type: z.enum(CAPA_TYPES), priority: z.enum(CAPA_PRIORITIES), customerId: z.uuid().nullable(), sources: z.number().int().min(0) }),
    live: live(['type']),
  }),
  defineEvent({
    type: 'capa.changed',
    context: 'quality-capa',
    description: "A CAPA's title, owner, team, due day, priority, customer or problem statement changed.",
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), fields: z.array(z.enum(CAPA_CHANGED_FIELDS)).min(1) }),
    live: live(['fields']),
  }),
  defineEvent({
    type: 'capa.stage_changed',
    context: 'quality-capa',
    description: 'A CAPA moved inside its stages (Plan, Act, Check; D1 to D8), was closed from its last stage, or was cancelled.',
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), from: z.enum(CAPA_STATUSES), to: z.enum(CAPA_STATUSES) }),
    live: live(['from', 'to']),
  }),
  defineEvent({
    type: 'capa.sources_changed',
    context: 'quality-capa',
    description: 'An NCR or a complaint was escalated to a CAPA, or taken off it while it is open.',
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), change: z.enum(SOURCE_CHANGES), recordType: z.enum(SOURCE_TYPES), recordId: z.uuid() }),
    live: live(['change', 'recordType', 'recordId']),
  }),
  defineEvent({
    type: 'capa.action_changed',
    context: 'quality-capa',
    description: "A CAPA's corrective or preventive action was added, changed, recorded done with its evidence, or cancelled.",
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), actionId: z.uuid(), seq: z.number().int().min(1), kind: z.enum(ACTION_KINDS), change: z.enum(ACTION_CHANGES) }),
    live: live(['actionId', 'seq', 'change']),
  }),
  defineEvent({
    type: 'capa.action_due',
    context: 'quality-capa',
    description: "An open CAPA action was reminded (a task for its owner): its due day is near or today.",
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), actionId: z.uuid(), seq: z.number().int().min(1), dueOn: day(), reminder: z.number().int().min(1), taskId: z.uuid().nullable(), byHand: z.boolean() }),
    live: live(['actionId', 'seq', 'dueOn', 'reminder']),
  }),
  defineEvent({
    type: 'capa.action_overdue',
    context: 'quality-capa',
    description: 'An overdue CAPA action escalated, once: tasks for its escalation path, else the audience of the company\'s overdue-action rule.',
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), actionId: z.uuid(), seq: z.number().int().min(1), dueOn: day(), told: z.number().int().min(0), tasks: z.number().int().min(0) }),
    live: live(['actionId', 'seq', 'dueOn']),
  }),
  defineEvent({
    type: 'capa.report_made',
    context: 'quality-capa',
    description: 'A version of a CAPA\'s 8D report was kept: a GeneratedDocument EIGHT_D with its PDF, in the chosen language.',
    payload: z.strictObject({ capaId: z.uuid(), number: z.string(), documentId: z.uuid(), version: z.number().int().min(1), language: z.enum(['it', 'en']) }),
    live: live(['documentId', 'version', 'language']),
  }),
] as const
