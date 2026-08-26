// RD-P4 — exercise the shipped service end to end against prod. Read-only.
import '../src/env.js'
import prisma from '../src/db.js'
import { getRankRuntime } from '../src/services/advertising/rank-runtime.service.js'

async function main() {
  const t0 = Date.now()
  const p = await getRankRuntime()
  console.log(`getRankRuntime OK in ${Date.now() - t0}ms · campaigns=${p.campaigns.length} groups=${p.groups.length} clock=${JSON.stringify(p.clock)}`)
  const byFresh: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  for (const c of p.campaigns) {
    byFresh[c.signal.freshness] = (byFresh[c.signal.freshness] ?? 0) + 1
    byKind[c.signal.kind] = (byKind[c.signal.kind] ?? 0) + 1
  }
  console.log('freshness:', JSON.stringify(byFresh))
  console.log('kind     :', JSON.stringify(byKind))
  console.log('\n=== rows with a BASIS (the axis SQP measured as decisive) ===')
  const withBasis = p.campaigns.filter((c) => c.signal.contributors && c.signal.contributors.total > 0)
  console.log(`campaigns with an ASIN basis: ${withBasis.length}`)
  for (const c of withBasis.slice(0, 8)) {
    const b = c.signal.contributors!
    console.log(`  ${c.campaignName.slice(0, 30).padEnd(30)} ${String(c.signal.label).padEnd(24)} basis=${b.withData}/${b.total} freshness=${c.signal.freshness}`)
  }
  console.log('\n=== stale rows and WHY ===')
  const stale = p.campaigns.filter((c) => c.signal.freshness === 'stale')
  console.log(`stale: ${stale.length}`)
  for (const c of stale.slice(0, 5)) console.log(`  ${c.campaignName.slice(0, 30).padEnd(30)} ${c.signal.staleReason}`)
  console.log('\n=== never-covered (onboarding, not cron) ===')
  const never = p.campaigns.filter((c) => c.signal.kind === 'no-coverage')
  console.log(`no-coverage: ${never.length}`)
  for (const c of never.slice(0, 3)) console.log(`  ${c.campaignName.slice(0, 30).padEnd(30)} ${c.signal.detail}`)
}
main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
