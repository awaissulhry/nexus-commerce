#!/usr/bin/env node
// BT.1 verifier — AutomationRuleTemplate table + the exact create/list/delete the B3
// endpoints use. Direct Prisma against Neon (no HTTP server, no workers). Safe + cleans up.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: join(here, '..', '.env'), override: true }) // local env injector pre-sets DATABASE_URL; force the real .env value
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }

console.log('verify-budget-templates → AutomationRuleTemplate (Neon)')
const payload = {
  conditions: [{ conditions: [{ metric: 'ACOS', op: 'gt', value: '25' }], action: { op: 'incPct', value: '20' } }],
  lookback: 'Last 60 Days', exclude: 'Last 3 Days',
  schedule: { frequency: 'Daily', time: '00:00', timezone: 'pst' },
}
let created
try {
  // 1) create (mirrors POST /advertising/rule-templates)
  created = await prisma.automationRuleTemplate.create({
    data: { name: `__verify Budget tmpl ${Date.now()}`, type: 'budget', domain: 'advertising', payload, createdBy: 'verify' },
  })
  ok(!!created.id, 'create returns id')
  ok(created.domain === 'advertising' && created.type === 'budget', 'domain=advertising, type=budget stored')
  ok(created.payload?.conditions?.[0]?.action?.op === 'incPct', 'payload (criteria + THEN action) round-trips')

  // 2) list filtered by type (mirrors GET /advertising/rule-templates?type=budget)
  const list = await prisma.automationRuleTemplate.findMany({ where: { domain: 'advertising', type: 'budget' }, orderBy: { createdAt: 'desc' }, take: 200 })
  ok(list.some((t) => t.id === created.id), 'list ?type=budget includes the new template')

  // 3) delete (mirrors DELETE /advertising/rule-templates/:id) + verify gone
  await prisma.automationRuleTemplate.delete({ where: { id: created.id } })
  const gone = await prisma.automationRuleTemplate.findUnique({ where: { id: created.id } })
  ok(gone === null, 'delete removes it (cleanup — no test rows left)')
  created = null
} catch (e) {
  fail++; console.log('  ✗ threw:', e.message)
} finally {
  if (created?.id) { try { await prisma.automationRuleTemplate.delete({ where: { id: created.id } }) } catch { /* noop */ } }
  await prisma.$disconnect()
}
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
