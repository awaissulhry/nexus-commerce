/** ADM.8 — every numeric column on the ads fact tables: is it ALIVE, all-zero, or all-null?
 *  An all-zero column with a name we render is an ingest gap wearing the clothes of a reading. */
import prisma from '../src/db.js'

async function sweep(table: string, where = '') {
  const cols = await prisma.$queryRawUnsafe<any[]>(`
    SELECT column_name::text AS c, data_type::text AS t FROM information_schema.columns
    WHERE table_name=$1 AND data_type IN ('integer','bigint','numeric','double precision','real','smallint')
    ORDER BY ordinal_position`, table)
  console.log(`\n=== ${table} ${where ? '('+where+')' : ''} — ${cols.length} numeric columns ===`)
  const dead: string[] = [], zero: string[] = [], alive: string[] = []
  for (const { c } of cols) {
    const r = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int rows, COUNT("${c}")::int nn, SUM(CASE WHEN "${c}" <> 0 THEN 1 ELSE 0 END)::int nz FROM "${table}" ${where ? 'WHERE '+where : ''}`)
    const x = r[0]
    if (x.nn === 0) dead.push(c)
    else if ((x.nz ?? 0) === 0) zero.push(`${c}(${x.nn} rows, all 0)`)
    else alive.push(c)
  }
  console.log(`  ALIVE (${alive.length}): ${alive.join(', ')}`)
  console.log(`  🔴 ALWAYS ZERO (${zero.length}): ${zero.join(', ') || '—'}`)
  console.log(`  🔴 ALWAYS NULL (${dead.length}): ${dead.join(', ') || '—'}`)
}
await sweep('AmazonAdsDailyPerformance', `"entityType"='CAMPAIGN'`)
await sweep('AmazonAdsPlacementReport')
await prisma.$disconnect()
