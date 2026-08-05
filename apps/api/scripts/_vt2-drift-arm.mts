/**
 * AX-VT.2 verification, step 1 — ARM.
 *
 * Creates the exact condition the fix must detect, WITHOUT touching Amazon: pick a campaign
 * that is in no portfolio (locally null, therefore null on Amazon too, since the portfolio
 * sync converges membership from Amazon) and give it a local portfolioId. Amazon will report
 * portfolioId: null, we hold a value — the state that was silently skipped for every campaign,
 * every cycle, and produced zero drift rows across 62 genuinely-wrong campaigns.
 *
 * DB-only. No Amazon write. _vt2-drift-check.mts disarms and restores.
 */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const PF = '190601227863497' // IT AIREON — any real portfolio works; we only need a non-null local value

const cand = await p.campaign.findFirst({
  where: { portfolioId: null, externalCampaignId: { not: null }, marketplace: 'IT', status: { not: 'ARCHIVED' } },
  select: { id: true, name: true, externalCampaignId: true, status: true },
  orderBy: { createdAt: 'asc' },
})
if (!cand) { L('no candidate campaign found'); process.exit(1) }

L(`candidate: ${cand.name}  (${cand.status})  local=${cand.id}  amazon=${cand.externalCampaignId}`)

const existingDrift = await p.adDrift.findFirst({ where: { entityType: 'CAMPAIGN', entityId: cand.id, field: 'portfolioId' } })
L(`pre-existing portfolioId drift row: ${existingDrift ? 'YES (will be reused)' : 'none'}`)

await p.campaign.update({ where: { id: cand.id }, data: { portfolioId: PF } })
L(`\nARMED: local portfolioId set to ${PF}. Amazon still reports none.`)
L(`Now trigger the bulk settings sync on prod, then run _vt2-drift-check.mts`)
L(`\nRESTORE TOKEN (pass to the check script): ${cand.id}`)
process.exit(0)
