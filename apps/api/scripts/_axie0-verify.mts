const { default: p } = await import('../src/db.js')
const q = async (label: string, sql: string) => {
  try {
    const r = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(sql)
    console.log(label, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
  } catch (e) { console.log(label, 'ERR', (e as Error).message.split('\n').find((l) => l.includes('Message:')) ?? 'failed') }
}
await q('MIGRATION_APPLIED', `SELECT migration_name::text, finished_at::text, rolled_back_at::text
  FROM _prisma_migrations WHERE migration_name = '20260728_axie0_correctness'`)
await q('COLUMNS', `SELECT table_name::text AS t, column_name::text AS c FROM information_schema.columns
  WHERE (table_name='Campaign' AND column_name='targetingType')
     OR (table_name='AmazonAdsConnection' AND column_name IN ('tokenIssuedAt','tokenExpiresAt','tokenIssuedAtIsEstimate'))
  ORDER BY 1,2`)
await q('TOKEN_BACKFILL', `SELECT marketplace, mode, "isActive",
  "tokenIssuedAt"::text AS issued, "tokenExpiresAt"::text AS expires,
  "tokenIssuedAtIsEstimate" AS est,
  EXTRACT(DAY FROM ("tokenExpiresAt" - now()))::int AS days_left
  FROM "AmazonAdsConnection" ORDER BY "tokenExpiresAt" LIMIT 4`)
await q('TARGETINGTYPE_FILL', `SELECT COALESCE("targetingType",'(null)') tt, count(*)::bigint n
  FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`)
await p.$disconnect()
