/** RA.20 — read-only: provenance of the 51 advertising AutomationRules (who created them, when, activity). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rules = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT id, name, trigger, enabled, "autonomyLevel", "createdBy",
         to_char("createdAt", 'YYYY-MM-DD') AS created,
         "executionCount", to_char("lastExecutedAt", 'YYYY-MM-DD') AS last_exec,
         ("scopeMarketplace" IS NOT NULL) AS mkt_scoped
  FROM "AutomationRule" WHERE domain='advertising'
  ORDER BY "createdAt" ASC`)
console.log('RULES', JSON.stringify(rules, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1))

const byCreator = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COALESCE("createdBy",'(null)') AS creator, COUNT(*)::int AS n,
         MIN(to_char("createdAt",'YYYY-MM-DD')) AS first, MAX(to_char("createdAt",'YYYY-MM-DD')) AS last
  FROM "AutomationRule" WHERE domain='advertising' GROUP BY 1 ORDER BY 2 DESC`)
console.log('BY_CREATOR', JSON.stringify(byCreator, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))

const assign = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT kind, COUNT(*)::int AS n FROM "CampaignRuleAssignment" GROUP BY 1`)
console.log('ASSIGNMENTS', JSON.stringify(assign, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))

await prisma.$disconnect()
