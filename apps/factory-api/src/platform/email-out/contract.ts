import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import {
  DISPLAY_NAME_POLICIES,
  IDENTITY_KINDS,
  IDENTITY_STATUSES,
  LOCALES,
  MAX_ADDRESS_LENGTH,
  MAX_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  OUTBOUND_STATUSES,
  VERIFICATION_STATUSES,
} from '@nexus/factory-domain/email/rules'
import { MAX_ATTACHMENTS, MAX_BODY_LENGTH, RECORD_TYPE } from '@nexus/factory-domain/threads/rules'
import { threadView } from '../threads/contract'

/**
 * Email out's contracts (plan A1 §3.7; features PLT-139, PLT-230, COL-024). A record mail is sent from the record's
 * thread (`/threads/<recordType>/<recordId>/emails`); its text is the thread's OUTBOUND message. No answer ever holds
 * the thread's reply address, SES's message id or a sign-in link.
 */

const recordParams = input({ recordType: z.string().regex(RECORD_TYPE), recordId: id() })
const address = z.string().max(MAX_ADDRESS_LENGTH)
const addresses = z.array(address).max(MAX_RECIPIENTS)

export const emailView = output({
  id: id(),
  companyId: id(),
  identityId: id(),
  threadId: id().nullable(),
  /** The thread message that holds its text. */
  messageId: id().nullable(),
  templateKey: z.string(),
  locale: z.string(),
  from: output({ name: z.string(), address: z.string() }),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  status: z.enum(OUTBOUND_STATUSES),
  attempts: z.number().int(),
  /** The last failure, or what a bounce or complaint said. */
  lastError: z.string().nullable(),
  queuedAt: instant(),
  sentAt: instant().nullable(),
  deliveredAt: instant().nullable(),
  bouncedAt: instant().nullable(),
  complainedAt: instant().nullable(),
  failedAt: instant().nullable(),
})
export type EmailView = z.infer<typeof emailView>

export const sendEmailContract = defineContract({
  params: recordParams,
  body: input({
    to: addresses.min(1),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    /** Left out: "Re: " and the subject of the thread's latest mail. */
    subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
    body: z.string().max(MAX_BODY_LENGTH),
    /** Files of this record shared with its party, together at most 10 MB; the mail carries their bytes. */
    attachments: z.array(id()).max(MAX_ATTACHMENTS).optional(),
    /** A sending identity of the record's company; default its CONVERSATION default. */
    identityId: id().optional(),
    /** The language of the mail's fixed text; default the company's. */
    locale: z.enum(LOCALES).optional(),
  }),
  response: { 201: output({ thread: threadView, messageId: id(), email: emailView }) },
})

export const listEmailsContract = defineContract({
  params: recordParams,
  querystring: input({ cursor: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ emails: z.array(emailView), nextCursor: z.string().nullable() }) },
})

export const identityView = output({
  id: id(),
  companyId: id(),
  kind: z.enum(IDENTITY_KINDS),
  domain: z.string(),
  fromAddress: z.string(),
  displayName: z.string(),
  displayNamePolicy: z.enum(DISPLAY_NAME_POLICIES),
  replyDomain: z.string(),
  accountId: id(),
  sesIdentityArn: z.string().nullable(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  dkimStatus: z.enum(VERIFICATION_STATUSES),
  /** The DNS records Easy DKIM needs (PLT-230). */
  dkimRecords: z.array(output({ type: z.literal('CNAME'), name: z.string(), value: z.string() })),
  /** Ready to send: active, domain and DKIM verified. */
  ready: z.boolean(),
  lastCheckedAt: instant().nullable(),
  isDefault: z.boolean(),
  status: z.enum(IDENTITY_STATUSES),
  version: z.number().int(),
  createdAt: instant(),
})
export type IdentityView = z.infer<typeof identityView>

export const listIdentitiesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ identities: z.array(identityView) }) },
})

export const createIdentityContract = defineContract({
  body: input({
    companyId: id(),
    kind: z.enum(IDENTITY_KINDS),
    /** The sending domain (`acme.example.com`, `mail.acme.example.com`). */
    domain: z.string().min(3).max(253),
    /** The From address's local part; default `noreply`. */
    localPart: z.string().min(1).max(64).optional(),
    /** The company's name as mail shows it; default its trade name, else its legal name. */
    displayName: z.string().trim().min(1).max(120).optional(),
    displayNamePolicy: z.enum(DISPLAY_NAME_POLICIES).optional(),
    /** Where the records' reply addresses live; default `reply.<domain>`. */
    replyDomain: z.string().min(3).max(253).optional(),
    /** The SES account (IntegrationAccount, provider SES) that sends. */
    accountId: id(),
    /** Make it the company's default of its kind (the first one is anyway). */
    isDefault: z.boolean().optional(),
  }),
  response: { 201: output({ identity: identityView, sesChecked: z.boolean() }) },
})

export const identityParams = input({ identityId: id() })

export const checkIdentityContract = defineContract({
  params: identityParams,
  response: { 200: output({ identity: identityView }) },
})

export const updateIdentityContract = defineContract({
  params: identityParams,
  body: input({
    /** The identity's version as read (edit-conflict guard). */
    version: z.number().int().min(1),
    displayName: z.string().trim().min(1).max(120).optional(),
    displayNamePolicy: z.enum(DISPLAY_NAME_POLICIES).optional(),
    isDefault: z.boolean().optional(),
    status: z.enum(IDENTITY_STATUSES).optional(),
  }),
  response: { 200: output({ identity: identityView }) },
})
