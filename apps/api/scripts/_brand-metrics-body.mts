/** READ-ONLY: create → poll → download a Brand Metrics report in one pass,
 *  and print the real row shape. The signed URL lives only 300s, so this
 *  must happen inside a single run. Also retries DSP with versioned Accepts. */
const prisma = (await import('../src/db.js')).default
const { decryptSecret } = await import('../src/lib/crypto.js')
const L = (s = '') => console.log(s)

const conn = await prisma.amazonAdsConnection.findFirst({
  where: { isActive: true, mode: 'production', marketplace: 'IT' },
  select: { profileId: true, credentialsEncrypted: true },
})
const creds = JSON.parse(decryptSecret(conn!.credentialsEncrypted!)) as { clientId: string; clientSecret: string; refreshToken: string }
const BASE = 'https://advertising-api-eu.amazon.com'
const tr = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret }).toString(),
})
const TOKEN = ((await tr.json()) as { access_token: string }).access_token
const MIME = 'application/vnd.brandmetricsreport.v1+json'
const H = { Authorization: `Bearer ${TOKEN}`, 'Amazon-Advertising-API-ClientId': creds.clientId, 'Amazon-Advertising-API-Scope': conn!.profileId }

for (const agg of ['WEEKLY', 'DAILY', 'MONTHLY']) {
  const end = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)
  const start = new Date(Date.now() - 37 * 86400000).toISOString().slice(0, 10)
  L(`\n══════ aggregationLevel=${agg}  ${start}..${end} ══════`)
  const c = await fetch(`${BASE}/insights/brandMetrics/report`, {
    method: 'POST', headers: { ...H, Accept: MIME, 'Content-Type': MIME },
    body: JSON.stringify({ reportStartDate: start, reportEndDate: end, aggregationLevel: agg }),
  })
  const cj = await c.json() as { reportId?: string; status?: string }
  L(`create → ${c.status} reportId=${cj.reportId} status=${cj.status}`)
  if (!cj.reportId) { L(JSON.stringify(cj).slice(0, 400)); continue }

  let loc: string | null = null
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2500))
    const s = await fetch(`${BASE}/insights/brandMetrics/report/${cj.reportId}`, { headers: { ...H, Accept: MIME } })
    const sj = await s.json() as { status?: string; location?: string; statusDetails?: string; brandsInfo?: unknown }
    if (i === 0) L(`  brandsInfo: ${JSON.stringify(sj.brandsInfo)}`)
    if (sj.status === 'SUCCESSFUL' && sj.location) { loc = sj.location; L(`  poll#${i + 1} → SUCCESSFUL`); break }
    if (sj.status === 'FAILED') { L(`  poll#${i + 1} → FAILED ${sj.statusDetails}`); break }
  }
  if (!loc) { L('  no location'); continue }

  const dl = await fetch(loc)
  const buf = Buffer.from(await dl.arrayBuffer())
  const isGz = buf[0] === 0x1f && buf[1] === 0x8b
  const body = (isGz ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
  L(`  download → ${dl.status} gzip=${isGz} bytes=${buf.byteLength}`)
  L(`  RAW BODY (first 2500 chars):`)
  L(body.slice(0, 2500))
  try {
    const parsed = JSON.parse(body)
    const top = Array.isArray(parsed) ? '(array)' : Object.keys(parsed).join(', ')
    L(`  top-level keys: ${top}`)
    const first = Array.isArray(parsed) ? parsed[0] : (parsed.rows ?? parsed.reports ?? parsed.data ?? [])[0]
    if (first) L(`  FIRST ROW KEYS: ${Object.keys(first).join(', ')}`)
  } catch { L('  (not JSON)') }
}

L('\n══════ DSP with versioned Accept headers ══════')
for (const mime of [
  'application/vnd.dspadvertisers.v1+json',
  'application/vnd.dspadvertiser.v1+json',
  'application/vnd.dspadvertisersummary.v1+json',
  'application/json',
]) {
  const r = await fetch(`${BASE}/dsp/advertisers?startIndex=0&count=10`, { headers: { ...H, Accept: mime } })
  L(`  ${mime} → ${r.status}  ${(await r.text()).slice(0, 200)}`)
  await new Promise((r) => setTimeout(r, 300))
}

await prisma.$disconnect()
