/**
 * P5.1 — Unified Triage Inbox API.
 *
 * GET /api/inbox        — aggregated priority feed (sync failures, alert events,
 *                         unread notifications, webhook errors)
 * GET /api/inbox/count  — lightweight count for sidebar badge
 *
 * MCP full control P3: the reads live in services/inbox/triage-inbox.service.ts.
 */

import type { FastifyPluginAsync } from 'fastify'
import { countTriageInbox, readTriageInbox } from '../services/inbox/triage-inbox.service.js'

export type { InboxItem } from '../services/inbox/triage-inbox.service.js'

// ── Route plugin ──────────────────────────────────────────────────────────────

const inboxRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /api/inbox ──────────────────────────────────────────────────────────

  fastify.get('/inbox', async (request) => {
    const q = request.query as {
      source?: string
      severity?: string
      limit?: string
      offset?: string
    }
    const sourceFilter = q.source && q.source !== 'all' ? q.source : null
    const severityFilter = q.severity ?? null
    const limit = Math.min(parseInt(q.limit ?? '100', 10), 200)
    const offset = parseInt(q.offset ?? '0', 10)

    return readTriageInbox({ sourceFilter, severityFilter, limit, offset })
  })

  // ── GET /api/inbox/count ────────────────────────────────────────────────────

  fastify.get('/inbox/count', async () => {
    return countTriageInbox()
  })
}

export default inboxRoutes
