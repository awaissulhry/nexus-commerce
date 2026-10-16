/**
 * Google Ads programme 2, G14a (2026-10-16) — custom conversion goals: pure builders (request + live state →
 * GoogleChangeDraft, or a refusal). No call here. Which campaign USES a custom goal is set-google-conversion-goals
 * (`customGoals`, change-conversions.ts), with `customGoalActions` below.
 *
 * Google's rules, checked 2026-10-16 with curl in the v25 reference (reference/rpc/v25/CustomConversionGoal,
 * CustomConversionGoalOperation, CustomConversionGoalStatusEnum, ConversionGoalCampaignConfig, MutateOperation,
 * MutateOperationResponse; the googleapis v25 protos resources/custom_conversion_goal.proto) and the guide
 * docs/conversions/goals/campaign-goals ("Custom goals"):
 *   - CustomConversionGoal: name, conversion_actions[] (resource names), status (ENABLED | REMOVED); id and resource_name
 *     Immutable. customConversionGoalOperation in GoogleAdsService.Mutate: create, update (+ update_mask), remove
 *     (customers/{c}/customConversionGoals/{id}); the result is custom_conversion_goal_result. A repeated field in the
 *     update mask is written whole: conversion_actions is the goal's full list.
 *   - Status has no PAUSED: REMOVED is the remove, so there is no status change of its own.
 *   - "You must create the CustomConversionGoal in the Google Ads conversion customer" (cross-account conversion
 *     tracking: the conversion account's id is customer.conversion_tracking_setting.conversion_tracking_id).
 *   - "When a ConversionAction is included in a CustomConversionGoal, the custom goal will optimize for that conversion
 *     action regardless of whether the action's primary_for_goal setting is true or false."
 *   - A campaign uses a custom goal through ConversionGoalCampaignConfig.custom_conversion_goal (update mask
 *     custom_conversion_goal; "the backend automatically updates goal_config_level to CAMPAIGN"); it then bids for the
 *     custom goal's actions AND its biddable campaign goals.
 *   The reference gives no length limit for a name and no cap on the actions: Google's check (validate_only) judges.
 *
 * Money: a custom goal that counts more conversion actions makes the Smart Bidding campaigns that use it chase more:
 * SPENDS MONEY, naming them (or saying none is enabled with Smart Bidding, so nothing spends more yet). A new goal is used
 * by no campaign (nothing spends). Fewer actions, or a removal, is a warning.
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { chaseSentence } from './change-conversions.js'
import type { LiveConversionAction, LiveConversions } from './live-account.js'
import { CONVERSION_BIDDING, type SmartBiddingCampaign } from './live-conversions.js'
import type { LiveCustomGoal } from './live-goals-audiences.js'
import type { GoogleMutateOperation } from './write-client.js'

export const NEW_GOAL = (n: number) => `new-goal-${n}`

export interface CustomGoalRequest {
  create?: Array<{ name: string; conversionActionIds: string[] }>
  /** The goal's new name and / or its FULL list of conversion actions. */
  change?: Array<{ customGoalId: string; name?: string; conversionActionIds?: string[] }>
  /** Custom goals removed for good (only on the person's ask: the tool holds confirmRemove). */
  remove?: string[]
}

export interface CustomGoalFields { customGoalId: string; name?: string | null; conversionActionIds?: string[] }
export interface CustomGoalRecord {
  /** Changed goals: the values replaced (before) or written (after). */
  goals: CustomGoalFields[]
  created: Array<{ customGoalId: string; name: string; conversionActionIds: string[] }>
  removed: Array<{ customGoalId: string; name: string | null; conversionActionIds: string[] }>
}

export interface CustomGoalLive {
  customerId: string
  /** The account that tracks this account's conversions (null: this account itself). */
  conversionCustomerId: string | null
  goals: LiveCustomGoal[]
  actions: LiveConversionAction[]
  /** Each campaign's goal settings (which custom goal it uses). */
  campaignGoals: LiveConversions['campaigns']
  campaigns: SmartBiddingCampaign[]
}

const uniq = (ids: string[]) => [...new Set(ids.map((id) => id.trim()))].sort()
const actionNames = (ids: string[], actions: LiveConversionAction[]) =>
  ids.slice(0, 5).map((id) => `"${actions.find((a) => a.conversionActionId === id)?.name ?? id}"`).join(', ') + (ids.length > 5 ? ` and ${ids.length - 5} more` : '')

/** The campaigns that use a custom goal (any status), and those of them that bid with Smart Bidding and are enabled. */
export function goalUsers(live: Pick<CustomGoalLive, 'campaignGoals' | 'campaigns'>, customGoalId: string): { users: SmartBiddingCampaign[]; chasers: SmartBiddingCampaign[] } {
  const ids = new Set(live.campaignGoals.filter((c) => c.customGoalId === customGoalId && c.goalsFrom === 'CAMPAIGN').map((c) => c.campaignId))
  const users = live.campaigns.filter((c) => ids.has(c.campaignId))
  return { users, chasers: users.filter((c) => c.status === 'ENABLED' && !!c.bidding && CONVERSION_BIDDING.has(c.bidding)) }
}

function actionsProblem(ids: string[], live: CustomGoalLive, what: string): string | null {
  if (!ids.length) return `${what}: name at least one conversion action (google-ads-live view conversions lists them).`
  const known = new Set(live.actions.map((a) => a.conversionActionId))
  const missing = ids.filter((id) => !known.has(id))
  return missing.length ? `${what}: conversion action ${missing.join(', ')} is not in the account (or is removed).` : null
}

export function customGoalDraft(customer: string, request: CustomGoalRequest, live: CustomGoalLive): GoogleChangeDraft | { refusal: string } {
  const creates = request.create ?? []
  const changes = request.change ?? []
  const removes = uniq(request.remove ?? [])
  if (!creates.length && !changes.length && !removes.length) return { refusal: 'Say what to change: create, change or remove.' }
  if (live.conversionCustomerId && live.conversionCustomerId !== live.customerId) {
    return { refusal: `This account's conversions are tracked in account ${live.conversionCustomerId} (cross-account conversion tracking): Google makes custom goals only there ("You must create the CustomConversionGoal in the Google Ads conversion customer"). Change them in that account.` }
  }
  const byId = new Map(live.goals.map((g) => [g.customGoalId, g]))
  const createOps: GoogleMutateOperation[] = []
  const updateOps: GoogleMutateOperation[] = []
  const removeOps: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: CustomGoalRecord = { goals: [], created: [], removed: [] }
  const after: CustomGoalRecord = { goals: [], created: [], removed: [] }
  const names = new Set<string>()

  for (const [i, c] of creates.entries()) {
    const name = c.name.trim()
    const what = `New custom goal "${name}"`
    if (!name) return { refusal: 'A custom goal has a name.' }
    if (names.has(name.toLowerCase())) return { refusal: `${what} is named twice.` }
    names.add(name.toLowerCase())
    const ids = uniq(c.conversionActionIds)
    const problem = actionsProblem(ids, live, what)
    if (problem) return { refusal: problem }
    if (live.goals.some((g) => (g.name ?? '').trim().toLowerCase() === name.toLowerCase())) warnings.push(`A custom goal called "${name}" exists already: the new one is another goal with the same name.`)
    createOps.push({ customConversionGoalOperation: { create: { name, conversionActions: ids.map((id) => `${customer}/conversionActions/${id}`), status: 'ENABLED' } } })
    after.created.push({ customGoalId: NEW_GOAL(i + 1), name, conversionActionIds: ids })
    lines.push([`new custom goal: ${name}`, null, `${plural(ids.length, 'conversion action')}: ${actionNames(ids, live.actions)}`])
  }
  if (creates.length) warnings.push('A new custom goal changes no bidding until a campaign uses it (set-google-conversion-goals, customGoals: SPENDS MONEY when it makes Smart Bidding chase more).')

  const seen = new Set<string>()
  for (const ch of changes) {
    const g = byId.get(ch.customGoalId)
    if (!g) return { refusal: `Custom goal ${ch.customGoalId} is not in the account (or is removed). google-ads-query "SELECT custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.conversion_actions FROM custom_conversion_goal" lists them.` }
    if (seen.has(g.customGoalId) || removes.includes(g.customGoalId)) return { refusal: `Custom goal ${g.customGoalId} is named twice (change and remove are one or the other).` }
    seen.add(g.customGoalId)
    const what = `Custom goal "${g.name ?? g.customGoalId}"`
    const was: CustomGoalFields = { customGoalId: g.customGoalId }
    const now: CustomGoalFields = { customGoalId: g.customGoalId }
    const body: Record<string, unknown> = { resourceName: `${customer}/customConversionGoals/${g.customGoalId}` }
    const mask: string[] = []
    if (ch.name !== undefined) {
      const name = ch.name.trim()
      if (!name) return { refusal: `${what}: a name cannot be empty.` }
      if (name === g.name) skipped.push(`${what}: the name is already "${name}".`)
      else {
        was.name = g.name
        now.name = name
        body.name = name
        mask.push('name')
        lines.push([`${g.name}: name`, g.name, name])
      }
    }
    if (ch.conversionActionIds !== undefined) {
      const ids = uniq(ch.conversionActionIds)
      const problem = actionsProblem(ids, live, what)
      if (problem) return { refusal: problem }
      if (ids.join(',') === g.conversionActionIds.join(',')) skipped.push(`${what}: it already counts exactly these conversion actions.`)
      else {
        was.conversionActionIds = g.conversionActionIds
        now.conversionActionIds = ids
        body.conversionActions = ids.map((id) => `${customer}/conversionActions/${id}`)
        mask.push('conversion_actions')
        const added = ids.filter((id) => !g.conversionActionIds.includes(id))
        const dropped = g.conversionActionIds.filter((id) => !ids.includes(id))
        lines.push([`${g.name}: conversion actions`, `${g.conversionActionIds.length}`, `${ids.length}${added.length ? ` (+ ${actionNames(added, live.actions)})` : ''}${dropped.length ? ` (− ${actionNames(dropped, live.actions)})` : ''}`])
        const { users, chasers } = goalUsers(live, g.customGoalId)
        if (added.length && users.length) spends.push(chaseSentence(`${what} counts ${plural(added.length, 'more conversion action')} (${actionNames(added, live.actions)}) for the campaigns that use it`, chasers))
        if (dropped.length && users.length) warnings.push(`${what} stops counting ${actionNames(dropped, live.actions)}: the ${plural(users.length, 'campaign')} that use it stop bidding for them.`)
      }
    }
    if (!mask.length) continue
    updateOps.push({ customConversionGoalOperation: { update: body, updateMask: mask.join(',') } })
    before.goals.push(was)
    after.goals.push(now)
  }

  for (const id of removes) {
    const g = byId.get(id)
    if (!g) return { refusal: `Custom goal ${id} is not in the account (or is already removed).` }
    removeOps.push({ customConversionGoalOperation: { remove: `${customer}/customConversionGoals/${id}` } })
    lines.push([`custom goal ${g.name ?? id}`, `${plural(g.conversionActionIds.length, 'conversion action')}`, 'REMOVED'])
    const removed = { customGoalId: id, name: g.name, conversionActionIds: g.conversionActionIds }
    before.removed.push(removed)
    after.removed.push(removed)
    const { users } = goalUsers(live, id)
    if (users.length) warnings.push(`Custom goal "${g.name ?? id}" is used by ${plural(users.length, 'campaign')} (${users.slice(0, 5).map((c) => `"${c.name}"`).join(', ')}): they stop bidding for its conversion actions (Google may refuse while a campaign uses it).`)
  }
  if (removes.length) warnings.push('A removed custom goal cannot be restored (a new goal with the same actions is another goal); undo does not make it again.')

  const operations = [...createOps, ...updateOps, ...removeOps]
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'every goal is already so.'}` }
  const { changes: table, more } = changeLines(lines)
  const parts = [
    after.created.length ? `make ${plural(after.created.length, 'custom goal')}` : '',
    after.goals.length ? `change ${plural(after.goals.length, 'custom goal')}` : '',
    after.removed.length ? `remove ${plural(after.removed.length, 'custom goal')} for good` : '',
  ].filter(Boolean)
  return {
    summary: `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.`,
    changes: table,
    totals: { created: after.created.length, changed: after.goals.length, removed: after.removed.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      goals: live.goals.filter((g) => seen.has(g.customGoalId) || removes.includes(g.customGoalId)).map((g) => `${g.customGoalId}:${g.name}:${g.conversionActionIds.join(',')}`).sort(),
      actions: [...new Set([...creates.flatMap((c) => c.conversionActionIds), ...changes.flatMap((c) => c.conversionActionIds ?? [])])].sort()
        .map((id) => `${id}:${live.actions.some((a) => a.conversionActionId === id)}`),
      users: [...seen, ...removes].sort().map((id) => `${id}:${goalUsers(live, id).users.map((c) => `${c.campaignId}/${c.status}/${c.bidding}`).join(',')}`),
    },
    before,
    after,
  }
}

/** After the run: the ids Google gave the goals it made (custom_conversion_goal_result, in create order — creates go first). */
export function customGoalRecordAfterRun(after: CustomGoalRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): CustomGoalRecord {
  const made = responses.map((r) => r.customConversionGoalResult?.resourceName)
  const out = structuredClone(after)
  out.created = out.created.map((c, i) => {
    const name = made[i]
    return name ? { ...c, customGoalId: name.slice(name.lastIndexOf('/') + 1) } : c
  })
  return out
}
