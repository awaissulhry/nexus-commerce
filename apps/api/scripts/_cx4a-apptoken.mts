/**
 * Can we fetch an eBay application token at all? If not, EVERY genuine notification
 * would be rejected as `public_key_unavailable` — indistinguishable from a forged key
 * id, which is the exact failure class CX.4a exists to end. Never prints the token.
 */
import { ebayAppToken } from '../src/services/cx/connectors/ebay/client.js'
try {
  const t = await ebayAppToken('production')
  console.error(`ebayAppToken: OK (length ${t.length}, prefix ${t.slice(0, 3)}…)`)
  const res = await fetch('https://api.ebay.com/commerce/notification/v1/public_key/does-not-exist', {
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
  })
  const txt = await res.text()
  console.error(`getPublicKey(bogus kid) -> HTTP ${res.status}: ${txt.slice(0, 220)}`)
  console.error(`\nreading: a 4xx that is NOT 401/403 means the token was accepted and the KEY was the problem.`)
} catch (e: any) {
  console.error('ebayAppToken FAILED:', e?.message?.slice(0, 300))
}
process.exit(0)
