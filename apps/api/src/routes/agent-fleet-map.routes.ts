/**
 * NAF.SB.M.1a — the Fleet map's read route.
 *
 * Its own file, not `agent-fleet.routes.ts`, per the session-locks protocol:
 * that file is 771 lines and shared, a duplicate path there is a boot crash,
 * and a one-line conflict in `index.ts` merges where a 771-line one does not.
 *
 * RBAC: no permissions-manifest entry is needed. `permissions-manifest.ts:141`
 * already covers the whole `/api/agent/` prefix with `ai.view` / `ai.run`, so
 * the coverage gate in pre-push passes without touching a shared auth file.
 *
 * READ-ONLY BY DESIGN (operator decision D3, 2026-08-07). The map shows state
 * and links out; it never writes. That is also the cheapest possible answer to
 * the spend audit — three control paths bypass the autonomy dial and can spend
 * on a dark fleet, and a read-only surface inherits none of them.
 */
import type { FastifyPluginAsync } from 'fastify'
import { getFleetMap, parseWindow } from '../services/agent-fleet/fleet-map.service.js'

const agentFleetMapRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Everything the map draws, in one call: fleet state, the effective wiring
   * (union of enabled workflows) with job furniture overlaid, one row per
   * worker with the raw fields the shared status classifier reads, and one
   * row per edge with honestly-counted artifact volume.
   *
   * `window` is the denominator for every windowed number: 24h | 7d | 30d |
   * all. Anything unrecognised resolves to 7d rather than erroring — a bad
   * query string should not blank the operator's map.
   */
  fastify.get<{ Querystring: { window?: string } }>(
    '/agent/fleet/map',
    async (request) => {
      return getFleetMap(parseWindow(request.query.window))
    },
  )
}

export default agentFleetMapRoutes
