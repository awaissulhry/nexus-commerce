/**
 * HV page study — why 209 of 218 engine-written keywords carry no Amazon id. READ-ONLY.
 *
 * createKeywordLocal pushes to Amazon only when ALL of these hold:
 *   ag.externalAdGroupId && ag.campaign.externalCampaignId && ag.campaign.marketplace
 *   && resolveCtx(marketplace) != null
 *   && checkAdsWriteGate({ marketplace, payloadValueCents }).allowed
 * On any failure it still writes the local row and returns externalTargetId: null.
 * This determines WHICH gate closed.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ HV page — why graduations never reach Amazon ═══\n')

const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'create_keyword', userId: 'automation:auto-harvest' },
  select: { entityId: true, createdAt: true, payloadAfter: true },
})
const ids = logs.map((l) => l.entityId)
const tg = await prisma.adTarget.findMany({
  where: { id: { in: ids } },
  select: {
    id: true, expressionValue: true, expressionType: true, bidCents: true, externalTargetId: true, createdAt: true, lastSyncStatus: true, lastSyncError: true,
    adGroup: { select: { name: true, externalAdGroupId: true, campaign: { select: { name: true, externalCampaignId: true, marketplace: true, status: true, maxBidCents: true } } } },
  },
})
console.log(`engine-written keyword targets: ${int(tg.length)}`)
const noExt = tg.filter((t) => !t.externalTargetId)
console.log(`  with an Amazon id:    ${int(tg.length - noExt.length)}`)
console.log(`  WITHOUT an Amazon id: ${int(noExt.length)}\n`)

const bucket = new Map<string, number>()
for (const t of noExt) {
  const ag = t.adGroup
  const c = ag?.campaign
  const why = !ag?.externalAdGroupId ? 'ad group has no externalAdGroupId'
    : !c?.externalCampaignId ? 'campaign has no externalCampaignId'
      : !c?.marketplace ? 'campaign has no marketplace'
        : 'all three ids present → resolveCtx or the WRITE GATE refused'
  bucket.set(why, (bucket.get(why) ?? 0) + 1)
}
console.log('why the push was skipped:')
for (const [w, n] of [...bucket.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(w, 56)} ${int(n)}`)

// by marketplace + campaign, for the ones that had every id
const idsOk = noExt.filter((t) => t.adGroup?.externalAdGroupId && t.adGroup.campaign?.externalCampaignId && t.adGroup.campaign.marketplace)
const byMkt = new Map<string, number>()
for (const t of idsOk) byMkt.set(t.adGroup!.campaign!.marketplace!, (byMkt.get(t.adGroup!.campaign!.marketplace!) ?? 0) + 1)
console.log(`\nof the ${idsOk.length} with all ids present, by marketplace: ${[...byMkt.entries()].map(([m, n]) => `${m}=${n}`).join(' · ')}`)

// the write gate's own verdict, per marketplace, right now
console.log('\ncurrent write-gate verdict per marketplace (checkAdsWriteGate, 50c payload):')
try {
  const { checkAdsWriteGate } = await import('../src/services/advertising/ads-write-gate.js')
  for (const m of ['IT', 'DE', 'ES', 'FR']) {
    const g = await checkAdsWriteGate({ marketplace: m, payloadValueCents: 50 } as never)
    console.log(`  ${m}: ${JSON.stringify(g)}`)
  }
} catch (e) { console.log(`  could not evaluate: ${(e as Error).message}`) }

console.log(`\n${pad('campaign', 46)} ${pad('mkt', 4)} ${pad('status', 9)} ${pad('rows', 5)} ${pad('w/ id', 6)} ext campaign id?`)
const byCamp = new Map<string, { rows: number; withId: number; mkt: string; status: string; ext: boolean }>()
for (const t of tg) {
  const c = t.adGroup?.campaign
  const k = c?.name ?? '(no campaign)'
  const b = byCamp.get(k) ?? { rows: 0, withId: 0, mkt: c?.marketplace ?? '?', status: String(c?.status ?? '?'), ext: !!c?.externalCampaignId }
  b.rows++; if (t.externalTargetId) b.withId++
  byCamp.set(k, b)
}
for (const [name, b] of [...byCamp.entries()].sort((a, b2) => b2[1].rows - a[1].rows)) {
  console.log(`${pad(name, 46)} ${pad(b.mkt, 4)} ${pad(b.status, 9)} ${pad(String(b.rows), 5)} ${pad(String(b.withId), 6)} ${b.ext ? 'yes' : 'NO'}`)
}

// sync status — did anything try and fail?
const bySync = new Map<string, number>()
for (const t of tg) bySync.set(String(t.lastSyncStatus ?? '(never attempted)'), (bySync.get(String(t.lastSyncStatus ?? '(never attempted)')) ?? 0) + 1)
console.log(`\nlastSyncStatus: ${[...bySync.entries()].map(([s, n]) => `${s}=${n}`).join(' · ')}`)
const errs = tg.filter((t) => t.lastSyncError).slice(0, 5)
for (const e of errs) console.log(`  error on "${e.expressionValue}": ${e.lastSyncError?.slice(0, 160)}`)

// how the whole positive population compares
const allPos = await prisma.adTarget.groupBy({ by: ['status'], where: { kind: 'KEYWORD', isNegative: false }, _count: { _all: true } })
console.log(`\nall positive keywords by status: ${allPos.map((s) => `${s.status}=${int(s._count._all)}`).join(' · ')}`)
const noIdAll = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, externalTargetId: null } })
const totAll = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } })
console.log(`positive keywords with NO Amazon id: ${int(noIdAll)} of ${int(totAll)} (${Math.round((noIdAll / totAll) * 100)}%)`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
