import { getStudioSheet } from './apps/api/src/services/pim/studio-sheet.service.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
for (const [ch,mp] of [['EBAY','IT'],['AMAZON','IT']]) {
  const s=await getStudioSheet({ productId:GALE, scope:'channel', channel:ch, market:mp, includeMapping:false })
  const row=(s.rows as any[]).find(r=>!r.isParent)
  const o=row.completeness.overall, q=row.completeness.required
  console.log(`${ch}/${mp} child ${row.sku}`)
  console.log(`   readiness.state        = ${row.readiness.state}   (issues: ${row.readiness.issues.length})`)
  console.log(`   completeness.overall   = ${o.filled}/${o.total} = ${o.pct}%   <- what I put in readiness.pct`)
  console.log(`   completeness.required  = ${q.filled}/${q.total} = ${q.total?Math.round(100*q.filled/q.total):null}%  <- what the house's readiness uses`)
  console.log(`   => my field says "readiness: { pct: ${o.pct}, state: '${row.readiness.state}' }" — two different measurements, one name`)
}
process.exit(0)
