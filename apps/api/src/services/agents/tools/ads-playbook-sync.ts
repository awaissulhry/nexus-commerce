/**
 * ADS PLAYBOOK PB-10 — apply-ads-playbook op sync: the preview, the check of a run by rule, the run and its undo, kept
 * apart from the tool file so its build / adopt / start / stop / phase ops stay as they are. The plan and the writes are
 * ads-playbook/sync.ts (loaded when asked: the tool registry's import cycle never reaches it at load).
 *
 *   preview   every drift item this sync fixes, by part, and the drift it leaves (a person's own changes not named in
 *             revert, with their keep and revert; what another tool fixes), where it lands, the strategy's facts
 *   by rule   only a sync that adds no spend (its negatives; nothing else) may run by the business's rule, inside the
 *             kit's limits and the strategy's narrowing of negatives; what adds spend (a keyword, a product ad, a slot)
 *             or re-saves a compiled part always waits for a person
 *   undo      the negatives it added are retired (undo-ad-change of its change set); what it built is archived only
 *             through archive-ads (buildRunId), and the keywords and product ads it added at the floor stay (a person
 *             archives them with archive-ads)
 */
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, notRun, reachNote, reachRefusal, recheck, requesterOf, storedReach, type StoredReach } from './ads-change-kit.js'
import { buildLimitFacts, commonRefusal, limitsNote, type KitItem } from './ads-autonomy-kit.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const TOOL = 'apply-ads-playbook'
const MAX_LISTED = 200
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export interface SyncArgsIn {
  op: 'sync'
  market: string
  productId?: string
  sku?: string
  fix?: string[]
  revert?: string[]
  expectVersion?: number
  why?: string
}

type SyncPlan = import('../../advertising/ads-playbook/sync.js').SyncPlan
type Item = SyncPlan['chosen'][number]

const itemOut = (i: Item) => ({
  key: i.key, kind: i.kind, slot: i.into?.slot ?? i.slot, says: i.says,
  ...(i.term ? { term: i.term } : {}), ...(i.match ? { match: i.match } : {}), ...(i.asin ? { asin: i.asin } : {}), ...(i.sku ? { sku: i.sku } : {}),
  ...(i.negative ? { of: i.negative.of } : {}), ...(i.startBidCents ? { startBidCents: i.startBidCents } : {}),
  ...(i.fix.by === 'sync' && i.fix.part === 'positives' ? { startsAt: 'the floor; START gives it its bid' } : {}),
  ...(i.artifact ? { artifact: i.artifact.kind, parts: i.artifact.parts } : {}),
  ...(i.byPerson ? { byPerson: i.byPerson, reverted: true } : {}),
})

/** The sync, planned and judged: its preview, and the plan `execute` runs. */
export async function syncPreview(a: SyncArgsIn, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plan?: SyncPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const { ownEngines, planSync } = await import('../../advertising/ads-playbook/sync.js')
  const out = await planSync({ market: a.market, productId: a.productId, sku: a.sku, fix: a.fix, revert: a.revert })
  if ('error' in out) return refuse(out.error)
  const p = out.data
  const d = p.drift
  if (a.expectVersion != null && a.expectVersion !== d.playbook.version) return refuse('The playbook row moved since you read it (expectVersion): read it again with ads-playbook.')
  if (p.problems.length) return refuse(`Not queued: ${p.problems.join('; ')}.`)
  if (!p.chosen.length) {
    const why = [
      p.left.byPerson.length ? `${plural(p.left.byPerson.length, 'change')} a person made himself (keep it, or name it in revert)` : '',
      p.left.elsewhere.length ? `${plural(p.left.elsewhere.length, 'item')} another tool fixes, or none (each item says which)` : '',
    ].filter(Boolean).join('; ')
    return refuse(`Nothing to sync for ${d.product.sku} in ${d.market}${why ? `: what drifts is ${why}` : ': no drift sync fixes (ads-playbook view drift)'}.`)
  }
  let currency: string
  try { currency = await marketCurrency('AMAZON', d.market) } catch (e) { return refuse((e as Error).message) }

  const build = p.build
  const largest = Math.max(0, ...(build?.campaigns ?? []).map((c) => Math.round(Number(c.dailyBudget ?? 0) * 100)))
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: d.market, payloadValueCents: largest }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)
  // The facts the business's rule is judged on: each negative where it lands (it lowers spend); a keyword as a new bid;
  // the slots built as the daily budget they add.
  const items: KitItem[] = [
    ...p.parts.negatives.map((i) => ({ entity: { kind: 'adGroup' as const, id: i.adGroupId! }, change: { field: 'negative' as const, term: i.term!, matchType: i.match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' } })),
    ...p.parts.positives.map((i) => ({ entity: { kind: 'adGroup' as const, id: (i.into?.adGroupId ?? i.adGroupId)! }, change: { field: 'bid' as const, fromCents: null, toCents: i.startBidCents ?? 2 } })),
    ...(build ? [{ entity: { kind: 'products' as const, market: d.market, productIds: [d.product.productId] }, change: { field: 'dailyBudget' as const, fromCents: null, toCents: build.dailyBudgetCents } }] : []),
  ]
  const facts = await buildLimitFacts({ tool: TOOL, action: 'negative', items, exceptIds: await ownEngines(d.playbook.id), approvalId: ctx.approvalId ?? null })
  const highest = Math.max(0, ...p.parts.positives.map((i) => i.startBidCents ?? 0), build?.highestPlannedBidCents ?? 0)
  const n = (part: keyof SyncPlan['parts']) => p.parts[part].length
  const effect = `Syncs ${d.product.sku}'s playbook in ${d.market}, adding only: `
    + [
      n('negatives') ? `${plural(n('negatives'), 'negative')} (they lower spend)` : '',
      n('positives') ? `${plural(n('positives'), 'keyword or product target')} — each starts at the 2-cent floor with its planned bid remembered; START gives it its bid` : '',
      n('productAds') ? `${plural(n('productAds'), 'product ad')}` : '',
      build ? `${plural(build.campaigns.length, 'campaign')} for ${p.parts.slots.map((i) => i.slot).join(', ')} through the SP Super Wizard's launch (born at the floor, off the live-write allowlist; ${amountLabel(build.dailyBudgetCents, currency)} of daily budget)` : '',
      n('artifacts') ? `${plural(n('artifacts'), 'compiled part')} saved again in Nexus (switched off when new)` : '',
    ].filter(Boolean).join('; ')
    + '. Nothing is deleted, archived or paused.'
    + (p.addsSpend ? ' It adds spend: a person decides.' : '')
  return {
    plan: p,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: 'sync',
        market: d.market,
        product: d.product,
        playbook: { id: d.playbook.id, version: d.playbook.version, state: d.playbook.state },
        currency,
        addsSpend: p.addsSpend,
        negatives: p.parts.negatives.slice(0, MAX_LISTED).map(itemOut),
        positives: p.parts.positives.slice(0, MAX_LISTED).map(itemOut),
        productAds: p.parts.productAds.slice(0, MAX_LISTED).map(itemOut),
        slots: build ? build.campaigns.map((c) => ({ slot: c.role, name: c.name, dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100), startBidCents: c.adGroups[0]?.defaultBidCents ?? 0 })) : [],
        artifacts: p.parts.artifacts.map(itemOut),
        totals: { negatives: n('negatives'), positives: n('positives'), productAds: n('productAds'), slots: n('slots'), artifacts: n('artifacts') },
        ...(build ? { dailyBudgetCents: build.dailyBudgetCents } : {}),
        highestPlannedBidCents: highest,
        startsSuppressed: { floorCents: 2, note: 'Starts at the floor; START gives it its bid. A keyword, a product target or a slot this sync adds starts at the 2-cent floor with its planned bid remembered; START (a re-run on a running playbook too, with the approver\'s code) puts exactly those bids back.' },
        left: {
          byPerson: p.left.byPerson.slice(0, MAX_LISTED).map((i) => ({ key: i.key, kind: i.kind, slot: i.slot, says: i.says, byPerson: i.byPerson, ...(i.keep ? { keep: i.keep } : {}), ...(i.revert ? { revert: i.revert } : {}) })),
          elsewhere: p.left.elsewhere.slice(0, MAX_LISTED).map((i) => ({ key: i.key, kind: i.kind, slot: i.slot, says: i.says, fix: i.fix })),
        },
        warnings: [...d.warnings, ...(build?.warnings ?? [])].slice(0, 20),
        basis: p.basis,
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        undoNote: 'Undo retires the negatives it added (undo-ad-change). A slot it built is archived only with archive-ads (buildRunId), permanently; keywords, product targets and product ads it added stay until a person archives them (archive-ads).',
        limitFacts: facts,
        limitsNote: limitsNote(facts),
      },
    },
  }
}

/** PB-10 — a sync's own check of a run by rule (pure, on its preview): only one that adds no spend, inside the kit's. */
export function syncRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { addsSpend?: boolean; totals?: Record<string, number> }
  if (p.addsSpend !== false) return 'it adds spend (a keyword, a product ad or a slot): a person decides'
  if ((p.totals?.artifacts ?? 0) > 0) return "it saves the playbook's compiled parts again: a person decides"
  return commonRefusal(preview, limits)
}

/** What a sync recorded: its change set, what it added, its build. */
export interface SyncAfter { op: 'sync'; playbookId: string; changeSetId: string; negatives: Array<{ targetId: string }>; applicationId?: string; added: Record<string, number> }

/** Run an approved sync: re-planned, held to what was approved, as the approver. */
export async function executeSync(a: SyncArgsIn, ctx: ToolContext, writerOf: (changeSetId: string) => { via: string; actor: string; actorUserId: string | null; approvalId: string; updatedBy: string }): Promise<ToolResult> {
  const fresh = await syncPreview(a, ctx)
  if (!fresh.result.ok || !fresh.plan) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid sync'}`)
  const refusal = recheck(ctx, fresh.result, ['op', 'basis', 'reach'])
  if (refusal) return notRun(refusal)
  const p = fresh.plan
  const preview = fresh.result.preview as { reach: StoredReach; effect: string }
  // What adds spend never runs by rule (withinLimits holds it); said again here, where it would write.
  if (ctx.decidedVia === 'auto' && p.addsSpend) return notRun('Not run: it adds spend, and only a person decides that.')
  const run = approvedRun(ctx, a.why ?? preview.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const requester = await requesterOf(ctx, run.actor)
  const { runSync } = await import('../../advertising/ads-playbook/sync.js')
  const out = await runSync(p, { actor: run.actor, requester, changeSetId: run.changeSetId, writer: writerOf(run.changeSetId), manual: run.manual, confirmOwnLimits: run.confirmOwnLimits })
  const build = out.build && 'applicationId' in out.build ? out.build : null
  const added = { negatives: out.negatives.added + out.negatives.local, positives: out.positives.added + out.positives.local, productAds: out.productAds.added + out.productAds.local }
  const problems = [
    ...out.negatives.refused, ...out.negatives.failed, ...out.positives.refused, ...out.positives.failed, ...out.productAds.failed,
  ].map((o) => `${o.key}: ${o.why}`)
  return {
    ok: true,
    data: {
      reach: preview.reach,
      changeSetId: run.changeSetId,
      negatives: out.negatives, positives: out.positives, productAds: out.productAds,
      ...(out.build ? { build: out.build } : {}),
      artifacts: out.artifacts,
      ...(problems.length ? { problems: problems.slice(0, 20) } : {}),
      note: [
        preview.reach.reach === 'live' ? 'Sent to Amazon as it ran.' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
        build ? `The missing slots build on their own: follow them with ads-playbook view build (applicationId ${build.applicationId}).` : '',
        'Read ads-playbook view drift again for what is left.',
      ].filter(Boolean).join(' '),
    },
    change: {
      before: { op: 'sync', playbookId: p.drift.playbook.id, changeSetId: run.changeSetId, negatives: [] },
      after: { op: 'sync', playbookId: p.drift.playbook.id, changeSetId: run.changeSetId, negatives: out.negatives.ids.map((targetId) => ({ targetId })), ...(build ? { applicationId: build.applicationId } : {}), added } satisfies SyncAfter,
    },
  }
}

/** The undo of a sync: its negatives retired (undo-ad-change of its change set); a build it started is archived apart. */
export async function syncUndoCurrent(after: SyncAfter): Promise<SyncAfter> {
  const ids = after.negatives.map((n) => n.targetId)
  const standing = ids.length ? await prisma.adTarget.findMany({ where: { id: { in: ids }, isNegative: true, status: { not: 'ARCHIVED' } }, select: { id: true } }) : []
  const keep = new Set(standing.map((t) => t.id))
  return { ...after, negatives: after.negatives.filter((n) => keep.has(n.targetId)) }
}

export function syncUndoRequest(after: SyncAfter, changeId?: string | null): { tool: string; args: Record<string, unknown> } | { refusal: string } {
  if (after.negatives.length) return { tool: 'undo-ad-change', args: { changeSetId: after.changeSetId, ...(changeId ? { changeId } : {}), why: 'undo of a playbook sync: the negatives it added are retired' } }
  if (after.applicationId) return { tool: 'archive-ads', args: { buildRunId: after.applicationId, why: 'undo of a playbook sync: the slots it built are archived for good' } }
  return { refusal: 'This sync added no negative and built no slot; what it added at the floor (keywords, product ads) is archived with archive-ads, one by one.' }
}
