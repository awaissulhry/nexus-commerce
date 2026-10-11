/**
 * HARVEST ENGINE — the names and lists every part of the engine shares.
 */
import { FIELDS } from '@nexus/shared/permissions'

/** The one request a harvest change set (or its undo) goes out as: the page and Claude the same (harvest/tool.ts). */
export const ENGINE_TOOL = 'apply-harvest'
/** The brain's own request for one of its pairs (services/agents/tools/ads-brain-harvest.tools.ts). */
export const BRAIN_HARVEST_TOOL = 'apply-brain-harvest'
/** The builder the brain asks for a new harvest campaign. */
export const BRAIN_CAMPAIGN_TOOL = 'create-ad-campaign'
/** The older names a harvest is asked with: doors onto the engine (they run apply-harvest's dry run and run — lane HMCP's
 *  ads-harvest-alias.ts). Their request stores the engine's preview, items and all. */
export const HARVEST_ALIAS_TOOLS: readonly string[] = ['harvest-search-term', 'graduate-keyword']
/** The requests the page may decide on its "Waiting for you" tile (POST /waiting/decide). */
export const HARVEST_TOOLS: readonly string[] = [ENGINE_TOOL, BRAIN_HARVEST_TOOL, BRAIN_CAMPAIGN_TOOL, ...HARVEST_ALIAS_TOOLS]

/** Approval statuses of a request still waiting or about to run. */
export const OPEN_APPROVAL: readonly string[] = ['pending', 'scheduled', 'approved', 'executing']

/** Harvest record statuses: in flight (a request, a write, a build), placed for good, ended. */
export const IN_FLIGHT: readonly string[] = ['WRITING', 'CAMPAIGN_BUILT', 'HALF_DONE']
export const PLACED: readonly string[] = ['DONE', 'HALF_DONE']

/** Ad-spend money of the harvest answers: hidden whole from a person without financials.adspend.view. */
export const HARVEST_MONEY: Readonly<Record<string, string>> = Object.fromEntries(
  ['spendCents', 'salesCents', 'acosPct', 'cpcCents', 'bidCents', 'startBidCents', 'dailyBudgetCents', 'capMonthlyCents', 'maxAcosPct', 'fromCents', 'toCents', 'money']
    .map((key) => [key, FIELDS.financialsAdspendView]),
)

/** The page's verdict words for a judged harvest. */
export type Verdict = 'better' | 'worse' | 'too-early'
export const verdictOf = (v: string | null | undefined): Verdict | null => (v === 'KEPT' ? 'better' : v === 'WORSE' ? 'worse' : v === 'WAITING' ? 'too-early' : null)

/** Who a harvest record's actor is, for the page. */
export const actorName = (kind: string, id: string | null, names: ReadonlyMap<string, string> = new Map()): string =>
  kind === 'BRAIN' ? 'Brain' : kind === 'CLAUDE' ? 'Claude' : kind === 'RULE' ? (id ? names.get(id) ?? 'Rule' : 'Rule') : (id ? names.get(id) ?? 'Person' : 'Person')

/** The candidates the page lists by default: the open work and what was harvested. */
export const DEFAULT_STATES = ['READY', 'NEEDS_DESTINATION', 'NEEDS_CAMPAIGN', 'HELD', 'WAITING', 'IN_FLIGHT', 'HARVESTED'] as const
export const ALL_STATES = [...DEFAULT_STATES, 'AT_HOME', 'OWNED_BY_SIBLING', 'BELOW_BAR', 'SKIPPED'] as const
export type CandidateState = (typeof ALL_STATES)[number]
