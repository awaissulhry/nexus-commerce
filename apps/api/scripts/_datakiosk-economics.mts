/** READ-ONLY: pin down the Data Kiosk ECONOMICS schema by reading FULL
 *  GraphQL error bodies (the sp-api wrapper hides the detail by default). */
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

async function tryQuery(label: string, query: string) {
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
    L(`\n✅ ${label} → queryId=${res?.queryId}`)
    return res?.queryId as string
  } catch (e: any) {
    // Dump EVERYTHING the wrapper carries — the useful GraphQL detail is
    // usually in details/errors, not message.
    const parts: string[] = []
    for (const k of ['message', 'code', 'details', 'errors', 'response', 'body', 'data']) {
      if (e?.[k] !== undefined) parts.push(`${k}=${typeof e[k] === 'string' ? e[k] : JSON.stringify(e[k])}`)
    }
    L(`\n⛔ ${label}`)
    L(`   ${parts.join('\n   ').slice(0, 1400)}`)
    return null
  }
}

L(`window ${start}..${end}  marketplace=${MKT}`)

// Sanity: the shape we KNOW works, with a bad field — to see how a real
// field-level error is reported vs a schema-level one.
await tryQuery('known schema + bad field', `query { analytics_salesAndTraffic_2024_04_24 { NOPE } }`)

const ECON_VARIANTS: Array<[string, string]> = [
  ['economics_2024_03_15 byAsin', `query { analytics_economics_2024_03_15 { economicsByAsin(startDate: "${start}", endDate: "${end}", aggregateBy: { date: DAY }, marketplaceIds: ["${MKT}"]) { startDate childAsin } } }`],
  ['economics_2024_03_15 minimal', `query { analytics_economics_2024_03_15 { economicsByAsin(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]) { startDate } } }`],
  ['economics_2025_01_15 byAsin', `query { analytics_economics_2025_01_15 { economicsByAsin(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]) { startDate } } }`],
  ['economics_preview', `query { analytics_economics_preview { economicsByAsin(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]) { startDate } } }`],
  ['salesAndTraffic byAsin', `query { analytics_salesAndTraffic_2024_04_24 { salesAndTrafficByAsin(startDate: "${start}", endDate: "${end}", aggregateBy: CHILD, marketplaceIds: ["${MKT}"]) { childAsin sales { unitsOrdered } traffic { sessions } } } }`],
]

const ids: Array<[string, string]> = []
for (const [label, q] of ECON_VARIANTS) {
  const id = await tryQuery(label, q)
  if (id) ids.push([label, id])
  await new Promise((r) => setTimeout(r, 800))
}

// Any accepted query: follow it to completion. FATAL yields an errorDocument
// whose body names the exact problem — the most informative signal available.
for (const [label, qid] of ids) {
  L(`\n── following ${label} (${qid}) ──`)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${qid}`, method: 'GET' }).catch(() => null)
    if (!s) continue
    if (s.processingStatus === 'DONE' || s.processingStatus === 'FATAL') {
      L(`   status=${s.processingStatus} dataDoc=${s.dataDocumentId ?? '-'} errDoc=${s.errorDocumentId ?? '-'}`)
      for (const [kind, id] of [['DATA', s.dataDocumentId], ['ERROR', s.errorDocumentId]] as Array<[string, string | null]>) {
        if (!id) continue
        const d = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${id}`, method: 'GET' }).catch(() => null)
        if (!d?.documentUrl) continue
        const buf = Buffer.from(await (await fetch(d.documentUrl)).arrayBuffer())
        const body = (buf[0] === 0x1f && buf[1] === 0x8b ? (await import('node:zlib')).gunzipSync(buf) : buf).toString('utf8')
        L(`   ${kind} (${buf.byteLength}B): ${body.slice(0, 1200)}`)
      }
      break
    }
  }
}

await prisma.$disconnect()
