import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LAWFUL_BASES, PRIVACY_LIMITS } from '@nexus/factory-domain/parties/contact-privacy/privacy'

/** The contacts' personal-data routes' contracts (B-W2b-290; SAL-022; modules/parties/contact-privacy). */

const basisWords = output({ en: z.string(), it: z.string(), article: z.string() })
const contactView = output({
  id: id(),
  name: z.string(),
  erased: z.boolean(),
  status: z.string(),
  lawfulBasis: z.enum(LAWFUL_BASES).nullable(),
  basisWords: basisWords.nullable(),
  consentAt: instant().nullable(),
  consentSource: z.string().nullable(),
  objectedAt: instant().nullable(),
  erasedAt: instant().nullable(),
  erasedBy: z.string().nullable(),
  version: z.number().int(),
})
const privacyView = output({
  partyId: id(),
  code: z.string(),
  contacts: z.array(contactView),
  notRecorded: z.number().int(),
  bases: z.array(output({ basis: z.enum(LAWFUL_BASES), en: z.string(), it: z.string(), article: z.string() })),
})
const answer = output({ privacy: privacyView })
const contact = input({ partyId: id(), contactId: id() })
const words = z.string().max(PRIVACY_LIMITS.words + 200)
const record = output({ id: id(), number: z.string(), status: z.string(), at: instant() })

export const getContactsPrivacyContract = defineContract({ params: input({ partyId: id() }), response: { 200: answer } })
export const setLawfulBasisContract = defineContract({
  params: contact,
  body: input({ version: z.number().int().min(1), lawfulBasis: z.enum(LAWFUL_BASES), consentAt: instant().nullish(), consentSource: z.string().max(PRIVACY_LIMITS.consentSource + 100).nullish() }),
  response: { 200: answer },
})
export const recordObjectionContract = defineContract({ params: contact, body: input({ version: z.number().int().min(1), at: instant().nullish(), words }), response: { 200: answer } })
export const accessCopyContract = defineContract({
  params: contact,
  body: input({ words }),
  response: {
    201: output({
      madeAt: instant(),
      copy: output({
        person: output({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), roles: z.array(z.string()), language: z.string().nullable(), status: z.string(), createdAt: instant(), updatedAt: instant() }),
        processing: output({
          controller: output({ partyCode: z.string(), note: z.string() }),
          organisation: output({ code: z.string(), legalName: z.string() }),
          lawfulBasis: z.enum(LAWFUL_BASES).nullable(),
          basisWords: basisWords.nullable(),
          consentAt: instant().nullable(),
          consentSource: z.string().nullable(),
          objectedAt: instant().nullable(),
        }),
        records: output({ quotes: z.array(record), inquiries: z.array(record), returns: z.array(record), complaints: z.array(record) }),
        mailsReceived: z.array(output({ id: id(), at: instant(), from: z.string().nullable(), fromName: z.string().nullable(), subject: z.string().nullable(), excerpt: z.string().nullable(), status: z.string() })),
        mailsSent: z.array(output({ id: id(), at: instant(), subject: z.string(), status: z.string(), record: output({ type: z.string(), id: z.string() }).nullable() })),
        messages: z.array(output({ id: id(), threadId: id(), at: instant(), authorName: z.string().nullable(), excerpt: z.string().nullable() })),
        links: z.array(output({ id: id(), purpose: z.string(), recordType: z.string(), email: z.string().nullable(), at: instant() })),
        measurementProfiles: z.array(output({ id: id(), riderName: z.string(), garmentType: z.string(), revision: z.number().int(), measurements: z.unknown(), baseSize: z.string().nullable(), fitNotes: z.string().nullable(), takenAt: instant() })),
        portalUsers: z.array(output({ id: id(), email: z.string(), displayName: z.string(), status: z.string() })),
        changes: z.array(output({ at: instant(), action: z.string() })),
        truncated: z.boolean(),
      }),
    }),
  },
})
export const eraseContactContract = defineContract({
  params: contact,
  body: input({ version: z.number().int().min(1), words }),
  response: { 200: output({ privacy: privacyView, kept: z.array(output({ kind: z.string(), count: z.number().int(), why: z.string() })) }) },
})
