/**
 * READ-ONLY, decisive test of the fee-labelling hypothesis.
 *
 * `fees: [FeeSummary]!` returns amounts with NO identifier field (20 candidate
 * names rejected). `analytics_economics_preview` rejects with "Missing field
 * argument feeTypes", so the fee type is almost certainly a QUERY ARGUMENT and
 * the list comes back in the requested order.
 *
 * A bogus enum value makes GraphQL enumerate the valid ones — one query, whole
 * answer. Waits 5 min first so the ~1/min create-query quota has refilled.
 */
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

L('waiting 5 min for create-query quota to refill…')
await new Promise((r) => setTimeout(r, 300_000))

async function run(label: string, query: string, follow = false, waitFirst = 70_000) {
  if (waitFirst) { L(`   …${Math.round(waitFirst / 1000)}s quota wait`); await new Promise((r) => setTimeout(r, waitFirst)) }
  L(`\n── ${label} ──`)
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
    L(`  ✅ ACCEPTED queryId=${res?.queryId}`)
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
        const lines = body.trim().split('\n').filter(Boolean)
        L(`  ${kind}: ${buf.byteLength}B, ${lines.length} JSONL rows`)
        try { L(JSON.stringify(JSON.parse(lines[0]), null, 2).slice(0, 3000)) } catch { L(body.slice(0, 2000)) }
      }
      return
    }
    L('  (timed out polling)')
  } catch (e: any) {
    const d = String(e?.details ?? '')
    L(`  ⛔ ${String(e?.message ?? e).slice(0, 120)}`)
    if (d) L(`  details: ${d.slice(0, 1600)}`)
  }
}

// 1. Bogus enum → Amazon should enumerate the valid feeTypes.
await run('feeTypes enum discovery (deliberately bogus value)', `query {
  analytics_economics_2024_03_15 {
    economics(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"], feeTypes: [ZZZ_NOT_A_REAL_FEE_TYPE]) {
      startDate
    }
  }
}`, false, 0)

// 2. Full production query WITH data. Uses aggregateBy so rows are per-ASIN-day.
await run('PRODUCTION economics query (real data)', `query {
  analytics_economics_2024_03_15 {
    economics(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]) {
      startDate endDate marketplaceId parentAsin childAsin msku
      sales {
        unitsOrdered
        netProductSales { amount currencyCode }
        averageSellingPrice { amount currencyCode }
      }
      fees { charge { aggregatedDetail { amount { amount currencyCode } quantity } } }
      ads  { charge { amount { amount currencyCode } quantity } }
      netProceeds { total { amount currencyCode } perUnit { amount currencyCode } }
      cost { costOfGoodsSold { amount currencyCode } miscellaneousCost { amount currencyCode } }
    }
  }
}`, true)

await prisma.$disconnect()
