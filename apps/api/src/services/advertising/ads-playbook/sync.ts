/**
 * ADS PLAYBOOK PB-10 — SYNC: fix one product's drift in one market, ADDING ONLY (design report 9 §5.5). It never deletes,
 * archives or pauses anything; taking something away is the W2 archive kind, with its own approval.
 *
 *   negatives    the missing isolation, source and product negatives, each through the one negative write service
 *                (ads-negative-kw.service.ts: it refuses a negative over the ad group's own live keyword, L1; a
 *                protected term; Amazon's text limits) — lowers spend. Rule 3 again right before the writes: an ad group
 *                that now also advertises another product gets none, nor does a campaign that left the playbook, nor a
 *                negative whose own keyword is no longer live.
 *   positives    a missing keyword or competitor ASIN of the product's terms, or a misplaced keyword in its right slot,
 *                created at Amazon's 2¢ floor with its planned bid remembered (the SP Super Wizard's launch does the
 *                same, with the same create service) — adds spend. It starts at the floor; only START gives it its bid
 *                (`giveBackSyncedBids` below): the planned bid is kept in the sync's own version row, not as a floor's
 *                memory, so no other restore gives it back. At the floor it is no home: isolation never sends a
 *                search to it (isolation.ts). The misplaced one stays where it is: sync never
 *                removes, and a winner is never moved at all (drift offers no fix for it: Owner rule 2).
 *   productAds   a child listed in the market but not advertised in a slot — adds spend.
 *   slots        a slot with no live campaign is built through the playbook's build (build.ts: the SP Super Wizard's own
 *                launch, born at the floor and off the live-write allowlist — Owner rule 1), detached — adds spend.
 *   artifacts    a compiled rule or hourly plan missing or changed is re-saved through its compiler (artifacts.ts, mode
 *                adopt: Nexus only, nothing is switched on).
 *
 * What a sync takes: every item drift says sync fixes (or the ones `fix` names), never a change a person made himself
 * unless `revert` names it. The plan is read again when it runs, and runs exactly what was approved.
 */
import { createHash } from 'node:crypto'
import prisma from '../../../db.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { familyOfProducts, familyOnly } from '../ads-winner-lock.js'
import { ARTIFACT_COMPILERS, compileArtifacts, type ArtifactCompiler, type ArtifactContext } from './artifacts.js'
import type { BuildPlan } from './build-preview.js'
import { loadDrift, type LoadedDrift } from './drift-load.js'
import { SPEND_PARTS, SYNC_PARTS, type DriftItem, type SyncPart } from './drift.js'
import { recordPlaybookApply, type PlaybookApplyWriter } from './write.js'

export interface SyncArgs {
  market: string
  productId?: string
  sku?: string
  channel?: string
  /** The drift items to fix (keys from ads-playbook view drift); absent: every item sync fixes that no person made. */
  fix?: readonly string[]
  /** The changes a person made himself to put back (their keys): sync never takes one unless it is named here. */
  revert?: readonly string[]
  /** op sync-negatives: its negatives only (a kind of its own, `negative`); everything else is op sync's (`create`). */
  negativesOnly?: boolean
}

export interface SyncPlan {
  drift: LoadedDrift & { playbook: NonNullable<LoadedDrift['playbook']> }
  /** What this sync does, item by item, and by part. */
  chosen: DriftItem[]
  parts: Record<SyncPart, DriftItem[]>
  /** The build of the missing slots (planBuild with only those slots), when any. */
  build: BuildPlan | null
  addsSpend: boolean
  /** Drift this sync leaves: a person's own changes not named in revert, and what another tool (or no one) fixes. */
  left: { byPerson: DriftItem[]; elsewhere: DriftItem[] }
  problems: string[]
  basis: string
}

/** The most drift items one sync fixes (every list of a request stays under the tool contract's 250). */
export const MAX_SYNC_ITEMS = 200
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 32)

/** A sync planned: nothing written. `problems` refuse it (said, not queued). */
export async function planSync(args: SyncArgs): Promise<{ data: SyncPlan } | { status: 400 | 404; error: string }> {
  const out = await loadDrift(args)
  if ('error' in out) return out
  const d = out.data
  if (!d.playbook) return { status: 400, error: `${d.product.sku} has no product playbook row in ${d.market}.` }
  if (!d.enrolled) return { status: 400, error: `${d.product.sku} is not enrolled in its playbook in ${d.market}: nothing is held to it, so there is nothing to sync.` }
  if (!d.report || !d.facts) return { status: 400, error: `The playbook does not compile yet: ${d.problems.join('; ') || 'it has no template'}.` }
  const items = d.report.items
  const byKey = new Map(items.map((i) => [i.key, i]))
  const problems: string[] = []
  const reverts = new Set(args.revert ?? [])
  for (const k of reverts) {
    const i = byKey.get(k)
    if (!i) problems.push(`revert: no drift item "${k}" now (read ads-playbook view drift again)`)
    else if (!i.byPerson) problems.push(`revert: "${k}" is no change a person made himself — name it in fix`)
    else if (i.revert?.by !== 'sync') problems.push(`revert: "${k}" is not put back by sync${i.revert?.by === 'tool' ? ` — ${i.revert.tool} does it` : ''}`)
  }
  const asked = args.fix?.length ? new Set(args.fix) : null
  for (const k of asked ?? []) {
    const i = byKey.get(k)
    if (!i) problems.push(`fix: no drift item "${k}" now (read ads-playbook view drift again)`)
    else if (i.fix.by !== 'sync') problems.push(`fix: "${k}" is not fixed by sync — ${i.fix.by === 'tool' ? `${i.fix.tool} does it` : i.fix.note}`)
    else if (i.byPerson && !reverts.has(k)) problems.push(`fix: "${k}" is a change ${i.byPerson.userId} made himself — name it in revert to put it back, or keep it (its keep request)`)
  }
  if (args.negativesOnly) {
    for (const k of [...(asked ?? []), ...reverts]) {
      const i = byKey.get(k)
      if (i && !(i.fix.by === 'sync' && i.fix.part === 'negatives')) problems.push(`"${k}" is not a negative: op sync-negatives adds negatives only (op sync does the rest)`)
    }
  }
  const chosen = items.filter((i) => i.fix.by === 'sync' && (!args.negativesOnly || i.fix.part === 'negatives') && (i.byPerson ? reverts.has(i.key) : !asked || asked.has(i.key)))
  if (chosen.length > MAX_SYNC_ITEMS) problems.push(`it would fix ${chosen.length} items, more than the ${MAX_SYNC_ITEMS} one sync holds: name the ones to fix first (fix)`)
  const parts = Object.fromEntries(SYNC_PARTS.map((p) => [p, chosen.filter((i) => i.fix.by === 'sync' && i.fix.part === p)])) as Record<SyncPart, DriftItem[]>
  const addsSpend = [...SPEND_PARTS].some((p) => parts[p].length > 0)
  if (addsSpend && d.playbook.state === 'STOPPED') problems.push('the playbook is stopped: what adds spend waits until it starts again (a sync of its negatives may run)')

  let build: BuildPlan | null = null
  if (parts.slots.length) {
    const { inFlightRefusal, planBuild } = await import('./build.js')
    const planned = await planBuild({ market: d.market, productId: d.product.productId, channel: d.channel, only: parts.slots.map((i) => i.slot!) })
    if ('error' in planned) problems.push(`the missing slots cannot be built: ${planned.error}`)
    else if (!planned.data.campaigns.length) problems.push('the missing slots are held by a live campaign again (read ads-playbook view drift again)')
    else if (!planned.data.allowed) problems.push(`the blueprint gate refuses building ${parts.slots.map((i) => i.slot).join(', ')} — ${planned.data.blockers.join(' ')}`)
    else {
      build = planned.data
      const flying = await inFlightRefusal(d.market, build.nameToken!, d.playbook.id)
      if (flying && !flying.stopped) problems.push(`a build of this product is running (run ${flying.applicationId}): follow it with ads-playbook view build`)
    }
  }
  const left = {
    byPerson: items.filter((i) => i.byPerson && !reverts.has(i.key)),
    elsewhere: items.filter((i) => i.fix.by !== 'sync' && !i.byPerson && !i.warnOnly),
  }
  const basis = hash({
    row: [d.playbook.id, d.playbook.version],
    chosen: chosen.map((i) => [i.key, i.adGroupId ?? null, i.into?.adGroupId ?? null, i.term ?? null, i.match ?? null, i.asin ?? null, i.sku ?? null, i.startBidCents ?? null, i.negative?.ownerTargetId ?? null]),
    build: build ? { campaigns: build.campaigns.map((c) => [c.role, c.name, c.dailyBudget]), productAds: build.productAds, portfolio: build.portfolio } : null,
  })
  return { data: { drift: d as SyncPlan['drift'], chosen, parts, build, addsSpend, left, problems, basis } }
}

// ── START's hook: the bids a sync planned ────────────────────────────────────────────────────────────────────────

/** A keyword or product target a sync added at the floor, with the bid planned for it, that still bids the floor. */
export interface SyncedBid { adTargetId: string; campaignId: string; adGroupId: string; text: string; bidCents: number; plannedCents: number }

/** Which of them: these campaigns only; `lifting` — campaigns START takes off their floor first (planned before it does). */
export interface SyncedBidScope { campaignIds?: Iterable<string>; lifting?: Iterable<string> }

/** Every bid a sync of this playbook planned (its version rows op sync), the newest plan for each target. */
async function plannedBidsOf(playbookId: string): Promise<Map<string, number>> {
  const rows = await prisma.adsPlaybookVersion.findMany({ where: { kind: 'playbook', refId: playbookId, op: 'sync' }, orderBy: { version: 'asc' }, select: { changes: true } })
  const out = new Map<string, number>()
  for (const r of rows) {
    for (const c of (Array.isArray(r.changes) ? r.changes : []) as Array<{ field?: unknown; to?: unknown }>) {
      if (c?.field !== 'sync.plannedBids' || !Array.isArray(c.to)) continue
      for (const b of c.to as Array<{ adTargetId?: unknown; startBidCents?: unknown }>) if (typeof b?.adTargetId === 'string' && typeof b.startBidCents === 'number') out.set(b.adTargetId, b.startBidCents)
    }
  }
  return out
}

/**
 * PB-10 — for START (PB-5b; a re-run of it is idempotent): the keywords and product targets a sync of this playbook added
 * at the floor that still bid it, with no floor over them now (neither their campaign, nor their ad group, nor a memory
 * of their own: those are a floor's, and its restore's). Read only.
 */
export async function syncedBidsToGiveBack(playbookId: string, scope: SyncedBidScope = {}): Promise<SyncedBid[]> {
  const { SUPPRESSION_FLOOR_CENTS } = await import('../ads-bid-suppression.service.js')
  const planned = await plannedBidsOf(playbookId)
  if (!planned.size) return []
  const only = scope.campaignIds ? new Set(scope.campaignIds) : null
  const lifting = new Set(scope.lifting ?? [])
  const rows = await prisma.adTarget.findMany({
    where: {
      id: { in: [...planned.keys()] }, isNegative: false, status: { not: 'ARCHIVED' }, suppressedFromBidCents: null, bidCents: { lte: SUPPRESSION_FLOOR_CENTS },
      adGroup: { bidsSuppressedAt: null, campaign: { status: { not: 'ARCHIVED' }, ...(only ? { id: { in: [...only] } } : {}) } },
    },
    select: { id: true, adGroupId: true, expressionValue: true, bidCents: true, adGroup: { select: { campaignId: true, campaign: { select: { bidsSuppressedAt: true } } } } },
    orderBy: { id: 'asc' },
  })
  return rows
    .filter((t) => !t.adGroup.campaign.bidsSuppressedAt || lifting.has(t.adGroup.campaignId))
    .map((t) => ({ adTargetId: t.id, campaignId: t.adGroup.campaignId, adGroupId: t.adGroupId, text: t.expressionValue, bidCents: t.bidCents, plannedCents: planned.get(t.id)! }))
}

/**
 * PB-10 — START gives exactly those bids: each to the bid planned for it, held inside the bounds that bind it today
 * (giveBackBounds: the campaign's own bounds, bid policies, the strategy's band), as the approver, with the approval's
 * change set. Only START calls it (with the approver's code): no other restore sees these bids. One moved off the floor
 * since (an engine or a person) is no longer listed; a re-run gives nothing again.
 */
export async function giveBackSyncedBids(playbookId: string, run: { actor: AdsActor; reason: string; changeSetId: string | null; manual?: boolean; campaignIds?: Iterable<string> }): Promise<{
  given: Array<{ adTargetId: string; text: string; toCents: number; heldBy?: string }>
  failed: Array<{ adTargetId: string; text: string; why: string }>
}> {
  const { giveBackBounds } = await import('../ads-bid-suppression.service.js')
  const { clampBid } = await import('../ads-strategy/bids.js')
  const { updateAdTargetWithSync } = await import('../ads-mutation.service.js')
  const out: Awaited<ReturnType<typeof giveBackSyncedBids>> = { given: [], failed: [] }
  const byCampaign = new Map<string, SyncedBid[]>()
  for (const b of await syncedBidsToGiveBack(playbookId, run.campaignIds ? { campaignIds: run.campaignIds } : {})) byCampaign.set(b.campaignId, [...(byCampaign.get(b.campaignId) ?? []), b])
  for (const [campaignId, list] of byCampaign) {
    const boundsOf = await giveBackBounds(campaignId, list.map((b) => b.adGroupId))
    for (const b of list) {
      const c = clampBid(b.plannedCents, boundsOf(b.adGroupId), { currentCents: b.bidCents, forced: true })
      try {
        const r = await updateAdTargetWithSync({ adTargetId: b.adTargetId, patch: { bidCents: c.cents }, actor: run.actor, reason: run.reason, applyImmediately: true, force: true, changeSetId: run.changeSetId, manual: run.manual })
        if (r.ok) out.given.push({ adTargetId: b.adTargetId, text: b.text, toCents: c.cents, ...(c.held ? { heldBy: c.held.limit.source } : {}) })
        else if (r.error !== 'not_found') out.failed.push({ adTargetId: b.adTargetId, text: b.text, why: r.error ?? 'not accepted' })
      } catch (e) { out.failed.push({ adTargetId: b.adTargetId, text: b.text, why: (e as Error).message.slice(0, 200) }) }
    }
  }
  return out
}

/** The rules and schedules the playbook compiled itself: a negative of its own sync is not "an engine also moves it". */
export async function ownEngines(playbookId: string): Promise<string[]> {
  const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId, kind: { in: ['harvestRule', 'isolationRule', 'rankGroup'] } }, select: { kind: true, refId: true } })
  const groups = links.filter((l) => l.kind === 'rankGroup').map((l) => l.refId)
  const schedules = groups.length ? (await prisma.adSchedule.findMany({ where: { groupId: { in: groups } }, select: { id: true } })).map((s) => s.id) : []
  return [...links.filter((l) => l.kind !== 'rankGroup').map((l) => l.refId), ...schedules]
}

export interface SyncWriter {
  /** The approver: every write is theirs. */
  actor: AdsActor
  /** Who asked: a slot built is flagged suppressed by them. */
  requester: AdsActor
  changeSetId: string
  writer: PlaybookApplyWriter
  /** A person approved it (his own click, approvedRun): the write gate treats each add as his. */
  manual: boolean
  confirmOwnLimits: boolean
}

type Outcome = { key: string; why: string }
export interface SyncResult {
  negatives: { added: number; local: number; alreadyStanding: number; refused: Outcome[]; failed: Outcome[]; leftAlone: Outcome[]; ids: string[] }
  positives: { added: number; local: number; existed: number; refused: Outcome[]; failed: Outcome[]; leftAlone: Outcome[]; ids: string[]; planned: Array<{ adTargetId: string; startBidCents: number }> }
  productAds: { added: number; local: number; failed: Outcome[]; leftAlone: Outcome[]; ids: string[] }
  build: { applicationId: string; alreadyRunning?: boolean } | { refusal: string } | null
  artifacts: { resaved: string[]; errors: string[] }
}

/** Where an item's write lands: a misplaced keyword's right slot, else the item's own ad group. */
const placeOf = (i: DriftItem) => (i.into ? { adGroupId: i.into.adGroupId, campaignId: i.into.campaignId } : { adGroupId: i.adGroupId!, campaignId: i.campaignId! })

/** Run an approved sync. Writes nothing the plan does not hold; each part is said, item by item, as it landed. */
export async function runSync(plan: SyncPlan, w: SyncWriter, opts: { compilers?: readonly ArtifactCompiler[] } = {}): Promise<SyncResult> {
  const { SUPPRESSION_FLOOR_CENTS } = await import('../ads-bid-suppression.service.js')
  const { createKeywordLocal, createProductAdLocal, createTargetLocal } = await import('../ads-create.service.js')
  const { writeNegativeKeyword } = await import('../ads-negative-kw.service.js')
  const d = plan.drift
  const res: SyncResult = {
    negatives: { added: 0, local: 0, alreadyStanding: 0, refused: [], failed: [], leftAlone: [], ids: [] },
    positives: { added: 0, local: 0, existed: 0, refused: [], failed: [], leftAlone: [], ids: [], planned: [] },
    productAds: { added: 0, local: 0, failed: [], leftAlone: [], ids: [] },
    build: null,
    artifacts: { resaved: [], errors: [] },
  }
  const floor = SUPPRESSION_FLOOR_CENTS

  // Rule 3, the last layer: right before the writes, each ad group still advertises only this product (an empty one
  // takes only this product's ads), and its campaign still plays a slot of this playbook.
  const family = await familyOfProducts([d.playbook.scopeId])
  const writes = [...plan.parts.negatives, ...plan.parts.positives, ...plan.parts.productAds]
  const groupIds = [...new Set(writes.map((i) => placeOf(i).adGroupId))]
  const owned = await familyOnly(groupIds, family)
  const foreign = new Map(owned.excluded.map((e) => [e.adGroupId, e.why]))
  const live = groupIds.length ? new Set((await prisma.adProductAd.findMany({ where: { adGroupId: { in: groupIds }, status: { not: 'ARCHIVED' } }, select: { adGroupId: true } })).map((a) => a.adGroupId)) : new Set<string>()
  const links = writes.length ? await prisma.adsPlaybookLink.findMany({ where: { kind: 'slot', refId: { in: [...new Set(writes.map((i) => placeOf(i).campaignId))] } }, select: { refId: true, playbookId: true } }) : []
  const linkedHere = new Set(links.filter((l) => l.playbookId === d.playbook.id).map((l) => l.refId))
  const goneWhy = (i: DriftItem, adsOnly = false): string | null => {
    const at = placeOf(i)
    if (!linkedHere.has(at.campaignId)) return 'Not written: its campaign left this product\'s playbook since the plan was made.'
    const why = foreign.get(at.adGroupId)
    if (why && !(adsOnly && !live.has(at.adGroupId))) return `Not written: ${why}.`
    return null
  }
  const evidence = (i: DriftItem) => ({ targetKey: `playbook-sync:${i.kind}`, note: i.says.slice(0, 300) })

  // 1 — negatives (lower spend).
  for (const i of plan.parts.negatives) {
    const gone = goneWhy(i)
    if (gone) { res.negatives.leftAlone.push({ key: i.key, why: gone }); continue }
    if (i.negative?.ownerTargetId) {
      const owner = await prisma.adTarget.findUnique({ where: { id: i.negative.ownerTargetId }, select: { isNegative: true, status: true, externalTargetId: true, bidCents: true } })
      if (!owner || owner.isNegative || String(owner.status) !== 'ENABLED' || owner.externalTargetId == null || owner.bidCents <= floor) {
        res.negatives.leftAlone.push({ key: i.key, why: `Not written: its keyword "${i.negative.owner ?? '?'}" is no longer live${owner && owner.bidCents <= floor ? ' above the 2-cent floor' : ''}, so its searches would have nowhere to go.` })
        continue
      }
    }
    const r = await writeNegativeKeyword({
      scope: 'AD_GROUP', adGroupId: placeOf(i).adGroupId, keywordText: i.term!, matchType: i.match === 'PHRASE' ? 'PHRASE' : 'EXACT',
      // The converting guard is not asked: drift held back every negative that would block a winner (rule 2).
      protectConverting: null, userId: w.actor, evidence: evidence(i), manual: w.manual, changeSetId: w.changeSetId,
    })
    if (r.outcome === 'created' || r.outcome === 'local') {
      if (r.reachedAmazon) res.negatives.added++
      else res.negatives.local++
      if (r.adTargetId) res.negatives.ids.push(r.adTargetId)
    } else if (r.outcome === 'already_existed') res.negatives.alreadyStanding++
    else if (r.outcome === 'refused') res.negatives.refused.push({ key: i.key, why: r.refusal?.reason ?? r.error ?? 'refused' })
    else res.negatives.failed.push({ key: i.key, why: r.error ?? 'it did not reach Amazon' })
  }

  // 2 — positives: born at the floor, the planned bid remembered (adds spend).
  for (const i of plan.parts.positives) {
    const gone = goneWhy(i)
    if (gone) { res.positives.leftAlone.push({ key: i.key, why: gone }); continue }
    const at = placeOf(i)
    const planned = i.startBidCents ?? 0
    try {
      if (i.targetKind === 'PRODUCT') {
        const t = await createTargetLocal({ adGroupId: at.adGroupId, kind: 'PRODUCT', value: i.term!, bidEur: floor / 100, userId: w.actor, manual: w.manual, confirmOwnLimits: w.confirmOwnLimits, changeSetId: w.changeSetId })
        if (t.id) res.positives.ids.push(t.id)
        if (t.id && planned > floor) res.positives.planned.push({ adTargetId: t.id, startBidCents: planned })
        if (t.externalTargetId) res.positives.added++
        else if (t.notSent?.outcome === 'refused') res.positives.refused.push({ key: i.key, why: t.notSent.reason })
        else if (t.notSent) res.positives.failed.push({ key: i.key, why: t.notSent.reason })
        else res.positives.local++
      } else {
        const k = await createKeywordLocal({
          adGroupId: at.adGroupId, keywordText: i.term!, matchType: (i.match as 'BROAD' | 'PHRASE' | 'EXACT'), bidEur: floor / 100,
          userId: w.actor, evidence: evidence(i), manual: w.manual, confirmOwnLimits: w.confirmOwnLimits, changeSetId: w.changeSetId,
        })
        if (k.existed) { res.positives.existed++; continue }
        if (k.id) res.positives.ids.push(k.id)
        if (k.id && planned > floor) res.positives.planned.push({ adTargetId: k.id, startBidCents: planned })
        if (k.externalTargetId) res.positives.added++
        else if (k.denied) res.positives.refused.push({ key: i.key, why: k.denied.reason })
        else if (k.pushError) res.positives.failed.push({ key: i.key, why: k.pushError })
        else res.positives.local++
      }
    } catch (e) { res.positives.failed.push({ key: i.key, why: (e as Error).message.slice(0, 200) }) }
  }

  // 3 — product ads (adds spend).
  for (const i of plan.parts.productAds) {
    const gone = goneWhy(i, true)
    if (gone) { res.productAds.leftAlone.push({ key: i.key, why: gone }); continue }
    try {
      const a = await createProductAdLocal({ adGroupId: placeOf(i).adGroupId, asin: i.asin, ...(i.sku ? { sku: i.sku } : {}), userId: w.actor, manual: w.manual, confirmOwnLimits: w.confirmOwnLimits, changeSetId: w.changeSetId })
      if (a.id) res.productAds.ids.push(a.id)
      if (a.externalAdId) res.productAds.added++
      else if (a.notSent) res.productAds.failed.push({ key: i.key, why: a.notSent.reason })
      else res.productAds.local++
    } catch (e) { res.productAds.failed.push({ key: i.key, why: (e as Error).message.slice(0, 200) }) }
  }

  // 4 — the compiled artifacts that drift, re-saved through their compilers (Nexus only; nothing switched on).
  const kinds = new Set(plan.parts.artifacts.map((i) => i.artifact?.kind).filter((k): k is string => !!k))
  if (kinds.size) {
    const compilers = (opts.compilers ?? ARTIFACT_COMPILERS).filter((c) => kinds.has(c.kind))
    const all = await prisma.adsPlaybookLink.findMany({ where: { playbookId: d.playbook.id }, select: { kind: true, key: true, refId: true, adGroupId: true, origin: true } })
    const doc = d.facts!.doc
    const rankRole = (key: string) => doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'
    const ctx: ArtifactContext = {
      playbookId: d.playbook.id, market: d.market, productId: d.product.productId, nameToken: d.facts!.nameToken, doc,
      slots: all.filter((l) => l.kind === 'slot').map((l) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId, origin: l.origin === 'built' ? 'built' : 'adopted', rankRole: rankRole(l.key) })),
      // The hook's conservative mode: what an adopt does — created or followed switched off, nothing switched on.
      mode: 'adopt', actor: w.actor, changeSetId: w.changeSetId, compiledVersion: d.playbook.version,
    }
    const out = await compileArtifacts(ctx, all.filter((l) => l.kind !== 'slot' && l.kind !== 'portfolio'), compilers)
    res.artifacts.errors.push(...out.errors)
    for (const l of out.links) {
      try {
        const mine = await prisma.adsPlaybookLink.findFirst({ where: { playbookId: d.playbook.id, kind: l.kind, key: l.key }, select: { id: true } })
        const data = { refId: l.refId, origin: 'built', compiledVersion: d.playbook.version, updatedBy: w.writer.updatedBy }
        if (mine) await prisma.adsPlaybookLink.update({ where: { id: mine.id }, data })
        else await prisma.adsPlaybookLink.create({ data: { playbookId: d.playbook.id, kind: l.kind, key: l.key, ...data } })
      } catch (e) { res.artifacts.errors.push(`link ${l.kind} ${l.key}: ${(e as Error).message.slice(0, 160)}`) }
    }
    res.artifacts.resaved.push(...compilers.map((c) => c.kind))
  }

  // 5 — the row records the sync (one version row, op sync); a build of the missing slots then runs detached, planned
  // against the row as recorded.
  const current = await prisma.adsPlaybook.findUnique({ where: { id: d.playbook.id }, select: { state: true } })
  const recorded = await recordPlaybookApply(d.playbook.id, {
    op: 'sync', state: current?.state ?? d.playbook.state ?? 'DRAFT', compiledVersion: d.playbook.version, compiledTemplateVersion: d.template?.version ?? null,
    reason: `sync: ${plan.parts.negatives.length} negative(s), ${plan.parts.positives.length} keyword(s) or target(s), ${plan.parts.productAds.length} product ad(s), ${plan.parts.slots.length} slot(s), ${kinds.size} artifact(s)`,
    // The bids START gives the keywords and targets it added at the floor (giveBackSyncedBids reads them here).
    ...(res.positives.planned.length ? { plannedBids: res.positives.planned } : {}),
  }, { ...w.writer, approvalId: w.changeSetId }).catch(() => null)
  if (!recorded && res.positives.planned.length) res.artifacts.errors.push('the playbook row did not record this sync: START cannot give the keywords it added their planned bids (a person sets them)')
  if (plan.build) {
    const { startPlaybookBuild } = await import('./build.js')
    const build = recorded ? { ...plan.build, playbook: { ...plan.build.playbook!, version: recorded.version } } : plan.build
    res.build = await startPlaybookBuild({ plan: build, actor: w.actor, requester: w.requester, changeSetId: w.changeSetId, writer: w.writer, ...(opts.compilers ? { compilers: opts.compilers } : {}) })
  }
  return res
}
