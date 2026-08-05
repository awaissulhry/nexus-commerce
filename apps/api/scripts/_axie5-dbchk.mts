const { default: p } = await import('../src/db.js')
const r = await p.campaign.findMany({ where: { name: { in: ['AIR MESH BROAD','AIREON JACKET AUTO'] } },
  select: { name: true, biddingStrategy: true, dailyBudget: true, updatedAt: true, settingsSyncedAt: true } })
for (const c of r) console.log(`DB    ${c.name.padEnd(20)} strategy=${c.biddingStrategy} budget=${c.dailyBudget} updated=${c.updatedAt.toISOString()} settingsSynced=${c.settingsSyncedAt?.toISOString()}`)
await p.$disconnect()
