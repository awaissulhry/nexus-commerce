/**
 * A2 (XLSM hybrid) — real-file smoke for the Amazon template reader.
 * Runs detectAmazonTemplate against the operator's five FINAL upload files
 * (read-only) and asserts the ground truth established 2026-07-16.
 *
 *   npx tsx scripts/_xlsm-template-smoke.mts
 */
import fs from 'node:fs'
import { detectAmazonTemplate } from '../src/services/amazon/template-workbook.js'

const BASE = '/Users/awais/Desktop/2026/LISTNGS'
const CASES = [
  {
    file: `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/IT/AIREON IT - FINAL (upload this)/AIREON IT.xlsm`,
    sheet: 'Modello', marketplace: 'IT', rows: 41, headerCount: 344,
    productTypes: ['COAT', 'PANTS'], actions: { replace: 0, partial: 41, delete: 0, unknown: 0 },
  },
  {
    file: `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/DE/AIREON DE - FINAL (upload this)/AIREON DE.xlsm`,
    sheet: 'Vorlage', marketplace: 'DE', rows: 41, headerCount: 352,
    productTypes: ['COAT', 'PANTS'], actions: { replace: 41, partial: 0, delete: 0, unknown: 0 },
  },
  {
    file: `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/ES/AIREON ES - FINAL (upload this)/AIREON ES.xlsm`,
    sheet: 'Plantilla', marketplace: 'ES', rows: 41, headerCount: 344,
    productTypes: ['COAT', 'PANTS'], actions: { replace: 41, partial: 0, delete: 0, unknown: 0 },
  },
  {
    file: `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/FR/AIREON FR - FINAL (upload this)/AIREON FR.xlsm`,
    sheet: 'Modèle', marketplace: 'FR', rows: 41, headerCount: 344,
    productTypes: ['COAT', 'PANTS'], actions: { replace: 41, partial: 0, delete: 0, unknown: 0 },
  },
  {
    file: `${BASE}/SUITS/XAVIA X AAA/AMAZON/LISTINGS/IT/X-RACING IT - FINAL (upload this)/X-RACING IT.xlsm`,
    sheet: 'Modello', marketplace: 'IT', rows: 50, headerCount: 252,
    productTypes: ['APPAREL'], actions: { replace: 50, partial: 0, delete: 0, unknown: 0 },
  },
]

let failures = 0
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { failures++; console.log(`   ✗ ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`) }
  else console.log(`   ✓ ${label} = ${JSON.stringify(actual)}`)
}

for (const c of CASES) {
  const name = c.file.split('/').pop()
  if (!fs.existsSync(c.file)) { console.log(`— ${name}: MISSING, skipped`); continue }
  const bytes = new Uint8Array(fs.readFileSync(c.file))
  const t0 = Date.now()
  const parsed = await detectAmazonTemplate(bytes)
  const ms = Date.now() - t0
  console.log(`— ${name} (${(bytes.length / 1024).toFixed(0)} KB) parsed in ${ms} ms`)
  if (!parsed) { failures++; console.log('   ✗ not detected as an Amazon template'); continue }
  check('sheet', parsed.meta.sheet, c.sheet)
  check('grammar', parsed.meta.grammar, 'v2')
  check('marketplace', parsed.meta.marketplace, c.marketplace)
  check('dataRows', parsed.rows.length, c.rows)
  check('headers', parsed.headers.length, c.headerCount)
  check('productTypes', parsed.meta.productTypes, c.productTypes)
  check('actions', parsed.meta.actions, c.actions)
  const sku = parsed.headers.findIndex((h) => h.startsWith('contribution_sku'))
  check('firstSkuHeaderIsCol1', sku, 0)
  const first = parsed.rows[0]
  console.log(`   first SKU: ${first[parsed.headers[0]]} | label[SKU]: ${parsed.labels[parsed.headers[0]] ?? '—'} | tid: ${parsed.meta.templateIdentifier}`)
  if (ms > 3000) { failures++; console.log(`   ✗ too slow (${ms} ms > 3000 ms)`) }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
