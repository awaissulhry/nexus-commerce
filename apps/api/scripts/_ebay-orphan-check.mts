/** READ-ONLY. create-connection makes a row BEFORE the token exchange, so an
 *  abandoned attempt strands an inactive, tokenless orphan. How many? */
const { default: prisma } = await import('../src/db.js')
const all = await prisma.channelConnection.findMany({ where: { channelType: 'EBAY' }, select: { id: true, isActive: true, accessToken: true, externalAccountId: true, createdAt: true } })
const orphans = all.filter(r => !r.isActive && !r.accessToken && !r.externalAccountId)
console.log(`eBay rows: ${all.length}   active: ${all.filter(r=>r.isActive).length}   tokenless inactive orphans: ${orphans.length}`)
for (const o of orphans) console.log(`  orphan ${o.createdAt.toISOString()}  ${o.id}`)
console.log('\nACTIVE accounts:')
for (const r of all.filter(x=>x.isActive)) console.log(`  ${r.id}  extId=${JSON.stringify(r.externalAccountId)}`)
await prisma.$disconnect()
