import { getStudioSheet } from './apps/api/src/services/pim/studio-sheet.service.js'
const GALE='cmokmy3a40078pm0p1fvnu523'
for (const [ch,mp] of [['AMAZON','PL'],['ETSY','GLOBAL'],['EBAY','IT']]) {
  try {
    const s=await getStudioSheet({ productId:GALE, scope:'channel', channel:ch, market:mp, includeMapping:false })
    const row=(s.rows as any[]).find(r=>!r.isParent)
    console.log(`${ch}/${mp}: columns=${s.columns.length} schemaMissing=${JSON.stringify(s.meta.schemaMissing)}`)
    console.log(`   child completeness: ${JSON.stringify(row?.completeness?.overall)} required=${JSON.stringify(row?.completeness?.required)}`)
    console.log(`   -> my read relays readiness.pct = ${row?.completeness?.overall?.pct}`)
  } catch(e:any){ console.log(`${ch}/${mp}: THREW ${e.constructor.name} ${String(e.message).slice(0,70)}`) }
}
process.exit(0)
