import { getStudioSheet } from './apps/api/src/services/pim/studio-sheet.service.js'
import { PrismaClient } from '@prisma/client'
const GALE='cmokmy3a40078pm0p1fvnu523'
const db=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL!}}})
for (const mp of ['IT','DE','FR','ES']) {
  try {
    const s = await getStudioSheet({ productId: GALE, scope:'channel', channel:'EBAY', market: mp, includeMapping:false })
    const cols = s.columns.filter((c:any)=>['color','size'].includes(c.key))
    console.log(`EBAY/${mp}: ${s.columns.length} cols | axis cols: ${cols.map((c:any)=>c.key).join(',')||'NONE'}`)
    const row = s.rows.find((r:any)=>!r.isParent)
    for (const c of cols as any[]) {
      const cell = row?.values?.[c.key]
      console.log(`   ${c.key}: editable=${c.editable} writeField=${c.writeField} | cell.writable=${cell?.writable} cell.writeTarget=${cell?.writeTarget} blocked=${JSON.stringify(cell?.writeBlockedReason)}`)
    }
  } catch (e:any) { console.log(`EBAY/${mp}: sheet FAILED — ${e.message?.slice(0,90)}`) }
  const l = await db.channelListing.findFirst({ where:{ productId: GALE, channel:'EBAY', marketplace: mp, aliasKey:'' }, select:{ platformAttributes:true, listingStatus:true, externalListingId:true } })
  const pa=(l?.platformAttributes??{}) as any
  console.log(`   listing: status=${l?.listingStatus??'(none)'} ext=${l?.externalListingId??'null'} detectedCategoryId=${JSON.stringify(pa.detectedCategoryId??pa.categoryId??null)}`)
}
const m = await getStudioSheet({ productId: GALE, scope:'master', market:'IT', includeMapping:false })
const mc = m.columns.filter((c:any)=>['color','size'].includes(c.key))
console.log('\nMASTER has axis cols:', mc.map((c:any)=>`${c.key}(${c.writeField}, ${c.writeTarget})`).join(' '))
await db.$disconnect(); process.exit(0)
