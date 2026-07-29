// AX3.1 verification — READ-ONLY. The source tree the picker will render, and
// proof that selecting a portfolio / individual campaigns / individual ad groups
// all resolve correctly. No writes, no Amazon calls.
const { loadSourceTree, loadSourceCampaigns } = await import('../src/services/advertising/ads-blueprint.service.js')
const { extractBlueprint } = await import('../src/services/ads-core/ads-blueprint.js')
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

const { portfolios } = await loadSourceTree({ marketplace: 'IT' })
L(`── source tree (IT): ${portfolios.length} groups ──────────────────────`)
for (const p of portfolios) {
  const ags = p.campaigns.reduce((n, c) => n + c.adGroups.length, 0)
  const pos = p.campaigns.reduce((n, c) => n + c.positives, 0)
  L(`  ${p.name.padEnd(30)} ${String(p.campaigns.length).padStart(3)} campaigns · ${String(ags).padStart(3)} ad groups · ${String(pos).padStart(4)} positives · €${p.dailyBudgetTotal.toFixed(2)}/day`)
}

// Roles, now that deriveRole handles all five conventions.
L('\n── roles per convention (was: only the dash one parsed) ───────────────')
const cases: Array<[string, Record<string, unknown>, string]> = [
  ['IT AIREON  (dash)', { portfolioId: '190601227863497' }, 'AIREON'],
  ['Xavia GALE (pipe)', { portfolioId: '255127157311072' }, 'GALE'],
  ['IT_Gale (underscore)', { portfolioId: '182512333091276' }, 'GALE'],
  ['Moss_Jacket (token last)', { portfolioId: '181885525106359' }, 'MOSS'],
]
for (const [label, sel, token] of cases) {
  const { campaigns } = await loadSourceCampaigns({ ...sel, marketplace: 'IT' })
  const doc = extractBlueprint(campaigns, { productToken: token })
  const roles = doc.campaigns.map((c) => c.role)
  L(`  ${label}`)
  L(`     ${roles.join(', ').slice(0, 160)}`)
  L(`     unique: ${new Set(roles.map((r) => r.toLowerCase())).size}/${roles.length}${new Set(roles.map((r) => r.toLowerCase())).size === roles.length ? ' ✓' : '  ← COLLISION'}`)
}

// Granularity: portfolio → a subset of campaigns → a single ad group.
L('\n── selection granularity ──────────────────────────────────────────────')
const pf = await loadSourceCampaigns({ portfolioId: '190601227863497', marketplace: 'IT' })
L(`  by portfolioId          → ${pf.campaigns.length} campaigns, ${pf.campaigns.reduce((n, c) => n + c.adGroups.length, 0)} ad groups`)

const someIds = pf.ids.slice(0, 3)
const sub = await loadSourceCampaigns({ campaignIds: someIds, marketplace: 'IT' })
L(`  by 3 campaignIds        → ${sub.campaigns.length} campaigns, ${sub.campaigns.reduce((n, c) => n + c.adGroups.length, 0)} ad groups`)

const ags = await prisma.adGroup.findMany({ where: { campaignId: { in: pf.ids } }, select: { id: true, name: true }, take: 2 })
const byAg = await loadSourceCampaigns({ adGroupIds: ags.map((a) => a.id), marketplace: 'IT' })
L(`  by 2 adGroupIds         → ${byAg.campaigns.length} campaigns, ${byAg.campaigns.reduce((n, c) => n + c.adGroups.length, 0)} ad groups (parents resolved automatically)`)
L(`     ${byAg.campaigns.map((c) => `${c.name} [${c.adGroups.map((g) => g.name).join(', ')}]`).join(' · ').slice(0, 170)}`)

const oneAg = await loadSourceCampaigns({ adGroupIds: [ags[0]!.id], marketplace: 'IT' })
const oneDoc = extractBlueprint(oneAg.campaigns, { productToken: 'AIREON' })
L(`  by 1 adGroupId          → ${oneDoc.stats.campaigns} campaign · ${oneDoc.stats.adGroups} ad group · ${oneDoc.stats.positives} positives · ${oneDoc.stats.negatives} negatives`)

await prisma.$disconnect()
