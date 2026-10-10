/**
 * ONE BRAIN — `set-ads-brain`: the Owner's control of a product's brain (design 2026-10-08-ads-one-brain/DESIGN.md §6,
 * §2.10, §10 "control it individually": every setting a default he can override per product, market, campaign and lever;
 * his setting always wins). One change tool, eight ops; the rules are advertising/brain/control.ts:
 *
 *   enroll · set-level · lock · unlock · exclude · include · set-value · leave
 *
 * THE OWNER'S CODE RULE A (ads-code-rule.ts 'set-ads-brain: a lever to AUTO') — a change that takes any lever to AUTO (on
 * the product or one of its own campaigns, whichever op does it, an enrollment with an adopted AUTO included) or puts a
 * campaign under the bid brain is a BIG DOOR: approving it needs the approver's authenticator code (the preview's
 * `stepUp`, checked again on the fresh dry run in `execute`). Batch 2 review fix (lead decision) — so is op set-value
 * RAISING the product's portfolio cap limit (portfolioCapLimitCents; 'set-ads-brain: a portfolio cap limit raised'); a lower
 * limit is a normal approval. Everything else is day-to-day: a person's normal approval, with what can add spend listed in
 * `raises` and said in the effect. Every op waits for a person: never by rule, never confirmed in Claude (ceiling ask).
 *
 * Approved, it runs as the person who approved it, on the basis it was approved on (the brain's version and the plan's
 * basis): anything moved since refuses it. op leave gives back, after the commit, the bids and placements of each own
 * campaign the bid brain ran (set-bid-brain-enrollment's putBack, the write gate judging each write), or what a stop saved
 * on those taken back to shadow; withdraws (in the commit) every request the brain asked for that still waits; and
 * resumes each campaign the brain's own pause holds (pauses: resume — a big door, the approver's code), as the approver.
 * undo-change asks this tool for the op that puts the choice back.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import {
  CONTROL_OPS, CONTROL_TOOL, controlStateNow, controlUndoRequest, LEAVE_BIDS, LEAVE_PAUSES, PRODUCT_NOT_FOUND, previewControl, runControl, type ControlInput, type ControlPreview,
} from '../../advertising/brain/control.js'
import { BRAIN_LEVELS, BRAIN_LEVERS, BRAIN_SETTING_KEYS, type BrainSetting } from '../../advertising/brain/levers.js'
import { giveBackPlan, readSnapshot } from '../../advertising/bid-brain/enrollment.js'
import { giveBackStopMemory } from '../../advertising/bid-brain/stop-memory.js'
import { STEP_UP_NEEDS, type StepUp } from '../step-up-approval.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import { ADDS_NO_SPEND, addsSpendWords, codeGate, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'
import { putBack } from './ads-bid-brain-enrollment.tools.js'
import { giveBackWhatBroke, type GiveBackResult } from '../../advertising/brain/retire-run.js'
import { updateCampaignWithSync } from '../../advertising/ads-mutation.service.js'
import type { AgentTool, PlanEntities, ToolContext, ToolResult } from '../tool-types.js'

const BIG_DOOR_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code.'
const ID = z.string().trim().min(1).max(64)

/** The tool's arguments as the service reads them. */
function inputOf(args: Record<string, unknown>): ControlInput {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    op: args.op as ControlInput['op'],
    productId: String(args.productId ?? ''),
    market: String(args.market ?? ''),
    campaignId: text(args.campaignId),
    lever: text(args.lever),
    level: text(args.level),
    levels: (args.levels as ControlInput['levels']) ?? null,
    ref: typeof args.ref === 'string' ? args.ref : null,
    key: text(args.key),
    value: args.value,
    reset: args.reset === true,
    bids: (args.bids as ControlInput['bids']) ?? null,
    pauses: (args.pauses as ControlInput['pauses']) ?? null,
  }
}

/** The dry run: the service's plan, with the code rule's decision and the effect in words. */
async function decide(args: Record<string, unknown>): Promise<ToolResult> {
  const out = await previewControl(inputOf(args))
  if ('refusal' in out) return { ok: false, error: out.refusal === PRODUCT_NOT_FOUND || out.refusal.startsWith('Not queued') ? out.refusal : `Not queued: ${out.refusal}` }
  const p = out.preview
  // Code rule A — three doors: a lever to AUTO (or a campaign under the bid brain), op leave lifting the brain's own pauses,
  // and (batch 2 review fix, lead decision) op set-value raising the product's portfolio cap limit.
  const door = p.op === 'leave' ? 'set-ads-brain: leave lifts the brain\'s pauses' as const
    : p.op === 'set-value' ? 'set-ads-brain: a portfolio cap limit raised' as const
      : 'set-ads-brain: a lever to AUTO' as const
  const coded = p.needsCode && needsCode(door)
  const stepUp: StepUp | null = coded
    ? p.op === 'leave'
      ? { what: `takes the product out of the ads brain and ${p.bigDoor.join('; ')}`, raises: ['Campaign state'], needs: STEP_UP_NEEDS, how: BIG_DOOR_HOW }
      : p.op === 'set-value'
        ? { what: `raises the ads brain's limit (${p.bigDoor.join('; ')})`, raises: ['Portfolio cap limit'], needs: STEP_UP_NEEDS, how: BIG_DOOR_HOW }
        : { what: `takes the ads brain to AUTO (${p.bigDoor.join('; ')})`, raises: ['Brain level'], needs: STEP_UP_NEEDS, how: BIG_DOOR_HOW }
    : null
  const doorWords = p.op === 'leave' ? ' Lifting the brain\'s own pauses is a big door: approving it needs the approver\'s authenticator code (leave with pauses: "keep" needs none).'
    : p.op === 'set-value' ? ' Raising the portfolio cap limit is a big door: approving it needs the approver\'s authenticator code (a lower limit needs none).'
      : ' A lever going to AUTO is a big door: approving it needs the approver\'s authenticator code.'
  const effect = [
    p.summary,
    ...p.starts.map((s) => `${s[0].toUpperCase()}${s.slice(1)}.`),
  ].join(' ') + addsSpendWords(p.raises, coded) + (coded ? doorWords : '') + ` ${p.reachNote}`
  return {
    ok: true,
    preview: {
      ...p,
      ...(stepUp ? { stepUp } : { noCode: p.raises.length ? DAY_TO_DAY_NO_CODE : ADDS_NO_SPEND }),
      consequences: effect,
      effect,
    },
  }
}

const describeOps =
  'op enroll: the product (a variation names its parent) enters the brain for one market — every lever starts OBSERVE '
  + '(shadow: the brain decides and logs, writes nothing) unless levels names another level the lever takes today; the '
  + 'keyword bids lever is adopted from its campaigns as they are (AUTO when the bid brain already runs one of them LIVE) '
  + 'and no campaign moves. op set-level: one lever\'s level (OFF, OBSERVE, PROPOSE: asks a person for each change, AUTO: '
  + 'acts alone inside the caps) for the product or one of its campaigns (campaignId); reset: true ends the level set there '
  + '(the campaign follows the product again, the product the brain\'s default). The keyword bids lever puts the campaigns '
  + 'that may go LIVE under the bid brain at AUTO and takes them back to shadow below it. op lock: hold a lever at the '
  + 'Owner\'s own value (value, or empty: as it is now), or one thing in it (ref: "hourCell:d1h14", "lane:TOP_OF_SEARCH", '
  + '"term:<words>", "adGroup:<id>", "target:<id>"): the brain writes nothing there and only recommends; op unlock ends it. '
  + 'op exclude: the product or one campaign out of the brain (today\'s engines run it); op include ends it. op set-value: '
  + 'one of the brain\'s settings (key, inside its bounds; per product, or per campaign where it means something for one '
  + 'campaign): the portfolio cap on or off, its % or amount, the pacing limit, pauseMinDays, longStopUntil, '
  + 'archiveDeadWeeks, hourPlanAsLimits, hourCellMovePct, the negatives warning and maximum, the strategy-switch approval '
  + 'mode and the rest; reset: true goes back to the product\'s value or the default. tosTargetPct (the top-of-search '
  + 'impression share the bid brain holds a keyword at) also takes one keyword\'s own value: ref "target:<AdTarget.id>" '
  + '(ad-targets lists the ids; the keyword\'s own value wins over its campaign\'s and its product\'s); any other setting '
  + 'refuses a ref, and a keyword that is not in the product\'s campaign named is refused — never set wider instead. '
  + 'op leave: the product out of the '
  + 'brain — every lever back to OFF, its levels and values ended, the Owner\'s locks and exclusions kept; bids says what '
  + 'happens to its own campaigns the bid brain runs: give-back (default: bids and placements back as they were when each '
  + 'went LIVE), shadow (bids stay where they are) or keep (the bid brain keeps running them one by one); every request the '
  + 'brain asked for that still waits for a person is withdrawn; pauses says what happens to the campaigns the brain\'s own '
  + 'pause holds: resume (default: switched back on as the approver — lifting an automation\'s pause needs the approver\'s '
  + 'authenticator code) or keep (they stay paused, each named).'

const setAdsBrain: AgentTool = {
  name: CONTROL_TOOL,
  title: 'Control a product\'s ads brain',
  category: 'advertising',
  description:
    'Control one product\'s Amazon Sponsored Products brain in one market — the Owner\'s own settings, which always win '
    + 'over the brain\'s defaults and over the brain. ' + describeOps + ' The preview names every campaign it reaches (own '
    + 'and shared — a shared campaign is no brain\'s — the excluded and locked ones and those with a level of their own), '
    + 'each change from → to, what the brain will start doing lever by lever, what can add spend, and the refusals: a '
    + 'level a lever does not take yet, a value outside its bounds, a lever to AUTO while one of Amazon\'s own rules acts on '
    + 'it, a change that changes nothing. Any change that takes a lever to AUTO (or puts a campaign under the bid brain) is '
    + 'a big door: approving it needs the approver\'s authenticator code, and so does a value that raises the product\'s '
    + 'portfolio cap limit (portfolioCapLimitCents); OBSERVE, PROPOSE, OFF, locks, exclusions, other values (a lower limit '
    + 'included) and leave are a normal approval, with what adds spend said. A person approves every change in Nexus; nothing '
    + 'changes until then, and an approved change runs only on the facts it was approved on. ads-brain view map shows '
    + 'every setting with its source afterwards.',
  input: z.object({
    op: z.enum(CONTROL_OPS).describe('enroll · set-level · lock · unlock · exclude · include · set-value · leave (see the description)'),
    productId: ID.describe('the product, its Nexus id (a variation names its parent\'s brain)'),
    market: z.string().trim().toUpperCase().min(2).max(20).describe('one Amazon market code, e.g. IT (business-overview lists them)'),
    campaignId: ID.optional().describe('set-level / lock / unlock / exclude / include / set-value: one campaign of the product instead of the whole product (its Nexus id, ad-campaigns)'),
    lever: z.enum(BRAIN_LEVERS).optional().describe('set-level / lock / unlock: the lever'),
    level: z.enum(BRAIN_LEVELS).optional().describe('set-level: OFF, OBSERVE (shadow), PROPOSE (asks a person) or AUTO (acts alone inside the caps — a big door)'),
    levels: z.object(Object.fromEntries(BRAIN_LEVERS.map((l) => [l, z.enum(BRAIN_LEVELS).optional()]))).optional().describe('enroll: the starting level per lever (a lever not named starts OBSERVE; bids follows its campaigns)'),
    ref: z.string().trim().max(220).optional().describe('lock / unlock: one thing inside the lever ("hourCell:d1h14", "lane:TOP_OF_SEARCH", "term:<words>", "adGroup:<id>", "target:<id>"); empty = the whole lever. set-value of tosTargetPct only: one keyword\'s own value, "target:<AdTarget.id>" (with campaignId: at that campaign; without: the product\'s value for that keyword); empty = the product\'s or the campaign\'s value. Any other op or setting refuses a ref'),
    key: z.enum(BRAIN_SETTING_KEYS as [BrainSetting, ...BrainSetting[]]).optional().describe('set-value: the setting (ads-brain view map lists each with its value and source)'),
    value: z.union([z.number(), z.boolean(), z.string().max(64), z.null(), z.record(z.string(), z.number())]).optional()
      .describe('set-value: the setting\'s value (a whole number, true/false, a mode, a day YYYY-MM-DD, or null = empty where it takes one); lock: the Owner\'s own value of the whole lever ({ dailyBudgetCents }, { amountCents }, { TOP_OF_SEARCH: 50 }, a bidding strategy, ENABLED / PAUSED), or empty = as it is now'),
    reset: z.boolean().optional().describe('set-level / set-value: true ends the level or value set at this scope instead (the next one applies)'),
    bids: z.enum(LEAVE_BIDS).optional().describe('leave: give-back (default) puts each LIVE campaign\'s bids and placements back as they were when it went LIVE; shadow leaves them where they are; keep lets the bid brain keep running them one by one'),
    pauses: z.enum(LEAVE_PAUSES).optional().describe('leave: resume (default) switches each campaign the brain\'s own pause holds back on as the approver (a big door: the approver\'s code); keep leaves them paused'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the approver and kept with the Owner\'s choice'),
  }),
  // The brain decides money (budgets, the portfolio cap): who controls it must see ad-spend money.
  requires: [F.adsCampaignsManage, F.adsAutomationManage, FIELDS.financialsAdspendView],
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  // A campaign taken back to shadow gets what a stop saved back at Amazon; op leave gives bids back at Amazon.
  openWorld: true,
  // The choice always goes back; what the brain wrote at Amazon meanwhile, and a give-back, stay.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  // A value or an enrollment is Nexus only (an enrollment moves no campaign) and goes back in full.
  consequencesFor: (args) => (args.op === 'set-value' || args.op === 'enroll' ? { openWorld: false, reversibility: 'full' } : null),
  undo: {
    current: (change) => controlStateNow((change.after ?? {}) as Record<string, unknown>),
    request(change) {
      const built = controlUndoRequest((change.before ?? {}) as Record<string, unknown>)
      return 'refusal' in built ? built : { tool: CONTROL_TOOL, args: built.args }
    },
  },
  // C6 — a step stands on the product's brain (and the campaign it names): a later step of the same plan on the same brain
  // takes its basis again after an earlier one ran.
  planEntities: (args): PlanEntities => {
    const productId = typeof args.productId === 'string' ? args.productId.trim() : ''
    const market = typeof args.market === 'string' ? args.market.trim().toUpperCase() : ''
    const keys = [...(productId && market ? [`ads-brain:${productId}@${market}` as const] : []), ...(typeof args.campaignId === 'string' && args.campaignId.trim() ? [`campaign:${args.campaignId.trim()}` as const] : [])]
    return { reads: keys, writes: keys }
  },
  async handler(args) {
    return decide(args)
  },
  async execute(args, ctx: ToolContext) {
    const fresh = await decide(args)
    if (!fresh.ok) return notRun((fresh.error ?? 'it is no longer a valid change').replace(/^Not queued/, 'Not run'))
    const p = fresh.preview as ControlPreview & { effect: string }
    const approved = ctx.approvedPreview as { basis?: unknown; version?: unknown } | undefined
    if (approved && ((approved.basis !== undefined && approved.basis !== p.basis) || (approved.version !== undefined && (approved.version ?? null) !== p.version))) {
      return notRun(`Not run: what you approved changed since (the product's brain, an override or a campaign's place in the bid brain moved). Nothing changed: preview it again.`)
    }
    const gate = await codeGate(ctx, fresh.preview)
    if ('refusal' in gate) return notRun(gate.refusal)
    const run = approvedRun(ctx, String(args.why ?? '') || p.summary)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const done = await runControl(inputOf(args), { by: run.actor, reason: run.reason, approved: approved ? { basis: approved.basis, version: approved.version } : null })
    if ('refusal' in done) return notRun(`Not run: ${done.refusal}`)
    // op leave — after the commit: each own campaign the bid brain ran gets its bids and placements back (the bid brain's
    // give-back, as the approver, the write gate judging each write), or what a stop saved (taken back to shadow).
    const warnings: string[] = []
    const gaveBack: Array<{ campaignId: string; sent: number; refused: string[] }> = []
    for (const campaignId of done.giveBack) {
      try {
        const row = await prisma.bidBrainEnrollment.findFirst({ where: { campaignId }, select: { snapshot: true } })
        const snapshot = readSnapshot(row?.snapshot)
        if (!snapshot) { warnings.push(`campaign ${campaignId} is back in shadow, but holds no snapshot to give back: its bids stay where they are.`); continue }
        const back = await putBack(campaignId, await giveBackPlan(campaignId, snapshot), run)
        gaveBack.push({ campaignId, sent: back.sent, refused: back.refused })
        if (back.refused.length) warnings.push(`campaign ${campaignId}: ${back.refused.length} write${back.refused.length === 1 ? '' : 's'} of its give-back refused (${back.refused.join('; ')}).`)
        if (back.placementsNotRestored) warnings.push(`campaign ${campaignId}: ${back.placementsNotRestored} (set-bid-brain-enrollment op give-back).`)
      } catch (err) {
        logger.warn('[ads-brain] a give-back after leaving the brain failed', { campaignId, error: err instanceof Error ? err.message : String(err) })
        warnings.push(`campaign ${campaignId} is back in shadow, but its give-back failed (${err instanceof Error ? err.message : String(err)}): run set-bid-brain-enrollment op give-back on it.`)
      }
    }
    // Batch 2 fix — the campaigns the brain's own pause held: back on as the approver (the write gate judges each write).
    const resumed: Array<{ campaignId: string; queued: boolean; refused?: string }> = []
    for (const r of done.resumes ?? []) {
      try {
        const out = await updateCampaignWithSync({
          campaignId: r.campaignId, patch: { status: r.statusBefore as 'ENABLED' }, actor: run.actor, reason: `the product left the ads brain: its pause lifted — ${run.reason}`.slice(0, 480),
          changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, askGate: true,
        })
        if (out.ok) resumed.push({ campaignId: r.campaignId, queued: !!out.outboundQueueId })
        else { resumed.push({ campaignId: r.campaignId, queued: false, refused: out.error ?? 'refused' }); warnings.push(`campaign ${r.campaignId} stays paused: its resume was refused (${out.error ?? 'refused'}) — a person enables it in the campaign manager.`) }
      } catch (err) {
        logger.warn('[ads-brain] a pause of the brain could not be lifted after leaving the brain', { campaignId: r.campaignId, error: err instanceof Error ? err.message : String(err) })
        warnings.push(`campaign ${r.campaignId} stays paused: its resume failed (${err instanceof Error ? err.message : String(err)}) — a person enables it in the campaign manager.`)
      }
    }
    for (const campaignId of done.toShadow) {
      try {
        const back = await giveBackStopMemory(campaignId, { actor: run.actor, reason: `the product left the brain — ${run.reason}`, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits })
        if (back.owed) warnings.push(`campaign ${campaignId} is back in shadow, but what a stop saved could not all be put back (${back.refused.join('; ')}): the next restore of its stop gives it back.`)
      } catch (err) {
        logger.warn('[ads-brain] a stop\'s saved settings could not be given back after leaving the brain', { campaignId, error: err instanceof Error ? err.message : String(err) })
        warnings.push(`campaign ${campaignId} is back in shadow, but what a stop saved could not be given back (${err instanceof Error ? err.message : String(err)}).`)
      }
    }
    // AB-20 — a change that ends what a retirement stood on (leaving the brain, a lever back from AUTO or from the Owner's
    // choice, an unlock, an exclusion) gives back at once each writer the brain retired there; nothing retired, one count.
    let gaveBackWriters: GiveBackResult[] = []
    try { gaveBackWriters = await giveBackWhatBroke(p.brain.productId, p.brain.market, run.actor) } catch (err) {
      logger.warn('[ads-brain] the retired writers could not be checked after a change of the brain — the 15-minute tick does it', { productId: p.brain.productId, market: p.brain.market, error: err instanceof Error ? err.message : String(err) })
      warnings.push('the writers this product\'s brain retired could not be checked now: the 15-minute tick gives back what no longer holds.')
    }
    return {
      ok: true,
      data: {
        op: p.op, productId: p.brain.productId, market: p.brain.market, version: done.version, summary: p.summary, changeSetId: run.changeSetId,
        ...(gaveBack.length ? { gaveBack } : {}), ...(resumed.length ? { resumed } : {}), ...(done.withdrawn?.length ? { withdrawn: done.withdrawn } : {}), ...(warnings.length ? { warnings } : {}),
        ...(gaveBackWriters.length ? { gaveBackWriters: gaveBackWriters.map((g) => ({ writer: g.writer, id: g.targetId, name: g.name, did: g.act, why: g.why })) } : {}),
        note: 'ads-brain view map shows the product\'s brain with every setting and where it comes from.',
      },
      change: { before: done.before, after: done.after },
    }
  },
}

export const ADS_BRAIN_CONTROL_TOOLS: AgentTool[] = [setAdsBrain]
