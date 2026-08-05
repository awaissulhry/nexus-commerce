/**
 * READ-ONLY Amazon stack entitlement audit.
 *
 * Answers one question per Amazon product: does THIS account's token actually
 * get in? Probes live endpoints and classifies the response:
 *   200/201        → ENTITLED
 *   400/422        → ENTITLED (auth passed, our probe body was deliberately bad)
 *   401/403        → BLOCKED  (token/role/gateway refuses us)
 *   404            → NOT PROVISIONED / wrong shape
 *
 * No writes. Report-create probes use deliberately invalid bodies so nothing
 * is actually queued. ~40 requests, sequential, 200 ms apart.
 */

const prisma = (await import('../src/db.js')).default
const { decryptSecret } = await import('../src/lib/crypto.js')

const L = (s = '') => console.log(s)
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))

// ── classification ───────────────────────────────────────────────────
type Verdict = 'ENTITLED' | 'BLOCKED' | 'ABSENT' | 'UNKNOWN'
function classify(status: number): Verdict {
  if (status >= 200 && status < 300) return 'ENTITLED'
  if (status === 400 || status === 422) return 'ENTITLED' // auth passed, body rejected
  if (status === 401 || status === 403) return 'BLOCKED'
  if (status === 404) return 'ABSENT'
  return 'UNKNOWN'
}
const ICON: Record<Verdict, string> = { ENTITLED: '✅', BLOCKED: '⛔', ABSENT: '❔', UNKNOWN: '⚠️ ' }

interface Row { product: string; probe: string; status: number; verdict: Verdict; detail: string }
const rows: Row[] = []

// ── Ads connection + LWA token ───────────────────────────────────────
const REGION_ENDPOINT: Record<string, string> = {
  EU: 'https://advertising-api-eu.amazon.com',
  NA: 'https://advertising-api.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
}

const conn = await prisma.amazonAdsConnection.findFirst({
  where: { isActive: true },
  select: { profileId: true, marketplace: true, region: true, credentialsEncrypted: true, mode: true },
})

const region = conn?.region ?? 'EU'
const BASE = REGION_ENDPOINT[region] ?? REGION_ENDPOINT.EU

L('══ ACCOUNT ═══════════════════════════════════════════════════════════')
L(`profileId=${conn?.profileId}  marketplace=${conn?.marketplace}  region=${region}  mode=${conn?.mode}`)
L(`ads endpoint: ${BASE}`)

// Ads credentials live encrypted in the DB under the deployment's own key.
// If this runner doesn't hold that key, skip the Ads half rather than fail —
// the SP-API half below uses env credentials and still runs.
let TOKEN: string | null = null
let creds: { clientId: string; clientSecret: string; refreshToken: string } | null = null
if (!conn?.credentialsEncrypted) {
  L('⚠️  no active AmazonAdsConnection with credentials — Ads probes skipped')
} else {
  try {
    creds = JSON.parse(decryptSecret(conn.credentialsEncrypted))
  } catch (e) {
    L(`⚠️  cannot decrypt ads credentials with this runner's NEXUS_CREDENTIAL_ENC_KEY — Ads probes skipped`)
    L(`    (${e instanceof Error ? e.message : String(e)}) — run this on the deployment that holds the key`)
  }
}
if (creds) {
  const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret }).toString(),
  })
  const tokenJson = await tokenRes.json() as { access_token?: string; scope?: string }
  if (!tokenJson.access_token) L(`⛔ LWA token failed: ${JSON.stringify(tokenJson).slice(0, 200)}`)
  else { TOKEN = tokenJson.access_token; L(`LWA token OK · granted scopes: ${tokenJson.scope ?? '(none returned)'}`) }
}

// ── Ads probe runner ─────────────────────────────────────────────────
interface AdsProbe {
  product: string; probe: string
  method: 'GET' | 'POST' | 'PUT'
  path: string
  body?: unknown
  mime?: string
  noScope?: boolean
  extraHeaders?: Record<string, string>
}

async function runAds(p: AdsProbe): Promise<void> {
  if (!TOKEN || !creds) return
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Amazon-Advertising-API-ClientId': creds.clientId,
    ...(p.extraHeaders ?? {}),
  }
  if (!p.noScope) headers['Amazon-Advertising-API-Scope'] = conn!.profileId
  if (p.mime) { headers.Accept = p.mime; if (p.body !== undefined) headers['Content-Type'] = p.mime }
  else if (p.body !== undefined) headers['Content-Type'] = 'application/json'

  let status = 0, detail = ''
  try {
    const res = await fetch(`${BASE}${p.path}`, { method: p.method, headers, body: p.body !== undefined ? JSON.stringify(p.body) : undefined })
    status = res.status
    detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 160)
  } catch (e) { detail = `[network] ${e instanceof Error ? e.message : String(e)}` }
  rows.push({ product: p.product, probe: p.probe, status, verdict: classify(status), detail })
  await new Promise((r) => setTimeout(r, 200))
}

// ── The probe matrix ─────────────────────────────────────────────────
const ADS_PROBES: AdsProbe[] = [
  // Identity / account structure
  { product: 'Ads: profiles', probe: 'GET /v2/profiles', method: 'GET', path: '/v2/profiles', noScope: true },
  { product: 'Ads: accounts (Manager)', probe: 'POST /adsAccounts/list', method: 'POST', path: '/adsAccounts/list', mime: 'application/vnd.listaccountsresource.v1+json', body: { maxResults: 5 }, noScope: true },
  { product: 'Ads: manager accounts', probe: 'GET /managerAccounts', method: 'GET', path: '/managerAccounts', noScope: true },

  // Ads API v3 — campaign management (SP / SB / SD)
  { product: 'Ads API v3 (SP)', probe: 'POST /sp/campaigns/list', method: 'POST', path: '/sp/campaigns/list', mime: 'application/vnd.spCampaign.v3+json', body: { maxResults: 1 } },
  { product: 'Ads API v3 (SP)', probe: 'POST /sp/adGroups/list', method: 'POST', path: '/sp/adGroups/list', mime: 'application/vnd.spAdGroup.v3+json', body: { maxResults: 1 } },
  { product: 'Ads API v3 (SP)', probe: 'POST /sp/targets/list', method: 'POST', path: '/sp/targets/list', mime: 'application/vnd.spTargetingClause.v3+json', body: { maxResults: 1 } },
  { product: 'Ads API v4 (SB)', probe: 'POST /sb/v4/campaigns/list', method: 'POST', path: '/sb/v4/campaigns/list', mime: 'application/vnd.sbcampaignresource.v4+json', body: { maxResults: 1 } },
  { product: 'Ads API v3 (SD)', probe: 'GET /sd/campaigns', method: 'GET', path: '/sd/campaigns' },
  { product: 'Ads API (Sponsored TV)', probe: 'POST /st/campaigns/list', method: 'POST', path: '/st/campaigns/list', mime: 'application/vnd.stcampaign.v1+json', body: { maxResults: 1 } },
  { product: 'Ads: portfolios v3', probe: 'POST /portfolios/list', method: 'POST', path: '/portfolios/list', mime: 'application/vnd.spPortfolio.v3+json', body: {} },

  // Exports API v1
  { product: 'Exports API v1', probe: 'POST /campaigns/export', method: 'POST', path: '/campaigns/export', mime: 'application/vnd.campaignsexport.v1+json', body: { adProductFilter: ['SPONSORED_PRODUCTS'] } },
  { product: 'Exports API v1', probe: 'POST /adGroups/export', method: 'POST', path: '/adGroups/export', mime: 'application/vnd.adgroupsexport.v1+json', body: { adProductFilter: ['SPONSORED_PRODUCTS'] } },
  { product: 'Exports API v1', probe: 'POST /targets/export', method: 'POST', path: '/targets/export', mime: 'application/vnd.targetsexport.v1+json', body: { adProductFilter: ['SPONSORED_PRODUCTS'] } },
  { product: 'Exports API v1', probe: 'POST /ads/export', method: 'POST', path: '/ads/export', mime: 'application/vnd.adsexport.v1+json', body: { adProductFilter: ['SPONSORED_PRODUCTS'] } },

  // Reporting v3 — deliberately incomplete body: 400 = entitled, 403 = blocked
  { product: 'Ads Reporting v3', probe: 'POST /reporting/reports (bad body)', method: 'POST', path: '/reporting/reports', mime: 'application/vnd.createasyncreportrequest.v3+json', body: {} },

  // Amazon Marketing Stream
  { product: 'Marketing Stream', probe: 'GET /streams/subscriptions', method: 'GET', path: '/streams/subscriptions' },
  { product: 'Marketing Stream', probe: 'GET /streams/datasets', method: 'GET', path: '/streams/datasets' },

  // Amazon Marketing Cloud
  { product: 'AMC', probe: 'GET /amc/instances', method: 'GET', path: '/amc/instances', noScope: true },
  { product: 'AMC', probe: 'GET /amc/instances (scoped)', method: 'GET', path: '/amc/instances' },
  { product: 'AMC', probe: 'GET /amc/accounts', method: 'GET', path: '/amc/accounts', noScope: true },
  { product: 'AMC', probe: 'GET /amc/advertisers', method: 'GET', path: '/amc/advertisers', noScope: true },
  { product: 'AMC (audiences)', probe: 'POST /amc/audiences/metadata', method: 'POST', path: '/amc/audiences/metadata', body: {} },

  // Amazon DSP
  { product: 'DSP', probe: 'GET /dsp/advertisers', method: 'GET', path: '/dsp/advertisers' },
  { product: 'DSP', probe: 'GET /dsp/v1/accounts', method: 'GET', path: '/dsp/v1/accounts' },

  // Brand / insight surfaces on the Ads API
  { product: 'Brand Metrics', probe: 'POST /insights/brandMetrics/report', method: 'POST', path: '/insights/brandMetrics/report', mime: 'application/vnd.brandmetricsreport.v1+json', body: {} },
  { product: 'Amazon Attribution', probe: 'GET /attribution/publishers', method: 'GET', path: '/attribution/publishers' },
  { product: 'Stores analytics', probe: 'GET /stores', method: 'GET', path: '/stores' },

  // Optimisation surfaces
  { product: 'Keyword recommendations', probe: 'POST /sp/targets/keywords/recommendations', method: 'POST', path: '/sp/targets/keywords/recommendations', mime: 'application/vnd.spkeywordsrecommendation.v5+json', body: {} },
  { product: 'Bid recommendations', probe: 'POST /sp/targets/bid/recommendations', method: 'POST', path: '/sp/targets/bid/recommendations', mime: 'application/vnd.spthemebasedbidrecommendation.v4+json', body: {} },
  { product: 'Budget usage', probe: 'POST /sp/campaigns/budget/usage', method: 'POST', path: '/sp/campaigns/budget/usage', mime: 'application/vnd.spcampaignbudgetusage.v1+json', body: {} },
  { product: 'Budget rules', probe: 'GET /sp/budgetRules', method: 'GET', path: '/sp/budgetRules' },
  { product: 'Product eligibility', probe: 'POST /eligibility/product/list', method: 'POST', path: '/eligibility/product/list', body: {} },
  { product: 'Creative asset library', probe: 'POST /assets/search', method: 'POST', path: '/assets/search', mime: 'application/vnd.assetsearchrequest.v1+json', body: {} },
  { product: 'Audiences (DSP/AMC)', probe: 'POST /audiences/list', method: 'POST', path: '/audiences/list', mime: 'application/vnd.audiencesearchrequest.v1+json', body: { maxResults: 1 } },
  { product: 'Locations', probe: 'GET /locations', method: 'GET', path: '/locations' },
  { product: 'Ad Library / moderation', probe: 'GET /sp/productAds/extendedData', method: 'GET', path: '/sp/productAds/extendedData' },
]

L('')
L('══ PROBING AMAZON ADS API ════════════════════════════════════════════')
if (!TOKEN) L('  (skipped — no ads token on this runner)')
for (const p of ADS_PROBES) {
  const before = rows.length
  await runAds(p)
  if (rows.length === before) continue
  const r = rows[rows.length - 1]
  L(`  ${ICON[r.verdict]} ${pad(r.probe, 46)} ${String(r.status).padStart(3)}  ${r.detail.slice(0, 70)}`)
}

// ── SP-API probes (Data Kiosk, Brand Analytics, Reports) ─────────────
L('')
L('══ PROBING SP-API (Data Kiosk / Brand Analytics) ═════════════════════')

let spApiOk = true
let sp: any = null
try {
  const SellingPartner = (await import('amazon-sp-api')).default as any
  sp = new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as 'eu',
    refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
    },
    options: { auto_request_tokens: true, auto_request_throttled: false },
  })
} catch (e) { spApiOk = false; L(`  ⚠️  SP-API client init failed: ${e instanceof Error ? e.message : String(e)}`) }

async function runSpApi(product: string, probe: string, opts: Record<string, unknown>): Promise<void> {
  if (!spApiOk) return
  let status = 0, detail = '', verdict: Verdict = 'UNKNOWN'
  try {
    const res = await sp.callAPI(opts)
    status = 200; verdict = 'ENTITLED'
    detail = JSON.stringify(res).replace(/\s+/g, ' ').slice(0, 160)
  } catch (e: any) {
    const code = e?.code ?? e?.name ?? ''
    const msg = String(e?.message ?? e).replace(/\s+/g, ' ')
    const both = `${code} ${msg}`
    // A broken/expired refresh token fails BEFORE the entitlement check, so it
    // says nothing about access. Must be caught first — it also surfaces as a
    // 400, which would otherwise be misread as "auth passed, body rejected".
    if (/invalid_grant|invalid_client|unauthorized_client|token .*(expired|invalid)/i.test(both)) {
      status = 0; verdict = 'UNKNOWN'
      detail = `CREDENTIALS BROKEN (not an entitlement answer) · ${both}`.slice(0, 160)
    }
    else if (/Unauthorized|Forbidden|access to requested resource is denied|not authorized|403/i.test(both)) { status = 403; verdict = 'BLOCKED'; detail = both.slice(0, 160) }
    else if (/NotFound|404/i.test(both)) { status = 404; verdict = 'ABSENT'; detail = both.slice(0, 160) }
    else if (/InvalidInput|Invalid|400|Validation/i.test(both)) { status = 400; verdict = 'ENTITLED'; detail = both.slice(0, 160) }
    else detail = both.slice(0, 160)
  }
  rows.push({ product, probe, status, verdict, detail })
  L(`  ${ICON[verdict]} ${pad(probe, 46)} ${String(status).padStart(3)}  ${detail.slice(0, 70)}`)
  await new Promise((r) => setTimeout(r, 300))
}

// Data Kiosk — read-only list of queries. 403 = role not granted on the app.
await runSpApi('Data Kiosk', 'GET /dataKiosk/2023-11-15/queries', {
  api_path: '/dataKiosk/2023-11-15/queries', method: 'GET', query: { pageSize: 1 },
})
// Sellers — sanity that SP-API auth works at all
await runSpApi('SP-API sanity', 'GET /sellers/v1/marketplaceParticipations', {
  api_path: '/sellers/v1/marketplaceParticipations', method: 'GET',
})
// Reports API — can we even list reports (base entitlement)
await runSpApi('SP-API Reports', 'GET /reports/2021-06-30/reports', {
  api_path: '/reports/2021-06-30/reports', method: 'GET',
  query: { reportTypes: 'GET_MERCHANT_LISTINGS_ALL_DATA', pageSize: 1 },
})
// Brand Analytics — SQP report create with a deliberately bad window.
// 403/denied = role missing; anything else = the role is there.
await runSpApi('Brand Analytics (SQP)', 'POST /reports/2021-06-30/reports (SQP)', {
  api_path: '/reports/2021-06-30/reports', method: 'POST',
  body: {
    reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
    marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
    reportOptions: { reportPeriod: 'WEEK' },
  },
})
await runSpApi('Brand Analytics (Market Basket)', 'POST create GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT', {
  api_path: '/reports/2021-06-30/reports', method: 'POST',
  body: {
    reportType: 'GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT',
    marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
    reportOptions: { reportPeriod: 'WEEK' },
  },
})
await runSpApi('Sales & Traffic', 'POST create GET_SALES_AND_TRAFFIC_REPORT', {
  api_path: '/reports/2021-06-30/reports', method: 'POST',
  body: {
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    marketplaceIds: [process.env.AMAZON_MARKETPLACE_ID],
  },
})

// ── Evidence from our own DB: what has actually landed ───────────────
// This is the strongest available signal: rows only exist because a real
// Amazon call succeeded. Freshness tells us whether access still works.
L('')
L('══ DATA ACTUALLY LANDED (proof access works, and how recently) ═══════')
const p = prisma as any

async function evidence(product: string, model: string, dateField: string | null) {
  try {
    const n = await p[model].count()
    let fresh = ''
    if (n > 0 && dateField) {
      const r = await p[model].aggregate({ _max: { [dateField]: true } })
      const v = r._max[dateField]
      const iso = v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : String(v)
      const ageD = v instanceof Date ? Math.floor((Date.now() - v.getTime()) / 86400000) : null
      fresh = ` · newest ${iso}${ageD !== null ? ` (${ageD}d old)` : ''}`
    }
    L(`  ${n > 0 ? '✅' : '⛔'} ${pad(product, 40)} ${String(n).padStart(7)} rows${fresh}`)
  } catch (e) {
    L(`  ❔ ${pad(product, 40)} ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`)
  }
}

await evidence('Ads v3 mirror · Campaign', 'campaign', 'lastSyncedAt')
await evidence('Ads v3 mirror · AdTarget', 'adTarget', null)
await evidence('Ads portfolios v3', 'amazonAdsPortfolio', null)
await evidence('Reporting v3 · daily perf', 'amazonAdsDailyPerformance', 'date')
await evidence('Reporting v3 · search terms', 'amazonAdsSearchTerm', 'date')
await evidence('Reporting v3 · placement', 'amazonAdsPlacementReport', 'date')
await evidence('Reporting v3 · job queue', 'amazonAdsReportJob', 'createdAt')
await evidence('Marketing Stream · hourly perf', 'amazonAdsHourlyPerformance', 'date')
await evidence('Brand Metrics API', 'amazonAdsBrandMetric', 'date')
await evidence('Brand Analytics SQP (SP-API)', 'searchQueryPerformance', null)
await evidence('Exports API v1 · job queue', 'amazonAdsExportJob', 'createdAt')

// ── The definitive live map: every Amazon endpoint we have actually called ──
L('')
L('══ OUTBOUND CALL LOG — what Amazon actually answered ═════════════════')
try {
  const since = new Date(Date.now() - 90 * 86400000)
  const logs = await p.outboundApiCallLog.groupBy({
    by: ['operation', 'endpoint', 'statusCode'],
    where: { channel: 'AMAZON', createdAt: { gte: since } },
    _count: { _all: true },
    _max: { createdAt: true },
  })
  L(`  ${logs.length} distinct (operation, endpoint, status) combos in the last 90d\n`)
  // Group by endpoint, show status distribution — 403s are the entitlement story.
  const byEndpoint = new Map<string, { ok: number; denied: number; other: number; last: Date | null; statuses: Set<number> }>()
  for (const l of logs) {
    const key = `${l.endpoint ?? l.operation}`
    const e = byEndpoint.get(key) ?? { ok: 0, denied: 0, other: 0, last: null, statuses: new Set<number>() }
    const sc = l.statusCode ?? 0
    e.statuses.add(sc)
    if (sc >= 200 && sc < 300) e.ok += l._count._all
    else if (sc === 401 || sc === 403) e.denied += l._count._all
    else e.other += l._count._all
    if (l._max.createdAt && (!e.last || l._max.createdAt > e.last)) e.last = l._max.createdAt
    byEndpoint.set(key, e)
  }
  const sorted = [...byEndpoint.entries()].sort((a, b) => (b[1].ok + b[1].denied + b[1].other) - (a[1].ok + a[1].denied + a[1].other))
  L(`  ${pad('endpoint / operation', 52)} ${'ok'.padStart(6)} ${'403'.padStart(5)} ${'oth'.padStart(5)}  last`)
  for (const [k, v] of sorted.slice(0, 60)) {
    const flag = v.denied > 0 && v.ok === 0 ? ' ⛔ALWAYS DENIED' : v.denied > 0 ? ' ⚠️ some denials' : ''
    L(`  ${pad(k, 52)} ${String(v.ok).padStart(6)} ${String(v.denied).padStart(5)} ${String(v.other).padStart(5)}  ${v.last?.toISOString().slice(0, 10) ?? '-'}${flag}`)
  }
} catch (e) { L(`  ❔ outbound log unavailable: ${e instanceof Error ? e.message.slice(0, 80) : e}`) }

L('')
L('══ SUMMARY BY VERDICT ════════════════════════════════════════════════')
for (const v of ['ENTITLED', 'BLOCKED', 'ABSENT', 'UNKNOWN'] as Verdict[]) {
  const hits = rows.filter((r) => r.verdict === v)
  if (!hits.length) continue
  L(`\n${ICON[v]} ${v} (${hits.length})`)
  for (const h of hits) L(`   ${pad(h.product, 32)} ${h.probe}`)
}

await prisma.$disconnect()
