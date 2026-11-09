import { z } from 'zod'
import { SHARE_FIELD_KINDS, SHARE_HELD_REASONS, SHARE_PERMISSIONS } from '@nexus/factory-domain/shares/rules'
import type { ApiClient } from '../../lib/api/client'
import { downloadLink, type Presigned } from '../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../record-panels/store'

/**
 * A partner invited to one record (apps/factory-api platform/shares, B-W2b-200; RECORD_INVITE; COL-061, COL-062; design
 * links.invite, SCR-270): the page (`GET /link/share?language=`: the share as it is now — what the person may do, until
 * when, "E-mail me", who invited them —, the record's shared fields, the files shared with the link, one page of the
 * record's shared thread newest first, and whether they may post or upload, each with a code when not), the older
 * messages (`GET /link/share/messages?cursor=`), a post (`POST /link/share/messages`), "E-mail me" (`PUT
 * /link/share/notify`), an upload (announce, the bytes straight to the store, complete) and a file opened through the
 * generic files route (presigned for 60 s, read once). Reading uses nothing: the link opens until the share ends or is
 * revoked. The API's English is never shown: the page says everything from codes, kinds and values. The token travels only
 * in `x-factory-link`.
 */

const field = z.object({ key: z.string(), kind: z.enum(SHARE_FIELD_KINDS), value: z.union([z.string(), z.number()]).nullable() })
const held = z.enum(SHARE_HELD_REASONS).nullable()

export const shareMessageSchema = z.object({
  id: z.string(),
  side: z.enum(['COMPANY', 'PARTNER']),
  channel: z.string(),
  author: z.object({ name: z.string().nullable(), mine: z.boolean() }),
  body: z.string(),
  attachments: z.array(z.object({ id: z.string(), kind: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number() })),
  at: z.string(),
})
export type ShareMessage = z.infer<typeof shareMessageSchema>

export const sharePageSchema = z.object({
  share: z.object({ id: z.string(), permissions: z.array(z.enum(SHARE_PERMISSIONS)), notifyByEmail: z.boolean(), expiresAt: z.string(), invitedAt: z.string(), invitedBy: z.string().nullable(), version: z.number() }),
  from: z.object({ companyName: z.string() }),
  record: z.object({ type: z.string(), reference: z.string(), theirRef: z.string().nullable(), fields: z.array(field) }),
  files: z.array(z.object({ id: z.string(), kind: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number(), at: z.string(), mine: z.boolean() })),
  thread: z.object({
    status: z.enum(['OPEN', 'CLOSED']).nullable(),
    shared: z.boolean(),
    messages: z.array(shareMessageSchema),
    nextCursor: z.string().nullable(),
    canPost: z.boolean(),
    held,
    replyByEmail: z.boolean(),
  }),
  upload: z.object({ canUpload: z.boolean(), held, contentTypes: z.array(z.string()), maxBytes: z.number() }),
  locale: z.enum(['it', 'en']),
})
export type SharePage = z.infer<typeof sharePageSchema>
export type ShareFile = SharePage['files'][number]
export type ShareField = SharePage['record']['fields'][number]

/** `GET /link/share?language=` — the page in the reader's language (nothing is used). */
export function readLinkShare(api: ApiClient, language: 'it' | 'en', signal?: AbortSignal): Promise<SharePage> {
  return api.get('/link/share', { query: { language }, schema: sharePageSchema, signal })
}

const messagesSchema = z.object({ messages: z.array(shareMessageSchema), nextCursor: z.string().nullable() })

/** `GET /link/share/messages?cursor=` — the next (older) page of the thread. */
export function readOlderMessages(api: ApiClient, cursor: string): Promise<z.infer<typeof messagesSchema>> {
  return api.get('/link/share/messages', { query: { cursor }, schema: messagesSchema })
}

const postedSchema = z.object({ thread: z.object({ id: z.string(), status: z.enum(['OPEN', 'CLOSED']) }), message: shareMessageSchema })

/** `POST /link/share/messages` — a message on the shared record (the share must allow comments now), with the record's shared files ticked. */
export function postShareMessage(api: ApiClient, body: string, attachments: readonly string[], idempotencyKey: string): Promise<z.infer<typeof postedSchema>> {
  return api.post('/link/share/messages', { body: { body, ...(attachments.length > 0 ? { attachments: [...attachments] } : {}) }, schema: postedSchema, idempotencyKey })
}

const notifySchema = z.object({ notifyByEmail: z.boolean(), version: z.number() })

/** `PUT /link/share/notify` — "E-mail me" on or off. */
export function setShareNotify(api: ApiClient, on: boolean, idempotencyKey: string): Promise<z.infer<typeof notifySchema>> {
  return api.request('PUT', '/link/share/notify', { body: { on }, schema: notifySchema, idempotencyKey })
}

const presignedSchema = z.object({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
const uploadedSchema = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number(), status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED']) })
const announcedSchema = z.object({ file: uploadedSchema, upload: presignedSchema })
const completedSchema = z.object({ file: uploadedSchema })

/**
 * One file onto the shared record: announced with its SHA-256, its bytes PUT straight to the store, then confirmed. Each
 * step has its own key, so a retry of the same file starts again cleanly.
 */
export async function uploadShareFile(api: ApiClient, file: File, keys: { announce: string; complete: string }, put: typeof putToStore = putToStore): Promise<z.infer<typeof uploadedSchema>> {
  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const announced = await api.post('/link/share/files', { body: { originalName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: bytes.byteLength, sha256 }, schema: announcedSchema, idempotencyKey: keys.announce })
  await put(announced.upload as Presigned, bytes)
  const done = await api.post(`/link/share/files/${encodeURIComponent(announced.file.id)}/complete`, { schema: completedSchema, idempotencyKey: keys.complete })
  return done.file
}

/** A shared file's bytes, through the generic files route as the link (presigned for 60 s, read once). */
export async function shareFileBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const { download } = await downloadLink(api, fileId)
  return readFromStore(download)
}
