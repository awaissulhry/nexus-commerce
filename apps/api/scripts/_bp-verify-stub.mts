/**
 * BP — local verification stub for the Bid page + builder (P1–P6), port 8099.
 *
 * READS are proxied verbatim to the PROD API (campaigns, portfolios, scope-options, targets…),
 * so the picker and previews show real data. RULE WRITES are simulated in an in-memory store —
 * nothing touches the database — but they run through the REAL policy code (`producedActionTypes`
 * + `graduationCeiling` + `isLevelAllowed`), so the op-aware ceiling, the 409 shape and the
 * arming flow are verified against the same functions prod will run.
 *
 * Run:  cd apps/api && npx tsx scripts/_bp-verify-stub.mts
 * Web:  cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:8099 NEXT_DEV_ISOLATED=1 npm run dev
 */
import '../src/env.js'
import { createServer } from 'node:http'
import { producedActionTypes } from '../src/services/advertising/ads-rule-adapter.service.js'
import { graduationCeiling, isLevelAllowed, type AutonomyLevel } from '../src/services/advertising/ads-graduation.js'

const { default: prisma } = await import('../src/db.js')

const PORT = 8099
const PROD = 'https://nexusapi-production-b7bb.up.railway.app'

interface MemRule extends Record<string, unknown> { id: string }
const mem = new Map<string, MemRule>()
const templates: Array<{ id: string; name: string; type: string; payload: unknown }> = []
let seq = 1

const readBody = (req: import('node:http').IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
})

createServer(async (req, res) => {
  const origin = req.headers.origin ?? 'http://localhost:3000'
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('access-control-allow-private-network', 'true')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const [url, qs] = (req.url ?? '').split('?')
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const log = (line: string) => console.log(`[bp-stub] ${line}`)

  try {
    // ── simulated rule store ─────────────────────────────────────────────────
    if (url === '/api/advertising/automation-rules' && req.method === 'GET') {
      return json(200, { rules: [...mem.values()] })
    }
    if (url === '/api/advertising/automation-rules' && req.method === 'POST') {
      const b = await readBody(req)
      const id = `mem-${seq++}`
      const rule: MemRule = {
        id, name: b.name, description: b.description ?? null, domain: 'advertising',
        trigger: b.trigger, conditions: b.conditions ?? [], actions: b.actions ?? [],
        enabled: false, dryRun: true, autonomyLevel: 'PROPOSE',
        maxExecutionsPerDay: b.maxExecutionsPerDay ?? 10,
        maxDailyAdSpendCentsEur: b.maxDailyAdSpendCentsEur ?? 10000,
        maxWritesPerDay: b.maxWritesPerDay ?? null,
        scopeMarketplace: b.scopeMarketplace ?? null,
        createdAt: new Date().toISOString(),
      }
      mem.set(id, rule)
      log(`CREATE ${id} "${rule.name}" → enabled:false PROPOSE (server defaults) execs/day=${rule.maxExecutionsPerDay} spend=€${Number(rule.maxDailyAdSpendCentsEur) / 100}/day`)
      return json(200, { rule })
    }
    const idMatch = url.match(/^\/api\/advertising\/automation-rules\/([^/]+)$/)
    if (idMatch && req.method === 'GET') {
      const rule = mem.get(idMatch[1])
      return rule ? json(200, { rule, builderView: null }) : json(404, { error: 'not_found' })
    }
    if (idMatch && req.method === 'PATCH') {
      const rule = mem.get(idMatch[1])
      if (!rule) return json(404, { error: 'not_found' })
      const b = await readBody(req)
      Object.assign(rule, b)
      log(`PATCH ${rule.id} fields=[${Object.keys(b).join(', ')}]`)
      return json(200, { rule })
    }
    if (idMatch && req.method === 'DELETE') {
      mem.delete(idMatch[1]); log(`DELETE ${idMatch[1]}`)
      return json(200, { ok: true })
    }
    if (url === '/api/advertising/automation-rules/activity') {
      return json(200, { items: Object.fromEntries([...mem.keys()].map((id) => [id, { pending: 0, lastWroteAt: null, writes7d: 0 }])) })
    }
    // ── autonomy: the REAL policy functions decide ───────────────────────────
    if (url === '/api/advertising/autonomy/rules' && req.method === 'GET') {
      const items = [...mem.values()].map((r) => {
        const ceiling = graduationCeiling({ actionTypes: producedActionTypes(r), hasKeywordProtections: true })
        return { id: r.id, name: r.name, ceiling: ceiling.maxLevel, ceilingReason: ceiling.reason, blockedBy: ceiling.blockedBy }
      })
      return json(200, { items })
    }
    const lvlMatch = url.match(/^\/api\/advertising\/autonomy\/rules\/([^/]+)$/)
    if (lvlMatch && req.method === 'PATCH') {
      const rule = mem.get(lvlMatch[1])
      if (!rule) return json(404, { ok: false, error: 'not_found' })
      const { level } = await readBody(req) as { level?: string }
      const ceiling = graduationCeiling({ actionTypes: producedActionTypes(rule), hasKeywordProtections: true })
      if (!isLevelAllowed(level as AutonomyLevel, ceiling.maxLevel)) {
        log(`LEVEL ${rule.id} → ${level} REFUSED 409 (ceiling ${ceiling.maxLevel}: produced=[${producedActionTypes(rule).join(',')}])`)
        return json(409, { ok: false, error: 'above_ceiling', maxLevel: ceiling.maxLevel, message: ceiling.reason, blockedBy: ceiling.blockedBy })
      }
      rule.autonomyLevel = level
      rule.enabled = level !== 'OFF'
      rule.dryRun = level !== 'AUTO'
      log(`LEVEL ${rule.id} → ${level} (enabled:${rule.enabled} dryRun:${rule.dryRun}) produced=[${producedActionTypes(rule).join(',')}]`)
      return json(200, { ok: true, rule: { id: rule.id, name: rule.name, autonomyLevel: rule.autonomyLevel, enabled: rule.enabled, dryRun: rule.dryRun } })
    }
    // ── templates: in-memory so Save/Apply round-trips ───────────────────────
    if (url === '/api/advertising/rule-templates' && req.method === 'GET') return json(200, { items: templates })
    if (url === '/api/advertising/rule-templates' && req.method === 'POST') {
      const b = await readBody(req)
      const t = { id: `tmpl-${seq++}`, name: String(b.name), type: String(b.type), payload: b.payload }
      templates.unshift(t); log(`TEMPLATE saved "${t.name}"`)
      return json(200, { template: t })
    }
    // ── prod READS via Neon directly (the prod API is RBAC-walled to a browser on localhost;
    //    the W1 stub proved the direct-Prisma pattern) ─────────────────────────
    if (url === '/api/advertising/campaigns' && req.method === 'GET') {
      const rows = await prisma.campaign.findMany({
        select: { id: true, name: true, marketplace: true, status: true, type: true, dailyBudget: true, portfolioId: true },
        orderBy: { name: 'asc' },
      })
      return json(200, { items: rows.map((c) => ({ ...c, dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null })) })
    }
    if (url === '/api/advertising/portfolios' && req.method === 'GET') {
      const rows = await prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true }, orderBy: { name: 'asc' } })
      return json(200, { portfolios: rows.map((p) => ({ portfolioId: p.externalPortfolioId, name: p.name })) })
    }
    if (url === '/api/advertising/scope-options' && req.method === 'GET') {
      // Flat product lines (no parent grouping — the Products tab's grouping fidelity was
      // prod-verified in Phase 0; here it only needs rows to click).
      const ads = await prisma.adProductAd.findMany({
        where: { productId: { not: null } },
        select: { productId: true, adGroup: { select: { campaignId: true } } },
      })
      const byProduct = new Map<string, Set<string>>()
      for (const a of ads) {
        if (!a.productId || !a.adGroup?.campaignId) continue
        const s = byProduct.get(a.productId) ?? new Set<string>()
        s.add(a.adGroup.campaignId); byProduct.set(a.productId, s)
      }
      const products = await prisma.product.findMany({ where: { id: { in: [...byProduct.keys()] } }, select: { id: true, sku: true, name: true } })
      return json(200, { productLines: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, variations: 1, campaigns: [...(byProduct.get(p.id) ?? [])] })) })
    }
    if (url === '/api/advertising/targets' && req.method === 'GET') {
      const rows = await prisma.adTarget.findMany({
        where: { status: 'ENABLED', isNegative: false },
        select: { id: true, text: true, matchType: true, kind: true, bidCents: true, marketplace: true, adGroup: { select: { campaignId: true } } },
        take: 1500,
      })
      return json(200, { rows: rows.map((t) => ({ ...t, campaignId: t.adGroup?.campaignId ?? null })) })
    }
    // ── HP (harvest) reads ───────────────────────────────────────────────────
    if (url === '/api/advertising/ad-groups' && req.method === 'GET') {
      const rows = await prisma.adGroup.findMany({
        select: { id: true, name: true, status: true, campaignId: true, campaign: { select: { name: true, status: true, adProduct: true, portfolioId: true } } },
        orderBy: { name: 'asc' }, take: 3000,
      })
      return json(200, { items: rows.map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, campaignName: g.campaign?.name ?? null, status: g.status, campaignStatus: g.campaign?.status ?? null, adProduct: g.campaign?.adProduct ?? null, portfolioId: g.campaign?.portfolioId ?? null })) })
    }
    if (url === '/api/advertising/harvest-pathways' && req.method === 'GET') {
      const { listHarvestPathways } = await import('../src/services/advertising/harvest-pathways.service.js')
      return json(200, await listHarvestPathways())
    }
    if (url === '/api/advertising/harvest-cohort' && req.method === 'GET') {
      const { getHarvestCohort } = await import('../src/services/advertising/harvest-cohort.service.js')
      return json(200, await getHarvestCohort({ market: 'all', outcome: null, actor: null, since: null, q: null } as never))
    }
    if (url === '/api/advertising/suggestions/count' && req.method === 'GET') {
      return json(200, { pending: await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } }) })
    }
    // ── everything else: proxy prod, read-only ───────────────────────────────
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
}).listen(PORT, () => console.log(`[bp-stub] listening on :${PORT} — reads proxy ${PROD}, rule writes simulated in-memory`))
