import { z } from 'zod'
import { SHARE_PERMISSIONS, SHARE_STATES, type SharePermission } from '@nexus/factory-domain/shares/rules'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import type { RecordKey } from '../api'

/**
 * "Share with a partner" from a record (apps/factory-api platform/shares office.ts, B-W2b-200; COL-061, COL-062): the
 * record's partner, its contacts on file and every invitation (`GET /shares?recordType&recordId`), the invitation
 * (`POST /shares`: ONE command makes the RECORD_INVITE link and the share; `send` mails the link, else the API gives it
 * ONCE to pass on), what an invited person may do (`PUT /shares/:id/permissions {permissions, version}`) and the revoke
 * (`POST /shares/:id/revoke {version}`: the share and its link stop together). Office only: partners.shares.view / .manage
 * plus the record's own permission (the API checks both). No money here.
 */

const locale = z.enum(['it', 'en'])

export const shareSchema = z.object({
  id: z.string(),
  email: z.string(),
  contact: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  permissions: z.array(z.enum(SHARE_PERMISSIONS)),
  notifyByEmail: z.boolean(),
  expiresAt: z.string(),
  state: z.enum(SHARE_STATES),
  invitedAt: z.string(),
  invitedBy: z.string().nullable(),
  revoked: z.object({ at: z.string(), byName: z.string().nullable() }).nullable(),
  lastOpenedAt: z.string().nullable(),
  may: z.object({ change: z.boolean(), revoke: z.boolean() }),
  version: z.number(),
})
export type OfficeShare = z.infer<typeof shareSchema>

export const recordSharesSchema = z.object({
  record: z.object({ type: z.string(), id: z.string(), reference: z.string() }),
  party: z.object({ id: z.string(), name: z.string(), language: locale }).nullable(),
  contacts: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), language: locale.nullable() })),
  held: z.enum(['ALL_COMPANIES', 'NO_PARTY']).nullable(),
  may: z.object({ invite: z.boolean() }),
  shares: z.array(shareSchema),
})
export type RecordShares = z.infer<typeof recordSharesSchema>
export type ShareContact = RecordShares['contacts'][number]

export const inviteAnswerSchema = z.object({ share: shareSchema, url: z.string().nullable(), delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable() })
export type InviteAnswer = z.infer<typeof inviteAnswerSchema>

export interface InviteBody {
  recordType: string
  recordId: string
  contactId?: string
  email?: string
  permissions: SharePermission[]
  expiresAt: string
  note: string | null
  send: boolean
  language?: 'it' | 'en'
}

export function readRecordShares(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<RecordShares> {
  return api.get('/shares', { query: { recordType: record.type, recordId: record.id }, schema: recordSharesSchema, signal })
}

export function inviteToRecord(api: ApiClient, body: InviteBody, idempotencyKey = newIdempotencyKey()): Promise<InviteAnswer> {
  return api.post('/shares', { body, schema: inviteAnswerSchema, idempotencyKey })
}

const oneShare = z.object({ share: shareSchema })

export function changeSharePermissions(api: ApiClient, shareId: string, permissions: SharePermission[], version: number): Promise<{ share: OfficeShare }> {
  return api.request('PUT', `/shares/${encodeURIComponent(shareId)}/permissions`, { body: { permissions, version }, schema: oneShare, idempotencyKey: newIdempotencyKey() })
}

export function revokeShare(api: ApiClient, shareId: string, version: number): Promise<{ share: OfficeShare }> {
  return api.post(`/shares/${encodeURIComponent(shareId)}/revoke`, { body: { version }, schema: oneShare, idempotencyKey: newIdempotencyKey() })
}
