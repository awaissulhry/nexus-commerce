/**
 * READ-ONLY contract capture for the surfaces we just proved entitled.
 * Prints FULL response bodies so the integrations are written against the
 * real shapes rather than documented guesses.
 */
const prisma = (await import('../src/db.js')).default
const { decryptSecret } = await import('../src/lib/crypto.js')
const L = (s = '') => console.log(s)

const conns = await prisma.amazonAdsConnection.findMany({
  where: { isActive: true, mode: 'production' },
  select: { profileId: true, marketplace: true, region: true, credentialsEncrypted: true },
})
const primary = conns.find((c) => c.marketplace === 'IT') ?? conns[0]
if (!primary?.credentialsEncrypted) { L('no production connection'); process.exit(1) }
const creds = JSON.parse(decryptSecret(primary.credentialsEncrypted)) as { clientId: string; clientSecret: string; refreshToken: string }
const BASE = 'https://advertising-api-eu.amazon.com'

const tr = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret }).toString(),
})
const TOKEN = ((await tr.json()) as { access_token: string }).access_token

async function call(label: string, method: string, path: string, opts: { body?: unknown; mime?: string; profileId?: string | null; extra?: Record<string, string> } = {}) {
  const h: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Amazon-Advertising-API-ClientId': creds.clientId, ...(opts.extra ?? {}) }
  if (opts.profileId !== null) h['Amazon-Advertising-API-Scope'] = opts.profileId ?? primary!.profileId
  if (opts.mime) { h.Accept = opts.mime; if (opts.body !== undefined) h['Content-Type'] = opts.mime }
  else if (opts.body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
  const text = await res.text()
  L(`\n── ${label}  [${method} ${path}] → ${res.status}`)
  L(text.slice(0, 2200))
  await new Promise((r) => setTimeout(r, 400))
  return { status: res.status, text }
}

L(`profiles (production): ${conns.map((c) => `${c.marketplace}=${c.profileId}`).join(' ')}`)
L(`using primary: ${primary.marketplace}=${primary.profileId}`)

L('\n══ BRAND METRICS — full create response + follow-up ═══════════════')
const end = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10)
const start = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)
for (const agg of ['WEEKLY', 'DAILY']) {
  const r = await call(`create ${agg} ${start}..${end}`, 'POST', '/insights/brandMetrics/report', {
    mime: 'application/vnd.brandmetricsreport.v1+json',
    body: { reportStartDate: start, reportEndDate: end, aggregationLevel: agg },
  })
  // If it handed back a location, follow it and show the actual report rows.
  try {
    const j = JSON.parse(r.text) as { location?: string; reportId?: string }
    if (j.location) {
      L(`   ↳ following location…`)
      const dl = await fetch(j.location)
      const buf = Buffer.from(await dl.arrayBuffer())
      const isGz = buf[0] === 0x1f && buf[1] === 0x8b
      const body = isGz ? (await import('node:zlib')).gunzipSync(buf) : buf
      L(`   ↳ ${dl.status} gzip=${isGz} bytes=${buf.byteLength}`)
      L(`   ↳ ${body.toString('utf8').slice(0, 1800)}`)
    }
    if (j.reportId) await call('  poll by reportId', 'GET', `/insights/brandMetrics/report/${j.reportId}`, { mime: 'application/vnd.brandmetricsreport.v1+json' })
  } catch { /* non-JSON */ }
}

L('\n══ AMC — is any instance provisioned? ════════════════════════════')
await call('amc accounts', 'GET', '/amc/accounts', { profileId: null })
const acct = await call('adsAccounts list', 'POST', '/adsAccounts/list', { mime: 'application/vnd.listaccountsresource.v1+json', body: { maxResults: 10 }, profileId: null })
try {
  const j = JSON.parse(acct.text) as { adsAccounts?: Array<{ adsAccountId?: string; alternateIds?: Array<{ entityId?: string; profileId?: number }> }> }
  for (const a of j.adsAccounts ?? []) {
    for (const alt of a.alternateIds ?? []) {
      if (alt.entityId) {
        await call(`amc instances entityId=${alt.entityId}`, 'GET', `/amc/instances?entityId=${alt.entityId}`, { profileId: null, extra: { 'Amazon-Advertising-API-AdvertiserId': alt.entityId } })
      }
    }
  }
} catch { /* ignore */ }

L('\n══ DSP — advertisers with proper params ══════════════════════════')
for (const c of conns) {
  await call(`dsp advertisers profile=${c.marketplace}`, 'GET', '/dsp/advertisers?startIndex=0&count=10', { profileId: c.profileId, mime: 'application/vnd.dspadvertiser.v1+json' })
}

L('\n══ MARKETING STREAM — subscriptions per profile ══════════════════')
for (const c of conns) {
  await call(`streams profile=${c.marketplace}`, 'GET', '/streams/subscriptions', { profileId: c.profileId })
}

L('\n══ DATA KIOSK — available GraphQL schemas ════════════════════════')
L('  (SP-API — probed separately below)')

L('\n══ SPONSORED TV + ATTRIBUTION ═══════════════════════════════════')
await call('attribution publishers', 'GET', '/attribution/publishers')
await call('attribution advertisers', 'GET', '/attribution/advertisers')
await call('st campaigns', 'POST', '/st/campaigns/list', { mime: 'application/vnd.stcampaign.v1+json', body: { maxResults: 5 } })

await prisma.$disconnect()
