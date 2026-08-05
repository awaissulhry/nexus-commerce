/** READ-ONLY: re-fetch a DONE Data Kiosk document and analyse the ROW SHAPES
 *  that matter — rows with populated fees/ads, null patterns, key coverage.
 *  The document URL is minted fresh on each GET (300s TTL), so this is safe
 *  to re-run. */
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)
const QID = process.argv[2] ?? '111255020663'

const SellingPartner = (await import('amazon-sp-api')).default as any
const sp = new SellingPartner({
  region: (process.env.AMAZON_REGION ?? 'eu') as 'eu',
  refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
  credentials: {
    SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID!,
    SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET!,
  },
  options: { auto_request_tokens: true, auto_request_throttled: false },
})

const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${QID}`, method: 'GET' })
const d = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${s.dataDocumentId}`, method: 'GET' })
const buf = Buffer.from(await (await fetch(d.documentUrl)).arrayBuffer())
const body = (buf[0] === 0x1f && buf[1] === 0x8b ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
const rows = body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
L(`${rows.length} rows, ${buf.byteLength}B`)

const withFees = rows.filter((r: any) => Array.isArray(r.fees) && r.fees.length > 0)
const withAds = rows.filter((r: any) => Array.isArray(r.ads) && r.ads.length > 0)
const withSales = rows.filter((r: any) => (r.sales?.unitsOrdered ?? 0) > 0)
const withCost = rows.filter((r: any) => r.cost?.costOfGoodsSold != null || r.cost?.miscellaneousCost != null)
L(`rows with fees=${withFees.length}  ads=${withAds.length}  unitsOrdered>0=${withSales.length}  cost set=${withCost.length}`)

L('\n══ A ROW WITH POPULATED FEES ════════════════════════════════════')
L(withFees.length ? JSON.stringify(withFees[0], null, 2).slice(0, 3000) : '(none — no fees anywhere in this window)')

L('\n══ FEES ARRAY LENGTHS SEEN ══════════════════════════════════════')
const lens = new Map<number, number>()
for (const r of rows as any[]) { const n = Array.isArray(r.fees) ? r.fees.length : -1; lens.set(n, (lens.get(n) ?? 0) + 1) }
L([...lens.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `len=${k}: ${v} rows`).join('  '))

L('\n══ A ROW WITH ADS ═══════════════════════════════════════════════')
L(withAds.length ? JSON.stringify(withAds[0], null, 2).slice(0, 2000) : '(none)')

L('\n══ A ROW WITH SALES ═════════════════════════════════════════════')
L(withSales.length ? JSON.stringify(withSales[0], null, 2).slice(0, 2500) : '(none)')

L('\n══ NULL PATTERNS (how often each path is null) ══════════════════')
const paths = [
  'parentAsin', 'childAsin', 'msku',
  'sales.unitsOrdered', 'sales.netProductSales', 'sales.netProductSales.amount', 'sales.averageSellingPrice',
  'netProceeds', 'netProceeds.total', 'netProceeds.total.amount', 'netProceeds.perUnit',
  'cost', 'cost.costOfGoodsSold', 'cost.miscellaneousCost',
]
for (const p of paths) {
  let nulls = 0
  for (const r of rows as any[]) {
    const v = p.split('.').reduce<any>((a, k) => (a == null ? a : a[k]), r)
    if (v === null || v === undefined) nulls++
  }
  L(`  ${p.padEnd(34)} null/absent in ${String(nulls).padStart(5)}/${rows.length}`)
}

L('\n══ GRAIN — is (date, childAsin, msku) unique? ═══════════════════')
for (const combo of [
  ['startDate', 'childAsin'],
  ['startDate', 'childAsin', 'msku'],
  ['startDate', 'marketplaceId', 'childAsin', 'msku'],
  ['startDate', 'marketplaceId', 'parentAsin', 'childAsin', 'msku'],
]) {
  const set = new Set((rows as any[]).map((r) => combo.map((c) => String(r[c])).join('|')))
  L(`  ${set.size === rows.length ? '✅ UNIQUE' : '⛔ collides'}  ${set.size}/${rows.length}  [${combo.join(', ')}]`)
}

L('\n══ DATE COVERAGE ════════════════════════════════════════════════')
const byDate = new Map<string, number>()
for (const r of rows as any[]) byDate.set(r.startDate, (byDate.get(r.startDate) ?? 0) + 1)
L([...byDate.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  '))
L(`startDate === endDate on every row: ${(rows as any[]).every((r) => r.startDate === r.endDate)}`)

await prisma.$disconnect()
