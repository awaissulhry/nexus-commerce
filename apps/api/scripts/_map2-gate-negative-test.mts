/** Negative test: does the section-4 gate ABORT when the backfill is incomplete?
 *  Runs the migration with ONE backfill UPDATE removed, inside a rolled-back
 *  transaction. A gate that has never refused is an unproven gate. */
await import('../src/env.js')
const fs = await import('node:fs')
const { default: pg } = await import('pg')
const url = (process.env.DATABASE_URL ?? '').replace('-pooler', '')
let sql = fs.readFileSync('/Users/awais/nexus-commerce/packages/database/prisma/migrations/20260819a_map2_account_dimension/migration.sql', 'utf8')

// Sabotage: neuter the ChannelListing backfill so 977 rows stay unattributed.
const before = sql
sql = sql.replace(
  `UPDATE "ChannelListing" t SET "channelConnectionId" = (
  SELECT c.id FROM "ChannelConnection" c
  WHERE c."channelType" = t.channel AND c."isActive" = true
  ORDER BY c."updatedAt" DESC LIMIT 1
) WHERE t."channelConnectionId" IS NULL;`,
  `-- (sabotaged for the negative test: ChannelListing backfill removed)`)
if (sql === before) { console.log('SABOTAGE FAILED TO APPLY — test is invalid'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()
await c.query('BEGIN')
try {
  await c.query(sql)
  console.log('BAD: the gate did NOT fire. It would have dropped the index on a partial backfill.')
} catch (e: any) {
  console.log('GOOD: the gate refused and aborted the transaction.')
  console.log('  message:', e?.message)
  // Prove the index drop never happened.
  await c.query('ROLLBACK'); await c.query('BEGIN')
  const ix = await c.query(`SELECT indexname::text AS n FROM pg_indexes WHERE indexname='ChannelConnection_channelType_marketplace_active_key'`)
  console.log('  original singleton index still present:', ix.rows.length === 1)
} finally {
  await c.query('ROLLBACK')
  console.log('ROLLED BACK - nothing was committed.')
  await c.end()
}
