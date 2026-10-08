/**
 * ADS PLAYBOOK PB-7 — isolation per product: one run of a compiled `isolate_product_terms` rule, and the save that
 * compiles it (spec PB-6-7 §3).
 *
 *   run    loads the product's own scope (isolation-load.ts), plans with the pure planner (isolation.ts) and, when a
 *          person accepted the card (or the rule may act alone), writes each planned negative through the one
 *          negative write service. A dry run lists `items` (≤ 200) and proposes nothing when nothing is planned; an
 *          accept applies ONLY the card's items, each planned again on today's data. Counts are honest: `added` is
 *          what reached Amazon, `local` what Nexus holds for a campaign not on Amazon yet.
 *   write  the third layer of the Owner's rule 3: right before the writes each ad group must still advertise only this
 *          product (familyOnly again), and before each write its slot link is read again (same playbook) and the owner
 *          keyword must still be live; else it is left alone, said. The converting
 *          guard is not asked (`protectConverting: null`): a negative here only sends a search to the product's own
 *          live keyword, and a search that wins where it runs is left there by the planner (winners stay).
 *   sync   `syncIsolationRule(playbookId, { enabled })` — the hook PB-5's apply calls: resolves the product's playbook,
 *          compiles the rule and saves it once (rules.ts: PROPOSE, a dry run, one run a day). `enabled: true` is a
 *          START: it switches the rule on, never over a switch-off made after the last start; `false` (build, adopt,
 *          stop, a re-sync) leaves an existing rule's on/off and autonomy level as they are, and a new one is born off.
 *
 * Never compiled, never called: `sync_negatives_across_campaigns` (market-wide; it would cross products).
 */
import prisma from '../../../db.js'
import type { ActionResult } from '../../automation-rule.service.js'
import { writeNegativeKeyword } from '../ads-negative-kw.service.js'
import { familyOnly, type ProductFamily } from '../ads-winner-lock.js'
import { loadCatalog } from '../ads-strategy/load.js'
import { strategyMarketOf } from '../ads-strategy/terms.js'
import type { ProductTerms } from './doc.js'
import {
  ISOLATION_ACTION, ISOLATION_HANDOVER, MAX_ISOLATION_ITEMS, compileIsolationRule, isolationItemKey, planIsolation,
  type CompiledIsolationRule, type IsolationAction, type IsolationPlan, type LeftAlone, type PlannedNegative, type ScopeGroup,
} from './isolation.js'
import { loadIsolation, type Excluded } from './isolation-load.js'
import { loadPlaybookIndex, PLAYBOOK_ROW_SELECT, playbookLinks } from './load.js'
import { resolveProduct } from './resolve.js'
import { ensureCompiledRule } from './rules.js'
import { brainSkipsOutput, leverHeldOf, readLeverHolds, type LeverSkip } from '../brain/engine-skips.js'

export interface IsolationItem { kind: PlannedNegative['kind']; text: string; match: 'EXACT' | 'PHRASE'; adGroupId: string; slot: string; owner: string }

export interface IsolationWritten {
  /** Reached Amazon (Amazon's id). */
  added: number
  /** Held in Nexus: the campaign is not on Amazon yet. */
  local: number
  alreadyStanding: number
  refused: Array<{ text: string; adGroupId: string; deniedAt: string; reason: string }>
  failed: Array<{ text: string; adGroupId: string; error: string }>
  /** Planned, then left alone at the write (left the playbook, owner no longer live). */
  leftAlone: LeftAlone[]
  /** The Nexus rows written (the approval's undo list). */
  negativeIds: string[]
}

export interface IsolationRun {
  scope: { adGroups: number; groups: ScopeGroup[]; excluded: Excluded[] }
  plan: IsolationPlan
  /** What this run acts on: the card's items found again, else the plan up to MAX_ISOLATION_ITEMS. */
  chosen: PlannedNegative[]
  noLongerDue: Array<{ text: string; adGroupId: string; why: string }>
  written: IsolationWritten | null
  /** ONE BRAIN AB-6 — the negatives left because a product's brain owns (or the Owner holds) their campaign's negatives. */
  leftToBrain: LeverSkip[]
  /** The same negatives, each with its text, ad group and why (for a caller that lists what it left alone). */
  leftToBrainItems?: Array<{ text: string; adGroupId: string; why: string }>
  /** Who holds the levers could not be read: nothing was skipped on a guess, the write gate judged each write. */
  holdsUnread?: boolean
}

const itemOf = (a: PlannedNegative): IsolationItem => ({ kind: a.kind, text: a.text, match: a.match, adGroupId: a.adGroupId, slot: a.slot, owner: a.owner.text })

/** A card's items as stored (the dry run's output, merged into the accepted action). */
function itemsOf(raw: unknown): Array<{ text: string; match: string; adGroupId: string }> | null {
  if (!Array.isArray(raw)) return null
  return raw.filter((i): i is { text: string; match: string; adGroupId: string } =>
    !!i && typeof i === 'object' && typeof (i as { text?: unknown }).text === 'string' && typeof (i as { match?: unknown }).match === 'string' && typeof (i as { adGroupId?: unknown }).adGroupId === 'string')
}

/** The third layer: the ad group still plays a slot of this playbook, and the owner keyword is still live. */
async function stillOwned(playbookId: string, add: PlannedNegative): Promise<string | null> {
  const link = await prisma.adsPlaybookLink.findFirst({ where: { kind: 'slot', refId: add.campaignId }, select: { playbookId: true, adGroupId: true } })
  if (!link || link.playbookId !== playbookId || (link.adGroupId && link.adGroupId !== add.adGroupId)) {
    return 'Not written: its campaign left this product\'s playbook since the plan was made.'
  }
  const owner = await prisma.adTarget.findUnique({
    where: { id: add.owner.adTargetId },
    select: { isNegative: true, status: true, externalTargetId: true, adGroup: { select: { campaign: { select: { status: true } } } } },
  })
  const live = !!owner && !owner.isNegative && String(owner.status) === 'ENABLED' && owner.externalTargetId != null && String(owner.adGroup?.campaign?.status) !== 'ARCHIVED'
  return live ? null : `Not written: its keyword "${add.owner.text}" is no longer live, so its searches would have nowhere to go.`
}

async function writeAll(playbookId: string, adds: readonly PlannedNegative[], actor: string, family: ProductFamily): Promise<IsolationWritten> {
  const w: IsolationWritten = { added: 0, local: 0, alreadyStanding: 0, refused: [], failed: [], leftAlone: [], negativeIds: [] }
  // Rule 3 again, just before the writes: an ad group that now also advertises another product gets none.
  const owned = await familyOnly([...new Set(adds.map((a) => a.adGroupId))], family)
  const foreign = new Map(owned.excluded.map((e) => [e.adGroupId, e.why]))
  for (const add of adds) {
    const gone = foreign.has(add.adGroupId) ? `Not written: ${foreign.get(add.adGroupId)}.` : await stillOwned(playbookId, add)
    if (gone) { w.leftAlone.push({ kind: add.kind, text: add.text, adGroupId: add.adGroupId, slot: add.slot, why: gone }); continue }
    const r = await writeNegativeKeyword({
      scope: 'AD_GROUP', adGroupId: add.adGroupId, keywordText: add.text, matchType: add.match, protectConverting: null, userId: actor,
      evidence: { targetKey: `isolation:${add.kind}`, note: add.why },
    })
    if (r.outcome === 'created' || r.outcome === 'local') {
      if (r.reachedAmazon) w.added++
      else w.local++
      if (r.adTargetId) w.negativeIds.push(r.adTargetId)
    } else if (r.outcome === 'already_existed') w.alreadyStanding++
    else if (r.outcome === 'refused') w.refused.push({ text: add.text, adGroupId: add.adGroupId, deniedAt: r.refusal?.deniedAt ?? 'refused', reason: r.refusal?.reason ?? r.error ?? 'refused' })
    else w.failed.push({ text: add.text, adGroupId: add.adGroupId, error: r.error ?? 'it did not reach Amazon' })
  }
  return w
}

/** One run: scope, fresh plan, the items it acts on and (unless a dry run) the writes. */
export async function isolateProduct(args: { action: IsolationAction; actor: string; dryRun: boolean; items?: ReadonlyArray<{ text: string; match: string; adGroupId: string }> | null }): Promise<IsolationRun | { refused: string }> {
  const loaded = await loadIsolation(args.action)
  if ('refused' in loaded) return loaded
  const { inputs } = loaded
  const plan = planIsolation({ action: args.action, ...inputs })
  let chosen = plan.adds
  let noLongerDue: IsolationRun['noLongerDue'] = []
  if (args.items) {
    const wanted = new Set(args.items.map(isolationItemKey))
    chosen = plan.adds.filter((a) => wanted.has(isolationItemKey(a)))
    const found = new Set(chosen.map(isolationItemKey))
    noLongerDue = args.items.filter((i) => !found.has(isolationItemKey(i)))
      .map((i) => ({ text: i.text, adGroupId: i.adGroupId, why: 'It is no longer due on today\'s data (already there, no longer this product\'s, or a winner there now), so it was left alone.' }))
  }
  // ONE BRAIN AB-6 — a negative in a campaign whose negatives a product's brain owns (or the Owner holds) is left to it, in
  // a dry run too (brain/engine-skips.ts; nothing read unless a product is enrolled).
  const holds = await readLeverHolds(chosen.map((a) => a.campaignId), { actor: args.actor }, 'isolate_product_terms')
  const leftToBrain: LeverSkip[] = []
  const leftToBrainItems: NonNullable<IsolationRun['leftToBrainItems']> = []
  chosen = chosen.filter((a) => {
    const skip = holds.skip(a.campaignId, 'negatives')
    if (skip) {
      leftToBrain.push(skip)
      leftToBrainItems.push({ text: a.text, adGroupId: a.adGroupId, why: `left alone: ${skip.reason} (one owner per lever)` })
    }
    return !skip
  })
  chosen = chosen.slice(0, MAX_ISOLATION_ITEMS)
  const written = args.dryRun ? null : await writeAll(args.action.playbookId, chosen, args.actor, inputs.family)
  return { scope: { adGroups: inputs.scope.length, groups: inputs.scope, excluded: inputs.excluded }, plan, chosen, noLongerDue, written, leftToBrain, leftToBrainItems, ...(holds.unread ? { holdsUnread: true } : {}) }
}

const top = <T,>(key: string, list: readonly T[], n = 5) => (list.length ? { [key]: list.length, [`top${key[0].toUpperCase()}${key.slice(1)}`]: list.slice(0, n) } : {})

/**
 * A cadence of N days: one sweep per N UTC days (the rule's one run a day already holds a cadence of 1). Only a sweep that
 * ran counts: a run that failed swept nothing.
 */
async function sweptWithin(ruleId: string, cadenceDays: number): Promise<boolean> {
  const since = new Date()
  since.setUTCHours(0, 0, 0, 0)
  since.setUTCDate(since.getUTCDate() - (cadenceDays - 1))
  const recent = await prisma.automationRuleExecution.findMany({ where: { ruleId, startedAt: { gte: since } }, select: { actionResults: true }, take: 50 })
  return recent.some((ex) => Array.isArray(ex.actionResults) && (ex.actionResults as Array<{ type?: string; ok?: boolean; output?: { cadenceHeld?: unknown } } | null>)
    .some((r) => r?.type === 'isolate_product_terms' && r.ok === true && r.output?.cadenceHeld == null))
}

/**
 * The rule engine's run (the H handler is its caller). `approval` (AA-W2-10): each negative this apply creates joins its
 * undo list.
 */
export async function runIsolation(args: { action: Record<string, unknown>; ruleId: string; dryRun: boolean; preview?: boolean; approval?: { negatives: string[] } }): Promise<ActionResult> {
  const type = 'isolate_product_terms'
  const parsed = ISOLATION_ACTION.safeParse(args.action)
  if (!parsed.success) return { type, ok: false, error: `This isolation rule does not read (${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}); compile it again from the playbook.` }
  const action = parsed.data
  const items = itemsOf(args.action.items)
  // A preview (the Test button, preview-automation) shows what a run would do, whatever the cadence.
  if (!items && !args.preview && (await sweptWithin(args.ruleId, action.cadenceDays))) {
    return { type, ok: true, output: { noChange: true, cadenceHeld: true, why: `This rule keeps a product's campaigns apart once every ${action.cadenceDays} day${action.cadenceDays === 1 ? '' : 's'}, and it already ran.` } }
  }
  const run = await isolateProduct({ action, actor: `automation:${args.ruleId}`, dryRun: args.dryRun, items })
  if ('refused' in run) return args.dryRun ? { type, ok: true, output: { noChange: true, why: run.refused } } : { type, ok: false, error: run.refused }
  const scope = { adGroups: run.scope.adGroups, excluded: run.scope.excluded.slice(0, 20), ...(run.scope.excluded.length > 20 ? { excludedMore: run.scope.excluded.length - 20 } : {}) }
  const leftAlone = top('leftAlone', run.plan.leftAlone)
  const brainSkips = brainSkipsOutput(leverHeldOf(run.leftToBrain), run.leftToBrain, run.holdsUnread === true)
  if (args.dryRun) {
    return {
      type,
      ok: true,
      output: {
        dryRun: true,
        noChange: run.chosen.length === 0,
        scope,
        planned: run.plan.adds.length,
        wouldNegate: run.chosen.length,
        topNegatives: run.chosen.slice(0, 5).map((a) => ({ text: a.text, match: a.match, slot: a.slot, owner: a.owner.text })),
        // What an accept applies: these, and only these (the rest come on the next run).
        items: run.chosen.map(itemOf),
        ...(run.plan.adds.length > run.chosen.length && !items ? { itemsLeftForNextRun: run.plan.adds.length - run.chosen.length } : {}),
        ...(run.plan.alreadyStanding ? { alreadyStanding: run.plan.alreadyStanding } : {}),
        ...leftAlone,
        ...brainSkips,
      },
    }
  }
  const w = run.written!
  if (args.approval) for (const id of w.negativeIds) if (!args.approval.negatives.includes(id)) args.approval.negatives.push(id)
  const wrote = w.added + w.local
  const noLongerDue = top('noLongerDue', run.noLongerDue)
  if (items && !run.chosen.length) {
    if (run.leftToBrain.length && !run.noLongerDue.length) {
      return { type, ok: true, output: { skipped: 'brain-lever', why: `every negative of the card is left alone: ${run.leftToBrain[0].reason} (one owner per lever)`, scope, ...brainSkips } }
    }
    return { type, ok: true, output: { skipped: 'no-longer-due', why: 'none of the card\'s negatives is still due on today\'s data, so nothing was written', scope, ...noLongerDue, ...brainSkips } }
  }
  const problems = [...w.refused.map((r) => r.reason), ...w.failed.map((f) => f.error)]
  // Nothing written, nothing refused, nothing already there: every negative was left alone at the write. Said as a skip,
  // so an accepted card keeps waiting with the reason instead of reading "applied".
  if (!wrote && !problems.length && !w.alreadyStanding && w.leftAlone.length) {
    return { type, ok: true, output: { skipped: 'left-alone', why: w.leftAlone[0].why, scope, ...top('leftAlone', w.leftAlone), ...brainSkips } }
  }
  return {
    type,
    ok: problems.length === 0 || wrote > 0,
    ...(problems.length && !wrote ? { error: problems[0] } : {}),
    output: {
      scope,
      added: w.added,
      local: w.local,
      alreadyStanding: w.alreadyStanding,
      ...(w.refused.length ? { refused: w.refused.slice(0, 20) } : {}),
      ...(w.failed.length ? { failed: w.failed.slice(0, 20) } : {}),
      ...top('leftAlone', [...w.leftAlone, ...run.plan.leftAlone]),
      ...noLongerDue,
      ...brainSkips,
    },
  }
}

// ── The compile and its save ───────────────────────────────────────────────────────────────────

/** The product's playbook row resolved and its isolation rule compiled, or why it cannot be. */
export async function compileIsolationFor(playbookId: string): Promise<{ row: { id: string; market: string; version: number }; compiled: CompiledIsolationRule } | { problems: string[] }> {
  const row = await prisma.adsPlaybook.findUnique({ where: { id: playbookId }, select: PLAYBOOK_ROW_SELECT })
  if (!row) return { problems: ['No such playbook row in this business'] }
  if (row.level !== 'PRODUCT') return { problems: ['Isolation is compiled for a product\'s playbook row only'] }
  const [{ index }, { catalog }] = await Promise.all([loadPlaybookIndex(row.market, row.channel), loadCatalog([row.scopeId])])
  const product = catalog.products.get(row.scopeId)
  if (!product) return { problems: ['The playbook row\'s product no longer exists'] }
  const resolved = resolveProduct(index, product, catalog)
  if (!resolved.doc) return { problems: resolved.problems }
  const value = <T,>(field: 'nameToken' | 'terms') => (resolved.product?.[field].value ?? null) as T | null
  const compiled = compileIsolationRule({
    playbookId: row.id, market: strategyMarketOf(row.market) ?? row.market, nameToken: value<string>('nameToken'), doc: resolved.doc,
    terms: value<ProductTerms>('terms'), handover: ISOLATION_HANDOVER,
  })
  compiled.warnings.unshift(...resolved.warnings)
  return { row: { id: row.id, market: row.market, version: row.version }, compiled }
}

/**
 * The marketplace code the rule runs under (AutomationRule.scopeMarketplace, compared as stored with the run's context):
 * the one this product's linked campaigns in the market carry (Campaign.marketplace; the most common when they differ),
 * else the row's market. So its card is filed under its market, never "the whole account".
 */
async function scopeMarketplaceOf(playbookId: string, market: string): Promise<string> {
  const links = (await playbookLinks([playbookId])).filter((l) => l.kind === 'slot')
  const campaigns = links.length ? await prisma.campaign.findMany({ where: { id: { in: links.map((l) => l.refId) } }, select: { marketplace: true } }) : []
  const counts = new Map<string, number>()
  for (const c of campaigns) if (c.marketplace && strategyMarketOf(c.marketplace) === strategyMarketOf(market)) counts.set(c.marketplace, (counts.get(c.marketplace) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? market
}

/** D1 — why a START keeps the isolation rule off when the compile does (its preview and its answer say it). */
export const ISOLATION_OFF = 'the template turns every isolation switch off'

/**
 * PB-5's hook: compile the product's isolation rule and save it once (AdsPlaybookLink kind 'isolationRule', key
 * 'isolation'). `enabled: true` = a playbook START (rules.ts `start`: on, unless a person switched it off since the last
 * start — then it stays off and `keptOff` says who); `false` = build, adopt or a re-sync (the rule keeps its own on/off;
 * the playbook never switches a rule off). A template that turns every switch off is never started: D1 — a START says
 * so (`keptOff`). Nothing is written when the compile has problems.
 */
export async function syncIsolationRule(playbookId: string, opts: { enabled: boolean; actor?: string }): Promise<{ ruleId: string | null; created: boolean; changed: boolean; enabled: boolean; keptOff?: string; problems: string[]; warnings: string[] }> {
  const out = await compileIsolationFor(playbookId)
  if ('problems' in out) return { ruleId: null, created: false, changed: false, enabled: false, problems: out.problems, warnings: [] }
  const { row, compiled } = out
  if (compiled.problems.length) return { ruleId: null, created: false, changed: false, enabled: false, problems: compiled.problems, warnings: compiled.warnings }
  const saved = await ensureCompiledRule({
    playbookId: row.id, kind: 'isolationRule', key: 'isolation', name: compiled.name, action: compiled.action as unknown as Record<string, unknown>,
    enabled: false, start: opts.enabled && compiled.enabled, scopeMarketplace: await scopeMarketplaceOf(row.id, row.market),
    compiledVersion: row.version, actor: opts.actor ?? 'ads-playbook',
  })
  const keptOff = opts.enabled && !compiled.enabled && !saved.enabled ? `the product's isolation rule stays off: ${ISOLATION_OFF} (START does not switch it on)` : saved.keptOff
  return { ...saved, ...(keptOff ? { keptOff } : {}), problems: [], warnings: compiled.warnings }
}
