/**
 * Heal the 19 SD/SB campaigns that H.12 wrongly archived.
 *
 * Amazon reports all 19 as PAUSED (verified live via /advertising/launches/verify — 19/19 `state`
 * deltas of archived→paused, zero ENABLED, zero missing). Local says ARCHIVED. Amazon is source of
 * truth for state, so this aligns us to it.
 *
 * SPEND-NEUTRAL BY CONSTRUCTION: a campaign Amazon has paused cannot serve, so restoring the local
 * row to PAUSED cannot start spend. It only makes ~€1,075/day of paused budget VISIBLE again, which
 * is the point — these were invisible, and the engines and the operator both need to see them.
 *
 * Deliberately sets PAUSED and nothing else: not ENABLED (that would be inventing an intent Amazon
 * does not report), and it does not touch liveBidWritesEnabled, budgets or portfolios — all of which
 * the verifier confirmed already agree.
 *
 * Reversible: set status back to ARCHIVED. Safe to re-run. DRY=1 to preview.
 * The H.12 fix (643384b8f) is deployed, so the settings sync will not re-archive these.
 */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)
const dry = process.env.DRY === '1'

const rows = await p.campaign.findMany({
  where: { adProduct: { in: ['SPONSORED_DISPLAY', 'SPONSORED_BRANDS'] }, status: 'ARCHIVED', externalCampaignId: { not: null } },
  select: { id: true, name: true, adProduct: true, marketplace: true, dailyBudget: true },
  orderBy: [{ adProduct: 'asc' }, { marketplace: 'asc' }],
})

L(`${dry ? 'DRY RUN — ' : ''}${rows.length} campaign(s) ARCHIVED locally, PAUSED on Amazon\n`)
let budget = 0
for (const r of rows) {
  budget += Number(r.dailyBudget ?? 0)
  L(`  ${r.adProduct.replace('SPONSORED_', '').padEnd(8)} ${String(r.marketplace).padEnd(3)} ${String(r.name).slice(0, 40).padEnd(42)} ARCHIVED → PAUSED   budget €${r.dailyBudget}/day`)
}
L(`\n  total paused budget made visible: €${budget}/day (cannot spend — Amazon has them paused)`)

if (dry) { L('\nDRY=1 — nothing written.'); process.exit(0) }

const res = await p.campaign.updateMany({
  where: { id: { in: rows.map((r: any) => r.id) } },
  data: { status: 'PAUSED' },
})
L(`\nHEALED: ${res.count} campaign(s) set ARCHIVED → PAUSED, matching Amazon.`)

const left = await p.campaign.count({ where: { adProduct: { in: ['SPONSORED_DISPLAY', 'SPONSORED_BRANDS'] }, status: 'ARCHIVED' } })
L(`SD/SB still ARCHIVED locally: ${left} (expect 0)`)
process.exit(0)
