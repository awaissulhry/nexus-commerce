/**
 * Google Ads changes, G7 (2026-10-15) — exclusions one by one: websites (placements), YouTube channels and videos, mobile
 * apps, app categories, content labels (sensitive content) and IP addresses, excluded for the whole account
 * (CustomerNegativeCriterion) or for one campaign (CampaignCriterion with negative = true). One atomic request; pure.
 *
 * Google's rules (v25 reference and guide targeting/criteria, checked 2026-10-15; live-exclusions.ts says where):
 *   - a CustomerNegativeCriterion is made (create, its info only) or removed (by resource name
 *     customers/{c}/customerNegativeCriteria/{id}); never updated. A campaign exclusion likewise: create with
 *     `negative: true`, remove by customers/{c}/campaignCriteria/{campaign}~{criterion};
 *   - at most 500 IP addresses per account and per campaign;
 *   - which campaign types take which exclusion is Google's to say: its check (validate_only) refuses a kind a campaign
 *     does not take, before anything is queued.
 * Money: an exclusion stops ads from showing there — adding one narrows (a warning). Removing one lets ads show there
 * again: SPENDS MONEY (with a note when no campaign it reaches is enabled).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveCampaign } from './live.js'
import {
  exclusionInfo, exclusionKey, exclusionWords, KIND_WORD, MAX_IP_BLOCKS, normalizeExclusion,
  type ExclusionItem, type ExclusionKind, type LiveAccountExclusions, type LiveCampaignExclusions, type LiveExclusion,
} from './live-exclusions.js'
import type { GoogleMutateOperation } from './write-client.js'

export interface ExclusionChangeRequest {
  add?: ExclusionItem[]
  remove?: ExclusionItem[]
}

/** What the change wrote (after) and what undo reads: the exclusions it added and removed (by value, not by id). */
export interface ExclusionChangeRecord {
  /** Only for a campaign's exclusions. */
  campaignId?: string
  added: ExclusionItem[]
  removed: ExclusionItem[]
}

const KIND_PLURAL: Record<ExclusionKind, string> = {
  placement: 'websites', 'youtube-channel': 'YouTube channels', 'youtube-video': 'YouTube videos', 'mobile-app': 'apps',
  'app-category': 'app categories', 'content-label': 'content labels', 'ip-block': 'IP addresses',
}

/** "2 websites, 1 content label". */
export function kindsInWords(items: ExclusionItem[]): string {
  const counts = new Map<ExclusionKind, number>()
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1)
  return [...counts].map(([k, n]) => plural(n, KIND_WORD[k], KIND_PLURAL[k])).join(', ')
}

/** At most 12 exclusions in words, the rest counted. */
export const someExclusions = (items: Array<ExclusionItem & { name?: string | null }>) =>
  items.slice(0, 12).map(exclusionWords).join(', ') + (items.length > 12 ? ` … (+${items.length - 12})` : '')

export const notEnabledNote = (statuses: Array<string | null>) =>
  (statuses.some((s) => s === 'ENABLED') ? '' : ' (no campaign it reaches is enabled now: nothing spends until one is)')

interface Scope {
  /** "the account" / `campaign "Shop A"` */
  where: string
  live: LiveExclusion[]
  create: (item: ExclusionItem) => GoogleMutateOperation
  remove: (criterionId: string) => GoogleMutateOperation
  /** The campaigns the exclusions reach (their statuses), for the SPENDS MONEY note. */
  reaches: Array<string | null>
  /** What a removed exclusion lets show again, in words ("every campaign of the account", `"Shop A"`). */
  whom: string
}

interface ItemsOutcome {
  operations: GoogleMutateOperation[]
  added: ExclusionItem[]
  removed: LiveExclusion[]
  skipped: string[]
}

/** The operations of a request on one scope's exclusions, or a refusal in words. */
function itemsChange(scope: Scope, request: ExclusionChangeRequest): ItemsOutcome | { refusal: string } {
  const add = request.add ?? []
  const remove = request.remove ?? []
  if (add.length + remove.length === 0) return { refusal: 'Say what to change: add or remove exclusions.' }
  const normalize = (list: ExclusionItem[]) => {
    const out: ExclusionItem[] = []
    for (const item of list) {
      const n = normalizeExclusion(item)
      if ('problem' in n) return { refusal: `Not queued: ${n.problem}.` }
      out.push(n)
    }
    return out
  }
  const adds = normalize(add)
  if ('refusal' in adds) return adds
  const removes = normalize(remove)
  if ('refusal' in removes) return removes
  const liveByKey = new Map(scope.live.map((e) => [exclusionKey(e), e]))
  const removeKeys = new Set(removes.map(exclusionKey))
  const out: ItemsOutcome = { operations: [], added: [], removed: [], skipped: [] }
  const seen = new Set<string>()
  for (const item of adds) {
    const key = exclusionKey(item)
    if (removeKeys.has(key)) return { refusal: `${exclusionWords(item)} is both added and removed.` }
    if (seen.has(key)) continue
    seen.add(key)
    if (liveByKey.has(key)) { out.skipped.push(`${exclusionWords(item)} is already excluded for ${scope.where}.`); continue }
    out.operations.push(scope.create(item))
    out.added.push(item)
  }
  const removedKeys = new Set<string>()
  for (const item of removes) {
    const key = exclusionKey(item)
    if (removedKeys.has(key)) continue
    removedKeys.add(key)
    const found = liveByKey.get(key)
    if (!found) { out.skipped.push(`${exclusionWords(item)} is not excluded for ${scope.where}.`); continue }
    out.operations.push(scope.remove(found.criterionId))
    out.removed.push(found)
  }
  const ips = scope.live.filter((e) => e.kind === 'ip-block').length + out.added.filter((e) => e.kind === 'ip-block').length - out.removed.filter((e) => e.kind === 'ip-block').length
  if (ips > MAX_IP_BLOCKS) return { refusal: `${scope.where} would exclude ${ips} IP addresses: Google allows ${MAX_IP_BLOCKS} (exclude a CIDR block, e.g. 192.0.2.0/24, instead of single addresses).` }
  if (!out.operations.length) return { refusal: `Nothing to change: ${out.skipped.join(' ')}` }
  return out
}

function draftOf(scope: Scope, outcome: ItemsOutcome, extra: { label: string; stands: Record<string, unknown>; campaignId?: string }): GoogleChangeDraft {
  const lines: Array<[string, unknown, unknown]> = [
    ...outcome.added.map((i): [string, unknown, unknown] => [exclusionWords(i), 'can show ads', 'excluded']),
    ...outcome.removed.map((i): [string, unknown, unknown] => [exclusionWords(i), 'excluded', 'can show ads']),
  ]
  const { changes, more } = changeLines(lines)
  const warnings: string[] = []
  const spends: string[] = []
  if (outcome.added.length) warnings.push(`Excludes ${kindsInWords(outcome.added)} for ${scope.where}: ${scope.whom} no longer shows ads there (fewer impressions there, and fewer sales from them).`)
  if (outcome.removed.length) spends.push(`Removes ${plural(outcome.removed.length, 'exclusion')} (${someExclusions(outcome.removed)}): ${scope.whom} can show ads there again${notEnabledNote(scope.reaches)}.`)
  const parts = [
    ...(outcome.added.length ? [`exclude ${kindsInWords(outcome.added)}`] : []),
    ...(outcome.removed.length ? [`remove ${plural(outcome.removed.length, 'exclusion')}`] : []),
  ]
  const record: ExclusionChangeRecord = {
    ...(extra.campaignId ? { campaignId: extra.campaignId } : {}),
    added: outcome.added,
    removed: outcome.removed.map(({ kind, value }) => ({ kind, value })),
  }
  return {
    summary: `Google Ads ${extra.label}: ${parts.join(', ')}.`,
    changes,
    totals: { operations: outcome.operations.length, excluded: outcome.added.length, removed: outcome.removed.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped: outcome.skipped,
    operations: outcome.operations,
    stands: { ...extra.stands, exclusions: scope.live.map((e) => `${exclusionKey(e)}#${e.criterionId}`).sort() },
    before: { ...(extra.campaignId ? { campaignId: extra.campaignId } : {}), removed: record.removed },
    after: record,
  }
}

// ── the account ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface AccountExclusionLiveState {
  account: LiveAccountExclusions
  campaigns: LiveCampaign[]
}

/** Exclusions for the whole account (every campaign): a draft, or a refusal in words. Pure. */
export function accountExclusionDraft(customer: string, request: ExclusionChangeRequest, live: AccountExclusionLiveState): GoogleChangeDraft | { refusal: string } {
  const scope: Scope = {
    where: 'the account',
    live: live.account.items,
    create: (item) => ({ customerNegativeCriterionOperation: { create: exclusionInfo(item) } }),
    remove: (id) => ({ customerNegativeCriterionOperation: { remove: `${customer}/customerNegativeCriteria/${id}` } }),
    reaches: live.campaigns.map((c) => c.status),
    whom: 'every campaign of the account',
  }
  const outcome = itemsChange(scope, request)
  if ('refusal' in outcome) return outcome
  // The SPENDS MONEY note stands on whether any campaign is enabled.
  return draftOf(scope, outcome, { label: 'account exclusions', stands: { level: 'account', enabled: live.campaigns.some((c) => c.status === 'ENABLED') } })
}

// ── one campaign ────────────────────────────────────────────────────────────────────────────────────────────────

export interface CampaignExclusionLiveState {
  campaign: LiveCampaign | null
  exclusions: LiveCampaignExclusions
}

/** Exclusions of one campaign: a draft, or a refusal in words. Pure. */
export function campaignExclusionDraft(customer: string, campaignId: string, request: ExclusionChangeRequest, live: CampaignExclusionLiveState): GoogleChangeDraft | { refusal: string } {
  const c = live.campaign
  if (!c) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed). google-ads-live view campaigns lists them.` }
  const scope: Scope = {
    where: `campaign "${c.name}"`,
    live: live.exclusions.items,
    create: (item) => ({ campaignCriterionOperation: { create: { campaign: `${customer}/campaigns/${campaignId}`, negative: true, ...exclusionInfo(item) } } }),
    remove: (id) => ({ campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${campaignId}~${id}` } }),
    reaches: [c.status],
    whom: `"${c.name}"`,
  }
  const outcome = itemsChange(scope, request)
  if ('refusal' in outcome) return outcome
  return draftOf(scope, outcome, { label: `exclusions of "${c.name}"`, campaignId, stands: { level: 'campaign', campaignId, status: c.status, type: c.type } })
}
