/**
 * Google Ads changes, PR 6 (2026-10-15) — build a whole Google Ads structure in ONE atomic request: new shared budgets,
 * new negative keyword lists with their keywords, and campaigns — each ALWAYS paused — with their targeting, negatives,
 * lists, ad groups, keywords, product groups, responsive search ads and campaign assets. Everything new points at what it
 * belongs to through temporary ids (negative numbers, unique across the request, each defined before it is used), so
 * Google makes all of it or none of it. Steps of a change plan cannot do this: a later step cannot point at a campaign an
 * earlier step has not made yet when Google checks the plan.
 *
 * A campaign of the build can also be a COPY of a live campaign (`copyOf`): the tool reads it live (live.ts) and this file
 * receives it already expanded (`BuildCampaign` with every part), so the build is pure.
 *
 * Money: every campaign is made PAUSED, so the build spends nothing; enabling is set-google-status (SPENDS MONEY). The
 * preview says what would spend once enabled: the daily budgets, and any "everything else" product group left open.
 */
import { changeLines, keywordTextProblem, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { campaignCreateOperations, campaignCreateProblem, type CampaignCreateRequest } from './change-campaigns.js'
import { httpsUrlProblem, rsaProblems, widthProblem, type RsaAd } from './change-ads.js'
import { ASSET_LIMITS, snippetHeader, type AssetFieldType, type SitelinkRequest, type SnippetRequest } from './change-assets.js'
import { keywordKey, microsOfCents, type LiveBudget, type LiveCampaign, type LiveNegativeList, type MatchType } from './live.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

export interface BuildKeyword { text: string; matchType: MatchType; bidCents?: number; status?: 'ENABLED' | 'PAUSED' }
export interface BuildNegative { text: string; matchType: MatchType }
/** A product group node to make again as it is (a copy): its parent by index in the list, its case value as Google reads it. */
export interface BuildProductNode { parent: number | null; kind: 'SUBDIVISION' | 'UNIT'; caseValue: Record<string, unknown> | null; excluded: boolean; bidCents: number | null }
export type BuildProductGroups =
  | { itemIds: string[]; bidCents: number; itemBids?: Array<{ itemId: string; bidCents: number }>; includeEverythingElse?: { bidCents: number } }
  | { nodes: BuildProductNode[] }

export interface BuildAdGroup {
  name: string
  defaultBidCents?: number
  status?: 'ENABLED' | 'PAUSED'
  keywords?: BuildKeyword[]
  negatives?: BuildNegative[]
  productGroups?: BuildProductGroups
  ads?: Array<RsaAd & { status?: 'ENABLED' | 'PAUSED' }>
}

export interface BuildCampaign extends Omit<CampaignCreateRequest, 'budgetId' | 'dailyBudgetCents'> {
  /** Its budget: one this build makes (`ref`), an existing shared budget (`budgetId`), or a new one of its own. */
  budget: { ref: string } | { budgetId: string } | { dailyBudgetCents: number }
  /** Shared negative keyword lists: one this build makes (`ref`), or an existing one (`listId`). */
  negativeLists?: Array<{ ref: string } | { listId: string }>
  /** Campaign-level negative keywords. */
  negatives?: BuildNegative[]
  adGroups?: BuildAdGroup[]
  assets?: {
    sitelinks?: SitelinkRequest[]
    callouts?: string[]
    structuredSnippets?: SnippetRequest[]
    /** Existing assets of the account linked to the new campaign (a copy links the same assets). */
    link?: Array<{ assetId: string; fieldType: AssetFieldType }>
  }
}

export interface BuildSpec {
  sharedBudgets?: Array<{ ref: string; name: string; budgetCents: number }>
  negativeLists?: Array<{ ref: string; name: string; keywords: BuildNegative[] }>
  campaigns: BuildCampaign[]
  /** BROAD keywords (not negatives) are refused unless asked. */
  allowBroad?: boolean
}

export interface BuildLive { campaigns: LiveCampaign[]; budgets: LiveBudget[]; lists: LiveNegativeList[] }

/** What a build made, by the operation that made it: after the run, Google's ids. */
export interface BuildRecord {
  campaigns: Array<{ name: string; campaignId: string | null; op: number }>
  sharedBudgets: Array<{ name: string; budgetId: string | null; op: number }>
  negativeLists: Array<{ name: string; listId: string | null; op: number }>
}

const MAX_BUILD_OPERATIONS = 4000

export function buildDraft(customer: string, currency: string, spec: BuildSpec, live: BuildLive): GoogleChangeDraft | { refusal: string } {
  if (!spec.campaigns.length && !spec.sharedBudgets?.length && !spec.negativeLists?.length) return { refusal: 'The build holds nothing.' }
  const problems: string[] = []
  let next = -1
  const temp = () => next--
  const ops: GoogleMutateOperation[] = []
  const record: BuildRecord = { campaigns: [], sharedBudgets: [], negativeLists: [] }
  const lower = (s: string) => s.trim().toLowerCase()
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const totals = { campaigns: 0, adGroups: 0, keywords: 0, negatives: 0, productGroups: 0, ads: 0, assets: 0 }

  // Names Google keeps unique: campaigns, shared budgets, negative keyword lists (in the account and in the build).
  const unique = (what: string, names: string[], taken: Set<string>) => {
    const seen = new Set<string>()
    for (const n of names) {
      if (taken.has(lower(n))) problems.push(`A ${what} named "${n}" already exists in the account: Google refuses a second one.`)
      if (seen.has(lower(n))) problems.push(`Two ${what}s of the build are named "${n}".`)
      seen.add(lower(n))
    }
  }
  unique('campaign', spec.campaigns.map((c) => c.name), new Set(live.campaigns.map((c) => lower(c.name))))
  unique('budget', (spec.sharedBudgets ?? []).map((b) => b.name), new Set(live.budgets.map((b) => lower(b.name ?? ''))))
  unique('negative keyword list', (spec.negativeLists ?? []).map((l) => l.name), new Set(live.lists.map((l) => lower(l.name ?? ''))))

  // 1. Shared budgets.
  const budgetRefs = new Map<string, { res: string; cents: number; name: string }>()
  for (const b of spec.sharedBudgets ?? []) {
    if (budgetRefs.has(b.ref)) { problems.push(`Budget ref "${b.ref}" is used twice.`); continue }
    const res = `${customer}/campaignBudgets/${temp()}`
    record.sharedBudgets.push({ name: b.name.trim(), budgetId: null, op: ops.length })
    ops.push({ campaignBudgetOperation: { create: { resourceName: res, name: b.name.trim(), amountMicros: microsOfCents(b.budgetCents), explicitlyShared: true, deliveryMethod: 'STANDARD' } } })
    budgetRefs.set(b.ref, { res, cents: b.budgetCents, name: b.name.trim() })
    lines.push([`new shared budget "${b.name.trim()}"`, '(none)', `${money(b.budgetCents, currency)} a day`])
  }

  // 2. Negative keyword lists and their keywords.
  const listRefs = new Map<string, string>()
  for (const l of spec.negativeLists ?? []) {
    if (listRefs.has(l.ref)) { problems.push(`List ref "${l.ref}" is used twice.`); continue }
    const res = `${customer}/sharedSets/${temp()}`
    record.negativeLists.push({ name: l.name.trim(), listId: null, op: ops.length })
    ops.push({ sharedSetOperation: { create: { resourceName: res, name: l.name.trim(), type: 'NEGATIVE_KEYWORDS' } } })
    listRefs.set(l.ref, res)
    const seen = new Set<string>()
    for (const k of l.keywords) {
      const p = keywordTextProblem(k.text)
      if (p) { problems.push(`List "${l.name}": negative "${k.text}" ${p}.`); continue }
      const key = keywordKey(k.text, k.matchType)
      if (seen.has(key)) continue
      seen.add(key)
      ops.push({ sharedCriterionOperation: { create: { sharedSet: res, keyword: { text: k.text.trim(), matchType: k.matchType } } } })
    }
    totals.negatives += seen.size
    lines.push([`new negative keyword list "${l.name.trim()}"`, '(none)', plural(seen.size, 'keyword')])
  }

  // 3. Campaigns.
  let dailyIfEnabled = 0
  const countedBudgets = new Set<string>()
  spec.campaigns.forEach((c, ci) => {
    const where = `campaign ${ci + 1} "${c.name}"`
    let budgetRes: string
    let budgetCents: number | null
    let budgetKey: string
    const budgetOps: GoogleMutateOperation[] = []
    if ('ref' in c.budget) {
      const b = budgetRefs.get(c.budget.ref)
      if (!b) { problems.push(`${where}: budget ref "${c.budget.ref}" is not a budget of the build.`); return }
      budgetRes = b.res; budgetCents = b.cents; budgetKey = b.res
    } else if ('budgetId' in c.budget) {
      const b = live.budgets.find((x) => x.budgetId === (c.budget as { budgetId: string }).budgetId)
      if (!b) { problems.push(`${where}: budget ${c.budget.budgetId} is not in the account.`); return }
      if (!b.shared) { problems.push(`${where}: budget ${c.budget.budgetId} is another campaign's own budget.`); return }
      budgetRes = `${customer}/campaignBudgets/${b.budgetId}`; budgetCents = b.amountCents; budgetKey = budgetRes
    } else {
      budgetRes = `${customer}/campaignBudgets/${temp()}`; budgetCents = c.budget.dailyBudgetCents; budgetKey = budgetRes
      budgetOps.push({ campaignBudgetOperation: { create: { resourceName: budgetRes, amountMicros: microsOfCents(c.budget.dailyBudgetCents), explicitlyShared: false, deliveryMethod: 'STANDARD' } } })
    }
    const request: CampaignCreateRequest = { ...c, budgetId: undefined, dailyBudgetCents: undefined }
    const problem = campaignCreateProblem(request)
    if (problem) { problems.push(`${where}: ${problem}`); return }
    const campaignRes = `${customer}/campaigns/${temp()}`
    ops.push(...budgetOps)
    record.campaigns.push({ name: c.name.trim(), campaignId: null, op: ops.length })
    const created = campaignCreateOperations(customer, request, budgetRes, campaignRes)
    if ('refusal' in created) { problems.push(`${where}: ${created.refusal}`); return }
    ops.push(...created.operations)
    totals.campaigns += 1
    if (budgetCents !== null && !countedBudgets.has(budgetKey)) { dailyIfEnabled += budgetCents; countedBudgets.add(budgetKey) }

    // Campaign negatives and lists.
    const negSeen = new Set<string>()
    for (const n of c.negatives ?? []) {
      const p = keywordTextProblem(n.text)
      if (p) { problems.push(`${where}: negative "${n.text}" ${p}.`); continue }
      const key = keywordKey(n.text, n.matchType)
      if (negSeen.has(key)) continue
      negSeen.add(key)
      ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, keyword: { text: n.text.trim(), matchType: n.matchType } } } })
    }
    totals.negatives += negSeen.size
    for (const l of c.negativeLists ?? []) {
      let res: string | undefined
      if ('ref' in l) res = listRefs.get(l.ref)
      else if (live.lists.some((x) => x.listId === l.listId)) res = `${customer}/sharedSets/${l.listId}`
      if (!res) { problems.push(`${where}: negative keyword list ${'ref' in l ? `ref "${l.ref}"` : l.listId} is not in the build or the account.`); continue }
      ops.push({ campaignSharedSetOperation: { create: { campaign: campaignRes, sharedSet: res } } })
    }

    // Ad groups.
    const isShopping = c.type === 'SHOPPING'
    const groupNames = new Set<string>()
    let open = 0
    for (const g of c.adGroups ?? []) {
      const gWhere = `${where}, ad group "${g.name}"`
      if (groupNames.has(lower(g.name))) { problems.push(`${gWhere}: two ad groups of the campaign have this name.`); continue }
      groupNames.add(lower(g.name))
      if (isShopping && (g.keywords?.length || g.ads?.length)) problems.push(`${gWhere}: a Shopping ad group has no keywords or text ads (its products are its ads).`)
      if (!isShopping && g.productGroups) problems.push(`${gWhere}: product groups are for Shopping ad groups.`)
      const agRes = `${customer}/adGroups/${temp()}`
      ops.push({ adGroupOperation: { create: { resourceName: agRes, campaign: campaignRes, name: g.name.trim(), status: g.status ?? 'ENABLED', type: isShopping ? 'SHOPPING_PRODUCT_ADS' : 'SEARCH_STANDARD', ...(g.defaultBidCents ? { cpcBidMicros: microsOfCents(g.defaultBidCents) } : {}) } } })
      totals.adGroups += 1
      if (isShopping) ops.push({ adGroupAdOperation: { create: { adGroup: agRes, status: 'ENABLED', ad: { shoppingProductAd: {} } } } })
      const kwSeen = new Set<string>()
      for (const k of g.keywords ?? []) {
        const p = keywordTextProblem(k.text)
        if (p) { problems.push(`${gWhere}: keyword "${k.text}" ${p}.`); continue }
        if (k.matchType === 'BROAD' && !spec.allowBroad) { problems.push(`${gWhere}: keyword "${k.text}" is BROAD (refused unless allowBroad).`); continue }
        const key = keywordKey(k.text, k.matchType)
        if (kwSeen.has(key)) continue
        kwSeen.add(key)
        ops.push({ adGroupCriterionOperation: { create: { adGroup: agRes, status: k.status ?? 'ENABLED', keyword: { text: k.text.trim(), matchType: k.matchType }, ...(k.bidCents ? { cpcBidMicros: microsOfCents(k.bidCents) } : {}) } } })
      }
      totals.keywords += kwSeen.size
      const agNeg = new Set<string>()
      for (const n of g.negatives ?? []) {
        const p = keywordTextProblem(n.text)
        if (p) { problems.push(`${gWhere}: negative "${n.text}" ${p}.`); continue }
        const key = keywordKey(n.text, n.matchType)
        if (agNeg.has(key)) continue
        agNeg.add(key)
        ops.push({ adGroupCriterionOperation: { create: { adGroup: agRes, negative: true, keyword: { text: n.text.trim(), matchType: n.matchType } } } })
      }
      totals.negatives += agNeg.size
      if (g.productGroups) {
        const tree = productGroupOperations(customer, agRes, g.productGroups, temp)
        if ('refusal' in tree) problems.push(`${gWhere}: ${tree.refusal}`)
        else { ops.push(...tree.operations); totals.productGroups += tree.operations.length; open += tree.openEverythingElse }
      }
      ;(g.ads ?? []).forEach((ad, ai) => {
        const adProblems = rsaProblems(ad, ai + 1).map((p) => `${gWhere}, ${p}`)
        if (adProblems.length) { problems.push(...adProblems); return }
        ops.push({ adGroupAdOperation: { create: { adGroup: agRes, status: ad.status ?? 'ENABLED', ad: { finalUrls: [ad.finalUrl.trim()], responsiveSearchAd: {
          headlines: ad.headlines.map((t) => ({ text: t.text.trim(), ...(t.pin ? { pinnedField: t.pin } : {}) })),
          descriptions: ad.descriptions.map((t) => ({ text: t.text.trim(), ...(t.pin ? { pinnedField: t.pin } : {}) })),
          ...(ad.path1?.trim() ? { path1: ad.path1.trim() } : {}),
          ...(ad.path2?.trim() ? { path2: ad.path2.trim() } : {}),
        } } } } })
        totals.ads += 1
      })
    }
    if (open) warnings.push(`${where}: ${plural(open, 'product group')} leave "everything else" OPEN: once enabled it can advertise every other product of the feed.`)

    // Campaign assets.
    const assetLines = assetOperations(customer, campaignRes, c.assets, temp)
    if ('refusal' in assetLines) problems.push(`${where}: ${assetLines.refusal}`)
    else { ops.push(...assetLines.operations); totals.assets += assetLines.count }
    lines.push([`new campaign "${c.name.trim()}"`, '(none)', `${c.type === 'SHOPPING' ? 'Standard Shopping' : 'Search'} · PAUSED · ${plural((c.adGroups ?? []).length, 'ad group')}`])
  })

  if (problems.length) return { refusal: `The build cannot be sent as it is (${plural(problems.length, 'problem')}): ${problems.slice(0, 25).join(' · ')}${problems.length > 25 ? ` · … ${problems.length - 25} more` : ''}` }
  if (ops.length > MAX_BUILD_OPERATIONS) return { refusal: `The build holds ${ops.length} operations, more than the ${MAX_BUILD_OPERATIONS} Nexus sends at once. Split it.` }
  const { changes, more } = changeLines(lines)
  if (totals.campaigns) warnings.unshift(`Every campaign is made PAUSED: nothing spends until a person enables one (set-google-status, SPENDS MONEY). Once enabled, their daily budgets add up to ${money(dailyIfEnabled, currency)}.`)
  return {
    summary: `Google Ads build: ${[record.sharedBudgets.length && plural(record.sharedBudgets.length, 'shared budget'), record.negativeLists.length && plural(record.negativeLists.length, 'negative keyword list'), totals.campaigns && `${plural(totals.campaigns, 'campaign')} (PAUSED)`].filter(Boolean).join(', ')} — in one request.`,
    changes,
    totals: { operations: ops.length, ...totals, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    operations: ops,
    stands: {
      // The names the build takes must still be free; nothing else of the account is changed.
      names: [...spec.campaigns.map((c) => `c:${lower(c.name)}`), ...(spec.sharedBudgets ?? []).map((b) => `b:${lower(b.name)}`), ...(spec.negativeLists ?? []).map((l) => `l:${lower(l.name)}`)].sort(),
      budgets: live.budgets.filter((b) => spec.campaigns.some((c) => 'budgetId' in c.budget && c.budget.budgetId === b.budgetId)).map((b) => `${b.budgetId}:${b.amountCents}:${b.shared}`).sort(),
      lists: live.lists.filter((l) => spec.campaigns.some((c) => (c.negativeLists ?? []).some((x) => 'listId' in x && x.listId === l.listId))).map((l) => l.listId).sort(),
    },
    before: null,
    after: record,
  }
}

/** The ids Google gave what the build made, by the operation that made each. */
export function buildRecordAfterRun(after: BuildRecord, responses: GoogleMutateResponse[]): BuildRecord {
  const idAt = (op: number, kind: string) => {
    const name = responses[op]?.[kind]?.resourceName
    return name ? name.slice(name.lastIndexOf('/') + 1) : null
  }
  return {
    campaigns: after.campaigns.map((c) => ({ ...c, campaignId: idAt(c.op, 'campaignResult') })),
    sharedBudgets: after.sharedBudgets.map((b) => ({ ...b, budgetId: idAt(b.op, 'campaignBudgetResult') })),
    negativeLists: after.negativeLists.map((l) => ({ ...l, listId: idAt(l.op, 'sharedSetResult') })),
  }
}

// ── product groups ──────────────────────────────────────────────────────────────────────────────────────────────

function productGroupOperations(
  customer: string,
  adGroupRes: string,
  pg: BuildProductGroups,
  temp: () => number,
): { operations: GoogleMutateOperation[]; openEverythingElse: number } | { refusal: string } {
  const adGroupId = adGroupRes.slice(adGroupRes.lastIndexOf('/') + 1)
  const res = () => `${customer}/adGroupCriteria/${adGroupId}~${temp()}`
  const ops: GoogleMutateOperation[] = []
  if ('nodes' in pg) {
    // A copy: every node again, in an order where a parent comes before its children.
    const made: string[] = []
    let open = 0
    for (const [i, n] of pg.nodes.entries()) {
      if (n.parent !== null && (n.parent >= i || !made[n.parent])) return { refusal: 'the product group tree to copy lists a child before its parent.' }
      const name = res()
      made[i] = name
      // "Everything else": a child whose dimension carries no value (`{ productItemId: {} }`, `{ productType: { level } }`).
      const isRest = n.parent !== null && Object.values(n.caseValue ?? {}).every((v) => (v as { value?: unknown } | null)?.value == null)
      if (n.kind === 'UNIT' && isRest && !n.excluded) open += 1
      ops.push({ adGroupCriterionOperation: { create: {
        resourceName: name, status: 'ENABLED',
        ...(n.kind === 'UNIT' && n.excluded ? { negative: true } : {}),
        ...(n.kind === 'UNIT' && !n.excluded && n.bidCents ? { cpcBidMicros: microsOfCents(n.bidCents) } : {}),
        listingGroup: { type: n.kind, ...(n.parent !== null ? { parentAdGroupCriterion: made[n.parent] } : {}), ...(n.caseValue ? { caseValue: n.caseValue } : {}) },
      } } })
    }
    return { operations: ops, openEverythingElse: open }
  }
  // Item ids once, compared without case (Merchant Center may read ids differing only by case as one); the first spelling.
  const byKey = new Map<string, string>()
  for (const id of pg.itemIds) if (id.trim() && !byKey.has(id.trim().toLowerCase())) byKey.set(id.trim().toLowerCase(), id.trim())
  const ids = [...byKey.values()]
  if (!ids.length) return { refusal: 'product groups need at least one item id.' }
  if (ids.some((id) => id.length > 50 || id.includes('==') || id.includes('&+'))) return { refusal: 'an item id is longer than 50 characters or holds "==" or "&+".' }
  const root = res()
  ops.push({ adGroupCriterionOperation: { create: { resourceName: root, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' } } } })
  const rest = pg.includeEverythingElse
  ops.push({ adGroupCriterionOperation: { create: {
    resourceName: res(), status: 'ENABLED', ...(rest ? { cpcBidMicros: microsOfCents(rest.bidCents) } : { negative: true }),
    listingGroup: { type: 'UNIT', parentAdGroupCriterion: root, caseValue: { productItemId: {} } },
  } } })
  const bidOf = new Map((pg.itemBids ?? []).map((b) => [b.itemId.trim().toLowerCase(), b.bidCents]))
  for (const id of ids) {
    ops.push({ adGroupCriterionOperation: { create: {
      resourceName: res(), status: 'ENABLED', cpcBidMicros: microsOfCents(bidOf.get(id.toLowerCase()) ?? pg.bidCents),
      listingGroup: { type: 'UNIT', parentAdGroupCriterion: root, caseValue: { productItemId: { value: id } } },
    } } })
  }
  return { operations: ops, openEverythingElse: rest ? 1 : 0 }
}

// ── campaign assets ─────────────────────────────────────────────────────────────────────────────────────────────

function assetOperations(
  customer: string,
  campaignRes: string,
  assets: BuildCampaign['assets'],
  temp: () => number,
): { operations: GoogleMutateOperation[]; count: number } | { refusal: string } {
  if (!assets) return { operations: [], count: 0 }
  const problems: string[] = []
  const ops: GoogleMutateOperation[] = []
  const links: GoogleMutateOperation[] = []
  const L = ASSET_LIMITS
  const add = (fieldType: AssetFieldType, body: Record<string, unknown>) => {
    const res = `${customer}/assets/${temp()}`
    ops.push({ assetOperation: { create: { resourceName: res, ...body } } })
    links.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: res, fieldType } } })
  }
  for (const [i, s] of (assets.sitelinks ?? []).entries()) {
    const where = `sitelink ${i + 1}`
    const d1 = s.description1?.trim() ?? ''
    const d2 = s.description2?.trim() ?? ''
    for (const p of [widthProblem(`${where} text`, s.linkText, L.linkText), d1 ? widthProblem(`${where} description 1`, d1, L.sitelinkDescription) : null, d2 ? widthProblem(`${where} description 2`, d2, L.sitelinkDescription) : null, httpsUrlProblem(where, s.finalUrl)]) if (p) problems.push(p)
    if (!!d1 !== !!d2) problems.push(`${where}: give both descriptions or neither`)
    add('SITELINK', { finalUrls: [s.finalUrl.trim()], sitelinkAsset: { linkText: s.linkText.trim(), ...(d1 && d2 ? { description1: d1, description2: d2 } : {}) } })
  }
  for (const [i, c] of (assets.callouts ?? []).entries()) {
    const p = widthProblem(`callout ${i + 1}`, c, L.callout)
    if (p) problems.push(p)
    add('CALLOUT', { calloutAsset: { calloutText: c.trim() } })
  }
  for (const [i, s] of (assets.structuredSnippets ?? []).entries()) {
    const header = snippetHeader(s.header, s.language ?? 'en')
    if ('problem' in header) { problems.push(`structured snippet ${i + 1}: ${header.problem}`); continue }
    const values = s.values.map((v) => v.trim()).filter(Boolean)
    if (values.length < L.minSnippetValues || values.length > L.maxSnippetValues) problems.push(`structured snippet ${i + 1}: ${values.length} values (Google takes ${L.minSnippetValues}–${L.maxSnippetValues})`)
    for (const v of values) { const p = widthProblem(`structured snippet ${i + 1} value "${v}"`, v, L.snippetValue); if (p) problems.push(p) }
    add('STRUCTURED_SNIPPET', { structuredSnippetAsset: { header: header.header, values } })
  }
  for (const l of assets.link ?? []) links.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: `${customer}/assets/${l.assetId}`, fieldType: l.fieldType } } })
  if (problems.length) return { refusal: problems.join(' · ') }
  return { operations: [...ops, ...links], count: links.length }
}
