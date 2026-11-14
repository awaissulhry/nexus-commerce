import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { READ_LOG_RECORD_TYPES } from './model'

/**
 * Who looked (B-W2b-413 on B-W2b-399's API; PLT-074), administrators and the Owner only (audit.reads.view over every company):
 * one record's reads (`GET /audit/reads`), one person's reads only with a reason (`POST /audit/reads/person`: the reason is
 * written first as an audit row on the person), and whether the log is on (`GET /audit/reads/status`, GATE-PRIVACY). Rows,
 * never a count or a total per person.
 */

export const READ_ACTIONS = ['VIEW', 'DOWNLOAD', 'EXPORT'] as const
export const READ_SURFACES = ['OFFICE', 'API', 'SYSTEM'] as const

const recordRead = z.object({ id: z.string(), at: z.string(), action: z.enum(READ_ACTIONS), surface: z.enum(READ_SURFACES), reader: z.object({ id: z.string(), name: z.string().nullable() }) })
export type RecordRead = z.infer<typeof recordRead>
const personRead = z.object({ id: z.string(), at: z.string(), action: z.enum(READ_ACTIONS), surface: z.enum(READ_SURFACES), record: z.object({ type: z.enum(READ_LOG_RECORD_TYPES), id: z.string() }) })
export type PersonRead = z.infer<typeof personRead>

export const readLogStatus = (api: ApiClient) => api.get('/audit/reads/status', { schema: z.object({ on: z.boolean() }) }).then((answer) => answer.on)

export const recordReads = (api: ApiClient, record: { type: string; id: string }, before?: string | null) =>
  api.get('/audit/reads', { query: { recordType: record.type, recordId: record.id, before: before ?? undefined, limit: 50 }, schema: z.object({ reads: z.array(recordRead), nextBefore: z.string().nullable() }) })

export const personReads = (api: ApiClient, body: { userId: string; reason: string; before?: string | null }) =>
  api.post('/audit/reads/person', {
    body: { userId: body.userId, reason: body.reason, ...(body.before ? { before: body.before } : {}), limit: 50 },
    schema: z.object({ person: z.object({ id: z.string(), name: z.string() }), reads: z.array(personRead), nextBefore: z.string().nullable() }),
    idempotencyKey: newIdempotencyKey(),
  })
