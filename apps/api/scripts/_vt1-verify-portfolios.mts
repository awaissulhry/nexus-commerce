/**
 * AX-VT.1 — READ-ONLY dry run of verifyCampaignPortfolios against the live Amazon account.
 *
 * Makes no writes: in dryRun mode the service only calls listCampaignsV3 (a read) and
 * reports. Pass APPLY=1 to actually repair MISSING_ON_AMAZON rows — that DOES write
 * (PATCH portfolioId per campaign), so it is opt-in and never the default.
 *
 * CONFLICT rows are never written in either mode: a campaign Amazon reports in a
 * different portfolio is somebody's Seller Central decision, not our bug to "fix".
 */
process.env.NEXUS_AMAZON_ADS_MODE = 'live'

const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

const { adsMode } = await import('../src/services/advertising/ads-api-client.js')
if (adsMode() !== 'live') { L('ABORT: not live'); process.exit(1) }

const apply = process.env.APPLY === '1'
L(`mode: ${apply ? '*** APPLY — will PATCH missing membership ***' : 'DRY RUN (read-only)'}\n`)

const { verifyCampaignPortfolios } = await import('../src/services/advertising/ads-create.service.js')
const r = await verifyCampaignPortfolios({ dryRun: !apply })

L('══ SUMMARY ═══════════════════════════════════════════════════════')
L(`  checked            ${r.checked}`)
L(`  agreed ✓           ${r.agreed}`)
L(`  MISSING on Amazon  ${r.missingOnAmazon}   ← the defect: we hold a portfolio, Amazon holds none`)
L(`  CONFLICT           ${r.conflicts}   ← Amazon has a DIFFERENT portfolio; never auto-touched`)
L(`  not on Amazon      ${r.notOnAmazon}`)
if (apply) L(`  repaired           ${r.repaired}\n  repair failed      ${r.repairFailed}`)
if (r.errors.length) L(`  errors: ${JSON.stringify(r.errors)}`)

const byVerdict = new Map<string, typeof r.rows>()
for (const row of r.rows) { const a = byVerdict.get(row.verdict) ?? []; a.push(row); byVerdict.set(row.verdict, a) }
for (const [v, rows] of byVerdict) {
  L(`\n══ ${v} (${rows.length}) ══════════════════════════════════════════`)
  for (const x of rows) {
    const flag = x.repaired === true ? ' REPAIRED ✓' : x.repaired === false ? ` FAILED: ${x.error}` : ''
    L(`  ${String(x.marketplace ?? '--').padEnd(3)} ${String(x.name).slice(0, 44).padEnd(46)} intended=${x.intended} amazon=${x.amazon ?? 'NONE'}${flag}`)
  }
}
await prisma.$disconnect().catch(() => {})
process.exit(0)
