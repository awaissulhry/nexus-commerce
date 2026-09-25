/** GALE IT after apply: which Amazon IT values does Nexus hold that the full-replace file does NOT carry (Amazon would clear them)? */
import { readFileSync, writeFileSync } from 'node:fs'
const API = '/Users/awais/nexus-commerce/apps/api/src'
const OUT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/860563e3-4083-4cae-95e2-45981fb48a2e/scratchpad/runs/out'
if (!/@127\.0\.0\.1:55439\/nexus_cfi_20260924$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing: not the clone')
const { default: prisma } = await import(`${API}/db.ts`)
const { readTransferFile } = await import(`${API}/services/pim/catalog-transfer-file.ts`)
const imported = JSON.parse(readFileSync(`${OUT}/s01-gale-it.json`, 'utf8'))
const back = await readTransferFile(readFileSync(`${OUT}/rt2-gale-it-editing-nexus-catalog-editing.xlsx`), 'x.xlsx')
const have = new Set((imported.rawRows as any[]).map(r => `${r.sku}|${r.field}`))
const excludedByDesign = new Set(['price', 'salePrice', 'quantity', 'fulfillment_availability', 'list_price', 'purchasable_offer', 'parentSku', 'family', 'brand', 'condition_type'])
const extra = (back.rows as any[]).filter(r => r.channel === 'AMAZON' && r.marketplace === 'IT' && r.entity !== 'Listings' && r.value !== undefined && r.value !== null && r.value !== '' && !(Array.isArray(r.value) && !r.value.length) && r.action !== 'INHERIT' && !have.has(`${r.sku}|${r.field}`))
const byField = new Map<string, number>()
for (const r of extra) byField.set(r.field, (byField.get(r.field) ?? 0) + 1)
const out = { rowsNotInFile: extra.length, fields: [...byField.entries()].sort((a, b) => b[1] - a[1]), sample: extra.slice(0, 12).map(r => ({ sku: r.sku, field: r.field, locale: r.locale, action: r.action, value: r.value })) }
writeFileSync(`${OUT}/rt3-gale-it-held-not-in-file.json`, JSON.stringify(out, null, 1))
console.log(JSON.stringify({ rowsNotInFile: out.rowsNotInFile, fields: out.fields.slice(0, 40) }))
process.exit(0)
