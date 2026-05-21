#!/usr/bin/env node
// Probes 5 different Finance API endpoints to see if ANY of them grant access,
// or whether the entire Finance role is gated for this account.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const clientId = process.env.AMAZON_LWA_CLIENT_ID
const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
const refreshToken = process.env.AMAZON_REFRESH_TOKEN
const region = 'eu'
const host = `sellingpartnerapi-${region}.amazon.com`
const marketplaceId = 'APJ6JRA9NG5V4'

// Refresh LWA
console.log('Refreshing LWA token (local .env — may not match Railway prod)…')
const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString(),
})
if (!tokenRes.ok) { console.error('LWA failed', await tokenRes.text()); process.exit(1) }
const { access_token } = await tokenRes.json()

const since = new Date(Date.now() - 7 * 86400_000).toISOString()
const probes = [
  { name: 'Finances v0 — listFinancialEvents', path: `/finances/v0/financialEvents?PostedAfter=${since}&MaxResultsPerPage=10` },
  { name: 'Finances v0 — listFinancialEventGroups', path: `/finances/v0/financialEventGroups?FinancialEventGroupStartedAfter=${since}&MaxResultsPerPage=10` },
  { name: 'Finances 2024 — listTransactions', path: `/finances/2024-06-19/transactions?postedAfter=${since}&marketplaceId=${marketplaceId}` },
  { name: 'Reports — listReports (settlement)', path: `/reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&pageSize=5` },
  { name: 'Reports — getReport schemas (catalog)', path: `/reports/2021-06-30/reports?reportTypes=GET_MERCHANT_LISTINGS_ALL_DATA&pageSize=5` },
]

for (const p of probes) {
  const r = await fetch(`https://${host}${p.path}`, {
    headers: { 'x-amz-access-token': access_token, 'Content-Type': 'application/json' },
  })
  const body = await r.text()
  let errMsg = ''
  try {
    const j = JSON.parse(body)
    errMsg = j.errors?.[0]?.message ?? j.message ?? ''
  } catch {}
  const verdict = r.status === 200 ? '✅ OK' : r.status === 403 ? '❌ 403' : `? ${r.status}`
  console.log(`${verdict.padEnd(8)} ${p.name}`)
  if (r.status !== 200 && errMsg) console.log(`         → ${errMsg}`)
}
