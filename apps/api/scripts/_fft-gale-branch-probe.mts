/** FFT-I2 — replicate the familyId cluster branch's exact queries, step by step. */
const prisma = (await import('../src/db.js')).default

const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
if (!gale) { console.log('no GALE-JACKET'); process.exit(0) }
const familyId = gale.id
console.log('familyId =', familyId)

// Step 1 — the family fetch
const fam = await prisma.product.findMany({
  where: { deletedAt: null, OR: [{ id: familyId }, { parentId: familyId }] },
  select: { id: true, sku: true },
})
console.log(`fam: ${fam.length} products; skus sample: ${fam.slice(0, 6).map((p) => p.sku).join(', ')}${fam.length > 6 ? '…' : ''}`)

const ids = new Set<string>([familyId])
for (const p of fam) ids.add(p.id)
const famSkus = fam.map((p) => p.sku).filter(Boolean)

// Step 2 — the membership match
const memberships = await prisma.sharedListingMembership.findMany({
  where: {
    status: 'ACTIVE',
    OR: [
      { productId: { in: [...ids] } },
      ...(famSkus.length ? [{ parentSku: { in: famSkus } }] : []),
    ],
  },
  select: { parentSku: true, productId: true, itemId: true, sku: true },
})
console.log(`memberships matched: ${memberships.length}`)
const nullPid = memberships.filter((m) => !m.productId).length
console.log(`  productId NULL on ${nullPid}/${memberships.length}`)
const byParent = new Map<string, number>()
for (const m of memberships) byParent.set(m.parentSku ?? '?', (byParent.get(m.parentSku ?? '?') ?? 0) + 1)
console.log('  by parentSku:', JSON.stringify([...byParent.entries()]))

// Step 3 — how many memberships' productIds are actually IN the family ids?
const inFam = memberships.filter((m) => m.productId && ids.has(m.productId)).length
console.log(`  memberships whose productId ∈ family ids: ${inFam}`)

// Cross-check: ALL GALE memberships' productIds — do they point at pool children?
const allGale = await prisma.sharedListingMembership.findMany({
  where: { sku: { contains: 'GALE' } },
  select: { productId: true, sku: true, parentSku: true },
})
const pids = [...new Set(allGale.map((m) => m.productId).filter((v): v is string => !!v))]
const linked = pids.length
  ? await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, sku: true, parentId: true, deletedAt: true } })
  : []
const linkedById = new Map(linked.map((l) => [l.id, l]))
let toPool = 0, toElsewhere = 0, dangling = 0
for (const m of allGale) {
  if (!m.productId) continue
  const l = linkedById.get(m.productId)
  if (!l) { dangling++; continue }
  if (l.parentId === familyId) toPool++
  else toElsewhere++
}
console.log(`allGale memberships: ${allGale.length}; linked→poolChild=${toPool} linked→elsewhere=${toElsewhere} dangling=${dangling}`)
if (toElsewhere > 0) {
  const sample = allGale.map((m) => ({ m, l: m.productId ? linkedById.get(m.productId) : undefined }))
    .filter((x) => x.l && x.l.parentId !== familyId).slice(0, 5)
  for (const s of sample) console.log(`  elsewhere: mem(sku=${s.m.sku}, parentSku=${s.m.parentSku}) → product(sku=${s.l!.sku}, parentId=${s.l!.parentId}, deletedAt=${s.l!.deletedAt ? 'SET' : 'null'})`)
}
await prisma.$disconnect()
process.exit(0)
