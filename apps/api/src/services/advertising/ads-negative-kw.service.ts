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
 *
 * 5b — THE ONE NEGATIVE WRITE SERVICE (review 7.1, 7.5, 7.6, 7.12). Every Nexus path that adds a negative — the
 * launches, bulk negatives, the bulk sheet, blueprints, AI goals, the launch repair, harvest, the rules, n-grams, the
 * funnel, the route and the MCP tools — comes through `writeNegativeKeyword` / `writeNegativeProductTarget`, or through
 * `createNegative`, the push-only wrapper whose callers record the row themselves. One order for all of them:
 *
 *   validate  Amazon's text limits, an ASIN is a product and not a keyword, protected terms (ads-negation-policy.ts)
 *   dedupe    a standing negative with this text and match type at this level: case-insensitive, both match-type
 *             spellings. An ARCHIVED one is absent, so a retired negative can be added again. A row whose retire
 *             failed (`retiredAt` set, still ENABLED) still stands: 5f decides on status, and so does this.
 *   policy    the converting guard, when the caller asks for it (`protectConverting`)
 *   gate      checkAdsWriteGate with the campaign's id, so the live-write allowlist binds a negative like any other
 *             write. A campaign launched in the same request passes `creationFlow`, as its keywords and product ads do.
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
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  liveCall, adsMode, listNegativeKeywords,
  createNegativeKeyword as sendNegativeKeyword, createNegativeProductTarget as sendNegativeProductTarget,
  type AdsRegion, type ClientContext,
} from './ads-api-client.js'
import { checkAdsWriteGate } from './ads-write-gate.js'
import { isPersonCreate } from './ads-mutation.service.js'
import { assertNegativeWriteAllowed, isAsin, negativeKeywordTextProblem, protectedNegativeRefusal } from './ads-negation-policy.js'
import { checkProtectConverting, normaliseNegTerm, type ProtectConvertingConfig } from './ads-protect-converting.js'
import { packEvidence, type AdWriteEvidence } from './ads-evidence.js'
import { adProductOf } from '@nexus/shared/ads-ad-product'

export type NegativeMatchType = 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'
export type NegativeScope = 'AD_GROUP' | 'CAMPAIGN'

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
  refusal: { deniedAt: string; reason: string } | null
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
}

export interface WriteNegativeProductTargetArgs {
  adGroupId: string
  asin: string
  creationFlow?: boolean
  userId?: string | null
  evidence?: AdWriteEvidence | null
  /** 1e — a person's own add from a screen or an upload (isPersonCreate). Set only by the routes. */
  manual?: boolean
}

// ── Endpoint constants (legacy SP v3) ─────────────────────────────────

const SP_CAMPAIGN_NEGATIVE_KW_PATH = '/sp/campaignNegativeKeywords'
const SP_CAMPAIGN_NEGATIVE_KW_MIME = 'application/vnd.spCampaignNegativeKeyword.v3+json'

type Refusal = { deniedAt: string; reason: string }
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

async function protectedRefusal(text: string, matchType: NegativeMatchType | null, campaign: CampaignRow): Promise<Refusal | null> {
  const hit = await protectedNegativeRefusal({ text, matchType, marketplace: campaign.marketplace, campaignId: campaign.id })
  return hit ? { deniedAt: 'keyword_protected', reason: hit.reason } : null
}

async function convertingRefusal(text: string, config: ProtectConvertingConfig | null | undefined): Promise<Refusal | null> {
  if (!config?.enabled) return null
  const decision = (await checkProtectConverting({ terms: [text], config })).get(normaliseNegTerm(text))
  return decision && !decision.allowed ? { deniedAt: 'protect_converting', reason: decision.reason } : null
}

async function clientContext(marketplace: string | null, liveProfileId: string | null, profileId?: string | null, region?: AdsRegion): Promise<ClientContext> {
  const conn = marketplace ? await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true, region: true } }) : null
  return {
    profileId: profileId || liveProfileId || conn?.profileId || 'sandbox',
    region: region ?? ((conn?.region as AdsRegion | undefined) ?? 'EU'),
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
}

async function sendKeyword(job: KeywordJob): Promise<Sent> {
  const { placement: { campaign, adGroup }, scope, text, matchType } = job
  const invalid = keywordTextRefusal(text, matchType) ?? await protectedRefusal(text, matchType, campaign)
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
  // 6a — the endpoints below are Sponsored Products ones, so the gate gets the campaign's ad product.
  const gate = await checkAdsWriteGate({
    marketplace: campaign.marketplace,
    payloadValueCents: 0, // a negative is a structural change with no monetary value
    isNegation: true,
    keywordText: text,
    negativeMatchType: matchType,
    adProduct: adProductOf(campaign),
    ...(job.creationFlow ? {} : { campaignId: campaign.id }),
    manual: job.manual === true,
  })
  if (gate.allowed === false) return { kind: 'refused', refusal: { deniedAt: gate.deniedAt, reason: gate.reason } }
  const ctx = await clientContext(campaign.marketplace, gate.mode === 'live' ? gate.profileId : null, job.profileId, job.region)

  try {
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

interface ProductJob { placement: Placement; asin: string; creationFlow?: boolean; pushing?: boolean; /** 1e — see KeywordJob.manual. */ manual?: boolean }

async function sendProductTarget(job: ProductJob): Promise<Sent> {
  const { placement: { campaign, adGroup }, asin } = job
  if (!adGroup) return { kind: 'refused', refusal: { deniedAt: 'ad_group_unknown', reason: 'A negative product target needs an ad group.' } }
  if (!isAsin(asin)) return { kind: 'refused', refusal: { deniedAt: 'not_an_asin', reason: `"${asin}" is not an ASIN (B0 and 8 letters or digits): a negative product target names one product.` } }
  const invalid = await protectedRefusal(asin, null, campaign)
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
  const gate = await checkAdsWriteGate({
    marketplace: campaign.marketplace, payloadValueCents: 0, isNegation: true, keywordText: asin, adProduct: adProductOf(campaign),
    ...(job.creationFlow ? {} : { campaignId: campaign.id }),
    manual: job.manual === true,
  })
  if (gate.allowed === false) return { kind: 'refused', refusal: { deniedAt: gate.deniedAt, reason: gate.reason } }
  const ctx = await clientContext(campaign.marketplace, gate.mode === 'live' ? gate.profileId : null)
  try {
    const r = await sendNegativeProductTarget(ctx, { externalCampaignId: campaign.externalCampaignId, externalAdGroupId: adGroup.externalAdGroupId, asin, state: 'enabled' })
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
    },
  })
  return { id: t.id, created: true }
}

async function auditCreate(actionType: string, adTargetId: string, payloadAfter: Record<string, unknown>, userId?: string | null, evidence?: AdWriteEvidence | null) {
  await prisma.advertisingActionLog.create({
    data: {
      userId: userId ?? null, actionType, entityType: 'AD_TARGET', entityId: adTargetId, payloadBefore: {}, payloadAfter: payloadAfter as never,
      amazonResponseStatus: 'SUCCESS', evidence: (packEvidence(evidence) ?? undefined) as never,
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
}): Promise<{ id: string; created: boolean }> {
  const row = await mirrorNegativeRow({
    adGroupId: input.adGroupId, campaignId: input.campaignId, kind: 'KEYWORD', level: input.scope,
    expressionType: input.matchType, expressionValue: input.keywordText, externalTargetId: input.externalTargetId,
  })
  if (row.created) {
    await auditCreate('create_negative_keyword', row.id, {
      keywordText: input.keywordText, matchType: input.matchType, scope: input.scope, externalTargetId: input.externalTargetId,
      reachedAmazon: input.externalTargetId != null, ...(input.mode ? { mode: input.mode } : {}),
    }, input.userId, input.evidence)
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
  const sent = await sendKeyword({ placement, scope: args.scope, text, matchType, protectConverting: args.protectConverting, creationFlow: args.creationFlow, profileId: args.profileId, region: args.region, manual: isPersonCreate(args.manual, args.userId) })
  const early = settled(sent, sent.kind === 'draft' ? 'local' : mode)
  if (early) return done('negative keyword', early)

  const recordMode = sent.kind === 'sent' ? sent.mode : 'local'
  const externalTargetId = sent.kind === 'sent' ? sent.externalId : null
  const row = await mirrorNegativeKeyword({
    scope: args.scope, adGroupId: placement.adGroup!.id, campaignId: placement.campaign.id, keywordText: text, matchType,
    externalTargetId, mode: recordMode, userId: args.userId, evidence: args.evidence,
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
  const sent = await sendProductTarget({ placement, asin, creationFlow: args.creationFlow, manual: isPersonCreate(args.manual, args.userId) })
  const early = settled(sent, sent.kind === 'draft' ? 'local' : mode)
  if (early) return done('negative product target', early)

  const recordMode = sent.kind === 'sent' ? sent.mode : 'local'
  const externalTargetId = sent.kind === 'sent' ? sent.externalId : null
  const row = await mirrorNegativeRow({ adGroupId: args.adGroupId, kind: 'PRODUCT', level: 'AD_GROUP', expressionType: 'ASIN', expressionValue: asin, externalTargetId })
  if (row.created) {
    await auditCreate('create_negative_product_target', row.id, { asin, externalId: externalTargetId, reachedAmazon: externalTargetId != null, mode: recordMode }, args.userId, args.evidence)
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
  const sent = await sendKeyword({ placement, scope: args.scope, text: (args.keywordText ?? '').trim(), matchType: toNegativeMatch(args.matchType), profileId: args.profileId, region: args.region, manual: isPersonCreate(args.manual, null) })
  switch (sent.kind) {
    case 'refused': return denied(sent.refusal)
    case 'exists':
      logger.info('[ads-negative-kw] already exists locally — skipping create', { profileId: args.profileId, keywordText: args.keywordText, matchType: args.matchType, scope: args.scope })
      return { ok: true, mode, externalNegativeKeywordId: null, alreadyExisted: true, denied: null, rawResponse: { localDedup: true } }
    case 'threw': throw sent.error
    case 'draft': return { ok: false, mode, externalNegativeKeywordId: null, alreadyExisted: false, denied: null, rawResponse: { error: 'the campaign or ad group has no Amazon ids yet' } }
    case 'sent':
      if (sent.errors.length) {
        logger.warn('[ads-negative-kw] Amazon returned per-item errors', { profileId: args.profileId, errors: sent.errors })
        return { ok: false, mode: 'live', externalNegativeKeywordId: null, alreadyExisted: false, denied: null, rawResponse: sent.rawResponse }
      }
      logger.info(`[ADS-${sent.mode === 'live' ? 'LIVE' : 'SANDBOX'}] createNegative`, { profileId: args.profileId, scope: args.scope, externalId: sent.externalId, keywordText: args.keywordText })
      return { ok: true, mode: sent.mode, externalNegativeKeywordId: sent.externalId, alreadyExisted: false, denied: null, rawResponse: sent.mode === 'sandbox' ? { sandbox: true } : sent.rawResponse }
  }
}
