/**
 * ADS PLAYBOOK PB-5b — START a built playbook, and STOP it again (its undo, a brake). One product in one market. A build
 * leaves each campaign it made ENABLED at the 2¢ floor with its planned bids remembered, off the live-write allowlist and
 * without placements (build.ts): nothing spends until START.
 *
 *   start   for each campaign the playbook BUILT, in this order (allowlist first, so a run by rule passes the gate):
 *             1 on the live-write allowlist, when it is off
 *             2 the planned bids back (restoreCampaignBids `planned`): only a floor a person or a build set (a `user:`
 *               actor) — an engine's floor (dayparting, budget, retail, an hourly plan's window) is named "held by"
 *               and left, and an ad group at its own floor (stock, a product's monthly cap) stays; each bid goes back
 *               never above the bid remembered, and one that left the floor since (an engine or a person moved it)
 *               stays where it is, named. PB-9 — a slot the product's CURRENT phase floors (the strategy's goal; e.g.
 *               DEFEND's research slots) keeps its floor, named "held by phase …": a phase switch releases it
 *             3 the placements the build deferred (build run options `deferredPlacements`), only onto a campaign that
 *               holds none: placements set since the build are left, named
 *           then the portfolio read-back repair (settleLaunchPortfolios: it passes the allowlist now), the playbook's
 *           artifacts switched on (ARTIFACT_COMPILERS setEnabled: hourly plans, harvest and isolation rules — never
 *           over a person's switch-off), and the row's state RUNNING. A campaign PAUSED at Amazon is prepared but never
 *           enabled: a person enables it in Nexus. A campaign the playbook ADOPTED is the business's own: its
 *           allowlist, bids and placements are left as they are (named); the artifacts cover it.
 *   stop    for each built campaign: every bid to the 2¢ floor, remembered again (suppressCampaignBids; never a pause,
 *           never an archive; a floor already set stays its owner's), then off the allowlist. Once no built campaign of the playbook runs (on the allowlist
 *           and not at a person's floor), its artifacts are switched off AFTER the floors — each hourly plan with its
 *           floors handed to the stop's approver, never given back (rank.ts: the bids stay at 2¢ until START), each
 *           compiled rule recorded as the playbook's own stop, so the next START switches it on again (artifacts.ts,
 *           rules.ts) — and the row's state is STOPPED; while one still runs (a
 *           stop of some slots), they stay on and the row stays RUNNING, said.
 *
 * Idempotent: each step skips what is done (a re-run of START writes nothing new). The preview (`planStart`) reads
 * everything and writes nothing; the tool (apply-ads-playbook op start | stop) re-plans it on approval and runs it.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { giveBackBounds, plannedGiveBack, SUPPRESSION_FLOOR_CENTS } from '../ads-bid-suppression.service.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { ARTIFACT_COMPILERS, previewArtifacts, type ArtifactCompiler, type ArtifactContext, type ArtifactPreviewLine, type StoredArtifactLink } from './artifacts.js'
import { loadProductPlaybook } from './build-preview.js'
import type { BuildRunOptions } from './build.js'
import type { RankRole, TemplateDoc } from './doc.js'
import { STOP_FLOOR_KIND } from './held.js'
import { rankOffEffect } from './rank.js'
import { PHASE_FLOOR_KIND, phaseNow, recordPhaseFloor } from './phase.js'
import { recordPlaybookApply, type PlaybookApplyWriter } from './write.js'

export type ApplyOp = 'start' | 'stop'

type Placement = { placement: string; percentage: number }

/** What a START or a STOP does to one campaign the playbook built. */
export interface StartCampaign {
  slot: string
  campaignId: string
  name: string
  /** At Amazon: ENABLED, PAUSED. */
  status: string
  dailyBudgetCents: number
  currency: string
  /** The live-write allowlist: what the op does. */
  allowlist: 'on' | 'off' | 'already'
  /** The bids: START puts them back, STOP floors them; held: an engine's floor, left (START); none: nothing to do. */
  bids:
    | { does: 'restore'; floorCents: number; adGroups: number; targets: number; highestCents: number
        held: Array<{ text: string; rememberedCents: number; toCents: number; heldBy: string }>
        left: Array<{ text: string; bidCents: number; rememberedCents: number }> }
    | { does: 'floor'; floorCents: number; adGroups: number; targets: number }
    /** STOP: at a person's floor with bids above it (a START that did not finish): floored again at that floor. */
    | { does: 'refloor'; floorCents: number; adGroups: number; targets: number }
    | { does: 'held'; by: string }
    | { does: 'none'; why: string }
  /** Ad groups at their own floor (stock, a product's monthly cap): neither op lifts them. */
  ownFloors: number
  /** START only: the placements the build deferred. */
  placements: { does: 'apply'; adjustments: Placement[] } | { does: 'already' | 'left' | 'none'; why: string }
  /** START: PAUSED at Amazon — prepared, never enabled. */
  paused?: string
  /** PB-9 — START: its floor stays, held by the product's current phase; the floor's holder (recorded as the phase's). */
  phaseHeldBy?: string
  /** After the op: it serves at its planned bids (START), or at the floor (STOP). */
  spends: boolean
}

export interface StartPlan {
  op: ApplyOp
  market: string
  product: { productId: string; sku: string }
  playbook: { id: string; version: number; state: string | null; label: string }
  compiledTemplateVersion: number | null
  /** Null when the playbook no longer compiles (a STOP still runs: it is a brake). */
  doc: TemplateDoc | null
  nameToken: string | null
  /** The built campaigns it acts on. */
  campaigns: StartCampaign[]
  /** Slots it leaves as they are, and why (adopted, not at Amazon). */
  untouched: Array<{ slot: string; campaignId: string; name: string; why: string }>
  /**
   * START: campaigns whose hourly plan's floor a STOP took over (its STOP_FLOOR_KIND link, still held by the same
   * approver), an adopted one too: their bids go back (nothing else of an adopted campaign moves).
   */
  heldFloors: Array<{ slot: string; campaignId: string; name: string; origin: 'built' | 'adopted'; status: string; dailyBudgetCents: number; bids: Extract<StartCampaign['bids'], { does: 'restore' }> }>
  /** STOP: the campaigns whose hourly plan's floor the stop takes over when it switches the plans off (rank.ts). */
  floorsTaken: Array<{ slot: string; campaignId: string; name: string; origin: 'built' | 'adopted' }>
  /** START: STOP_FLOOR_KIND links whose floor is gone or no longer the stop's: dropped. */
  staleFloorLinks: string[]
  /** Every linked slot (the artifacts' context). */
  slots: Array<{ key: string; campaignId: string; adGroupId: string | null; origin: 'built' | 'adopted' }>
  artifactLinks: StoredArtifactLink[]
  artifacts: ArtifactPreviewLine[]
  artifactErrors: string[]
  /** START: the highest bid it puts back (minor units, the market's currency). */
  highestRestoredBidCents: number
  /** START: the daily budgets that spend again (ENABLED campaigns it starts). */
  dailyBudgetCents: number
  /** The campaigns that start (or stop) spending. */
  spending: number
  warnings: string[]
  problems: string[]
}

const isPersonFloor = (by: string | null | undefined) => !!by && by.startsWith('user:')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100)
const placementsOf = (dynamicBidding: unknown): Placement[] =>
  (((dynamicBidding as { placementBidding?: unknown } | null)?.placementBidding ?? []) as Placement[])
    .filter((p) => p && typeof p.placement === 'string' && Number(p.percentage) > 0)
const samePlacements = (a: readonly Placement[], b: readonly Placement[]) => {
  const key = (l: readonly Placement[]) => l.filter((p) => p.percentage > 0).map((p) => `${p.placement}:${Math.round(p.percentage)}`).sort().join('|')
  return key(a) === key(b)
}

const CAMPAIGN_SELECT = {
  id: true, name: true, status: true, marketplace: true, externalCampaignId: true, liveBidWritesEnabled: true, bidsSuppressedAt: true,
  bidsSuppressedBy: true, bidsSuppressedFloorCents: true, dailyBudget: true, dailyBudgetCurrency: true, dynamicBidding: true,
} as const

/** The placements each built campaign's build deferred to START, by campaign. */
async function deferredPlacementsOf(playbookId: string): Promise<Map<string, Placement[]>> {
  const runs = await prisma.adBlueprintApplication.findMany({ where: { playbookId }, orderBy: { createdAt: 'asc' }, select: { options: true } })
  const out = new Map<string, Placement[]>()
  for (const r of runs) {
    for (const d of (r.options as Partial<BuildRunOptions> | null)?.deferredPlacements ?? []) out.set(d.campaignId, d.placementBidding)
  }
  return out
}

/** What a START gives back on one campaign floored by a person or a build (decided as the run decides it). */
async function restoreOf(campaignId: string, floorCents: number): Promise<Extract<StartCampaign['bids'], { does: 'restore' }>> {
  const [groups, targets] = await Promise.all([
    prisma.adGroup.findMany({ where: { campaignId, bidsSuppressedAt: null, suppressedFromBidCents: { not: null } }, select: { id: true, name: true, defaultBidCents: true, suppressedFromBidCents: true }, orderBy: { id: 'asc' } }),
    prisma.adTarget.findMany({ where: { adGroup: { campaignId, bidsSuppressedAt: null }, suppressedFromBidCents: { not: null } }, select: { id: true, adGroupId: true, expressionValue: true, kind: true, bidCents: true, suppressedFromBidCents: true }, orderBy: { id: 'asc' } }),
  ])
  const out: Extract<StartCampaign['bids'], { does: 'restore' }> = { does: 'restore', floorCents, adGroups: 0, targets: 0, highestCents: 0, held: [], left: [] }
  if (!groups.length && !targets.length) return out
  const boundsOf = await giveBackBounds(campaignId, [...groups.map((g) => g.id), ...targets.map((t) => t.adGroupId)])
  const take = (text: string, current: number, remembered: number, adGroupId: string, kind: 'adGroups' | 'targets') => {
    const p = plannedGiveBack(remembered, current, floorCents, boundsOf(adGroupId))
    if ('left' in p) { out.left.push({ text, bidCents: current, rememberedCents: remembered }); return }
    out[kind]++
    out.highestCents = Math.max(out.highestCents, p.cents)
    if (p.heldBy) out.held.push({ text, rememberedCents: remembered, toCents: p.cents, heldBy: p.heldBy })
  }
  for (const g of groups) take(`ad group "${g.name}" default bid`, g.defaultBidCents, g.suppressedFromBidCents as number, g.id, 'adGroups')
  for (const t of targets) take(t.expressionValue?.trim() ? `"${t.expressionValue}"` : `${String(t.kind).toLowerCase()} target ${t.id}`, t.bidCents, t.suppressedFromBidCents as number, t.adGroupId, 'targets')
  return out
}

/** What a STOP floors on one campaign (as suppressCampaignBids selects it). */
async function floorOf(campaignId: string): Promise<Extract<StartCampaign['bids'], { does: 'floor' }>> {
  const floor = SUPPRESSION_FLOOR_CENTS
  const [adGroups, targets] = await Promise.all([
    prisma.adGroup.count({ where: { campaignId, defaultBidCents: { gt: floor }, suppressedFromBidCents: null } }),
    prisma.adTarget.count({ where: { adGroup: { campaignId }, isNegative: false, bidCents: { gt: floor }, suppressedFromBidCents: null } }),
  ])
  return { does: 'floor', floorCents: floor, adGroups, targets }
}

/** The bids still above a floor on a floored campaign (refloorCampaignBids moves them; an ad group's own floor stays). */
async function aboveFloorOf(campaignId: string, floor: number): Promise<{ adGroups: number; targets: number }> {
  const [adGroups, targets] = await Promise.all([
    prisma.adGroup.count({ where: { campaignId, bidsSuppressedAt: null, defaultBidCents: { gt: floor } } }),
    prisma.adTarget.count({ where: { adGroup: { campaignId, bidsSuppressedAt: null }, isNegative: false, bidCents: { gt: floor } } }),
  ])
  return { adGroups, targets }
}

/** The artifacts' context of an op. */
function contextOf(plan: StartPlan, actor: AdsActor, changeSetId: string | null): ArtifactContext | null {
  if (!plan.doc || !plan.nameToken) return null
  const doc = plan.doc
  return {
    playbookId: plan.playbook.id, market: plan.market, productId: plan.product.productId, nameToken: plan.nameToken, doc,
    slots: plan.slots.map((s) => ({ ...s, rankRole: doc.structure.slots.find((d) => d.key === s.key)?.rankRole ?? 'none' })),
    mode: plan.op, actor, changeSetId, compiledVersion: plan.playbook.version,
  }
}

/**
 * START or STOP of one product's playbook in one market, planned: nothing is written. `slots`: only these built slots
 * (default: every built slot). Refusals (no row, nothing built) come back as `problems`.
 */
export async function planStart(args: { op: ApplyOp; market: string; productId?: string; sku?: string; slots?: readonly string[] }, opts: { compilers?: readonly ArtifactCompiler[] } = {}): Promise<{ data: StartPlan } | { status: 400 | 404; error: string }> {
  const loaded = await loadProductPlaybook(args)
  if ('error' in loaded) return loaded
  const { market, product, resolved, row, links } = loaded
  if (!row) return { status: 400, error: `${product.sku} has no product playbook row in ${market}: there is nothing to ${args.op}.` }
  const doc = resolved.doc ?? null
  const nameToken = (resolved.product?.nameToken.value as string | null) ?? row.nameToken ?? null
  const warnings: string[] = []
  const problems: string[] = []
  if (args.op === 'start' && !doc) problems.push(`the playbook does not compile: ${resolved.problems.join('; ') || 'no template'}`)

  const mine = links.filter((l) => l.playbookId === row.id)
  const asked = args.slots?.length ? new Set(args.slots) : null
  for (const key of asked ?? []) {
    const link = mine.find((l) => l.key === key)
    if (!link) problems.push(`the playbook holds no live campaign for slot "${key}"`)
    else if (link.origin !== 'built') problems.push(`slot "${key}" was adopted, not built: ${args.op === 'start' ? 'START' : 'STOP'} leaves an adopted campaign as it is`)
  }
  const rows = new Map((mine.length ? await prisma.campaign.findMany({ where: { id: { in: mine.map((l) => l.refId) } }, select: CAMPAIGN_SELECT }) : []).map((c) => [c.id, c]))
  const deferred = args.op === 'start' ? await deferredPlacementsOf(row.id) : new Map<string, Placement[]>()
  const ownFloorCounts = mine.length
    ? new Map((await prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: mine.map((l) => l.refId) }, bidsSuppressedAt: { not: null } }, _count: { _all: true } })).map((g) => [g.campaignId, g._count._all]))
    : new Map<string, number>()

  // PB-9 — the slots the product's current phase floors (its strategy's goal): START leaves their floor in place.
  const phase = args.op === 'start' && doc ? await phaseNow(market, row.scopeId) : null
  const phaseFloors = new Set(Object.entries((phase && doc?.phases[phase]?.slots) || {}).filter(([, state]) => state === 'floor').map(([key]) => key))
  const heldByPhase = `phase ${phase}`

  const campaigns: StartCampaign[] = []
  const untouched: StartPlan['untouched'] = []
  const heldFloors: StartPlan['heldFloors'] = []
  // The floors a STOP took over (rank.ts hands an hourly plan's floors to the approver who switches it off): START gives
  // them back — only while the same approver still holds the floor. A link whose floor is gone or moved is dropped.
  const stopLinks = args.op === 'start' ? await prisma.adsPlaybookLink.findMany({ where: { playbookId: row.id, kind: STOP_FLOOR_KIND }, select: { refId: true, updatedBy: true } }) : []
  const holderOf = new Map(stopLinks.map((l) => [l.refId, l.updatedBy]))
  const staleFloorLinks = stopLinks.filter((l) => { const c = rows.get(l.refId); return !c || !c.bidsSuppressedAt || c.bidsSuppressedBy !== l.updatedBy }).map((l) => l.refId)
  for (const link of mine) {
    const c = rows.get(link.refId)
    if (!c) continue
    if (link.origin !== 'built' && args.op === 'start' && c.bidsSuppressedAt && holderOf.get(c.id) === c.bidsSuppressedBy && (!asked || asked.has(link.key)) && phaseFloors.has(link.key)) {
      untouched.push({ slot: link.key, campaignId: c.id, name: c.name, why: `held by ${heldByPhase}: the ${phase} phase floors this slot, so its floor stays (a phase switch releases it)` })
      continue
    }
    if (link.origin !== 'built' && args.op === 'start' && c.bidsSuppressedAt && holderOf.get(c.id) === c.bidsSuppressedBy && (!asked || asked.has(link.key))) {
      heldFloors.push({ slot: link.key, campaignId: c.id, name: c.name, origin: 'adopted', status: String(c.status), dailyBudgetCents: cents(c.dailyBudget), bids: await restoreOf(c.id, c.bidsSuppressedFloorCents ?? SUPPRESSION_FLOOR_CENTS) })
      warnings.push(`"${c.name}" (adopted) is at the floor its hourly plan set, which the playbook's stop holds: START gives its bids back (nothing else of it moves).`)
      continue
    }
    if (link.origin !== 'built') {
      untouched.push({ slot: link.key, campaignId: c.id, name: c.name, why: `adopted: it is the business's own campaign — its allowlist, bids and placements are left as they are${c.liveBidWritesEnabled ? '' : ' (off the live-write allowlist: the playbook\'s rules and hourly plans cannot write to it until a person puts it on)'}` })
      continue
    }
    if (asked && !asked.has(link.key)) continue
    if (!c.externalCampaignId) { untouched.push({ slot: link.key, campaignId: c.id, name: c.name, why: 'not at Amazon (Amazon never took it): nothing to start or stop' }); continue }
    const status = String(c.status)
    const currency = c.dailyBudgetCurrency?.trim() || 'EUR'
    const ownFloors = ownFloorCounts.get(c.id) ?? 0
    const base = { slot: link.key, campaignId: c.id, name: c.name, status, dailyBudgetCents: cents(c.dailyBudget), currency, ownFloors }
    if (args.op === 'start') {
      let bids: StartCampaign['bids']
      if (!c.bidsSuppressedAt) bids = { does: 'none', why: 'not at a floor: it serves at its bids' }
      else if (!isPersonFloor(c.bidsSuppressedBy)) bids = { does: 'held', by: c.bidsSuppressedBy || 'an unrecorded engine' }
      else if (phaseFloors.has(link.key)) bids = { does: 'held', by: heldByPhase }
      else bids = await restoreOf(c.id, c.bidsSuppressedFloorCents ?? SUPPRESSION_FLOOR_CENTS)
      const planned = deferred.get(c.id) ?? []
      const now = placementsOf(c.dynamicBidding)
      const placements: StartCampaign['placements'] = !planned.length ? { does: 'none', why: 'none planned' }
        : !now.length ? { does: 'apply', adjustments: planned.map((p) => ({ placement: p.placement, percentage: p.percentage })) }
          : samePlacements(now, planned) ? { does: 'already', why: 'set as planned' }
            : { does: 'left', why: 'placements were set since the build (a person or an engine): left as they are' }
      const paused = status === 'PAUSED' ? 'paused at Amazon: START prepares it (allowlist, planned bids, placements) but never enables it — a person enables it in Nexus, and it serves from then' : undefined
      const changes = !c.liveBidWritesEnabled || bids.does === 'restore' || placements.does === 'apply'
      campaigns.push({
        ...base, allowlist: c.liveBidWritesEnabled ? 'already' : 'on', bids, placements, ...(paused ? { paused } : {}),
        ...(bids.does === 'held' && bids.by === heldByPhase && c.bidsSuppressedBy ? { phaseHeldBy: c.bidsSuppressedBy } : {}),
        spends: status === 'ENABLED' && changes && bids.does !== 'held',
      })
      if (bids.does === 'held' && bids.by === heldByPhase) warnings.push(`"${c.name}" stays at the floor, held by ${heldByPhase}: the ${phase} phase floors slot "${link.key}" (low bids, never a pause). A phase switch to one that runs it gives its bids back.`)
      else if (bids.does === 'held') warnings.push(`"${c.name}" stays at the floor ${bids.by} set: START never lifts an engine's floor (it lifts it itself once its reason ends, now that the campaign is on the allowlist).`)
      if (ownFloors) warnings.push(`"${c.name}": ${ownFloors} ad group${ownFloors === 1 ? ' stays' : 's stay'} at ${ownFloors === 1 ? 'its' : 'their'} own floor (stock, or a product's monthly cap): START never lifts it.`)
      if (bids.does === 'restore' && bids.left.length) warnings.push(`"${c.name}": ${bids.left.length} bid${bids.left.length === 1 ? '' : 's'} left the floor since the build (a person or an engine moved ${bids.left.length === 1 ? 'it' : 'them'}): left as ${bids.left.length === 1 ? 'it stands' : 'they stand'}.`)
      if (placements.does === 'left') warnings.push(`"${c.name}": ${placements.why}.`)
    } else {
      // A campaign at a floor already keeps it: a person's (START lifts it), or an engine's — an hourly plan's floor is
      // handed to the stop when the plan is switched off (rank.ts), any other engine's stays its own (START never lifts it).
      // A person's floor with bids above it (a START that did not finish) is floored again, at that floor.
      const floor = c.bidsSuppressedFloorCents ?? SUPPRESSION_FLOOR_CENTS
      const above = c.bidsSuppressedAt && isPersonFloor(c.bidsSuppressedBy) ? await aboveFloorOf(c.id, floor) : null
      const bids: StartCampaign['bids'] = !c.bidsSuppressedAt ? await floorOf(c.id)
        : above && (above.adGroups || above.targets) ? { does: 'refloor', floorCents: floor, ...above }
          : { does: 'none', why: `at a floor already (${c.bidsSuppressedBy || 'an unrecorded actor'})` }
      const floors = (bids.does === 'floor' || bids.does === 'refloor') && (bids.adGroups > 0 || bids.targets > 0)
      if (bids.does === 'refloor') warnings.push(`"${c.name}" is at the floor with ${plural(bids.adGroups + bids.targets, 'bid')} above it (a start that did not finish): the stop floors ${bids.adGroups + bids.targets === 1 ? 'it' : 'them'} again first.`)
      campaigns.push({
        ...base, allowlist: c.liveBidWritesEnabled ? 'off' : 'already', bids, placements: { does: 'none', why: 'a stop leaves placements as they are (they multiply 2¢ bids)' },
        spends: status === 'ENABLED' && (floors || c.liveBidWritesEnabled),
      })
    }
  }
  if (!campaigns.length && !heldFloors.length && !problems.length) {
    problems.push(mine.some((l) => l.origin === 'built')
      ? `no campaign the playbook built is at Amazon${asked ? ' among the slots asked' : ''}`
      : `the playbook built no campaign for ${product.sku} in ${market} yet (adopted campaigns are the business's own): build it first (apply-ads-playbook op build)`)
  }

  const artifactLinks = (await prisma.adsPlaybookLink.findMany({ where: { playbookId: row.id, kind: { notIn: ['slot', 'portfolio'] } }, select: { kind: true, key: true, refId: true } }))
  const plan: StartPlan = {
    op: args.op, market, product: { productId: product.id, sku: product.sku },
    playbook: { id: row.id, version: row.version, state: row.state, label: row.label },
    compiledTemplateVersion: resolved.template.value?.version ?? null,
    doc, nameToken, campaigns, untouched, heldFloors, floorsTaken: [], staleFloorLinks,
    slots: mine.map((l) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId, origin: l.origin === 'adopted' ? 'adopted' as const : 'built' as const })),
    artifactLinks, artifacts: [], artifactErrors: [],
    highestRestoredBidCents: Math.max(0, ...campaigns.map((c) => (c.bids.does === 'restore' ? c.bids.highestCents : 0)), ...heldFloors.map((h) => h.bids.highestCents)),
    dailyBudgetCents: args.op === 'start'
      ? [...campaigns.filter((c) => c.spends), ...heldFloors.filter((h) => h.status === 'ENABLED')].reduce((sum, c) => sum + c.dailyBudgetCents, 0)
      : 0,
    spending: campaigns.filter((c) => c.spends).length + heldFloors.filter((h) => h.status === 'ENABLED').length,
    warnings, problems,
  }
  // The artifacts: what each compiler would do (no writes).
  const ctx = contextOf(plan, 'user:preview', null)
  if (ctx) {
    const lines = await previewArtifacts(ctx, artifactLinks, opts.compilers ?? ARTIFACT_COMPILERS)
    plan.artifacts = lines.lines
    plan.artifactErrors = lines.errors
    // STOP: the hourly plans' floors it takes over (kept at the floor for the approver; START gives them back).
    if (args.op === 'stop') {
      const slotOf = new Map(plan.slots.map((x) => [x.campaignId, x]))
      const effect = await rankOffEffect(ctx, ['performance', 'research'] as RankRole[], 'keep')
      plan.floorsTaken = effect.heldAtFloor.filter((h) => slotOf.has(h.campaignId)).map((h) => ({ slot: slotOf.get(h.campaignId)!.key, campaignId: h.campaignId, name: h.name, origin: slotOf.get(h.campaignId)!.origin }))
      for (const t of plan.floorsTaken.filter((x) => x.origin === 'adopted')) warnings.push(`"${t.name}" (adopted) stays at the floor its hourly plan set: the stop holds it, and only START gives its bids back.`)
    }
  } else if (args.op === 'stop') plan.artifactErrors.push('the playbook does not compile, so its hourly plans and rules are not switched by this stop (its campaigns are floored and off the allowlist: nothing writes to them)')
  return { data: plan }
}

/** How an approved op writes: the approver (`user:`), the audit reason, the approval's change set, a person's click. */
export interface ApplyRun { actor: AdsActor; reason: string; changeSetId: string; manual: boolean }

export interface ApplyOutcome {
  /** The slots whose campaign the op changed (started, or stopped), without a failure. */
  done: string[]
  failed: Array<{ slot: string; campaignId: string; why: string }>
  /** Bids left where a person or an engine put them since the build (START). */
  left: Array<{ slot: string; text: string; bidCents: number; rememberedCents: number }>
  /** The artifacts the op switched (their compilers' words). */
  artifacts: string[]
  /** STOP: the slots whose hourly plan's floor it took over (START gives those bids back). */
  floorsHeld: string[]
  errors: string[]
  /** The row's state after the op. */
  state: string | null
}

/** A built campaign still runs: on the allowlist and not at a person's (or a build's) floor. */
async function stillRunning(playbookId: string): Promise<string[]> {
  const built = await prisma.adsPlaybookLink.findMany({ where: { playbookId, kind: 'slot', origin: 'built' }, select: { key: true, refId: true } })
  if (!built.length) return []
  const rows = await prisma.campaign.findMany({ where: { id: { in: built.map((l) => l.refId) }, status: { not: 'ARCHIVED' } }, select: { id: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true } })
  const running = new Set(rows.filter((c) => c.liveBidWritesEnabled && !(c.bidsSuppressedAt && isPersonFloor(c.bidsSuppressedBy))).map((c) => c.id))
  return built.filter((l) => running.has(l.refId)).map((l) => l.key)
}

/** Every compiler's setEnabled on the playbook's artifacts; a compiler that throws is an error, never the op's end. */
async function switchArtifacts(ctx: ArtifactContext, links: readonly StoredArtifactLink[], enabled: boolean, compilers: readonly ArtifactCompiler[]): Promise<{ changed: string[]; errors: string[] }> {
  const changed: string[] = []
  const errors: string[] = []
  for (const c of compilers) {
    try {
      const r = await c.setEnabled(ctx, links.filter((l) => l.kind === c.kind).map((l) => ({ key: l.key, refId: l.refId })), enabled)
      changed.push(...r.changed)
      errors.push(...r.errors.map((e) => `${c.kind}: ${e}`))
    } catch (e) { errors.push(`${c.kind}: ${(e as Error).message.slice(0, 200)}`) }
  }
  return { changed, errors }
}

/** Record the op on the row (its state, one version row); a failure is an error of the op, never a thrown run. */
async function record(plan: StartPlan, state: string, writer: PlaybookApplyWriter, reason: string, errors: string[]): Promise<string | null> {
  try {
    await recordPlaybookApply(plan.playbook.id, { op: plan.op, state, compiledVersion: plan.playbook.version, compiledTemplateVersion: plan.compiledTemplateVersion, reason }, writer)
    return state
  } catch (e) {
    logger.error(`[PB-5b] the playbook row did not record the ${plan.op}`, { playbookId: plan.playbook.id, error: (e as Error).message })
    errors.push(`the playbook row did not record the ${plan.op}: ${(e as Error).message.slice(0, 160)}`)
    return plan.playbook.state
  }
}

/** START, as planned and approved (the caller re-planned it and checked nothing moved). */
export async function runStart(plan: StartPlan, run: ApplyRun, writer: PlaybookApplyWriter, opts: { compilers?: readonly ArtifactCompiler[] } = {}): Promise<ApplyOutcome> {
  const { setLiveWrites } = await import('../campaign-settings.service.js')
  const { restoreCampaignBids } = await import('../ads-bid-suppression.service.js')
  const { settleLaunchPortfolios, updatePlacementBidding } = await import('../ads-create.service.js')
  const out: ApplyOutcome = { done: [], failed: [], left: [], artifacts: [], floorsHeld: [], errors: [], state: plan.playbook.state }
  for (const c of plan.campaigns) {
    const fail = (why: string) => out.failed.push({ slot: c.slot, campaignId: c.campaignId, why })
    let changed = false
    try {
      // 1 — on the allowlist first: a run by rule writes as the rule, and the gate lets it through only then.
      if (c.allowlist === 'on') {
        const r = await setLiveWrites(c.campaignId, true, run.actor)
        if ('error' in r) { fail(`it could not be put on the live-write allowlist: ${r.error}`); continue }
        changed = true
      }
      // 2 — the planned bids back (never above what was remembered; a bid moved since stays).
      if (c.bids.does === 'restore') {
        const left: Array<{ kind: 'adGroup' | 'target'; id: string; bidCents: number; rememberedCents: number }> = []
        await restoreCampaignBids(c.campaignId, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual, planned: { floorCents: c.bids.floorCents, left } })
        const texts = new Map(c.bids.left.map((l) => [`${l.bidCents}:${l.rememberedCents}`, l.text]))
        for (const l of left) out.left.push({ slot: c.slot, text: texts.get(`${l.bidCents}:${l.rememberedCents}`) ?? `${l.kind} ${l.id}`, bidCents: l.bidCents, rememberedCents: l.rememberedCents })
        const after = await prisma.campaign.findUnique({ where: { id: c.campaignId }, select: { bidsSuppressedAt: true } })
        if (after?.bidsSuppressedAt) { fail('some of its planned bids were not taken: it stays at the floor until START runs again (each bid not taken keeps its planned value)'); continue }
        changed = true
      }
      // 3 — the placements the build deferred, onto a campaign that holds none.
      if (c.placements.does === 'apply') {
        const r = await updatePlacementBidding({ campaignId: c.campaignId, adjustments: c.placements.adjustments, actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual })
        if (!r.ok) { fail(`its placements were not set: ${r.reason ?? r.error ?? r.mode}`); continue }
        changed = true
      }
      // PB-9 — a floor the current phase holds is the phase's from now on: a later phase switch gives it back (phase.ts).
      if (c.phaseHeldBy) await recordPhaseFloor(plan.playbook.id, c.campaignId, c.phaseHeldBy, plan.playbook.version)
      else if (c.bids.does === 'restore') await prisma.adsPlaybookLink.deleteMany({ where: { playbookId: plan.playbook.id, kind: PHASE_FLOOR_KIND, refId: c.campaignId } })
      if (changed) out.done.push(c.slot)
    } catch (e) {
      fail((e as Error).message.slice(0, 200))
    }
  }
  // The floors a STOP took over on the playbook's other campaigns (an adopted one's hourly plan): their bids back too.
  for (const h of plan.heldFloors) {
    try {
      const left: Array<{ kind: 'adGroup' | 'target'; id: string; bidCents: number; rememberedCents: number }> = []
      await restoreCampaignBids(h.campaignId, { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual, planned: { floorCents: h.bids.floorCents, left } })
      for (const l of left) out.left.push({ slot: h.slot, text: `${l.kind} ${l.id}`, bidCents: l.bidCents, rememberedCents: l.rememberedCents })
      const after = await prisma.campaign.findUnique({ where: { id: h.campaignId }, select: { bidsSuppressedAt: true } })
      if (after?.bidsSuppressedAt) out.failed.push({ slot: h.slot, campaignId: h.campaignId, why: 'some of its bids were not taken: it stays at the floor the stop holds until START runs again' })
      else out.done.push(h.slot)
    } catch (e) { out.failed.push({ slot: h.slot, campaignId: h.campaignId, why: (e as Error).message.slice(0, 200) }) }
  }
  // A floor the stop held that is gone (given back) or no longer the stop's: its link is dropped.
  const given = [...plan.staleFloorLinks, ...[...plan.campaigns, ...plan.heldFloors].map((c) => c.campaignId)]
  const gone = given.length ? await prisma.campaign.findMany({ where: { id: { in: given } }, select: { id: true, bidsSuppressedAt: true } }) : []
  const drop = [...new Set([...plan.staleFloorLinks, ...gone.filter((c) => !c.bidsSuppressedAt).map((c) => c.id)])]
  if (drop.length) await prisma.adsPlaybookLink.deleteMany({ where: { playbookId: plan.playbook.id, kind: STOP_FLOOR_KIND, refId: { in: drop } } })
  // 4 — the portfolio read-back repair: off the allowlist the launch could not repair it; now it can.
  const builtIds = plan.campaigns.map((c) => c.campaignId)
  const portfolios = await settleLaunchPortfolios(builtIds)
  if (portfolios?.repairFailed) out.errors.push(`portfolio membership could not be set for ${portfolios.repairFailed} campaign(s): ${portfolios.errors.slice(0, 2).join('; ')}`)
  // 5 — the artifacts on (hourly plans, harvest and isolation rules), never over a person's switch-off — only once a
  // campaign the playbook built runs: plans and rules never run over campaigns that all stayed at the floor.
  const anyRuns = (await stillRunning(plan.playbook.id)).length > 0
  const ctx = contextOf(plan, run.actor, run.changeSetId)
  if (ctx && anyRuns) {
    const s = await switchArtifacts(ctx, plan.artifactLinks, true, opts.compilers ?? ARTIFACT_COMPILERS)
    out.artifacts.push(...s.changed)
    out.errors.push(...s.errors)
  }
  out.state = anyRuns
    ? await record(plan, 'RUNNING', writer, `start: ${out.done.length} campaign(s) started${out.failed.length ? `, ${out.failed.length} not` : ''}`, out.errors)
    : plan.playbook.state
  if (!anyRuns) out.errors.push('no campaign the playbook built runs after this start: its hourly plans and rules stay off and the row\'s state is unchanged')
  logger.info('[PB-5b] playbook start finished', { playbookId: plan.playbook.id, done: out.done.length, failed: out.failed.length, errors: out.errors.length })
  return out
}

/** STOP, as planned and approved: the brake (never a pause, never an archive). */
export async function runStop(plan: StartPlan, run: ApplyRun, writer: PlaybookApplyWriter, opts: { compilers?: readonly ArtifactCompiler[] } = {}): Promise<ApplyOutcome> {
  const { setLiveWrites } = await import('../campaign-settings.service.js')
  const { refloorCampaignBids, suppressCampaignBids } = await import('../ads-bid-suppression.service.js')
  const out: ApplyOutcome = { done: [], failed: [], left: [], artifacts: [], floorsHeld: [], errors: [], state: plan.playbook.state }
  for (const c of plan.campaigns) {
    const fail = (why: string) => out.failed.push({ slot: c.slot, campaignId: c.campaignId, why })
    let changed = false
    try {
      // 1 — every bid to the floor, remembered again — while it is still on the allowlist (a run by rule needs it; a
      // person's approval passes it). A person's floor with bids above it (a START that did not finish) is floored again.
      if (c.bids.does === 'floor' || c.bids.does === 'refloor') {
        const due = c.bids.adGroups + c.bids.targets
        if (due && c.allowlist === 'already' && !run.manual) { fail('it is off the live-write allowlist, so a stop by rule cannot lower its bids: a person approves this stop'); continue }
        const moved = c.bids.does === 'floor'
          ? await suppressCampaignBids(c.campaignId, { actor: run.actor, reason: run.reason, floorCents: c.bids.floorCents, changeSetId: run.changeSetId, manual: run.manual })
          : await refloorCampaignBids(c.campaignId, { actor: run.actor, reason: run.reason, floorCents: c.bids.floorCents, changeSetId: run.changeSetId, manual: run.manual })
        const after = await prisma.campaign.findUnique({ where: { id: c.campaignId }, select: { bidsSuppressedAt: true } })
        // Every lowering is a write the gate took (sent to Amazon, or kept in Nexus in sandbox): one it refused stays live.
        if (!after?.bidsSuppressedAt || moved < due) { fail(`only ${moved} of its ${due} bids were lowered (the write gate refused the rest): it stays on the allowlist, and a stop again finishes it`); continue }
        changed = true
      }
      // 2 — off the allowlist: no engine, rule or schedule writes to it until START.
      if (c.allowlist === 'off') {
        const r = await setLiveWrites(c.campaignId, false, run.actor)
        if ('error' in r) { fail(`it could not be taken off the live-write allowlist: ${r.error}`); continue }
        changed = true
      }
      if (changed) out.done.push(c.slot)
    } catch (e) {
      fail((e as Error).message.slice(0, 200))
    }
  }
  // 3 — once no built campaign runs, AFTER the floors (an hourly plan switched off gives back the floors it set: the
  // campaigns are floored by the stop first): the artifacts off — hourly plans, harvest and isolation rules, each
  // recorded as the playbook's stop — and the row STOPPED.
  const running = await stillRunning(plan.playbook.id)
  if (running.length) {
    out.errors.push(`${running.length} campaign(s) the playbook built still run (${running.join(', ')}): its hourly plans and rules stay on, and the row stays ${plan.playbook.state ?? 'as it is'}`)
    return out
  }
  const ctx = contextOf(plan, run.actor, run.changeSetId)
  if (ctx) {
    // The floors switching the hourly plans off hands to the approver (rank.ts): which ones, recorded, so START (and
    // only START) gives them back — an adopted campaign's too.
    const ids = plan.slots.map((x) => x.campaignId)
    const before = new Map((await prisma.campaign.findMany({ where: { id: { in: ids }, bidsSuppressedAt: { not: null } }, select: { id: true, bidsSuppressedBy: true } })).map((c) => [c.id, c.bidsSuppressedBy]))
    const s = await switchArtifacts(ctx, plan.artifactLinks, false, opts.compilers ?? ARTIFACT_COMPILERS)
    out.artifacts.push(...s.changed)
    out.errors.push(...s.errors)
    const taken = (await prisma.campaign.findMany({ where: { id: { in: [...before.keys()] }, bidsSuppressedBy: run.actor }, select: { id: true } })).filter((c) => before.get(c.id) !== run.actor)
    for (const c of taken) {
      const slot = plan.slots.find((x) => x.campaignId === c.id)!
      try {
        const mine = await prisma.adsPlaybookLink.findFirst({ where: { kind: STOP_FLOOR_KIND, refId: c.id }, select: { id: true } })
        const data = { playbookId: plan.playbook.id, key: c.id, origin: slot.origin, compiledVersion: plan.playbook.version, updatedBy: run.actor }
        if (mine) await prisma.adsPlaybookLink.update({ where: { id: mine.id }, data })
        else await prisma.adsPlaybookLink.create({ data: { ...data, kind: STOP_FLOOR_KIND, refId: c.id } })
        out.floorsHeld.push(slot.key)
      } catch (e) { out.errors.push(`the floor of "${slot.key}" the stop holds was not recorded: ${(e as Error).message.slice(0, 160)}`) }
    }
  } else out.errors.push('the playbook does not compile, so its hourly plans and rules were not switched off (its campaigns are floored and off the allowlist: nothing writes to them)')
  out.state = await record(plan, 'STOPPED', writer, `stop: ${out.done.length} campaign(s) floored and off the allowlist`, out.errors)
  logger.info('[PB-5b] playbook stop finished', { playbookId: plan.playbook.id, done: out.done.length, failed: out.failed.length, errors: out.errors.length })
  return out
}
