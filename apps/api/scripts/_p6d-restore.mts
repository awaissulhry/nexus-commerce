/** 🔴 Restore the invariant every ads reader depends on.
 *
 *  `salesCents = sales7dCents + sales14dCents` appears in ~10 readers and is correct ONLY because
 *  exactly one of the two is populated per row: SP writes 7d and a hard 0 to 14d, SB writes 14d.
 *
 *  SPC.1's widened ingest — never landed, but run locally against production on 2026-08-20 —
 *  wrote a REAL sales14d for 301 SPONSORED_PRODUCTS rows. Those rows are summed with themselves:
 *  measured over the last 30 days, EUR 18,953 shown against EUR 9,483 true, and every affected
 *  ACoS is halved (ES_Phrase_3_Keywords reads 20.6% when it is 45.3%). Rules read ACoS, so the
 *  automation is being suppressed by the same arithmetic.
 *
 *  SCOPE, deliberately tight:
 *    · SPONSORED_PRODUCTS only — SB rows legitimately carry their sales here.
 *    · `> 0` only — the 3,785 SP rows holding a literal 0 are what the DEPLOYED ingest writes and
 *      add nothing to the sum. Touching them would be noise.
 *
 *  Set to NULL rather than 0, matching 20260820d's treatment: NULL says "this window is not part
 *  of this row's ingest contract", where 0 would assert Amazon reported zero 14-day sales. Both
 *  are identical to every current reader; only NULL is true.
 *
 *  NOT the permanent fix. The readers must become adProduct-aware before SPC.1 can ever land —
 *  see reference_sales_7d_14d_double_count. This stops the bleeding; it does not close the wound.
 */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('   ' + Object.entries(x).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
const win = `"entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "date" >= CURRENT_DATE - 30`

console.log('=== BEFORE — what the Ad Manager shows over 30 days ===')
t(await q(`SELECT ROUND((SUM("sales7dCents"+COALESCE("sales14dCents",0))/100.0)::numeric,2) AS shown_eur,
   ROUND((SUM("sales7dCents")/100.0)::numeric,2) AS true_eur,
   ROUND((100*(SUM("costMicros")/1e6)/NULLIF(SUM("sales7dCents"+COALESCE("sales14dCents",0))/100.0,0))::numeric,1) AS acos_shown,
   ROUND((100*(SUM("costMicros")/1e6)/NULLIF(SUM("sales7dCents")/100.0,0))::numeric,1) AS acos_true
 FROM "AmazonAdsDailyPerformance" WHERE ${win}`))
t(await q(`SELECT COUNT(*)::bigint AS rows_to_fix FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "sales14dCents" > 0`))

const n = await prisma.$executeRawUnsafe(
  `UPDATE "AmazonAdsDailyPerformance" SET "sales14dCents" = NULL
   WHERE "entityType"='CAMPAIGN' AND "adProduct" = 'SPONSORED_PRODUCTS' AND "sales14dCents" > 0`)
console.log(`\nrows corrected: ${n}   (expected 301)`)

console.log('\n=== AFTER ===')
t(await q(`SELECT ROUND((SUM("sales7dCents"+COALESCE("sales14dCents",0))/100.0)::numeric,2) AS shown_eur,
   ROUND((SUM("sales7dCents")/100.0)::numeric,2) AS true_eur,
   ROUND((100*(SUM("costMicros")/1e6)/NULLIF(SUM("sales7dCents"+COALESCE("sales14dCents",0))/100.0,0))::numeric,1) AS acos_shown,
   ROUND((100*(SUM("costMicros")/1e6)/NULLIF(SUM("sales7dCents")/100.0,0))::numeric,1) AS acos_true
 FROM "AmazonAdsDailyPerformance" WHERE ${win}`))
console.log('   ^ shown_eur must now EQUAL true_eur, and acos_shown must equal acos_true')

console.log('\n=== Sponsored Brands untouched? ===')
t(await q(`SELECT COUNT(*)::bigint AS sb_rows, COUNT("sales14dCents")::bigint AS sb_keeping_their_14d,
   COALESCE(SUM("sales14dCents"),0)::bigint AS sb_sales_cents
 FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_BRANDS'`))
console.log('\n=== any SP row still inflating? ===')
t(await q(`SELECT COUNT(*)::bigint AS remaining FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "sales14dCents" > 0`))
await prisma.$disconnect()
