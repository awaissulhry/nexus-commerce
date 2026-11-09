import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TIME_VERSION_STATUSES } from '../product/minutes/rules'

/**
 * SMV governance (B-W2b-215; PRD-111, PRD-113; design products.operations "SMV changes waiting for approval" tile and the
 * Minutes tab's timeline; products.styles routing "operation.smv_changed (library) → 'Library: x · Use library value' marks").
 * apps/factory-api's modules/product/minutes emits them in the commands that make the change. In a module folder of its own
 * (the product module's events stay in ../product/events.ts).
 *
 *   smv_version.changed    an SMV version was proposed, replaced by a new proposal, approved, rejected, or superseded when a
 *                          later one took effect
 *   operation.smv_changed  an operation's SMV took an approved version's numbers (at its approval when its day has come, else
 *                          on its day by the hourly job): new routing steps, capacity, cost and piece rates read it
 *
 * They reach Products › Operations (product.routing.view). Ids, codes, numbers and states only: no person, no money, no
 * words a person typed.
 */

const office = 'product.routing.view'

export const SMV_VERSION_CHANGES = ['PROPOSED', 'REPLACED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const
export type SmvVersionChange = (typeof SMV_VERSION_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'smv_version.changed',
    context: 'product-minutes',
    description: "A version of an operation's standard minutes was proposed, replaced by a new proposal, approved or rejected by a second person, or superseded when a later one took effect.",
    payload: z.strictObject({
      operationId: z.uuid(),
      /** The operation's code. */
      code: z.string(),
      versionId: z.uuid(),
      number: z.number().int().min(1),
      status: z.enum(TIME_VERSION_STATUSES),
      change: z.enum(SMV_VERSION_CHANGES),
      /** The version's SMV and its first day (YYYY-MM-DD). */
      standardMinutes: z.string(),
      effectiveFrom: z.string(),
    }),
    live: { permission: office, fields: ['operationId', 'code', 'versionId', 'number', 'status', 'change'] },
  }),
  defineEvent({
    type: 'operation.smv_changed',
    context: 'product-minutes',
    description: "An operation's SMV took the numbers of an approved version (at its approval, or on its day): the routing marks steps that differ, and capacity, cost and piece rates read the new SMV.",
    payload: z.strictObject({
      operationId: z.uuid(),
      code: z.string(),
      versionId: z.uuid(),
      number: z.number().int().min(1),
      /** Before and after. */
      from: z.string(),
      standardMinutes: z.string(),
      /** At the approval (a person) or on its day (the system). */
      by: z.enum(['APPROVAL', 'SCHEDULE']),
    }),
    live: { permission: office, fields: ['operationId', 'code', 'versionId', 'number', 'standardMinutes'] },
  }),
] as const
