import { z } from 'zod'
import type { ApiClient } from '../api/client'
import type { ReadUnread } from './use-unread'

const answer = z.object({ counts: z.array(z.object({ recordType: z.string(), recordId: z.string(), newCount: z.number().int(), lastAt: z.string().nullable() })) })

/**
 * B-TH-230: POST /threads/unread through the page's own client — the office's, or the portal's (the partner audience: its party's
 * shared messages only). A read in a POST: up to 200 records in the body; nothing written.
 */
export const readUnreadWith =
  (api: ApiClient): ReadUnread =>
  (records, signal) =>
    api.post('/threads/unread', { body: { records: records.map((record) => ({ recordType: record.recordType, recordId: record.recordId })) }, schema: answer, signal }).then((result) => result.counts)
