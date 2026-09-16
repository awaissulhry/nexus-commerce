/**
 * Asks eBay whether the production app may request every scope the Connect button sends.
 *
 * Why: eBay refuses the WHOLE consent request when ONE scope is outside the app's keyset, and
 * names none of them — the operator sees only `{"error_id":"invalid_scope","http_status_code":400}`.
 * 2026-09-16: `sell.logistics` and `commerce.catalog.readonly` had been in the list since CX.1
 * (08-29), so no eBay account could be connected. Nothing in the tree could see it: the list is
 * valid TypeScript and the OAuth tests stub eBay.
 *
 * How: GET the consent URL the Connect button opens and follow redirects only while they stay on
 * eBay's auth hosts. Accepted → eBay sends the browser on to signin.ebay.com (never fetched).
 * Refused → eBay answers with a JSON `error_id`. No sign-in, no token, no database, no write.
 *
 * Every run carries two controls, so a quiet network or a wrong app ID can never read as a clean
 * list ("could not measure" is not "measured clean"):
 *   - the base scope alone must be ACCEPTED — proves the app ID + RuName are right and eBay answers
 *   - a scope that does not exist must be REFUSED with invalid_scope — proves a refusal is visible
 * When the full list is refused, each scope is asked alone so the failure names the culprits.
 *
 * Env:  EBAY_CLIENT_ID, EBAY_RUNAME — the PRODUCTION keyset (the same names the API seeds from).
 *       EBAY_AUTH_BASE — optional, defaults to https://auth.ebay.com.
 * Exit: 0 eBay accepts every scope · 1 eBay refuses the list · 2 could not measure.
 *
 * Run from apps/api:  npx tsx scripts/check-ebay-consent-scopes.mts
 * Runs in .github/workflows/deploy-api.yml before the Railway deploy.
 */

import { EBAY_REQUIRED_SCOPES, EBAY_SCOPE_BASE } from '../src/services/cx/connectors/ebay/scopes.js'

type Verdict =
  | { kind: 'accepted' }
  | { kind: 'refused'; errorId: string; body: string }
  | { kind: 'unknown'; detail: string }

const clientId = process.env.EBAY_CLIENT_ID?.trim() ?? ''
const ruName = process.env.EBAY_RUNAME?.trim() ?? ''
const authBase = (process.env.EBAY_AUTH_BASE ?? 'https://auth.ebay.com').replace(/\/+$/, '')
const MAX_HOPS = 5
const ATTEMPTS = 3

function couldNotMeasure(message: string): never {
  console.error(`❌ eBay scope check could not measure: ${message}`)
  process.exit(2)
}

// Mirrors ebaySpec.auth: response_type=code, prompt=login, scopes joined by one space.
function consentUrl(scopes: string[]): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    scope: scopes.join(' '),
    state: 'nexus-scope-check',
    response_type: 'code',
    prompt: 'login',
  })
  return `${authBase}/oauth2/authorize?${params.toString()}`
}

async function askOnce(scopes: string[]): Promise<Verdict> {
  let url = consentUrl(scopes)
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Nexus eBay scope check)' }, signal: AbortSignal.timeout(15_000) })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url)
      if (next.hostname === 'signin.ebay.com') return { kind: 'accepted' }
      if (!/^auth\d*\.(sandbox\.)?ebay\.com$/.test(next.hostname)) return { kind: 'unknown', detail: `redirected off eBay's auth hosts to ${next.hostname}` }
      url = next.toString()
      continue
    }
    const body = (await res.text()).slice(0, 400)
    try {
      const parsed = JSON.parse(body) as { error_id?: unknown }
      if (typeof parsed.error_id === 'string') return { kind: 'refused', errorId: parsed.error_id, body }
    } catch { /* not JSON — fall through */ }
    return { kind: 'unknown', detail: `HTTP ${res.status} with no redirect and no error_id: ${body.slice(0, 120)}` }
  }
  return { kind: 'unknown', detail: `more than ${MAX_HOPS} redirects` }
}

async function ask(scopes: string[]): Promise<Verdict> {
  let last: Verdict = { kind: 'unknown', detail: 'not asked' }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      last = await askOnce(scopes)
    } catch (err) {
      last = { kind: 'unknown', detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    }
    if (last.kind !== 'unknown') return last
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt))
  }
  return last
}

if (!clientId || !ruName) couldNotMeasure('EBAY_CLIENT_ID and EBAY_RUNAME must both be set (the production app ID and RuName).')

const baseOnly = await ask([EBAY_SCOPE_BASE])
if (baseOnly.kind === 'refused') couldNotMeasure(`eBay refused the base scope alone (${baseOnly.errorId}). The app ID or RuName is wrong: ${baseOnly.body}`)
if (baseOnly.kind === 'unknown') couldNotMeasure(`control "base scope is accepted" did not answer — ${baseOnly.detail}`)

const fake = await ask([EBAY_SCOPE_BASE, `${EBAY_SCOPE_BASE}/nexus.scope-check.does-not-exist`])
if (fake.kind !== 'refused' || fake.errorId !== 'invalid_scope') {
  couldNotMeasure(`control "a fake scope is refused" returned ${fake.kind === 'refused' ? fake.errorId : fake.kind === 'unknown' ? fake.detail : 'accepted'} — a refusal would not be visible`)
}

const full = await ask(EBAY_REQUIRED_SCOPES)
if (full.kind === 'unknown') couldNotMeasure(`the full list did not answer — ${full.detail}`)
if (full.kind === 'accepted') {
  console.log(`✓ eBay accepts all ${EBAY_REQUIRED_SCOPES.length} consent scopes (controls: base accepted, fake refused)`)
  process.exit(0)
}

console.error(`❌ eBay refuses the consent request (${full.errorId}). Nobody can connect an eBay account with this list.`)
if (full.errorId === 'invalid_scope') {
  const refused: string[] = []
  for (const scope of EBAY_REQUIRED_SCOPES.filter((s) => s !== EBAY_SCOPE_BASE)) {
    const alone = await ask([EBAY_SCOPE_BASE, scope])
    if (alone.kind === 'unknown') couldNotMeasure(`asking for ${scope} alone did not answer — ${alone.detail}`)
    if (alone.kind === 'refused') refused.push(`${scope} (${alone.errorId})`)
  }
  if (refused.length) {
    console.error('   Scopes this app may not request:')
    for (const line of refused) console.error(`   - ${line}`)
    console.error('   Remove them from apps/api/src/services/cx/connectors/ebay/scopes.ts, or get them granted to the app at developer.ebay.com.')
  } else {
    console.error('   Every scope is accepted alone, so eBay refuses only the combination. Ask eBay developer support.')
  }
} else {
  console.error(`   eBay said: ${full.body}`)
}
process.exit(1)
