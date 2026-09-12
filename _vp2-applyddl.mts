import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
const url = process.argv[2], file = process.argv[3]
const p = new PrismaClient({ datasources: { db: { url } } })
const sql = readFileSync(file, 'utf8')
const label = url.includes('neon') ? 'NEON-PROD' : 'LOCAL-DOCKER'
const before: any[] = await p.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='ChannelListing' AND column_name='variationExcluded'`)
for (const stmt of sql.split(/;\s*$/m).map(s => s.trim()).filter(s => s && !s.split('\n').every(l => l.trim().startsWith('--')))) {
  await p.$executeRawUnsafe(stmt)
}
const after: any[] = await p.$queryRawUnsafe(`SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name='ChannelListing' AND column_name='variationExcluded'`)
const idx: any[] = await p.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE tablename='ChannelListing' AND indexname='ChannelListing_variationExcluded_idx'`)
const counts: any[] = await p.$queryRawUnsafe(`SELECT count(*)::int AS total, count(*) FILTER (WHERE "variationExcluded")::int AS excluded FROM "ChannelListing"`)
console.log(label, '| before:', before.length, '| after:', JSON.stringify(after[0] ?? null), '| index:', idx.length, '| rows:', JSON.stringify(counts[0]))
await p.$disconnect()
