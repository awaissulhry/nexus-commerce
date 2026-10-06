/**
 * ADS PLAYBOOK PB-5a — apply-ads-playbook: Claude asks to apply ONE product's playbook in ONE market (the playbook is the
 * business's own: ads-playbook reads it, set-ads-playbook changes it). Four ops: build and adopt (PB-5a), start and stop
 * (PB-5b).
 *
 *   build   create the slots the product does not hold yet, through the SP Super Wizard's own launch (Owner rule 1;
 *           ads-playbook/build.ts) — each campaign ENABLED at Amazon's 2¢ floor with its planned bids remembered
 *           (suppressed by the person who asked, never paused), OFF the live-write allowlist, without placements. It
 *           serves next to nothing (not nothing) until START. The plan is the dry run's (ads-playbook view compile),
 *           judged by the blueprint gate (Owner rule 3: only the product's own campaigns are kept apart); `execute`
 *           re-plans it and runs exactly what was approved, detached: it answers the run's id at once (view build).
 *   adopt   bind existing campaigns to the product's slots (ads-playbook/adopt.ts): Nexus only — nothing at Amazon, no
 *           allowlist, bid or rule moves; the playbook's own hourly plans follow the slots, switched off (PB-8, rank.ts).
 *   start   PB-5b — the built campaigns start spending (ads-playbook/start.ts): on the live-write allowlist, their
 *           planned bids back (never above what was remembered; a bid moved since stays; an engine's floor and an ad
 *           group's own floor stay), the placements the build deferred, the portfolio repair, then the playbook's
 *           hourly plans and rules switched on; a paused campaign is never enabled. It adds spend, so approving it needs
 *           the approver's authenticator code (stepUp) — by rule only where the business let it (allowStart, a
 *           loosening that itself needs the code) and the ads strategy runs both restore and allowlist alone.
 *   stop    PB-5b — the brake and START's undo: the built campaigns' bids to the 2¢ floor (remembered again; an engine's
 *           floor taken over), off the allowlist, then the playbook's hourly plans (their floors handed to the stop) and
 *           rules off. Never a pause, never an archive; no code (it lowers spend).
 *   sync    PB-10 — fix the product's drift (ads-playbook view drift), adding only (ads-playbook/sync.ts; the preview,
 *           the check by rule and the undo in ads-playbook-sync.ts): never deletes, archives or pauses; what adds spend
 *           waits for a person, a sync of negatives only may run by rule; a person's own change only when revert names it.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview says where it lands and a refusal is not queued; it runs only
 * as an approved request, as the approver, and refuses when what was approved moved. Strategy-bound (ads-autonomy-kit.ts):
 * a build is a kind of its own (create, as create-ad-campaign); it may run by the business's rule only inside the ads
 * strategy and this tool's limits — by default it does not (maxCampaigns 0: every build waits for a person). An adopt
 * only writes Nexus links: the strategy does not narrow it.
 *
 * Undo: a build — archive-ads of every campaign it made (buildRunId), permanent at Amazon; an adopt — the inverse adopt;
 * a start — a stop of the slots it started; a stop — a start of the slots it stopped (with the approver's code again).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { applyAdopt, planAdopt, type AdoptPlan } from '../../advertising/ads-playbook/adopt.js'
import { previewArtifacts } from '../../advertising/ads-playbook/artifacts.js'
import { buildRunCampaigns, inFlightRefusal, planBuild, startPlaybookBuild, type BuildPlan } from '../../advertising/ads-playbook/build.js'
import { planStart, runStart, runStop, type ApplyOp, type StartPlan } from '../../advertising/ads-playbook/start.js'
import { PLAYBOOK_MONEY, SLOT_KEY } from '../../advertising/ads-playbook/doc.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, requesterOf, storedReach, strategyFactsMoney, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote } from './ads-autonomy-kit.js'
import { STEP_UP_NEEDS, stepUpApproval } from '../step-up-approval.js'
import { executeSync, syncPreview, syncRefusal, syncUndoCurrent, syncUndoRequest, type SyncAfter, type SyncArgsIn } from './ads-playbook-sync.js'
import type { AgentTool, FieldPermission, ToolContext, ToolDoor, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'apply-ads-playbook'
const ID = z.string().trim().min(1).max(64)
const MAX_SLOTS = 30

const input = z.object({
  op: z.enum(['build', 'adopt', 'start', 'stop', 'sync', 'sync-negatives'])
    .describe("build: create the slots the product does not hold yet (born at the 2¢ floor, off the live-write allowlist, no placements: nothing spends until START); adopt: bind campaigns the product already runs to its slots (Nexus only); start: the built campaigns start spending (allowlist, planned bids, placements, then the playbook's hourly plans and rules; needs the approver's authenticator code); stop: the brake — built campaigns back to the 2¢ floor and off the allowlist, the hourly plans and rules off (never a pause); sync: fix its drift (ads-playbook view drift), adding only; sync-negatives: only its missing negatives (a kind of its own: it lowers spend)"),
  market: z.string().trim().toUpperCase().min(2).max(20).describe('ONE Amazon market code (IT, DE, FR, ES, UK; business-overview lists them)'),
  productId: ID.optional().describe('the product (a parent or a variation), its Nexus id; or sku'),
  sku: z.string().trim().min(1).max(100).optional().describe("instead of productId: the product's SKU in this business"),
  slots: z.array(SLOT_KEY).max(MAX_SLOTS).optional().describe('build: only these missing slots (slot keys from ads-playbook view compile); default: every slot the product does not hold. start / stop: only these built slots; default: every slot the playbook built'),
  bind: z.array(z.object({
    slot: SLOT_KEY.describe('the slot key'),
    campaignId: ID.describe('the campaign that plays it, its Nexus id (campaignId in ad-campaigns)'),
  })).max(MAX_SLOTS).optional().describe('adopt: campaigns named for slots (the others are matched by name, then by shape)'),
  unbind: z.array(SLOT_KEY).max(MAX_SLOTS).optional().describe('adopt: slots whose adopted campaign is taken off the playbook again (the undo of an adopt)'),
  fix: z.array(z.string().trim().min(1).max(200)).max(200).optional().describe('sync: only these drift items (their keys from ads-playbook view drift); default: every item sync fixes that no person made himself'),
  revert: z.array(z.string().trim().min(1).max(200)).max(200).optional().describe('sync: changes a person made himself to put back (their keys, byPerson in view drift); sync never puts one back unless it is named here'),
  expectVersion: z.number().int().min(0).optional().describe('the product playbook row version you read (ads-playbook): refused when it moved since'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const MOVED_ROW = 'The playbook row moved since you read it (expectVersion): read it again with ads-playbook.'
const UNDO_BUILD = "Undo archives every campaign the build made (archive-ads buildRunId): permanent at Amazon, an archived campaign never comes back."

/** What a build's preview says about each campaign it makes (the plan's detail is ads-playbook view compile). */
function campaignLines(p: BuildPlan) {
  return p.campaigns.map((c) => {
    const g = c.adGroups[0]
    const t = g?.targets ?? []
    const positive = t.filter((x) => !x.isNegative)
    return {
      slot: c.role, name: c.name, targeting: c.targetingType,
      dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100), startBidCents: g?.defaultBidCents ?? 0,
      keywords: positive.filter((x) => x.kind === 'KEYWORD').length, productTargets: positive.filter((x) => x.kind === 'PRODUCT').length,
      autoGroups: positive.filter((x) => x.kind === 'AUTO').length, negatives: t.length - positive.length,
      placementsAtStart: c.placementBidding.length,
    }
  })
}

/** The build, planned and judged: its preview, and the plan `execute` runs. */
async function buildPreview(a: Args, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plan?: BuildPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const out = await planBuild({ market: a.market, productId: a.productId, sku: a.sku, only: a.slots })
  if ('error' in out) return refuse(out.error)
  const p = out.data
  if (!p.playbook) return refuse(`${p.product.sku} has no product playbook row in ${p.market}: set one (set-ads-playbook), enroll it, then build.`)
  if (a.expectVersion != null && a.expectVersion !== p.playbook.version) return refuse(MOVED_ROW)
  if (!p.enrolled) return refuse(`${p.product.sku} is not enrolled in its playbook in ${p.market}: a person includes it first (set-ads-playbook op enroll).`)
  if (!p.compiles) return refuse(`The playbook does not compile yet: ${p.problems.join('; ')}.`)
  if (!p.campaigns.length) return refuse(a.slots?.length ? `Nothing to build: ${a.slots.join(', ')} ${a.slots.length === 1 ? 'is' : 'are'} held by a live campaign already.` : 'Nothing to build: every slot of the playbook is held by a live campaign (ads-playbook view compile).')
  if (!p.allowed) return refuse(`The blueprint gate refuses this build — ${p.blockers.join(' ')}`)
  // A dry run writes nothing: a build that stopped (no progress for 30 minutes) is only said here; the build marks it FAILED.
  const flying = await inFlightRefusal(p.market, p.nameToken!, p.playbook.id)
  if (flying && !flying.stopped) return refuse(`A build of this product is running (run ${flying.applicationId}): follow it with ads-playbook view build.`)
  const stoppedNote = flying?.stopped
    ? `An earlier build of this product (run ${flying.applicationId}) stopped${flying.campaign ? ` at "${flying.campaign}"` : ''} without finishing: this build marks it FAILED. What it made can be archived (archive-ads buildRunId ${flying.applicationId}) or adopted.`
    : null
  let currency: string
  try { currency = await marketCurrency('AMAZON', p.market) } catch (e) { return refuse((e as Error).message) }

  // Where it lands: a creation names no campaign yet, so the gate is asked as the launch asks it (no allowlist). Each
  // campaign is its own write: the gate's value cap is held against the largest single budget (the whole set's daily
  // budget is held by this tool's limits and the strategy's month, below).
  const largestBudgetCents = Math.max(0, ...p.campaigns.map((c) => Math.round(Number(c.dailyBudget ?? 0) * 100)))
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: p.market, payloadValueCents: largestBudgetCents }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)
  // The facts the business's rule is judged on: a build adds its daily budgets where its product is in the strategy.
  const facts = await buildLimitFacts({
    tool: TOOL, action: 'create',
    items: [{ entity: { kind: 'products', market: p.market, productIds: [p.product.productId] }, change: { field: 'dailyBudget', fromCents: null, toCents: p.dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: p.market }, select: { id: true } }))
  const artifacts = await previewArtifacts({
    playbookId: p.playbook.id, market: p.market, productId: p.product.productId, nameToken: p.nameToken!, doc: p.doc!,
    slots: p.linked.map((l) => ({ key: l.key, campaignId: l.campaignId, adGroupId: null, origin: 'built', rankRole: p.doc!.structure.slots.find((s) => s.key === l.key)?.rankRole ?? 'none' })),
    mode: 'build', actor: 'user:preview', changeSetId: null, compiledVersion: p.playbook.version,
  }, [])
  const floor = SUPPRESSION_FLOOR_CENTS
  const campaigns = campaignLines(p)
  const effect = `Builds ${plural(campaigns.length, 'Sponsored Products campaign')} of ${p.product.sku}'s playbook in ${p.market} through the SP Super Wizard's launch `
    + `(${campaigns.map((c) => c.slot).join(', ')}): ${amountLabel(p.dailyBudgetCents, currency)} of daily budget in all, advertising ${plural(p.productAds.length, 'ASIN')}. `
    + `Each is born ENABLED with every bid at the ${floor}-cent floor (the planned bids remembered; suppressed, never paused), off the live-write allowlist and without placements: `
    + 'it serves next to nothing (not nothing) until START puts it on the allowlist and its planned bids and placements back.'
  return {
    plan: p,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: 'build',
        market: p.market,
        product: p.product,
        playbook: p.playbook,
        currency,
        campaigns,
        totals: p.totals,
        dailyBudgetCents: p.dailyBudgetCents,
        highestPlannedBidCents: p.highestPlannedBidCents,
        productAds: p.productAds,
        portfolio: p.portfolio,
        linked: p.linked,
        sharedWithOtherProducts: p.sharedWithOtherProducts,
        skippedShared: p.skippedShared,
        acceptedShared: p.acceptedShared,
        startsSuppressed: { floorCents: floor, by: 'the person who asked', note: `Every bid above ${floor} cents starts at the ${floor}-cent floor and the bid planned is remembered: START puts them back.` },
        liveWrites: false,
        placements: 'deferred to START (a campaign off the allowlist is refused them)',
        ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaign in ${p.market}.` } : {}),
        warnings: [...p.warnings, ...(stoppedNote ? [stoppedNote] : [])],
        artifacts: artifacts.lines,
        ...(artifacts.errors.length ? { artifactErrors: artifacts.errors } : {}),
        basis: hash({ row: [p.playbook.id, p.playbook.version], template: p.template, campaigns: p.campaigns, productAds: p.productAds, portfolio: p.portfolio, linked: p.linked }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        nextSteps: ['ads-playbook view build (applicationId): follow the build', 'START (a later step) puts the campaigns on the allowlist and their planned bids and placements back'],
        undoNote: UNDO_BUILD,
        limitFacts: facts,
        limitsNote: limitsNote(facts),
      },
    },
  }
}

/** The adopt, planned: its preview, and the plan `execute` writes. */
async function adoptPreview(a: Args): Promise<{ result: ToolResult; plan?: AdoptPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const out = await planAdopt({ market: a.market, productId: a.productId, sku: a.sku, bind: a.bind, unbind: a.unbind })
  if ('error' in out) return refuse(out.error)
  const p = out.data
  if (a.expectVersion != null && a.expectVersion !== p.playbook.version) return refuse(MOVED_ROW)
  if (p.problems.length) return refuse(`Not queued: ${p.problems.join('; ')}.`)
  if (!p.bindings.length && !p.unbinds.length) {
    const why = [
      p.ambiguous.length ? `${p.ambiguous.map((x) => `slot "${x.slot}" could be ${x.campaignIds.join(' or ')}`).join('; ')} (name one with bind)` : '',
      p.outside.length ? `${plural(p.outside.length, 'campaign')} play no free slot` : '',
      p.empty.length ? `no campaign plays ${p.empty.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    return refuse(`Nothing to adopt for ${p.product.sku} in ${p.market}${why ? `: ${why}` : ''}.`)
  }
  // The playbook's own artifacts after the adopt (PB-8: its hourly plans follow the slots, created switched off).
  const rankRole = (key: string) => p.doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'
  const after = [...p.linked, ...p.bindings.map((b) => ({ slot: b.slot, campaignId: b.campaignId }))]
  const artifacts = await previewArtifacts({
    playbookId: p.playbook.id, market: p.market, productId: p.product.productId, nameToken: p.nameToken, doc: p.doc,
    slots: after.map((l) => ({ key: l.slot, campaignId: l.campaignId, adGroupId: null, origin: 'adopted', rankRole: rankRole(l.slot) })),
    mode: 'adopt', actor: 'user:preview', changeSetId: null, compiledVersion: p.playbook.version,
  }, [])
  const effect = `Binds ${plural(p.bindings.length, 'campaign')} ${p.product.sku} already runs in ${p.market} to its playbook's slots`
    + `${p.bindings.length ? ` (${p.bindings.map((b) => `${b.slot} ← "${b.name}"`).join(', ')})` : ''}`
    + `${p.unbinds.length ? `, and takes ${plural(p.unbinds.length, 'adopted slot')} off again (${p.unbinds.map((u) => u.slot).join(', ')})` : ''}. `
    + 'Nexus only: nothing is sent to Amazon by the links, and no bid, allowlist or rule of these campaigns changes. '
    + "The playbook's own hourly plans follow its slots (artifacts): created switched off, nothing runs until START; a campaign taken off a plan that is on leaves it at STOP; an hourly plan the playbook did not make is never touched."
    + (Object.keys(p.placementBaseline).length ? ` Each adopted slot the hourly plans do not own keeps the placements its campaign holds now as its baseline (${Object.keys(p.placementBaseline).join(', ')}): drift shows only what changes after.` : '')
  return {
    plan: p,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: 'adopt',
        market: p.market,
        product: p.product,
        playbook: p.playbook,
        bindings: p.bindings.map((b) => ({ slot: b.slot, campaignId: b.campaignId, name: b.name, why: b.why })),
        unbinds: p.unbinds,
        ambiguous: p.ambiguous,
        outside: p.outside,
        empty: p.empty,
        linked: p.linked,
        ...(p.portfolioId ? { portfolio: { portfolioId: p.portfolioId, does: 'link' } } : {}),
        warnings: p.warnings,
        ...(Object.keys(p.placementBaseline).length ? { placementBaseline: p.placementBaseline } : {}),
        artifacts: artifacts.lines,
        ...(artifacts.errors.length ? { artifactErrors: artifacts.errors } : {}),
        basis: p.basis,
        reachNote: 'Nexus only: nothing is sent to Amazon by this change.',
        effect,
        undoNote: 'Undo asks for the opposite adopt (the slots bound here taken off, the ones taken off bound again).',
      },
    },
  }
}

/** How a START is approved, in one sentence (its stepUp). */
const START_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked '
  + 'confirms it in Claude with theirs when the business set apply-ads-playbook to confirm in Claude. By rule only where the business '
  + 'allows a start (allowStart) and the ads strategy lets both a restore and the allowlist run alone.'

/** What a START or a STOP does to one campaign, as its preview lists it (each count, never a money total in words). */
function campaignOpLine(op: ApplyOp, c: StartPlan['campaigns'][number]) {
  const bids = c.bids.does === 'restore'
    ? { does: 'restore', adGroups: c.bids.adGroups, targets: c.bids.targets, highestCents: c.bids.highestCents, ...(c.bids.held.length ? { held: c.bids.held.slice(0, 10) } : {}), ...(c.bids.left.length ? { left: c.bids.left.slice(0, 10), leftCount: c.bids.left.length } : {}) }
    : c.bids.does === 'floor' || c.bids.does === 'refloor' ? { does: c.bids.does, floorCents: c.bids.floorCents, adGroups: c.bids.adGroups, targets: c.bids.targets }
      : c.bids.does === 'held' ? { does: 'held', by: c.bids.by } : { does: 'none', why: c.bids.why }
  return {
    slot: c.slot, campaignId: c.campaignId, name: c.name, status: c.status, dailyBudgetCents: c.dailyBudgetCents,
    allowlist: c.allowlist, bids,
    ...(op === 'start' ? { placements: c.placements.does === 'apply' ? { does: 'apply', placements: c.placements.adjustments.length } : c.placements } : {}),
    ...(c.ownFloors ? { ownFloors: c.ownFloors } : {}),
    ...(c.paused ? { paused: c.paused } : {}),
    spends: c.spends,
  }
}

/** A START or a STOP, planned and judged: its preview, and the plan `execute` runs. */
async function startPreview(a: Args, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plan?: StartPlan }> {
  const op = a.op as ApplyOp
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const out = await planStart({ op, market: a.market, productId: a.productId, sku: a.sku, slots: a.slots })
  if ('error' in out) return refuse(out.error)
  const p = out.data
  if (a.expectVersion != null && a.expectVersion !== p.playbook.version) return refuse(MOVED_ROW)
  if (p.problems.length) return refuse(`Not queued: ${p.problems.join('; ')}.`)
  const acting = op === 'start'
    ? p.campaigns.filter((c) => c.allowlist === 'on' || c.bids.does === 'restore' || c.placements.does === 'apply')
    : p.campaigns.filter((c) => c.allowlist === 'off' || c.bids.does === 'floor' || c.bids.does === 'refloor')
  const switching = p.artifacts.some((l) => l.does === (op === 'start' ? 'enable' : 'disable'))
  if (!acting.length && !switching && !p.heldFloors.length && !p.syncedBids.length) {
    return refuse(op === 'start'
      ? `Nothing to start: every campaign the playbook built for ${p.product.sku} in ${p.market} runs already (on the allowlist, at its bids) and its hourly plans and rules are on.`
      : `Nothing to stop: every campaign the playbook built for ${p.product.sku} in ${p.market} is at the floor and off the allowlist already, and its hourly plans and rules are off.`)
  }
  let currency: string
  try { currency = await marketCurrency('AMAZON', p.market) } catch (e) { return refuse((e as Error).message) }

  // Where it lands: the market's gate (the campaigns are off the allowlist before a START, so it is asked as a launch
  // asks it); a STOP only lowers, so a halt does not refuse it.
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: p.market, payloadValueCents: op === 'start' ? p.highestRestoredBidCents : 0, ...(op === 'stop' ? { isSuppression: true } : {}) }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)
  // START — the facts a run by rule is judged on: the product's campaigns spend again (their daily budgets in full, in
  // the month's forecast), the restore kind (the strategy narrows it by the allowlist kind too: ads-strategy/claude.ts).
  const facts = op === 'start'
    ? await buildLimitFacts({
        tool: TOOL, action: 'restore', projectMonth: true,
        items: [{ entity: { kind: 'products', market: p.market, productIds: [p.product.productId], label: `${p.product.sku}'s playbook campaigns` }, change: { field: 'status', from: 'LOW_BIDS', to: 'ENABLED', dailyBudgetCents: p.dailyBudgetCents } }],
        approvalId: ctx.approvalId ?? null,
      })
    : null
  const campaigns = p.campaigns.map((c) => campaignOpLine(op, c))
  // The playbook's hourly plans a START switches on raise bids too (top of search): part of what the code approves.
  const rankOn = p.artifacts.filter((l) => l.kind === 'rankGroup' && l.does === 'enable').length
  const paused = p.campaigns.filter((c) => c.paused).length
  const effect = op === 'start'
    ? `Starts ${p.product.sku}'s playbook in ${p.market}: ${plural(acting.length, 'campaign')} it built ${acting.length === 1 ? 'goes' : 'go'} on the live-write allowlist with ${acting.length === 1 ? 'its' : 'their'} planned bids and placements back — `
      + `${plural(p.spending, 'campaign')} start${p.spending === 1 ? 's' : ''} spending at once`
      + `${paused ? ` (${paused} paused at Amazon ${paused === 1 ? 'stays' : 'stay'} paused: a person enables ${paused === 1 ? 'it' : 'them'} in Nexus)` : ''}`
      + `${p.heldFloors.length ? `, and ${plural(p.heldFloors.length, 'other campaign')} of the playbook ${p.heldFloors.length === 1 ? 'gets its' : 'get their'} bids back from the floor its stop held` : ''}; `
      + `${p.syncedBids.length ? `${plural(p.syncedBids.length, 'keyword or target')} a sync added at the floor ${p.syncedBids.length === 1 ? 'gets its' : 'get their'} planned bid; ` : ''}`
      + "then the playbook's hourly plans and rules are switched on. An engine's floor and an ad group's own floor (stock, a product's monthly cap) stay; a bid moved since the build stays where it is."
    : `Stops ${p.product.sku}'s playbook in ${p.market}: every bid of ${plural(acting.length, 'campaign')} it built goes to the ${SUPPRESSION_FLOOR_CENTS}-cent floor (remembered: START puts them back) and off the live-write allowlist, `
      + "then the playbook's hourly plans and rules are switched off — the floors an hourly plan set stay, held by the stop, and only START gives them back. "
      + 'Never a pause, never an archive: a START brings it back in about a minute.'
  const summary = {
    campaigns: acting.length, spending: p.spending, slots: acting.map((c) => c.slot), artifacts: p.artifacts.filter((l) => l.does !== 'keep').map((l) => `${l.kind}:${l.key}:${l.does}`),
    ...(p.heldFloors.length ? { heldFloors: p.heldFloors.map((h) => h.slot) } : {}),
    ...(p.floorsTaken.length ? { floorsTaken: p.floorsTaken.map((t) => t.slot) } : {}),
  }
  return {
    plan: p,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op,
        market: p.market,
        product: p.product,
        playbook: p.playbook,
        currency,
        campaigns,
        ...(op === 'start' ? { starts: summary } : { stops: summary }),
        untouched: p.untouched,
        // START: the floors a stop holds on the playbook's other campaigns (an adopted one's hourly plan), given back.
        ...(p.heldFloors.length ? { heldFloors: p.heldFloors.map((h) => ({ slot: h.slot, campaignId: h.campaignId, name: h.name, origin: h.origin, status: h.status, adGroups: h.bids.adGroups, targets: h.bids.targets, highestCents: h.bids.highestCents })) } : {}),
        // STOP: the hourly plans' floors it takes over (kept at the floor; only START gives them back).
        ...(p.floorsTaken.length ? { floorsTaken: p.floorsTaken } : {}),
        // PB-10 — START: what a sync added at the floor, each with its planned bid (startBidCents: money).
        ...(p.syncedBids.length ? { syncedBids: p.syncedBids } : {}),
        ...(op === 'start' ? { highestRestoredBidCents: p.highestRestoredBidCents, dailyBudgetCents: p.dailyBudgetCents } : {}),
        artifacts: p.artifacts,
        ...(p.artifactErrors.length ? { artifactErrors: p.artifactErrors } : {}),
        warnings: p.warnings,
        ...(op === 'start'
          ? { stepUp: { what: `starts spending on ${plural(p.spending, 'campaign')}${rankOn ? ` and switches on ${plural(rankOn, 'hourly bid plan')}` : ''}`, raises: ['Bids', 'Spend', ...(rankOn ? ['Hourly bid plans'] : [])], needs: STEP_UP_NEEDS, how: START_HOW } }
          : { noCode: 'A stop lowers spend: it needs no authenticator code.' }),
        basis: hash({ op, row: [p.playbook.id, p.playbook.version], campaigns: p.campaigns, untouched: p.untouched, heldFloors: p.heldFloors, floorsTaken: p.floorsTaken, artifacts: p.artifacts, syncedBids: p.syncedBids }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        undoNote: op === 'start'
          ? 'Undo asks for a STOP of the campaigns this start started (their bids back to the floor, off the allowlist).'
          : 'Undo asks for a START of the campaigns this stop stopped (it needs the approver\'s authenticator code again).',
        ...(facts ? { limitFacts: facts, limitsNote: limitsNote(facts) } : {}),
      },
    },
  }
}

/** The door a request came through, as the version row records it. */
const VIA: Record<ToolDoor, string> = { claude: 'claude', app: 'assistant', fleet: 'fleet', system: 'system' }

/**
 * Claude's limits for a build run by rule: the kit's (one product per request), and the most campaigns, daily budget and
 * highest planned bid a build may make without a person — 0 by default: every build waits for a person until he types a
 * number — and the markets.
 */
const APPLY_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxCampaigns: z.number().int().min(0).max(MAX_SLOTS).default(0).describe('build: the most campaigns one build may create by rule; 0 = every build waits for a person'),
  maxDailyBudgetCents: z.number().int().min(0).default(0).describe("build: the most daily budget (all its campaigns, minor units of the market's currency) one build may create by rule; 0 = every build waits for a person"),
  maxBidCents: z.number().int().min(0).default(0).describe("build: the highest planned bid (restored at START) a build created by rule may hold; start: the highest bid a start by rule may put back — in minor units of the market's currency"),
  // PB-5b — a start adds spend: off by default, so every start waits for a person with their authenticator code.
  allowStart: z.boolean().default(false).describe('start: let a start run by rule (inside the other limits and the ads strategy); off by default — every start then waits for a person, who approves it with their authenticator code'),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([]).describe('the markets where it may run by rule (empty = every market)'),
})

/**
 * PB-5a — apply-ads-playbook's own checks around the kit's (C1–C7, the month). Pure. PB-5b — a stop is a brake (never
 * held by a limit); a start runs by rule only with allowStart, and puts back no bid above maxBidCents or the strategy's
 * highest bid.
 */
function applyRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    op?: string; market?: string; newMarket?: boolean; campaigns?: unknown[]; dailyBudgetCents?: number; highestPlannedBidCents?: number; highestRestoredBidCents?: number; currency?: string
  }
  if (!p.op) return 'there is no preview of this playbook apply to check; a person decides'
  if (p.op === 'stop') return null
  const markets = (limits.markets as string[] | undefined) ?? []
  if (p.market && markets.length && !markets.includes(p.market)) return `this business lets a playbook apply run by rule only in ${markets.join(', ')}`
  if (p.op === 'adopt') return null
  // PB-10 — a sync runs by rule only when it adds no spend (its negatives), inside the kit's limits.
  if (p.op === 'sync' || p.op === 'sync-negatives') return syncRefusal(preview, limits)
  if (p.op === 'start' && limits.allowStart !== true) return "it starts spending: a person decides, with their authenticator code (this business does not let a start run by rule: allowStart is off)"
  const common = commonRefusal(preview, limits)
  if (common) return common
  const currency = p.currency ?? 'EUR'
  if (p.op === 'start') return highestBidRefusal(preview, p.highestRestoredBidCents ?? 0, 'highest restored bid', limits, currency)
  if (p.op !== 'build') return `op ${p.op} is not one this tool runs by rule; a person decides`
  if (p.newMarket) return `it builds the first campaigns in ${p.market}: a person decides a new market`
  const n = p.campaigns?.length ?? 0
  const maxCampaigns = typeof limits.maxCampaigns === 'number' ? limits.maxCampaigns : 0
  if (n > maxCampaigns) return `it creates ${plural(n, 'campaign')}, more than the ${maxCampaigns} this tool's limits let a build create by rule${maxCampaigns === 0 ? ' (0: every build waits for a person)' : ''}; a person decides`
  const budget = typeof limits.maxDailyBudgetCents === 'number' ? limits.maxDailyBudgetCents : 0
  if ((p.dailyBudgetCents ?? 0) > budget) return `its daily budgets add up to ${amountLabel(p.dailyBudgetCents ?? 0, currency)}, more than the ${amountLabel(budget, currency)} this tool's limits let a build create by rule; a person decides`
  return highestBidRefusal(preview, p.highestPlannedBidCents ?? 0, 'highest planned bid', limits, currency)
}

/** A bid a build plans (or a start puts back) above this tool's maxBidCents, or the strategy's highest bid where it lands. */
function highestBidRefusal(preview: unknown, highest: number, words: string, limits: Record<string, unknown>, currency: string): string | null {
  const bid = typeof limits.maxBidCents === 'number' ? limits.maxBidCents : 0
  if (highest > bid) return `its ${words} ${amountLabel(highest, currency)} is above the ${amountLabel(bid, currency)} this tool's limits allow by rule; a person decides`
  const facts = limitFactsOf(preview)
  for (const scope of Object.values(facts?.scopes ?? {})) {
    const max = scope.limits.maxBidCents
    if (max == null || !scope.sources.maxBid || highest <= max) continue
    return `its ${words} ${amountLabel(highest, currency)} is above the highest bid ${amountLabel(max, currency)} (${strategyWords(scope.sources.maxBid)}); a person decides`
  }
  return null
}

/** What a change of this tool recorded: the op, and its run (build), its links (adopt) or the slots it moved (start, stop). */
type ApplyAfter =
  | { op: 'build'; playbookId: string; applicationId: string }
  | { op: 'adopt'; playbookId: string; market: string; productId: string; bound: Array<{ slot: string; campaignId: string }>; unbound: Array<{ slot: string; campaignId: string }> }
  | { op: 'start' | 'stop'; playbookId: string; market: string; productId: string; slots: string[]; state: string | null; whole?: boolean }
  | SyncAfter

/**
 * Undo: a build is archived (archive-ads buildRunId, permanent at Amazon); an adopt is the inverse adopt; a start is a
 * stop of the slots it started, a stop a start of the slots it stopped — while the row's state is still what it left.
 */
export const APPLY_PLAYBOOK_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as ApplyAfter
    if (after.op === 'build') {
      // A build stands while a campaign it made is not archived (one still running stands too: archive-ads waits for it).
      const run = await buildRunCampaigns(after.applicationId)
      const standing = 'refusal' in run ? /still running/.test(run.refusal) : run.campaignIds.length > 0
      return standing ? { op: 'build', playbookId: after.playbookId, applicationId: after.applicationId } : { op: 'build', playbookId: after.playbookId, applicationId: after.applicationId, archived: true }
    }
    if (after.op === 'adopt') {
      const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId: after.playbookId, kind: 'slot' }, select: { key: true, refId: true } })
      const has = (s: { slot: string; campaignId: string }) => links.some((l) => l.key === s.slot && l.refId === s.campaignId)
      return { ...after, bound: after.bound.filter(has), unbound: after.unbound.filter((u) => !has(u)) }
    }
    if (after.op === 'start' || after.op === 'stop') {
      const row = await prisma.adsPlaybook.findUnique({ where: { id: after.playbookId }, select: { state: true } })
      return { ...after, state: row?.state ?? null }
    }
    if (after.op === 'sync') return syncUndoCurrent(after)
    return change.after
  },
  request(change) {
    const after = (change.after ?? {}) as ApplyAfter
    if (after.op === 'build') {
      return after.applicationId
        ? { tool: 'archive-ads', args: { buildRunId: after.applicationId, why: 'undo of a playbook build: archived for good' } }
        : { refusal: 'This change does not name the build it started.' }
    }
    if (after.op === 'adopt') {
      if (!after.bound.length && !after.unbound.length) return { refusal: 'This adopt bound and unbound nothing.' }
      return {
        tool: TOOL,
        args: {
          op: 'adopt', market: after.market, productId: after.productId,
          ...(after.bound.length ? { unbind: after.bound.map((b) => b.slot) } : {}),
          ...(after.unbound.length ? { bind: after.unbound } : {}),
          why: 'undo of a playbook adopt',
        },
      }
    }
    if (after.op === 'start' || after.op === 'stop') {
      if (!after.slots?.length) return { refusal: `This ${after.op} ${after.op === 'start' ? 'started' : 'stopped'} no campaign (each one was ${after.op === 'start' ? 'running' : 'stopped'} already): there is nothing of it to undo.` }
      const back = after.op === 'start' ? 'stop' : 'start'
      // A start or a stop of the whole playbook is undone whole (its hourly plans, their floors and its rules with it).
      return { tool: TOOL, args: { op: back, market: after.market, productId: after.productId, ...(after.whole ? {} : { slots: after.slots }), why: `undo of a playbook ${after.op}` } }
    }
    if (after.op === 'sync') return syncUndoRequest(after, change.id)
    return { refusal: 'This change does not record what it applied.' }
  },
}

const applyAdsPlaybook: AgentTool = {
  name: TOOL,
  title: 'Apply the ads playbook',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, F.adsAutomationManage, FIELDS.financialsAdspendView],
  restrictedFields: {
    ...PLAYBOOK_MONEY, ...strategyFactsMoney(),
    ...Object.fromEntries(['highestPlannedBidCents', 'highestRestoredBidCents', 'highestCents', 'rememberedCents', 'toCents', 'bidCents'].map((key) => [key, FIELDS.financialsAdspendView])),
  } as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // A build is undone by archiving what it made (permanent at Amazon; what it spent stays spent); an adopt in full; a
  // start by a stop (what it spent stays spent), a stop by a start.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: APPLY_LIMITS,
  withinLimits: applyRefusal,
  undo: APPLY_PLAYBOOK_UNDO,
  description:
    "Apply ONE product's Amazon ads playbook in ONE market (ads-playbook reads it). op build creates the slots the product "
    + "does not hold yet through the SP Super Wizard's own launch: each campaign born at the 2-cent floor (its planned "
    + 'bids remembered; suppressed, never paused), off the live-write allowlist and without placements, so it spends next '
    + 'to nothing until a later START. The plan is the dry run of ads-playbook view compile, held to the blueprint gate '
    + '(only the product\'s own campaigns are kept apart; another product may buy the same keyword). It runs on its own '
    + 'once approved: follow it with ads-playbook view build. op adopt binds campaigns the product already runs to its '
    + 'slots (bind names some; the rest match by name, then by shape): Nexus only, nothing at Amazon moves (the playbook\'s '
    + 'own hourly plans follow the slots, switched off until START; one another plan holds is never taken). op start '
    + 'makes the campaigns the playbook built spend: on the live-write allowlist, their planned bids back (never above '
    + 'what was planned; a bid moved since, an engine\'s floor and an ad group\'s own floor stay), the placements the build '
    + 'held back, then the playbook\'s hourly plans and rules switched on; a paused campaign is never enabled and an adopted '
    + 'one is left as it is. Starting to spend needs the approver\'s authenticator code (in Nexus, or the person who asked '
    + 'confirms it in Claude). op stop is the brake: the built campaigns\' bids to the 2-cent floor (remembered), off the '
    + 'allowlist, the hourly plans and rules off — never a pause; it needs no code. A person approves it in Nexus, unless '
    + 'the business lets it run by its rule inside its limits and the ads strategy (by default a build does not: '
    + 'maxCampaigns 0; a start does not: allowStart off). Refused, and not queued, when the product is not enrolled, '
    + 'nothing is missing (or nothing to start or stop), the gate or Amazon\'s write gate refuses it, or a build of it is '
    + 'already running. Undo: a build is archived (archive-ads, permanent at Amazon); an adopt is reversed by the opposite '
    + 'adopt; a start by a stop, a stop by a start. '
    + 'op sync fixes the drift ads-playbook view drift lists, ADDING ONLY (it never deletes, archives or pauses): missing '
    + 'isolation, source and product negatives (through the negative write service; only inside this product\'s own '
    + 'campaigns), missing or misplaced keywords and competitor ASINs and missing product ads (at the 2-cent floor, the '
    + 'planned bid remembered), missing slots (built as op build builds them), and compiled rules or hourly plans saved '
    + 'again (Nexus only). A winning search term is never moved. A change a person made himself is never put back unless '
    + 'revert names it (keep it with set-ads-playbook instead). What adds spend waits for a person; a sync of negatives '
    + 'only may run by the business\'s rule inside its limits — op sync-negatives (its negatives only; the strategy\'s '
    + 'negative kind; op sync is its create kind); never one that puts back a person\'s own change. Undo retires the '
    + 'negatives it added (undo-ad-change).',
  async handler(args, ctx) {
    const a = args as Args
    if (a.op === 'start' || a.op === 'stop') return (await startPreview(a, ctx)).result
    if (a.op === 'sync' || a.op === 'sync-negatives') return (await syncPreview(a as SyncArgsIn, ctx)).result
    return a.op === 'adopt' ? (await adoptPreview(a)).result : (await buildPreview(a, ctx)).result
  },
  async execute(args, ctx) {
    const a = args as Args
    const approvalId = ctx.approvalId?.trim()
    const decision = approvalId ? await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { decidedBy: true } }) : null
    const writerOf = (changeSetId: string) => ({
      via: VIA[ctx.via] ?? ctx.via,
      actor: decision?.decidedBy ?? `user:${ctx.userId}`,
      actorUserId: ctx.userId ?? null,
      approvalId: changeSetId,
      updatedBy: ctx.via === 'claude' ? `claude:${changeSetId}` : `user:${ctx.userId}`,
    })
    if (a.op === 'sync' || a.op === 'sync-negatives') return executeSync(a as SyncArgsIn, ctx, writerOf)

    if (a.op === 'adopt') {
      const fresh = await adoptPreview(a)
      if (!fresh.result.ok || !fresh.plan) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid adopt'}`)
      const before = (ctx.approvedPreview ?? {}) as Record<string, unknown>
      const now = fresh.result.preview as Record<string, unknown>
      const moved = ['op', 'basis', 'bindings'].filter((k) => k in before && canonical(before[k]) !== canonical(now[k]))
      if (moved.length) return notRun(`Not run: what you approved has moved since — ${moved.join(', ')} changed. Ask for it again with the campaigns as they are now.`)
      const run = approvedRun(ctx, a.why ?? String(now.effect ?? ''))
      if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
      const p = fresh.plan
      const out = await applyAdopt(p, { ...writerOf(run.changeSetId), changeSetId: run.changeSetId })
      if ('error' in out) return notRun(`Not run: ${out.error}`)
      return {
        ok: true,
        data: { bound: out.bound, unbound: out.unbound, ...(out.errors.length ? { errors: out.errors } : {}), note: 'Saved in Nexus: nothing was sent to Amazon.' },
        change: {
          before: { op: 'adopt', playbookId: p.playbook.id, linked: p.linked },
          after: { op: 'adopt', playbookId: p.playbook.id, market: p.market, productId: p.product.productId, bound: p.bindings.map((b) => ({ slot: b.slot, campaignId: b.campaignId })), unbound: p.unbinds },
        },
      }
    }

    if (a.op === 'start' || a.op === 'stop') {
      const op = a.op
      const fresh = await startPreview(a, ctx)
      if (!fresh.result.ok || !fresh.plan) return notRun(`Not run: ${fresh.result.error ?? `it is no longer a valid ${op}`}`)
      const refusal = recheck(ctx, fresh.result, ['op', 'basis', 'reach'])
      if (refusal) return notRun(refusal)
      const preview = fresh.result.preview as { reach: StoredReach; effect: string }
      const run = approvedRun(ctx, a.why ?? preview.effect)
      if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
      // A start adds spend: approved with the approver's fresh code, or run by the business's rule (allowStart, itself a
      // loosening that needed the code). A stop lowers spend: no code.
      let stepUpAt: Date | null = null
      if (op === 'start' && ctx.decidedVia !== 'auto') {
        const coded = await stepUpApproval(ctx)
        if ('refusal' in coded) return notRun(coded.refusal.replace('a raise runs', 'a start runs').replace('it raises', 'it starts spending').replace('a raise needs', 'a start needs'))
        stepUpAt = coded.at
      }
      const p = fresh.plan
      const writer = { ...writerOf(run.changeSetId), stepUpAt }
      const out = op === 'start' ? await runStart(p, run, writer) : await runStop(p, run, writer)
      const moved = out.done.length
      const data = {
        op, [op === 'start' ? 'started' : 'stopped']: out.done, state: out.state, reach: preview.reach, changeSetId: run.changeSetId,
        ...(out.failed.length ? { failed: out.failed } : {}),
        ...(out.left.length ? { leftAsTheyStand: out.left } : {}),
        ...(out.artifacts.length ? { artifactsSwitched: out.artifacts } : {}),
        ...(out.floorsHeld.length ? { floorsHeld: out.floorsHeld, floorsHeldNote: 'Their hourly plans\' floors are the stop\'s now: they stay at the floor until START gives their bids back (restore-campaign refuses them).' } : {}),
        ...(out.syncedBids ? { syncedBidsGiven: out.syncedBids } : {}),
        ...(out.errors.length ? { errors: out.errors } : {}),
        note: op === 'start'
          ? `${plural(moved, 'campaign')} started: on the live-write allowlist, planned bids and placements back; each bid write is sent to Amazon at once.`
          : `${plural(moved, 'campaign')} stopped: bids at the ${SUPPRESSION_FLOOR_CENTS}-cent floor (remembered) and off the live-write allowlist. Nothing was paused.`,
      }
      const change = {
        before: { op, playbookId: p.playbook.id, state: p.playbook.state, slots: p.campaigns.map((c) => ({ slot: c.slot, campaignId: c.campaignId, allowlist: c.allowlist, bids: c.bids.does })) },
        after: { op, playbookId: p.playbook.id, market: p.market, productId: p.product.productId, slots: out.done.filter((slot) => p.campaigns.some((c) => c.slot === slot)), state: out.state, ...(a.slots?.length ? {} : { whole: true }) },
      }
      if (!moved && out.failed.length) return { ok: false, error: `Not ${op === 'start' ? 'started' : 'stopped'}: ${out.failed.map((f) => `${f.slot}: ${f.why}`).join('; ')}`, data, change }
      return { ok: true, data, change }
    }

    const fresh = await buildPreview(a, ctx)
    // What is no longer a valid build (the product deleted, nothing missing) is said as it is, before the re-check.
    if (!fresh.result.ok) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid build'}`)
    const refusal = recheck(ctx, fresh.result, ['op', 'basis', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.plan!
    const preview = fresh.result.preview as { reach: StoredReach; effect: string }
    const run = approvedRun(ctx, a.why ?? preview.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const requester = await requesterOf(ctx, run.actor)
    const started = await startPlaybookBuild({ plan: p, actor: run.actor, requester, changeSetId: run.changeSetId, writer: writerOf(run.changeSetId) })
    if ('refusal' in started) return notRun(`Not run: ${started.refusal}`)
    if (started.alreadyRunning) return notRun(`Not run: a build of this product is already running (run ${started.applicationId}): follow it with ads-playbook view build.`)
    return {
      ok: true,
      data: {
        applicationId: started.applicationId,
        status: 'RUNNING',
        reach: preview.reach,
        changeSetId: run.changeSetId,
        note: `Runs on its own; follow it with ads-playbook view build (applicationId ${started.applicationId}). Born at ${SUPPRESSION_FLOOR_CENTS}¢ and off the live-write allowlist — nothing spends until START.`,
      },
      change: {
        before: { op: 'build', playbookId: p.playbook!.id, state: p.playbook!.state, slots: p.linked },
        after: { op: 'build', playbookId: p.playbook!.id, applicationId: started.applicationId },
      },
    }
  },
}

export const ADS_PLAYBOOK_APPLY_TOOLS: AgentTool[] = [applyAdsPlaybook]
