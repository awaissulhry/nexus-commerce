/**
 * KT-P — local verification rig for the Keyword Tracker tab + builder, port 8098.
 *
 * Same shape as `_bp-verify-stub.mts` (BUD-P's, on 8099 — deliberately a different port and a
 * different file, so two sessions can run their rigs at once and neither edits the other's).
 *
 * READS proxy the PROD API, so the campaign picker and the rules grid show real data. The TWO
 * ENDPOINTS KT-P adds are served here from the REAL service functions against the real database —
 * they are not deployed yet, so a proxy would 404 them and the surfaces under test would render
 * their failure state instead of their true one.
 *
 * Nothing writes. The preview runs `bid_apply` in dryRun, which returns before any mutation.
 *
 * Run:  cd apps/api && npx tsx scripts/_ktp-verify-stub.mts
 * Web:  cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:3001 NEXT_DEV_STUB_PROXY=http://localhost:8098 NEXT_DEV_ISOLATED=1 npm run dev -- -p 3001
 */
import '../src/env.js'
import { createServer } from 'node:http'

const { default: prisma } = await import('../src/db.js')

const PORT = Number(process.env.KTP_STUB_PORT ?? 8098)
const PROD = 'https://nexusapi-production-b7bb.up.railway.app'

const readBody = (req: import('node:http').IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
})

createServer(async (req, res) => {
  const origin = req.headers.origin ?? 'http://localhost:3001'
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('access-control-allow-private-network', 'true')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const [url, qs] = (req.url ?? '').split('?')
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const log = (line: string) => console.log(`[ktp-stub] ${line}`)

  try {
    // ── KT-P1: the rank feed's census, from the real service ────────────────
    if (url === '/api/advertising/keyword-tracker/feed-health' && req.method === 'GET') {
      const { keywordRankFeedHealth } = await import('../src/services/advertising/ads-rule-preview.service.js')
      const out = await keywordRankFeedHealth()
      log(`feed-health → rows=${out.rows} covered=${out.coveredTargets}/${out.totalTargets}`)
      return json(200, out)
    }
    // ── KT-P2: the draft preview, running the REAL engine in dryRun ─────────
    if (url === '/api/advertising/automation-rules/preview' && req.method === 'POST') {
      const body = await readBody(req)
      const slug = String((Array.isArray(body.actions) ? (body.actions[0] as { type?: unknown })?.type : '') ?? '')
      const svc = await import('../src/services/advertising/ads-rule-preview.service.js')
      /**
       * FIXTURE MODE (`?ktpFixture=1`) — rig only, never a code path the app can reach.
       *
       * The rank table, the Δ column, the per-row suppression tag and the census warning are all
       * code that CANNOT render against production today, because `KeywordRank` is empty and the
       * true answer is always "0 matched". Shipping rendering nobody has ever looked at is how
       * KT.6, KT.7 and KT.8 each shipped their worst defect. This serves one synthetic result in
       * the real result shape so those pixels can be read before they ship.
       */
      if (slug === 'keyword-tracker' && (qs ?? '').includes('ktpFixture=1')) {
        const feed = { rows: 412, keywords: 97, markets: 2, newestCapturedAt: new Date(Date.now() - 86_400_000).toISOString(), coveredTargets: 946, totalTargets: 2130 }
        const rows = [
          { targetId: 't1', keyword: 'motorradjacke herren sommer', campaignId: 'c1', marketplace: 'DE', organicRank: 74, sponsoredRank: 12, rankDelta: 9, currentEur: 0.5, proposedEur: 0.8, suppressed: null, campaignSuppressed: false },
          { targetId: 't2', keyword: 'giacca moto', campaignId: 'c2', marketplace: 'IT', organicRank: 88, sponsoredRank: null, rankDelta: -14, currentEur: 0.02, proposedEur: 0.8, suppressed: 'bid', campaignSuppressed: false },
          { targetId: 't3', keyword: 'bikerjacke herren', campaignId: 'c2', marketplace: 'IT', organicRank: 61, sponsoredRank: 4, rankDelta: null, currentEur: 0.03, proposedEur: 0.8, suppressed: 'flag', campaignSuppressed: true },
          { targetId: 't4', keyword: 'blouson moto homme homologué', campaignId: 'c3', marketplace: 'FR', organicRank: 55, sponsoredRank: null, rankDelta: 0, currentEur: 0.45, proposedEur: 0.8, suppressed: null, campaignSuppressed: false },
        ]
        return json(200, { ok: true, windowDays: 30, selected: 70, measurable: 946, inScope: 946, matched: 4, noChange: 1, rows, suppressedMatched: 2, suppressedUnflaggedMatched: 1, campaignSuppressedMatched: 1, feed, readAt: new Date().toISOString() })
      }
      if (slug === 'keyword-tracker') {
        const out = await svc.previewKeywordTrackerRule(body)
        log(`preview kt → selected=${out.selected} measurable=${out.measurable} inScope=${out.inScope} matched=${out.matched} rows=${out.rows.length} feedRows=${out.feed.rows}`)
        return json(out.ok ? 200 : 400, out)
      }
      const out = await svc.previewBudgetRule(body)
      return json(out.ok ? 200 : 400, out)
    }
    // The rules grid — real rules, prod-shaped (the live route is RBAC-gated and the session
    // cookie does not cross from localhost to Railway, so a proxy returns nothing).
    if (url === '/api/advertising/automation-rules' && req.method === 'GET') {
      const items = await prisma.automationRule.findMany({
        where: { domain: 'advertising' },
        orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
      })
      return json(200, { items, rules: items, count: items.length })
    }
    /**
     * The campaign picker. Prod's `/advertising/campaigns` is RBAC-gated (`ads.view`) and the
     * session cookie does not cross from localhost to Railway, so the proxy returns
     * `{"error":"Access denied"}` and the picker renders "No campaigns match" — a rig artifact that
     * looks exactly like a product defect. Served from the database in the route's own shape.
     */
    if (url === '/api/advertising/campaigns' && req.method === 'GET') {
      const rows = await prisma.campaign.findMany({
        select: { id: true, name: true, status: true, marketplace: true, targetingType: true, type: true, portfolioId: true, dailyBudget: true },
        orderBy: { name: 'asc' },
        take: 500,
      })
      const items = rows.map((c) => ({
        ...c,
        adProduct: c.type === 'SPONSORED_BRANDS' ? 'SB' : c.type === 'SPONSORED_DISPLAY' ? 'SD' : 'SP',
        dailyBudget: c.dailyBudget != null ? String(c.dailyBudget) : null,
      }))
      return json(200, { items, count: items.length })
    }
    if (url === '/api/advertising/portfolios' && req.method === 'GET') {
      const items = await prisma.adPortfolio.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }).catch(() => [])
      return json(200, { items, count: items.length })
    }
    if (url === '/api/advertising/suggestions/count' && req.method === 'GET') {
      return json(200, { pending: await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } }) })
    }
    // ── everything else: proxy prod, read-only ──────────────────────────────
    if (req.method === 'GET') {
      const r = await fetch(`${PROD}${url}${qs ? `?${qs}` : ''}`)
      const body = await r.text()
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' })
      res.end(body)
      return
    }
    log(`UNHANDLED ${req.method} ${url}`)
    return json(200, { ok: true, simulated: true })
  } catch (e) {
    log(`ERROR ${req.method} ${url}: ${String(e)}`)
    return json(500, { error: String(e) })
  }
}).listen(PORT, () => console.log(`[ktp-stub] listening on :${PORT} — reads proxy ${PROD}; feed-health + preview served from the real services; NOTHING writes`))
