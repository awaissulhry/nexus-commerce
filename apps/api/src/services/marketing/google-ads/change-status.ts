/**
 * Google Ads changes, PR 2 (2026-10-15) — status and removal.
 *
 *   status   pause or enable campaigns, ad groups, keywords and ads (Google's `status` field, update mask `status`).
 *            Pausing is a safe step. Enabling is the person's decision and always SPENDS MONEY when what is enabled
 *            can serve (its campaign and ad group enabled too); enabling a Shopping campaign whose product groups leave
 *            "everything else" open, or a campaign with no targeted location, says so plainly.
 *   remove   delete campaigns, ad groups, keywords, ads, budgets and negative keyword lists — only when the person asked
 *            for that removal (the tool's `confirmRemove`), never undone (Google keeps a removed item as history only).
 *            A budget or a list still in use is refused.
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveBudget, LiveCampaign, LiveNegativeList } from './live.js'
import type { LiveStatusItem } from './live-campaigns.js'
import type { GoogleMutateOperation } from './write-client.js'

export type ItemKind = 'campaign' | 'ad-group' | 'keyword' | 'ad'
export type Status = 'PAUSED' | 'ENABLED'
export interface StatusRequest { items: Array<{ kind: ItemKind; id: string; status?: Status }>; status?: Status }
export interface StatusRecord { items: Array<{ kind: ItemKind; id: string; status: string | null }> }

const KIND_WORD: Record<ItemKind, string> = { campaign: 'campaign', 'ad-group': 'ad group', keyword: 'keyword', ad: 'ad' }

/** Google's resource name and MutateOperation kind for an item. */
export function itemResource(customer: string, kind: ItemKind | 'budget' | 'negative-list', id: string): { op: string; resource: string } {
  switch (kind) {
    case 'campaign': return { op: 'campaignOperation', resource: `${customer}/campaigns/${id}` }
    case 'ad-group': return { op: 'adGroupOperation', resource: `${customer}/adGroups/${id}` }
    case 'keyword': return { op: 'adGroupCriterionOperation', resource: `${customer}/adGroupCriteria/${id}` }
    case 'ad': return { op: 'adGroupAdOperation', resource: `${customer}/adGroupAds/${id}` }
    case 'budget': return { op: 'campaignBudgetOperation', resource: `${customer}/campaignBudgets/${id}` }
    case 'negative-list': return { op: 'sharedSetOperation', resource: `${customer}/sharedSets/${id}` }
  }
}

/** One item as it is now: a campaign from the campaign list, the rest from liveStatuses. */
function itemNow(kind: ItemKind, id: string, campaigns: LiveCampaign[], items: LiveStatusItem[]): LiveStatusItem | null {
  if (kind === 'campaign') {
    const c = campaigns.find((x) => x.campaignId === id)
    return c ? { kind, id, name: c.name, status: c.status, campaignId: c.campaignId, campaignName: c.name, campaignStatus: c.status, adGroupStatus: null } : null
  }
  return items.find((x) => x.kind === kind && x.id === id) ?? null
}

export interface EnableFacts {
  /** Shopping campaigns being enabled whose product groups leave "everything else" NOT excluded (count of such groups). */
  openEverythingElse: Record<string, number>
  /** Campaigns being enabled that target no location (they can show in every country). */
  noLocation: string[]
}

export function statusDraft(
  customer: string,
  request: StatusRequest,
  live: { campaigns: LiveCampaign[]; items: LiveStatusItem[]; facts: EnableFacts },
): GoogleChangeDraft | { refusal: string } {
  if (!request.items.length) return { refusal: 'Name at least one item.' }
  const ops: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: StatusRecord = { items: [] }
  const after: StatusRecord = { items: [] }
  const seen = new Set<string>()
  // Enabled by this same request: a campaign (or ad group) enabled with its children serves.
  const enabledHere = new Set(request.items.filter((i) => (i.status ?? request.status) === 'ENABLED').map((i) => `${i.kind}:${i.id}`))
  for (const item of request.items) {
    const key = `${item.kind}:${item.id}`
    if (seen.has(key)) return { refusal: `${KIND_WORD[item.kind]} ${item.id} is named twice.` }
    seen.add(key)
    const to = item.status ?? request.status
    if (!to) return { refusal: `Say the status for ${KIND_WORD[item.kind]} ${item.id} (status PAUSED or ENABLED).` }
    const now = itemNow(item.kind, item.id, live.campaigns, live.items)
    if (!now) return { refusal: `${KIND_WORD[item.kind]} ${item.id} is not in this account (or it is removed). google-ads-live shows the ids.` }
    if (now.status === 'REMOVED') return { refusal: `${KIND_WORD[item.kind]} "${now.name}" is removed: Google cannot pause or enable it.` }
    if (now.status === to) { skipped.push(`${KIND_WORD[item.kind]} "${now.name}" is already ${to.toLowerCase()}.`); continue }
    const { op, resource } = itemResource(customer, item.kind, item.id)
    ops.push({ [op]: { update: { resourceName: resource, status: to }, updateMask: 'status' } })
    lines.push([`${KIND_WORD[item.kind]} "${now.name}"${item.kind === 'campaign' ? '' : ` (${now.campaignName})`}`, now.status, to])
    before.items.push({ kind: item.kind, id: item.id, status: now.status })
    after.items.push({ kind: item.kind, id: item.id, status: to })
    if (to !== 'ENABLED') continue
    const campaignOn = item.kind === 'campaign' || now.campaignStatus === 'ENABLED' || enabledHere.has(`campaign:${now.campaignId}`)
    const adGroupId = item.kind === 'keyword' || item.kind === 'ad' ? item.id.split('~')[0] : null
    const adGroupOn = item.kind === 'campaign' || item.kind === 'ad-group' || now.adGroupStatus === 'ENABLED' || (adGroupId !== null && enabledHere.has(`ad-group:${adGroupId}`))
    if (campaignOn && adGroupOn) {
      spends.push(item.kind === 'campaign'
        ? `Enables the campaign "${now.name}": it can spend its daily budget from now.`
        : `Enables the ${KIND_WORD[item.kind]} "${now.name}" in the running campaign "${now.campaignName}": it can spend from now.`)
    } else {
      spends.push(`Enables the ${KIND_WORD[item.kind]} "${now.name}" (nothing serves until its ${!campaignOn ? 'campaign' : 'ad group'} is enabled too).`)
    }
    if (item.kind === 'campaign') {
      const open = live.facts.openEverythingElse[item.id] ?? 0
      if (open > 0) spends.push(`"${now.name}" leaves "everything else" open in ${plural(open, 'product group')}: it can advertise EVERY other product of the feed.`)
      if (live.facts.noLocation.includes(item.id)) warnings.push(`"${now.name}" targets no location: it can show in every country.`)
    }
  }
  if (!ops.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  const enabling = after.items.filter((i) => i.status === 'ENABLED').length
  const pausing = after.items.length - enabling
  return {
    summary: `Google Ads: ${[pausing && `pause ${plural(pausing, 'item')}`, enabling && `ENABLE ${plural(enabling, 'item')}`].filter(Boolean).join(', ')}.`,
    changes,
    totals: { operations: ops.length, paused: pausing, enabled: enabling, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations: ops,
    stands: {
      items: before.items.map((i) => {
        const now = itemNow(i.kind, i.id, live.campaigns, live.items)!
        return `${i.kind}:${i.id}:${now.status}:${now.campaignStatus}:${now.adGroupStatus}`
      }).sort(),
      facts: live.facts,
    },
    before,
    after,
  }
}

// ── remove ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type RemoveKind = ItemKind | 'budget' | 'negative-list'
export interface RemoveRequest { items: Array<{ kind: RemoveKind; id: string }> }

export function removeDraft(
  customer: string,
  request: RemoveRequest,
  live: { campaigns: LiveCampaign[]; items: LiveStatusItem[]; budgets: LiveBudget[]; lists: LiveNegativeList[] },
): GoogleChangeDraft | { refusal: string } {
  if (!request.items.length) return { refusal: 'Name at least one item to remove.' }
  const ops: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const seen = new Set<string>()
  const removed: Array<{ kind: RemoveKind; id: string; name: string }> = []
  const spends: string[] = []
  // Google needs what uses a budget or list gone before the budget or list itself: campaigns, ad groups, keywords and ads
  // first, budgets and lists last.
  const last = (k: RemoveKind) => (k === 'budget' || k === 'negative-list' ? 1 : 0)
  for (const item of [...request.items].sort((a, b) => last(a.kind) - last(b.kind))) {
    const key = `${item.kind}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    let name: string
    if (item.kind === 'budget') {
      const b = live.budgets.find((x) => x.budgetId === item.id)
      if (!b) return { refusal: `Budget ${item.id} is not in this account (or it is removed).` }
      const users = b.campaigns.filter((c) => !request.items.some((i) => i.kind === 'campaign' && i.id === c.campaignId))
      if (users.length) return { refusal: `Budget "${b.name ?? b.budgetId}" is used by ${plural(users.length, 'campaign')} (${users.map((c) => c.name).join(', ')}): move them first (set-google-budget), or remove them in the same request.` }
      name = b.name ?? `budget ${b.budgetId}`
    } else if (item.kind === 'negative-list') {
      const l = live.lists.find((x) => x.listId === item.id)
      if (!l) return { refusal: `Negative keyword list ${item.id} is not in this account (or it is removed).` }
      if (l.campaigns.length) return { refusal: `The list "${l.name ?? l.listId}" is on ${plural(l.campaigns.length, 'campaign')}: take it off first (set-google-negative-list detachCampaignIds).` }
      name = l.name ?? `list ${l.listId}`
    } else {
      const now = itemNow(item.kind, item.id, live.campaigns, live.items)
      if (!now) return { refusal: `${KIND_WORD[item.kind]} ${item.id} is not in this account (or it is already removed).` }
      name = now.name
      if (item.kind === 'keyword' && now.negative) {
        spends.push(`Removes the negative keyword ${now.name} from "${now.campaignName}": more searches can show the ads${now.campaignStatus === 'ENABLED' ? '' : ' (the campaign is paused: nothing spends until it is enabled)'}.`)
      }
    }
    const { op, resource } = itemResource(customer, item.kind, item.id)
    ops.push({ [op]: { remove: resource } })
    removed.push({ kind: item.kind, id: item.id, name })
    lines.push([`${item.kind === 'budget' ? 'budget' : item.kind === 'negative-list' ? 'negative keyword list' : KIND_WORD[item.kind]} "${name}"`, 'exists', 'REMOVED'])
  }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads: REMOVE ${plural(removed.length, 'item')} for good (${removed.slice(0, 3).map((r) => `"${r.name}"`).join(', ')}${removed.length > 3 ? ' …' : ''}).`,
    changes,
    totals: { operations: ops.length, removed: removed.length, ...(more ? { linesNotShown: more } : {}) },
    warnings: ['A removal cannot be undone: Google keeps a removed item only as history, and it cannot be enabled again.'],
    spendsMoney: spends,
    skipped: [],
    operations: ops,
    stands: { removed: removed.map((r) => `${r.kind}:${r.id}`).sort(), budgets: live.budgets.filter((b) => removed.some((r) => r.kind === 'budget' && r.id === b.budgetId)).map((b) => b.usedBy), lists: live.lists.filter((l) => removed.some((r) => r.kind === 'negative-list' && r.id === l.listId)).map((l) => l.campaigns.length) },
    before: { removed },
    after: { removed: removed.map((r) => ({ kind: r.kind, id: r.id })) },
  }
}
