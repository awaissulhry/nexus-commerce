/** READ-ONLY: find the real root field on Analytics_Economics_2024_03_15.
 *  GraphQL "FieldUndefined" errors name the type, so enumeration is cheap and
 *  definitive. Invalid queries are rejected at validation — nothing is created. */
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

const CANDIDATES = [
  'economics', 'economicsByAsin', 'economicsBySku', 'economicsByDate',
  'economicsPreview', 'productEconomics', 'asinEconomics', 'economicsByChildAsin',
  'economicsByParentAsin', 'salesAndTrafficByAsin', 'economicsByAsinAndDate',
  'economicsAggregated', 'economicsByMsku',
]

async function probe(field: string): Promise<string> {
  const q = `query { analytics_economics_2024_03_15 { ${field}(startDate: "${start}", endDate: "${end}", marketplaceIds: ["${MKT}"]) { startDate } } }`
  try {
    const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query: q } })
    return `✅ ACCEPTED queryId=${res?.queryId}`
  } catch (e: any) {
    const d = String(e?.details ?? e?.message ?? e)
    if (/FieldUndefined/.test(d)) return '— field does not exist'
    // Any OTHER validation error means the FIELD EXISTS and only its
    // arguments/selection are wrong — that is the one we want.
    return `★ FIELD EXISTS → ${d.slice(0, 300)}`
  }
}

for (const f of CANDIDATES) {
  L(`${f.padEnd(24)} ${await probe(f)}`)
  await new Promise((r) => setTimeout(r, 600))
}

await prisma.$disconnect()
