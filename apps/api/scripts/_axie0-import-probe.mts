const { default: p } = await import('../src/db.js')
const c = await p.campaign.findFirst({
  where: { externalCampaignId: { not: null }, dailyBudget: { gt: 0 } },
  select: { externalCampaignId: true, name: true, dailyBudget: true, status: true },
})
const ag = await p.adGroup.findFirst({ where: { externalAdGroupId: { not: null } }, select: { externalAdGroupId: true } })
console.log('CAMPAIGN', JSON.stringify(c))
console.log('ADGROUP', JSON.stringify(ag))
await p.$disconnect()
