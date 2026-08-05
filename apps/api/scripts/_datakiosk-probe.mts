/**
 * READ-ONLY Data Kiosk discovery.
 *  1. Which schema versions does this account accept?
 *  2. Does GraphQL introspection work (definitive field list)?
 *  3. Run one real query end-to-end to capture the document format.
 *
 * Creating a query is a normal read operation (it generates a dataset); no
 * writes to Amazon state.
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
L(`marketplaceId=${MKT}`)

async function createQuery(label: string, query: string): Promise<string | null> {
  try {
    const res = await sp.callAPI({
      api_path: '/dataKiosk/2023-11-15/queries',
      method: 'POST',
      body: { query },
    })
    L(`  ✅ ${label} → queryId=${res?.queryId}`)
    return res?.queryId ?? null
  } catch (e: any) {
    const msg = String(e?.message ?? e).replace(/\s+/g, ' ')
    L(`  ⛔ ${label} → ${msg.slice(0, 420)}`)
    return null
  }
}

L('\n══ 1. SCHEMA DISCOVERY — deliberately invalid schema ═════════════')
// Amazon's error for an unknown schema usually enumerates the valid ones.
await createQuery('bogus schema', 'query { thisSchemaDoesNotExist_9999 { foo } }')

L('\n══ 2. GRAPHQL INTROSPECTION ══════════════════════════════════════')
await createQuery('introspection', '{ __schema { queryType { fields { name description } } } }')

L('\n══ 3. KNOWN SCHEMA VERSIONS ══════════════════════════════════════')
const CANDIDATES = [
  'analytics_salesAndTraffic_2023_11_15',
  'analytics_salesAndTraffic_2024_04_24',
  'analytics_economics_2024_03_15',
  'analytics_economics_2025_01_15',
  'analytics_economics_preview',
]
for (const schema of CANDIDATES) {
  // Ask for a field that certainly does not exist: a schema that EXISTS returns
  // "Cannot query field X on type Y"; one that does not returns "Unknown type".
  await createQuery(schema, `query { ${schema} { __nonexistentProbeField__ } }`)
  await new Promise((r) => setTimeout(r, 700))
}

L('\n══ 4. REAL QUERY END-TO-END (salesAndTraffic) ════════════════════')
const end = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
const start = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)
const realQuery = `query SalesAndTraffic {
  analytics_salesAndTraffic_2024_04_24 {
    salesAndTrafficByDate(
      startDate: "${start}"
      endDate: "${end}"
      aggregateBy: DAY
      marketplaceIds: ["${MKT}"]
    ) {
      startDate
      endDate
      marketplaceId
      sales { orderedProductSales { amount currencyCode } unitsOrdered totalOrderItems }
      traffic { browserPageViews mobileAppPageViews sessions buyBoxPercentage unitSessionPercentage }
    }
  }
}`
L(`window ${start}..${end}`)
const qid = await createQuery('salesAndTraffic real', realQuery)

if (qid) {
  L('\n  polling…')
  let doc: string | null = null
  let errDoc: string | null = null
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    try {
      const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${qid}`, method: 'GET' })
      L(`   poll#${i + 1} status=${s?.processingStatus} dataDoc=${s?.dataDocumentId ?? '-'} errDoc=${s?.errorDocumentId ?? '-'}`)
      if (s?.processingStatus === 'DONE' || s?.processingStatus === 'FATAL') {
        doc = s?.dataDocumentId ?? null
        errDoc = s?.errorDocumentId ?? null
        break
      }
    } catch (e: any) { L(`   poll error ${String(e?.message ?? e).slice(0, 200)}`) }
  }

  for (const [kind, id] of [['DATA', doc], ['ERROR', errDoc]] as Array<[string, string | null]>) {
    if (!id) continue
    try {
      const d = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${id}`, method: 'GET' })
      L(`\n  ${kind} document meta: ${JSON.stringify(d).slice(0, 300)}`)
      if (d?.documentUrl) {
        const r = await fetch(d.documentUrl)
        const buf = Buffer.from(await r.arrayBuffer())
        const isGz = buf[0] === 0x1f && buf[1] === 0x8b
        const body = (isGz ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
        L(`  ${kind} download ${r.status} gzip=${isGz} bytes=${buf.byteLength}`)
        L(`  ${kind} BODY (first 1800):`)
        L(body.slice(0, 1800))
        const lines = body.trim().split('\n').filter(Boolean)
        L(`  ${kind} line count = ${lines.length} (JSONL if >1 and each parses)`)
      }
    } catch (e: any) { L(`  ${kind} doc fetch failed: ${String(e?.message ?? e).slice(0, 250)}`) }
  }
}

await prisma.$disconnect()
