/** READ-ONLY: finish mapping economics — FeeSummary / AdSummary / cost /
 *  netProceeds / Amount. Probes spaced 70s (validation failures cost quota).
 *  Control fields deliberately avoid the reserved '__' prefix. */
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

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

const MKT = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
const end = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10)
const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)
const ARGS = `startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]`

async function probe(label: string, selection: string, follow = false): Promise<void> {
  L('   …70s quota wait')
  await new Promise((r) => setTimeout(r, 70_000))
  const query = `query { analytics_economics_2024_03_15 { economics(${ARGS}) { ${selection} } } }`
  L(`\n── ${label} ──`)
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
    L(`  ✅ ACCEPTED — whole selection valid. queryId=${res?.queryId}`)
    if (!follow) return
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 6000))
      const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${res.queryId}`, method: 'GET' }).catch(() => null)
      if (!s || (s.processingStatus !== 'DONE' && s.processingStatus !== 'FATAL')) continue
      L(`  status=${s.processingStatus}`)
      for (const [kind, id] of [['DATA', s.dataDocumentId], ['ERROR', s.errorDocumentId]] as Array<[string, string | null]>) {
        if (!id) continue
        const d = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${id}`, method: 'GET' }).catch(() => null)
        if (!d?.documentUrl) continue
        const buf = Buffer.from(await (await fetch(d.documentUrl)).arrayBuffer())
        const body = (buf[0] === 0x1f && buf[1] === 0x8b ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
        L(`  ${kind} (${buf.byteLength}B):`)
        L(body.slice(0, 2500))
      }
      return
    }
  } catch (e: any) {
    const d = String(e?.details ?? '')
    if (!d) { L(`  ⛔ ${String(e?.message ?? e).slice(0, 160)}`); return }
    const undef = [...d.matchAll(/Field '([^']+)' in type '([^']+)' is undefined/g)].map((m) => `${m[2]}.${m[1]}`)
    const sub = [...d.matchAll(/Sub selection required for type ([^ ]+) of field (\w+)/g)].map((m) => `${m[2]}:${m[1]}`)
    if (undef.length) L(`  ✗ undefined: ${[...new Set(undef)].join(', ')}`)
    if (sub.length) L(`  ⊂ needs sub-selection: ${[...new Set(sub)].join(', ')}`)
    if (!undef.length && !sub.length) L(`  raw: ${d.slice(0, 800)}`)
  }
}

// Amount is almost certainly {amount, currencyCode} — confirm, and map
// FeeSummary / AdSummary / cost / netProceeds in the same pass.
await probe('money objects', `
  sales { unitsOrdered netProductSales { amount currencyCode zzzCtl } }
  fees { feeType charge totalAmount amount zzzCtl }
  ads { adType spend cost zzzCtl }
  cost { totalCost amount zzzCtl }
  netProceeds { total perUnit zzzCtl }
`)

// Whatever survives becomes the production query — run it for real data.
await probe('candidate production query', `
  startDate endDate marketplaceId parentAsin childAsin msku
  sales { unitsOrdered netProductSales { amount currencyCode } averageSellingPrice { amount currencyCode } }
  fees { feeType totalAmount { amount currencyCode } }
  netProceeds { total { amount currencyCode } perUnit { amount currencyCode } }
`, true)

await prisma.$disconnect()
