import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The supplier questionnaire (B-W2b-172; SCM-023; the Forced Labour Regulation (EU) 2024/3015 due diligence).
 * apps/factory-api's modules/purchasing/questionnaire emits them in the commands that make the change. Their own module
 * folder (check-event-contract wants src/<module>/events.ts); the code is factory-domain purchasing/questionnaire.
 *
 *   supplier_questionnaire.published  a company published a questionnaire version: from then on it is fixed, and the
 *                                     links sent from now ask it
 *   supplier_questionnaire.link_sent  a buyer sent a supplier the questionnaire by link (mailed, or the address given once);
 *                                     the supplier's earlier open links of the company were withdrawn in the same command
 *   supplier_questionnaire.answered   a supplier sent its signed answer through its link: kept as a PDF on the supplier's
 *                                     files, with a review task for the buyer
 *   supplier_questionnaire.reviewed   the buyer accepted the answer (its documents then count, with their expiry) or sent
 *                                     questions back on the supplier's thread
 *
 * Reach the office screens that read them (purchasing.questionnaire.view): ids, versions, decisions and counts only, never
 * a name, an address, an answer's words or the link's token.
 */

const answer = { responseId: z.uuid(), partyId: z.uuid(), questionnaireId: z.uuid(), revision: z.number().int().min(1) }

export const events = [
  defineEvent({
    type: 'supplier_questionnaire.published',
    context: 'supplier-questionnaire',
    description: "A company published a version of its supplier questionnaire: it is fixed from now on, and every link sent from now asks it.",
    payload: z.strictObject({ questionnaireId: z.uuid(), revision: z.number().int().min(1), questions: z.number().int().min(1) }),
    live: { permission: 'purchasing.questionnaire.view', fields: ['questionnaireId', 'revision'] },
  }),
  defineEvent({
    type: 'supplier_questionnaire.link_sent',
    context: 'supplier-questionnaire',
    description: "A buyer sent a supplier the questionnaire by link (by e-mail, or the link given to pass on); the supplier's earlier open links of the company were withdrawn.",
    payload: z.strictObject({ linkId: z.uuid(), partyId: z.uuid(), questionnaireId: z.uuid(), mailed: z.boolean(), withdrawn: z.number().int().min(0), expiresAt: z.iso.datetime() }),
    live: { permission: 'purchasing.questionnaire.view', fields: ['linkId', 'partyId', 'questionnaireId'] },
  }),
  defineEvent({
    type: 'supplier_questionnaire.answered',
    context: 'supplier-questionnaire',
    description: "A supplier sent its signed questionnaire answer through its link: kept as a PDF on the supplier's files, with a review task for the buyer.",
    payload: z.strictObject({ ...answer, linkId: z.uuid().nullable(), documents: z.number().int().min(0), pdfFileId: z.uuid(), taskId: z.uuid() }),
    live: { permission: 'purchasing.questionnaire.view', fields: ['responseId', 'partyId', 'questionnaireId', 'revision'] },
  }),
  defineEvent({
    type: 'supplier_questionnaire.reviewed',
    context: 'supplier-questionnaire',
    description: "The buyer reviewed a supplier's questionnaire answer: accepted (its documents count, with their expiry) or questions sent back on the supplier's thread.",
    payload: z.strictObject({ ...answer, decision: z.enum(['ACCEPTED', 'QUESTIONS']), documents: z.number().int().min(0) }),
    live: { permission: 'purchasing.questionnaire.view', fields: ['responseId', 'partyId', 'decision'] },
  }),
] as const
