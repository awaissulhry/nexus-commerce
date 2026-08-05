/** AX-IE.1 — dry run only. apply=false writes nothing. */
await import('../src/db.js')
const { backfillAmazonShadow } = await import('../src/services/marketing/amazon-backfill.service.js')
const r = await backfillAmazonShadow({ apply: false })
console.log('DRYRUN', JSON.stringify(r, null, 2))
process.exit(0)
