// E0 read-only probe 4: advertising eligibility per marketplace (sell.account
// scope — already granted). NO WRITES.
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
const prisma = new PrismaClient()

const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
})
let tok = conn.accessToken
if (!tok || (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) <= new Date())) {
  const creds = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refreshToken }),
  })
  tok = (await r.json()).access_token
}

for (const mkt of ['EBAY_IT', 'EBAY_DE', 'EBAY_FR', 'EBAY_ES']) {
  const r = await fetch(
    'https://api.ebay.com/sell/account/v1/advertising_eligibility?program_types=PROMOTED_LISTINGS,PROMOTED_LISTINGS_ADVANCED',
    { headers: { Authorization: `Bearer ${tok}`, 'X-EBAY-C-MARKETPLACE-ID': mkt } },
  )
  const body = await r.text()
  console.log(`${mkt}: HTTP ${r.status} ${body.slice(0, 500)}`)
}

await prisma.$disconnect()
