/**
 * PLC-P4 — the refusal path, against the REAL write gate.
 *
 * 🔴 NOT run against `ZZ_e2e_single_wwq7s`: that campaign's `liveBidWritesEnabled` is TRUE, the
 * account is not halted and it carries an external id, so a real `placement_apply` there would
 * push a multiplier to Amazon. The phase plan assumed it was gate-closed; it is not.
 *
 * Run instead against a PAUSED, gate-closed campaign, where `checkAdsWriteGate` denies at
 * `campaign_allowlist`. A denial returns BEFORE `campaign.update` and before any Amazon call, so
 * nothing is mutated — asserted below, before and after. The one side effect is an
 * AdvertisingActionLog row recording the blocked attempt, which is what that path is for.
 *
 * What this adds over the unit test: proof that the gate REALLY populates `reason`/`deniedAt`, not
 * just that the handler forwards them when a mock does.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ACTION_HANDLERS } = await import('../src/services/automation-rule.service.js')
await import('../src/services/advertising/automation-action-handlers.js')

const target = await prisma.campaign.findFirst({
  where: { status: 'PAUSED', liveBidWritesEnabled: false, externalCampaignId: { not: null }, adProduct: 'SPONSORED_PRODUCTS' },
  select: { id: true, name: true, dynamicBidding: true, marketplace: true },
})
if (!target) { console.log('no gate-closed campaign found — nothing to test against'); process.exit(1) }
console.log(`target: "${target.name}" [${target.id}] ${target.marketplace} · gate CLOSED · PAUSED`)

const before = JSON.stringify(target.dynamicBidding)
const histBefore = await prisma.campaignBidHistory.count({ where: { campaignId: target.id, field: { startsWith: 'PLACEMENT' } } })
console.log(`before: dynamicBidding=${before} · placement history rows=${histBefore}\n`)

const res = await (ACTION_HANDLERS.placement_apply as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; error?: string; output?: Record<string, unknown> }>)(
  { campaignId: target.id, placement: 'PLACEMENT_TOP', op: 'set', value: 25, minPct: 0, maxPct: 900, type: 'placement_apply' },
  {}, { dryRun: false, ruleId: 'plcp4-refusal-probe' },
)
console.log('handler result:')
console.log(JSON.stringify(res, null, 2))

const after = await prisma.campaign.findUnique({ where: { id: target.id }, select: { dynamicBidding: true } })
const histAfter = await prisma.campaignBidHistory.count({ where: { campaignId: target.id, field: { startsWith: 'PLACEMENT' } } })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? '  ✓' : '  ✗'} ${n} — ${d}`); ok ? pass++ : fail++ }
console.log('')
check('the write was REFUSED', res.ok === false, `ok=${res.ok}`)
check('🔴 the refusal carries the gate\'s own sentence', typeof res.error === 'string' && res.error.length > 0, JSON.stringify(res.error))
check('🔴 it names WHICH gate refused', typeof res.output?.deniedAt === 'string', JSON.stringify(res.output?.deniedAt))
check('mode is blocked', res.output?.mode === 'blocked', String(res.output?.mode))
check('nothing was mutated locally', JSON.stringify(after?.dynamicBidding) === before, 'dynamicBidding unchanged')
check('no history row was manufactured', histAfter === histBefore, `${histBefore} → ${histAfter}`)

const log = await prisma.advertisingActionLog.findFirst({
  where: { entityId: target.id, actionType: 'update_placement_bidding' },
  orderBy: { createdAt: 'desc' },
  select: { amazonResponseStatus: true, payloadAfter: true, userId: true, createdAt: true },
})
check('the blocked attempt is recorded as FAILED, not SUCCESS', log?.amazonResponseStatus === 'FAILED',
  `${log?.amazonResponseStatus} by ${log?.userId} at ${log?.createdAt.toISOString()}`)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
