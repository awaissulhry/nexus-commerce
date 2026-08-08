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
const { listCharters } = await import('../src/services/agent-fleet/charter-registry.js')

/**
 * S1R — state simulation, so the three header states that real data cannot
 * produce are still verified in a browser rather than reasoned about.
 *
 * `STUB_HALT=1` a halted fleet · `STUB_FAIL=1` a failing read (the "Can't read"
 * instrument and the last-good-read banner) · `STUB_EMPTY=1` zero events
 * anywhere · `STUB_EMPTY=selftest` zero events in the default scope while the
 * whole history is still non-empty.
 *
 * All are READ-ONLY fictions in this process. Nothing is written, no charter is
 * enabled, and production is untouched — which matters, because the only other
 * way to see a halted fleet is to halt the real one.
 */
const SIM = {
  halt: process.env.STUB_HALT === '1',
  fail: process.env.STUB_FAIL === '1',
  empty: process.env.STUB_EMPTY ?? '',
}

async function handle(url: URL): Promise<unknown> {
  const p = url.pathname
  const q = url.searchParams

  if (SIM.fail && p.endsWith('/timeline')) throw new Error('simulated: timeline unavailable')

  if (p.endsWith('/timeline') && SIM.empty) {
    // `STUB_EMPTY=1` empties everything — "nothing on record yet".
    // `STUB_EMPTY=selftest` empties only the reads that hide the self-test, so
    // the header still knows the whole history is non-empty. That is the branch
    // that says "all N events on record came from the self-test", and it is
    // otherwise unreachable: production has 33 business events, so the real
    // data can never produce it.
    const hidesSelfTest = ['0', 'false', 'no'].includes(
      (q.get('includeSelfTest') ?? '').trim().toLowerCase(),
    )
    if (SIM.empty === '1' || hidesSelfTest) {
      return { events: [], nextCursor: null, total: 0, countsByKind: {}, actors: [] }
    }
  }

  if (p.endsWith('/charters')) return { charters: await listCharters() }

  if (p.endsWith('/timeline')) {
    const raw = q.get('includeSelfTest')
    const includeDiagnostic =
      raw === null ? undefined : !['0', 'false', 'no'].includes(raw.trim().toLowerCase())
    return getFleetTimeline(
      {
        q: q.get('q') ?? undefined,
        actors: q.get('actor')?.split(',').map((v) => v.trim()).filter(Boolean),
        kinds: (q.get('kind')?.split(',').filter(Boolean) as never) ?? undefined,
        includeDiagnostic,
      },
      { limit: Number(q.get('limit')) || 50, cursor: q.get('cursor') ?? undefined },
    )
  }
  if (p.endsWith('/state')) {
    const real = await getFleetState()
    return SIM.halt
      ? {
          ...real,
          halted: true,
          haltReason: 'Spend ceiling reached while a bid change was mid-flight.',
          haltedBy: 'awaissulhry@gmail.com',
          haltedAt: new Date(Date.now() - 47 * 60_000).toISOString(),
        }
      : real
  }

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

/**
 * CORS, and why it is more than one header.
 *
 * The browser is on http://localhost:3010 and this is http://localhost:8099, so
 * every read is cross-origin. A bare `access-control-allow-origin: *` was not
 * enough in Chrome: it also gates requests that reach a private/loopback
 * address behind Private Network Access, which wants the ORIGIN echoed back
 * (not a wildcard), an explicit allow header, and a real answer to the OPTIONS
 * preflight. Without them every read fails with a bare "TypeError: Failed to
 * fetch" and the page renders its can't-read state perfectly while the server
 * is healthy on curl.
 */
function cors(req: { headers: Record<string, string | string[] | undefined> }) {
  const origin = (req.headers.origin as string | undefined) ?? '*'
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-csrf-token',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

createServer((req, res) => {
  const headers = cors(req)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  handle(url)
    .then((body) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    })
    .catch((e: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    })
}).listen(8099, () => console.log('SB.ACT read-only stub on http://localhost:8099'))
