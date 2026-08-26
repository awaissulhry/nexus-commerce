// Prints a non-reversible fingerprint of the prod ANTHROPIC_API_KEY so the
// operator can match it against console.anthropic.com — never the key itself.
import { createHash } from 'node:crypto'
const k = process.env.ANTHROPIC_API_KEY ?? ''
if (!k) { console.log('ANTHROPIC_API_KEY: NOT SET'); process.exit(0) }
console.log('length:', k.length)
console.log('last 4 chars:', '…' + k.slice(-4))
console.log('sha256[0:12]:', createHash('sha256').update(k).digest('hex').slice(0, 12))
