import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { COLUMN_KEYS } from '@nexus/factory-domain/documents/layouts'
import { DOCUMENT_TEMPLATE_KINDS, MANDATORY_PARTS } from '@nexus/factory-domain/templates/documents'
import { LANGUAGE_SOURCES, TEMPLATE_LANGUAGES } from '@nexus/factory-domain/templates/language'
import { MAIL_EVENTS } from '@nexus/factory-domain/templates/mail'
import { REPLY_RECORD_TYPES } from '@nexus/factory-domain/templates/replies'

/**
 * The template routes' contracts (B-W2b-422; PLT-131, PLT-231, PLT-232, COL-016; the screens are B-W2b-432's). Office only.
 * Codes, never words for the screens to show (kinds, events, statuses, columns, the parts a document always prints, where a
 * language comes from); a template's own words are the person's text and come back as written.
 */

const version = z.number().int().min(1)
const versionQuery = input({ version: z.coerce.number().int().min(1) })
const language = z.enum(TEMPLATE_LANGUAGES)
const status = z.enum(['DRAFT', 'ACTIVE', 'RETIRED'])
const person = output({ id: id(), name: z.string() })
const templateParams = input({ templateId: id() })
const replyParams = input({ replyId: id() })
/** A template's text as sent: room for the spaces trimmed off; the rules check the length of what is kept. */
const words = (max: number) => z.string().max(max + 2000)

// ── Document templates ───────────────────────────────────────────────────────────────────────────────────────────────

export const documentTemplateView = output({
  id: id(),
  companyId: id(),
  kind: z.enum(DOCUMENT_TEMPLATE_KINDS),
  /** As kept (two letters); the API writes Italian and English only. */
  language: z.string(),
  /** Its version number in the series of its company, kind and language. */
  revision: z.number().int(),
  status,
  header: z.string().nullable(),
  terms: z.string().nullable(),
  /** null: the company's own footer text. */
  footer: z.string().nullable(),
  /** The optional columns it shows, in the layout's order. */
  fieldsShown: z.array(z.string()),
  /** The layout it prints with (`QUOTE/2+t3`). */
  layout: z.string(),
  publishedAt: instant().nullable(),
  publishedBy: person.nullable(),
  retiredAt: instant().nullable(),
  createdAt: instant(),
  createdBy: person.nullable(),
  updatedAt: instant(),
  version: z.number().int(),
})
export type DocumentTemplateView = z.infer<typeof documentTemplateView>

const slotVersion = output({ id: id(), revision: z.number().int(), at: instant() })

export const listDocumentTemplatesContract = defineContract({
  querystring: input({ companyId: id(), kind: z.enum(DOCUMENT_TEMPLATE_KINDS).optional(), language: language.optional(), status: status.optional() }),
  response: {
    200: output({
      /** Every version that matches, newest first (at most 500). */
      templates: z.array(documentTemplateView),
      /** One row per kind and language: the version in use (null: the code's fixed layout), the open draft, the versions kept. */
      slots: z.array(output({ kind: z.enum(DOCUMENT_TEMPLATE_KINDS), language, layout: z.string(), active: slotVersion.nullable(), draft: slotVersion.nullable(), versions: z.number().int(), lastChangedAt: instant().nullable() })),
      mayManage: z.boolean(),
    }),
  },
})

export const documentKindsContract = defineContract({
  response: {
    200: output({
      kinds: z.array(
        output({
          kind: z.enum(DOCUMENT_TEMPLATE_KINDS),
          /** The code's fixed layout (the fallback). */
          layout: z.string(),
          /** The columns a template may show or leave out (the code's layout shows them all), in the layout's order. */
          optionalColumns: z.array(z.enum(COLUMN_KEYS)),
          mandatoryColumns: z.array(z.enum(COLUMN_KEYS)),
          mandatoryParts: z.array(z.enum(MANDATORY_PARTS)),
          placeholders: z.array(z.string()),
          limits: output({ header: z.number().int(), terms: z.number().int(), footer: z.number().int() }),
        }),
      ),
      languages: z.array(language),
    }),
  },
})

export const getDocumentTemplateContract = defineContract({ params: templateParams, response: { 200: output({ template: documentTemplateView, mayManage: z.boolean() }) } })

const documentWords = {
  header: words(2000).nullish(),
  terms: words(20000).nullish(),
  footer: words(2000).nullish(),
  fieldsShown: z.array(z.string().max(60)).max(60).optional(),
}

export const createDocumentTemplateContract = defineContract({
  body: input({
    companyId: id(),
    kind: z.enum(DOCUMENT_TEMPLATE_KINDS),
    language,
    /** A version of the same company, kind and language to start from; default the one in use, else the code's layout. */
    from: id().optional(),
    ...documentWords,
  }),
  response: { 201: output({ template: documentTemplateView }) },
})

export const updateDocumentTemplateContract = defineContract({
  params: templateParams,
  body: input({ version, ...documentWords }),
  response: { 200: output({ template: documentTemplateView }) },
})

const lifeBody = input({ version })

export const publishDocumentTemplateContract = defineContract({
  params: templateParams,
  body: lifeBody,
  response: { 200: output({ template: documentTemplateView, retired: output({ id: id(), revision: z.number().int() }).nullable() }) },
})

export const retireDocumentTemplateContract = defineContract({ params: templateParams, body: lifeBody, response: { 200: output({ template: documentTemplateView }) } })

export const deleteDocumentTemplateContract = defineContract({ params: templateParams, querystring: versionQuery, response: { 200: output({ deleted: id() }) } })

/** The PDF itself (a sample on the company's legal data with this version's words; stored nowhere). */
export const previewDocumentTemplateContract = defineContract({ params: templateParams, response: {} })

// ── E-mail templates ─────────────────────────────────────────────────────────────────────────────────────────────────

export const emailTemplateView = output({
  id: id(),
  /** null: every company's (a company's own wins). */
  companyId: id().nullable(),
  event: z.enum(MAIL_EVENTS),
  /** As kept (two letters); the API writes Italian and English only. */
  language: z.string(),
  revision: z.number().int(),
  status,
  subject: z.string(),
  body: z.string(),
  publishedAt: instant().nullable(),
  publishedBy: person.nullable(),
  retiredAt: instant().nullable(),
  createdAt: instant(),
  createdBy: person.nullable(),
  updatedAt: instant(),
  version: z.number().int(),
})
export type EmailTemplateView = z.infer<typeof emailTemplateView>

export const mailEventsContract = defineContract({
  response: {
    200: output({
      events: z.array(output({ event: z.enum(MAIL_EVENTS), recordType: z.string(), placeholders: z.array(z.string()), words: z.record(z.string(), output({ subject: z.string(), body: z.string() })) })),
      languages: z.array(language),
    }),
  },
})

export const listEmailTemplatesContract = defineContract({
  querystring: input({ companyId: id(), event: z.enum(MAIL_EVENTS).optional(), language: language.optional(), status: status.optional() }),
  response: {
    200: output({
      /** The company's own and every company's versions that match, newest first (at most 500). */
      templates: z.array(emailTemplateView),
      /** One row per event and language: what the company's mail is sent with now (its own, every company's, the code's words). */
      slots: z.array(
        output({
          event: z.enum(MAIL_EVENTS),
          language,
          inUse: z.enum(['COMPANY', 'ALL', 'CODE']),
          company: output({ active: slotVersion.nullable(), draft: slotVersion.nullable() }),
          all: output({ active: slotVersion.nullable(), draft: slotVersion.nullable() }),
          lastChangedAt: instant().nullable(),
        }),
      ),
      mayManage: output({ company: z.boolean(), all: z.boolean() }),
    }),
  },
})

export const getEmailTemplateContract = defineContract({ params: templateParams, response: { 200: output({ template: emailTemplateView, mayManage: z.boolean() }) } })

export const createEmailTemplateContract = defineContract({
  body: input({
    /** null: every company's. */
    companyId: id().nullable(),
    event: z.enum(MAIL_EVENTS),
    language,
    /** A version of the same event, company and language to start from; default the one in use, else the code's words. */
    from: id().optional(),
    subject: words(200).optional(),
    body: words(20000).optional(),
  }),
  response: { 201: output({ template: emailTemplateView }) },
})

export const updateEmailTemplateContract = defineContract({
  params: templateParams,
  body: input({ version, subject: words(200).optional(), body: words(20000).optional() }),
  response: { 200: output({ template: emailTemplateView }) },
})

export const publishEmailTemplateContract = defineContract({
  params: templateParams,
  body: lifeBody,
  response: { 200: output({ template: emailTemplateView, retired: output({ id: id(), revision: z.number().int() }).nullable() }) },
})

export const retireEmailTemplateContract = defineContract({ params: templateParams, body: lifeBody, response: { 200: output({ template: emailTemplateView }) } })

export const deleteEmailTemplateContract = defineContract({ params: templateParams, querystring: versionQuery, response: { 200: output({ deleted: id() }) } })

export const previewEmailTemplateContract = defineContract({
  params: templateParams,
  /** The company whose names fill an every-company template (default: the template's own company, else the first one the person sees). */
  body: input({ companyId: id().optional() }),
  response: { 200: output({ subject: z.string(), body: z.string(), missing: z.array(z.string()) }) },
})

// ── Saved replies ────────────────────────────────────────────────────────────────────────────────────────────────────

export const replyView = output({
  id: id(),
  companyId: id().nullable(),
  name: z.string(),
  /** As kept (two letters); the API writes Italian and English only. */
  language: z.string(),
  body: z.string(),
  /** As kept: a record type of REPLY_RECORD_TYPES, another table (written another way), or null (any record). */
  recordType: z.string().nullable(),
  /** Shared with the office (ownerId null), else the person's own. */
  shared: z.boolean(),
  owner: person.nullable(),
  /** The reader may change and delete it (their own, or a shared one with email.replies.share). */
  mayChange: z.boolean(),
  updatedAt: instant(),
  version: z.number().int(),
})
export type ReplyView = z.infer<typeof replyView>

export const listRepliesContract = defineContract({
  querystring: input({ language: language.optional(), recordType: z.enum(REPLY_RECORD_TYPES).optional(), companyId: id().optional() }),
  response: {
    200: output({
      /** The reader's own and the shared ones, by name (a record type's replies with those for any record). */
      replies: z.array(replyView),
      placeholders: z.record(z.string(), z.array(z.string())),
      mayShare: z.boolean(),
    }),
  },
})

const replyWords = { name: z.string().max(400), language, body: z.string().max(12000), recordType: z.enum(REPLY_RECORD_TYPES).nullable(), companyId: id().nullable() }

export const createReplyContract = defineContract({ body: input({ ...replyWords, shared: z.boolean() }), response: { 201: output({ reply: replyView }) } })

export const updateReplyContract = defineContract({
  params: replyParams,
  body: input({ version, name: replyWords.name.optional(), language: language.optional(), body: replyWords.body.optional(), recordType: replyWords.recordType.optional(), companyId: replyWords.companyId.optional() }),
  response: { 200: output({ reply: replyView }) },
})

export const deleteReplyContract = defineContract({ params: replyParams, querystring: versionQuery, response: { 200: output({ deleted: id() }) } })

export const fillReplyContract = defineContract({
  params: replyParams,
  body: input({ recordType: z.enum(REPLY_RECORD_TYPES), recordId: id(), contactId: id().optional() }),
  response: {
    200: output({
      /** The body with the record's values (the person reads and changes it before sending). */
      body: z.string(),
      language,
      /** The placeholders the record had no value for (left empty in the body). */
      missing: z.array(z.string()),
    }),
  },
})

// ── The partner contact's language ───────────────────────────────────────────────────────────────────────────────────

const recipientLanguage = output({ language, source: z.enum(LANGUAGE_SOURCES), notOffered: z.string().nullable() })

export const recipientLanguageContract = defineContract({
  querystring: input({ partyId: id(), contactId: id().optional() }),
  response: { 200: output({ partyId: id(), contactId: id().nullable(), ...recipientLanguage.shape }) },
})

export const contactLanguagesContract = defineContract({
  querystring: input({ q: z.string().trim().max(120).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: {
    200: output({
      /** Active contacts of active parties, by party then name: their own language, the party's, and what goes out. */
      contacts: z.array(
        output({
          contactId: id(),
          name: z.string(),
          email: z.string().nullable(),
          own: z.string().nullable(),
          party: output({ id: id(), code: z.string(), name: z.string(), language: z.string() }),
          ...recipientLanguage.shape,
          version: z.number().int(),
        }),
      ),
      nextCursor: z.string().nullable(),
      languages: z.array(language),
    }),
  },
})
