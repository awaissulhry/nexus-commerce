import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Work instructions (B-W2b-214; PRD-117, MES-110, MES-119; design production.instructions "a change by someone else shows a
 * Banner with Reload", floor.instructions "A new version published → the 'New' badge and the acknowledgement due at the
 * next Start"). apps/factory-api modules/production/instructions emits them in the commands that make the change. Its own
 * module folder (as production-lays and production-cutissue): the production events file is other steps'.
 *
 *   production.instruction_changed       an instruction was made, archived or restored, or a version of it drafted, saved
 *                                        or discarded
 *   production.instruction_published     a second person approved a draft: the floor shows it from now on, the version
 *                                        before it is superseded in the same command
 *   production.instruction_acknowledged  a worker saw a version (on a tablet, or on paper recorded by the office)
 *
 * They reach the office's Work instructions (production.instructions.view). Never a tablet: an instruction is a company's,
 * not a site's, and a tablet reads the version in force when the operation opens. Ids, numbers and states only, never a
 * person (an acknowledgement is a training record, never a figure per worker: Owner answers F2, H3, W1).
 */

export const INSTRUCTION_CHANGES = ['CREATED', 'ARCHIVED', 'RESTORED', 'VERSION_DRAFTED', 'VERSION_SAVED', 'VERSION_DISCARDED'] as const
export type InstructionChange = (typeof INSTRUCTION_CHANGES)[number]

export const ACK_WAYS = ['FLOOR', 'PAPER'] as const
export type AckWay = (typeof ACK_WAYS)[number]

const live = { permission: 'production.instructions.view', fields: ['instructionId', 'number', 'versionId', 'versionNumber'] } as const

export const events = [
  defineEvent({
    type: 'production.instruction_changed',
    context: 'production-instructions',
    description: 'A work instruction was made, archived or restored, or one of its versions was drafted, saved or discarded.',
    payload: z.strictObject({
      instructionId: z.uuid(),
      number: z.string(),
      operationId: z.uuid(),
      change: z.enum(INSTRUCTION_CHANGES),
      versionId: z.uuid().nullable(),
      versionNumber: z.number().int().min(1).nullable(),
    }),
    live: { ...live, fields: [...live.fields, 'change'] },
  }),
  defineEvent({
    type: 'production.instruction_published',
    context: 'production-instructions',
    description: 'A second person approved a draft of a work instruction: the floor shows it from now on and, when it asks for it, the workers of the operation look at it at their next Start; the version before it was superseded.',
    payload: z.strictObject({
      instructionId: z.uuid(),
      number: z.string(),
      operationId: z.uuid(),
      versionId: z.uuid(),
      versionNumber: z.number().int().min(1),
      supersededVersionId: z.uuid().nullable(),
      acknowledgementRequired: z.boolean(),
    }),
    live,
  }),
  defineEvent({
    type: 'production.instruction_acknowledged',
    context: 'production-instructions',
    description: 'A worker saw a version of a work instruction (Seen on a tablet, or a paper acknowledgement recorded by the office): a training record, never a figure per worker.',
    payload: z.strictObject({
      instructionId: z.uuid(),
      number: z.string(),
      versionId: z.uuid(),
      versionNumber: z.number().int().min(1),
      siteId: z.uuid(),
      way: z.enum(ACK_WAYS),
    }),
    live,
  }),
] as const
