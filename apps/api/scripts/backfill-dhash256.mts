/**
 * IE.13 — Backfill ProductImage.dhash256 for rows created before the
 * dual-hash near-dup gate. Downloads each image (Cloudinary or
 * Amazon-synced URL), computes the 256-bit dHash, writes it back.
 *
 * Run from apps/api:  npx tsx scripts/backfill-dhash256.mts
 *
 * Safe to re-run: only rows with dhash256 IS NULL are touched, so an
 * interrupted run resumes where it left off. Rows whose download or
 * decode fails are logged and skipped (they stay NULL — the gate
 * fails open for them). Also fills perceptualHash when missing so the
 * two hashes stay in lockstep. Concurrency 5, per-fetch timeout 20s.
 */
const { default: prisma } = await import('../src/db.js')
const { aHashBuffer, dHash256Buffer } = await import('../src/services/images/image-hash.service.js')

const CONCURRENCY = 5

const rows = await prisma.productImage.findMany({
  where: { mediaType: 'IMAGE', dhash256: null },
  select: { id: true, url: true, perceptualHash: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`Rows to backfill: ${rows.length}`)

let done = 0
let failed = 0
const failures: Array<{ id: string; url: string; reason: string }> = []

async function processRow(row: { id: string; url: string; perceptualHash: string | null }): Promise<void> {
  try {
    const res = await fetch(row.url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const dhash256 = await dHash256Buffer(buf)
    const perceptualHash = row.perceptualHash ?? await aHashBuffer(buf)
    await prisma.productImage.update({
      where: { id: row.id },
      data: { dhash256, perceptualHash },
    })
    done++
  } catch (e) {
    failed++
    failures.push({ id: row.id, url: row.url, reason: e instanceof Error ? e.message : String(e) })
  }
  if ((done + failed) % 100 === 0) console.log(`  ${done + failed}/${rows.length} (${failed} failed)`)
}

const queue = [...rows]
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) await processRow(row)
  }),
)

console.log(`\nBackfilled: ${done} | failed: ${failed}`)
for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f.id} ${f.reason} ${f.url}`)
if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`)

await prisma.$disconnect()
process.exit(failed > 0 && done === 0 ? 1 : 0)
