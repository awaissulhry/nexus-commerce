import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
await import('../src/services/advertising/automation-action-handlers.js')
const { ACTION_HANDLERS } = await import('../src/services/automation-rule.service.js')
const h: any = (ACTION_HANDLERS as any).bid_apply
const out: any = {}

// Pick one real target of each kind and run bid_apply in dryRun — writes nothing.
const pick = async (where: any) => prisma.adTarget.findFirst({
  where: { kind: 'KEYWORD', isNegative: false, ...where },
  select: { id: true, bidCents: true, suppressedFromBidCents: true, expressionValue: true,
    adGroup: { select: { campaignId: true, campaign: { select: { name: true, bidsSuppressedAt: true, liveBidWritesEnabled: true } } } } },
})
const cases: Array<[string, any]> = [
  ['flagged',        { suppressedFromBidCents: { not: null } }],
  ['low bid (<=3c)', { suppressedFromBidCents: null, bidCents: { lte: 3 } }],
  ['campaign supp.', { adGroup: { campaign: { bidsSuppressedAt: { not: null } } }, suppressedFromBidCents: null, bidCents: { gt: 3 } }],
  ['normal',         { suppressedFromBidCents: null, bidCents: { gt: 20 } }],
]
out.cases = []
for (const [label, where] of cases) {
  const t = await pick(where)
  if (!t) { out.cases.push({ label, found: false }); continue }
  const res = await h({ type: 'bid_apply', op: 'set', value: 0.80, campaignIds: [] }, { adTarget: { id: t.id } }, { dryRun: true, ruleId: 'ktp6-verify' })
  out.cases.push({ label, keyword: t.expressionValue, bidCents: t.bidCents, flag: t.suppressedFromBidCents,
    campaignSuppressed: t.adGroup?.campaign?.bidsSuppressedAt != null, result: res.output })
}
// Population the guard now protects
const pop = await prisma.$queryRawUnsafe<any[]>(`
  SELECT count(*)::int reachable,
         count(*) FILTER (WHERE t."suppressedFromBidCents" IS NOT NULL)::int flagged,
         count(*) FILTER (WHERE t."suppressedFromBidCents" IS NULL AND t."bidCents" <= 3)::int low_unflagged,
         count(*) FILTER (WHERE c."bidsSuppressedAt" IS NOT NULL)::int in_suppressed_campaign
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t.kind='KEYWORD' AND t."isNegative"=false AND c."liveBidWritesEnabled"=true`)
out.protected = pop[0]
console.log('===JSON===' + JSON.stringify(out, (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await prisma.$disconnect()
