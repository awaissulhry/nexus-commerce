/** READ-ONLY: map the selection set of analytics_economics_2024_03_15.economics.
 *  GraphQL reports EVERY validation error at once, so a single over-broad
 *  selection tells us exactly which fields exist and which don't. */
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

async function run(label: string, query: string, follow = false) {
  L(`\n── ${label} ──`)
  let qid: string | null = null
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
    qid = res?.queryId
    L(`  ✅ accepted queryId=${qid}`)
  } catch (e: any) {
    const d = String(e?.details ?? '')
    const m = String(e?.message ?? e)
    if (!d) { L(`  ⛔ ${m.slice(0, 200)} (no detail — likely throttled, retry)`); return }
    // Split the error array into one line per undefined field.
    for (const err of d.split('","')) L(`     ${err.replace(/^\[?"|"?\]$/g, '').slice(0, 190)}`)
    return
  }
  if (!qid || !follow) return
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${qid}`, method: 'GET' }).catch(() => null)
    if (!s) continue
    if (s.processingStatus === 'DONE' || s.processingStatus === 'FATAL') {
      L(`  status=${s.processingStatus}`)
      for (const [kind, id] of [['DATA', s.dataDocumentId], ['ERROR', s.errorDocumentId]] as Array<[string, string | null]>) {
        if (!id) continue
        const d = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${id}`, method: 'GET' }).catch(() => null)
        if (!d?.documentUrl) continue
        const buf = Buffer.from(await (await fetch(d.documentUrl)).arrayBuffer())
        const body = (buf[0] === 0x1f && buf[1] === 0x8b ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
        L(`  ${kind} (${buf.byteLength}B):`)
        L(body.slice(0, 2000))
      }
      return
    }
  }
  L('  (timed out polling)')
}

// Over-broad selection: every plausible top-level field at once.
await run('economics — probe top-level selection', `query {
  analytics_economics_2024_03_15 {
    economics(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]) {
      startDate endDate marketplaceId parentAsin childAsin msku sku asin
      sales fees ads cost netProceeds charges inventory aggregateBy
      __probeNonexistent__
    }
  }
}`)

// Same trick one level down, once the top level is known.
await run('economics — probe sales/fees/netProceeds sub-fields', `query {
  analytics_economics_2024_03_15 {
    economics(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]) {
      sales { orderedRevenue netProductSales unitsOrdered unitsRefunded averageSellingPrice __nope__ }
      fees { totalFees __nope__ }
      netProceeds { total perUnit __nope__ }
    }
  }
}`)

await prisma.$disconnect()
