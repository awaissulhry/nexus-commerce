/**
 * Where a harvested term can go — the options of the `DestinationPicker` (Keyword Harvest page F2, 2026-10-10). Pure,
 * tested in Node.
 *
 * Input: `GET /api/advertising/harvest/destinations?market=&productId=` (lane HCORE, `02-harvest/HCORE-API.md`): the
 * product's portfolio → campaign → ad group tree in one market. The Owner's structure (10-09) is one portfolio per
 * product and one campaign per match type with ONE ad group, so a two-level list is enough: a GROUP per portfolio, an
 * OPTION per "Campaign › Ad group" (ad group names repeat across campaigns, so the campaign is always named).
 *
 * The rules:
 *   - "Suggested" first: the place the server suggests (or its proposed new campaign), taken out of its portfolio group;
 *   - then each portfolio in the server's order, then "No portfolio" (the product's campaigns outside one);
 *   - HELD, never hidden: a place the server holds (the term's own source, an auto campaign, paused, archived, has the
 *     term already, another product's) stays in the list, says why, and cannot be picked;
 *   - the value is the preview body's `to`: `{ adGroupId }` or `{ newCampaign: key }`.
 */

/** `{ id, name, href? }`; `href` without the `/w/<id>` prefix. */
export interface HarvestRef { id: string; name: string; href?: string | null }
export type HarvestRole = 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT' | 'PRODUCT'
export type HarvestMatch = 'EXACT' | 'PHRASE'
/** Why a place cannot take the term: `label` a few words ("Found here"), `reason` the sentence. */
export interface HarvestHeld { label: string; reason: string }

export interface DestinationAdGroup extends HarvestRef {
  role: HarvestRole | null
  keywords: number
  productTargets: number
  serving: boolean | null
  held: HarvestHeld | null
  suggested: boolean
}
export interface DestinationCampaign extends HarvestRef {
  status: string
  serving: boolean | null
  role: HarvestRole | null
  /** Money key: absent without `financials.adspend.view`. */
  dailyBudgetCents?: number | null
  biddingStrategy: string | null
  adGroups: DestinationAdGroup[]
}
export interface DestinationPortfolio extends HarvestRef { campaigns: DestinationCampaign[] }
export interface DestinationNewCampaign {
  name: string
  adGroupName: string
  portfolio: HarvestRef | null
  dailyBudgetCents?: number | null
  held: HarvestHeld | null
}
export interface DestinationStored {
  grain: string
  scopeId: string
  match: HarvestMatch | null
  adGroup: HarvestRef | null
  negateAtSource: boolean
}
/** The `/destinations` answer. */
export interface HarvestDestinations {
  market: string
  product: HarvestRef
  match: HarvestMatch
  suggested: { kind: 'existing'; adGroupId: string } | { kind: 'new' } | null
  portfolios: DestinationPortfolio[]
  unplaced: DestinationCampaign[]
  newCampaign: DestinationNewCampaign
  stored: DestinationStored[]
}

/** The preview body's `to`. */
export type HarvestTo = { adGroupId: string } | { newCampaign: string }
/** A new campaign the page has planned in this window (its preview `newCampaigns[].key`). */
export interface PlannedCampaign { key: string; name: string }

export const SUGGESTED_GROUP = 'Suggested'
export const NO_PORTFOLIO_GROUP = 'No portfolio'
export const PLANNED_GROUP = 'New campaigns'
/** The key of the server's proposed new campaign when the page has not named one. */
export const DEFAULT_NEW_KEY = 'new'

export interface DestinationOption {
  /** `ag:<adGroupId>` or `new:<key>` — see `toValue` / `fromValue`. */
  value: string
  /** "Campaign › Ad group", or "New campaign · <name>". */
  label: string
  group: string
  /** Portfolio, campaign and ad group names and the match word, so any of them finds it. */
  searchText: string
  /** The match chip's word, or null when the place has no keyword match (unknown). */
  match: string | null
  /** Held: the sentence (announced, shown under the label) and the few words shown at the end of the row. */
  heldReason?: string
  heldLabel?: string
  suggested: boolean
}

const MATCH_WORDS: Record<HarvestRole, string> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad', AUTO: 'Auto', PRODUCT: 'Product' }
export const matchWord = (role: HarvestRole | null | undefined): string | null => (role ? MATCH_WORDS[role] ?? null : null)

export const placeLabel = (campaign: HarvestRef, adGroup: HarvestRef): string => `${campaign.name} › ${adGroup.name}`
export const newCampaignLabel = (name: string): string => `New campaign · ${name}`

export function toValue(to: HarvestTo): string {
  return 'adGroupId' in to ? `ag:${to.adGroupId}` : `new:${to.newCampaign}`
}
export function fromValue(value: string): HarvestTo | null {
  if (value.startsWith('ag:') && value.length > 3) return { adGroupId: value.slice(3) }
  if (value.startsWith('new:') && value.length > 4) return { newCampaign: value.slice(4) }
  return null
}

/** Every ad group of the tree with its campaign and portfolio, in the server's order (portfolios, then unplaced). */
export function destinationPlaces(tree: HarvestDestinations): Array<{ portfolio: HarvestRef | null; campaign: DestinationCampaign; adGroup: DestinationAdGroup }> {
  const out: Array<{ portfolio: HarvestRef | null; campaign: DestinationCampaign; adGroup: DestinationAdGroup }> = []
  for (const p of tree.portfolios) for (const c of p.campaigns) for (const g of c.adGroups) out.push({ portfolio: p, campaign: c, adGroup: g })
  for (const c of tree.unplaced) for (const g of c.adGroups) out.push({ portfolio: null, campaign: c, adGroup: g })
  return out
}

export interface DestinationOptionsInput {
  /** New campaigns already planned in this window, listed as places of their own. */
  planned?: readonly PlannedCampaign[]
  /** The key the server's proposed new campaign gets when picked from "Suggested". Default `DEFAULT_NEW_KEY`. */
  newCampaignKey?: string
}

/** The picker's options, Suggested first, then per portfolio, then "No portfolio", then planned new campaigns. */
export function destinationOptions(tree: HarvestDestinations | null | undefined, input: DestinationOptionsInput = {}): DestinationOption[] {
  if (!tree) return []
  const newKey = input.newCampaignKey ?? DEFAULT_NEW_KEY
  const suggestedId = tree.suggested?.kind === 'existing' ? tree.suggested.adGroupId : null
  const suggested: DestinationOption[] = []
  const rest: DestinationOption[] = []
  for (const { portfolio, campaign, adGroup } of destinationPlaces(tree)) {
    const word = matchWord(adGroup.role ?? campaign.role)
    const isSuggested = adGroup.suggested || adGroup.id === suggestedId
    const option: DestinationOption = {
      value: toValue({ adGroupId: adGroup.id }),
      label: placeLabel(campaign, adGroup),
      group: isSuggested ? SUGGESTED_GROUP : portfolio?.name || NO_PORTFOLIO_GROUP,
      searchText: [portfolio?.name, campaign.name, adGroup.name, word].filter(Boolean).join(' '),
      match: word,
      suggested: isSuggested,
      ...(adGroup.held ? { heldReason: adGroup.held.reason, heldLabel: adGroup.held.label } : {}),
    }
    ;(isSuggested ? suggested : rest).push(option)
  }
  if (tree.suggested?.kind === 'new') {
    const plan = tree.newCampaign
    suggested.unshift({
      value: toValue({ newCampaign: newKey }),
      label: newCampaignLabel(plan.name),
      group: SUGGESTED_GROUP,
      searchText: [plan.portfolio?.name, plan.name, plan.adGroupName, matchWord(tree.match)].filter(Boolean).join(' '),
      match: matchWord(tree.match),
      suggested: true,
      ...(plan.held ? { heldReason: plan.held.reason, heldLabel: plan.held.label } : {}),
    })
  }
  const planned = (input.planned ?? []).filter((p) => p.key !== newKey || tree.suggested?.kind !== 'new').map((p): DestinationOption => ({
    value: toValue({ newCampaign: p.key }),
    label: newCampaignLabel(p.name),
    group: PLANNED_GROUP,
    searchText: `${p.name} ${matchWord(tree.match) ?? ''}`.trim(),
    match: matchWord(tree.match),
    suggested: false,
  }))
  // A held suggestion is still listed first, with its reason: the operator sees what would have been chosen and why not.
  // One option per place, even if the tree names a place twice.
  const seen = new Set<string>()
  return [...suggested, ...rest, ...planned].filter((o) => !seen.has(o.value) && (seen.add(o.value), true))
}

/**
 * The place to start on: the suggested ad group when it can take the term, else the server's proposed new campaign
 * when it is suggested and not held, else nothing (the operator picks).
 */
export function suggestedTo(tree: HarvestDestinations | null | undefined, newCampaignKey = DEFAULT_NEW_KEY): HarvestTo | null {
  if (!tree?.suggested) return null
  if (tree.suggested.kind === 'new') return tree.newCampaign.held ? null : { newCampaign: newCampaignKey }
  const id = tree.suggested.adGroupId
  const place = destinationPlaces(tree).find((p) => p.adGroup.id === id)
  return place && !place.adGroup.held ? { adGroupId: id } : null
}

/**
 * Block the term where it ran ("In source")? On by default (the Owner's 10-08 standard). A stored destination with
 * `negateAtSource = false` still wins (the Owner's setting) — shown off, with the reason, and switchable on the page.
 */
export function negateAtSourceFor(tree: HarvestDestinations | null | undefined, to: HarvestTo | null, match?: HarvestMatch): { on: boolean; why: string | null } {
  if (!tree || !to || !('adGroupId' in to)) return { on: true, why: null }
  const off = tree.stored.some((s) => s.adGroup?.id === to.adGroupId && s.negateAtSource === false && (!match || !s.match || s.match === match))
  return off ? { on: false, why: 'Off for this destination: your setting' } : { on: true, why: null }
}

/** The words for a chosen place ("Campaign › Ad group" or "New campaign · name"); null when it is not in the tree. */
export function destinationLabel(tree: HarvestDestinations | null | undefined, to: HarvestTo | null, planned: readonly PlannedCampaign[] = [], newCampaignKey = DEFAULT_NEW_KEY): string | null {
  if (!tree || !to) return null
  if ('newCampaign' in to) {
    const plan = planned.find((p) => p.key === to.newCampaign)
    if (plan) return newCampaignLabel(plan.name)
    return to.newCampaign === newCampaignKey ? newCampaignLabel(tree.newCampaign.name) : null
  }
  const place = destinationPlaces(tree).find((p) => p.adGroup.id === to.adGroupId)
  return place ? placeLabel(place.campaign, place.adGroup) : null
}
