/**
 * NAF.SB.ACT verification stub — READ-ONLY. Serves only the two endpoints
 * /fleet/activity reads, using the real services against the real database.
 *
 * Why not the real API: booting apps/api starts always-on crons against
 * production Neon. This process opens no cron, writes nothing, and exits when
 * killed. See memory reference_web_verify_without_local_api.
 */
import '../src/env.js'
import { createServer } from 'node:http'

const { getFleetTimeline } = await import('../src/services/agent-fleet/fleet-timeline.service.js')
const { getFleetState } = await import('../src/services/agent-fleet/fleet-state.service.js')

async function handle(url: URL): Promise<unknown> {
  const p = url.pathname
  const q = url.searchParams

  if (p.endsWith('/timeline')) {
    const raw = q.get('includeSelfTest')
    const includeDiagnostic =
      raw === null ? undefined : !['0', 'false', 'no'].includes(raw.trim().toLowerCase())
    return getFleetTimeline(
      {
        q: q.get('q') ?? undefined,
        actor: q.get('actor') ?? undefined,
        includeDiagnostic,
      },
      { limit: Number(q.get('limit')) || 50, cursor: q.get('cursor') ?? undefined },
    )
  }
  if (p.endsWith('/state')) return getFleetState()

  // The app shell's PageGuard reads /auth/me and renders "Access denied" for
  // an authed user without the page's permission. The stub is a local
  // rendering harness, not an auth test, so it answers as the owner. Nothing
  // here reaches production — this file is a `_`-prefixed script.
  if (p.endsWith('/auth/csrf')) return { csrfToken: 'sbact-local-stub' }
  if (p.endsWith('/auth/me')) {
    return {
      user: { id: 'sbact-local', email: 'local@verify', name: 'Local verification' },
      isOwner: true,
      permissions: ['ai.view'],
    }
  }

  return { error: `stub does not serve ${p}` }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  handle(url)
    .then((body) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      })
      res.end(JSON.stringify(body))
    })
    .catch((e: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    })
}).listen(8099, () => console.log('SB.ACT read-only stub on http://127.0.0.1:8099'))
