/** SPC.3 — how long does a completed v3 report URL stay fetchable? READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
const jobs = await p.amazonAdsReportJob.findMany({
  where: { status: 'COMPLETED', location: { not: null } },
  orderBy: { completedAt: 'desc' }, take: 6,
  select: { id: true, reportTypeId: true, completedAt: true, location: true, fileSize: true },
})
for (const j of jobs) {
  const ageMin = j.completedAt ? Math.round((Date.now() - j.completedAt.getTime()) / 60000) : null
  let verdict: string
  try {
    const r = await fetch(j.location!, { method: 'GET', headers: { Range: 'bytes=0-64' } })
    verdict = r.ok || r.status === 206 ? `ALIVE (${r.status})` : `DEAD (${r.status})`
  } catch (e) { verdict = `DEAD (${(e as Error).message.slice(0, 40)})` }
  console.log(`${String(ageMin).padStart(5)} min old  ${j.reportTypeId.padEnd(20)} ${String(j.fileSize ?? '').padStart(7)}B  ${verdict}`)
}
await p.$disconnect()
