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
  /**
   * S2R — the "What needs a look" band.
   *
   * Its headline turns on ONE fact: did the newest run in scope fail? On
   * production nothing has failed since 6 August and 12 runs have run clean
   * since, so the band is permanently in its `settled` state and its three
   * failing states are unreachable. Rather than reason about them, this
   * back-dates nothing and forward-dates one existing failure so it becomes the
   * newest run — a rearrangement of rows already in the response, in memory,
   * on their way out of this process.
   *
   *   STUB_BAND=fail-severe  the contract break becomes the newest run
   *   STUB_BAND=fail-limit   the token-limit halt becomes the newest run, and
   *                          the severe ones are dropped, so the panel must go
   *                          amber and blame nobody
   *   STUB_BAND=fail-test    the newest run is a FAILING TEST RUN — the case
   *                          that has never once occurred (0 of 26) and is
   *                          therefore exactly the rule most likely to rot
   *   STUB_BAND=err          the band's own read fails while the rest of the
   *                          page keeps working, so "could not check" can be
   *                          told apart from "nothing is wrong"
   */
  band: process.env.STUB_BAND ?? '',
  /**
   * S3R Phase 0 — make the data MOVE, so the facet chips and the scope line can
   * be watched over successive polls.
   *
   * `STUB_DRIFT=1` hides the newest event during odd 15-second windows, so the
   * stream alternates between N and N−1 events: one direction exercises the
   * adopt path, the other makes an id reappear at the head and exercises the
   * hold path behind the "N new events" button.
   *
   * The window is derived from the CLOCK rather than a request counter on
   * purpose — the page issues three or four reads per tick, and a counter would
   * hand them different worlds, which is precisely the bug under test. Every
   * read inside one window sees the same history.
   */
  drift: process.env.STUB_DRIFT === '1',
  /**
   * S3R — two states the real data cannot reach.
   *
   *   STUB_FACETS=err   every `limit=1` read fails, which is how the facet
   *                     vocabulary and the whole-history total arrive. The
   *                     panel must SAY the options are missing rather than
   *                     offer empty dropdowns that look ready.
   *   STUB_ACTORS=25    pads the actor list to 25, the roster size W.8
   *                     instances are designed for. This is the state that
   *                     decides the whole design: a chip row cannot hold it,
   *                     a dropdown does not care.
   */
  facets: process.env.STUB_FACETS ?? '',
  actors: Number(process.env.STUB_ACTORS ?? 0),
}

const driftHidesNewest = () => SIM.drift && Math.floor(Date.now() / 15_000) % 2 === 1

/** The band asks for exactly this, and nothing else on the page does — so it is
 *  a safe discriminator for simulating the band alone. */
const BAND_KINDS = 'run.ok,run.failed,run.running'

interface Timelineish {
  events: Array<Record<string, unknown>>
  nextCursor: string | null
  total: number
  countsByKind: Record<string, number>
  actors: unknown[]
}

/**
 * Remove the newest event and keep every derived number consistent with it —
 * `total` and `countsByKind` included. A drift that moved the rows but not the
 * counts would be testing the harness, not the page.
 *
 * `limit=1` reads (the base-scope facets and the whole-history total) carry one
 * event but a full `total`/`countsByKind`, so the kind is taken from the counts
 * when the row itself is not in the page.
 */
function dropNewest(page: Timelineish): Timelineish {
  if (page.total <= 0) return page
  const newest = page.events[0]
  const kind = newest ? String(newest.kind) : null
  const counts = { ...page.countsByKind }
  if (kind && counts[kind]) counts[kind] = counts[kind]! - 1
  if (kind && counts[kind] === 0) delete counts[kind]
  return {
    ...page,
    events: page.events.slice(1),
    total: page.total - 1,
    countsByKind: counts,
  }
}

/** Synthesise a realistic roster: real workers first, then W.8-style instances
 *  with the long-ish names an operator would actually create. */
function padActors(real: unknown[]): unknown[] {
  const out = [...real]
  const suffixes = ['DE', 'FR', 'ES', 'IT', 'NL', 'PL', 'SE']
  for (let i = out.length; i < SIM.actors; i++) {
    const s = suffixes[i % suffixes.length]
    out.push({ key: `amazon-negative-miner-${s?.toLowerCase()}-${i}`, name: `Negative miner ${s} #${i}`, kind: 'worker' })
  }
  return out
}

function simulateBand(page: Timelineish): Timelineish {
  const mode = SIM.band
  if (!mode || mode === 'err') return page
  const events = page.events.map((e) => ({ ...e }))
  const isFail = (e: Record<string, unknown>) => e.kind === 'run.failed'
  // The token-limit halt is the only non-severe failure in the data; the
  // classifier decides that from `haltedReason`, so this picks by the same
  // field rather than by guessing at a class.
  const isLimit = (e: Record<string, unknown>) => isFail(e) && e.haltedReason != null

  let pick: Record<string, unknown> | undefined
  let kept = events
  if (mode === 'fail-limit') {
    kept = events.filter((e) => !isFail(e) || isLimit(e))
    pick = kept.find(isLimit)
  } else {
    pick = events.find((e) => isFail(e) && !isLimit(e))
    if (mode === 'fail-test' && pick) pick.mode = 'preview'
  }
  if (!pick) return { ...page, events: kept }

  pick.at = new Date().toISOString()
  const reordered = [pick, ...kept.filter((e) => e !== pick)]
  return { ...page, events: reordered, total: reordered.length }
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
    const isBandRead = q.get('kind') === BAND_KINDS
    if (isBandRead && SIM.band === 'err') {
      throw new Error('simulated: the band could not check')
    }
    const raw = q.get('includeSelfTest')
    const includeDiagnostic =
      raw === null ? undefined : !['0', 'false', 'no'].includes(raw.trim().toLowerCase())
    const page = (await getFleetTimeline(
      {
        q: q.get('q') ?? undefined,
        actors: q.get('actor')?.split(',').map((v) => v.trim()).filter(Boolean),
        kinds: (q.get('kind')?.split(',').filter(Boolean) as never) ?? undefined,
        includeDiagnostic,
      },
      { limit: Number(q.get('limit')) || 50, cursor: q.get('cursor') ?? undefined },
    )) as unknown as Timelineish
    const isFacetRead = q.get('limit') === '1'
    if (isFacetRead && SIM.facets === 'err') {
      throw new Error('simulated: the facet read failed')
    }
    const drifted = driftHidesNewest() ? dropNewest(page) : page
    const padded =
      isFacetRead && SIM.actors > 0 ? { ...drifted, actors: padActors(drifted.actors) } : drifted
    return isBandRead ? simulateBand(padded) : padded
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
