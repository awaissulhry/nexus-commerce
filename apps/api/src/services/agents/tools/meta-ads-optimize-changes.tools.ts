/**
 * Meta ads changes, step 28 — Meta's recommendations and experiments on the business's chosen Meta ad account (and its
 * chosen Page's video tests):
 *   apply-meta-recommendations  apply a recommendation of the 14 types Meta applies by API, with its signature; undo puts
 *                               back budgets and goals and pauses copies it made — RC-008…RC-021
 *   create-meta-experiment      an A/B test, a creative test, a conversion lift study (Meta's grant) or a Page video A/B
 *                               test, with Nexus's own pre-check (Meta has none by API) — EX-011, EX-013…EX-018, EX-901
 *   set-meta-experiment         rename, describe, extend, add cells or objects, change the split or objectives before it
 *                               starts, share it; delete a concluded Page video test — EX-019…EX-022, EX-902
 *   end-meta-experiment         end a running test early (its end moved to a time soon: Meta takes only a future end) — EX-023
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person
 * approves it, it runs as that person. Meta's own MCP tools for these (ads_experiment_abtest_create_test / _update_test,
 * ads_experiment_lift_create_test, ads_experiment_check_eligibility) change Meta without a preview, an approval, a
 * spending sentence or a record; these do all four (and Meta's MCP has no recommendation apply at all).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { metaChosenAccount, MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { liveAccountPixels } from '../../marketing/meta-ads/live-settings.js'
import {
  liveAccountBusiness, liveAccountCustomConversions, liveAccountPeople, liveApplyTargets, liveNewCopies, liveObjectStudies, liveOpenStudies, livePageVideo,
  livePageVideoTest, liveRecommendation, liveStudy, studyForeignProblem, type ApplyTarget,
} from '../../marketing/meta-ads/live-optimize-changes.js'
import {
  APPLY_TYPES, applyDraft, applyFields, applyLevel, applyTargetIds, deliversNow, restoreDraft, type ApplyRecord, type ApplyRequest, type RestoreItem,
} from '../../marketing/meta-ads/change-recommendations.js'
import {
  addedObjectIds, cellObjectIds, createExperimentDraft, endExperimentDraft, EXPERIMENT_KINDS, MAX_STUDY_OBJECTS_CREATE, setExperimentDraft, studyFields,
  type CreateExperimentRequest, type ExperimentRecord, type OpenStudy, type SetExperimentRequest, type StudyObject,
} from '../../marketing/meta-ads/change-experiments.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import { CREATIVE_FEATURES, LIFT_PIXEL_EVENTS, MAX_APPLY_OBJECTS, MAX_STUDY_VIEWERS, RECOMMENDATION_SIGNATURE, VIDEO_TEST_GOALS } from '../../gateway/meta-optimize-rules.js'
import { BILLING_EVENTS, META_NAME_TEXT, OPTIMIZATION_GOALS } from '../../gateway/meta-settings-rules.js'
import { metaObjectState, noteMetaObjectTouched } from '../../gateway/meta-object-limits.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' previews and answers: their sentences and tables quote budgets and test budgets. */
const OPTIMIZE_MONEY = {
  changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, skipped: ADSPEND, steps: ADSPEND, objects: ADSPEND, values: ADSPEND,
  readBack: ADSPEND, restored: ADSPEND,
} as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const id = z.string().trim().regex(/^\d{1,20}$/, 'a Meta id is digits only')
const idList = (what: string, max: number) => z.array(id).min(1).max(max).describe(what)
const centsArg = (what: string) => z.number().int().positive().max(100_000_000_000).describe(`${what}, in minor units of the ad account's currency (cents for EUR)`)
const typedText = (max: number) => z.string().trim().min(1).max(max).regex(META_NAME_TEXT, 'no control or format characters')
const isoArg = (what: string) => z.string().trim().min(10).max(40).describe(`${what} (ISO 8601 with its offset, e.g. 2026-11-01T08:00:00Z)`)
const percentArg = (what: string, min: number) => z.number().min(min).max(100).describe(what)

/** A builder that turns a refusal of the live reads (another account, not that kind) into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

/** Each ad set's budget changes in the last hour (Meta allows 4; Nexus's own count of what it sent). */
async function budgetChanges(account: MetaChangeAccount, ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const adSetId of ids) out[adSetId] = (await metaObjectState(account.accountId, adSetId)).budgetChanges.length
  return out
}

// ── apply-meta-recommendations ──────────────────────────────────────────────────────────────────────────────────

const restoreItem = z.object({
  kind: z.enum(['campaign', 'adset', 'ad']).describe('campaign, adset or ad'),
  id: metaIdArg('its id'),
  dailyBudgetCents: centsArg('its daily budget as it was').optional(),
  lifetimeBudgetCents: centsArg('its lifetime budget as it was').optional(),
  optimizationGoal: z.enum(OPTIMIZATION_GOALS).optional().describe('its performance goal as it was'),
  billingEvent: z.enum(BILLING_EVENTS).optional().describe('its billing as it was'),
  status: z.literal('PAUSED').optional().describe('a copy the apply made: paused'),
  foundBy: z.literal('time').optional().describe('a copy found by its time only (Meta named no source): the preview says so'),
})

const buildApply = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.restore) {
    const restore = args.restore as { type: string; items: RestoreItem[] }
    const targets: ApplyTarget[] = []
    for (const kind of ['campaign', 'adset', 'ad'] as const) {
      const ids = restore.items.filter((i) => i.kind === kind).map((i) => i.id)
      if (!ids.length) continue
      const read = await liveApplyTargets(account.target, ids, kind)
      if ('refusal' in read) return read
      targets.push(...read)
    }
    return restoreDraft(restore.type, restore.items, { targets, currency: account.currency, budgetChangesLastHour: await budgetChanges(account, targets.filter((t) => t.kind === 'adset').map((t) => t.id)) })
  }
  const request: ApplyRequest = {
    signature: String(args.signature ?? ''),
    objectIds: args.objectIds as string[] | undefined,
    creativeFeatures: args.creativeFeatures as ApplyRequest['creativeFeatures'],
    backgroundAction: args.backgroundAction as ApplyRequest['backgroundAction'],
    budgetRaises: args.budgetRaises as ApplyRequest['budgetRaises'],
    allowNewObjects: args.allowNewObjects as boolean | undefined,
  }
  if (!request.signature) return { refusal: 'Name the recommendation by its signature (meta-recommendations view list shows it).' }
  const recommendation = await liveRecommendation(account.target, request.signature)
  const base = { currency: account.currency, adAccountId: account.adAccountId, budgetChangesLastHour: {} }
  if (!recommendation) return applyDraft(request, { ...base, recommendation: null, targets: [] })
  const ids = applyTargetIds(request, recommendation)
  if ('refusal' in ids) return ids
  const targets = await liveApplyTargets(account.target, ids, applyLevel(recommendation.type)!)
  if ('refusal' in targets) return targets
  return applyDraft(request, { ...base, recommendation, targets, budgetChangesLastHour: await budgetChanges(account, targets.filter((t) => t.kind === 'adset').map((t) => t.id)) })
})

/** The record of an apply (or of a restore): only what Meta made. */
function applyFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeDraft['requests'][number] }>) {
  const before = draft.before as ApplyRecord
  const after = draft.after as ApplyRecord
  if (before.signature) return { data: { type: before.type, objects: after.objects.map((o) => ({ kind: o.kind, id: o.id, name: o.name })) }, before, after }
  // A restore: one request per object.
  const made = new Set(done.map(({ request }) => request.objectId))
  const keep = (r: ApplyRecord): ApplyRecord => ({ ...r, objects: r.objects.filter((o) => made.has(o.id)) })
  return { data: { restored: keep(after).objects }, before: keep(before), after: keep(after) }
}

/**
 * Right after an apply: the objects read again (what Meta made of them — the record undo compares with), and for a type
 * that makes copies, the copies Nexus finds by Meta's source field since the run started (undo pauses them; one found by
 * its time only is named so). Meta's per-object limits learn the objects it changed. Review A7 — Meta has applied it by
 * now: a failure here never drops the record or its undo; the answer says what could not be read.
 */
async function afterApply(result: ToolResult, startedAt: number): Promise<ToolResult> {
  const change = result.change as { before: ApplyRecord & { accountId?: string }; after: ApplyRecord & { accountId?: string; adAccountId?: string } } | undefined
  if (!result.ok || !change?.after?.signature) return result
  const notes: string[] = []
  const rule = APPLY_TYPES[change.after.type]
  const after: ApplyRecord & { accountId?: string; adAccountId?: string } = { ...change.after }
  const before: ApplyRecord & { accountId?: string; adAccountId?: string } = { ...change.before }
  const readBack: Array<Record<string, unknown>> = []
  let copiesSentence: string | null = null
  let account: Awaited<ReturnType<typeof recordAccount>> = null
  try { account = await recordAccount(change.after) } catch (err) { notes.push(`Nexus could not open the account again to read the change back (${err instanceof Error ? err.message : String(err)}).`) }
  if (account) {
    const read: ApplyTarget[] = []
    const objects = []
    for (const o of change.after.objects) {
      const live = await liveApplyTargets(account.target, [o.id], o.kind).catch(() => ({ refusal: 'not read' }))
      if ('refusal' in live) { objects.push(o); readBack.push({ kind: o.kind, id: o.id, name: o.name, notRead: true }); continue }
      read.push(live[0])
      const fields = applyFields(change.after.type, live[0])
      objects.push({ ...o, fields })
      readBack.push({ kind: o.kind, id: o.id, name: o.name, now: fields })
    }
    after.objects = objects
    try {
      for (const o of change.after.objects) await noteMetaObjectTouched(account.accountId, o.id, { budget: rule?.undo === 'budgets' && o.kind === 'adset' })
    } catch { notes.push('Nexus could not note Meta\'s per-object limits for these objects: a change of one of them within 30 s may be refused by Meta.') }
    if (rule?.copies) {
      const sources = new Set(change.after.objects.map((o) => o.id))
      const parents = new Set(read.map((t) => (rule.copies === 'adset' ? t.campaignId : t.adSetId)).filter((x): x is string => !!x))
      const copies = await liveNewCopies(account.target, rule.copies, sources, parents, startedAt).catch(() => null)
      if (copies) {
        after.copies = copies.map(({ kind, id, name, status }) => ({ kind, id, name, status }))
        const pause = copies.filter((c) => c.status !== 'PAUSED' && c.status !== 'ARCHIVED' && c.status !== 'DELETED')
        const items: RestoreItem[] = pause.slice(0, MAX_APPLY_OBJECTS - (before.undo?.length ?? 0)).map((c) => ({ kind: c.kind, id: c.id, status: 'PAUSED' as const, ...(c.foundBy === 'time' ? { foundBy: 'time' as const } : {}) }))
        if (items.length < pause.length) before.noUndo = [...(before.noUndo ?? []), `Meta made more copies than one undo pauses (${MAX_APPLY_OBJECTS}): pause the rest with set-meta-status.`]
        before.undo = [...(before.undo ?? []), ...items]
        if (!before.undo.length) before.undo = null
        const running = copies.filter((c) => c.status === 'ACTIVE')
        const byTime = copies.filter((c) => c.foundBy === 'time')
        copiesSentence = copies.length
          ? `Meta made ${copies.length} new ${rule.copies === 'adset' ? 'ad set' : 'ad'}${copies.length === 1 ? '' : 's'} (${copies.map((c) => `${c.id}: ${c.status ?? 'status not read'}${c.foundBy === 'time' ? ', found by its time only' : ''}`).join(', ')})${running.length ? ` — ${running.length} ${running.length === 1 ? 'is' : 'are'} ACTIVE and can spend; set-meta-status or undo pauses them` : ''}.${byTime.length ? ' One found by its time only has no source on Meta\'s side: it may be one a person made at the same moment — the undo names it so.' : ''}`
          : 'Nexus found no new copy yet.'
        copiesSentence += ' Copies Meta makes LATER are not found by the undo: meta-ads-live shows the ad sets and ads; pause any with set-meta-status.'
      } else {
        after.copiesUnread = true
        before.noUndo = [...(before.noUndo ?? []), 'Nexus could not read the copies Meta made right after the apply: pause them with set-meta-status (meta-ads-live shows them).']
        copiesSentence = 'Nexus could not read the copies Meta made: meta-ads-live shows them; pause them with set-meta-status if they run.'
      }
    }
  } else if (rule?.copies) {
    before.noUndo = [...(before.noUndo ?? []), 'Nexus could not look for the copies Meta made: pause them with set-meta-status (meta-ads-live shows them).']
  }
  const data = result.data as Record<string, unknown>
  return {
    ...result,
    data: {
      ...data,
      ...(readBack.length ? { readBack } : {}),
      ...(after.copies ? { copies: after.copies } : {}),
      ...(copiesSentence ? { copiesSentence } : {}),
      ...(notes.length ? { nexusNote: `Meta applied it. ${notes.join(' ')}` } : {}),
    },
    change: { before: { ...before, accountId: change.before.accountId ?? change.after.accountId, adAccountId: change.after.adAccountId } as unknown, after: after as unknown },
  }
}

/** Undo of an apply: the budgets and goals it replaced back, the copies it made paused — through this tool's restore. */
const applyUndo: ToolUndo = {
  async current(change: ToolChange) {
    const before = (change.before ?? {}) as ApplyRecord
    const after = (change.after ?? {}) as ApplyRecord & { accountId?: string; adAccountId?: string }
    // Nothing to put back (no undo, or a restore): the request says why; nothing is read.
    if (!before.undo?.length || !after.signature) return change.after
    const account = await recordAccount(after)
    if (!account) return null
    const objects = []
    for (const o of after.objects) {
      const live = await liveApplyTargets(account.target, [o.id], o.kind).catch(() => ({ refusal: 'not read' }))
      if ('refusal' in live) return null
      objects.push({ ...o, fields: applyFields(after.type, live[0]) })
    }
    return { ...after, objects }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as ApplyRecord & { accountId?: string }
    const after = (change.after ?? {}) as ApplyRecord & { accountId?: string }
    if (!before.signature) return { refusal: 'This was the undo of an apply: to change it again, apply the recommendation again (or set-meta-ad-set / set-meta-campaign).' }
    if (!before.undo?.length) return { refusal: `Nexus cannot put this ${before.type} apply back: ${(before.noUndo ?? []).join(' ') || 'it recorded nothing to put back.'}` }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'apply-meta-recommendations',
      args: { ...(accountId ? { connectionId: accountId } : {}), restore: { type: before.type, items: before.undo }, why: `undo of an applied Meta ${before.type} recommendation` },
    }
  },
}

const applyMetaRecommendations: AgentTool = {
  ...common,
  name: 'apply-meta-recommendations',
  title: 'Apply Meta ads recommendations',
  // Budgets and goals are put back, copies paused; Advantage+ targeting, placements and creative features have no way back in Nexus.
  reversibility: 'partial',
  consequencesFor: (args) => (args.restore ? { reversibility: 'none' } : null),
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: OPTIMIZE_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    signature: z.string().trim().regex(RECOMMENDATION_SIGNATURE, 'the signature as meta-recommendations shows it').optional()
      .describe('the recommendation to apply, by its signature (meta-recommendations view list: signature; it goes stale — Nexus reads it again first)'),
    objectIds: idList(`the ads or ad sets to apply it to, among the ones it names (types that take a choice: creative features, music, uncrop, AI backgrounds, creative fatigue, Reels placements, Shops ads; default all; at most ${MAX_APPLY_OBJECTS})`, MAX_APPLY_OBJECTS).optional(),
    creativeFeatures: z.array(z.enum(CREATIVE_FEATURES)).max(CREATIVE_FEATURES.length).optional()
      .describe('APLUSC_STANDARD_ENHANCEMENTS_BUNDLE: the features each ad opts in to (standard_enhancements always; Nexus names every feature it opts in to and no other)'),
    backgroundAction: z.enum(['OPT_IN', 'OPT_OUT']).optional().describe('BACKGROUND_GENERATION: AI backgrounds on (OPT_IN) or off (OPT_OUT)'),
    budgetRaises: z.array(z.object({
      objectId: metaIdArg('an ad set (no campaign budget) or a campaign (campaign budget) the recommendation names'),
      additionalBudgetCents: centsArg('how much more it may spend (added to its daily or lifetime budget)'),
    })).min(1).max(MAX_APPLY_OBJECTS).optional().describe('SCALE_GOOD_CAMPAIGN: the raise per object (Meta takes the amounts you name; it gives none by API)'),
    allowNewObjects: z.literal(true).optional().describe('CONVERSION_LEADS_OPTIMIZATION, CREATIVE_FATIGUE, LANDING_PAGE_VIEW_OPTIMIZATION_GOAL: you accept that Meta makes new ad sets, ads or a campaign that may start running (SPENDS MONEY; undo pauses the copies Nexus finds) — without it Nexus does not apply these'),
    restore: z.object({
      type: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,79}$/).describe('the recommendation type that was applied'),
      items: z.array(restoreItem).min(1).max(MAX_APPLY_OBJECTS).describe('what each object goes back to'),
    }).optional().describe('ONLY the undo of an earlier apply (undo-change builds it from the record): put back the budgets and goals it replaced, pause the copies it made'),
    why: metaWhyArg,
  }),
  description:
    'Apply ONE of Meta\'s recommendations for the business\'s chosen Meta ad account, by its signature (meta-recommendations '
    + 'view list): the 14 types Meta applies by API — Advantage+ audience, Advantage+ placements, Reels placements, Shops '
    + 'ads, landing-page-view goal, product set expansion, conversion-leads copies, creative fatigue refresh, Advantage+ '
    + 'creative enhancements (Nexus names every feature it opts in to), standard enhancements, music, image uncrop, AI '
    + 'backgrounds (on or off) and budget raises (SCALE_GOOD_CAMPAIGN: you name each raise in minor units). Any other type '
    + 'is answered with the Nexus tool that does the same, or the recommendation\'s Ads Manager link. Nexus reads the '
    + 'recommendation (signatures go stale) and every object it names again first; the objects must be the chosen account\'s. '
    + 'A budget raise, wider delivery in an object that is on, and copies or new ads Meta makes are SPENDS MONEY (the line '
    + 'says when nothing is on); Meta does not say whether its copies start running, so the types that make them need '
    + 'allowNewObjects: true. Meta has no check for an apply and answers only "success": the run reads the objects back. '
    + 'Applying means agreeing to Meta\'s advertising terms. Undo puts back the budgets and goals it replaced and pauses the '
    + 'copies it made; Advantage+ audience, placements, Shops ads, product set expansion and creative features have no way '
    + 'back in Nexus (the preview says so).'
    + META_CHANGE_RULES,
  undo: applyUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildApply(args)),
  execute: async (args, ctx) => {
    // Review A4 — the copies' window starts when this run starts (never earlier: an object made before is never a copy).
    const startedAt = Math.floor(Date.now() / 1000)
    const result = await runMetaChange(args, ctx, buildApply(args), applyFinish)
    return args.restore ? result : afterApply(result, startedAt)
  },
}

// ── create-meta-experiment ──────────────────────────────────────────────────────────────────────────────────────

const cellArg = z.object({
  name: typedText(100).describe('the cell\'s name'),
  description: typedText(500).optional(),
  percent: percentArg('its share of the audience that sees the ads (10–100; a creative test: whole numbers summing to 100)', 10),
  controlPercent: z.number().gt(0).max(100).optional().describe('lift: its holdout (people who see none of these ads), above 0'),
  campaignIds: idList('its campaigns (A/B test of campaigns, lift)', 50).optional(),
  adSetIds: idList('its ad sets (A/B test of ad sets, lift)', 50).optional(),
  adIds: idList('creative test: its ONE ad', 1).optional(),
  wholeAdAccount: z.literal(true).optional().describe('lift: the whole chosen ad account'),
})
const objectiveArg = z.object({
  name: typedText(100).describe('what it measures, e.g. "Purchases"'),
  primary: z.boolean().optional().describe('the primary objective (one; default the first)'),
  pixelId: id.optional().describe('the ad account\'s own pixel'),
  pixelEvents: z.array(z.enum(LIFT_PIXEL_EVENTS)).min(1).max(LIFT_PIXEL_EVENTS.length).optional().describe('the pixel events it counts (fb_pixel_purchase, …)'),
  customConversionIds: idList('the ad account\'s own custom conversions', 10).optional(),
})

const studyObjects = async (account: MetaChangeAccount, chosen: Awaited<ReturnType<typeof metaChosenAccount>>, ids: Array<{ kind: 'campaign' | 'adset' | 'ad'; id: string }>) => {
  const objects = new Map<string, StudyObject>()
  const objectStudies = new Map<string, OpenStudy[]>()
  for (const o of ids) {
    const read = await liveApplyTargets(account.target, [o.id], o.kind)
    if ('refusal' in read) return { refusal: read.refusal }
    objects.set(o.id, { kind: o.kind, id: o.id, name: read[0].name, on: deliversNow(read[0]) })
    objectStudies.set(o.id, (await liveObjectStudies(chosen, o.kind, o.id)).map((s) => ({ studyId: s.studyId, name: s.name, state: s.state, endTime: s.endTime })))
  }
  return { objects, objectStudies }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

const buildCreate = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const { connectionId: _c, why: _w, ...rest } = args
  const request = rest as unknown as CreateExperimentRequest
  const chosen = await metaChosenAccount(account.accountId)
  const now = nowSeconds()
  const empty = { now, adAccountId: account.adAccountId, currency: account.currency, businessId: null, pageId: chosen.pageId, objects: new Map(), objectStudies: new Map(), openStudies: null, pixels: null, customConversions: null, videos: [] }
  if (request.kind === 'page-video-test') {
    if (!chosen.pageId) return createExperimentDraft(request, empty)
    const videos = []
    for (const v of [...new Set(request.videoIds ?? [])].slice(0, 4)) {
      const read = await livePageVideo(account.target, chosen.pageId, v)
      if ('refusal' in read) return read
      videos.push(read)
    }
    return createExperimentDraft(request, { ...empty, videos })
  }
  const ids = cellObjectIds(request.cells)
  if (ids.length > MAX_STUDY_OBJECTS_CREATE) return { refusal: `A new test names at most ${MAX_STUDY_OBJECTS_CREATE} objects in Nexus (each is read twice before it is asked: Meta's Limited access tier allows about 60 reads per 5 minutes).` }
  const read = await studyObjects(account, chosen, ids)
  if ('refusal' in read) return { refusal: read.refusal }
  const lift = request.kind === 'lift'
  const open = await liveOpenStudies(chosen)
  return createExperimentDraft(request, {
    ...empty,
    businessId: await liveAccountBusiness(account.target),
    objects: read.objects,
    objectStudies: read.objectStudies,
    openStudies: open.more ? null : open.open,
    openLifts: open.openLifts.map((s) => ({ studyId: s.studyId, name: s.name, state: s.state, endTime: s.endTime, wholeAccount: s.wholeAccount })),
    pixels: lift && request.objectives?.some((o) => o.pixelId) ? await liveAccountPixels(account.target) : null,
    customConversions: lift && request.objectives?.some((o) => o.customConversionIds?.length) ? await liveAccountCustomConversions(account.target) : null,
  })
})

/** The record of a new study or video test: Meta's new id, read back. */
function createFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeDraft['requests'][number]; result: { node: Record<string, unknown> | null } }>) {
  const node = done[0]?.result.node ?? null
  const newId = node && (typeof node.id === 'string' || typeof node.id === 'number') ? String(node.id) : ''
  const after = { ...(draft.after as ExperimentRecord), id: newId }
  return { data: { id: newId || null, kind: after.kind, type: after.type, note: newId ? 'meta-experiments view study (or page-video-test) reads it.' : 'Meta did not send its new id back: meta-experiments view list shows it.' }, before: draft.before, after }
}

const createMetaExperiment: AgentTool = {
  ...common,
  name: 'create-meta-experiment',
  title: 'Make a Meta A/B test or lift study',
  // A study cannot be deleted (Meta), a Page video test only once it concluded: making one has no undo.
  reversibility: 'none',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: OPTIMIZE_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    kind: z.enum(EXPERIMENT_KINDS).describe('ab-test (ad sets or campaigns), creative-test (one ad per cell, with a test budget), lift (conversion lift with a holdout: Meta\'s grant), page-video-test (the chosen Page\'s unpublished videos)'),
    name: typedText(200).describe('its name'),
    description: typedText(1000).optional().describe('its purpose (a Page video test needs one)'),
    startTime: isoArg('when it starts (in the future; a Page video test: when Meta starts it, default at once)').optional(),
    endTime: isoArg('when it ends').optional(),
    observationEndTime: isoArg('lift: until when Meta counts conversions (default its end)').optional(),
    confidenceLevel: z.number().min(0.5).max(0.99).optional().describe('the confidence Meta reports with (0.5–0.99)'),
    cells: z.array(cellArg).min(1).max(10).optional().describe('its groups (cells): an A/B test 2–10 (all ad sets or all campaigns), a creative test 2–5 (one ad each, shares summing to 100), lift 1–10; each share at least 10 %, all at most 100 %; at most 20 objects in all'),
    creativeTestBudget: z.object({
      dailyBudgetCents: centsArg('a daily test budget').optional(),
      lifetimeBudgetPercent: z.number().min(1).max(100).optional().describe('or a share of the lifetime budget'),
    }).optional().describe('creative test: its own test budget (one of the two)'),
    objectives: z.array(objectiveArg).min(1).max(5).optional().describe('lift: what it measures (at least one; the ad account\'s pixel with its events, or its custom conversions)'),
    videoIds: idList('page-video-test: 2–4 of the chosen Page\'s uploaded, unpublished videos', 4).optional(),
    controlVideoId: id.optional().describe('page-video-test: the video that wins a tie (default the first)'),
    goal: z.enum(VIDEO_TEST_GOALS).optional().describe('page-video-test: what decides the winner'),
    durationMinutes: z.number().int().min(30).max(10_080).optional().describe('page-video-test: how long it runs (30 minutes to a week)'),
    why: metaWhyArg,
  }),
  description:
    'Make ONE experiment for the business\'s chosen Meta ad account: an A/B test of ad sets or campaigns (one variable), a '
    + 'creative test (one ad per cell, its own test budget), a conversion lift study with a holdout (Meta grants lift to '
    + 'some accounts only: its refusal is said in plain words), or a video A/B test of the chosen Page\'s unpublished '
    + 'videos (organic). Studies are made on the ad account\'s business portfolio. Nexus runs the pre-check Meta has no API '
    + 'for: 2+ cells (lift 1+), each share at least 10 % and all at most 100 %, every object the chosen account\'s and in no '
    + 'other test that is not over, at most 100 open studies, the start in the future. A test adds no budget — the cells\' '
    + 'campaigns and ad sets keep spending as set — except a creative test\'s own test budget: SPENDS MONEY (the line says '
    + 'when its ads are off). Meta has no check for it. NO UNDO: Meta cannot delete a study; once it runs its start and '
    + 'split are fixed and nothing can be removed (set-meta-experiment, end-meta-experiment do what Meta allows).'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCreate(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCreate(args), createFinish),
}

// ── set-meta-experiment ─────────────────────────────────────────────────────────────────────────────────────────

const buildSet = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const { connectionId: _c, why: _w, ...rest } = args
  const request = rest as unknown as SetExperimentRequest
  const chosen = await metaChosenAccount(account.accountId)
  const now = nowSeconds()
  const empty = { now, adAccountId: account.adAccountId, study: null, objects: new Map(), objectStudies: new Map(), pixels: null, customConversions: null, people: null, videoTest: null }
  if (request.action === 'delete-page-video-test') {
    if (!chosen.pageId) return { refusal: 'No Facebook Page is chosen for this business yet.' }
    if (!request.testId) return setExperimentDraft(request, empty)
    const t = await livePageVideoTest(account.target, chosen.pageId, request.testId)
    return setExperimentDraft(request, { ...empty, videoTest: t })
  }
  if (!request.studyId) return setExperimentDraft(request, empty)
  const study = await liveStudy(chosen, request.studyId)
  const foreign = await studyForeignProblem(chosen, study)
  if (foreign) return { refusal: foreign }
  const added = addedObjectIds(request)
  if (added.length > 20) return { refusal: 'Add at most 20 objects in one change (each is read twice first: Meta\'s rate limits).' }
  const read = await studyObjects(account, chosen, added)
  if ('refusal' in read) return { refusal: read.refusal }
  const newcomers = (request.viewers ?? []).filter((v) => !(study.viewers ?? []).includes(v))
  const business = newcomers.length ? await liveAccountBusiness(account.target) : null
  return setExperimentDraft(request, {
    ...empty, study, objects: read.objects, objectStudies: read.objectStudies,
    pixels: request.objectives?.some((o) => o.pixelId) ? await liveAccountPixels(account.target) : null,
    customConversions: request.objectives?.some((o) => o.customConversionIds?.length) ? await liveAccountCustomConversions(account.target) : null,
    people: business ? await liveAccountPeople(account.target, business) : null,
    // Follow-up 2 — the OTHER open lifts on the account, when cells or objects are added (null: not readable).
    ...(request.addCells?.length || request.addObjects?.length ? { openLifts: await otherOpenLifts(chosen, study.id) } : {}),
  })
})

/** The lift studies on the chosen account that are not over, but this one; null when Meta does not answer the list. */
async function otherOpenLifts(chosen: Awaited<ReturnType<typeof metaChosenAccount>>, studyId: string): Promise<OpenStudy[] | null> {
  try {
    const open = await liveOpenStudies(chosen)
    if (open.more) return null
    return open.openLifts.filter((l) => l.studyId !== studyId).map((l) => ({ studyId: l.studyId, name: l.name, state: l.state, endTime: l.endTime, wholeAccount: l.wholeAccount }))
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return null
    throw err
  }
}

/**
 * Follow-up 6 — a removal of cells: the study is read again after the run and the answer says whether Meta removed them
 * (best effort; a read that fails is said, the record stands).
 */
async function afterSet(result: ToolResult, args: Record<string, unknown>): Promise<ToolResult> {
  const removed = Array.isArray(args.removeCellIds) ? (args.removeCellIds as string[]) : []
  if (!result.ok || !removed.length || typeof args.studyId !== 'string') return result
  let sentence: string
  try {
    const ranOn = ((result.data as Record<string, unknown>).account as { accountId?: unknown } | undefined)?.accountId
    const chosen = await metaChosenAccount(typeof ranOn === 'string' ? ranOn : null)
    const study = await liveStudy(chosen, args.studyId)
    const still = removed.filter((id) => study.cells?.some((c) => c.id === id))
    sentence = !study.cells
      ? 'Nexus could not read the study\'s cells again: meta-experiments view study shows whether Meta removed them.'
      : still.length ? `Meta still lists cell ${still.join(', ')}: it did not remove ${still.length === 1 ? 'it' : 'them'} (meta-experiments view study shows the cells).` : `Meta removed cell ${removed.join(', ')} (read back).`
  } catch (err) {
    sentence = `Nexus could not read the study again (${err instanceof Error ? err.message : String(err)}): meta-experiments view study shows whether Meta removed the cells.`
  }
  return { ...result, data: { ...(result.data as Record<string, unknown>), removedCells: sentence } }
}

function studyRecordFinish(draft: MetaChangeDraft) {
  return { data: { id: (draft.after as ExperimentRecord).id, fields: (draft.after as ExperimentRecord).fields }, before: draft.before, after: draft.after }
}

/** Undo of a study change: name, description, dates, split and viewers as they were — through set-meta-experiment, read live first. */
const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const before = (change.before ?? {}) as ExperimentRecord
    const after = (change.after ?? {}) as ExperimentRecord & { accountId?: string; adAccountId?: string }
    if (after.kind !== 'study' || !before.undo) return change.after
    const account = await recordAccount(after)
    if (!account) return null
    const chosen = await metaChosenAccount(account.accountId).catch(() => null)
    if (!chosen) return null
    const study = await liveStudy(chosen, after.id).catch(() => null)
    if (!study) return null
    const live = studyFields(study)
    return { ...after, fields: Object.fromEntries(Object.keys(after.fields).map((k) => [k, live[k] ?? null])) }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as ExperimentRecord & { accountId?: string }
    const after = (change.after ?? {}) as ExperimentRecord & { accountId?: string }
    if (!before.undo) return { refusal: `Nexus cannot put this change back: ${(before.noUndo ?? []).join(' ') || 'it recorded nothing to put back.'}` }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-meta-experiment',
      args: { ...(accountId ? { connectionId: accountId } : {}), ...before.undo, why: `undo of an earlier Meta study change${before.noUndo?.length ? ` (stays: ${before.noUndo.join(' ')})` : ''}`.slice(0, 300) },
    }
  },
}

const setMetaExperiment: AgentTool = {
  ...common,
  name: 'set-meta-experiment',
  title: 'Change a Meta A/B test or lift study',
  // Names, dates, splits and viewers are put back; added cells and objects stay (Meta removes nothing from a running study);
  // a deleted Page video test is gone.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'delete-page-video-test' ? { reversibility: 'none' } : null),
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['update', 'delete-page-video-test']).describe('update a study, or delete a concluded Page video test (for good)'),
    studyId: metaIdArg('update: the study (meta-experiments view list)').optional(),
    name: typedText(200).optional().describe('its new name'),
    description: typedText(1000).optional().describe('its new description'),
    startTime: isoArg('before it starts only: its new start').optional(),
    endTime: isoArg('its new end: any time before it starts; once it runs only LATER (to end sooner: end-meta-experiment)').optional(),
    observationEndTime: isoArg('lift: until when Meta counts conversions (at or after the end)').optional(),
    confidenceLevel: z.number().min(0.5).max(0.99).optional().describe('the confidence Meta reports with'),
    splits: z.array(z.object({
      cellId: metaIdArg('a cell (meta-experiments view study)'),
      percent: percentArg('its new share (at least 10)', 10),
      controlPercent: z.number().gt(0).max(100).optional().describe('lift: its new holdout (above 0; needed when Meta did not answer the old one)'),
    })).min(1).max(10).optional().describe('before it starts only: every remaining cell\'s share'),
    addCells: z.array(cellArg).min(1).max(5).optional().describe('new cells (Meta needs every cell\'s share with it; the new shares fit in what is left of 100 %)'),
    removeCellIds: z.array(id).min(1).max(9).optional().describe('before it starts only: cells to remove'),
    addObjects: z.array(z.object({
      cellId: metaIdArg('the cell'),
      campaignIds: idList('campaigns to add (a cell of campaigns)', 20).optional(),
      adSetIds: idList('ad sets to add (a cell of ad sets)', 20).optional(),
      adIds: idList('ads to add', 20).optional(),
    })).min(1).max(10).optional().describe('objects to add to cells (also while it runs; Meta never removes one once it runs)'),
    objectives: z.array(objectiveArg).min(1).max(5).optional().describe('lift, before it starts only: its objectives (they replace the ones it has)'),
    viewers: z.array(id).max(MAX_STUDY_VIEWERS).optional().describe('who may see it: the FULL list of Meta person ids (only people with a role on the ad account; [] shares it with nobody)'),
    testId: metaIdArg('delete-page-video-test: the test (meta-experiments view page-video-tests)').optional(),
    why: metaWhyArg,
  }),
  description:
    'Change ONE study of the business\'s chosen Meta ad account (an A/B test, a creative test or a conversion lift study '
    + 'that touches only that account): its name and description; its end (before it starts any time, once it runs only '
    + 'later — Meta allows extending; a creative test\'s observation end moves with it, and its test budget runs longer: '
    + 'SPENDS MONEY); a lift study\'s observation end; new cells and new objects in cells (also while it runs; Meta removes '
    + 'nothing from a running study); before it starts only: its start, the split, removing cells, a lift study\'s '
    + 'objectives; who may see it (Meta person ids, only people with a role on the ad account). Or delete a Page video '
    + 'test once it concluded (for good; its posts stay). Meta has no check for a study change. Undo puts back the name, '
    + 'description, dates, split and viewers it replaced; added cells and objects stay.'
    + META_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSet(args)),
  execute: async (args, ctx) => afterSet(await runMetaChange(args, ctx, buildSet(args), studyRecordFinish), args),
}

// ── end-meta-experiment ─────────────────────────────────────────────────────────────────────────────────────────

const buildEnd = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const chosen = await metaChosenAccount(account.accountId)
  const study = await liveStudy(chosen, String(args.studyId ?? ''))
  const foreign = await studyForeignProblem(chosen, study)
  if (foreign) return { refusal: foreign }
  return endExperimentDraft(study, nowSeconds(), String(args.endAt ?? ''))
})

const endMetaExperiment: AgentTool = {
  ...common,
  name: 'end-meta-experiment',
  title: 'End a Meta A/B test early',
  // Once the new end has passed a study is over for good (Meta restarts and deletes none).
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    studyId: metaIdArg('the running study (meta-experiments view list)'),
    endAt: isoArg('when it ends: soon, at least 2 minutes and at most a day from now — 15 minutes from now is a good default (Meta takes only a future end)'),
    why: metaWhyArg,
  }),
  description:
    'End ONE running study of the business\'s chosen Meta ad account early (an A/B test, a creative test or a conversion '
    + 'lift study that touches only that account). Meta documents no cancel and takes only a FUTURE end, so Nexus moves the '
    + 'end to the time named (endAt: at least 2 minutes from now — 15 minutes is a good default); a creative test\'s '
    + 'observation end moves with it, a lift study keeps counting conversions until its observation end. Whether Meta takes '
    + 'an earlier end is not proven yet: its answer decides, in its words. The results of a test cut short are weaker. Its '
    + 'campaigns, ad sets and ads keep running as set (pause them with set-meta-status). A study not started yet cannot be '
    + 'ended (move its dates with set-meta-experiment). Meta has no check for it. No undo once the new end has passed.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildEnd(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildEnd(args), studyRecordFinish),
}

export const META_ADS_OPTIMIZE_CHANGES_TOOLS: AgentTool[] = [applyMetaRecommendations, createMetaExperiment, setMetaExperiment, endMetaExperiment]
