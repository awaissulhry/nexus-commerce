/**
 * Cap own-top-allout's max CPC.
 *
 * all-out deliberately IGNORES the ACoS cap — that is its job. But maxCpcCents is null, which the
 * schema documents as "truly unbounded", so today it is the only target with no ceiling of any
 * kind. maxCpcCents is described in the model as the runaway guard; this sets it.
 *
 * Dry-run unless "apply" is passed. Only maxCpcCents changes — allOut, bias and placement stay as
 * they are, so the behaviour is unchanged except that it now has a floor under the worst case.
 */
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const APPLY = process.argv[2] === 'apply'
const CAP_CENTS = Number(process.argv[3] ?? 150)

const t = await p.rankTarget.findFirst({ where: { key: 'own-top-allout' } })
if (!t) { console.log('own-top-allout not found'); process.exit(1) }
console.log(`own-top-allout  BEFORE: maxCpc=${t.maxCpcCents != null ? `€${(t.maxCpcCents/100).toFixed(2)}` : 'NONE (unbounded)'}  allOut=${t.allOut}  acosCap=${t.acosCapPct ?? '—'}  maxBias=${t.maxBiasPct ?? 900}%`)
console.log(`                AFTER : maxCpc=€${(CAP_CENTS/100).toFixed(2)}   (everything else unchanged)`)

if (!APPLY) { console.log('\nDRY RUN — pass "apply" to write.'); await p.$disconnect(); process.exit(0) }
const u = await p.rankTarget.update({ where: { id: t.id }, data: { maxCpcCents: CAP_CENTS } })
console.log(`\nAPPLIED — maxCpcCents = ${u.maxCpcCents} (€${(u.maxCpcCents!/100).toFixed(2)})`)
console.log('Takes effect on the next rank-defend tick (within 15 minutes).')
await p.$disconnect()
