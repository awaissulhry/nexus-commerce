const { default: p } = await import('../src/db.js')
const r = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(
  `SELECT conname::text, pg_get_constraintdef(oid)::text def FROM pg_constraint
   WHERE conrelid='"AdvertisingActionLog"'::regclass AND contype='f'`)
console.log('FKS', JSON.stringify(r))
await p.$disconnect()
