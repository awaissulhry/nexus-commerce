/**
 * SOV-P verification stub — read-only, port 8095.
 *
 * Serves the SOV endpoints from the REAL services against prod data so the tab and the builder can
 * be driven in a browser. Writes are impossible here: the only POST it answers is the draft
 * preview, which runs `bid_apply` in dryRun. Everything else returns an honest empty shape so the
 * page renders without inventing data.
 *
 * Own file and own port on purpose — `_bp-verify-stub.mts` on :8099 belongs to another session.
 */
import '../src/env.js'
import http from 'node:http'
const { default: prisma } = await import('../src/db.js')
const { getSovStrip } = await import('../src/services/advertising/ads-sov-keyword-share.service.js')
const { previewSovRule } = await import('../src/services/advertising/ads-sov-preview.service.js')

const PORT = 8095
const json = (res: http.ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    // 🔴 without allow-methods every POST dies at preflight while GETs work
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  res.end(s)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const p = url.pathname.replace(/^\/api/, '')
  if (req.method === 'OPTIONS') return json(res, 204, {})
  try {
    if (p === '/advertising/sov/strip') return json(res, 200, await getSovStrip())
    if (p === '/advertising/automation-rules/preview' && req.method === 'POST') {
      const body = await new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)) })
      const out = await previewSovRule(JSON.parse(body || '{}'))
      return json(res, out.ok ? 200 : 400, out)
    }
    // the rules grid + tab badges: real reads, so the tab shows the account's true 0 SOV rules
    if (p === '/advertising/autonomy/rules') {
      const rules = await prisma.automationRule.findMany({
        where: { domain: 'advertising' },
        select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true, createdAt: true, scopeMarketplace: true, maxWritesPerDay: true, maxExecutionsPerDay: true, maxDailyAdSpendCentsEur: true },
      })
      return json(res, 200, { rules: rules.map((r) => ({ ...r, legacy: false })) })
    }
    if (p === '/advertising/campaigns') {
      const rows = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, adProduct: true, targetingType: true, dailyBudget: true, status: true, portfolioId: true }, take: 400 })
      return json(res, 200, { items: rows, campaigns: rows, rows, total: rows.length })
    }
    /**
     * Everything else — auth, permissions, page chrome — is PROXIED to the sibling rig on :8099
     * rather than answered with `{}`. Answering `{}` is what produced an "Access denied" page:
     * the RBAC check is an SSR fetch, and an empty body reads as "no permissions" rather than as
     * "not stubbed". A verification rig that silently denies the page it is meant to show is the
     * same class of defect this session is here to remove.
     */
    const upstream = `http://localhost:8099${url.pathname}${url.search}`
    try {
      const r = await fetch(upstream, {
        method: req.method,
        headers: { ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), 'content-type': 'application/json' },
      })
      const body = await r.text()
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
      return res.end(body)
    } catch {
      return json(res, 200, {})
    }
  } catch (e) {
    return json(res, 500, { error: String(e) })
  }
})
server.listen(PORT, () => console.log(`[sovp-stub] read-only on http://localhost:${PORT}`))
