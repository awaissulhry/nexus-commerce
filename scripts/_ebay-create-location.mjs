// One-shot: create eBay inventory location "xavia-main" for the Xavia seller account.
// Uses the stored eBay refresh token to get a live access token, then calls
// POST /sell/inventory/v1/location/{merchantLocationKey}.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })

const EBAY_API_BASE = 'https://api.ebay.com'
const LOCATION_KEY  = 'xavia-main'

// ── 1. Load eBay tokens from ChannelConnection ────────────────────────────
const c = new pg.Client({ connectionString: process.env.DATABASE_URL?.replace('-pooler','') }); await c.connect()
const { rows } = await c.query(
  `SELECT id, "accessToken", "refreshToken", "tokenExpiresAt"
     FROM "ChannelConnection"
    WHERE "channelType" = 'EBAY' AND "isActive" = true
    LIMIT 1`
)
await c.end()

if (!rows.length) { console.error('No active EBAY ChannelConnection found.'); process.exit(1) }
const conn = rows[0]
console.log(`ChannelConnection id=${conn.id}`)

const clientId     = process.env.EBAY_CLIENT_ID
const clientSecret = process.env.EBAY_CLIENT_SECRET
if (!clientId || !clientSecret) { console.error('Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in .env'); process.exit(1) }

// ── 2. Get a valid access token (refresh if expired) ──────────────────────
let accessToken = conn.accessToken
const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt) : new Date(0)
if (!accessToken || expiresAt <= new Date()) {
  console.log('Access token expired — refreshing via OAuth…')
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const tokRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refreshToken }),
  })
  if (!tokRes.ok) { console.error('Token refresh failed:', await tokRes.text()); process.exit(1) }
  const { access_token } = await tokRes.json()
  accessToken = access_token
  console.log('Token refreshed.')
} else {
  console.log('Access token still valid.')
}

// ── 3. Check if location already exists ───────────────────────────────────
const checkRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/location/${LOCATION_KEY}`, {
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
})
if (checkRes.ok) {
  const existing = await checkRes.json()
  console.log(`\n✓ Location "${LOCATION_KEY}" already exists:`)
  console.log(JSON.stringify(existing, null, 2))
  process.exit(0)
}
if (checkRes.status !== 404) {
  console.error('Unexpected status checking location:', checkRes.status, await checkRes.text())
  process.exit(1)
}

// ── 4. Create the location ────────────────────────────────────────────────
const body = {
  location: {
    address: {
      addressLine1: 'Via Giovanni Pascoli, 58',
      city: 'Santarcangelo Di Romagna',
      country: 'IT',
      postalCode: '47822',
    },
  },
  locationTypes: ['WAREHOUSE'],
  name: 'Xavia Main',
  merchantLocationStatus: 'ENABLED',
}

console.log(`\nCreating location "${LOCATION_KEY}"…`)
console.log('Request body:', JSON.stringify(body, null, 2))

const createRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/location/${LOCATION_KEY}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT',
  },
  body: JSON.stringify(body),
})

const createText = await createRes.text()
if (createRes.ok || createRes.status === 204) {
  console.log(`\n✓ Location created successfully (HTTP ${createRes.status})`)
  if (createText) console.log(createText)
  console.log(`\nmerchandLocationKey to store: "${LOCATION_KEY}"`)
} else {
  console.error(`\n✗ Create failed (HTTP ${createRes.status}):`)
  console.error(createText)
  process.exit(1)
}
