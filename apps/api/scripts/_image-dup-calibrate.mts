// READ-ONLY calibration: for every same-product pair that the CURRENT gate
// blocks (aHash Hamming ≤ 6, different bytes), download both images and
// compute dHash at 64-bit (9×8) and 256-bit (17×16). Prints a sorted table
// so we can pick thresholds that separate "same shot re-exported" from
// "different image, same template" on the real catalog.
import sharp from 'sharp'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
const { default: prisma } = await import('../src/db.js')
const { hammingHex } = await import('../src/services/images/image-hash.service.js')

const CACHE = '/private/tmp/claude-501/-Users-awais-nexus-commerce/4ed21537-7199-4f6c-8994-2cfdeba0fa4c/scratchpad/imgcache'
mkdirSync(CACHE, { recursive: true })

async function fetchBuf(url: string): Promise<Buffer | null> {
  const key = createHash('md5').update(url).digest('hex')
  const path = `${CACHE}/${key}`
  if (existsSync(path)) return readFileSync(path)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(path, buf)
    return buf
  } catch { return null }
}

// dHash: resize to (w+1)×h grayscale, bit = pixel[x] > pixel[x+1] per row.
async function dHash(buf: Buffer, w: number, h: number): Promise<string> {
  const px = await sharp(buf).resize(w + 1, h, { fit: 'fill' }).grayscale().raw().toBuffer()
  const bits: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      bits.push(px[y * (w + 1) + x] > px[y * (w + 1) + x + 1] ? 1 : 0)
  let hex = ''
  for (let i = 0; i < bits.length; i += 4)
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16)
  return hex
}

const rows = await prisma.productImage.findMany({
  where: { mediaType: 'IMAGE', perceptualHash: { not: null } },
  select: { id: true, productId: true, url: true, contentHash: true, perceptualHash: true },
})
const byProduct = new Map<string, typeof rows>()
for (const r of rows) {
  const l = byProduct.get(r.productId) ?? []
  l.push(r); byProduct.set(r.productId, l)
}
type Pair = { urlA: string; urlB: string; aDist: number }
const pairs: Pair[] = []
const seen = new Set<string>()
for (const [, list] of byProduct) {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const d = hammingHex(list[i].perceptualHash!, list[j].perceptualHash!)
      if (d <= 6 && list[i].contentHash !== list[j].contentHash) {
        const key = [list[i].url, list[j].url].sort().join('|')
        if (!seen.has(key)) { seen.add(key); pairs.push({ urlA: list[i].url, urlB: list[j].url, aDist: d }) }
      }
    }
}
console.log(`Distinct blocked pairs: ${pairs.length}`)

const results: Array<{ aDist: number; d64: number; d256: number; urlA: string; urlB: string }> = []
let failed = 0
for (const p of pairs) {
  const [a, b] = await Promise.all([fetchBuf(p.urlA), fetchBuf(p.urlB)])
  if (!a || !b) { failed++; continue }
  try {
    const [a64, b64, a256, b256] = await Promise.all([
      dHash(a, 8, 8), dHash(b, 8, 8), dHash(a, 16, 16), dHash(b, 16, 16),
    ])
    results.push({ aDist: p.aDist, d64: hammingHex(a64, b64), d256: hammingHex(a256, b256), urlA: p.urlA, urlB: p.urlB })
  } catch { failed++ }
}
console.log(`Hashed pairs: ${results.length} | failed downloads/decodes: ${failed}`)

const buckets = (vals: number[], edges: number[]) => {
  const out: Record<string, number> = {}
  for (const v of vals) {
    const e = edges.find((x) => v <= x)
    out[e === undefined ? `>${edges[edges.length - 1]}` : `≤${e}`] = (out[e === undefined ? `>${edges[edges.length - 1]}` : `≤${e}`] ?? 0) + 1
  }
  return out
}
console.log('dHash-64 distribution over blocked pairs:', JSON.stringify(buckets(results.map((r) => r.d64), [2, 4, 6, 8, 12, 16, 24])))
console.log('dHash-256 distribution over blocked pairs:', JSON.stringify(buckets(results.map((r) => r.d256), [8, 16, 26, 38, 64, 96])))

results.sort((x, y) => x.d256 - y.d256)
console.log('\n10 LOWEST d256 (most similar under dHash — likely true re-exports):')
for (const r of results.slice(0, 10)) console.log(`  a=${r.aDist} d64=${r.d64} d256=${r.d256}\n    ${r.urlA}\n    ${r.urlB}`)
console.log('\n10 HIGHEST d256 (different content that aHash falsely merges):')
for (const r of results.slice(-10)) console.log(`  a=${r.aDist} d64=${r.d64} d256=${r.d256}\n    ${r.urlA}\n    ${r.urlB}`)

await prisma.$disconnect()
process.exit(0)
