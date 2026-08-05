/**
 * STEP 1 of the IT-drop diagnosis — capture the RAW spCampaigns payload for IT
 * and DE and diff their shape.
 *
 * Established already: request configuration is byte-identical between the two,
 * Amazon returns a GROWING file for IT (1345→1721 bytes vs DE's ~440), the JSON
 * parses without error, and then every row is discarded — rowsIngested = 0 since
 * 2026-07-28 while IT actively spends (€103.27 on Aug 3 per AMS).
 *
 * So the answer is in the row SHAPE. `ingestCampaignRows` skips silently on
 * `if (!r.date || r.campaignId == null) continue` — this prints exactly which
 * keys each market's rows carry.
 *
 * Touches NO Nexus table. It creates an Amazon-side report request, polls it,
 * downloads it, and prints. Needs prod Ads credentials:
 *
 *   cd apps/api && railway run npx tsx scripts/_it-payload.mts
 */
import { gunzipSync } from 'node:zlib'
import { liveCall } from '../src/services/advertising/ads-api-client.js'

const DAY = '2026-08-03'
const TARGETS = [
  { market: 'IT', profileId: '4117374346144545' },
  { market: 'DE', profileId: '2009298984696893' },
]

const body = {
  name: `diag-spCampaigns-${DAY}`,
  startDate: DAY,
  endDate: DAY,
  configuration: {
    format: 'GZIP_JSON',
    columns: ['date', 'campaignId', 'campaignName', 'campaignStatus',
              'impressions', 'clicks', 'cost', 'sales7d', 'purchases7d', 'unitsSoldClicks7d'],
    groupBy: ['campaign'],
    timeUnit: 'DAILY',
    adProduct: 'SPONSORED_PRODUCTS',
    reportTypeId: 'spCampaigns',
  },
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const results: Record<string, { keys: string[]; rows: number; sample: unknown }> = {}

for (const t of TARGETS) {
  console.log(`\n${'='.repeat(70)}\n${t.market}  profile ${t.profileId}  ${DAY}\n${'='.repeat(70)}`)
  try {
    const created = await liveCall<{ reportId: string }>({
      profileId: t.profileId, region: 'EU', method: 'POST', path: '/reporting/reports',
      body, contentType: 'application/vnd.createasyncreportrequest.v3+json',
    })
    console.log('reportId:', created.reportId)

    let url: string | undefined
    for (let i = 0; i < 40; i++) {
      await sleep(15_000)
      const st = await liveCall<{ status: string; url?: string; fileSize?: number }>({
        profileId: t.profileId, region: 'EU', method: 'GET',
        path: `/reporting/reports/${created.reportId}`,
      })
      process.stdout.write(`  poll ${i + 1}: ${st.status}\n`)
      if (String(st.status).toUpperCase() === 'COMPLETED' && st.url) {
        url = st.url
        console.log('  fileSize reported:', st.fileSize)
        break
      }
      if (String(st.status).toUpperCase() === 'FAILURE') { console.log('  FAILED'); break }
    }
    if (!url) { console.log('  no url — giving up'); continue }

    const res = await fetch(url)
    const bytes = Buffer.from(await res.arrayBuffer())
    console.log('  downloaded bytes:', bytes.length)

    let text: string
    try {
      text = gunzipSync(bytes).toString('utf8')
      console.log('  gunzip: OK, inflated bytes:', text.length)
    } catch (e) {
      console.log('  gunzip FAILED —', String(e).slice(0, 120))
      console.log('  raw head:', bytes.toString('utf8').slice(0, 400))
      continue
    }

    console.log('  inflated head:', text.slice(0, 300))
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch (e) {
      console.log('  JSON.parse FAILED —', String(e).slice(0, 120)); continue
    }
    const isArr = Array.isArray(parsed)
    console.log('  isArray:', isArr, '| length:', isArr ? (parsed as unknown[]).length : 'n/a')
    if (!isArr) { console.log('  NON-ARRAY payload:', JSON.stringify(parsed).slice(0, 600)); continue }

    const arr = parsed as Array<Record<string, unknown>>
    if (!arr.length) { console.log('  EMPTY ARRAY — Amazon returned no rows'); results[t.market] = { keys: [], rows: 0, sample: null }; continue }

    const keys = Object.keys(arr[0]).sort()
    results[t.market] = { keys, rows: arr.length, sample: arr[0] }
    console.log('  row keys:', JSON.stringify(keys))
    console.log('  first row:', JSON.stringify(arr[0]))
    // The two fields the ingest requires — the exact skip condition.
    const missingDate = arr.filter((r) => !r.date).length
    const missingCampaignId = arr.filter((r) => r.campaignId == null).length
    console.log(`  >>> rows lacking .date: ${missingDate}/${arr.length}`)
    console.log(`  >>> rows lacking .campaignId: ${missingCampaignId}/${arr.length}`)
  } catch (err) {
    console.log('  ERROR:', err instanceof Error ? err.message : String(err))
  }
}

console.log(`\n${'='.repeat(70)}\nSHAPE DIFF\n${'='.repeat(70)}`)
const it = results.IT, de = results.DE
if (it && de) {
  console.log('IT keys :', JSON.stringify(it.keys))
  console.log('DE keys :', JSON.stringify(de.keys))
  const onlyIT = it.keys.filter((k) => !de.keys.includes(k))
  const onlyDE = de.keys.filter((k) => !it.keys.includes(k))
  console.log('only in IT:', JSON.stringify(onlyIT))
  console.log('only in DE:', JSON.stringify(onlyDE))
  console.log(onlyIT.length || onlyDE.length ? '>>> SHAPES DIFFER — that is the bug.' : '>>> shapes identical — cause is elsewhere.')
} else {
  console.log('incomplete — IT:', !!it, 'DE:', !!de)
}
process.exit(0)
