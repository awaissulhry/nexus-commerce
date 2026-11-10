import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECLARATION_KINDS, RULE_CODES, SUBSTANCE_TESTS } from '../compliance/substances/rules'

/**
 * Restricted substances' events (B-W2b-250; the code is factory-domain compliance/substances). A module folder of its own,
 * as compliance-rules and textile-rules (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/compliance/substances emits them in the command that makes the change (its routes, the starter list and the two
 * importers).
 *
 *   compliance_substances.substance_changed    a substance was added to the list, edited, archived or restored (by a person,
 *                                              the starter list or an import)
 *   compliance_substances.rule_changed         a rule over the list was added, edited, switched on or off, archived or
 *                                              restored
 *   compliance_substances.svhc_version_added   a new Candidate List version was recorded (a longer list asks the SVHC
 *                                              declarations again: B-W2b-256)
 *   compliance_substances.profile_evaluated    the evaluator wrote a material's compliance profile: its state, the rules,
 *                                              tests and declarations it needs, its SVHC answer
 *
 * Live for compliance.certificates.view (who reads the substance list and the material profiles). Ids, keys, codes and
 * states only: no words a person typed.
 */
const live = { permission: 'compliance.certificates.view' } as const
const change = z.enum(['CREATED', 'EDITED', 'SWITCHED', 'ARCHIVED', 'RESTORED'])

export const events = [
  defineEvent({
    type: 'compliance_substances.substance_changed',
    context: 'compliance-substances',
    description: 'A restricted substance was added to the list, edited, archived or restored (by a person, the starter list or an import).',
    payload: z.strictObject({
      substanceId: z.uuid(),
      casNumber: z.string().nullable(),
      groupCode: z.string().nullable(),
      change,
      by: z.enum(['PERSON', 'STARTER', 'IMPORT']),
    }),
    live: { ...live, fields: ['substanceId', 'casNumber', 'change'] },
  }),
  defineEvent({
    type: 'compliance_substances.rule_changed',
    context: 'compliance-substances',
    description: 'A rule over the substance list was added, edited, switched on or off, archived or restored.',
    payload: z.strictObject({
      ruleId: z.uuid(),
      key: z.string(),
      code: z.enum(RULE_CODES),
      switchedOn: z.boolean(),
      change,
      by: z.enum(['PERSON', 'STARTER', 'IMPORT']),
    }),
    live: { ...live, fields: ['ruleId', 'key', 'code', 'switchedOn', 'change'] },
  }),
  defineEvent({
    type: 'compliance_substances.svhc_version_added',
    context: 'compliance-substances',
    description: 'A new version of the ECHA Candidate List was recorded: declarations against an older, shorter list are asked again.',
    payload: z.strictObject({
      versionId: z.uuid(),
      publishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      entryCount: z.number().int().min(1),
      /** Entries more than the version before (null: the first one held). */
      grewBy: z.number().int().nullable(),
    }),
    live: { ...live, fields: ['versionId', 'publishedOn', 'entryCount'] },
  }),
  defineEvent({
    type: 'compliance_substances.profile_evaluated',
    context: 'compliance-substances',
    description: "The evaluator wrote a material's compliance profile: its state, the rules that apply, the tests and declarations it needs and its SVHC answer.",
    payload: z.strictObject({
      itemId: z.uuid(),
      state: z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED']),
      previousState: z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED']).nullable(),
      rules: z.number().int().min(0),
      testsNeeded: z.array(z.enum(SUBSTANCE_TESTS)),
      declarationsNeeded: z.array(z.enum(DECLARATION_KINDS)),
      svhcAboveThreshold: z.boolean().nullable(),
    }),
    live: { ...live, fields: ['itemId', 'state', 'previousState'] },
  }),
] as const
