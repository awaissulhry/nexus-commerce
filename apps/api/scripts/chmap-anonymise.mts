/**
 * CHMAP M5 (study §8.6, decision D2 A) — make an ANONYMISED copy of one of the Owner's Amazon templates for the
 * public repo's golden tests. The template itself (sheets, settings, Amazon's dictionaries and value lists, keys,
 * labels) is kept byte-for-byte where it is Amazon's; everything that is the Owner's is replaced, consistently:
 *   SKUs and parent SKUs · titles, bullets, descriptions, keywords, brand/manufacturer/model names · ASINs/EANs ·
 *   image and document links · prices · the seller's contributor id · the template instance id · file authorship.
 * A replacement is deterministic (same original → same fake, across files), so parent/child links survive.
 * The copy is then SCANNED: no original private value may remain anywhere in the zip, or the script fails.
 *
 *   cd apps/api && npx tsx scripts/chmap-anonymise.mts --in "<real file>" --out "<fixture path>"
 */
import { readFileSync, writeFileSync } from 'node:fs'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const IN = arg('in'), OUT = arg('out')
if (!IN || !OUT) throw new Error('--in and --out are required')
const { anonymiseAmazonTemplate } = await import('./lib/chmap-anonymise-lib.mts')

const result = await anonymiseAmazonTemplate(readFileSync(IN))
if (result.leaks.length) { console.error(`LEAK — ${result.leaks.length} original values remain:\n${result.leaks.slice(0, 20).join('\n')}`); process.exit(1) }
writeFileSync(OUT, result.bytes)
console.log(JSON.stringify({ in: IN.split('/').at(-1), out: OUT, rows: result.rows, replacedValues: result.fake.size, bytes: result.bytes.length, scan: 'no original private value found' }))
process.exit(0)
