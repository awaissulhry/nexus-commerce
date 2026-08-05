const { default: p } = await import('../src/db.js')
const q = async (l:string,sql:string)=>{const r=await p.$queryRawUnsafe<Array<Record<string,unknown>>>(sql);console.log(l,JSON.stringify(r,(_k,v)=>typeof v==='bigint'?String(v):v))}
await q('CAMPAIGN', `SELECT count(*)::bigint n, count(*) FILTER (WHERE impressions>0)::bigint impr FROM "Campaign"`)
await q('ADGROUP',  `SELECT count(*)::bigint n, count(*) FILTER (WHERE impressions>0)::bigint impr FROM "AdGroup"`)
await q('ADTARGET', `SELECT count(*)::bigint n, count(*) FILTER (WHERE impressions>0)::bigint impr FROM "AdTarget"`)
await q('PRODUCTAD',`SELECT count(*)::bigint n, count(*) FILTER (WHERE impressions>0)::bigint impr FROM "AdProductAd"`)
await p.$disconnect()
