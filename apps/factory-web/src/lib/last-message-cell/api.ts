import { z } from 'zod'
import type { ApiClient } from '../api/client'
import type { ReadUnread } from './use-unread'

// F-OP-213 (B-OP-061, 13-backend §8 A2): each record also says whether this reader may read its thread (`readable`: an unknown record and
// one out of the reader's reach both answer false — no difference to read); an answer without it (an older API) says nothing.
const answer = z.object({ counts: z.array(z.object({ recordType: z.string(), recordId: z.string(), newCount: z.number().int(), lastAt: z.string().nullable(), readable: z.boolean().optional() })) })

/**
 * B-TH-230: POST /threads/unread through the page's own client — the office's, or the portal's (the partner audience: its party's
 * shared messages only). A read in a POST: up to 200 records in the body; nothing written.
 * F-OP-213 (B-OP-061: the flag is opt-in): `readable` asks the API to say, per record, whether this reader may read its thread — only
 * the dock asks it, for the few records its pick offers; a list's cells never do (the check is an extra read per record).
 */
export const readUnreadWith =
  (api: ApiClient, options: { readonly readable?: boolean } = {}): ReadUnread =>
  (records, signal) =>
    api
      .post('/threads/unread', { body: { records: records.map((record) => ({ recordType: record.recordType, recordId: record.recordId })), ...(options.readable ? { readable: true } : {}) }, schema: answer, signal })
      .then((result) => result.counts)
