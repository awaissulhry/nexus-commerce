/**
 * Google Ads changes, G7 (2026-10-15) — shared exclusion lists: the account's negative keyword list
 * (ACCOUNT_LEVEL_NEGATIVE_KEYWORDS), placement lists (NEGATIVE_PLACEMENTS: websites, YouTube channels and videos, apps,
 * app categories) and brand lists (BRANDS). Make a list, rename it, add and remove what it holds, and put it where it
 * acts: the whole account (a negative keyword list, a placement list), campaigns (a placement list, a brand list as an
 * exclusion or an inclusion). One atomic request; pure.
 *
 * Google's rules (v25, checked 2026-10-15 — reference SharedSet, SharedCriterion, CampaignSharedSet, CampaignCriterion,
 * CustomerNegativeCriterion, NegativeKeywordListInfo, PlacementListInfo, BrandListInfo; guides targeting/shared-sets,
 * targeting/criteria and ai-max-for-search-campaigns):
 *   - a list's name is unique among active lists of its type, 1 to 255 UTF-8 bytes; its type cannot change;
 *   - ACCOUNT_LEVEL_NEGATIVE_KEYWORDS goes only on the account (CustomerNegativeCriterion.negative_keyword_list), "at
 *     most one per account"; Google applies it to all eligible search and shopping inventory (Google Ads Help "About
 *     negative keywords");
 *   - NEGATIVE_PLACEMENTS goes on campaigns (CampaignSharedSet) and on the account (CustomerNegativeCriterion
 *     .placement_list); "Only negative keyword shared sets can be associated with Shopping campaigns";
 *   - BRANDS goes on campaigns through CampaignCriterion.brand_list: negative = an exclusion, else an inclusion (a brand
 *     restriction: the campaign's broad matching keeps to these brands). CampaignCriterionError
 *     CANNOT_ATTACH_BRAND_LIST_TO_NON_QUALIFIED_SEARCH_CAMPAIGN (v25): "For search advertising channel, brand lists can
 *     only be applied to exclusive targeting, broad match campaigns for inclusive targeting or PMax generated
 *     campaigns" — so an inclusion on a Search campaign needs broad match (AI Max); Google's check says so before
 *     anything is queued. An ad group takes only an inclusion (guide targeting/criteria; read here, not changed). A
 *     brand is named by its id (BrandInfo.entity_id; set-google-exclusion-list finds it by name).
 *   - a list's items and links are made (create) and removed (by resource name), never updated.
 * Money: what narrows (more exclusions, a list put on, a brand restriction put on) is a warning. What widens is SPENDS
 * MONEY: an exclusion or keyword taken out of a list in use, a list taken off (unless it stays on the whole account), a
 * brand added to a list used as an inclusion (more brands allowed), a brand restriction taken off, and a brand
 * inclusion put on a campaign that already keeps to another brand list (Google may take the brands of both).
 */
import { changeLines, keywordTextProblem, plural, type GoogleChangeDraft } from './change-draft.js'
import type { ListKeyword } from './change-lists.js'
import { notEnabledNote, someExclusions } from './change-exclusions.js'
import { keywordKey, type LiveCampaign } from './live.js'
import {
  exclusionInfo, exclusionKey, exclusionWords, normalizeExclusion, PLACEMENT_LIST_KINDS,
  type ExclusionItem, type ExclusionListType, type LiveAccountExclusions, type LiveExclusionList,
} from './live-exclusions.js'
import type { GoogleMutateOperation } from './write-client.js'

export type BrandMode = 'exclude' | 'include'
/**
 * A brand by Google's id. `name` is Google's (a list's brand, or SuggestBrands' answer) unless `nameAsGiven`: then it is
 * the name the request gave with the id, which Google did not check — shown as such, never as fact.
 */
export interface ListBrand { entityId: string; name: string | null; nameAsGiven?: true }

export interface ExclusionListChangeRequest {
  listId?: string
  create?: { name: string; type: ExclusionListType }
  name?: string
  addKeywords?: ListKeyword[]
  removeKeywords?: ListKeyword[]
  addItems?: ExclusionItem[]
  removeItems?: ExclusionItem[]
  /** Brands by Google's id (a name is found by the tool before this builder runs). */
  addBrands?: ListBrand[]
  removeBrands?: string[]
  attachCampaigns?: Array<{ campaignId: string; mode?: BrandMode }>
  detachCampaignIds?: string[]
  attachToAccount?: boolean
  detachFromAccount?: boolean
}

export interface ExclusionListLiveState {
  lists: LiveExclusionList[]
  /** The account's links (its negative keyword list, its placement lists), when read. */
  account: LiveAccountExclusions | null
  campaigns: LiveCampaign[]
}

/** What the change wrote (and what undo puts back). */
export interface ExclusionListRecord {
  listId: string
  type: ExclusionListType
  created?: boolean
  renamed?: { from: string | null; to: string }
  addedKeywords: ListKeyword[]
  removedKeywords: ListKeyword[]
  addedItems: ExclusionItem[]
  removedItems: ExclusionItem[]
  addedBrands: ListBrand[]
  removedBrands: ListBrand[]
  attached: Array<{ campaignId: string; mode: BrandMode }>
  detached: Array<{ campaignId: string; mode: BrandMode }>
  accountAttached?: true
  accountDetached?: true
}

const NEW_LIST_TEMP_ID = -1
const TYPE_WORD: Record<ExclusionListType, string> = {
  ACCOUNT_LEVEL_NEGATIVE_KEYWORDS: 'account negative keyword list',
  NEGATIVE_PLACEMENTS: 'placement exclusion list',
  BRANDS: 'brand list',
}
const kw = (k: ListKeyword) => `${k.matchType === 'EXACT' ? `[${k.text}]` : k.matchType === 'PHRASE' ? `"${k.text}"` : k.text}`
const someKeywords = (ks: ListKeyword[]) => ks.slice(0, 12).map(kw).join(', ') + (ks.length > 12 ? ` … (+${ks.length - 12})` : '')
const brandWords = (b: ListBrand) => (!b.name ? b.entityId : b.nameAsGiven ? `${b.entityId} (name as given, not checked by Google: ${b.name})` : `${b.name} (${b.entityId})`)
const someBrands = (bs: ListBrand[]) => bs.slice(0, 12).map(brandWords).join(', ') + (bs.length > 12 ? ` … (+${bs.length - 12})` : '')

class ListRefusal extends Error {}

/** The change of a set-google-exclusion-list request, from the live state: a draft, or a refusal in words. Pure. */
export function exclusionListDraft(customer: string, request: ExclusionListChangeRequest, live: ExclusionListLiveState): GoogleChangeDraft | { refusal: string } {
  try {
    return buildListChange(customer, request, live)
  } catch (err) {
    if (err instanceof ListRefusal) return { refusal: err.message }
    throw err
  }
}

function buildListChange(customer: string, request: ExclusionListChangeRequest, live: ExclusionListLiveState): GoogleChangeDraft {
  const refuse = (why: string): never => { throw new ListRefusal(why) }
  if (!!request.listId === !!request.create) refuse('Give listId (an existing exclusion list) or create (a new one), not both.')
  if (request.create && request.name !== undefined) refuse('name renames an existing list (listId); a new list takes its name from create.')
  if (request.attachToAccount && request.detachFromAccount) refuse('attachToAccount and detachFromAccount cannot both be asked.')
  const addKeywords = request.addKeywords ?? []
  const removeKeywords = request.removeKeywords ?? []
  const addItems = request.addItems ?? []
  const removeItems = request.removeItems ?? []
  const addBrands = request.addBrands ?? []
  const removeBrands = request.removeBrands ?? []
  const attach = request.attachCampaigns ?? []
  const detach = request.detachCampaignIds ?? []
  const asked = addKeywords.length + removeKeywords.length + addItems.length + removeItems.length + addBrands.length + removeBrands.length + attach.length + detach.length
  if (!request.create && request.name === undefined && asked === 0 && !request.attachToAccount && !request.detachFromAccount) {
    refuse('Say what to change: name, addKeywords / removeKeywords, addItems / removeItems, addBrands / removeBrands, attachCampaigns / detachCampaignIds, attachToAccount or detachFromAccount.')
  }

  let list: LiveExclusionList | null = null
  let type: ExclusionListType
  let listName: string
  let listRes: string
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spends: string[] = []
  const skipped: string[] = []
  if (request.create) {
    type = request.create.type
    listName = request.create.name.trim()
    nameProblem(listName, refuse)
    if (live.lists.some((l) => l.type === type && (l.name ?? '').trim().toLowerCase() === listName.toLowerCase())) {
      refuse(`A ${TYPE_WORD[type]} named "${listName}" already exists: Google refuses a second one. Use its listId, or another name.`)
    }
    listRes = `${customer}/sharedSets/${NEW_LIST_TEMP_ID}`
    operations.push({ sharedSetOperation: { create: { resourceName: listRes, name: listName, type } } })
    lines.push([`new ${TYPE_WORD[type]} "${listName}"`, '(none)', 'made'])
  } else {
    list = live.lists.find((l) => l.listId === request.listId) ?? null
    if (!list) refuse(`Exclusion list ${request.listId} is not in this account (or it is removed, or it is a negative keyword list for campaigns: set-google-negative-list changes those). google-ads-live view exclusions lists them.`)
    type = list!.type
    listName = list!.name ?? list!.listId
    listRes = `${customer}/sharedSets/${list!.listId}`
    const content = type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' ? list!.keywords : type === 'BRANDS' ? list!.brands : list!.items
    if (!content) refuse('The list\'s content was not read: Nexus cannot say what changes.')
  }
  const word = TYPE_WORD[type]

  // What each type holds and where it goes (Google's rules, above).
  if (type !== 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' && addKeywords.length + removeKeywords.length) {
    refuse(`A ${word} holds no keywords: keywords go in the account negative keyword list (type ACCOUNT_LEVEL_NEGATIVE_KEYWORDS) or a campaign negative keyword list (set-google-negative-list).`)
  }
  if (type !== 'NEGATIVE_PLACEMENTS' && addItems.length + removeItems.length) {
    refuse(`A ${word} holds no websites, channels, videos or apps: those go in a placement exclusion list (type NEGATIVE_PLACEMENTS), or one by one with set-google-account-exclusions / set-google-campaign-exclusions.`)
  }
  if (type !== 'BRANDS' && addBrands.length + removeBrands.length) refuse(`A ${word} holds no brands: brands go in a brand list (type BRANDS).`)
  if (type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' && attach.length + detach.length) {
    refuse('The account negative keyword list goes on the whole account (attachToAccount), not on campaigns: Google applies it to every campaign\'s eligible search and shopping traffic.')
  }
  if (type === 'BRANDS' && (request.attachToAccount || request.detachFromAccount)) refuse('A brand list goes on campaigns (attachCampaigns), not on the account.')

  const record: ExclusionListRecord = {
    listId: request.listId ?? 'new', type, ...(request.create ? { created: true } : {}),
    addedKeywords: [], removedKeywords: [], addedItems: [], removedItems: [], addedBrands: [], removedBrands: [], attached: [], detached: [],
  }

  // A new name.
  if (request.name !== undefined && list) {
    const name = request.name.trim()
    nameProblem(name, refuse)
    if (name === (list.name ?? '').trim()) skipped.push(`The list is already named "${name}".`)
    else {
      if (live.lists.some((l) => l.listId !== list!.listId && l.type === type && (l.name ?? '').trim().toLowerCase() === name.toLowerCase())) {
        refuse(`A ${word} named "${name}" already exists: Google refuses a second one. Choose another name.`)
      }
      operations.push({ sharedSetOperation: { update: { resourceName: listRes, name }, updateMask: 'name' } })
      record.renamed = { from: list.name, to: name }
      lines.push([`${word} "${listName}" name`, list.name ?? '(none)', name])
    }
  }

  // ── what it holds ──
  const criterionRes = (criterionId: string) => `${customer}/sharedCriteria/${list!.listId}~${criterionId}`
  if (type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS') {
    const inList = new Map((list?.keywords ?? []).map((k) => [keywordKey(k.text, k.matchType), k]))
    const seen = new Set<string>()
    for (const k of addKeywords) {
      const problem = keywordTextProblem(k.text)
      if (problem) refuse(`The negative keyword "${k.text}" ${problem}.`)
      const key = keywordKey(k.text, k.matchType)
      if (seen.has(key)) continue
      seen.add(key)
      if (inList.has(key)) { skipped.push(`${kw(k)} is already in "${listName}".`); continue }
      operations.push({ sharedCriterionOperation: { create: { sharedSet: listRes, keyword: { text: k.text.trim(), matchType: k.matchType } } } })
      record.addedKeywords.push({ text: k.text.trim(), matchType: k.matchType })
    }
    for (const k of removeKeywords) {
      const key = keywordKey(k.text, k.matchType)
      if (seen.has(key)) refuse(`${kw(k)} is both added and removed.`)
      const found = inList.get(key)
      if (!found) { skipped.push(`${kw(k)} is not in "${listName}".`); continue }
      if (record.removedKeywords.some((r) => keywordKey(r.text, r.matchType) === key)) continue
      operations.push({ sharedCriterionOperation: { remove: criterionRes(found.criterionId) } })
      record.removedKeywords.push({ text: found.text, matchType: found.matchType })
    }
    if (record.addedKeywords.length) lines.push([`"${listName}" keywords added`, list ? list.itemCount : 0, someKeywords(record.addedKeywords)])
    if (record.removedKeywords.length) lines.push([`"${listName}" keywords removed`, someKeywords(record.removedKeywords), '(removed)'])
  }
  if (type === 'NEGATIVE_PLACEMENTS') {
    const allowed = new Set<string>(PLACEMENT_LIST_KINDS)
    const normalize = (item: ExclusionItem) => {
      if (!allowed.has(item.kind)) refuse(`A placement exclusion list holds websites, YouTube channels and videos, apps and app categories, not a ${item.kind} (exclude it with set-google-account-exclusions or set-google-campaign-exclusions).`)
      const n = normalizeExclusion(item)
      if ('problem' in n) refuse(`Not queued: ${n.problem}.`)
      return n as ExclusionItem
    }
    const inList = new Map((list?.items ?? []).map((i) => [exclusionKey(i), i]))
    const removeKeys = new Set(removeItems.map((i) => exclusionKey(normalize(i))))
    const seen = new Set<string>()
    for (const raw of addItems) {
      const item = normalize(raw)
      const key = exclusionKey(item)
      if (removeKeys.has(key)) refuse(`${exclusionWords(item)} is both added and removed.`)
      if (seen.has(key)) continue
      seen.add(key)
      if (inList.has(key)) { skipped.push(`${exclusionWords(item)} is already in "${listName}".`); continue }
      operations.push({ sharedCriterionOperation: { create: { sharedSet: listRes, ...exclusionInfo(item) } } })
      record.addedItems.push(item)
    }
    const removed = new Set<string>()
    for (const raw of removeItems) {
      const item = normalize(raw)
      const key = exclusionKey(item)
      if (removed.has(key)) continue
      removed.add(key)
      const found = inList.get(key)
      if (!found) { skipped.push(`${exclusionWords(item)} is not in "${listName}".`); continue }
      operations.push({ sharedCriterionOperation: { remove: criterionRes(found.criterionId) } })
      record.removedItems.push({ kind: found.kind, value: found.value })
    }
    if (record.addedItems.length) lines.push([`"${listName}" exclusions added`, list ? list.itemCount : 0, someExclusions(record.addedItems)])
    if (record.removedItems.length) lines.push([`"${listName}" exclusions removed`, someExclusions(record.removedItems), '(removed)'])
  }
  if (type === 'BRANDS') {
    const inList = new Map((list?.brands ?? []).map((b) => [b.entityId, b]))
    const removeSet = new Set(removeBrands.map((id) => id.trim()))
    const seen = new Set<string>()
    for (const b of addBrands) {
      const id = b.entityId.trim()
      if (!id) refuse('A brand to add has no id.')
      if (removeSet.has(id)) refuse(`Brand ${brandWords(b)} is both added and removed.`)
      if (seen.has(id)) continue
      seen.add(id)
      if (inList.has(id)) {
        // Google's name from the list when it has one; else the name as asked (labelled as such when unchecked).
        const google = inList.get(id)!.name
        skipped.push(`${brandWords(google ? { entityId: id, name: google } : { ...b, entityId: id })} is already in "${listName}".`)
        continue
      }
      operations.push({ sharedCriterionOperation: { create: { sharedSet: listRes, brand: { entityId: id } } } })
      record.addedBrands.push({ entityId: id, name: b.name ?? null, ...(b.nameAsGiven && b.name ? { nameAsGiven: true as const } : {}) })
    }
    for (const id of removeSet) {
      const found = inList.get(id)
      if (!found) { skipped.push(`Brand ${id} is not in "${listName}".`); continue }
      operations.push({ sharedCriterionOperation: { remove: criterionRes(found.criterionId) } })
      record.removedBrands.push({ entityId: found.entityId, name: found.name })
    }
    if (record.addedBrands.length) lines.push([`"${listName}" brands added`, list ? list.itemCount : 0, someBrands(record.addedBrands)])
    if (record.removedBrands.length) lines.push([`"${listName}" brands removed`, someBrands(record.removedBrands), '(removed)'])
  }

  // ── where it acts ──
  const campaignById = new Map(live.campaigns.map((c) => [c.campaignId, c]))
  const usedBy = new Map((list?.campaigns ?? []).map((c) => [c.campaignId, c]))
  /**
   * A brand inclusion narrows a campaign only when it keeps to no other brand list yet: with another inclusion already on
   * the campaign (or on one of its ad groups), Google may take the brands of both, so adding one can widen what it shows
   * for (SPENDS MONEY). Read from the brand lists' links (every BRANDS list's campaigns and ad groups are read).
   */
  const otherInclusions = (campaignId: string) => live.lists
    .filter((l) => l.type === 'BRANDS' && l.listId !== list?.listId)
    .flatMap((l) => [
      ...l.campaigns.filter((u) => u.campaignId === campaignId && u.mode === 'include').map(() => ({ listId: l.listId, name: l.name, where: 'the campaign', adGroupId: null as string | null })),
      ...l.adGroups.filter((g) => g.campaignId === campaignId).map((g) => ({ listId: l.listId, name: l.name, where: `its ad group "${g.name}"`, adGroupId: g.adGroupId })),
    ])
  const widening: Array<{ campaignId: string; others: ReturnType<typeof otherInclusions> }> = []
  const inclusionStands: string[] = []
  const attachedIds = new Set<string>()
  for (const a of attach) {
    const id = a.campaignId
    if (attachedIds.has(id)) continue
    attachedIds.add(id)
    const c = campaignById.get(id)
    if (!c) refuse(`Campaign ${id} is not in this account (or it is removed).`)
    if (detach.includes(id)) refuse(`Campaign "${c!.name}" is both attached and detached.`)
    const mode: BrandMode = a.mode ?? 'exclude'
    if (type === 'NEGATIVE_PLACEMENTS') {
      if (mode !== 'exclude') refuse('A placement exclusion list only excludes (mode exclude).')
      if (c!.type === 'SHOPPING') refuse(`"${c!.name}" is a Shopping campaign: Google takes only negative keyword lists on Shopping campaigns (CampaignSharedSet, v25).`)
      if (usedBy.has(id)) { skipped.push(`"${listName}" is already on "${c!.name}".`); continue }
      operations.push({ campaignSharedSetOperation: { create: { campaign: `${customer}/campaigns/${id}`, sharedSet: listRes } } })
    } else {
      const now = usedBy.get(id)
      if (now && now.mode === mode) { skipped.push(`"${listName}" is already on "${c!.name}" as an ${mode === 'exclude' ? 'exclusion' : 'inclusion'}.`); continue }
      if (now) refuse(`"${listName}" is on "${c!.name}" as an ${now.mode === 'exclude' ? 'exclusion' : 'inclusion'}: detach it first to use it the other way.`)
      operations.push({ campaignCriterionOperation: { create: { campaign: `${customer}/campaigns/${id}`, negative: mode === 'exclude', brandList: { sharedSet: listRes } } } })
      if (mode === 'include') {
        const others = otherInclusions(id)
        inclusionStands.push(`${id}:${others.map((o) => `${o.listId}@${o.adGroupId ?? 'campaign'}`).sort().join(',')}`)
        if (others.length) widening.push({ campaignId: id, others })
      }
    }
    record.attached.push({ campaignId: id, mode })
    lines.push([`campaign "${c!.name}"`, `without "${listName}"`, type === 'BRANDS' ? (mode === 'exclude' ? `excludes the brands of "${listName}"` : `keeps to the brands of "${listName}"`) : `excludes what "${listName}" holds`])
  }
  for (const id of [...new Set(detach)]) {
    const c = campaignById.get(id)
    if (!c) refuse(`Campaign ${id} is not in this account (or it is removed).`)
    const now = usedBy.get(id)
    if (!now) { skipped.push(`"${listName}" is not on "${c!.name}".`); continue }
    if (type === 'NEGATIVE_PLACEMENTS') operations.push({ campaignSharedSetOperation: { remove: `${customer}/campaignSharedSets/${id}~${list!.listId}` } })
    else {
      if (!now.criterionId) refuse(`The link of "${listName}" to "${c!.name}" was not read: Nexus cannot take it off.`)
      operations.push({ campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${id}~${now.criterionId}` } })
    }
    record.detached.push({ campaignId: id, mode: now.mode })
    lines.push([`campaign "${c!.name}"`, type === 'BRANDS' ? `${now.mode === 'exclude' ? 'excludes' : 'keeps to'} the brands of "${listName}"` : `excludes what "${listName}" holds`, `without "${listName}"`])
  }

  // The account.
  const onAccount = list?.account ?? null
  if (request.attachToAccount) {
    if (!live.account) refuse('The account\'s exclusions were not read: Nexus cannot say whether the list is on it.')
    if (onAccount) skipped.push(`"${listName}" is already on the account.`)
    else {
      if (type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' && live.account!.keywordList) {
        const other = live.lists.find((l) => l.listId === live.account!.keywordList!.listId)
        refuse(`The account already uses "${other?.name ?? live.account!.keywordList!.listId}" (${live.account!.keywordList!.listId}) as its negative keyword list, and Google allows one: add the keywords there, or take it off the account first (its listId, detachFromAccount).`)
      }
      operations.push({ customerNegativeCriterionOperation: { create: type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' ? { negativeKeywordList: { sharedSet: listRes } } : { placementList: { sharedSet: listRes } } } })
      record.accountAttached = true
      lines.push(['the account', `without "${listName}"`, `every campaign excludes what "${listName}" holds`])
    }
  }
  if (request.detachFromAccount) {
    if (!onAccount) skipped.push(`"${listName}" is not on the account.`)
    else {
      operations.push({ customerNegativeCriterionOperation: { remove: `${customer}/customerNegativeCriteria/${onAccount.criterionId}` } })
      record.accountDetached = true
      lines.push(['the account', `every campaign excludes what "${listName}" holds`, `without "${listName}"`])
    }
  }

  if (operations.length === 0) refuse(`Nothing to change: ${skipped.join(' ')}`)

  // ── money: what narrows is a warning, what widens SPENDS MONEY ──
  const allStatuses = live.campaigns.map((c) => c.status)
  const excludeUsers = (list?.campaigns ?? []).filter((c) => c.mode === 'exclude' && !record.detached.some((d) => d.campaignId === c.campaignId))
  const includeUsers = (list?.campaigns ?? []).filter((c) => c.mode === 'include' && !record.detached.some((d) => d.campaignId === c.campaignId))
  const adGroupUsers = list?.adGroups ?? []
  const accountUser = !!onAccount && !record.accountDetached
  /** "which 2 campaigns use" / "which is on the whole account". */
  const whichUse = accountUser ? 'is on the whole account' : `${plural(excludeUsers.length, 'campaign')} use${excludeUsers.length === 1 ? 's' : ''}`
  const inUse = accountUser || excludeUsers.length > 0
  const usersNote = accountUser ? notEnabledNote(allStatuses) : notEnabledNote(excludeUsers.map((c) => c.status))
  if (type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS') {
    if (record.removedKeywords.length && accountUser) spends.push(`Removes ${plural(record.removedKeywords.length, 'negative keyword')} (${someKeywords(record.removedKeywords)}) from the account's negative keyword list "${listName}": every campaign can show ads on those searches again${notEnabledNote(allStatuses)}.`)
    if (record.accountDetached) spends.push(`Takes "${listName}" off the account: its ${plural(list!.itemCount, 'negative keyword')} no longer ${list!.itemCount === 1 ? 'blocks' : 'block'} searches in any campaign${notEnabledNote(allStatuses)}.`)
    if (record.addedKeywords.length && accountUser) warnings.push(`Adds ${plural(record.addedKeywords.length, 'negative keyword')} to the account's negative keyword list: no campaign shows ads on those searches any more.`)
    if (record.accountAttached) warnings.push(`Puts "${listName}" on the account: no campaign shows ads on the searches it blocks.`)
  }
  if (type === 'NEGATIVE_PLACEMENTS') {
    if (record.removedItems.length && inUse) spends.push(`Removes ${plural(record.removedItems.length, 'exclusion')} (${someExclusions(record.removedItems)}) from "${listName}", which ${whichUse}: ads can show there again${usersNote}.`)
    if (record.detached.length) {
      // Still on the whole account: the account link keeps excluding what it holds, so nothing shows there yet.
      if (accountUser) warnings.push(`Takes "${listName}" off ${plural(record.detached.length, 'campaign')}: the list stays on the whole account, so they still exclude what it holds.`)
      else spends.push(`Takes "${listName}" off ${plural(record.detached.length, 'campaign')}: they can show ads on what it excludes again${notEnabledNote(record.detached.map((d) => campaignById.get(d.campaignId)?.status ?? null))}.`)
    }
    if (record.accountDetached) spends.push(`Takes "${listName}" off the account: every campaign can show ads on what it excludes again${notEnabledNote(allStatuses)}.`)
    if (record.addedItems.length && inUse) warnings.push(`Adds ${plural(record.addedItems.length, 'exclusion')} to "${listName}", which ${whichUse}: no ads show there any more.`)
    if (record.attached.length || record.accountAttached) warnings.push(`Puts "${listName}" on ${record.accountAttached ? 'the account' : plural(record.attached.length, 'campaign')}: no ads show on what it excludes.`)
  }
  if (type === 'BRANDS') {
    const includeAll = [...includeUsers.map((c) => c.status), ...adGroupUsers.filter((g) => g.status === 'ENABLED').map((g) => g.campaignStatus)]
    const includeCount = includeUsers.length + adGroupUsers.length
    if (record.removedBrands.length && excludeUsers.length) spends.push(`Removes ${plural(record.removedBrands.length, 'brand')} (${someBrands(record.removedBrands)}) from "${listName}", which ${plural(excludeUsers.length, 'campaign')} exclude${excludeUsers.length === 1 ? 's' : ''}: they can show ads on searches about those brands again${notEnabledNote(excludeUsers.map((c) => c.status))}.`)
    if (record.addedBrands.length && includeCount) spends.push(`Adds ${plural(record.addedBrands.length, 'brand')} (${someBrands(record.addedBrands)}) to "${listName}", which ${plural(includeCount, 'campaign or ad group', 'campaigns or ad groups')} keep${includeCount === 1 ? 's' : ''} to: they can show ads on searches about more brands${notEnabledNote(includeAll)}.`)
    const offExclude = record.detached.filter((d) => d.mode === 'exclude')
    const offInclude = record.detached.filter((d) => d.mode === 'include')
    if (offExclude.length) spends.push(`Takes the brand exclusion "${listName}" off ${plural(offExclude.length, 'campaign')}: they can show ads on searches about its brands again${notEnabledNote(offExclude.map((d) => campaignById.get(d.campaignId)?.status ?? null))}.`)
    if (offInclude.length) spends.push(`Takes the brand inclusion "${listName}" off ${plural(offInclude.length, 'campaign')}: they no longer keep to its brands and can show ads on more searches${notEnabledNote(offInclude.map((d) => campaignById.get(d.campaignId)?.status ?? null))}.`)
    if (record.addedBrands.length && excludeUsers.length) warnings.push(`Adds ${plural(record.addedBrands.length, 'brand')} to "${listName}", which ${plural(excludeUsers.length, 'campaign')} exclude${excludeUsers.length === 1 ? 's' : ''}: they stop showing ads on searches about those brands.`)
    if (record.removedBrands.length && includeCount) warnings.push(`Removes ${plural(record.removedBrands.length, 'brand')} from "${listName}", which ${plural(includeCount, 'campaign or ad group', 'campaigns or ad groups')} keep${includeCount === 1 ? 's' : ''} to: fewer searches show their ads.`)
    const onExclude = record.attached.filter((a) => a.mode === 'exclude')
    const onInclude = record.attached.filter((a) => a.mode === 'include')
    for (const w of widening) {
      const c = campaignById.get(w.campaignId)!
      const lists = w.others.map((o) => `"${o.name ?? o.listId}" (${o.listId}) on ${o.where}`).join(', ')
      spends.push(`Adds brands "${c.name}" may show ads for: it already keeps to ${lists}, and Google may take the brands of both, so it can show ads on searches about the brands of "${listName}" too${notEnabledNote([c.status])}.`)
    }
    const narrowing = onInclude.filter((a) => !widening.some((w) => w.campaignId === a.campaignId))
    if (onExclude.length) warnings.push(`Excludes the brands of "${listName}" on ${plural(onExclude.length, 'campaign')}: no ads on searches about them.`)
    if (narrowing.length) warnings.push(`Keeps ${plural(narrowing.length, 'campaign')} to the brands of "${listName}" (brand inclusion): their broad matching shows ads only on searches about those brands.`)
    if (onInclude.length) warnings.push('On a Search campaign Google takes a brand inclusion only with broad match (AI Max) on (its check says so).')
  }
  const putOn = type === 'BRANDS' ? 'attachCampaigns' : type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' ? 'attachToAccount' : 'attachCampaigns or attachToAccount'
  if (!list && !record.attached.length && !record.accountAttached) warnings.push(`The new list is on no campaign and not on the account: it changes nothing until it is put somewhere (${putOn}).`)

  const { changes, more } = changeLines(lines)
  const parts: string[] = []
  if (request.create) parts.push(`make the ${word} "${listName}"`)
  if (record.renamed) parts.push(`rename it to "${record.renamed.to}"`)
  if (record.addedKeywords.length) parts.push(`add ${plural(record.addedKeywords.length, 'negative keyword')}`)
  if (record.removedKeywords.length) parts.push(`remove ${plural(record.removedKeywords.length, 'negative keyword')}`)
  if (record.addedItems.length) parts.push(`add ${plural(record.addedItems.length, 'exclusion')}`)
  if (record.removedItems.length) parts.push(`remove ${plural(record.removedItems.length, 'exclusion')}`)
  if (record.addedBrands.length) parts.push(`add ${plural(record.addedBrands.length, 'brand')}`)
  if (record.removedBrands.length) parts.push(`remove ${plural(record.removedBrands.length, 'brand')}`)
  if (record.attached.length) parts.push(`put it on ${plural(record.attached.length, 'campaign')}`)
  if (record.detached.length) parts.push(`take it off ${plural(record.detached.length, 'campaign')}`)
  if (record.accountAttached) parts.push('put it on the account')
  if (record.accountDetached) parts.push('take it off the account')
  const contentKeys = list
    ? type === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' ? (list.keywords ?? []).map((k) => `${keywordKey(k.text, k.matchType)}#${k.criterionId}`)
      : type === 'BRANDS' ? (list.brands ?? []).map((b) => `${b.entityId}#${b.criterionId}`)
        : (list.items ?? []).map((i) => `${exclusionKey(i)}#${i.criterionId}`)
    : []
  return {
    summary: `Google Ads ${word}${request.create ? '' : ` "${listName}"`}: ${parts.join(', ')}.`,
    changes,
    totals: {
      operations: operations.length,
      ...(record.renamed ? { renamed: 1 } : {}),
      added: record.addedKeywords.length + record.addedItems.length + record.addedBrands.length,
      removed: record.removedKeywords.length + record.removedItems.length + record.removedBrands.length,
      campaignsAttached: record.attached.length,
      campaignsDetached: record.detached.length,
      ...(record.accountAttached ? { accountAttached: 1 } : {}),
      ...(record.accountDetached ? { accountDetached: 1 } : {}),
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      listId: list?.listId ?? null,
      type,
      content: contentKeys.sort(),
      // The SPENDS MONEY words stand on who uses the list and whether they are enabled.
      campaigns: (list?.campaigns ?? []).map((c) => `${c.campaignId}:${c.mode}:${c.criterionId ?? ''}:${c.status}`).sort(),
      adGroups: (list?.adGroups ?? []).map((g) => `${g.adGroupId}:${g.status}:${g.campaignStatus}`).sort(),
      account: onAccount?.criterionId ?? null,
      ...(request.attachToAccount || record.accountDetached || accountUser ? { accountKeywordList: live.account?.keywordList?.listId ?? null, enabled: allStatuses.some((s) => s === 'ENABLED') } : {}),
      // A brand inclusion's SPENDS MONEY words stand on the other inclusion lists of each campaign it goes on.
      ...(inclusionStands.length ? { otherInclusions: inclusionStands.sort() } : {}),
      asked: [...new Set([...attach.map((a) => a.campaignId), ...detach])].sort().map((id) => ({ id, status: campaignById.get(id)?.status ?? null, type: campaignById.get(id)?.type ?? null })),
      ...(request.name !== undefined || request.create ? { names: live.lists.filter((l) => l.type === type).map((l) => `${l.listId}:${l.name ?? ''}`).sort() } : {}),
    },
    before: {
      listId: record.listId,
      type,
      ...(record.renamed ? { name: record.renamed.from } : {}),
      removedKeywords: record.removedKeywords,
      removedItems: record.removedItems,
      removedBrands: record.removedBrands,
      detached: record.detached,
      ...(record.accountDetached ? { accountDetached: true } : {}),
    },
    after: record,
  }
}

function nameProblem(name: string, refuse: (why: string) => never): void {
  const bytes = new TextEncoder().encode(name).length
  if (bytes < 1 || bytes > 255) refuse(`The list name "${name.slice(0, 40)}" is ${bytes} bytes long: Google takes 1 to 255 (UTF-8).`)
}

/** The id Google gave a list the run made (`sharedSetResult` of the first operation). */
export function createdExclusionListId(responses: Array<Record<string, { resourceName?: string } | undefined>>, request: ExclusionListChangeRequest): string | null {
  if (!request.create) return null
  const name = responses[0]?.sharedSetResult?.resourceName
  return name ? name.slice(name.lastIndexOf('/') + 1) : null
}
