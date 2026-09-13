import '../src/env.js'
const { default: p } = await import('../src/db.js')
const cols = await p.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string }>>(
  `SELECT column_name::text, data_type::text, is_nullable::text FROM information_schema.columns
   WHERE table_name='ReadinessIndex' AND column_name='variationSource'`)
console.log('column:', JSON.stringify(cols))
const idx = await p.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
  `SELECT indexname::text, indexdef::text FROM pg_indexes WHERE tablename='ReadinessIndex' AND indexname LIKE '%variationSource%'`)
console.log('index:', JSON.stringify(idx))
const rows = await p.$queryRawUnsafe<Array<{ total: bigint; stamped: bigint }>>(
  `SELECT count(*)::bigint total, count("variationSource")::bigint stamped FROM "ReadinessIndex"`)
console.log('ReadinessIndex rows:', Number(rows[0]!.total), '| with variationSource:', Number(rows[0]!.stamped), '(NULL = not computed, never "derived")')
await p.$disconnect()
