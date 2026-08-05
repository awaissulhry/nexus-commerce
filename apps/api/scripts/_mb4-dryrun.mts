/**
 * READ-ONLY MB.4 dry run: if the CPC ceiling were enforced, what would change?
 *
 * Uses the SAME pure functions the engine will use (cpcCapPct / strategyHeadroom /
 * resolveActiveTargetKey / biasBand), so this is the engine's own arithmetic rather than a
 * paraphrase of it. Writes nothing.
 */
const { default: prisma } = await import('../src/db.js')
const { cpcCapPct, strategyHeadroom, resolveActiveTargetKey, biasBand } = await import('../src/services/advertising/rank-controller.js')

type Ov = Record<string, { biasPct?: number; maxCpcCents?: number; maxBiasPct?: number }>
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)

const targets = await prisma.rankTarget.findMany()
const byKey = new Map(targets.map((t) => [t.key, t]))
const scheds = await prisma.adSchedule.findMany({ where: { enabled: true } })
const goal = scheds.filter((s) => s.defaultTargetKey || (Array.isArray(s.windows) && (s.windows as Array<{ targetKey?: string }>).some((w) => w?.targetKey)))
const campIds = [...new Set(goal.map((s) => s.campaignId))]
const camps = await prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true, biddingStrategy: true, dynamicBidding: true } })
const campById = new Map(camps.map((c) => [c.id, c]))

// Highest live base bid per campaign — exactly the job's rule (restore value counts).
const maxBase = new Map<string, number>()
const ags = await prisma.adGroup.findMany({ where: { campaignId: { in: campIds } }, select: { id: true, campaignId: true, defaultBidCents: true, suppressedFromBidCents: true } })
for (const g of ags) {
  const v = Math.max(g.defaultBidCents ?? 0, g.suppressedFromBidCents ?? 0)
  if (v > (maxBase.get(g.campaignId) ?? 0)) maxBase.set(g.campaignId, v)
}
const campByAg = new Map(ags.map((g) => [g.id, g.campaignId]))
const tgs = await prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: campIds } }, isNegative: false }, select: { adGroupId: true, bidCents: true, suppressedFromBidCents: true } })
for (const t of tgs) {
  const cid = campByAg.get(t.adGroupId); if (!cid) continue
  const v = Math.max(t.bidCents ?? 0, t.suppressedFromBidCents ?? 0)
  if (v > (maxBase.get(cid) ?? 0)) maxBase.set(cid, v)
}

const now = new Date()
const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now)
const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')!.value)
const hour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10) % 24
console.log(`\n=== MB.4 DRY RUN · Europe/Rome ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]} ${String(hour).padStart(2,'0')}:00 · ${goal.length} goal-mode schedules ===\n`)

let nowCapped = 0, everCapped = 0, baseAlone = 0, noCeiling = 0
const rows: string[] = []
const everRows: string[] = []

for (const s of goal) {
  const camp = campById.get(s.campaignId); if (!camp) continue
  const ov = (s.targetOverrides ?? {}) as Ov
  const base = maxBase.get(camp.id) ?? null
  const mult = strategyHeadroom(camp.biddingStrategy)
  const cdb = (camp.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }

  // Every distinct target this schedule can reach, not just the one live this minute.
  const keys = new Set<string>()
  if (s.defaultTargetKey) keys.add(s.defaultTargetKey)
  for (const w of (s.windows ?? []) as Array<{ targetKey?: string }>) if (w?.targetKey) keys.add(w.targetKey)
  const activeKey = resolveActiveTargetKey(s.windows as never, s.defaultTargetKey, day, hour)

  for (const k of keys) {
    const t = byKey.get(k); if (!t || t.pause) continue
    const maxCpc = ov[k]?.maxCpcCents ?? t.maxCpcCents
    const bias = ov[k]?.biasPct ?? t.biasPct
    const ceilOv = ov[k]?.maxBiasPct ?? t.maxBiasPct
    const band = biasBand({ biasPct: bias, maxBiasPct: ceilOv, allOut: t.allOut })
    if (maxCpc == null) { if (t.allOut) noCeiling++; continue }
    const cap = cpcCapPct(maxCpc, base, mult)
    if (!cap) continue
    const reach = band.ceiling // the highest % this target may reach today
    if (cap.baseAlone) baseAlone++
    if (reach > cap.capPct) {
      everCapped++
      everRows.push(`  ${camp.name.padEnd(34).slice(0, 34)} ${k.padEnd(15)} reach ${String(reach).padStart(3)}% → cap ${String(cap.capPct).padStart(3)}%  base ${eur(base)} ceil ${eur(maxCpc)} ${camp.biddingStrategy ?? '—'}${cap.baseAlone ? '  ⚠ BASE ALONE OVER CEILING' : ''}`)
    }
    if (k === activeKey) {
      const curPct = cdb.placementBidding?.find((x) => x.placement === t.placement)?.percentage ?? 0
      if (curPct > cap.capPct) {
        nowCapped++
        rows.push(`  ${camp.name.padEnd(34).slice(0, 34)} ${k.padEnd(15)} NOW ${String(curPct).padStart(3)}% → ${String(cap.capPct).padStart(3)}%  base ${eur(base)} ceil ${eur(maxCpc)}${cap.baseAlone ? '  ⚠ BASE ALONE' : ''}`)
      }
    }
  }
}

console.log(`── WOULD MOVE ON THE NEXT TICK (${nowCapped}) ──`)
console.log(rows.length ? [...new Set(rows)].join('\n') : '  (none — no live placement is above its ceiling right now)')
console.log(`\n── WOULD BE CAPPED IN SOME PAINTED HOUR (${everCapped}) ──`)
console.log(everRows.length ? [...new Set(everRows)].sort().join('\n') : '  (none)')
console.log(`\nall-out targets still carrying NO ceiling at all (unbounded): ${noCeiling}`)
console.log(`campaigns whose base bid alone exceeds the ceiling: ${baseAlone}`)
await prisma.$disconnect()
