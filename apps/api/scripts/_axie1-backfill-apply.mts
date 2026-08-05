/** AX-IE.1 — apply. Idempotent delete-then-insert scoped to channel=AMAZON.
 *  Never writes Generation A (Campaign/AdGroup/AdTarget/AmazonAdsDailyPerformance). */
await import('../src/db.js')
const { backfillAmazonShadow } = await import('../src/services/marketing/amazon-backfill.service.js')
const r = await backfillAmazonShadow({ apply: true })
console.log('APPLIED', JSON.stringify(r, null, 2))
process.exit(0)
