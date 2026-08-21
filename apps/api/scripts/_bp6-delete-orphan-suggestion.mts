/**
 * BP.P6 — delete ORPHANED pending suggestions: rows whose rule no longer exists.
 *
 * The W7 wipe (2026-08-20) deleted all 51 legacy rules and their 305 pending suggestions, but
 * one earlier test row survived it: `__ea manual 1781961158143` (created 2026-06-20 by EA-series
 * testing), whose rule is long gone. It pins the Suggestions badge at 1 forever and its Approve
 * button points at nothing. A suggestion has no FK to its rule, so the cascade never reached it.
 *
 * DRY-RUN by default; pass --apply to delete. Run on deploy day, on the operator's command:
 *   cd apps/api && railway run npx tsx scripts/_bp6-delete-orphan-suggestion.mts [--apply]
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
  const pending = await prisma.adsRuleSuggestion.findMany({
    where: { status: 'pending' },
    select: { id: true, ruleId: true, ruleName: true, createdAt: true },
  })
  const ruleIds = [...new Set(pending.map((s) => s.ruleId).filter((v): v is string => v != null))]
  const existing = new Set(
    (await prisma.automationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true } })).map((r) => r.id),
  )
  const orphans = pending.filter((s) => s.ruleId == null || !existing.has(s.ruleId))
  console.log(`pending suggestions: ${pending.length} · orphaned (rule gone): ${orphans.length}`)
  for (const o of orphans) console.log(`  · ${o.id} — "${o.ruleName}" (rule ${o.ruleId ?? 'null'}, created ${o.createdAt.toISOString()})`)
  if (!orphans.length) return
  if (!APPLY) { console.log('\nDRY RUN — pass --apply to delete these rows.'); return }
  const res = await prisma.adsRuleSuggestion.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } })
  console.log(`deleted: ${res.count}`)
}

main().finally(() => prisma.$disconnect())
