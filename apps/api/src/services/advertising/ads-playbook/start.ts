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
 *               stays where it is, named
 *             3 the placements the build deferred (build run options `deferredPlacements`), only onto a campaign that
 *               holds none: placements set since the build are left, named
 *           then the portfolio read-back repair (settleLaunchPortfolios: it passes the allowlist now), the playbook's
 *           artifacts switched on (ARTIFACT_COMPILERS setEnabled: hourly plans, harvest and isolation rules — never
 *           over a person's switch-off), and the row's state RUNNING. A campaign PAUSED at Amazon is prepared but never
 *           enabled: a person enables it in Nexus. A campaign the playbook ADOPTED is the business's own: its
 *           allowlist, bids and placements are left as they are (named); the artifacts cover it.
 *   stop    for each built campaign: every bid to the 2¢ floor, remembered again (suppressCampaignBids; never a pause,
 *           never an archive), then off the allowlist. Once no built campaign of the playbook runs (on the allowlist
 *           and not at a person's floor), its artifacts are switched off — the compiled rules by stopCompiledRule
 *           (rules.ts), whatever compiles now — and the row's state is STOPPED; while one still runs (a stop of some
 *           slots), they stay on and the row stays RUNNING, said.
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
import type { TemplateDoc } from './doc.js'
import { stopCompiledRule } from './rules.js'
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
  /** The bids: START puts them back, STOP floors them; held: an engine's floor, left; none: nothing to do. */
  bids:
    | { does: 'restore'; floorCents: number; adGroups: number; targets: number; highestCents: number
        held: Array<{ text: string; rememberedCents: number; toCents: number; heldBy: string }>
        left: Array<{ text: string; bidCents: number; rememberedCents: number }> }
    | { does: 'floor'; floorCents: number; adGroups: number; targets: number }
    | { does: 'held'; by: string }
    | { does: 'none'; why: string }
  /** Ad groups at their own floor (stock, a product's monthly cap): neither op lifts them. */
  ownFloors: number
  /** START only: the placements the build deferred. */
  placements: { does: 'apply'; adjustments: Placement[] } | { does: 'already' | 'left' | 'none'; why: string }
  /** START: PAUSED at Amazon — prepared, never enabled. */
  paused?: string
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

/** The compiled rules a STOP switches off itself (rules.ts stopCompiledRule), whatever a compiler does on a stop. */
const RULE_KINDS = ['harvestRule', 'isolationRule'] as const
type RuleKind = (typeof RULE_KINDS)[number]
const isRuleKind = (kind: string): kind is RuleKind => (RULE_KINDS as readonly string[]).includes(kind)

/** A STOP's lines for the compiled rules: each one on is switched off. */
async function ruleStopLines(links: readonly StoredArtifactLink[]): Promise<ArtifactPreviewLine[]> {
  const rules = links.filter((l) => isRuleKind(l.kind))
  if (!rules.length) return []
  const rows = new Map((await prisma.automationRule.findMany({ where: { id: { in: rules.map((l) => l.refId) } }, select: { id: true, name: true, enabled: true } })).map((r) => [r.id, r]))
  return rules.map((l) => {
    const r = rows.get(l.refId)
    const kind = l.kind as RuleKind
    if (!r) return { kind, key: l.key, does: 'report' as const, summary: `Its ${kind === 'harvestRule' ? 'harvest' : 'isolation'} rule is gone: nothing to switch off.` }
    return r.enabled
      ? { kind, key: l.key, does: 'disable' as const, summary: `"${r.name}" is switched off (the next START switches it on again).`, refId: r.id }
      : { kind, key: l.key, does: 'keep' as const, summary: `"${r.name}" is off already: left as it is.`, refId: r.id }
  })
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

  const campaigns: StartCampaign[] = []
  const untouched: StartPlan['untouched'] = []
  for (const link of mine) {
    const c = rows.get(link.refId)
    if (!c) continue
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
        spends: status === 'ENABLED' && changes && bids.does !== 'held',
      })
      if (bids.does === 'held') warnings.push(`"${c.name}" stays at the floor ${bids.by} set: START never lifts an engine's floor (it lifts it itself once its reason ends, now that the campaign is on the allowlist).`)
      if (ownFloors) warnings.push(`"${c.name}": ${ownFloors} ad group${ownFloors === 1 ? ' stays' : 's stay'} at ${ownFloors === 1 ? 'its' : 'their'} own floor (stock, or a product's monthly cap): START never lifts it.`)
      if (bids.does === 'restore' && bids.left.length) warnings.push(`"${c.name}": ${bids.left.length} bid${bids.left.length === 1 ? '' : 's'} left the floor since the build (a person or an engine moved ${bids.left.length === 1 ? 'it' : 'them'}): left as ${bids.left.length === 1 ? 'it stands' : 'they stand'}.`)
      if (placements.does === 'left') warnings.push(`"${c.name}": ${placements.why}.`)
    } else {
      const bids: StartCampaign['bids'] = c.bidsSuppressedAt
        ? { does: 'none', why: `at a floor already (${c.bidsSuppressedBy || 'an unrecorded actor'})` }
        : await floorOf(c.id)
      const floors = bids.does === 'floor' && (bids.adGroups > 0 || bids.targets > 0)
      campaigns.push({
        ...base, allowlist: c.liveBidWritesEnabled ? 'off' : 'already', bids, placements: { does: 'none', why: 'a stop leaves placements as they are (they multiply 2¢ bids)' },
        spends: status === 'ENABLED' && (floors || c.liveBidWritesEnabled),
      })
    }
  }
  if (!campaigns.length && !problems.length) {
    problems.push(mine.some((l) => l.origin === 'built')
      ? `no campaign the playbook built is at Amazon${asked ? ' among the slots asked' : ''}`
      : `the playbook built no campaign for ${product.sku} in ${market} yet (adopted campaigns are the business's own): build it first (apply-ads-playbook op build)`)
  }

  const artifactLinks = (await prisma.adsPlaybookLink.findMany({ where: { playbookId: row.id, kind: { notIn: ['slot', 'portfolio'] } }, select: { kind: true, key: true, refId: true } }))
  const plan: StartPlan = {
    op: args.op, market, product: { productId: product.id, sku: product.sku },
    playbook: { id: row.id, version: row.version, state: row.state, label: row.label },
    compiledTemplateVersion: resolved.template.value?.version ?? null,
    doc, nameToken, campaigns, untouched,
    slots: mine.map((l) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId, origin: l.origin === 'adopted' ? 'adopted' as const : 'built' as const })),
    artifactLinks, artifacts: [], artifactErrors: [],
    highestRestoredBidCents: Math.max(0, ...campaigns.map((c) => (c.bids.does === 'restore' ? c.bids.highestCents : 0))),
    dailyBudgetCents: args.op === 'start' ? campaigns.filter((c) => c.spends).reduce((sum, c) => sum + c.dailyBudgetCents, 0) : 0,
    spending: campaigns.filter((c) => c.spends).length,
    warnings, problems,
  }
  // The artifacts: what each compiler would do (no writes); on a STOP the compiled rules are switched off here.
  const ctx = contextOf(plan, 'user:preview', null)
  if (ctx) {
    const lines = await previewArtifacts(ctx, artifactLinks, opts.compilers ?? ARTIFACT_COMPILERS)
    plan.artifacts = lines.lines
    plan.artifactErrors = lines.errors
  } else if (args.op === 'stop') plan.artifactErrors.push('the playbook does not compile, so its hourly plans are not switched by this stop (its campaigns are floored and off the allowlist: nothing writes to them)')
  if (args.op === 'stop') {
    const ruleLines = await ruleStopLines(artifactLinks)
    plan.artifacts = [...plan.artifacts.filter((l) => !isRuleKind(l.kind)), ...ruleLines]
  }
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
  const out: ApplyOutcome = { done: [], failed: [], left: [], artifacts: [], errors: [], state: plan.playbook.state }
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
      if (changed) out.done.push(c.slot)
    } catch (e) {
      fail((e as Error).message.slice(0, 200))
    }
  }
  // 4 — the portfolio read-back repair: off the allowlist the launch could not repair it; now it can.
  const builtIds = plan.campaigns.map((c) => c.campaignId)
  const portfolios = await settleLaunchPortfolios(builtIds)
  if (portfolios?.repairFailed) out.errors.push(`portfolio membership could not be set for ${portfolios.repairFailed} campaign(s): ${portfolios.errors.slice(0, 2).join('; ')}`)
  // 5 — the artifacts on (hourly plans, harvest and isolation rules), never over a person's switch-off.
  const ctx = contextOf(plan, run.actor, run.changeSetId)
  if (ctx) {
    const s = await switchArtifacts(ctx, plan.artifactLinks, true, opts.compilers ?? ARTIFACT_COMPILERS)
    out.artifacts.push(...s.changed)
    out.errors.push(...s.errors)
  }
  const anyRuns = (await stillRunning(plan.playbook.id)).length > 0
  out.state = anyRuns
    ? await record(plan, 'RUNNING', writer, `start: ${out.done.length} campaign(s) started${out.failed.length ? `, ${out.failed.length} not` : ''}`, out.errors)
    : plan.playbook.state
  if (!anyRuns) out.errors.push('no campaign the playbook built runs after this start: the row\'s state is unchanged')
  logger.info('[PB-5b] playbook start finished', { playbookId: plan.playbook.id, done: out.done.length, failed: out.failed.length, errors: out.errors.length })
  return out
}

/** STOP, as planned and approved: the brake (never a pause, never an archive). */
export async function runStop(plan: StartPlan, run: ApplyRun, writer: PlaybookApplyWriter, opts: { compilers?: readonly ArtifactCompiler[] } = {}): Promise<ApplyOutcome> {
  const { setLiveWrites } = await import('../campaign-settings.service.js')
  const { suppressCampaignBids } = await import('../ads-bid-suppression.service.js')
  const out: ApplyOutcome = { done: [], failed: [], left: [], artifacts: [], errors: [], state: plan.playbook.state }
  for (const c of plan.campaigns) {
    const fail = (why: string) => out.failed.push({ slot: c.slot, campaignId: c.campaignId, why })
    let changed = false
    try {
      // 1 — every bid to the floor, remembered again — while it is still on the allowlist (a run by rule needs it).
      if (c.bids.does === 'floor') {
        await suppressCampaignBids(c.campaignId, { actor: run.actor, reason: run.reason, floorCents: c.bids.floorCents, changeSetId: run.changeSetId, manual: run.manual })
        const after = await prisma.campaign.findUnique({ where: { id: c.campaignId }, select: { bidsSuppressedAt: true } })
        if (!after?.bidsSuppressedAt) { fail('its bids could not be floored'); continue }
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
  // 3 — once no built campaign runs: the artifacts off, the compiled rules by their stored rule, the row STOPPED.
  const running = await stillRunning(plan.playbook.id)
  if (running.length) {
    out.errors.push(`${running.length} campaign(s) the playbook built still run (${running.join(', ')}): its hourly plans and rules stay on, and the row stays ${plan.playbook.state ?? 'as it is'}`)
    return out
  }
  const ctx = contextOf(plan, run.actor, run.changeSetId)
  if (ctx) {
    const s = await switchArtifacts(ctx, plan.artifactLinks.filter((l) => !isRuleKind(l.kind)), false, (opts.compilers ?? ARTIFACT_COMPILERS).filter((c) => !isRuleKind(c.kind)))
    out.artifacts.push(...s.changed)
    out.errors.push(...s.errors)
  }
  for (const l of plan.artifactLinks.filter((x) => isRuleKind(x.kind))) {
    try {
      const r = await stopCompiledRule({ playbookId: plan.playbook.id, kind: l.kind as RuleKind, key: l.key, actor: run.actor })
      if (r?.changed && !r.enabled) out.artifacts.push(`${l.kind} ${l.key}: switched off`)
    } catch (e) { out.errors.push(`${l.kind}: ${(e as Error).message.slice(0, 200)}`) }
  }
  out.state = await record(plan, 'STOPPED', writer, `stop: ${out.done.length} campaign(s) floored and off the allowlist`, out.errors)
  logger.info('[PB-5b] playbook stop finished', { playbookId: plan.playbook.id, done: out.done.length, failed: out.failed.length, errors: out.errors.length })
  return out
}
