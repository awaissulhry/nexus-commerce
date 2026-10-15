/**
 * Google Ads changes (2026-10-15) — shared negative keyword lists: make a list, add and remove its keywords, attach it
 * to campaigns and take it off them. One atomic request.
 *
 * Money: a negative keyword stops ads from showing for a search. Removing one, or taking a list off a campaign, lets
 * more searches reach the ads: said in the warnings. Nothing here raises a budget or a bid.
 */
import { changeLines, keywordTextProblem, plural, type GoogleChangeDraft } from './change-draft.js'
import { keywordKey, type LiveCampaign, type LiveNegativeList, type MatchType } from './live.js'
import type { GoogleMutateOperation } from './write-client.js'

export interface ListKeyword { text: string; matchType: MatchType }

export interface ListChangeRequest {
  /** An existing list (its Google id), or `create` a new one. */
  listId?: string
  create?: { name: string }
  addKeywords?: ListKeyword[]
  removeKeywords?: ListKeyword[]
  attachCampaignIds?: string[]
  detachCampaignIds?: string[]
}

export interface ListLiveState {
  lists: LiveNegativeList[]
  campaigns: LiveCampaign[]
}

/** What the change wrote (and what undo puts back): the keywords it added and removed, the campaigns it attached and detached. */
export interface ListChangeRecord {
  listId: string
  added: ListKeyword[]
  removed: ListKeyword[]
  attached: string[]
  detached: string[]
  created?: boolean
}

const NEW_LIST_TEMP_ID = -1
const kw = (k: ListKeyword) => `${k.matchType === 'EXACT' ? `[${k.text}]` : k.matchType === 'PHRASE' ? `"${k.text}"` : k.text}`

export function listChangeDraft(customer: string, request: ListChangeRequest, live: ListLiveState): GoogleChangeDraft | { refusal: string } {
  if (!!request.listId === !!request.create) return { refusal: 'Give listId (an existing negative keyword list) or create (a new one), not both.' }
  const add = request.addKeywords ?? []
  const remove = request.removeKeywords ?? []
  const attach = request.attachCampaignIds ?? []
  const detach = request.detachCampaignIds ?? []
  if (!request.create && add.length + remove.length + attach.length + detach.length === 0) {
    return { refusal: 'Say what to change: addKeywords, removeKeywords, attachCampaignIds or detachCampaignIds.' }
  }
  const campaignById = new Map(live.campaigns.map((c) => [c.campaignId, c]))
  let list: LiveNegativeList | null = null
  let listRes: string
  let listName: string
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const skipped: string[] = []
  if (request.create) {
    listName = request.create.name.trim()
    if (live.lists.some((l) => (l.name ?? '').trim().toLowerCase() === listName.toLowerCase())) {
      return { refusal: `A negative keyword list named "${listName}" already exists: Google refuses a second one. Use its listId, or another name.` }
    }
    listRes = `${customer}/sharedSets/${NEW_LIST_TEMP_ID}`
    operations.push({ sharedSetOperation: { create: { resourceName: listRes, name: listName, type: 'NEGATIVE_KEYWORDS' } } })
    lines.push([`new negative keyword list "${listName}"`, '(none)', 'made'])
  } else {
    list = live.lists.find((l) => l.listId === request.listId) ?? null
    if (!list) return { refusal: `Negative keyword list ${request.listId} is not in this account (or it is removed). google-ads-live view negative-lists lists them.` }
    if (!list.keywords) return { refusal: 'The list\'s keywords were not read: Nexus cannot say what changes.' }
    listRes = `${customer}/sharedSets/${list.listId}`
    listName = list.name ?? list.listId
  }
  const inList = new Map((list?.keywords ?? []).map((k) => [keywordKey(k.text, k.matchType), k]))
  const record: ListChangeRecord = { listId: request.listId ?? 'new', added: [], removed: [], attached: [], detached: [], ...(request.create ? { created: true } : {}) }

  const seen = new Set<string>()
  for (const k of add) {
    const problem = keywordTextProblem(k.text)
    if (problem) return { refusal: `The negative keyword "${k.text}" ${problem}.` }
    const key = keywordKey(k.text, k.matchType)
    if (seen.has(key)) continue
    seen.add(key)
    if (inList.has(key)) { skipped.push(`${kw(k)} is already in "${listName}".`); continue }
    operations.push({ sharedCriterionOperation: { create: { sharedSet: listRes, keyword: { text: k.text.trim(), matchType: k.matchType } } } })
    record.added.push({ text: k.text.trim(), matchType: k.matchType })
  }
  for (const k of remove) {
    const found = inList.get(keywordKey(k.text, k.matchType))
    if (!found) { skipped.push(`${kw(k)} is not in "${listName}".`); continue }
    if (record.removed.some((r) => keywordKey(r.text, r.matchType) === keywordKey(k.text, k.matchType))) continue
    if (record.added.some((r) => keywordKey(r.text, r.matchType) === keywordKey(k.text, k.matchType))) return { refusal: `${kw(k)} is both added and removed.` }
    operations.push({ sharedCriterionOperation: { remove: `${customer}/sharedCriteria/${list!.listId}~${found.criterionId}` } })
    record.removed.push({ text: found.text, matchType: found.matchType })
  }
  if (record.added.length) lines.push([`"${listName}" keywords added`, list ? list.keywordCount : 0, record.added.slice(0, 12).map(kw).join(', ') + (record.added.length > 12 ? ` … (+${record.added.length - 12})` : '')])
  if (record.removed.length) {
    lines.push([`"${listName}" keywords removed`, record.removed.slice(0, 12).map(kw).join(', ') + (record.removed.length > 12 ? ` … (+${record.removed.length - 12})` : ''), '(removed)'])
    warnings.push(`Removing ${plural(record.removed.length, 'negative keyword')} lets more searches show the ads of the campaigns this list is on.`)
  }

  const attachedNow = new Set(list?.campaigns.map((c) => c.campaignId) ?? [])
  for (const id of [...new Set(attach)]) {
    const c = campaignById.get(id)
    if (!c) return { refusal: `Campaign ${id} is not in this account (or it is removed).` }
    if (detach.includes(id)) return { refusal: `Campaign "${c.name}" is both attached and detached.` }
    if (attachedNow.has(id)) { skipped.push(`"${listName}" is already on "${c.name}".`); continue }
    operations.push({ campaignSharedSetOperation: { create: { campaign: `${customer}/campaigns/${id}`, sharedSet: listRes } } })
    record.attached.push(id)
    lines.push([`campaign "${c.name}"`, 'without the list', `uses "${listName}"`])
  }
  for (const id of [...new Set(detach)]) {
    const c = campaignById.get(id)
    if (!c) return { refusal: `Campaign ${id} is not in this account (or it is removed).` }
    if (!attachedNow.has(id)) { skipped.push(`"${listName}" is not on "${c.name}".`); continue }
    operations.push({ campaignSharedSetOperation: { remove: `${customer}/campaignSharedSets/${id}~${list!.listId}` } })
    record.detached.push(id)
    lines.push([`campaign "${c.name}"`, `uses "${listName}"`, 'without the list'])
  }
  if (record.detached.length) warnings.push(`Taking "${listName}" off ${plural(record.detached.length, 'campaign')} lets more searches show their ads.`)

  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes, more } = changeLines(lines)
  const parts: string[] = []
  if (request.create) parts.push(`make the negative keyword list "${listName}"`)
  if (record.added.length) parts.push(`add ${plural(record.added.length, 'negative keyword')}`)
  if (record.removed.length) parts.push(`remove ${plural(record.removed.length, 'negative keyword')}`)
  if (record.attached.length) parts.push(`attach it to ${plural(record.attached.length, 'campaign')}`)
  if (record.detached.length) parts.push(`take it off ${plural(record.detached.length, 'campaign')}`)
  return {
    summary: `Google Ads negative keyword list${request.create ? '' : ` "${listName}"`}: ${parts.join(', ')}.`,
    changes,
    totals: {
      operations: operations.length,
      keywordsAdded: record.added.length,
      keywordsRemoved: record.removed.length,
      campaignsAttached: record.attached.length,
      campaignsDetached: record.detached.length,
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney: [],
    skipped,
    operations,
    stands: {
      listId: list?.listId ?? null,
      keywords: list ? [...inList.keys()].sort() : null,
      campaigns: list ? [...attachedNow].sort() : null,
      names: request.create ? live.lists.map((l) => (l.name ?? '').toLowerCase()).sort() : undefined,
      asked: [...new Set([...attach, ...detach])].sort().map((id) => ({ id, status: campaignById.get(id)?.status ?? null })),
    },
    before: { listId: record.listId, keywords: record.removed, campaigns: record.detached },
    after: record,
  }
}

/** The id Google gave a list the run made (`sharedSetResult` of the first operation). */
export function createdListId(responses: Array<Record<string, { resourceName?: string } | undefined>>, request: ListChangeRequest): string | null {
  if (!request.create) return null
  const name = responses[0]?.sharedSetResult?.resourceName
  return name ? name.slice(name.lastIndexOf('/') + 1) : null
}
