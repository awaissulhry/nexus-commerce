import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DOCUMENT_TEMPLATE_KINDS } from './documents'
import { MAIL_EVENTS } from './mail'

/**
 * Templates' events (B-W2b-422; PLT-231, PLT-232, COL-016). apps/factory-api's platform/templates emits them in the command
 * that changes a template; none carries a template's words:
 *   document_template.changed   a version of a company's document template was written, changed, published, retired or a
 *                               draft deleted: Documents & numbering › Document templates and an open editor read again.
 *   email_template.changed      the same for an e-mail template (a company's own or every company's: companyId null).
 *   saved_reply.changed         a saved reply was written, changed or deleted (shared: the office's; else a person's own).
 */

export const TEMPLATE_CHANGES = ['CREATED', 'EDITED', 'PUBLISHED', 'RETIRED', 'DELETED'] as const
export type TemplateChange = (typeof TEMPLATE_CHANGES)[number]

export const REPLY_CHANGES = ['CREATED', 'EDITED', 'DELETED'] as const
export type ReplyChange = (typeof REPLY_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'document_template.changed',
    context: 'templates',
    description: "A version of a company's document template was written, changed, published or retired, or a draft deleted.",
    payload: z.strictObject({
      templateId: z.uuid(),
      companyId: z.uuid(),
      kind: z.enum(DOCUMENT_TEMPLATE_KINDS),
      language: z.string().length(2),
      revision: z.number().int().min(1),
      change: z.enum(TEMPLATE_CHANGES),
    }),
    live: { permission: 'documents.view', fields: ['templateId', 'companyId', 'kind', 'language', 'revision', 'change'] },
  }),
  defineEvent({
    type: 'email_template.changed',
    context: 'templates',
    description: 'A version of an e-mail template (a company’s own or every company’s) was written, changed, published or retired, or a draft deleted.',
    payload: z.strictObject({
      templateId: z.uuid(),
      companyId: z.uuid().nullable(),
      event: z.enum(MAIL_EVENTS),
      language: z.string().length(2),
      revision: z.number().int().min(1),
      change: z.enum(TEMPLATE_CHANGES),
    }),
    live: { permission: 'documents.view', fields: ['templateId', 'companyId', 'event', 'language', 'revision', 'change'] },
  }),
  defineEvent({
    type: 'saved_reply.changed',
    context: 'templates',
    description: 'A saved reply was written, changed or deleted.',
    payload: z.strictObject({ replyId: z.uuid(), shared: z.boolean(), change: z.enum(REPLY_CHANGES) }),
    live: { permission: 'email.send', fields: ['replyId', 'shared', 'change'] },
  }),
] as const
