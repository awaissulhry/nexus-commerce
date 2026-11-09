import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { SHARE_FIELD_KINDS, SHARE_HELD_REASONS, SHARE_LOCALES, SHARE_NOTE_MAX, SHARE_PERMISSIONS, SHARE_STATES } from '@nexus/factory-domain/shares/rules'
import { MAX_ATTACHMENTS, MAX_BODY_LENGTH } from '@nexus/factory-domain/threads/rules'

/**
 * Inviting a partner to one record (B-W2b-200). No money anywhere: ids, codes, times, the record's shared fields (each with
 * its kind) and words people typed (messages, names). The screens say every state and refusal in their own words from the
 * codes (`state`, `held`, `permissions`, the issues' `held/<CODE>` and `refusal/<CODE>` paths).
 */

const permission = z.enum(SHARE_PERMISSIONS)
const permissions = z.array(permission).max(SHARE_PERMISSIONS.length)
const locale = z.enum(SHARE_LOCALES)
const version = () => z.number().int().min(1)

// ---- the office --------------------------------------------------------------------------------------------------------

const shareView = output({
  id: id(),
  email: z.string(),
  contact: output({ id: id(), name: z.string().nullable() }).nullable(),
  permissions: z.array(permission),
  notifyByEmail: z.boolean(),
  expiresAt: instant(),
  state: z.enum(SHARE_STATES),
  invitedAt: instant(),
  invitedBy: z.string().nullable(),
  revoked: output({ at: instant(), byName: z.string().nullable() }).nullable(),
  lastOpenedAt: instant().nullable(),
  may: output({ change: z.boolean(), revoke: z.boolean() }),
  version: z.number().int(),
})

export const recordSharesContract = defineContract({
  querystring: input({ recordType: z.string().min(1).max(64), recordId: id() }),
  response: {
    200: output({
      record: output({ type: z.string(), id: id(), reference: z.string() }),
      party: output({ id: id(), name: z.string(), language: locale }).nullable(),
      contacts: z.array(output({ id: id(), name: z.string(), email: z.string(), language: locale.nullable() })),
      held: z.enum(['ALL_COMPANIES', 'NO_PARTY']).nullable(),
      may: output({ invite: z.boolean() }),
      shares: z.array(shareView),
    }),
  },
})

export const inviteContract = defineContract({
  body: input({
    recordType: z.string().min(1).max(64),
    recordId: id(),
    contactId: id().optional(),
    email: z.string().trim().max(254).optional(),
    permissions,
    expiresAt: instant().optional(),
    note: z.string().max(SHARE_NOTE_MAX * 2).nullable().optional(),
    send: z.boolean(),
    language: locale.optional(),
  }),
  response: { 201: output({ share: shareView, url: z.string().nullable(), delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable() }) },
})

const shareParams = input({ shareId: id() })

export const changeContract = defineContract({
  params: shareParams,
  body: input({ permissions, version: version() }),
  response: { 200: output({ share: shareView }) },
})

export const revokeContract = defineContract({
  params: shareParams,
  body: input({ version: version() }),
  response: { 200: output({ share: shareView }) },
})

// ---- the invited partner (the RECORD_INVITE link) ----------------------------------------------------------------------

const attachment = output({ id: id(), kind: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int() })
const message = output({
  id: id(),
  side: z.enum(['COMPANY', 'PARTNER']),
  channel: z.string(),
  author: output({ name: z.string().nullable(), mine: z.boolean() }),
  body: z.string(),
  attachments: z.array(attachment),
  at: instant(),
})
const held = z.enum(SHARE_HELD_REASONS).nullable()

export const linkPageContract = defineContract({
  querystring: input({ language: locale.optional(), cursor: z.string().max(200).optional() }),
  response: {
    200: output({
      share: output({ id: id(), permissions: z.array(permission), notifyByEmail: z.boolean(), expiresAt: instant(), invitedAt: instant(), invitedBy: z.string().nullable(), version: z.number().int() }),
      from: output({ companyName: z.string() }),
      record: output({
        type: z.string(),
        reference: z.string(),
        theirRef: z.string().nullable(),
        fields: z.array(output({ key: z.string(), kind: z.enum(SHARE_FIELD_KINDS), value: z.union([z.string(), z.number()]).nullable() })),
      }),
      files: z.array(output({ id: id(), kind: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), at: instant(), mine: z.boolean() })),
      thread: output({
        status: z.enum(['OPEN', 'CLOSED']).nullable(),
        shared: z.boolean(),
        messages: z.array(message),
        nextCursor: z.string().nullable(),
        canPost: z.boolean(),
        held,
        replyByEmail: z.boolean(),
      }),
      upload: output({ canUpload: z.boolean(), held, contentTypes: z.array(z.string()), maxBytes: z.number().int() }),
      locale,
    }),
  },
})

export const linkMessagesContract = defineContract({
  querystring: input({ cursor: z.string().max(200).optional() }),
  response: { 200: output({ messages: z.array(message), nextCursor: z.string().nullable() }) },
})

export const linkPostContract = defineContract({
  body: input({ body: z.string().max(MAX_BODY_LENGTH * 2), attachments: z.array(id()).max(MAX_ATTACHMENTS).optional() }),
  response: { 201: output({ thread: output({ id: id(), status: z.enum(['OPEN', 'CLOSED']) }), message }) },
})

export const linkNotifyContract = defineContract({
  body: input({ on: z.boolean() }),
  response: { 200: output({ notifyByEmail: z.boolean(), version: z.number().int() }) },
})

const uploadedFile = output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED']) })

export const linkAnnounceContract = defineContract({
  body: input({
    originalName: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(100),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  response: { 201: output({ file: uploadedFile, upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})

export const linkCompleteContract = defineContract({
  params: input({ fileId: id() }),
  response: { 200: output({ file: uploadedFile }) },
})
