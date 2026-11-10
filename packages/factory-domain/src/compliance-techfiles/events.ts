import { z } from 'zod'
import { defineEvent } from '../events/define'
import {
  ANNEX_III_POINTS,
  ASSESSMENT_STATUSES,
  ITEM_STATES,
  PACK_PURPOSES,
  PACK_STATUSES,
  TECHNICAL_FILE_STATUSES,
  TEST_KINDS,
  TEST_RESULTS,
} from '../compliance/techfiles/rules'

/**
 * Technical files' events (B-W2b-251; the code is factory-domain compliance/techfiles). A module folder of its own, as
 * compliance-rules and product-techpack (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/compliance/techfiles emits them in the command that makes the change (design compliance.techfiles live:
 * "inspection.signed / release.granted / test.recorded → Production control rows, tiles").
 *
 *   technical_file.changed         a style's technical file was opened, edited (certificate, keeper, note, keep-until),
 *                                  completed, reopened or archived
 *   technical_file.item_changed    an Annex III item was added, linked to its evidence, reviewed, marked not applicable,
 *                                  unlinked or removed
 *   technical_file.risk_changed    a product risk assessment revision was drafted, edited (its words or its hazards),
 *                                  signed (superseding the one before) or removed while a draft
 *   technical_file.test_changed    a production-control test was planned, recorded (PASS or FAIL), edited or removed
 *   technical_file.pack_requested  an evidence pack was asked for: its build job runs (the worker's handler
 *                                  compliance.techfiles.buildPack)
 *   technical_file.pack_changed    an evidence pack was built or failed, sent by a link, its link withdrawn, or removed
 *
 * Live for compliance.certificates.view (who reads the technical files and the certificates). Ids, numbers, codes, kinds and
 * states only: no words a person typed, no person.
 */
const live = { permission: 'compliance.certificates.view' } as const

export const events = [
  defineEvent({
    type: 'technical_file.changed',
    context: 'compliance-techfiles',
    description: "A style's technical file was opened, edited, completed, reopened or archived.",
    payload: z.strictObject({
      technicalFileId: z.uuid(),
      number: z.string(),
      styleId: z.uuid(),
      status: z.enum(TECHNICAL_FILE_STATUSES),
      change: z.enum(['CREATED', 'EDITED', 'COMPLETED', 'REOPENED', 'ARCHIVED']),
    }),
    live: { ...live, fields: ['technicalFileId', 'number', 'styleId', 'status', 'change'] },
  }),
  defineEvent({
    type: 'technical_file.item_changed',
    context: 'compliance-techfiles',
    description: 'An Annex III item of a technical file was added, linked, reviewed, marked not applicable, unlinked or removed.',
    payload: z.strictObject({
      technicalFileId: z.uuid(),
      itemId: z.uuid(),
      point: z.enum(ANNEX_III_POINTS),
      state: z.enum(ITEM_STATES).nullable(),
      change: z.enum(['ADDED', 'LINKED', 'REVIEWED', 'NOT_APPLICABLE', 'UNLINKED', 'EDITED', 'REMOVED']),
    }),
    live: { ...live, fields: ['technicalFileId', 'itemId', 'point', 'state', 'change'] },
  }),
  defineEvent({
    type: 'technical_file.risk_changed',
    context: 'compliance-techfiles',
    description: 'A product risk assessment revision was drafted, edited, signed (superseding the one before) or removed while a draft.',
    payload: z.strictObject({
      technicalFileId: z.uuid(),
      assessmentId: z.uuid(),
      revision: z.number().int().min(1),
      status: z.enum(ASSESSMENT_STATUSES).nullable(),
      change: z.enum(['CREATED', 'EDITED', 'ROWS', 'SIGNED', 'REMOVED']),
    }),
    live: { ...live, fields: ['technicalFileId', 'assessmentId', 'revision', 'status', 'change'] },
  }),
  defineEvent({
    type: 'technical_file.test_changed',
    context: 'compliance-techfiles',
    description: 'A production-control test was planned, recorded, edited or removed.',
    payload: z.strictObject({
      testId: z.uuid(),
      styleId: z.uuid(),
      workOrderId: z.uuid().nullable(),
      test: z.enum(TEST_KINDS),
      result: z.enum(TEST_RESULTS).nullable(),
      change: z.enum(['PLANNED', 'RECORDED', 'EDITED', 'REMOVED']),
    }),
    live: { ...live, fields: ['testId', 'styleId', 'workOrderId', 'test', 'result', 'change'] },
  }),
  defineEvent({
    type: 'technical_file.pack_requested',
    context: 'compliance-techfiles',
    description: 'An evidence pack of a technical file was asked for; its build job runs.',
    payload: z.strictObject({
      packId: z.uuid(),
      number: z.string(),
      technicalFileId: z.uuid(),
      purpose: z.enum(PACK_PURPOSES),
    }),
    live: { ...live, fields: ['packId', 'number', 'technicalFileId', 'purpose'] },
  }),
  defineEvent({
    type: 'technical_file.pack_changed',
    context: 'compliance-techfiles',
    description: 'An evidence pack was built or failed, sent by a link, had its link withdrawn, or was removed.',
    payload: z.strictObject({
      packId: z.uuid(),
      number: z.string(),
      technicalFileId: z.uuid(),
      status: z.enum(PACK_STATUSES),
      change: z.enum(['BUILT', 'FAILED', 'SHARED', 'LINK_WITHDRAWN', 'REMOVED']),
      documents: z.number().int().min(0).nullable(),
    }),
    live: { ...live, fields: ['packId', 'number', 'technicalFileId', 'status', 'change', 'documents'] },
  }),
] as const
