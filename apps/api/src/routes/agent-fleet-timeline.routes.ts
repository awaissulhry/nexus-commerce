/**
 * NAF.DT.1 — the decision-timeline endpoints.
 *
 * Deliberately a SEPARATE file from `agent-fleet.routes.ts`: the parallel
 * NAF.AC session is adding its Charter Studio routes to that one, and two
 * sessions editing one route file is how a boot-crashing duplicate route
 * gets merged in. Same `/api/agent/fleet/*` prefix, so the existing
 * permissions-manifest entry for `/api/agent/` (ai.view) already covers
 * these with no manifest change.
 *
 * Read-only. Every control that acts on the fleet lives in DT.6 and waits on
 * AC.6's endpoints — an unenforced control is not rendered.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  getFleetTimeline,
  type FleetEventKind,
  type FleetEventOutcome,
  type FleetTimelineFilters,
} from '../services/agent-fleet/fleet-timeline.service.js'

const KINDS: FleetEventKind[] = [
  'run.ok',
  'run.failed',
  'finding.raised',
  'plan.drafted',
  'plan.critiqued',
  'approval.requested',
  'approval.decided',
  'fleet.halted',
]
const OUTCOMES: FleetEventOutcome[] = ['ok', 'attention', 'bad', 'neutral']

/** `?kind=run.ok,run.failed` — unknown values are dropped, not 400'd. */
function csv<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s))
  return picked.length > 0 ? picked : undefined
}

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** `?range=7d` — the shorthand the UI's range chips use. */
function parseRange(raw: string | undefined): Date | undefined {
  if (!raw || raw === 'all') return undefined
  const m = /^(\d+)d$/.exec(raw)
  if (!m) return undefined
  return new Date(Date.now() - Number(m[1]) * 24 * 3600_000)
}

const agentFleetTimelineRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      range?: string
      from?: string
      to?: string
      actor?: string
      kind?: string
      outcome?: string
      q?: string
      limit?: string
      cursor?: string
    }
  }>('/agent/fleet/timeline', async (request) => {
    const q = request.query
    const filters: FleetTimelineFilters = {
      from: parseDate(q.from) ?? parseRange(q.range),
      to: parseDate(q.to),
      actor: q.actor?.trim() || undefined,
      kinds: csv(q.kind, KINDS),
      outcomes: csv(q.outcome, OUTCOMES),
      q: q.q?.trim() || undefined,
    }
    return getFleetTimeline(filters, {
      limit: Number(q.limit) || 50,
      cursor: q.cursor,
    })
  })
}

export default agentFleetTimelineRoutes
