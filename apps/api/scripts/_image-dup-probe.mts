// READ-ONLY probe: quantify aHash near-dup false positives across the catalog.
// For every product, compare all perceptualHash pairs; a pair with Hamming ≤ 6
// but different contentHash is exactly what the upload gate would block today.
const { default: prisma } = await import('../src/db.js')
const { hammingHex } = await import('../src/services/images/image-hash.service.js')

const rows = await prisma.productImage.findMany({
  where: { mediaType: 'IMAGE' },
  select: { id: true, productId: true, url: true, type: true, contentHash: true, perceptualHash: true },
})

const total = rows.length
const withP = rows.filter((r) => r.perceptualHash)
const withC = rows.filter((r) => r.contentHash)
console.log(`ProductImage rows: ${total} | with perceptualHash: ${withP.length} | with contentHash: ${withC.length}`)

const byProduct = new Map<string, typeof withP>()
for (const r of withP) {
  const list = byProduct.get(r.productId) ?? []
  list.push(r)
  byProduct.set(r.productId, list)
}

const dist: Record<string, number> = {}
type Pair = { productId: string; a: string; b: string; d: number; urlA: string; urlB: string; sameBytes: boolean }
const collisions: Pair[] = []
let pairsTotal = 0
for (const [productId, list] of byProduct) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = hammingHex(list[i].perceptualHash!, list[j].perceptualHash!)
      pairsTotal++
      const bucket = d <= 2 ? String(d) : d <= 6 ? '3-6' : d <= 10 ? '7-10' : d <= 16 ? '11-16' : '>16'
      dist[bucket] = (dist[bucket] ?? 0) + 1
      if (d <= 6) {
        collisions.push({
          productId,
          a: list[i].id, b: list[j].id, d,
          urlA: list[i].url, urlB: list[j].url,
          sameBytes: !!list[i].contentHash && list[i].contentHash === list[j].contentHash,
        })
      }
    }
  }
}

console.log(`\nSame-product pairs compared: ${pairsTotal}`)
console.log('Distance distribution:', JSON.stringify(dist))
const falsePos = collisions.filter((c) => !c.sameBytes)
console.log(`\nPairs ≤ 6 (would 409 on upload): ${collisions.length} | of those with DIFFERENT bytes: ${falsePos.length}`)

// How many products are affected (any ≤6 different-bytes pair)?
const affected = new Set(falsePos.map((c) => c.productId))
console.log(`Products with at least one different-bytes collision: ${affected.size} / ${byProduct.size}`)

console.log('\nSample colliding pairs (different bytes, closest first):')
falsePos.sort((x, y) => x.d - y.d)
for (const c of falsePos.slice(0, 15)) {
  console.log(`  d=${c.d} product=${c.productId}\n    A: ${c.urlA}\n    B: ${c.urlB}`)
}

await prisma.$disconnect()
process.exit(0)
