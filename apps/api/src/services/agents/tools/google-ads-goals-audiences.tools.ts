/**
 * Google Ads changes, programme 2 G14a (2026-10-16, Owner: "no gap at all") — custom conversion goals and new audiences.
 * Every tool here is a Nexus change a person approves in Nexus; it runs as that person, never by a rule
 * (google-ads-kit.ts). Google checks each one first (validate_only: GoogleAdsService.Mutate, and CustomAudienceService's
 * own MutateCustomAudiences for custom segments).
 *
 *   set-google-custom-goals         custom conversion goals (a goal of chosen conversion actions): make, rename, change
 *                                   their actions, remove (only on the person's ask); which campaign uses one is
 *                                   set-google-conversion-goals (customGoals). Undo puts names and actions back and
 *                                   removes the goals it made.
 *   set-google-custom-audiences     custom segments (people by keywords, web addresses, apps): make, change, remove (only
 *                                   on ask). Undo puts them back and removes the ones it made.
 *   set-google-user-lists           your data segments: website visitors by rules, combinations of lists, people who
 *                                   converted, lookalikes — make, change, remove (only on ask). Customer Match lists are
 *                                   never made or filled here (personal data). Undo puts them back and removes the new ones.
 *   set-google-reusable-audiences   reusable audiences (Google's Audience: segments, age, gender, income, parental status,
 *                                   user lists left out) for Demand Gen ad groups and Performance Max signals: make and
 *                                   change. Google has no remove for them: undo puts a changed one back; a new one stays.
 *
 * An audience spends nothing by itself; the campaigns that use it do. A change that lets one reach more people where a
 * serving campaign uses it, or a custom goal that makes Smart Bidding chase more, is SPENDS MONEY in the preview.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange,
  type GoogleDraftBuilder, type GoogleSender,
} from './google-ads-kit.js'
import type { GoogleChangeAccount } from '../../marketing/google-ads/change-account.js'
import { customGoalDraft, customGoalRecordAfterRun, type CustomGoalRecord, type CustomGoalRequest } from '../../marketing/google-ads/change-custom-goals.js'
import {
  CUSTOM_AUDIENCE_TYPES, customAudienceDraft, customAudienceRecordAfterRun, membersOf,
  type CustomAudienceRecord, type CustomAudienceRequest,
} from '../../marketing/google-ads/change-custom-audiences.js'
import {
  AGE_MAXES, AGE_MINS, AUDIENCE_NAME_MAX, definitionKey, reusableAudienceDraft, reusableAudienceRecordAfterRun,
  type ReusableAudienceRecord, type ReusableAudienceRequest,
} from '../../marketing/google-ads/change-reusable-audiences.js'
import {
  LOGICAL_OPERATORS, LOOKALIKE_LEVELS, MEMBERSHIP_MAX_DAYS, userListDraft, userListRecordAfterRun, visitorsKey,
  type CombinationRule, type UserListFields, type UserListRecord, type UserListRequest,
} from '../../marketing/google-ads/change-user-lists.js'
import { liveAccountSettings, liveConversions } from '../../marketing/google-ads/live-account.js'
import { liveBiddingCampaigns, liveConversionActions } from '../../marketing/google-ads/live-conversions.js'
import {
  DATE_OPERATORS, GENDERS, INCOMES, liveAudienceUses, liveCustomAudiences, liveCustomGoals, liveDetailedDemographicNames, liveReusableAudiences,
  liveUserLists, MEMBER_TYPES, NUMBER_OPERATORS, PARENTAL, SEGMENT_KINDS, segmentKey, STRING_OPERATORS,
  type AudienceDefinition, type RuleOperand, type SegmentRef, type VisitorRules,
} from '../../marketing/google-ads/live-goals-audiences.js'
import { liveSegmentNames, type AudienceKind } from '../../marketing/google-ads/live-targeting.js'
import { checkAccountOperations, sendAccountOperations } from '../../marketing/google-ads/account-client.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
  // What they make or change is put back; what they remove is gone for good (and a reusable audience cannot be removed).
  reversibility: 'partial' as const,
}

const removeArg = (what: string) => z.array(googleIdArg(what)).max(20).optional()
  .describe(`${what}s to REMOVE for good — only when the person asked for exactly this removal (with confirmRemove true)`)
const confirmRemoveArg = z.literal(true).optional().describe('true: the person asked for exactly the removals in remove (needed with remove)')
const nameArg = (max: number) => z.string().trim().min(1).max(max)
const descriptionArg = z.string().max(2000).optional().describe('a description (\'\' clears it)')

/** A removal needs the person's ask, said with confirmRemove (the refusal before anything is read). */
function removalUnasked(args: Record<string, unknown>): { refusal: string } | null {
  return Array.isArray(args.remove) && args.remove.length && args.confirmRemove !== true
    ? { refusal: 'remove deletes for good: pass confirmRemove true, and only when the person asked for exactly this removal.' }
    : null
}

/** The ids a record made that undo removes; null when one has no Google id (the run did not record it). */
const madeIds = (ids: string[]): string[] | null => (ids.every((id) => /^\d{1,20}$/.test(id)) ? ids : null)

// ── set-google-custom-goals ─────────────────────────────────────────────────────────────────────────────────────

const customGoalRequest = (args: Record<string, unknown>): CustomGoalRequest => ({
  create: args.create as CustomGoalRequest['create'],
  change: args.change as CustomGoalRequest['change'],
  remove: args.remove as string[] | undefined,
})

const buildCustomGoals = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const unasked = removalUnasked(args)
  if (unasked) return unasked
  const conv = await liveConversions(account.target)
  if (conv.notRead.length) return { refusal: `Nexus could not read the account's conversions (${conv.notRead.map((n) => n.part).join(', ')}): ${conv.notRead[0].why}` }
  const settings = await liveAccountSettings(account.target)
  return customGoalDraft(customerResource(account.target), customGoalRequest(args), {
    customerId: account.customerId,
    conversionCustomerId: settings?.conversionTracking.conversionCustomerId ?? null,
    goals: await liveCustomGoals(account.target),
    actions: conv.actions,
    campaignGoals: conv.campaigns,
    campaigns: await liveBiddingCampaigns(account.target),
  })
}

const customGoalsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CustomGoalRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const byId = new Map((await liveCustomGoals(account.target)).map((g) => [g.customGoalId, g]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      goals: (after.goals ?? []).map((g) => {
        const now = byId.get(g.customGoalId)
        return {
          customGoalId: g.customGoalId,
          ...('name' in g ? { name: now?.name ?? null } : {}),
          ...('conversionActionIds' in g ? { conversionActionIds: now?.conversionActionIds ?? [] } : {}),
        }
      }),
      created: (after.created ?? []).filter((c) => byId.has(c.customGoalId)),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<CustomGoalRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<CustomGoalRecord> & { accountId?: string }
    const back = (before.goals ?? []).map((g) => ({
      customGoalId: g.customGoalId,
      ...(typeof g.name === 'string' && g.name ? { name: g.name } : {}),
      ...(g.conversionActionIds?.length ? { conversionActionIds: g.conversionActionIds } : {}),
    })).filter((g) => Object.keys(g).length > 1)
    const remove = madeIds((after.created ?? []).map((c) => c.customGoalId))
    if (!remove) return { refusal: 'This change does not record the id of a custom goal it made.' }
    if (!back.length && !remove.length) return { refusal: 'A removed custom goal cannot be put back (a new goal with the same actions is another goal, and no campaign uses it).' }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-custom-goals',
      args: {
        ...(accountId ? { accountId } : {}),
        ...(back.length ? { change: back } : {}),
        ...(remove.length ? { remove, confirmRemove: true } : {}),
        why: `undo of an earlier custom goal change${(after.removed ?? []).length ? ' (the goals it removed cannot be made again)' : ''}`,
      },
    }
  },
}

const actionIdsArg = z.array(googleIdArg('a conversion action')).min(1).max(100)

const setGoogleCustomGoals: AgentTool = {
  ...common,
  name: 'set-google-custom-goals',
  title: 'Change Google Ads custom goals',
  requires: [F.adsCampaignsManage, F.adsBidsEdit],
  input: z.object({
    accountId: googleAccountArg,
    create: z.array(z.object({
      name: nameArg(255).describe('its name'),
      conversionActionIds: actionIdsArg.describe('the conversion actions it counts (google-ads-live view conversions lists them); primary or secondary, they count'),
    })).max(20).optional().describe('new custom goals (no campaign uses one until set-google-conversion-goals customGoals says so)'),
    change: z.array(z.object({
      customGoalId: googleIdArg('the custom goal'),
      name: nameArg(255).optional().describe('a new name'),
      conversionActionIds: actionIdsArg.optional().describe('its FULL new list of conversion actions'),
    })).max(50).optional().describe('existing custom goals: a new name or a new list of actions'),
    remove: removeArg('a custom goal'),
    confirmRemove: confirmRemoveArg,
    why: googleWhyArg,
  }),
  description:
    'Custom conversion goals of the business\'s chosen Google Ads account: a goal of chosen conversion actions (any '
    + 'category, primary or secondary) a campaign bids for besides its biddable goals. Make them (create), rename them or '
    + 'give them a new list of actions (change), or REMOVE them (remove, with confirmRemove true, only when the person '
    + 'asked; a removal cannot be undone). A campaign uses one through set-google-conversion-goals (customGoals). More '
    + 'actions in a goal that Smart Bidding campaigns use is marked SPENDS MONEY, naming them; fewer is a warning. Google '
    + 'makes custom goals only in the account that tracks the conversions (cross-account tracking is refused, named). '
    + 'google-ads-query "SELECT custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.conversion_actions '
    + 'FROM custom_conversion_goal" lists them. Undo puts names and actions back and removes the goals it made.'
    + GOOGLE_CHANGE_RULES,
  undo: customGoalsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildCustomGoals(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildCustomGoals(args), (draft, responses) => {
    const after = customGoalRecordAfterRun(draft.after as CustomGoalRecord, responses)
    return { data: { created: after.created, changed: after.goals.length, removed: after.removed.length }, before: draft.before, after }
  }),
}

// ── set-google-custom-audiences ─────────────────────────────────────────────────────────────────────────────────

const memberArg = z.object({
  type: z.enum(MEMBER_TYPES).describe('KEYWORD (what people search or are into), URL (a site they visit, with https://), APP (an Android package name) or PLACE_CATEGORY (Google\'s id)'),
  value: z.string().trim().min(1).max(2048).describe('the keyword (at most 10 words, 80 characters), the web address, the package name or the id'),
})
const membersArg = z.array(memberArg).max(250)

const customAudienceRequest = (args: Record<string, unknown>): CustomAudienceRequest => ({
  create: args.create as CustomAudienceRequest['create'],
  change: args.change as CustomAudienceRequest['change'],
  remove: args.remove as string[] | undefined,
})

/** The uses an audience change stands on (only when it changes or removes one). */
async function usesFor(account: GoogleChangeAccount, needed: boolean) {
  if (!needed) return { uses: [], audiences: [] }
  return { uses: await liveAudienceUses(account.target), audiences: await liveReusableAudiences(account.target) }
}

const buildCustomAudiences = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const unasked = removalUnasked(args)
  if (unasked) return unasked
  const request = customAudienceRequest(args)
  const customAudiences = await liveCustomAudiences(account.target)
  const ctx = await usesFor(account, !!(request.change?.length || request.remove?.length))
  return customAudienceDraft(customerResource(account.target), request, { customAudiences, ...ctx })
}

/** CustomAudienceService: its own validate_only (the check) and its own call (account-client.ts). */
const customAudienceSender: GoogleSender = { check: checkAccountOperations, send: sendAccountOperations }

const customAudiencesUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as CustomAudienceRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const byId = new Map((await liveCustomAudiences(account.target)).map((a) => [a.customAudienceId, a]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      audiences: (after.audiences ?? []).map((a) => {
        const now = byId.get(a.customAudienceId)
        return {
          customAudienceId: a.customAudienceId,
          ...('name' in a ? { name: now?.name ?? null } : {}),
          ...('description' in a ? { description: now?.description ?? '' } : {}),
          ...('type' in a ? { type: now?.type ?? null } : {}),
          ...('members' in a ? { members: membersOf(now?.members ?? []) } : {}),
        }
      }),
      created: (after.created ?? []).filter((c) => byId.has(c.customAudienceId)),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<CustomAudienceRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<CustomAudienceRecord> & { accountId?: string }
    const lost: string[] = []
    const back = (before.audiences ?? []).map((a) => {
      const type = a.type && (CUSTOM_AUDIENCE_TYPES as readonly string[]).includes(a.type) ? a.type : undefined
      if ('type' in a && !type) lost.push(`its old type ${a.type ?? '(none)'} cannot be set again`)
      return {
        customAudienceId: a.customAudienceId,
        ...(typeof a.name === 'string' && a.name ? { name: a.name } : {}),
        ...('description' in a ? { description: a.description ?? '' } : {}),
        ...(type ? { type } : {}),
        ...(a.members?.length ? { members: a.members } : {}),
      }
    }).filter((a) => Object.keys(a).length > 1)
    const remove = madeIds((after.created ?? []).map((c) => c.customAudienceId))
    if (!remove) return { refusal: 'This change does not record the id of a custom segment it made.' }
    if (!back.length && !remove.length) return { refusal: 'A removed custom segment cannot be put back.' }
    const accountId = after.accountId ?? before.accountId
    const notes = [...lost, ...((after.removed ?? []).length ? ['the segments it removed cannot be made again'] : [])]
    return {
      tool: 'set-google-custom-audiences',
      args: {
        ...(accountId ? { accountId } : {}),
        ...(back.length ? { change: back } : {}),
        ...(remove.length ? { remove, confirmRemove: true } : {}),
        why: `undo of an earlier custom segment change${notes.length ? ` (${notes.join('; ')})` : ''}`,
      },
    }
  },
}

const setGoogleCustomAudiences: AgentTool = {
  ...common,
  name: 'set-google-custom-audiences',
  title: 'Change Google Ads custom segments',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    create: z.array(z.object({
      name: nameArg(1000).describe('its name (unique in the account, ignoring case)'),
      description: descriptionArg,
      type: z.enum(CUSTOM_AUDIENCE_TYPES).optional().describe('AUTO (Google picks how to match; default) or SEARCH (people by what they searched on Google)'),
      members: membersArg.min(1).describe('who it is: keywords, web addresses, apps'),
    })).max(20).optional().describe('new custom segments'),
    change: z.array(z.object({
      customAudienceId: googleIdArg('the custom segment (google-ads-live view lookup, lookup custom-audiences)'),
      name: nameArg(1000).optional().describe('a new name'),
      description: descriptionArg,
      type: z.enum(CUSTOM_AUDIENCE_TYPES).optional().describe('AUTO or SEARCH (Google may refuse a type change)'),
      members: membersArg.optional().describe('its FULL new member list; or use addMembers / removeMembers'),
      addMembers: membersArg.optional().describe('members to add'),
      removeMembers: membersArg.optional().describe('members to take out'),
    })).max(50).optional().describe('existing custom segments'),
    remove: removeArg('a custom segment'),
    confirmRemove: confirmRemoveArg,
    why: googleWhyArg,
  }),
  description:
    'Custom segments (custom audiences) of the business\'s chosen Google Ads account: people by the keywords they search '
    + 'or are into, the sites they visit and the apps they use. Make them (create), change their name, description, type '
    + 'or members (change), or REMOVE them (remove, with confirmRemove true, only when the person asked; Google refuses '
    + 'one a campaign still uses, and a removal cannot be undone). A segment spends nothing by itself: new members, or '
    + 'another type, for a segment a serving campaign uses is marked SPENDS MONEY, naming the campaigns. Targeting with '
    + 'one is set-google-audiences (Search, Shopping), a Demand Gen or Display ad group, or a reusable audience. They go to '
    + 'Google\'s CustomAudienceService (its own validate_only). Undo puts names, types and members back and removes the '
    + 'segments it made.' + GOOGLE_CHANGE_RULES,
  undo: customAudiencesUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildCustomAudiences(args), customAudienceSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildCustomAudiences(args), (draft, responses) => {
    const after = customAudienceRecordAfterRun(draft.after as CustomAudienceRecord, responses)
    return { data: { created: after.created, changed: after.audiences.length, removed: after.removed.length }, before: draft.before, after }
  }, customAudienceSender),
}

// ── set-google-user-lists ───────────────────────────────────────────────────────────────────────────────────────

const OPERATORS = [...new Set<string>([...STRING_OPERATORS, ...NUMBER_OPERATORS, ...DATE_OPERATORS])] as [string, ...string[]]
const ruleItemArg = z.object({
  parameter: z.string().trim().min(1).max(100).optional().describe('the tag parameter: url__ (the page\'s address; default), ref_url__ (the page they came from) or a custom parameter of the shop\'s tag'),
  operator: z.enum(OPERATORS).describe(`text: ${STRING_OPERATORS.join(', ')}; number: ${NUMBER_OPERATORS.join(', ')}; date: ${DATE_OPERATORS.join(', ')}`),
  text: z.string().max(1024).optional().describe('compare with this text (an address part such as /products/ or example.com/checkout)'),
  number: z.number().optional().describe('or: compare with this number'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('or: compare with this date (YYYY-MM-DD, the account\'s time zone)'),
  offsetDays: z.number().int().min(-MEMBERSHIP_MAX_DAYS).max(MEMBERSHIP_MAX_DAYS).optional().describe('or: compare with the date this many days from today'),
})
const operandArg = z.object({
  anyOf: z.array(z.object({ allOf: z.array(ruleItemArg).min(1).max(10).describe('conditions that must ALL hold') })).min(1).max(10)
    .describe('groups of conditions; a person matches when ANY group holds'),
  lookbackDays: z.number().int().min(1).max(MEMBERSHIP_MAX_DAYS).optional().describe(`over the last N days (1 to ${MEMBERSHIP_MAX_DAYS})`),
})
const visitorsArg = z.object({
  operator: z.enum(['AND', 'OR']).optional().describe('how the include rules join: AND (all; default) or OR (any)'),
  include: z.array(operandArg).min(1).max(10).describe('who is IN: visitors matching these rules'),
  exclude: z.array(operandArg).max(10).optional().describe('who is left OUT (any of these)'),
}).describe('website visitors by the pages they saw (the Google tag must be on the shop)')
const combinationArg = z.array(z.object({
  operator: z.enum(LOGICAL_OPERATORS).describe('ALL (in every list), ANY (in at least one) or NONE (in none)'),
  userListIds: z.array(googleIdArg('a user list')).min(1).max(50).describe('the lists (google-ads-live view lookup, lookup user-lists)'),
})).min(1).max(10).describe('rules that must ALL hold, each over other lists')

const userListRequest = (args: Record<string, unknown>): UserListRequest => ({
  create: args.create as UserListRequest['create'],
  change: args.change as UserListRequest['change'],
  remove: args.remove as string[] | undefined,
})

const buildUserLists = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const unasked = removalUnasked(args)
  if (unasked) return unasked
  const request = userListRequest(args)
  const lists = await liveUserLists(account.target)
  const needsActions = (request.create ?? []).some((c) => c.converters) || (request.change ?? []).some((c) => c.conversionActionIds !== undefined)
  const actions = needsActions ? await liveConversionActions(account.target) : []
  const ctx = await usesFor(account, !!(request.change?.length || request.remove?.length))
  return userListDraft(customerResource(account.target), request, { lists, actions, ...ctx })
}

/** Visitor rules as the request takes them (what undo sends back). */
const visitorsAsk = (v: VisitorRules) => {
  const operand = (o: RuleOperand) => ({ anyOf: o.anyOf.map((g) => ({ allOf: g.allOf.map((i) => ({ ...i })) })), ...(o.lookbackDays !== null ? { lookbackDays: o.lookbackDays } : {}) })
  return { operator: v.operator, include: v.include.map(operand), ...(v.exclude.length ? { exclude: v.exclude.map(operand) } : {}) }
}

const userListsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as UserListRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const byId = new Map((await liveUserLists(account.target)).map((l) => [l.userListId, l]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      lists: (after.lists ?? []).map((l) => {
        const now = byId.get(l.userListId)
        const out: UserListFields = { userListId: l.userListId }
        if ('name' in l) out.name = now?.name ?? null
        if ('description' in l) out.description = now?.description ?? ''
        if ('membershipStatus' in l) out.membershipStatus = now?.membershipStatus ?? null
        if ('membershipDays' in l) out.membershipDays = now?.membershipDays ?? null
        if ('eligibleForSearch' in l) out.eligibleForSearch = now?.eligibleForSearch ?? null
        // Rules compare in Google's own form: the recorded rules stand when Google holds the same.
        if ('visitors' in l) out.visitors = now && visitorsKey(now.visitors) === visitorsKey(l.visitors ?? null) ? l.visitors : now?.visitors ?? null
        if ('combination' in l) {
          const same = JSON.stringify((now?.combination ?? []).map((r) => [r.operator, [...r.userListIds].sort()])) === JSON.stringify((l.combination ?? []).map((r) => [r.operator, [...r.userListIds].sort()]))
          out.combination = same ? l.combination : (now?.combination as CombinationRule[] | null) ?? null
        }
        if ('conversionActionIds' in l) out.conversionActionIds = now?.actions?.conversionActionIds ?? null
        return out
      }),
      created: (after.created ?? []).filter((c) => byId.has(c.userListId)),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<UserListRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<UserListRecord> & { accountId?: string }
    const back = (before.lists ?? []).map((l) => ({
      userListId: l.userListId,
      ...(typeof l.name === 'string' && l.name ? { name: l.name } : {}),
      ...('description' in l ? { description: l.description ?? '' } : {}),
      ...(l.membershipStatus === 'OPEN' || l.membershipStatus === 'CLOSED' ? { membershipStatus: l.membershipStatus } : {}),
      ...(typeof l.membershipDays === 'number' ? { membershipDays: l.membershipDays } : {}),
      ...(typeof l.eligibleForSearch === 'boolean' ? { eligibleForSearch: l.eligibleForSearch } : {}),
      ...(l.visitors ? { visitors: visitorsAsk(l.visitors) } : {}),
      ...(l.combination?.length ? { combination: l.combination } : {}),
      ...(l.conversionActionIds?.length ? { conversionActionIds: l.conversionActionIds } : {}),
    })).filter((l) => Object.keys(l).length > 1)
    const remove = madeIds((after.created ?? []).map((c) => c.userListId))
    if (!remove) return { refusal: 'This change does not record the id of a user list it made.' }
    if (!back.length && !remove.length) return { refusal: 'A removed user list and the people in it cannot be put back.' }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-user-lists',
      args: {
        ...(accountId ? { accountId } : {}),
        ...(back.length ? { change: back } : {}),
        ...(remove.length ? { remove, confirmRemove: true } : {}),
        why: `undo of an earlier user list change${(after.removed ?? []).length ? ' (the lists it removed cannot be made again)' : ''}`,
      },
    }
  },
}

const setGoogleUserLists: AgentTool = {
  ...common,
  name: 'set-google-user-lists',
  title: 'Change Google Ads user lists',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    create: z.array(z.object({
      name: nameArg(1000).describe('its name (unique among the account\'s own lists)'),
      description: descriptionArg,
      visitors: visitorsArg.optional(),
      prepopulate: z.boolean().optional().describe('visitors only: also take in matching visitors of the last 30 days (Display only)'),
      combination: combinationArg.optional(),
      converters: z.object({
        conversionActionIds: z.array(googleIdArg('a conversion action')).min(1).max(50).describe('people who converted on these actions'),
        membershipDays: z.number().int().min(0).max(MEMBERSHIP_MAX_DAYS).optional().describe(`how long a person stays in it (0 to ${MEMBERSHIP_MAX_DAYS} days)`),
      }).optional().describe('people who converted'),
      lookalike: z.object({
        seedUserListIds: z.array(googleIdArg('a seed user list')).min(1).max(20).describe('the lists it looks like'),
        expansion: z.enum(LOOKALIKE_LEVELS).describe('NARROW, BALANCED or BROAD (how many similar people)'),
        countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).max(50).optional().describe('ISO 3166 country codes (IT)'),
      }).optional().describe('a lookalike segment (Demand Gen only)'),
    })).max(20).optional().describe('new lists, each exactly ONE of visitors, combination, converters or lookalike (no Customer Match list)'),
    change: z.array(z.object({
      userListId: googleIdArg('the user list (google-ads-live view lookup, lookup user-lists)'),
      name: nameArg(1000).optional().describe('a new name'),
      description: descriptionArg,
      membershipStatus: z.enum(['OPEN', 'CLOSED']).optional().describe('OPEN gathers people and can be targeted; CLOSED gathers nobody new'),
      membershipDays: z.number().int().min(0).max(MEMBERSHIP_MAX_DAYS).optional().describe('how long a person stays (not for rule-based or combination lists)'),
      eligibleForSearch: z.boolean().optional().describe('whether it can serve on Google Search'),
      visitors: visitorsArg.optional(),
      combination: combinationArg.optional(),
      conversionActionIds: z.array(googleIdArg('a conversion action')).min(1).max(50).optional().describe('a converters list: its FULL new list of conversion actions'),
    })).max(50).optional().describe('the account\'s own lists (a shared or Google list is refused)'),
    remove: removeArg('a user list'),
    confirmRemove: confirmRemoveArg,
    why: googleWhyArg,
  }),
  description:
    'User lists (your data segments) of the business\'s chosen Google Ads account. Make them (create, each ONE of: '
    + 'visitors — website visitors by the pages they saw or did not see, with rules on the page address, the referrer or '
    + 'the tag\'s own parameters and lookback windows; combination — ALL / ANY / NONE of other lists; converters — people '
    + 'who converted on chosen conversion actions; lookalike — similar people, for Demand Gen), change the account\'s own '
    + 'lists (name, description, open or closed, life span, Search, rules, actions), or REMOVE them (remove, with '
    + 'confirmRemove true, only when the person asked; a removal cannot be undone). Customer Match lists are never made or '
    + 'filled here: they hold uploaded personal data. A list spends nothing by itself: a change that lets one hold more '
    + 'people where a serving campaign targets it — or fewer where one excludes it — is marked SPENDS MONEY, naming the '
    + 'campaigns. Targeting with one is set-google-audiences or a reusable audience. Undo puts settings and rules back and '
    + 'removes the lists it made.' + GOOGLE_CHANGE_RULES,
  undo: userListsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildUserLists(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildUserLists(args), (draft, responses) => {
    const after = userListRecordAfterRun(draft.after as UserListRecord, responses)
    return { data: { created: after.created, changed: after.lists.length, removed: after.removed.length }, before: draft.before, after }
  }),
}

// ── set-google-reusable-audiences ───────────────────────────────────────────────────────────────────────────────

const demographicArg = <T extends readonly [string, ...string[]]>(values: T, what: string) => z.object({
  values: z.array(z.enum(values)).max(values.length).describe(`${what}: ${values.join(', ')}`),
  includeUndetermined: z.boolean().optional().describe('also people Google cannot tell'),
}).nullable().optional().describe(`the ${what} dimension; null takes it out`)
const definitionArgs = {
  segments: z.array(z.object({
    kind: z.enum(SEGMENT_KINDS).describe('USER_LIST, USER_INTEREST (affinity, in-market), CUSTOM_AUDIENCE, LIFE_EVENT or DETAILED_DEMOGRAPHIC'),
    id: googleIdArg('the segment (google-ads-live view lookup)'),
  })).max(100).optional().describe('segments: a person in ANY of them is in (the full list; [] takes them out)'),
  ages: z.object({
    ranges: z.array(z.object({
      min: z.number().int().describe(`from: ${AGE_MINS.join(', ')}`),
      max: z.number().int().nullable().optional().describe(`to: ${AGE_MAXES.join(', ')} (none: no upper end)`),
    })).max(6).describe('age ranges'),
    includeUndetermined: z.boolean().optional().describe('also people whose age Google cannot tell'),
  }).nullable().optional().describe('the age dimension; null takes it out'),
  genders: demographicArg(GENDERS, 'gender'),
  incomes: demographicArg(INCOMES, 'household income'),
  parental: demographicArg(PARENTAL, 'parental status'),
  excludeUserLists: z.array(googleIdArg('a user list')).max(50).optional().describe('user lists left OUT (the full list; [] takes them all off)'),
}

const reusableRequest = (args: Record<string, unknown>): ReusableAudienceRequest => ({
  create: args.create as ReusableAudienceRequest['create'],
  change: args.change as ReusableAudienceRequest['change'],
})

const buildReusable = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = reusableRequest(args)
  const audiences = await liveReusableAudiences(account.target)
  const asks = [...(request.create ?? []), ...(request.change ?? [])]
  const refs: SegmentRef[] = [
    ...asks.flatMap((a) => a.segments ?? []),
    ...asks.flatMap((a) => (a.excludeUserLists ?? []).map((id) => ({ kind: 'USER_LIST' as const, id }))),
  ]
  const named = refs.filter((r) => r.kind !== 'DETAILED_DEMOGRAPHIC') as Array<{ kind: AudienceKind; id: string }>
  const segmentNames: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(named.length ? await liveSegmentNames(account.target, named) : {})) segmentNames[key] = value.name
  const demographics = refs.filter((r) => r.kind === 'DETAILED_DEMOGRAPHIC').map((r) => r.id)
  for (const [id, name] of Object.entries(await liveDetailedDemographicNames(account.target, demographics))) segmentNames[segmentKey({ kind: 'DETAILED_DEMOGRAPHIC', id })] = name
  const uses = request.change?.length ? await liveAudienceUses(account.target) : []
  return reusableAudienceDraft(customerResource(account.target), request, { audiences, uses, segmentNames })
}

/** A definition as the request takes it (what undo sends back): every part, null for a part that was not there. */
const definitionAsk = (d: AudienceDefinition) => ({
  segments: d.segments,
  ages: d.ages ? { ranges: d.ages.ranges.map((r) => ({ min: r.min, max: r.max })), includeUndetermined: d.ages.includeUndetermined } : null,
  genders: d.genders ? { values: d.genders.values, includeUndetermined: d.genders.includeUndetermined } : null,
  incomes: d.incomes ? { values: d.incomes.values, includeUndetermined: d.incomes.includeUndetermined } : null,
  parental: d.parental ? { values: d.parental.values, includeUndetermined: d.parental.includeUndetermined } : null,
  excludeUserLists: d.excludeUserLists,
})

const reusableUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as ReusableAudienceRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const byId = new Map((await liveReusableAudiences(account.target)).map((a) => [a.audienceId, a]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      audiences: (after.audiences ?? []).map((a) => {
        const now = byId.get(a.audienceId)
        return {
          audienceId: a.audienceId,
          ...('name' in a ? { name: now?.name ?? null } : {}),
          ...('description' in a ? { description: now?.description ?? '' } : {}),
          // Compared in one canonical form: the recorded definition stands when Google holds the same.
          ...('definition' in a ? { definition: now && a.definition && definitionKey(now.definition) === definitionKey(a.definition) ? a.definition : now?.definition ?? null } : {}),
        }
      }),
      created: (after.created ?? []).filter((c) => byId.has(c.audienceId)),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<ReusableAudienceRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<ReusableAudienceRecord> & { accountId?: string }
    const back = (before.audiences ?? []).map((a) => ({
      audienceId: a.audienceId,
      ...(typeof a.name === 'string' && a.name ? { name: a.name } : {}),
      ...('description' in a ? { description: a.description ?? '' } : {}),
      ...(a.definition ? definitionAsk(a.definition) : {}),
    })).filter((a) => Object.keys(a).length > 1)
    if (!back.length) {
      return { refusal: (after.created ?? []).length
        ? 'Google has no way to remove an audience: the audiences this change made stay (they reach nobody until a campaign uses them).'
        : 'This change records no setting it replaced.' }
    }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-reusable-audiences',
      args: {
        ...(accountId ? { accountId } : {}),
        change: back,
        why: `undo of an earlier audience change${(after.created ?? []).length ? ' (the audiences it made stay: Google cannot remove an audience)' : ''}`,
      },
    }
  },
}

const setGoogleReusableAudiences: AgentTool = {
  ...common,
  name: 'set-google-reusable-audiences',
  title: 'Change Google Ads reusable audiences',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    create: z.array(z.object({
      name: nameArg(AUDIENCE_NAME_MAX).describe(`its name (1 to ${AUDIENCE_NAME_MAX} characters, unique among the account's audiences)`),
      description: descriptionArg,
      ...definitionArgs,
    })).max(20).optional().describe('new audiences: segments and / or demographics (at least one), user lists left out'),
    change: z.array(z.object({
      audienceId: googleIdArg('the audience'),
      name: nameArg(AUDIENCE_NAME_MAX).optional().describe('a new name (not for an audience of one asset group)'),
      description: descriptionArg,
      ...definitionArgs,
    })).max(50).optional().describe('existing audiences: each part given replaces that part; a part left out stays'),
    why: googleWhyArg,
  }),
  description:
    'Reusable audiences (Google\'s Audience) of the business\'s chosen Google Ads account: segments (your data, interests, '
    + 'custom segments, life events, detailed demographics: anyone in one of them) layered with age, gender, household '
    + 'income and parental status, minus user lists left out. Demand Gen ad groups target them and Performance Max asset '
    + 'groups take them as signals (set-google-campaign-type, set-google-pmax). Make them (create) or change them (change: '
    + 'name, description, any part). Google has NO way to remove an audience: a new one stays (it reaches nobody until '
    + 'used). An audience spends nothing by itself: a change that lets one hold more people (a segment added, a '
    + 'demographic widened or taken out, a list no longer left out) where a serving campaign uses it is marked SPENDS '
    + 'MONEY, naming the campaigns. google-ads-query "SELECT audience.id, audience.name, audience.dimensions FROM audience '
    + 'WHERE audience.status = \'ENABLED\'" lists them. Undo puts a changed audience back.' + GOOGLE_CHANGE_RULES,
  undo: reusableUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildReusable(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildReusable(args), (draft, responses) => {
    const after = reusableAudienceRecordAfterRun(draft.after as ReusableAudienceRecord, responses)
    return { data: { created: after.created, changed: after.audiences.length }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_GOALS_AUDIENCES_TOOLS: AgentTool[] = [setGoogleCustomGoals, setGoogleCustomAudiences, setGoogleUserLists, setGoogleReusableAudiences]
