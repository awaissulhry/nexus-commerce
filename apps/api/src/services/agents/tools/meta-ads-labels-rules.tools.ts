/**
 * Meta ads changes, step 21 — labels, value rules, reach & frequency, on the business's chosen Meta ad account:
 *   set-meta-labels              make, rename or delete (explicit ask) a label; add, remove or replace the labels of
 *                                campaigns and ad sets — CMP-065, CMP-066, CMP-082–084, AS-085–087
 *   set-meta-value-rules         make, change or delete (explicit ask) a value rule set; attach one to an ad set (its legacy
 *                                bid multipliers replaced on ask) or detach it; Meta's translation of legacy bid multipliers
 *                                — AS-093–098
 *   create-meta-reach-frequency  predict reach & frequency (a quote), book (reserve) a prediction, cancel a reservation,
 *                                give an ad set a reservation or let it go — AS-081–084
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person approves
 * it, it runs as that person, and undo puts back what it changed (or says what has no way back on Meta). Meta's own MCP has
 * no tool for any of these; its Ads Manager does them without a preview of what it moves, a spending sentence or an undo.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import { metaChosenAccount, MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { liveAccountCapabilities, liveCampaign } from '../../marketing/meta-ads/live-settings.js'
import { liveAccountLabels, liveAdSetHasAds, liveLabelCarriers, liveLabelledObject, livePrediction, liveRuleSetUsers, liveRulesAdSet, liveValueRuleSets, ruleSetFromRow, type LabelledObject } from '../../marketing/meta-ads/live-labels-rules.js'
import { LABEL_ACTIONS, labelRulesOf, labelsDraft, labelsReadBack, type LabelRule, type LabelsRecord, type LabelsRequest } from '../../marketing/meta-ads/change-labels.js'
import { metaAdRules } from '../../marketing/meta-ads/live-optimize.js'
import { recordedOf, undoRulesOf, VALUE_RULE_ACTIONS, valueRulesDraft, type ValueRulesRecord, type ValueRulesRequest } from '../../marketing/meta-ads/change-value-rules.js'
import { predictionWords, reservationUndoState, RF_ACTIONS, RF_VIDEO_ADS, reachFrequencyDraft, type ReachFrequencyRecord, type ReachFrequencyRequest } from '../../marketing/meta-ads/change-reach-frequency.js'
import { createdIdOf, type MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { META_NAME_TEXT, OPTIMIZATION_GOALS, typedTextOk } from '../../gateway/meta-settings-rules.js'
import {
  META_LABEL_NAME_MAX, META_LABELS_PER_OBJECT, MAX_CRITERIA_VALUES, MAX_VALUE_RULE_CRITERIA, MAX_VALUE_RULES, RF_DEVICE_PLATFORMS, RF_FACEBOOK_POSITIONS,
  RF_INSTAGRAM_POSITIONS, RF_INSTREAM_PACKAGES, RF_MAX_BUDGET, RF_MAX_CURVE_POINTS, RF_MAX_DAYS, RF_MAX_FREQUENCY, RF_MAX_REACH, RF_OBJECTIVES, RF_PRODUCT_TYPES,
  RF_PUBLISHER_PLATFORMS, VALUE_RULE_CRITERIA_TYPES, VALUE_RULE_DECREASE_MAX, VALUE_RULE_INCREASE_MAX, VALUE_RULE_LOCATION_TYPES, VALUE_RULE_PRODUCT_TYPES,
} from '../../gateway/meta-labels-rules.js'

const ADSPEND = FIELDS.financialsAdspendView
/** create-meta-reach-frequency's sentences quote budgets (a prediction's, a reservation's): money. */
const META_RF_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, steps: ADSPEND, values: ADSPEND } as const

// ── shared ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const typedText = (max: number) => z.string().trim().min(1).max(max).regex(META_NAME_TEXT, 'no control or format characters')
const idArg = (what: string) => z.string().trim().regex(/^\d{1,20}$/, 'a Meta id is digits only').describe(what)
const isoArg = (what: string) => z.string().trim().min(10).max(40).describe(`${what} (ISO 8601 with its offset, e.g. 2026-11-01T08:00:00Z)`)
const confirmDeleteArg = (what: string) => z.literal(true).optional().describe(`delete only: true ONLY when the person explicitly asked to DELETE ${what} (for good) — never for "stop" or "remove from"`)

/** A builder that turns a refusal of the live reads (another account, not that kind) into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}
/** A read that only adds to a preview (what carries a label): Meta's refusal leaves it out; the token or a throttle ends the read. */
const optional = <T>(read: Promise<T>): Promise<T | null> => read.catch((err) => {
  if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return null
  throw err
})
const restOf = <T>(args: Record<string, unknown>): T => {
  const { connectionId: _c, why: _w, ...rest } = args
  return rest as T
}
type Done = Array<{ request: MetaChangeRequest; result: MetaChangeResult }>

const common = {
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
} satisfies Partial<AgentTool>

// ── set-meta-labels ─────────────────────────────────────────────────────────────────────────────────────────────────

const labelledArg = z.object({ kind: z.enum(['campaign', 'adset']).describe('campaign or adset'), id: idArg('its Meta id') })

/**
 * Review A2 — the account's ENABLED automated rules that filter on labels (step 8's reader: live-optimize.ts metaAdRules,
 * view list), or null when they could not be read in full (said as a warning, never a refusal). A lost token or a throttle
 * ends the change's read.
 */
async function labelRules(connectionId: string): Promise<LabelRule[] | null> {
  try {
    const read = await metaAdRules({ connectionId, view: 'list', status: 'ENABLED', maxRows: 500 })
    if (!('items' in read) || !Array.isArray(read.items) || read.more) return null
    return labelRulesOf(read.items as unknown as Array<Record<string, unknown>>)
  } catch (err) {
    if (err instanceof MetaReadError && (err.failure.authLost || err.failure.throttled)) throw err
    if (err instanceof MetaReadError || err instanceof MetaLiveRefusal) return null
    throw err
  }
}

const buildLabels = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = restOf<LabelsRequest>(args)
  const target = account.target
  const { labels, more } = await liveAccountLabels(target)
  const named = request.action === 'replace' ? (request.sets ?? []).map((s) => ({ kind: s.kind, id: s.id })) : ['add', 'remove'].includes(request.action) ? request.objects ?? [] : []
  const objects: LabelledObject[] = []
  for (const o of named) if (!objects.some((x) => x.kind === o.kind && x.id === o.id)) objects.push(await liveLabelledObject(target, o.kind, o.id))
  const carriers = request.action === 'delete' && request.labelId && labels.some((l) => l.id === request.labelId) ? await optional(liveLabelCarriers(target, request.labelId)) : null
  const adRules = ['add', 'remove', 'replace', 'delete'].includes(request.action) ? await labelRules(account.accountId) : undefined
  return labelsDraft(request, { adAccountId: account.adAccountId, accountLabels: labels, accountLabelsMore: more, objects, carriers, ...(adRules !== undefined ? { adRules } : {}) })
})

function labelsFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as LabelsRecord
  const planned = draft.after as LabelsRecord
  if (planned.op === 'create') {
    const id = createdIdOf(done[0].result.node)
    const after: LabelsRecord = { op: 'create', label: { id, name: planned.label?.name ?? null }, ...(id ? {} : { noUndo: ['Meta did not answer the new label\'s id, so undo cannot tell it apart.'] }) }
    return { data: { labelId: id }, before, after }
  }
  if (planned.op !== 'objects') return { data: { labelId: planned.label?.id ?? null }, before, after: planned }
  // Only what Meta made is recorded (undo puts back only those objects), each as Meta read it back.
  const doneIds = new Set(done.map((d) => d.request.objectId))
  const objects = (planned.objects ?? []).filter((o) => doneIds.has(o.id)).map((o) => {
    const read = labelsReadBack(done.find((d) => d.request.objectId === o.id)?.result.node ?? null)
    return read ? { ...o, labels: read } : { ...o, unread: true }
  })
  return {
    data: { objects: objects.map((o) => ({ kind: o.kind, id: o.id, labels: o.labels })) },
    before: { op: 'objects' as const, objects: (before.objects ?? []).filter((o) => doneIds.has(o.id)) },
    after: { op: 'objects' as const, objects },
  }
}

const labelsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as LabelsRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      if (after.op === 'objects') {
        const objects = []
        for (const o of after.objects ?? []) objects.push({ ...o, labels: (await liveLabelledObject(account.target, o.kind, o.id)).labels })
        return { ...after, objects }
      }
      const { labels, more } = await liveAccountLabels(account.target)
      const now = labels.find((l) => l.id === after.label?.id)
      if (!now && more) return { ...after, label: { id: after.label?.id ?? null, name: null }, unreadable: 'it is not among the first 500 labels Nexus reads, so Nexus cannot see it now' }
      return { ...after, label: now ? { id: now.id, name: now.name } : { id: after.label?.id ?? null, name: null } }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as LabelsRecord & { accountId?: string }
    const after = (change.after ?? {}) as LabelsRecord & { accountId?: string }
    const connection = after.accountId ?? before.accountId
    const head = { ...(connection ? { connectionId: connection } : {}), why: 'undo of an earlier Meta label change' }
    if (after.op === 'delete') return { refusal: `A deleted label has no way back on Meta: ${(before.noUndo ?? []).join(' ') || 'make one of the same name and put it on what it labelled.'}` }
    if (after.op === 'create') {
      if (!after.label?.id) return { refusal: `There is nothing Nexus can put back: ${(after.noUndo ?? []).join(' ') || 'the change recorded no label id.'}` }
      return { tool: 'set-meta-labels', args: { ...head, action: 'delete', labelId: after.label.id, confirmDelete: true } }
    }
    if (after.op === 'rename') {
      const name = before.label?.name
      if (!after.label?.id || !typedTextOk(name, META_NAME_TEXT, META_LABEL_NAME_MAX)) return { refusal: 'The label\'s earlier name is not one Nexus can send again (empty, too long or with a control character): rename it with the name you want.' }
      return { tool: 'set-meta-labels', args: { ...head, action: 'rename', labelId: after.label.id, name } }
    }
    const sets = (before.objects ?? []).map((o) => ({ kind: o.kind, id: o.id, labelIds: o.labels.map((l) => l.id).filter((id): id is string => !!id) }))
    if (!sets.length) return { refusal: 'This change recorded no campaign or ad set it changed.' }
    return { tool: 'set-meta-labels', args: { ...head, action: 'replace', sets } }
  },
}

const setMetaLabels: AgentTool = {
  ...common,
  name: 'set-meta-labels',
  title: 'Change Meta ad labels',
  // A label deleted has no way back (Meta has no undelete); everything else is undone.
  consequencesFor: (args) => (args.action === 'delete' ? { reversibility: 'none' } : null),
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(LABEL_ACTIONS).describe('create a label; rename or delete one (labelId); add / remove labels on campaigns and ad sets (objects + labelIds / labelNames); replace their whole label lists (sets)'),
    name: typedText(META_LABEL_NAME_MAX).optional().describe('create, rename: the label\'s name'),
    labelId: metaIdArg('rename, delete: the label (meta-labels lists them)').optional(),
    confirmDelete: confirmDeleteArg('this label'),
    objects: z.array(labelledArg).min(1).max(META_LABELS_PER_OBJECT).optional().describe('add, remove: the campaigns and ad sets'),
    labelIds: z.array(idArg('a label of the chosen ad account')).min(1).max(META_LABELS_PER_OBJECT).optional().describe('add, remove: labels by id'),
    labelNames: z.array(typedText(META_LABEL_NAME_MAX)).min(1).max(META_LABELS_PER_OBJECT).optional().describe('add: labels by name (an existing one is used; a new name is made by Meta); remove: the names of labels the objects carry'),
    sets: z.array(labelledArg.extend({ labelIds: z.array(idArg('a label of the chosen ad account')).max(META_LABELS_PER_OBJECT).describe('its WHOLE new label list ([] takes every label off)') }))
      .min(1).max(META_LABELS_PER_OBJECT).optional().describe('replace: each campaign or ad set with its whole new label list'),
    why: metaWhyArg,
  }),
  description:
    'Ad labels of the business\'s chosen Meta ad account: make a label, rename one, or DELETE one (only when the person '
    + 'explicitly asked to delete it: confirmDelete true — Meta takes it off everything that carries it, the preview lists '
    + 'them, and there is no undo); put labels on campaigns and ad sets (by id, or by name: a new name is made by Meta), '
    + 'take them off, or set an object\'s whole list. Meta adds a campaign\'s labels with its add edge; an ad set\'s go as '
    + 'its whole list (Meta has no labels edge for an ad set) and so do removals; each object is read first and read back '
    + 'after. At most 50 labels on one object. Labels of ads are set-meta-ad\'s and of creatives set-meta-creative\'s. A label '
    + 'changes nothing by itself, but Meta\'s automated rules can filter on labels: the preview names every ENABLED rule a '
    + 'change touches, and when that can make the account spend more (an object brought under a rule that switches on or '
    + 'raises, or taken out of one that pauses or lowers) it is SPENDS MONEY. Meta has no check for these changes. Undo puts '
    + 'the earlier lists or name back, and deletes a label it made.'
    + META_CHANGE_RULES,
  undo: labelsUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildLabels(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildLabels(args), labelsFinish),
}

// ── set-meta-value-rules ────────────────────────────────────────────────────────────────────────────────────────────

const criterionArg = z.object({
  type: z.enum(VALUE_RULE_CRITERIA_TYPES).describe('AGE, GENDER, OS_TYPE, DEVICE_PLATFORM, LOCATION, PLACEMENT, AUDIENCE_LABEL, OMNI_CHANNEL (a rule\'s criteria each a different type)'),
  values: z.array(z.string().trim().min(1).max(40)).min(1).max(MAX_CRITERIA_VALUES)
    .describe('AGE "18-24" / "45+"; GENDER MALE / FEMALE; OS_TYPE ANDROID / IOS; DEVICE_PLATFORM MOBILE / DESKTOP; LOCATION a country (IT) or Meta\'s region / city / Comscore market key; PLACEMENT FB_FEED, IG_REELS, …; AUDIENCE_LABEL HIGH_VALUE, …; OMNI_CHANNEL WEBSITE, APP, …'),
  locationTypes: z.array(z.enum(VALUE_RULE_LOCATION_TYPES)).min(1).max(MAX_CRITERIA_VALUES).optional().describe('LOCATION only: each value\'s type, in order (LOCATION_COUNTRY, LOCATION_REGION, LOCATION_CITY, LOCATION_COMSCORE_MARKET)'),
})
const ruleArg = z.object({
  ruleId: idArg('change: a rule of the set that stays (its id; meta-value-rules shows it)').optional(),
  name: typedText(META_LABEL_NAME_MAX).describe('the rule\'s name'),
  adjust: z.enum(['INCREASE', 'DECREASE']).describe('raise or lower the bid for people who match'),
  percent: z.number().int().min(1).max(VALUE_RULE_INCREASE_MAX).describe(`by this percentage (raise 1–${VALUE_RULE_INCREASE_MAX}, lower 1–${VALUE_RULE_DECREASE_MAX})`),
  criteria: z.array(criterionArg).min(1).max(MAX_VALUE_RULE_CRITERIA).describe('who it is for: people who match ALL of these'),
})

const buildValueRules = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = restOf<ValueRulesRequest>(args)
  const target = account.target
  const ruleSets = await liveValueRuleSets(target)
  const users = request.action === 'change' || request.action === 'delete' ? await liveRuleSetUsers(target) : { users: [], more: false }
  const adSet = ['attach', 'detach', 'translate'].includes(request.action) && request.adSetId ? await liveRulesAdSet(target, request.adSetId) : null
  return valueRulesDraft(request, { adAccountId: account.adAccountId, ruleSets, users: users.users, usersMore: users.more, adSet })
})

function valueRulesFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as ValueRulesRecord
  const planned = draft.after as ValueRulesRecord
  const node = done[0].result.node
  if (planned.op === 'create' || planned.op === 'change') {
    // Review A1 — the set as Meta READ IT BACK (rules and criteria with Meta's ids): undo's later read of it then equals the
    // record while nothing moved. A read-back without rules records none (undo compares the name only).
    const id = planned.op === 'create' ? createdIdOf(node) : planned.ruleSet?.id ?? null
    const read = node && node.rules !== undefined && node.rules !== null ? ruleSetFromRow(node) : null
    const after: ValueRulesRecord = {
      op: planned.op,
      ruleSet: { id, name: typeof node?.name === 'string' ? node.name : planned.ruleSet?.name ?? null, rules: read ? read.rules.map(recordedOf) : null },
      ...(id ? {} : { noUndo: ['Meta did not answer the new set\'s id, so undo cannot tell it apart.'] }),
    }
    return { data: { ruleSetId: id, ...(read ? {} : { note: 'Meta did not read the rules back: meta-value-rules shows them.' }) }, before, after }
  }
  if (planned.op === 'translate') {
    // Meta answers a proposal (value_rule_set) and, when one of the account's own matches, its id; nothing was made.
    const proposal = node && typeof node === 'object' ? (node as Record<string, unknown>).value_rule_set ?? null : null
    const existing = node && typeof node === 'object' ? (node as Record<string, unknown>).existing_value_rule_set_id ?? null : null
    return {
      data: { translation: proposal, existingRuleSetId: existing, note: 'Nothing was made. To use it: make it (action create with its rules), or attach the existing set, with replaceLegacyBidMultipliers: true.' },
      before, after: planned, noUndo: 'A translation changes nothing on Meta: there is nothing to undo.',
    }
  }
  return { data: { ruleSetId: planned.ruleSet?.id ?? null, adSetId: planned.adSet?.id ?? null, valueRuleSetId: planned.adSet ? planned.adSet.valueRuleSetId : undefined }, before, after: planned }
}

const valueRulesUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ValueRulesRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      if (after.adSet) {
        const a = await liveRulesAdSet(account.target, after.adSet.id)
        return { ...after, adSet: { id: a.id, valueRuleSetId: a.valueRuleSetId && a.valueRulesApplied !== false ? a.valueRuleSetId : null } }
      }
      const sets = await liveValueRuleSets(account.target)
      const now = sets.find((s) => s.id === after.ruleSet?.id)
      // The same view of the set the run recorded (recordedOf of Meta's read); rules only where the record has them.
      return { ...after, ruleSet: now ? { id: now.id, name: now.name, rules: Array.isArray(after.ruleSet?.rules) ? now.rules.map(recordedOf) : null } : null }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as ValueRulesRecord & { accountId?: string }
    const after = (change.after ?? {}) as ValueRulesRecord & { accountId?: string }
    const connection = after.accountId ?? before.accountId
    const head = { ...(connection ? { connectionId: connection } : {}), why: 'undo of an earlier Meta value rule change' }
    switch (after.op) {
      case 'create':
        return after.ruleSet?.id ? { tool: 'set-meta-value-rules', args: { ...head, action: 'delete', ruleSetId: after.ruleSet.id, confirmDelete: true } } : { refusal: `There is nothing Nexus can put back: ${(after.noUndo ?? []).join(' ') || 'the change recorded no set id.'}` }
      case 'change': {
        const old = before.ruleSet
        if (!old?.id || !old.rules?.length || !typedTextOk(old.name, META_NAME_TEXT, META_LABEL_NAME_MAX) || old.rules.some((r) => !typedTextOk(r.name, META_NAME_TEXT, META_LABEL_NAME_MAX))) {
          return { refusal: 'The earlier rules are not ones Nexus can send again (a name empty, too long or with a control character): change the set to what you want.' }
        }
        return { tool: 'set-meta-value-rules', args: { ...head, action: 'change', ruleSetId: old.id, name: old.name, rules: undoRulesOf(old.rules, after.ruleSet?.rules ?? []) } }
      }
      case 'attach': {
        if (!after.adSet) return { refusal: 'This change recorded no ad set.' }
        // Review A6 — what the undo cannot bring back (legacy bid multipliers removed) rides in its own preview's why.
        const stays = before.noUndo?.length ? { why: `undo of an earlier Meta value rule change (stays as it is: ${before.noUndo.join(' ')})`.slice(0, 300) } : {}
        return before.adSet?.valueRuleSetId
          ? { tool: 'set-meta-value-rules', args: { ...head, ...stays, action: 'attach', adSetId: after.adSet.id, ruleSetId: before.adSet.valueRuleSetId } }
          : { tool: 'set-meta-value-rules', args: { ...head, ...stays, action: 'detach', adSetId: after.adSet.id } }
      }
      case 'detach':
        return before.adSet?.valueRuleSetId ? { tool: 'set-meta-value-rules', args: { ...head, action: 'attach', adSetId: before.adSet.id, ruleSetId: before.adSet.valueRuleSetId } } : { refusal: 'This change recorded no value rule set the ad set used.' }
      case 'translate':
        return { refusal: 'A translation changes nothing on Meta: there is nothing to undo.' }
      default:
        return { refusal: `A deleted value rule set has no way back on Meta: ${(before.noUndo ?? []).join(' ') || 'make one with the same rules and attach it again.'}` }
    }
  },
}

const setMetaValueRules: AgentTool = {
  ...common,
  name: 'set-meta-value-rules',
  title: 'Change Meta value rules',
  // A set deleted has no way back; a translation changes nothing; everything else is undone (legacy multipliers removed stay removed: said).
  consequencesFor: (args) => (args.action === 'delete' || args.action === 'translate' ? { reversibility: 'none' } : null),
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(VALUE_RULE_ACTIONS).describe('create or change a value rule set (rules); delete one; attach one to an ad set, or detach; translate an ad set\'s legacy bid multipliers (a proposal, nothing made)'),
    ruleSetId: metaIdArg('change, delete, attach: the value rule set (meta-value-rules lists them)').optional(),
    name: typedText(META_LABEL_NAME_MAX).optional().describe('create, change: the set\'s name'),
    rules: z.array(ruleArg).min(1).max(MAX_VALUE_RULES).optional().describe('create, change: the WHOLE list of rules in order — the first that matches a person wins (Meta replaces the whole set: a rule not named goes)'),
    productType: z.enum(VALUE_RULE_PRODUCT_TYPES).optional().describe('create only: Meta\'s product type (SDK only; Meta\'s default if left out)'),
    confirmDelete: confirmDeleteArg('this value rule set'),
    adSetId: metaIdArg('attach, detach, translate: the ad set').optional(),
    replaceLegacyBidMultipliers: z.literal(true).optional().describe('attach: the ad set\'s legacy bid multipliers are removed as the rules come — for good (Meta)'),
    why: metaWhyArg,
  }),
  description:
    'Value rules of the business\'s chosen Meta ad account (bid more or less for chosen people, places or placements): make '
    + 'or change a set (1–10 rules in order, each raises 1–1,000 % or lowers 1–90 % for people matching up to 4 criteria; '
    + 'a change sends the whole set, a kept rule by its ruleId), DELETE one (only on the person\'s explicit ask: '
    + 'confirmDelete true; no undo), attach a set to an ad set (LOWEST_COST_WITHOUT_CAP or COST_CAP only; an ad set on legacy '
    + 'bid multipliers moves with replaceLegacyBidMultipliers, for good) or detach it, and translate an ad set\'s legacy bid '
    + 'multipliers (Meta proposes a set; nothing is made — bid multipliers go away in 2027). A raise, a set that raises '
    + 'attached, or lowering rules taken away from an ad set are SPENDS MONEY (the line says when the ad sets are off, so '
    + 'nothing spends yet). Meta has no check for these changes. Undo puts the earlier rules or attachment back and deletes '
    + 'a set it made.'
    + META_CHANGE_RULES,
  undo: valueRulesUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildValueRules(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildValueRules(args), valueRulesFinish),
}

// ── create-meta-reach-frequency ─────────────────────────────────────────────────────────────────────────────────────

const buildReachFrequency = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = restOf<ReachFrequencyRequest>(args)
  const target = account.target
  const chosen = await metaChosenAccount(account.accountId)
  const capabilities = request.action === 'predict' || request.action === 'reserve' || request.action === 'attach' ? await liveAccountCapabilities(target) : null
  const prediction = (request.action === 'reserve' || request.action === 'cancel' || request.action === 'attach') && request.predictionId ? await livePrediction(target, request.predictionId) : null
  // Review A3 — the reservation a booking would release, read now (the draft refuses one an ad set holds).
  const released = request.action === 'reserve' && request.releasePredictionId ? await livePrediction(target, request.releasePredictionId) : null
  const adSet = (request.action === 'attach' || request.action === 'detach') && request.adSetId ? await liveRulesAdSet(target, request.adSetId) : null
  const adSetHasAds = request.action === 'attach' && adSet ? await liveAdSetHasAds(target, adSet.id) : undefined
  const campaignBuyingType = request.action === 'predict' && request.campaignId ? (await liveCampaign(target, request.campaignId)).buyingType : null
  return reachFrequencyDraft(request, {
    adAccountId: account.adAccountId, currency: account.currency, now: new Date(), capabilities, pageId: chosen.pageId, instagramId: chosen.instagramId,
    prediction, released, adSet, ...(adSetHasAds !== undefined ? { adSetHasAds } : {}), campaignBuyingType,
  })
})

function reachFrequencyFinish(draft: MetaChangeDraft, done: Done) {
  const before = draft.before as ReachFrequencyRecord
  const planned = draft.after as ReachFrequencyRecord
  const node = done[0].result.node
  const status = node && typeof node.status === 'number' ? node.status : node && typeof node.status === 'string' && /^\d+$/.test(node.status) ? Number(node.status) : null
  if (planned.op === 'predict') {
    const id = createdIdOf(node)
    return {
      data: { predictionId: id, prediction: id ? predictionWords({ id, status, reservationStatus: null }) : null, note: 'Meta works a prediction out over a few moments: ask a reserve of it (action reserve) to see its result in the preview before anything is booked.' },
      before, after: { ...planned, predictionId: id }, noUndo: 'A prediction books nothing and spends nothing: there is nothing to undo.',
    }
  }
  if (planned.op === 'reserve') {
    const id = createdIdOf(node)
    const after: ReachFrequencyRecord = { ...planned, reservationId: id, ...(id ? {} : { noUndo: ['Meta did not answer the reservation\'s id: cancel it by the id meta-ads-live or Ads Manager shows.'] }) }
    return { data: { reservationId: id, note: 'Meta holds the inventory about an hour: give it to an ad set now (action attach with this reservationId as predictionId).' }, before, after }
  }
  return { data: { adSetId: planned.adSetId ?? null, reservation: planned.adSetPrediction ?? planned.predictionId ?? null }, before, after: planned, ...(planned.op === 'cancel' ? { noUndo: 'A cancelled reservation cannot be put back: booking again is a new reservation.' } : {}) }
}

const reachFrequencyUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ReachFrequencyRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      if (after.op === 'attach' || after.op === 'detach') {
        const a = await liveRulesAdSet(account.target, after.adSetId ?? '')
        return { ...after, adSetPrediction: a.rfPredictionId }
      }
      // Review A1 — a booking's undo (a cancel) stays possible while the reservation reads reserved, free (not attached), not
      // expired and not running: then what is there is what the change made (equal to its record). Otherwise the reason.
      if (after.op !== 'reserve' || !after.reservationId) return after
      const p = await livePrediction(account.target, after.reservationId)
      const moved = reservationUndoState(p, Math.floor(Date.now() / 1000))
      return moved ? { ...after, state: moved } : after
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as ReachFrequencyRecord & { accountId?: string }
    const after = (change.after ?? {}) as ReachFrequencyRecord & { accountId?: string }
    const connection = after.accountId ?? before.accountId
    const head = { ...(connection ? { connectionId: connection } : {}), why: 'undo of an earlier Meta reach and frequency change' }
    switch (after.op) {
      case 'reserve':
        // Review A3 — a reservation this booking released does not come back: said in the undo's own preview (its why).
        return after.reservationId ? { tool: 'create-meta-reach-frequency', args: { ...head, ...(before.noUndo?.length ? { why: `undo of an earlier Meta reach and frequency booking (stays as it is: ${before.noUndo.join(' ')})`.slice(0, 300) } : {}), action: 'cancel', predictionId: after.reservationId } } : { refusal: `There is nothing Nexus can cancel by itself: ${(after.noUndo ?? []).join(' ') || 'the change recorded no reservation id.'}` }
      case 'attach':
        return after.adSetId ? { tool: 'create-meta-reach-frequency', args: { ...head, action: 'detach', adSetId: after.adSetId } } : { refusal: 'This change recorded no ad set.' }
      case 'detach':
        return before.adSetId && before.adSetPrediction ? { tool: 'create-meta-reach-frequency', args: { ...head, action: 'attach', adSetId: before.adSetId, predictionId: before.adSetPrediction } } : { refusal: 'This change recorded no reservation the ad set had.' }
      case 'predict':
        return { refusal: 'A prediction books nothing and spends nothing: there is nothing to undo (Meta has no delete for it; it expires).' }
      default:
        return { refusal: 'A cancelled reservation\'s inventory is free for others: booking again is a new reservation (action reserve on a prediction — Meta may quote another price).' }
    }
  },
}

const createMetaReachFrequency: AgentTool = {
  ...common,
  name: 'create-meta-reach-frequency',
  title: 'Meta reach & frequency (reservation)',
  // A prediction changes nothing to undo; a cancel cannot be put back; a booking and an ad set's reservation are undone.
  consequencesFor: (args) => (args.action === 'predict' || args.action === 'cancel' ? { reversibility: 'none' } : null),
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: META_RF_MONEY,
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(RF_ACTIONS).describe('predict (a quote: nothing booked or spent); reserve a prediction (BOOKS it: SPENDS MONEY); cancel a reservation; attach a reservation to an ad set; detach it'),
    mode: z.enum(['reach-from-budget', 'budget-from-reach']).optional().describe('predict: the reach for a budget (budgetCents) or the budget for a reach (reach)'),
    budgetCents: z.number().int().positive().max(RF_MAX_BUDGET).optional().describe('predict: the lifetime budget, in minor units of the ad account\'s currency (cents for EUR)'),
    reach: z.number().int().positive().max(RF_MAX_REACH).optional().describe('predict: the people to reach (Meta: at least the country\'s minimum, often 200,000–1,000,000)'),
    startTime: isoArg('predict: when it starts (in the future)').optional(),
    stopTime: isoArg(`predict: when it stops (at most 8 weeks ahead, at most ${RF_MAX_DAYS} days after the start)`).optional(),
    frequencyCap: z.number().int().min(1).max(RF_MAX_FREQUENCY).optional().describe('predict: at most this many times per person'),
    frequencyCapDays: z.number().int().min(1).max(RF_MAX_DAYS).optional().describe('predict: …per this many days (left out: over the whole plan)'),
    targetFrequency: z.number().int().min(1).max(RF_MAX_FREQUENCY).optional().describe('predict, instead of a cap: Meta\'s balanced target frequency (SDK only)'),
    targetFrequencyDays: z.number().int().min(1).max(RF_MAX_DAYS).optional().describe('predict: the target frequency\'s period in days'),
    targeting: z.object({
      country: z.string().trim().regex(/^[A-Z]{2}$/).describe('ONE country (Meta: a prediction takes one)'),
      ageMin: z.number().int().min(13).max(65).optional().describe('youngest age'),
      ageMax: z.number().int().min(13).max(65).optional().describe('oldest age'),
      genders: z.array(z.enum(['male', 'female'])).min(1).max(2).optional().describe('left out: everyone'),
      platforms: z.array(z.enum(RF_PUBLISHER_PLATFORMS)).min(1).max(2).optional().describe('facebook, instagram'),
      facebookPositions: z.array(z.enum(RF_FACEBOOK_POSITIONS)).min(1).max(RF_FACEBOOK_POSITIONS.length).optional().describe('Facebook placements (feed, right_hand_column, …)'),
      instagramPositions: z.array(z.enum(RF_INSTAGRAM_POSITIONS)).min(1).max(RF_INSTAGRAM_POSITIONS.length).optional().describe('Instagram placements (stream, story, explore, explore_home, reels)'),
      devices: z.array(z.enum(RF_DEVICE_PLATFORMS)).min(1).max(2).optional().describe('mobile, desktop'),
    }).optional().describe('predict: who and where (no Website Custom Audiences; Meta\'s answer decides each placement mix)'),
    destinations: z.array(z.enum(['page', 'instagram'])).min(1).max(2).optional().describe('predict: the chosen Facebook Page (default) and, for Instagram placements, the chosen Instagram account'),
    objective: z.enum(RF_OBJECTIVES).optional().describe('predict: Meta\'s reach-and-frequency objective (default REACH)'),
    optimizationGoal: z.enum(OPTIMIZATION_GOALS).optional().describe('predict: the optimisation goal'),
    dayParting: z.object({
      startMinute: z.number().int().min(0).max(1439).describe('from this minute of the day'),
      endMinute: z.number().int().min(1).max(1440).describe('to this minute of the day (at least 3 hours later)'),
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7).describe('0 = Sunday … 6 = Saturday'),
      timezone: z.enum(['USER', 'ADVERTISER']).optional().describe('USER: the viewer\'s time zone (default); ADVERTISER: the ad account\'s'),
    }).optional().describe('predict: the same hours every day it names (at least 3 hours)'),
    curvePoints: z.number().int().min(1).max(RF_MAX_CURVE_POINTS).optional().describe('predict: points of Meta\'s budget-reach curve (default 400)'),
    videoAds: z.enum(Object.keys(RF_VIDEO_ADS) as [keyof typeof RF_VIDEO_ADS, ...Array<keyof typeof RF_VIDEO_ADS>]).optional().describe('predict: the ad formats it is for (none, video, canvas, video-and-canvas)'),
    campaignId: metaIdArg('predict: the RESERVED campaign it belongs to').optional(),
    shareAudienceOf: metaIdArg('predict: a prediction whose audience it reuses').optional(),
    existingAdSetId: metaIdArg('predict: a running reservation ad set it re-predicts (SDK only)').optional(),
    productType: z.enum(RF_PRODUCT_TYPES).optional().describe('predict: Meta\'s product type — STANDARD only (SDK only; the trending and burst products are not offered)'),
    instreamPackages: z.array(z.enum(RF_INSTREAM_PACKAGES)).min(1).max(RF_INSTREAM_PACKAGES.length).optional().describe('predict: in-stream video packages'),
    predictionId: metaIdArg('reserve: the prediction; cancel: the reservation; attach: the reservation (the id Meta answered for the reserve)').optional(),
    point: z.object({
      reach: z.number().int().positive().max(RF_MAX_REACH).describe('the point\'s reach (curve_budget_reach)'),
      budgetCents: z.number().int().positive().max(RF_MAX_BUDGET).describe('its budget, minor units of the account currency'),
      impressions: z.number().int().positive().max(RF_MAX_REACH * RF_MAX_FREQUENCY).describe('its impressions'),
    }).optional().describe('reserve: one point of the prediction\'s budget-reach curve instead of its own (all three)'),
    releasePredictionId: metaIdArg('reserve: a reservation this one releases (its audience reused)').optional(),
    adSetId: metaIdArg('attach, detach: the ad set').optional(),
    why: metaWhyArg,
  }),
  description:
    'Reach & frequency (Meta\'s "Reservation" buying) on the business\'s chosen Meta ad account — Meta grants it per account '
    + '(CAN_USE_REACH_AND_FREQUENCY). predict: a quote of the reach for a budget or the budget for a reach in ONE country, '
    + 'dates (start ahead, stop at most 8 weeks ahead, at most 90 days), a frequency cap, placements, the chosen Page (and '
    + 'Instagram account) — it books and spends nothing. reserve: BOOKS a ready prediction — agreeing to pay Meta\'s '
    + 'proposed costs: SPENDS MONEY, the person\'s decision, the preview names the amount and dates; Meta holds it about an '
    + 'hour. attach: an ad set of a RESERVED campaign (with an ad, not active) takes the reservation (SPENDS MONEY once it '
    + 'is on). detach lets it go; cancel frees a reservation that does not run (a running one is stopped only by deleting '
    + 'its campaign). Amounts in minor units of the account currency. Meta has no check for these changes. Undo cancels a '
    + 'booking and detaches an attach.'
    + META_CHANGE_RULES,
  undo: reachFrequencyUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildReachFrequency(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildReachFrequency(args), reachFrequencyFinish),
}

export const META_ADS_LABELS_RULES_TOOLS: AgentTool[] = [setMetaLabels, setMetaValueRules, createMetaReachFrequency]
