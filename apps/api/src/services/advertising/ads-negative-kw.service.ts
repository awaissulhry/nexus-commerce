/**
 * Phase J — Create negative keywords on Amazon SP campaigns.
 *
 * Phase J.1 probes confirmed:
 *   - v1 unified /negativeTargets is gateway-blocked (Atza| JWT issue)
 *   - SP v3 /sp/negativeKeywords + /sp/campaignNegativeKeywords accept
 *     our LWA token (same gateway as the working /sp/campaigns/list)
 *   - SB v4 negativeKeywords is also blocked; SD has no concept
 *
 * Scope of this service: SP only, covering ~89% of campaigns in the
 * IT account. SB negatives need Amazon to unblock the v1 gateway
 * (separate concern, deferred).
 * W4-11 — no longer only: for a caller that may change SB/SD (`allowSbSd`, Claude's add-negative-targets), a negative
 * keyword in a Sponsored Brands ad group goes to SB 3.0's own POST /sb/negativeKeywords and a negative product target in
 * a Sponsored Display ad group to SD 3.0's POST /sd/negativeTargets (ads-api-client.ts), through the same order below.
 *
 * 5b — THE ONE NEGATIVE WRITE SERVICE (review 7.1, 7.5, 7.6, 7.12). Every Nexus path that adds a negative — the
 * launches, bulk negatives, the bulk sheet, blueprints, AI goals, the launch repair, harvest, the rules, n-grams, the
 * funnel, the route and the MCP tools — comes through `writeNegativeKeyword` / `writeNegativeProductTarget`, or through
 * `createNegative`, the push-only wrapper whose callers record the row themselves. One order for all of them:
 *
 *   validate  Amazon's text limits, an ASIN is a product and not a keyword, protected terms (ads-negation-policy.ts),
 *             and PB-6a's own-keyword rule: a negative never blocks a positive where it lands (an exact negative the
 *             EXACT keyword of its text, a phrase negative any keyword holding its words, a negative product target
 *             the product target of its ASIN; campaign scope: in any ad group of the campaign) — refused by name for
 *             everyone, a person included, with the keyword it would block (ads-winner-lock.ts ownKeywordRefusal)
 *   dedupe    a standing negative with this text and match type at this level: case-insensitive, both match-type
 *             spellings. An ARCHIVED one is absent, so a retired negative can be added again. A row whose retire
 *             failed (`retiredAt` set, still ENABLED) still stands: 5f decides on status, and so does this.
 *   policy    the converting guard, when the caller asks for it (`protectConverting`)
 *   gate      checkAdsWriteGate with the campaign's id, so the live-write allowlist binds a negative like any other
 *             write. A campaign launched in the same request passes `creationFlow`, as its keywords and product ads do.
 *             ONE BRAIN AB-5 — it names the `negatives` lever and who adds it (`userId`, `actor`): on a campaign whose
 *             negatives a product's brain owns, or the Owner locked, another engine's negative is refused; a person's passes.
 *   Amazon    the SP v3 create; a create that comes back without an id is read back before it is believed
 *   record    the local AdTarget row and its audit row, with `reachedAmazon`
 *
 * A refused negative leaves nothing behind: no local row, no audit row, no Amazon call. Before this a gate refusal
 * still wrote the local row (createNegativeKeywordLocal, the bulk sheet's campaign negative): a negative Nexus showed
 * and no auction honoured. A campaign or ad group with no Amazon ids yet (a launch the gate held back) keeps a local
 * row: the launch repair pushes it later through `pushLocalNegative`, which runs the same checks.
 *
 * `scripts/check-negative-write-path.mjs` holds the rest at zero: no client negative creator, no POST to a negative
 * endpoint and no `adTarget.create({ isNegative: true })` outside this file, the client, the policy and the syncs.
 *
 * Negative Targeting (2026-10-11, lane NWRITE) — the AUTHOR of every negative this door makes is stored on its row
 * (`AdTarget.negativeOrigin`, negativeOriginOf): HARVEST · BRAIN_FUNNEL · BRAIN · PLAYBOOK · RULE · CLAUDE · PERSON, from the
 * caller's actor and source (and, for an approved request, its approval's tool and door). The page and retire-negatives
 * read it: a Harvest or Brain-funnel negative is never lifted without saying so. `createNegative` (push-only) records the
 * row and its audit row too when its caller asks (`record`): the legacy rule path, the account-wide sync and the route
 * used to leave neither (no row until the next sync, then "unattributed"; no undo).
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  liveCall, adsMode, listNegativeKeywords,
  createNegativeKeyword as sendNegativeKeyword, createNegativeProductTarget as sendNegativeProductTarget,
  createSbNegativeKeyword as sendSbNegativeKeyword, createSdNegativeTarget as sendSdNegativeTarget,
  type AdsRegion, type ClientContext,
} from './ads-api-client.js'
import { BRAIN_HARVEST_ACTOR, checkAdsWriteGate, ownLimitsSentence, type OwnLimit } from './ads-write-gate.js'
import { isPersonCreate } from './ads-mutation.service.js'
import { assertNegativeWriteAllowed, isAsin, negativeKeywordTextProblem, protectedNegativeRefusal } from './ads-negation-policy.js'
import { checkProtectConverting, normaliseNegTerm, type ProtectConvertingConfig } from './ads-protect-converting.js'
import { packEvidence, type AdWriteEvidence } from './ads-evidence.js'
import { ownKeywordRefusal } from './ads-winner-lock.js'
import { SPONSORED_BRANDS, SPONSORED_DISPLAY, adProductOf, type AdWrite } from '@nexus/shared/ads-ad-product'

export type NegativeMatchType = 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'
export type NegativeScope = 'AD_GROUP' | 'CAMPAIGN'

// ── Who made a negative (Negative Targeting, 2026-10-11) ─────────────────────────────────────────────────────────

/** The authors a negative's row names (AdTarget.negativeOrigin). */
export const NEGATIVE_ORIGINS = ['HARVEST', 'BRAIN_FUNNEL', 'BRAIN', 'PLAYBOOK', 'RULE', 'CLAUDE', 'PERSON'] as const
export type NegativeOrigin = (typeof NEGATIVE_ORIGINS)[number]

/** What a writer says about itself, from which the door decides the author. */
export interface NegativeOriginSource {
  /** Said outright by the caller (wins). */
  origin?: NegativeOrigin | null
  /** The actor: `user:<id>`, `automation:<ruleId>`, an engine's `automation:<name>`. */
  userId?: string | null
  evidence?: AdWriteEvidence | null
  /** A launch's own negatives (a playbook build, the SP wizard, an AI goal, a single launch). */
  creationFlow?: boolean
  /** The approval this write runs for: its tool, the door its request came through, the run's agent. */
  approval?: { toolName?: string | null; via?: string | null; agentKey?: string | null } | null
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v : v != null && typeof v === 'object' ? JSON.stringify(v) : '')

/**
 * The author of a negative (pure), in this order: what the caller says; a harvest (any source naming a harvest — the brain's
 * harvest writer, a rule's harvest, harvest-search-term, apply-brain-harvest) → HARVEST; the brain's match-type funnel →
 * BRAIN_FUNNEL; the ads brain otherwise (its actor, its request "Ads brain: …", its run) → BRAIN; a launch or a playbook
 * (creationFlow, isolation and playbook sync) → PLAYBOOK; any other automation actor → RULE; a request Claude (or the
 * agent fleet) asked for → CLAUDE; a person → PERSON. Null: nothing to go on.
 */
export function negativeOriginOf(s: NegativeOriginSource): NegativeOrigin | null {
  if (s.origin && (NEGATIVE_ORIGINS as readonly string[]).includes(s.origin)) return s.origin
  const actor = (s.userId ?? '').trim()
  const ev = (s.evidence ?? null) as Record<string, unknown> | null
  const words = [ev?.metric, ev?.note, ev?.targetKey, ev?.source].map(textOf).filter(Boolean).join(' ')
  const tool = s.approval?.toolName ?? ''
  const agent = s.approval?.agentKey ?? ''
  if (actor === BRAIN_HARVEST_ACTOR || /harvest/i.test(actor) || /harvest/i.test(words) || /harvest/i.test(tool) || /harvest/i.test(agent)) return 'HARVEST'
  if (/match-type funnel/i.test(words)) return 'BRAIN_FUNNEL'
  if (actor.startsWith('automation:ads-brain') || /\bads brain\b/i.test(words) || agent.startsWith('ads-brain')) return 'BRAIN'
  if (s.creationFlow === true || /playbook/i.test(actor) || /playbook|\bisolation:/i.test(words) || /playbook/i.test(tool)) return 'PLAYBOOK'
  if (actor.startsWith('automation:')) return 'RULE'
  const via = s.approval?.via ?? null
  if (via === 'claude' || via === 'fleet') return 'CLAUDE'
  if (actor) return 'PERSON'
  return null
}

/**
 * The author of a negative this door is about to record: negativeOriginOf, reading the approval behind `changeSetId`
 * (its tool, door and agent) only when the caller's own words do not settle it. Never throws: null when nothing tells.
 */
async function originFor(s: NegativeOriginSource & { changeSetId?: string | null }): Promise<NegativeOrigin | null> {
  const first = negativeOriginOf(s)
  if (first && first !== 'PERSON') return first
  if (!s.changeSetId) return first
  try {
    const approval = await prisma.agentApproval.findUnique({ where: { id: s.changeSetId }, select: { toolName: true, agentRun: { select: { via: true, agentKey: true } } } })
    if (!approval) return first
    return negativeOriginOf({ ...s, approval: { toolName: approval.toolName, via: approval.agentRun?.via ?? null, agentKey: approval.agentRun?.agentKey ?? null } })
  } catch {
    return first
  }
}

/**
 * Who made each negative (Negative Targeting): its stored author, or — for a row made before 2026-10-11 — the brain's
 * own records (its negatives log: the funnel or another reason; its harvest pairs' source negatives). Null: not known.
 */
export async function negativeOriginsOf(ids: readonly string[]): Promise<Map<string, NegativeOrigin | null>> {
  const out = new Map<string, NegativeOrigin | null>()
  if (!ids.length) return out
  const rows = await prisma.adTarget.findMany({ where: { id: { in: [...ids] } }, select: { id: true, negativeOrigin: true } })
  for (const r of rows) out.set(r.id, (NEGATIVE_ORIGINS as readonly string[]).includes(r.negativeOrigin ?? '') ? r.negativeOrigin as NegativeOrigin : null)
  const unknown = ids.filter((id) => !out.get(id))
  if (!unknown.length) return out
  // The brain's own records, for rows made before the author was stored. A failed read leaves them not known (logged).
  try {
    const brain = await prisma.adsBrainNegative.findMany({ where: { adTargetId: { in: unknown }, action: 'ADD' }, select: { adTargetId: true, reason: true, reasons: true } })
    for (const b of brain) if (b.adTargetId && !out.get(b.adTargetId)) out.set(b.adTargetId, b.reason === 'funnel' || b.reasons.includes('funnel') ? 'BRAIN_FUNNEL' : 'BRAIN')
    const still = unknown.filter((id) => !out.get(id))
    if (still.length) {
      const harvests = await prisma.adsBrainHarvest.findMany({ select: { sources: true }, where: { status: { notIn: ['UNDONE'] } }, take: 5000 })
      const sourceNegatives = new Set(harvests.flatMap((h) => (Array.isArray(h.sources) ? h.sources as Array<{ negativeTargetId?: unknown }> : []).map((x) => String(x?.negativeTargetId ?? ''))).filter(Boolean))
      for (const id of still) if (sourceNegatives.has(id)) out.set(id, 'HARVEST')
    }
  } catch (error) {
    logger.warn('[ads-negative-kw] the brain\'s records of who made a negative could not be read', { error: (error as Error).message })
  }
  for (const id of ids) if (!out.has(id)) out.set(id, null)
  return out
}

export interface CreateNegativeArgs {
  profileId: string
  region?: AdsRegion
  /** Required for AD_GROUP scope; ignored for CAMPAIGN scope. */
  externalAdGroupId?: string
  externalCampaignId: string
  keywordText: string
  matchType: NegativeMatchType
  scope: NegativeScope
  /** Marketplace code (e.g. APJ6JRA9NG5V4) — needed by the write gate. */
  marketplace: string
  /**
   * MCP full control A5 — the Nexus Campaign.id, when the caller has it. 5b: the campaign is always resolved now (from
   * this, else from `externalCampaignId`) and handed to the write gate, so the live-write allowlist binds every negative.
   */
  nexusCampaignId?: string
  /** 1e — a person's own add from a screen (isPersonCreate): passes the halt and autonomy OFF. Set only by the routes. */
  manual?: boolean
  /**
   * ONE BRAIN AB-5 — who adds it (a rule's `automation:<ruleId>`, an engine's, a person's `user:<id>`): the write gate names
   * it when a product's brain owns the campaign's negatives. Absent: an unnamed automatic writer (a person passes by `manual`).
   */
  actor?: string | null
  /**
   * Negative Targeting (2026-10-11) — record the row and its audit row here, as writeNegativeKeyword does (the author
   * stored), for a caller that kept neither: who adds it (`userId`), the measurement, the change set (undo finds it).
   * Absent: push-only, as before (the n-gram page and the rules' builder path record their own).
   */
  record?: { userId?: string | null; evidence?: AdWriteEvidence | null; changeSetId?: string | null; origin?: NegativeOrigin | null } | null
}

export interface CreateNegativeResult {
  ok: boolean
  mode: 'sandbox' | 'live'
  /** Set when Amazon returns a new keywordId for the created negative. */
  externalNegativeKeywordId: string | null
  /** Set when the negative already existed locally (idempotent skip). */
  alreadyExisted: boolean
  /** Set when the write gate (or 5b's checks before it) denied the call. */
  denied: { reason: string; deniedAt: string } | null
  rawResponse: unknown
  /** Negative Targeting — with `record`: the local row (new, or the standing one); null when nothing was recorded. */
  adTargetId?: string | null
}

/** 5b — what became of one negative. A refusal or a failure wrote nothing here. */
export interface NegativeWriteResult {
  outcome: 'created' | 'local' | 'already_existed' | 'refused' | 'failed'
  /** 'local' — the campaign or ad group has no Amazon ids yet, so nothing was sent. */
  mode: 'sandbox' | 'live' | 'local'
  /** Amazon's id, only when Amazon confirmed the negative; never a sandbox stub. */
  externalTargetId: string | null
  /** `externalTargetId != null`: the external id, never the fact that a create was sent. */
  reachedAmazon: boolean
  /** The local row: the new one, or the standing negative for `already_existed`; null when nothing was written. */
  adTargetId: string | null
  /** W1-7 + 3A — with `deniedAt: 'needs_confirmation'`: the person's own limits it goes past (his "Send anyway" sends it). */
  refusal: { deniedAt: string; reason: string; limits?: OwnLimit[] } | null
  error: string | null
  rawResponse: unknown
}

export interface WriteNegativeKeywordArgs {
  scope: NegativeScope
  /** Where it lands: a Nexus ad group (for CAMPAIGN scope, any ad group of the campaign) or campaign, or Amazon's ids. */
  adGroupId?: string
  campaignId?: string
  externalCampaignId?: string
  externalAdGroupId?: string
  keywordText: string
  matchType: 'EXACT' | 'PHRASE' | NegativeMatchType
  /** NEG.0(a) — refuse a term that converted, when the caller's rule or screen asks for it. Absent = not asked here. */
  protectConverting?: ProtectConvertingConfig | null
  /** A campaign created in this same request: its negatives are part of the creation, so the allowlist is not asked. */
  creationFlow?: boolean
  /** Defaults to the market's Amazon Ads profile. */
  profileId?: string | null
  region?: AdsRegion
  userId?: string | null
  evidence?: AdWriteEvidence | null
  /** 1e — a person's own add from a screen or an upload (isPersonCreate). Set only by the routes. */
  manual?: boolean
  /** PB-5 — the approval this write runs for: its AdvertisingActionLog row carries it (executionId). */
  changeSetId?: string | null
  /**
   * The brain's match-type funnel only (brain/negatives.ts, Owner 2026-10-09): a negative phrase of two words or more may
   * narrow the broad keywords holding its words in its ad group (ads-winner-lock.ts BlockOpts). Absent: L1 as for everyone.
   */
  broadNarrowing?: boolean
  /**
   * W4-11 — a Claude request (add-negative-targets): a negative keyword in a Sponsored Brands ad group is sent to SB's
   * own endpoint (POST /sb/negativeKeywords). Absent: Sponsored Products only, as before (the gate refuses SB/SD).
   */
  allowSbSd?: boolean
  /** Negative Targeting — the author, said outright (negativeOriginOf decides it from the rest when absent). */
  origin?: NegativeOrigin | null
}

export interface WriteNegativeProductTargetArgs {
  adGroupId: string
  asin: string
  creationFlow?: boolean
  userId?: string | null
  evidence?: AdWriteEvidence | null
  /** 1e — a person's own add from a screen or an upload (isPersonCreate). Set only by the routes. */
  manual?: boolean
  /**
   * W1-7 + 3A — the person's "Send anyway": he saw that the ASIN belongs to a product his ads strategy protects and
   * confirmed. Honoured only with `manual` (a person's own add); an engine's is refused whatever it passes.
   */
  confirmOwnLimits?: boolean
  /** PB-5 — see WriteNegativeKeywordArgs.changeSetId. */
  changeSetId?: string | null
  /**
   * W4-11 — a Claude request (add-negative-targets): a negative product target in a Sponsored Display ad group is sent
   * to SD's own endpoint (POST /sd/negativeTargets). Absent: Sponsored Products only, as before.
   */
  allowSbSd?: boolean
  /** Negative Targeting — the author, said outright (negativeOriginOf decides it from the rest when absent). */
  origin?: NegativeOrigin | null
}

// ── Endpoint constants (legacy SP v3) ─────────────────────────────────

const SP_CAMPAIGN_NEGATIVE_KW_PATH = '/sp/campaignNegativeKeywords'
const SP_CAMPAIGN_NEGATIVE_KW_MIME = 'application/vnd.spCampaignNegativeKeyword.v3+json'

type Refusal = { deniedAt: string; reason: string; /** 3A — with `needs_confirmation`. */ limits?: OwnLimit[] }
interface CampaignRow { id: string; externalCampaignId: string | null; marketplace: string | null; adProduct: string | null; type: string | null }
/** Where a negative lands. For CAMPAIGN scope `adGroup` is the ad group that holds Nexus's row (the legacy structure). */
interface Placement { campaign: CampaignRow; adGroup: { id: string; externalAdGroupId: string | null } | null }

const CAMPAIGN_SELECT = { id: true, externalCampaignId: true, marketplace: true, adProduct: true, type: true } as const

const toNegativeMatch = (m: string): NegativeMatchType => (/PHRASE$/i.test(m) ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT')

// ── Dedupe ───────────────────────────────────────────────────────────

/**
 * A standing negative keyword with this text and match type at this level.
 *
 * TWO spellings exist on AdTarget.expressionType: locally-minted mirror rows carry Amazon's v3 vocab
 * ('NEGATIVE_EXACT'/'NEGATIVE_PHRASE'), the v1 sync stores plain 'EXACT'/'PHRASE' with isNegative=true — 1,068 such
 * rows on prod. Probing one spelling missed every synced negative and re-POSTed it to Amazon (pre-F fix).
 * 5b (review 7.6) — case-insensitive, as Amazon matches, and an ARCHIVED row is not standing: before this a retired
 * negative could never be added again.
 */
export function standingNegativeWhere(w: { scope: NegativeScope; adGroupId?: string | null; campaignId: string; keywordText: string; matchType: NegativeMatchType }): Prisma.AdTargetWhereInput {
  return {
    isNegative: true,
    status: { not: 'ARCHIVED' },
    expressionValue: { equals: w.keywordText, mode: 'insensitive' },
    expressionType: { in: [w.matchType, w.matchType.replace(/^NEGATIVE_/, '')] },
    // CAMPAIGN scope — AdTarget stores campaign-level negatives attached to an ad group (legacy structure); the sync
    // sets negativeLevel='CAMPAIGN'. An ad-group row from the v1 sync may carry no level.
    ...(w.scope === 'AD_GROUP'
      ? { adGroupId: w.adGroupId ?? '', OR: [{ negativeLevel: 'AD_GROUP' }, { negativeLevel: null }] }
      : { negativeLevel: 'CAMPAIGN', adGroup: { campaignId: w.campaignId } }),
  }
}

export async function negativeExistsLocally(args: {
  externalCampaignId: string
  externalAdGroupId?: string
  keywordText: string
  matchType: NegativeMatchType
  scope: NegativeScope
}): Promise<boolean> {
  const campaign = await prisma.campaign.findFirst({ where: { externalCampaignId: args.externalCampaignId }, select: { id: true } })
  if (!campaign) return false
  let adGroupId: string | null = null
  if (args.scope === 'AD_GROUP') {
    if (!args.externalAdGroupId) return false
    const adGroup = await prisma.adGroup.findFirst({ where: { externalAdGroupId: args.externalAdGroupId, campaignId: campaign.id }, select: { id: true } })
    if (!adGroup) return false
    adGroupId = adGroup.id
  }
  const existing = await prisma.adTarget.findFirst({
    where: standingNegativeWhere({ scope: args.scope, adGroupId, campaignId: campaign.id, keywordText: args.keywordText.trim(), matchType: args.matchType }),
    select: { id: true },
  })
  return existing != null
}

// ── Where it lands ───────────────────────────────────────────────────

async function resolvePlacement(w: Pick<WriteNegativeKeywordArgs, 'scope' | 'adGroupId' | 'campaignId' | 'externalCampaignId' | 'externalAdGroupId'>): Promise<Placement | Refusal> {
  const agSelect = { id: true, externalAdGroupId: true, campaign: { select: CAMPAIGN_SELECT } } as const
  const named = w.adGroupId
    ? await prisma.adGroup.findUnique({ where: { id: w.adGroupId }, select: agSelect })
    : w.scope === 'AD_GROUP' && w.externalAdGroupId
      ? await prisma.adGroup.findFirst({ where: { externalAdGroupId: w.externalAdGroupId, ...(w.externalCampaignId ? { campaign: { externalCampaignId: w.externalCampaignId } } : {}) }, select: agSelect })
      : null
  if (named) return { campaign: named.campaign as CampaignRow, adGroup: { id: named.id, externalAdGroupId: named.externalAdGroupId } }
  if (w.adGroupId || w.scope === 'AD_GROUP') {
    const which = w.adGroupId ?? w.externalAdGroupId ?? '(none named)'
    return { deniedAt: 'ad_group_unknown', reason: `Nexus holds no ad group ${which}, so the negative could not be checked or recorded.` }
  }
  const campaign = w.campaignId
    ? await prisma.campaign.findUnique({ where: { id: w.campaignId }, select: CAMPAIGN_SELECT })
    : w.externalCampaignId
      ? await prisma.campaign.findFirst({ where: { externalCampaignId: w.externalCampaignId }, select: CAMPAIGN_SELECT })
      : null
  if (!campaign) {
    return { deniedAt: 'campaign_unknown', reason: `Nexus holds no campaign ${w.campaignId ?? w.externalCampaignId ?? '(none named)'}, so the negative could not be checked or recorded.` }
  }
  const host = await prisma.adGroup.findFirst({ where: { campaignId: campaign.id }, select: { id: true, externalAdGroupId: true } })
  return { campaign: campaign as CampaignRow, adGroup: host }
}

const isRefusal = (p: Placement | Refusal): p is Refusal => 'deniedAt' in p

// ── The checks ───────────────────────────────────────────────────────

function keywordTextRefusal(text: string, matchType: NegativeMatchType): Refusal | null {
  // 7.5 — an ASIN search term names a product; as a keyword it blocks nothing Amazon would match.
  if (isAsin(text)) return { deniedAt: 'asin_keyword', reason: `"${text}" is an ASIN, a product: it can only be negated as a negative product target, not as a keyword.` }
  const problem = negativeKeywordTextProblem(text, matchType)
  return problem ? { deniedAt: 'text_limits', reason: problem } : null
}

async function protectedRefusal(
  text: string, matchType: NegativeMatchType | null, campaign: CampaignRow,
  person: { manual?: boolean; confirmOwnLimits?: boolean } = {},
): Promise<Refusal | null> {
  const hit = await protectedNegativeRefusal({ text, matchType, marketplace: campaign.marketplace, campaignId: campaign.id })
  // W1-7 + 3A — a person's own add on a protected PRODUCT is his own setting meeting his own click: it waits for his
  // "Send anyway" (here too, so an add Nexus keeps as a draft is asked as well), and once confirmed it goes; the write
  // gate asks the same at dispatch. An engine's is refused. A protected term refuses everyone, as before.
  if (hit?.protectedProduct && person.manual === true) {
    if (person.confirmOwnLimits === true) return null
    const limit: OwnLimit = { limit: 'product_protected', reason: hit.warning ?? hit.reason }
    return { deniedAt: 'needs_confirmation', reason: ownLimitsSentence([limit]), limits: [limit] }
  }
  return hit ? { deniedAt: hit.protectedProduct ? 'product_protected' : 'keyword_protected', reason: hit.reason } : null
}

async function convertingRefusal(text: string, config: ProtectConvertingConfig | null | undefined): Promise<Refusal | null> {
  if (!config?.enabled) return null
  const decision = (await checkProtectConverting({ terms: [text], config })).get(normaliseNegTerm(text))
  return decision && !decision.allowed ? { deniedAt: 'protect_converting', reason: decision.reason } : null
}

/**
 * CM-29 / CC-30 — a LIVE write goes to the profile the write gate approved (`liveProfileId`), never to one a caller
 * named: the caller's id used to win, so the gate could approve one profile while the call went to another. The market's
 * profile comes from the gate's own resolver (`adsClientContextFor`), not a second `findFirst`.
 */
async function clientContext(marketplace: string | null, liveProfileId: string | null, profileId?: string | null, region?: AdsRegion): Promise<ClientContext> {
  const { adsClientContextFor } = await import('./ads-profile-resolver.js')
  const conn = marketplace ? await adsClientContextFor(marketplace) : null
  return {
    profileId: liveProfileId || profileId || conn?.profileId || 'sandbox',
    region: region ?? conn?.region ?? 'EU',
  }
}

/**
 * 🔴 HV.9a — A NULL ID DOES NOT MEAN AMAZON DIDN'T CREATE IT. Measured on the 2026-08-13 proof write: Amazon accepted
 * "veste moto homme homologué", returned no error and no keywordId, and the negative is ENABLED there as
 * 48498817150724. A false failure is not the safe direction (the retry is a duplicate), so ask Amazon. A failed
 * read-back leaves the id null and never throws. (Moved here from applyHarvest, so every caller gets it.)
 */
async function readBackNegativeId(ctx: ClientContext, externalCampaignId: string, externalAdGroupId: string, text: string, matchType: NegativeMatchType): Promise<string | null> {
  try {
    const live = await listNegativeKeywords(ctx, { campaignIds: [externalCampaignId] })
    const key = normaliseNegTerm(text)
    const want = matchType.replace('NEGATIVE_', '')
    const found = live.find((k) => normaliseNegTerm(String(k.keywordText ?? '')) === key
      && String(k.adGroupId ?? '') === externalAdGroupId
      && String(k.matchType ?? '').toUpperCase().includes(want))
    const id = found?.negativeKeywordId ?? found?.keywordId ?? null
    if (id) logger.warn('[ads-negative-kw] Amazon created the negative but returned no id — recovered by read-back', { text, externalAdGroupId, id })
    return id ? String(id) : null
  } catch (e) {
    logger.warn('[ads-negative-kw] read-back after a null negative id failed', { text, error: (e as Error).message })
    return null
  }
}

/** Amazon SP v3 answers 207 with a per-item array: { <key>: { success: [...], error: [...] } }. */
const itemErrors = (raw: unknown, key: string): unknown[] => {
  const list = ((raw as Record<string, unknown> | null | undefined)?.[key] as { error?: unknown[] } | undefined)?.error
  return Array.isArray(list) ? list : []
}

/**
 * CM-25 — a standing row Nexus held without Amazon's id was just sent: Amazon's id goes on THAT row, so the next add
 * finds it as a negative Amazon holds (and no caller that records its own row makes a second one). Returns the id.
 */
async function healNegativeRow(rowId: string | null, externalId: string | null): Promise<string | null> {
  if (rowId && externalId) {
    await prisma.adTarget.updateMany({ where: { id: rowId, externalTargetId: null }, data: { externalTargetId: externalId } })
  }
  return externalId
}

// ── The pipeline ─────────────────────────────────────────────────────

/** What the pipeline did, before a caller decides what to record. */
type Sent =
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'exists'; adTargetId: string; externalTargetId: string | null }
  | { kind: 'draft' }
  | { kind: 'sent'; mode: 'sandbox' | 'live'; externalId: string | null; rawResponse: unknown; errors: unknown[] }
  | { kind: 'threw'; error: unknown }

interface KeywordJob {
  placement: Placement
  scope: NegativeScope
  text: string
  matchType: NegativeMatchType
  protectConverting?: ProtectConvertingConfig | null
  creationFlow?: boolean
  profileId?: string | null
  region?: AdsRegion
  /** Pushing a row Nexus already holds (the launch repair): it is not a duplicate of itself. */
  pushing?: boolean
  /** 1e — a person's own add (already checked by isPersonCreate): passes the halt and autonomy OFF at the gate. */
  manual?: boolean
  /** The brain's funnel: a negative phrase may narrow broad keywords (WriteNegativeKeywordArgs.broadNarrowing). */
  broadNarrowing?: boolean
  /** W4-11 — see WriteNegativeKeywordArgs.allowSbSd. */
  allowSbSd?: boolean
  /**
   * ONE BRAIN AB-5 — who adds it, for the gate's one owner per lever (the negatives lever). Every add names it (null: an
   * unnamed writer); a launch repair pushing a row Nexus holds (`pushing`) names none: a repair passes a brain's ownership.
   */
  actor?: string | null
}

/**
 * W4-11 — the new negative as the gate judges an SB/SD one (adWriteRefusal), for a caller that may send it; null for
 * every other caller and every Sponsored Products campaign, so the gate keeps refusing SB/SD for them (6a).
 */
function sbSdNegative(allow: boolean | undefined, campaign: CampaignRow, kind: 'KEYWORD' | 'PRODUCT', level: NegativeScope): AdWrite | null {
  const product = adProductOf(campaign)
  if (allow !== true || (product !== SPONSORED_BRANDS && product !== SPONSORED_DISPLAY)) return null
  return { entity: 'NEGATIVE_CREATE', kind, negativeLevel: level }
}

async function sendKeyword(job: KeywordJob): Promise<Sent> {
  const { placement: { campaign, adGroup }, scope, text, matchType } = job
  const invalid = keywordTextRefusal(text, matchType) ?? await protectedRefusal(text, matchType, campaign)
    ?? await ownKeywordRefusal({ scope, adGroupId: adGroup?.id ?? null, campaignId: campaign.id }, text, matchType === 'NEGATIVE_PHRASE' ? 'PHRASE' : 'EXACT', { broadNarrowing: job.broadNarrowing === true })
  if (invalid) return { kind: 'refused', refusal: invalid }
  const pushable = !!campaign.externalCampaignId && (scope !== 'AD_GROUP' || !!adGroup?.externalAdGroupId)
  let heal: string | null = null
  if (!job.pushing) {
    const standing = await prisma.adTarget.findFirst({
      where: standingNegativeWhere({ scope, adGroupId: adGroup?.id, campaignId: campaign.id, keywordText: text, matchType }),
      // CM-25 — the row Amazon holds first: it is the one that answers "already there".
      orderBy: { externalTargetId: { sort: 'asc', nulls: 'last' } },
      select: { id: true, externalTargetId: true },
    })
    // CM-25 — a row without Amazon's id is not a negative Amazon holds: when it can be sent, it is (and given the id).
    if (standing && (standing.externalTargetId || !pushable)) return { kind: 'exists', adTargetId: standing.id, externalTargetId: standing.externalTargetId }
    heal = standing?.id ?? null
  }
  const converting = await convertingRefusal(text, job.protectConverting)
  if (converting) return { kind: 'refused', refusal: converting }
  if (!campaign.externalCampaignId || (scope === 'AD_GROUP' && !adGroup?.externalAdGroupId)) return { kind: 'draft' }

  // Even sandbox calls go through the gate, so the same refusals apply; it returns mode=sandbox for env=sandbox.
  // 6a — the endpoints below are Sponsored Products ones, so the gate gets the campaign's ad product. W4-11 — and, for a
  // caller that may send one, the SB negative keyword it is (sbSdNegative), which goes to SB's own endpoint below.
  const sbSd = sbSdNegative(job.allowSbSd, campaign, 'KEYWORD', scope)
  const gate = await checkAdsWriteGate({
    marketplace: campaign.marketplace,
    payloadValueCents: 0, // a negative is a structural change with no monetary value
    isNegation: true,
    keywordText: text,
    negativeMatchType: matchType,
    adProduct: adProductOf(campaign),
    ...(job.creationFlow ? {} : { campaignId: campaign.id }),
    manual: job.manual === true,
    ...(sbSd ? { write: sbSd } : {}),
    // AB-5 — the negatives lever, and who adds it: on a campaign a product's brain owns, another engine's negative waits.
    dimension: 'negatives',
    ...(job.actor !== undefined ? { actor: job.actor } : {}),
  })
  if (gate.allowed === false) return { kind: 'refused', refusal: { deniedAt: gate.deniedAt, reason: gate.reason } }
  const ctx = await clientContext(campaign.marketplace, gate.mode === 'live' ? gate.profileId : null, job.profileId, job.region)

  try {
    // W4-11 — a Sponsored Brands negative keyword (the gate let only an ad-group one through): SB 3.0's own endpoint.
    // Its answer carries the id or Amazon's refusal; there is no SB read-back here, so no id is a failure (NO_ID).
    if (sbSd && adProductOf(campaign) === SPONSORED_BRANDS && scope === 'AD_GROUP') {
      const r = await sendSbNegativeKeyword(ctx, {
        externalCampaignId: campaign.externalCampaignId, externalAdGroupId: adGroup!.externalAdGroupId!,
        keywordText: text, matchType: matchType === 'NEGATIVE_PHRASE' ? 'PHRASE' : 'EXACT',
      })
      if (r.mode === 'sandbox') return { kind: 'sent', mode: 'sandbox', externalId: null, rawResponse: r.rawResponse, errors: [] }
      return { kind: 'sent', mode: 'live', externalId: await healNegativeRow(heal, r.externalId), rawResponse: r.rawResponse, errors: r.externalId ? [] : r.error ? [r.error] : [] }
    }
    if (scope === 'AD_GROUP') {
      const r = await sendNegativeKeyword(ctx, {
        externalCampaignId: campaign.externalCampaignId, externalAdGroupId: adGroup!.externalAdGroupId!,
        keywordText: text, matchType: matchType === 'NEGATIVE_PHRASE' ? 'PHRASE' : 'EXACT', state: 'enabled',
      })
      // A sandbox stub id is not an Amazon id.
      if (r.mode === 'sandbox') return { kind: 'sent', mode: 'sandbox', externalId: null, rawResponse: r.rawResponse, errors: [] }
      let errors = itemErrors(r.rawResponse, 'negativeKeywords')
      // CM-25 — when sending a row Nexus held, a refusal may mean Amazon already has it: ask before failing.
      const externalId = r.externalId
        ?? (errors.length && !heal ? null : await readBackNegativeId(ctx, campaign.externalCampaignId, adGroup!.externalAdGroupId!, text, matchType))
      if (externalId) errors = []
      return { kind: 'sent', mode: 'live', externalId: await healNegativeRow(heal, externalId), rawResponse: r.rawResponse, errors }
    }

    const body = { campaignNegativeKeywords: [{ campaignId: campaign.externalCampaignId, keywordText: text, matchType, state: 'ENABLED' }] }
    if (gate.mode === 'sandbox') {
      // 5a — sandbox refuses what liveCall would refuse.
      await assertNegativeWriteAllowed({ method: 'POST', path: SP_CAMPAIGN_NEGATIVE_KW_PATH, body })
      logger.info('[ADS-SANDBOX] campaign negative keyword', { campaignId: campaign.externalCampaignId, keywordText: text, matchType })
      return { kind: 'sent', mode: 'sandbox', externalId: null, rawResponse: { sandbox: true }, errors: [] }
    }
    const response = await liveCall<Record<string, unknown>>({
      profileId: ctx.profileId, region: ctx.region, method: 'POST', path: SP_CAMPAIGN_NEGATIVE_KW_PATH, body,
      contentType: SP_CAMPAIGN_NEGATIVE_KW_MIME, acceptHeader: SP_CAMPAIGN_NEGATIVE_KW_MIME,
    })
    const block = response?.campaignNegativeKeywords as { success?: Array<{ keywordId?: string; negativeKeywordId?: string; campaignNegativeKeywordId?: string }> } | undefined
    // 🔴 BOTH SPELLINGS. Amazon's create response can name the id `negativeKeywordId` where the list response names it
    // `keywordId`. Measured 2026-08-14: three `protezioni` negatives were created at Amazon while reading only
    // `keywordId` returned null for all three, so the local rows had no external id (NEG.4's split-brain state).
    const ok = block?.success?.[0]
    const externalId = ok?.keywordId ?? ok?.negativeKeywordId ?? ok?.campaignNegativeKeywordId ?? null
    return { kind: 'sent', mode: 'live', externalId: await healNegativeRow(heal, externalId), rawResponse: response, errors: itemErrors(response, 'campaignNegativeKeywords') }
  } catch (error) {
    return { kind: 'threw', error }
  }
}

interface ProductJob { placement: Placement; asin: string; creationFlow?: boolean; pushing?: boolean; /** 1e — see KeywordJob.manual. */ manual?: boolean; /** W1-7 — see WriteNegativeProductTargetArgs. */ confirmOwnLimits?: boolean; /** W4-11 — see WriteNegativeProductTargetArgs.allowSbSd. */ allowSbSd?: boolean; /** AB-5 — see KeywordJob.actor. */ actor?: string | null }

async function sendProductTarget(job: ProductJob): Promise<Sent> {
  const { placement: { campaign, adGroup }, asin } = job
  if (!adGroup) return { kind: 'refused', refusal: { deniedAt: 'ad_group_unknown', reason: 'A negative product target needs an ad group.' } }
  if (!isAsin(asin)) return { kind: 'refused', refusal: { deniedAt: 'not_an_asin', reason: `"${asin}" is not an ASIN (B0 and 8 letters or digits): a negative product target names one product.` } }
  const confirmed = job.manual === true && job.confirmOwnLimits === true
  const invalid = await protectedRefusal(asin, null, campaign, { manual: job.manual, confirmOwnLimits: job.confirmOwnLimits })
    ?? await ownKeywordRefusal({ scope: 'AD_GROUP', adGroupId: adGroup.id, campaignId: campaign.id }, asin, 'PRODUCT')
  if (invalid) return { kind: 'refused', refusal: invalid }
  let heal: string | null = null
  if (!job.pushing) {
    // H.5 — a negative product target is identified by ad group + ASIN.
    const standing = await prisma.adTarget.findFirst({
      where: { adGroupId: adGroup.id, kind: 'PRODUCT', isNegative: true, status: { not: 'ARCHIVED' }, expressionValue: { equals: asin, mode: 'insensitive' } },
      orderBy: { externalTargetId: { sort: 'asc', nulls: 'last' } },
      select: { id: true, externalTargetId: true },
    })
    // CM-25 — as for a keyword: a row without Amazon's id is sent, when it can be.
    const pushable = !!campaign.externalCampaignId && !!adGroup.externalAdGroupId
    if (standing && (standing.externalTargetId || !pushable)) return { kind: 'exists', adTargetId: standing.id, externalTargetId: standing.externalTargetId }
    heal = standing?.id ?? null
  }
  if (!campaign.externalCampaignId || !adGroup.externalAdGroupId) return { kind: 'draft' }
  // W4-11 — for a caller that may send one, the SD negative product target it is (sbSdNegative): SD's own endpoint below.
  const sbSd = sbSdNegative(job.allowSbSd, campaign, 'PRODUCT', 'AD_GROUP')
  const gate = await checkAdsWriteGate({
    marketplace: campaign.marketplace, payloadValueCents: 0, isNegation: true, keywordText: asin, adProduct: adProductOf(campaign),
    ...(job.creationFlow ? {} : { campaignId: campaign.id }),
    manual: job.manual === true,
    ...(confirmed ? { confirmOwnLimits: true } : {}),
    ...(sbSd ? { write: sbSd } : {}),
    // AB-5 — the negatives lever, and who adds it (see sendKeyword).
    dimension: 'negatives',
    ...(job.actor !== undefined ? { actor: job.actor } : {}),
  })
  if (gate.allowed === false) return { kind: 'refused', refusal: { deniedAt: gate.deniedAt, reason: gate.reason, ...(gate.ownLimits ? { limits: gate.ownLimits } : {}) } }
  const ctx = await clientContext(campaign.marketplace, gate.mode === 'live' ? gate.profileId : null)
  try {
    if (sbSd && adProductOf(campaign) === SPONSORED_DISPLAY) {
      const r = await sendSdNegativeTarget(ctx, { externalCampaignId: campaign.externalCampaignId, externalAdGroupId: adGroup.externalAdGroupId, asin, state: 'enabled', ...(confirmed ? { personConfirmed: true } : {}) })
      if (r.mode === 'sandbox') return { kind: 'sent', mode: 'sandbox', externalId: null, rawResponse: r.rawResponse, errors: [] }
      return { kind: 'sent', mode: 'live', externalId: await healNegativeRow(heal, r.externalId), rawResponse: r.rawResponse, errors: r.externalId ? [] : r.error ? [r.error] : [] }
    }
    // W1-7 — his confirmed add past a protected product: the wire lets that protection pass (the gate asked him).
    const r = await sendNegativeProductTarget(ctx, { externalCampaignId: campaign.externalCampaignId, externalAdGroupId: adGroup.externalAdGroupId, asin, state: 'enabled', ...(confirmed ? { personConfirmed: true } : {}) })
    if (r.mode === 'sandbox') return { kind: 'sent', mode: 'sandbox', externalId: null, rawResponse: r.rawResponse, errors: [] }
    return { kind: 'sent', mode: 'live', externalId: await healNegativeRow(heal, r.externalId), rawResponse: r.rawResponse, errors: itemErrors(r.rawResponse, 'negativeTargetingClauses') }
  } catch (error) {
    return { kind: 'threw', error }
  }
}

// ── Recording ────────────────────────────────────────────────────────

const NO_ID = 'Amazon returned no id and a read-back did not find it, so this term is NOT negated at Amazon. Nothing was recorded here; retrying is safe.'

/**
 * The one place a negative AdTarget row is created (scripts/check-negative-write-path.mjs). A standing row with the
 * same text is returned instead of a second one, and its missing Amazon id is healed. No audit row: callers write it.
 */
export async function mirrorNegativeRow(m: {
  adGroupId: string
  /** Needed for CAMPAIGN level: the campaign whose negatives are searched. */
  campaignId?: string | null
  kind: 'KEYWORD' | 'PRODUCT'
  level: NegativeScope
  expressionType: string
  expressionValue: string
  externalTargetId: string | null
  /** Negative Targeting — the author stored on a NEW row (a standing one keeps its own). */
  origin?: NegativeOrigin | null
}): Promise<{ id: string; created: boolean }> {
  const where: Prisma.AdTargetWhereInput = m.kind === 'KEYWORD'
    ? standingNegativeWhere({ scope: m.level, adGroupId: m.adGroupId, campaignId: m.campaignId ?? '', keywordText: m.expressionValue, matchType: toNegativeMatch(m.expressionType) })
    : { adGroupId: m.adGroupId, kind: 'PRODUCT', isNegative: true, status: { not: 'ARCHIVED' }, expressionValue: { equals: m.expressionValue, mode: 'insensitive' } }
  // CM-25 — the row Amazon holds first, so a second id-less row is never given the same Amazon id.
  const existing = await prisma.adTarget.findFirst({ where, orderBy: { externalTargetId: { sort: 'asc', nulls: 'last' } }, select: { id: true, externalTargetId: true } })
  if (existing) {
    if (!existing.externalTargetId && m.externalTargetId) {
      await prisma.adTarget.update({ where: { id: existing.id }, data: { externalTargetId: m.externalTargetId } })
    }
    return { id: existing.id, created: false }
  }
  const t = await prisma.adTarget.create({
    data: {
      adGroupId: m.adGroupId, kind: m.kind, expressionType: m.expressionType, expressionValue: m.expressionValue,
      bidCents: 0, status: 'ENABLED', isNegative: true, negativeLevel: m.level, externalTargetId: m.externalTargetId,
      ...(m.origin ? { negativeOrigin: m.origin } : {}),
    },
  })
  return { id: t.id, created: true }
}

async function auditCreate(actionType: string, adTargetId: string, payloadAfter: Record<string, unknown>, userId?: string | null, evidence?: AdWriteEvidence | null, changeSetId?: string | null) {
  await prisma.advertisingActionLog.create({
    data: {
      userId: userId ?? null, actionType, entityType: 'AD_TARGET', entityId: adTargetId, payloadBefore: {}, payloadAfter: payloadAfter as never,
      amazonResponseStatus: 'SUCCESS', evidence: (packEvidence(evidence) ?? undefined) as never,
      ...(changeSetId ? { executionId: changeSetId } : {}),
    },
  }).catch(() => {})
}

/** The row and its audit row (`create_negative_keyword`, with `reachedAmazon`) for a negative keyword that stands. */
export async function mirrorNegativeKeyword(input: {
  scope: NegativeScope
  /** AD_GROUP: the ad group. CAMPAIGN: the ad group that holds the campaign's row. */
  adGroupId: string
  campaignId?: string | null
  keywordText: string
  matchType: NegativeMatchType
  externalTargetId: string | null
  mode?: 'sandbox' | 'live' | 'local'
  userId?: string | null
  evidence?: AdWriteEvidence | null
  changeSetId?: string | null
  /** Negative Targeting — the author said outright, and a launch's own negative (both feed negativeOriginOf). */
  origin?: NegativeOrigin | null
  creationFlow?: boolean
}): Promise<{ id: string; created: boolean }> {
  const row = await mirrorNegativeRow({
    adGroupId: input.adGroupId, campaignId: input.campaignId, kind: 'KEYWORD', level: input.scope,
    expressionType: input.matchType, expressionValue: input.keywordText, externalTargetId: input.externalTargetId,
    origin: await originFor({ origin: input.origin, userId: input.userId, evidence: input.evidence, creationFlow: input.creationFlow, changeSetId: input.changeSetId }),
  })
  if (row.created) {
    await auditCreate('create_negative_keyword', row.id, {
      keywordText: input.keywordText, matchType: input.matchType, scope: input.scope, externalTargetId: input.externalTargetId,
      reachedAmazon: input.externalTargetId != null, ...(input.mode ? { mode: input.mode } : {}),
    }, input.userId, input.evidence, input.changeSetId)
  }
  return row
}

const refusedResult = (refusal: Refusal, mode: NegativeWriteResult['mode']): NegativeWriteResult => ({
  outcome: 'refused', mode, externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal, error: null, rawResponse: null,
})
const failedResult = (error: string, mode: NegativeWriteResult['mode'], rawResponse: unknown = null): NegativeWriteResult => ({
  outcome: 'failed', mode, externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal: null, error, rawResponse,
})

function logOutcome(what: string, r: NegativeWriteResult) {
  if (r.outcome === 'refused') logger.warn(`[ads-negative-kw] ${what} refused — nothing written`, { deniedAt: r.refusal?.deniedAt, reason: r.refusal?.reason })
  else if (r.outcome === 'failed') logger.warn(`[ads-negative-kw] ${what} failed — nothing written`, { error: r.error })
}

/** A `Sent` that is not a row of its own yet, as the result every writer returns; null when it needs recording. */
function settled(sent: Sent, mode: NegativeWriteResult['mode']): NegativeWriteResult | null {
  if (sent.kind === 'refused') return refusedResult(sent.refusal, mode)
  if (sent.kind === 'exists') {
    return { outcome: 'already_existed', mode, externalTargetId: sent.externalTargetId, reachedAmazon: sent.externalTargetId != null, adTargetId: sent.adTargetId, refusal: null, error: null, rawResponse: { localDedup: true } }
  }
  if (sent.kind === 'threw') {
    const error = sent.error instanceof Error ? sent.error.message : String(sent.error)
    // 5a's wire check (NegativeRefusedError) is a refusal, not a failure.
    return (sent.error as { code?: unknown } | null)?.code === 'negative_refused' ? refusedResult({ deniedAt: 'negative_refused', reason: error }, mode) : failedResult(error, mode)
  }
  if (sent.kind === 'sent' && sent.errors.length) return failedResult(`Amazon refused it: ${JSON.stringify(sent.errors).slice(0, 300)}`, 'live', sent.rawResponse)
  if (sent.kind === 'sent' && sent.mode === 'live' && sent.externalId == null) return failedResult(NO_ID, 'live', sent.rawResponse)
  return null
}

// ── Public API ────────────────────────────────────────────────────────

/** 5b — add one negative keyword: validate → dedupe → policy → gate → Amazon → the local row and its audit row. */
export async function writeNegativeKeyword(args: WriteNegativeKeywordArgs): Promise<NegativeWriteResult> {
  const mode = adsMode()
  const text = (args.keywordText ?? '').trim()
  const matchType = toNegativeMatch(args.matchType)
  const placement = await resolvePlacement(args)
  if (isRefusal(placement)) return done('negative keyword', refusedResult(placement, mode))
  if (args.scope === 'CAMPAIGN' && !placement.adGroup) {
    return done('negative keyword', failedResult(`${placement.campaign.id} has no ad group to hold Nexus's copy of a campaign negative, so nothing was sent.`, mode))
  }
  const sent = await sendKeyword({ placement, scope: args.scope, text, matchType, protectConverting: args.protectConverting, creationFlow: args.creationFlow, profileId: args.profileId, region: args.region, manual: isPersonCreate(args.manual, args.userId), allowSbSd: args.allowSbSd, actor: args.userId ?? null, broadNarrowing: args.broadNarrowing === true })
  const early = settled(sent, sent.kind === 'draft' ? 'local' : mode)
  if (early) return done('negative keyword', early)

  const recordMode = sent.kind === 'sent' ? sent.mode : 'local'
  const externalTargetId = sent.kind === 'sent' ? sent.externalId : null
  const row = await mirrorNegativeKeyword({
    scope: args.scope, adGroupId: placement.adGroup!.id, campaignId: placement.campaign.id, keywordText: text, matchType,
    externalTargetId, mode: recordMode, userId: args.userId, evidence: args.evidence, changeSetId: args.changeSetId,
    origin: args.origin, creationFlow: args.creationFlow,
  })
  return {
    outcome: sent.kind === 'draft' ? 'local' : 'created', mode: recordMode, externalTargetId, reachedAmazon: externalTargetId != null,
    adTargetId: row.id, refusal: null, error: null, rawResponse: sent.kind === 'sent' ? sent.rawResponse : null,
  }
}

/** 5b — add one ad-group negative product target (an ASIN), through the same order as a keyword. */
export async function writeNegativeProductTarget(args: WriteNegativeProductTargetArgs): Promise<NegativeWriteResult> {
  const mode = adsMode()
  const placement = await resolvePlacement({ scope: 'AD_GROUP', adGroupId: args.adGroupId })
  if (isRefusal(placement)) return done('negative product target', refusedResult(placement, mode))
  const asin = (args.asin ?? '').trim()
  const sent = await sendProductTarget({ placement, asin, creationFlow: args.creationFlow, manual: isPersonCreate(args.manual, args.userId), confirmOwnLimits: args.confirmOwnLimits, allowSbSd: args.allowSbSd, actor: args.userId ?? null })
  const early = settled(sent, sent.kind === 'draft' ? 'local' : mode)
  if (early) return done('negative product target', early)

  const recordMode = sent.kind === 'sent' ? sent.mode : 'local'
  const externalTargetId = sent.kind === 'sent' ? sent.externalId : null
  const row = await mirrorNegativeRow({
    adGroupId: args.adGroupId, kind: 'PRODUCT', level: 'AD_GROUP', expressionType: 'ASIN', expressionValue: asin, externalTargetId,
    origin: await originFor({ origin: args.origin, userId: args.userId, evidence: args.evidence, creationFlow: args.creationFlow, changeSetId: args.changeSetId }),
  })
  if (row.created) {
    await auditCreate('create_negative_product_target', row.id, { asin, externalId: externalTargetId, reachedAmazon: externalTargetId != null, mode: recordMode }, args.userId, args.evidence, args.changeSetId)
  }
  return {
    outcome: sent.kind === 'draft' ? 'local' : 'created', mode: recordMode, externalTargetId, reachedAmazon: externalTargetId != null,
    adTargetId: row.id, refusal: null, error: null, rawResponse: sent.kind === 'sent' ? sent.rawResponse : null,
  }
}

function done(what: string, r: NegativeWriteResult): NegativeWriteResult {
  logOutcome(what, r)
  return r
}

/**
 * LAUNCH-REPAIR — push a negative Nexus holds that never reached Amazon, through the same checks as a new one. Its
 * level decides the endpoint (a CAMPAIGN row goes to /sp/campaignNegativeKeywords, not to its host ad group). A
 * refusal leaves the row as it is and says why; a success writes Amazon's id onto it.
 */
export async function pushLocalNegative(adTargetId: string, opts: { creationFlow?: boolean } = {}): Promise<NegativeWriteResult> {
  const mode = adsMode()
  const row = await prisma.adTarget.findUnique({
    where: { id: adTargetId },
    select: { id: true, kind: true, isNegative: true, negativeLevel: true, expressionType: true, expressionValue: true, status: true, externalTargetId: true, adGroupId: true },
  })
  if (!row?.isNegative) return failedResult(`${adTargetId} is not a negative Nexus holds.`, mode)
  if (row.externalTargetId) return { outcome: 'already_existed', mode, externalTargetId: row.externalTargetId, reachedAmazon: true, adTargetId: row.id, refusal: null, error: null, rawResponse: null }
  if (String(row.status) === 'ARCHIVED') return refusedResult({ deniedAt: 'archived', reason: `${row.id} is archived; an archived negative is not pushed.` }, mode)
  const scope: NegativeScope = row.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP'
  const placement = await resolvePlacement({ scope: 'AD_GROUP', adGroupId: row.adGroupId })
  if (isRefusal(placement)) return done('negative push', refusedResult(placement, mode))
  const sent = row.kind === 'PRODUCT'
    ? await sendProductTarget({ placement, asin: row.expressionValue.trim(), creationFlow: opts.creationFlow, pushing: true })
    : await sendKeyword({ placement, scope, text: row.expressionValue.trim(), matchType: toNegativeMatch(row.expressionType), creationFlow: opts.creationFlow, pushing: true })
  if (sent.kind === 'draft') return done('negative push', failedResult('The campaign or ad group has no Amazon ids yet, so the negative cannot be pushed.', 'local'))
  const early = settled(sent, mode)
  if (early) return done('negative push', early)
  const externalTargetId = sent.kind === 'sent' ? sent.externalId : null
  if (externalTargetId) await prisma.adTarget.update({ where: { id: row.id }, data: { externalTargetId } })
  return {
    outcome: 'created', mode: sent.kind === 'sent' ? sent.mode : mode, externalTargetId, reachedAmazon: externalTargetId != null,
    adTargetId: row.id, refusal: null, error: null, rawResponse: sent.kind === 'sent' ? sent.rawResponse : null,
  }
}

/**
 * Create a negative keyword in Amazon at the given scope — the push-only wrapper. Its callers (the rules, n-grams, the
 * funnel, the route) record the row themselves, so it writes nothing here; every check above still runs, and an
 * existing negative short-circuits without hitting Amazon. A throw from the Amazon call is thrown on, as before.
 */
export async function createNegative(args: CreateNegativeArgs): Promise<CreateNegativeResult> {
  const mode = adsMode()
  const denied = (r: Refusal): CreateNegativeResult => {
    logger.warn('[ads-negative-kw] write gate denied', { profileId: args.profileId, reason: r.reason, deniedAt: r.deniedAt })
    return { ok: false, mode, externalNegativeKeywordId: null, alreadyExisted: false, denied: { reason: r.reason, deniedAt: r.deniedAt }, rawResponse: null }
  }
  if (args.scope === 'AD_GROUP' && !args.externalAdGroupId) {
    return { ok: false, mode, externalNegativeKeywordId: null, alreadyExisted: false, denied: null, rawResponse: { error: 'externalAdGroupId required for AD_GROUP scope' } }
  }
  const placement = await resolvePlacement({ scope: args.scope, campaignId: args.nexusCampaignId, externalCampaignId: args.externalCampaignId, externalAdGroupId: args.externalAdGroupId })
  if (isRefusal(placement)) return denied(placement)
  const sent = await sendKeyword({ placement, scope: args.scope, text: (args.keywordText ?? '').trim(), matchType: toNegativeMatch(args.matchType), profileId: args.profileId, region: args.region, manual: isPersonCreate(args.manual, null), actor: args.actor ?? null })
  switch (sent.kind) {
    case 'refused': return denied(sent.refusal)
    case 'exists':
      logger.info('[ads-negative-kw] already exists locally — skipping create', { profileId: args.profileId, keywordText: args.keywordText, matchType: args.matchType, scope: args.scope })
      return { ok: true, mode, externalNegativeKeywordId: null, alreadyExisted: true, denied: null, rawResponse: { localDedup: true }, ...(args.record ? { adTargetId: sent.adTargetId } : {}) }
    case 'threw': throw sent.error
    case 'draft': return { ok: false, mode, externalNegativeKeywordId: null, alreadyExisted: false, denied: null, rawResponse: { error: 'the campaign or ad group has no Amazon ids yet' } }
    case 'sent': {
      if (sent.errors.length) {
        logger.warn('[ads-negative-kw] Amazon returned per-item errors', { profileId: args.profileId, errors: sent.errors })
        return { ok: false, mode: 'live', externalNegativeKeywordId: null, alreadyExisted: false, denied: null, rawResponse: sent.rawResponse }
      }
      logger.info(`[ADS-${sent.mode === 'live' ? 'LIVE' : 'SANDBOX'}] createNegative`, { profileId: args.profileId, scope: args.scope, externalId: sent.externalId, keywordText: args.keywordText })
      // Negative Targeting — the caller asked this door to keep the row and its audit row (the author stored), as
      // writeNegativeKeyword does: a live create only once Amazon's id is known (a null id is not a negative that stands).
      const recorded = args.record && placement.adGroup && (sent.mode === 'sandbox' || sent.externalId != null)
        ? await mirrorNegativeKeyword({
          scope: args.scope, adGroupId: placement.adGroup.id, campaignId: placement.campaign.id, keywordText: (args.keywordText ?? '').trim(),
          matchType: toNegativeMatch(args.matchType), externalTargetId: sent.externalId, mode: sent.mode,
          userId: args.record.userId ?? args.actor ?? null, evidence: args.record.evidence, changeSetId: args.record.changeSetId, origin: args.record.origin,
        })
        : null
      return {
        ok: true, mode: sent.mode, externalNegativeKeywordId: sent.externalId, alreadyExisted: false, denied: null,
        rawResponse: sent.mode === 'sandbox' ? { sandbox: true } : sent.rawResponse,
        ...(args.record ? { adTargetId: recorded?.id ?? null } : {}),
      }
    }
  }
}

/** Tests only. */
export const __negativeKwTest = { clientContext }
