// READ-ONLY: after the dhash256 backfill, replay the near-dup gate over
// every same-product pair and compare old rule (aHash ≤ 6) vs new rule
// (aHash ≤ 6 AND dhash256 ≤ 26).
const { default: prisma } = await import('../src/db.js')
const { hammingHex, NEAR_DUP_HAMMING_THRESHOLD, DHASH256_NEAR_DUP_THRESHOLD } = await import('../src/services/images/image-hash.service.js')

const rows = await prisma.productImage.findMany({
  where: { mediaType: 'IMAGE', perceptualHash: { not: null } },
  select: { productId: true, url: true, contentHash: true, perceptualHash: true, dhash256: true },
})
console.log(`rows: ${rows.length} | with dhash256: ${rows.filter((r) => r.dhash256).length}`)

const byProduct = new Map<string, typeof rows>()
for (const r of rows) {
  const l = byProduct.get(r.productId) ?? []
  l.push(r); byProduct.set(r.productId, l)
}
let oldFlagged = 0
let newFlagged = 0
const stillFlagged = new Set<string>()
for (const [, list] of byProduct) {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = hammingHex(list[i].perceptualHash!, list[j].perceptualHash!)
      if (a > NEAR_DUP_HAMMING_THRESHOLD) continue
      oldFlagged++
      if (!list[i].dhash256 || !list[j].dhash256) continue
      const d = hammingHex(list[i].dhash256!, list[j].dhash256!)
      if (d <= DHASH256_NEAR_DUP_THRESHOLD) {
        newFlagged++
        stillFlagged.add([list[i].url, list[j].url].sort().join(' | '))
      }
    }
}
console.log(`old rule (aHash only) flags: ${oldFlagged} pairs`)
console.log(`new rule (dual hash)  flags: ${newFlagged} pairs (${stillFlagged.size} distinct URL pairs)`)
console.log('\nStill-flagged distinct pairs (operator will see the review modal):')
for (const p of [...stillFlagged].slice(0, 12)) console.log('  ' + p)
await prisma.$disconnect()
process.exit(0)
