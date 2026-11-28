import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * owb-po5.4 — the Chat panel's list: every conversation the person may read (`GET /portal/threads`, the partner read: its party's
 * shared messages only), by its last message, with the messages new to this person (the server's unread rule: a quiet line is never
 * counted, owb-po2.3). Parsed with the frame's own schema: only what the panel draws.
 */
const chatSchema = z.object({
  record: z.object({ type: z.string(), id: z.string(), theirRef: z.string().nullable(), ourRef: z.string().nullable(), subtitle: z.string().nullable() }),
  last: z.object({ authorName: z.string().nullable(), excerpt: z.string(), at: z.string() }).nullable().catch(null),
  newCount: z.number().default(0),
})
export type ChatRead = z.infer<typeof chatSchema>

/** The most the panel lists (the newest by their last message). */
export const CHATS_READ = 30

export const fetchChats = (api: ApiClient, signal?: AbortSignal): Promise<{ conversations: ChatRead[] }> =>
  api.get('/portal/threads', { query: { from: 'any', limit: CHATS_READ }, schema: z.object({ conversations: z.array(chatSchema) }), signal })
