import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SAMPLE_DECISION_VIAS, SAMPLE_DECISIONS, SAMPLE_KINDS, SAMPLE_TEST_RESULTS } from '../sales/samples/rules'
import { SWATCH_KINDS } from '../sales/sample-decisions/rules'

/**
 * Sample decisions (B-W2b-252; SAL-312, SAL-314, PRD-070, PRD-158; the code is factory-domain sales/sample-decisions). A
 * module folder of its own, as B-W2b-246's sales-samples (the event guard wants `src/<module>/events.ts`).
 * apps/factory-api's modules/sales/sample-decisions emits them in the command that makes the change (a brand's answer: in
 * the approvals engine's settle, the tenant's system scope).
 *
 *   sample_round.decided        a round was decided (by the office, or the brand by portal or link): the board's card moves to
 *                               Decided; a pre-production gate (B-W2b-263) that names the round may pass
 *   sample_round.asked          the brand was asked to decide the round (an approval request of kind SAMPLE)
 *   sample_round.fit_changed    the fit of a round was measured, or a fit comment written, resolved or removed
 *   sample_round.test_recorded  a CE test sample's result or certificate was recorded
 *   sample_swatch.changed       a leather or colour swatch was recorded, changed, sent, removed, asked or decided
 *
 * Live on the samples screens for sales.samples.view. Ids, codes and states only: no person, no money.
 */
export const FIT_CHANGES = ['MEASURED', 'COMMENT_ADDED', 'COMMENT_CHANGED', 'COMMENT_REMOVED'] as const
export const SWATCH_CHANGES = ['ADDED', 'UPDATED', 'SENT', 'REMOVED', 'ASKED', 'DECIDED'] as const

const live = { permission: 'sales.samples.view' } as const

export const events = [
  defineEvent({
    type: 'sample_round.decided',
    context: 'sales-sample-decisions',
    description: 'A sample round was decided (approved, approved with comments, rejected) on its pinned revision, by the office or the brand by portal or link.',
    payload: z.strictObject({
      sampleRoundId: z.uuid(),
      number: z.string(),
      styleId: z.uuid(),
      revisionId: z.uuid(),
      kind: z.enum(SAMPLE_KINDS),
      roundNo: z.number().int(),
      partyId: z.uuid().nullable(),
      decision: z.enum(SAMPLE_DECISIONS),
      via: z.enum(SAMPLE_DECISION_VIAS),
      approvalRequestId: z.uuid().nullable(),
    }),
    live: { ...live, fields: ['sampleRoundId', 'number', 'decision', 'via'] },
  }),
  defineEvent({
    type: 'sample_round.asked',
    context: 'sales-sample-decisions',
    description: 'The brand was asked to decide a sample round (an approval request of kind SAMPLE, by link or portal).',
    payload: z.strictObject({ sampleRoundId: z.uuid(), number: z.string(), approvalRequestId: z.uuid(), partyId: z.uuid() }),
    live: { ...live, fields: ['sampleRoundId', 'number', 'approvalRequestId'] },
  }),
  defineEvent({
    type: 'sample_round.fit_changed',
    context: 'sales-sample-decisions',
    description: "A sample round's fit was measured against the spec, or one of its fit comments was written, resolved or removed.",
    payload: z.strictObject({ sampleRoundId: z.uuid(), number: z.string(), change: z.enum(FIT_CHANGES), cells: z.number().int(), outside: z.number().int() }),
    live: { ...live, fields: ['sampleRoundId', 'number', 'change'] },
  }),
  defineEvent({
    type: 'sample_round.test_recorded',
    context: 'sales-sample-decisions',
    description: "A CE test sample's result at the notified body, or the certificate it led to, was recorded.",
    payload: z.strictObject({ sampleRoundId: z.uuid(), number: z.string(), testResult: z.enum(SAMPLE_TEST_RESULTS).nullable(), certificateId: z.uuid().nullable() }),
    live: { ...live, fields: ['sampleRoundId', 'number', 'testResult'] },
  }),
  defineEvent({
    type: 'sample_swatch.changed',
    context: 'sales-sample-decisions',
    description: 'A leather or colour swatch for a brand was recorded, changed, sent, removed, asked or decided.',
    payload: z.strictObject({
      sampleSwatchId: z.uuid(),
      styleId: z.uuid(),
      roundId: z.uuid().nullable(),
      partyId: z.uuid(),
      kind: z.enum(SWATCH_KINDS),
      change: z.enum(SWATCH_CHANGES),
      decision: z.enum(SAMPLE_DECISIONS).nullable(),
      via: z.enum(SAMPLE_DECISION_VIAS).nullable(),
    }),
    live: { ...live, fields: ['sampleSwatchId', 'styleId', 'roundId', 'change'] },
  }),
] as const
