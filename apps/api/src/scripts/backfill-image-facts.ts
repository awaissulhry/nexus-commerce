/**
 * Images rebuild P1 (docs/images-studio-rebuild/MEASURE.md) — fill the photo facts the channel checks need:
 * width/height/mime/size (419 photos have none, so "too small" cannot be judged) and the near-duplicate hashes
 * (214 Motovento photos have no dhash256, so the upload gate fails open for them).
 *
 * DRY RUN by default: counts the rows and downloads at most 5 to show what would be written. `--apply` writes.
 * Only NULL fields are filled — nothing already known is overwritten — so an interrupted run resumes safely.
 * Downloads go through the safe fetcher (public addresses only, 30 s, size-capped). No channel is called.
 *
 *   npx tsx src/scripts/backfill-image-facts.ts [--workspace <id>] [--apply] [--limit <n>]
 */
import sharp from 'sharp'
import prisma from '../db.js'
import { withWorkspace } from '../lib/workspace-context.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { fetchCatalogSource } from '../services/pim/catalog-source-fetch.js'
import { aHashBuffer, dHash256Buffer } from '../services/images/image-hash.service.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const APPLY = argv.includes('--apply')
const LIMIT = Number(flag('limit') ?? Infinity)
const WORKSPACE = flag('workspace')
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', tiff: 'image/tiff', avif: 'image/avif', heif: 'image/heif' }

type Row = { id: string; url: string; width: number | null; height: number | null; mimeType: string | null; fileSize: number | null; dhash256: string | null; perceptualHash: string | null }

async function facts(row: Row) {
  const { buffer } = await fetchCatalogSource(row.url)
  const meta = await sharp(buffer, { limitInputPixels: 64_000_000 }).metadata()
  const data: Record<string, unknown> = {}
  if (row.width == null && meta.width) data.width = meta.width
  if (row.height == null && meta.height) data.height = meta.height
  if (row.mimeType == null && meta.format && MIME[meta.format]) data.mimeType = MIME[meta.format]
  if (row.fileSize == null) data.fileSize = buffer.length
  if (row.dhash256 == null) data.dhash256 = await dHash256Buffer(buffer)
  if (row.perceptualHash == null) data.perceptualHash = await aHashBuffer(buffer)
  return data
}

async function business() {
  const rows: Row[] = await prisma.productImage.findMany({
    where: { mediaType: 'IMAGE', OR: [{ width: null }, { height: null }, { dhash256: null }] },
    select: { id: true, url: true, width: true, height: true, mimeType: true, fileSize: true, dhash256: true, perceptualHash: true },
    orderBy: { createdAt: 'asc' }, ...(Number.isFinite(LIMIT) ? { take: LIMIT } : {}),
  })
  const noSize = rows.filter(r => r.width == null || r.height == null).length, noHash = rows.filter(r => r.dhash256 == null).length
  console.log(`[image-facts] ${rows.length} photos to complete · ${noSize} without size · ${noHash} without dhash256`)
  const todo = APPLY ? rows : rows.slice(0, 5)
  let next = 0, written = 0
  const failures: string[] = []
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    while (next < todo.length) {
      const row = todo[next++]
      try {
        const data = await facts(row)
        if (!APPLY) { console.log(`[image-facts] would set ${row.id}: ${JSON.stringify({ ...data, dhash256: data.dhash256 ? '…' : undefined, perceptualHash: data.perceptualHash ? '…' : undefined })}`); continue }
        // Only still-NULL fields: a concurrent upload or a second run never has a value overwritten.
        const guard = { id: row.id, ...(data.width !== undefined ? { width: null } : {}), ...(data.dhash256 !== undefined ? { dhash256: null } : {}) }
        written += (await prisma.productImage.updateMany({ where: guard, data })).count
      } catch (error) { failures.push(`${row.id}: ${(error as Error).message}`) }
    }
  }))
  console.log(`[image-facts] ${APPLY ? `written ${written}` : 'DRY RUN — nothing written'} · failed ${failures.length}`)
  for (const failure of failures.slice(0, 20)) console.log(`[image-facts]   ${failure}`)
}

async function main() {
  const [{ d: database }] = (await prisma.$queryRawUnsafe(`select current_database()::text as d`)) as Array<{ d: string }>
  console.log(`[image-facts] database ${database} · ${APPLY ? 'APPLY' : 'DRY RUN'}${WORKSPACE ? ` · business ${WORKSPACE}` : ' · every active business'}`)
  if (WORKSPACE) await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, business)
  else await visitActiveWorkspaces(business)
  process.exit(0)
}

main().catch(error => { console.error(error); process.exit(1) })
