import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The DoC generator's events (B-W2b-257; the code is factory-domain compliance/declarations). A module folder of its own,
 * as compliance-rules and textile-rules (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/compliance/declarations emits them in the command that makes the change (design compliance.declarations live:
 * rows, the language matrix and the tiles re-read; "shipment.shipped → batches under each revision").
 *
 *   compliance_declarations.draft_changed        a generated DoC draft was made, refreshed from its records, given typed
 *                                                words or fields, or withdrawn (an original or a translation)
 *   compliance_declarations.translation_changed  a translation was started from the phrase library, moved between draft
 *                                                and in translation, checked by a second person, or its check undone
 *   compliance_declarations.batches_recorded     which signed revision went with which batch (and shipment) was recorded
 *   compliance_declarations.pack_made            a shipment's compliance pack got a new version (its PDF kept)
 *
 * Ids, codes, numbers and states only: no words a person typed. The first three are live for compliance.certificates.view
 * (who reads the declarations); the pack for shipping.view (who reads the shipment).
 */
const live = { permission: 'compliance.certificates.view' } as const
const language = () => z.string().regex(/^[a-z]{2,3}$/)

export const events = [
  defineEvent({
    type: 'compliance_declarations.draft_changed',
    context: 'compliance-declarations',
    description: 'A generated DoC draft (an original or a translation) was made, refreshed from its records, given typed words, or withdrawn.',
    payload: z.strictObject({
      documentId: z.uuid(),
      styleId: z.uuid(),
      revision: z.number().int().min(1),
      language: language(),
      translationOfId: z.uuid().nullable(),
      change: z.enum(['CREATED', 'REFRESHED', 'EDITED', 'WITHDRAWN']),
    }),
    live: { ...live, fields: ['documentId', 'styleId', 'language', 'change'] },
  }),
  defineEvent({
    type: 'compliance_declarations.translation_changed',
    context: 'compliance-declarations',
    description: "A generated DoC's translation was started from the phrase library, moved between draft and in translation, checked by a second person, or its check undone.",
    payload: z.strictObject({
      documentId: z.uuid(),
      translationOfId: z.uuid(),
      styleId: z.uuid(),
      language: language(),
      state: z.enum(['DRAFT', 'IN_TRANSLATION', 'CHECKED']),
      change: z.enum(['STARTED', 'MOVED', 'CHECKED', 'UNCHECKED']),
    }),
    live: { ...live, fields: ['documentId', 'translationOfId', 'language', 'state', 'change'] },
  }),
  defineEvent({
    type: 'compliance_declarations.batches_recorded',
    context: 'compliance-declarations',
    description: 'Which signed revision of a DoC or leaflet went with which batch, and with which shipment, was recorded (kept ten years).',
    payload: z.strictObject({
      styleIds: z.array(z.uuid()),
      shipmentId: z.uuid().nullable(),
      records: z.number().int().min(1),
      batchNumbers: z.array(z.string()),
    }),
    live: { ...live, fields: ['styleIds', 'shipmentId', 'records'] },
  }),
  defineEvent({
    type: 'compliance_declarations.pack_made',
    context: 'compliance-declarations',
    description: "A shipment's compliance pack got a new version: its signed DoCs and leaflets, the certificate summary and the batches, as a PDF kept on the shipment.",
    payload: z.strictObject({
      shipmentId: z.uuid(),
      generatedDocumentId: z.uuid(),
      version: z.number().int().min(1),
      language: language(),
      documents: z.number().int().min(0),
      shared: z.boolean(),
    }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'generatedDocumentId', 'version'] },
  }),
] as const
