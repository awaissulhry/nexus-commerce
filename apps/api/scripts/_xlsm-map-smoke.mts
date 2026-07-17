/**
 * A3 (XLSM hybrid) — real-file auto-map rate against the LIVE manifests.
 * Exit criterion: ≥95% of template headers map automatically, with the
 * remainder listed by name.
 *
 *   npx tsx scripts/_xlsm-map-smoke.mts
 */
import fs from 'node:fs'
import { detectAmazonTemplate } from '../src/services/amazon/template-workbook.js'
import { suggestFlatFileMapping } from '../src/services/amazon/flat-file-mapping.js'
import prisma from '../src/db.js'
import { AmazonService } from '../src/services/marketplaces/amazon.service.js'
import { CategorySchemaService } from '../src/services/categories/schema-sync.service.js'
import { AmazonFlatFileService } from '../src/services/amazon/flat-file.service.js'

const flatFileService = new AmazonFlatFileService(prisma, new CategorySchemaService(prisma, new AmazonService()))

const BASE = '/Users/awais/Desktop/2026/LISTNGS'
const FILES = [
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/IT/AIREON IT - FINAL (upload this)/AIREON IT.xlsm`,
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/DE/AIREON DE - FINAL (upload this)/AIREON DE.xlsm`,
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/ES/AIREON ES - FINAL (upload this)/AIREON ES.xlsm`,
  `${BASE}/JACKETS/AIREON/AMAZON/LISTINGS/FR/AIREON FR - FINAL (upload this)/AIREON FR.xlsm`,
  `${BASE}/SUITS/XAVIA X AAA/AMAZON/LISTINGS/IT/X-RACING IT - FINAL (upload this)/X-RACING IT.xlsm`,
]

let worst = 1
let attempted = 0
for (const f of FILES) {
  const name = f.split('/').pop()
  const parsed = await detectAmazonTemplate(new Uint8Array(fs.readFileSync(f)))
  if (!parsed) { console.log(`— ${name}: NOT DETECTED`); worst = 0; continue }
  const mp = parsed.meta.marketplace ?? 'IT'
  const types = parsed.meta.productTypes
  let manifest
  try {
    manifest = types.length > 1
      ? await flatFileService.generateUnionManifest(mp, types)
      : await flatFileService.generateManifest(mp, types[0])
  } catch (err) {
    console.log(`— ${name}: manifest fetch failed (${(err as Error).message}) — needs DB/SP-API; run on prod`)
    continue
  }
  const columns = manifest.groups
    .flatMap((g: any) => g.columns)
    .map((c: any) => ({ id: c.id, labelEn: c.labelEn, labelLocal: c.labelLocal, fieldRef: c.fieldRef }))
  attempted++
  const res = suggestFlatFileMapping(parsed.headers, columns)
  const total = res.mappings.length
  const bySource: Record<string, number> = {}
  for (const m of res.mappings) bySource[m.source] = (bySource[m.source] ?? 0) + 1
  const mapped = total - (bySource.none ?? 0)
  const rate = mapped / total
  worst = Math.min(worst, rate)
  console.log(`— ${name} [${mp} ${types.join('+')}]: ${mapped}/${total} mapped (${(rate * 100).toFixed(1)}%)`)
  console.log(`   sources: ${JSON.stringify(bySource)}`)
  if (res.unmappedHeaders.length > 0) {
    console.log(`   unmapped (${res.unmappedHeaders.length}):`)
    for (const h of res.unmappedHeaders.slice(0, 40)) console.log(`     · ${h}`)
    if (res.unmappedHeaders.length > 40) console.log(`     … +${res.unmappedHeaders.length - 40} more`)
  }
}
if (attempted === 0) {
  console.log('\nNO FILES CHECKED — manifests unavailable (DB/SP-API). Re-run where the DB is reachable (prod).')
  process.exit(1)
}
console.log(worst >= 0.95 ? `\nRATE OK (worst ${(worst * 100).toFixed(1)}%)` : `\nRATE BELOW TARGET (worst ${(worst * 100).toFixed(1)}%)`)
process.exit(worst >= 0.95 ? 0 : 1)
