import { PrismaClient } from '@prisma/client'
const p=new PrismaClient({datasources:{db:{url:process.argv[2]}}})
const t:any[] = await p.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%valuemap%' OR table_name ILIKE '%sizescale%' ORDER BY 1`)
console.log('tables:', t.map(r=>r.table_name).join(', ') || '(none)')
for (const tn of t.map(r=>r.table_name)) {
  const n:any[] = await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${tn}"`)
  console.log(`  ${tn}: ${n[0].n} rows`)
  if (n[0].n) { const s:any[] = await p.$queryRawUnsafe(`SELECT * FROM "${tn}" LIMIT 4`); for (const r of s) console.log('    ', JSON.stringify(r).slice(0,220)) }
}
await p.$disconnect()
