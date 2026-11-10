import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The user information builder's events (B-W2b-258; the code is factory-domain compliance/user-information). A module folder
 * of its own, as compliance-declarations and compliance-rules (the event guard wants `src/<module>/events.ts`).
 * apps/factory-api's modules/compliance/user-information emits them in the command that makes the change (design
 * compliance.declarations live: rows, the language matrix and the tiles re-read).
 *
 *   compliance_user_information.draft_changed        a generated leaflet draft was made, refreshed from its records, given
 *                                                    typed words, or withdrawn (an original or a translation)
 *   compliance_user_information.translation_changed  a translation was started from the phrase library (a market's
 *                                                    language pack), moved between draft and in translation, checked by a
 *                                                    second person, or its check undone
 *
 * Ids, codes and states only: no words a person typed. Live for compliance.certificates.view (who reads the declarations
 * and the leaflets).
 */
const live = { permission: 'compliance.certificates.view' } as const
const language = () => z.string().regex(/^[a-z]{2,3}$/)

export const events = [
  defineEvent({
    type: 'compliance_user_information.draft_changed',
    context: 'compliance-user-information',
    description: 'A generated user-information draft (an original or a translation) was made, refreshed from its records, given typed words, or withdrawn.',
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
    type: 'compliance_user_information.translation_changed',
    context: 'compliance-user-information',
    description: "A generated leaflet's translation was started from the phrase library (a market's language pack), moved between draft and in translation, checked by a second person, or its check undone.",
    payload: z.strictObject({
      documentId: z.uuid(),
      translationOfId: z.uuid(),
      styleId: z.uuid(),
      language: language(),
      marketCode: z.string().nullable(),
      state: z.enum(['DRAFT', 'IN_TRANSLATION', 'CHECKED']),
      change: z.enum(['STARTED', 'MOVED', 'CHECKED', 'UNCHECKED']),
    }),
    live: { ...live, fields: ['documentId', 'translationOfId', 'language', 'marketCode', 'state', 'change'] },
  }),
] as const
