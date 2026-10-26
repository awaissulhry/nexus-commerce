/**
 * Negative Targeting page (2026-10-11, lane NWRITE) — the page's writes, through the SAME code as Claude's Nexus tools.
 *
 * The page never writes Amazon or the hold itself. Each row the person picks becomes the request of an MCP tool, dry-run
 * as that person (callTool: permissions, business, arguments, the tool's own refusals), and the person who clicks Send
 * is the approver (the ask() pattern of routes/advertising-brain.routes.ts): one change set, an audit row per write, Undo
 * where Amazon allows (undo-change of the approval, or of one step).
 *
 *   PAUSE             our keyword or target   pause-ads { targetIds, keepPaused: true, keepUntil? }  — paused AND kept paused
 *   TURN_ON           our keyword or target   enable-ads { targetIds, includePeoplesPauses, releaseKeepPaused? }  — spends again
 *   RELEASE           a kept-paused one       pause-ads { keepPaused: false } (stays paused) · enable-ads { releaseKeepPaused }
 *                                             when Amazon already serves it (switched on outside Nexus: it runs as it is)
 *   NEGATE_EXACT/PHRASE  a shopper's term     add-negative-targets { negatives: [{ adGroupId | campaignId, text, matchType }] }
 *   NEGATE_ASIN       a shopper's ASIN term   add-negative-targets { negatives: [{ adGroupId, asin }] }
 *   REMOVE_NEGATIVE   a standing negative     retire-negatives { negativeIds } — Amazon archives it (final); Harvest's and the
 *                                             brain funnel's are refused by the tool (the page never forces). Polish M9 — also
 *                                             from our keyword's row with `targetRowId: 'neg:<id>'`: the negative over it (a clash)
 *   KEEP_UNTIL        a paused keyword        pause-ads { keepPaused: true, keepUntil? } — the hold's end only (null = Always);
 *                                             its Undo puts the old end back (polish M3)
 *   NEGATE_* + adGroupId                      the term (or our keyword's text) negated in a named ad group of the same product
 *                                             where it still runs — "Still bought elsewhere" (polish S17); refused elsewhere
 *   UNPROTECT         a PROTECTED row         set-ad-guardrail { kind: protected-term, op: remove, term, marketplace?,
 *                                             campaignId? } — one protected term that keeps it safe (`protectionId`; the
 *                                             first by default), Nexus only (protect.ts). Named before the row's own verb, the
 *                                             two are "Remove protection and stop": a pause goes with it as ONE change set;
 *                                             a negative WAITS for it (`after: 'UNPROTECT'`, never sent with it: its tool
 *                                             refuses a protected term): the server sends it once the removal ran, as the
 *                                             same person (follow-up.ts, step 4)
 *   NEGATE_PHRASE     a word (Words view)     `{ rowId: 'word:<market>|<word>', action: 'NEGATE_PHRASE', where, scope? }` — ONE
 *                                             step per place its terms spent in (words.ts wordPlaces: ad groups, or whole
 *                                             campaigns), each add-negative-targets { negatives: [{ adGroupId | campaignId,
 *                                             text, matchType: NEGATIVE_PHRASE }] }; a place that is blocked, held or does not
 *                                             waste is left out with why. `scope`: the page's filter-bar lists the row was
 *                                             read with (the same places the person saw)
 *
 * Every step also says its `level` (AD_GROUP / CAMPAIGN: a campaign negative's place ends at its campaign) and `final`
 * (a removal is archived at Amazon and cannot come back: its Done has no Undo) — polish M1, M2. Step 4 —
 * every NEGATE_* step says what it would block (`reach`: terms, spend, clicks, orders, sales over the page's window, and
 * the terms that sold), and the preview the total of the steps it sends: one call at the end (reach.ts withReach), after
 * the items are expanded into steps. A warning, never a refusal; apply re-checks nothing new (the planHash stands).
 *
 * preview  writes nothing: every row's step, where it lands, its refusal (the tool's own words), whether it raises spend,
 *          and a planHash over the rows, the requests and the facts they stand on.
 * apply    the same preview again; a different planHash is 409 (something moved: preview again). The rows that are not
 *          refused become ONE request — the tool itself for one row, else one change plan (submit-change-plan), one step
 *          per row (so each row has its own change and Undo) — asked as the person and approved by the same person at
 *          once through the Approvals page's path (decideFleetApproval: the undo window; a request whose stepUp asks the
 *          code needs settings.security.manage and the authenticator code — none since 2026-10-12, the code table's
 *          lines are off). The answer: { changeSetId, status, steps, … }. Step 4 — steps that wait for their protected
 *          term's removal are not in it: they are written as the removal's follow-up (follow-up.ts, `followUp` in the
 *          answer), which the server sends once the removal ran, as this person.
 * waiting  a request that waits on the page's rows (one of the tools above, or a plan holding one) approved or rejected
 *          through the same path, as on the Approvals page; any other request is 404 here. A rule's Ask-me card
 *          (`suggestion:<AdsRuleSuggestion.id>`: a keyword pause or a search-term negative) is decided through the
 *          Suggestions page's own path (ads-suggestion-decide.service.ts — the halt, the rule still standing behind it, the
 *          write gate; a refusal leaves it waiting): approve applies it (a pause_target keeps the keyword paused, the hold of
 *          waste/hold.ts), reject dismisses it. The page never needs the Suggestions page.
 *
 * Row ids are the read lane's (NREAD): 'kw:<AdTarget.id>' (our keyword or target), 'neg:<AdTarget.id>' (a standing
 * negative) and 'term:<market>|<external ad group id>|<term key>' (a shopper's search term; the key is the normalised
 * search text, percent-encoding allowed).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import prisma from '../../../db.js'
import { normalizeMarketplaceCode } from '../../../utils/marketplace-code.js'
import { callTool, ToolAccessError, type UserPrincipal } from '../../agents/call-tool.js'
import { requestApproval } from '../../agents/approval-gate.service.js'
import { PLAN_TOOL } from '../../agents/tool-types.js'
import { decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { isAsin } from '../ads-negation-policy.js'
import { ID_LIST } from '../ads-scope-lists.js'
import { HOLD_SELECT, holdActive, holdStateOf, keepUntilOf, type HoldColumns } from './hold.js'
import { WASTE_TOOLS } from './pure.js'
import { withReach, type Reach, type ReachTotal } from './reach.js'
import { isUnprotectArgs, linkRemovals, protectionContext, stopAfterRemovals, unprotectStep, type StepProtection, type StopRefusal, type Waits } from './protect.js'
import { followUpItems } from './follow-up.js'
import { wordPlaces } from './words.js'
import { parseWordId } from './words-pure.js'

export const WASTE_ACTIONS = ['PAUSE', 'NEGATE_EXACT', 'NEGATE_PHRASE', 'NEGATE_ASIN', 'TURN_ON', 'REMOVE_NEGATIVE', 'RELEASE', 'KEEP_UNTIL', 'UNPROTECT'] as const
export type WasteAction = (typeof WASTE_ACTIONS)[number]
/** The most rows one preview or apply names (a change plan's steps). */
export const MAX_WASTE_ITEMS = 200

export const WASTE_ITEM = z.object({
  rowId: z.string().trim().min(4).max(500),
  action: z.enum(WASTE_ACTIONS),
  where: z.enum(['adGroup', 'campaign']).optional(),
  keepUntil: z.string().trim().max(40).nullable().optional(),
  /** Polish M9 — REMOVE_NEGATIVE from our keyword's row: the negative over it (`neg:<AdTarget.id>`, the row's clash). */
  targetRowId: z.string().trim().min(4).max(80).optional(),
  /** Polish S17 — NEGATE_EXACT / NEGATE_PHRASE in this ad group (Nexus id) of the same product, where the term still runs. */
  adGroupId: z.string().trim().min(1).max(64).optional(),
  /** Step 4 — UNPROTECT: the protected term to remove (AdKeywordProtection.id, the row's `protection.terms`); the first by default. */
  protectionId: z.string().trim().min(1).max(64).optional(),
  /** Words view — a word's row (`word:<market>|<word>`) was read under the filter bar's lists: its places are those. */
  scope: z.object({ portfolioIds: ID_LIST.optional(), productIds: ID_LIST.optional(), campaignIds: ID_LIST.optional(), adGroupIds: ID_LIST.optional() }).strict().optional(),
})
export type WasteItem = z.infer<typeof WASTE_ITEM>
export const PREVIEW_BODY = z.object({
  items: z.array(WASTE_ITEM).min(1).max(MAX_WASTE_ITEMS),
  why: z.string().trim().max(300).optional(),
})
export const APPLY_BODY = PREVIEW_BODY.extend({
  planHash: z.string().trim().regex(/^[0-9a-f]{64}$/, 'the planHash the preview answered'),
  /** The approver's authenticator code, for a request that raises (its stepUp). Never stored. */
  code: z.string().trim().max(16).optional(),
})
export const DECIDE_BODY = z.object({
  decisions: z.array(z.object({
    approvalId: z.string().trim().min(1).max(64),
    decide: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(500).optional(),
    code: z.string().trim().max(16).optional(),
  })).min(1).max(50),
})

/** The tools the page's writes are made of (and the requests its Waiting rows may be). */
// NFIX — kept in pure.ts (the reads name a plan's steps that are not the page's without loading this file).
export { WASTE_TOOLS }

export interface Ref { id: string; name: string; href?: string }
export interface Place { portfolio: Ref | null; campaign: Ref | null; adGroup: Ref | null }
export interface PreviewStep {
  rowId: string
  action: WasteAction
  text: string | null
  place: Place
  from: string | null
  to: string | null
  /** Where it lands when sent: Amazon; Nexus only (a hold, or sandbox); or it waits for an approval with a code. */
  lands: 'amazon' | 'nexus' | 'approval' | null
  runsAt: string | null
  refusal: null | { code: string; label: string }
  raise: boolean
  /** Polish M1 — where a negative lands: one ad group, or the whole campaign (its place then ends at the campaign). */
  level: 'AD_GROUP' | 'CAMPAIGN' | null
  /** Polish M2 — a removal: archived at Amazon, it cannot come back (its Done has no Undo). */
  final: boolean
  needsCode: boolean
  tool: string | null
  /** The tool's own preview sentence, as this person may read it. */
  summary: string | null
  /** Step 4 — a NEGATE_* step: what it would block (reach.ts); null where its place cannot be read. Absent on other steps. */
  reach?: Reach | null
  /** Step 4 — UNPROTECT: the protected term it removes, its scope, why, and what else it keeps safe. */
  protection?: StepProtection
  /** Step 4 — it waits for its row's UNPROTECT (a negative of a protected term): never sent with it, sent once it ran. */
  after?: 'UNPROTECT'
}
/** One step as the preview reads it: the step, the tool request it is (null when left out) and the facts it stands on. */
export interface StepOut { step: PreviewStep; request: { tool: string; args: Record<string, unknown> } | null; basis: unknown }
/** `reach`: the steps that are sent, together (each term once); null when none adds a negative. */
export interface WastePreview { steps: PreviewStep[]; blocked: number; planHash: string; reach: ReachTotal | null }

// ── Pure: row ids, steps ────────────────────────────────────────────────────────────────────────────────────────────

export type RowRef =
  | { kind: 'kw' | 'neg'; targetId: string }
  | { kind: 'term'; market: string; extAdGroupId: string; termKey: string; text: string }

const decoded = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/** A page row id, read (pure); null when it is not one. */
export function parseRowId(id: string): RowRef | null {
  const t = id.trim()
  const kw = /^(kw|neg):([^\s|:]{1,64})$/.exec(t)
  if (kw) return { kind: kw[1] as 'kw' | 'neg', targetId: kw[2] }
  if (!t.startsWith('term:')) return null
  const parts = t.slice(5).split('|')
  if (parts.length < 3) return null
  const [market, extAdGroupId] = parts
  const termKey = parts.slice(2).join('|')
  const text = decoded(termKey).replace(/\s+/g, ' ').trim()
  if (!market.trim() || !extAdGroupId.trim() || !text) return null
  return { kind: 'term', market: market.trim().toUpperCase(), extAdGroupId: extAdGroupId.trim(), termKey, text }
}

/** Why this verb does not fit this row (pure), or null. */
export function actionRefusal(ref: RowRef, item: Pick<WasteItem, 'action' | 'where'> & Partial<Pick<WasteItem, 'targetRowId' | 'adGroupId'>>): { code: string; label: string } | null {
  const a = item.action
  // Step 4 — a protected term is removed from the row it keeps safe (ours or a shopper's), never from a negative.
  if (a === 'UNPROTECT') return ref.kind === 'neg' ? { code: 'wrong_verb', label: 'A standing negative can only be removed.' } : null
  if (ref.kind === 'kw') {
    // Polish M9 — the negative over our keyword (its clash) is removed from the keyword's row.
    if (a === 'REMOVE_NEGATIVE') return item.targetRowId?.startsWith('neg:') ? null : { code: 'wrong_verb', label: 'Name the negative to remove (the one over this keyword).' }
    // Polish S17 — our keyword's text negated in another ad group of the product, where it is still bought.
    if ((a === 'NEGATE_EXACT' || a === 'NEGATE_PHRASE') && item.adGroupId) return null
    if (!['PAUSE', 'TURN_ON', 'RELEASE', 'KEEP_UNTIL'].includes(a)) {
      return { code: 'keyword_is_paused_not_negated', label: 'Our own keyword or target is paused (and kept paused), never negated in its own ad group: a negative over it would block it.' }
    }
  }
  if (ref.kind === 'neg' && a !== 'REMOVE_NEGATIVE') return { code: 'wrong_verb', label: 'A standing negative can only be removed.' }
  if (ref.kind === 'term') {
    if (item.adGroupId && a === 'NEGATE_ASIN') return { code: 'wrong_verb', label: 'A product is negated in its own ad group only.' }
    if (!['NEGATE_EXACT', 'NEGATE_PHRASE', 'NEGATE_ASIN'].includes(a)) return { code: 'wrong_verb', label: 'A shopper\'s search term is negated (exact, phrase or as a product), not paused.' }
    const asin = isAsin(ref.text)
    if (a === 'NEGATE_ASIN' && !asin) return { code: 'not_an_asin', label: `"${ref.text}" is not an ASIN: negate it as exact or phrase.` }
    if (a !== 'NEGATE_ASIN' && asin) return { code: 'asin_term', label: `"${ref.text}" is an ASIN, a product: negate it as a product target (NEGATE_ASIN).` }
    if (a === 'NEGATE_ASIN' && item.where === 'campaign') return { code: 'asin_campaign_level', label: 'A product is negated inside its ad group only, not campaign-wide.' }
  }
  return null
}

/** What a keyword row is now, for its step. */
export interface TargetFacts { id: string; text: string; status: string; isNegative: boolean; hold: HoldColumns; negativeLevel?: string | null }

/** The tool request one row is (pure), or why not. `why` goes to the approver and the ads audit. */
export function requestFor(item: WasteItem, ref: RowRef, facts: { target?: TargetFacts; adGroupId?: string; campaignId?: string; negative?: TargetFacts }, why: string):
  { tool: string; args: Record<string, unknown> } | { refusal: { code: string; label: string } } {
  const t = facts.target
  if (ref.kind !== 'term' && !t) return { refusal: { code: 'not_found', label: 'This row is not in this business.' } }
  // Polish S17 — a named ad group: the term (or our keyword's text) negated there, at ad-group level.
  if ((item.action === 'NEGATE_EXACT' || item.action === 'NEGATE_PHRASE') && item.adGroupId) {
    const text = ref.kind === 'term' ? ref.text : t!.text
    return { tool: 'add-negative-targets', args: { negatives: [{ adGroupId: item.adGroupId, text, matchType: item.action === 'NEGATE_PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' }], why } }
  }
  switch (item.action) {
    case 'KEEP_UNTIL': {
      if (t!.isNegative) return { refusal: { code: 'is_negative', label: 'This is a negative: it is not paused.' } }
      if (t!.status !== 'PAUSED') return { refusal: { code: 'not_paused', label: 'It is not paused: pause it first (Pause keeps it paused).' } }
      const until = keepUntilOf(item.keepUntil ?? null)
      if ('refusal' in until) return { refusal: { code: 'keep_until', label: until.refusal } }
      return { tool: 'pause-ads', args: { targetIds: [t!.id], keepPaused: true, ...(until.until ? { keepUntil: until.until.toISOString() } : {}), why } }
    }
    case 'PAUSE': {
      if (t!.isNegative) return { refusal: { code: 'is_negative', label: 'This is a negative: remove it instead.' } }
      const until = keepUntilOf(item.keepUntil ?? null)
      if ('refusal' in until) return { refusal: { code: 'keep_until', label: until.refusal } }
      return { tool: 'pause-ads', args: { targetIds: [t!.id], keepPaused: true, ...(until.until ? { keepUntil: until.until.toISOString() } : {}), why } }
    }
    case 'TURN_ON':
      if (t!.isNegative) return { refusal: { code: 'is_negative', label: 'This is a negative: remove it instead.' } }
      return { tool: 'enable-ads', args: { targetIds: [t!.id], includePeoplesPauses: true, ...(holdActive(t!.hold) ? { releaseKeepPaused: true } : {}), why } }
    case 'RELEASE':
      if (!holdActive(t!.hold)) return { refusal: { code: 'not_kept_paused', label: 'It is not kept paused: there is no hold to release.' } }
      return t!.status === 'ENABLED'
        ? { tool: 'enable-ads', args: { targetIds: [t!.id], releaseKeepPaused: true, why } }
        : { tool: 'pause-ads', args: { targetIds: [t!.id], keepPaused: false, why } }
    case 'REMOVE_NEGATIVE': {
      // Polish M9 — from our keyword's row, the negative over it (resolved and checked by the caller).
      const n = ref.kind === 'kw' ? facts.negative : t
      if (!n) return { refusal: { code: 'not_found', label: 'That negative is not over this keyword (or no longer stands).' } }
      if (!n.isNegative) return { refusal: { code: 'not_a_negative', label: 'This is not a negative.' } }
      return { tool: 'retire-negatives', args: { negativeIds: [n.id], why } }
    }
    // Step 4 — a protected term's removal is its own step (protect.ts unprotectStep), never a row's tool request.
    case 'UNPROTECT': return { refusal: { code: 'wrong_verb', label: 'A protected term is removed by its own step.' } }
    default: {
      if (ref.kind !== 'term') return { refusal: { code: 'wrong_verb', label: 'Only a shopper\'s search term is negated.' } }
      const campaign = item.where === 'campaign'
      const place = campaign ? { campaignId: facts.campaignId } : { adGroupId: facts.adGroupId }
      if (!(campaign ? facts.campaignId : facts.adGroupId)) return { refusal: { code: 'place_not_found', label: 'Nexus holds no ad group with this search term\'s id in this market.' } }
      const negative = item.action === 'NEGATE_ASIN'
        ? { ...place, asin: ref.text.toUpperCase() }
        : { ...place, text: ref.text, matchType: item.action === 'NEGATE_PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' }
      return { tool: 'add-negative-targets', args: { negatives: [negative], why } }
    }
  }
}

/** The state a row goes from and to (pure, for the review's one line per change). */
export function fromTo(item: WasteItem, t: TargetFacts | undefined, now: Date = new Date()): { from: string | null; to: string | null } {
  const state = t ? holdStateOf({ ...t.hold, status: t.status, isNegative: t.isNegative }, now) : null
  switch (item.action) {
    case 'PAUSE': return { from: state, to: 'KEPT_PAUSED' }
    // Polish M3 — the hold's end: the old one and the new one (an ISO date, or ALWAYS); null: not kept paused before.
    case 'KEEP_UNTIL': {
      const old = t && holdActive(t.hold, now) ? (t.hold.keptPausedUntil?.toISOString() ?? 'ALWAYS') : null
      const next = keepUntilOf(item.keepUntil ?? null, now)
      return { from: old, to: 'refusal' in next ? null : next.until?.toISOString() ?? 'ALWAYS' }
    }
    case 'TURN_ON': return { from: state, to: 'RUNNING' }
    case 'RELEASE': return { from: state, to: t?.status === 'ENABLED' ? 'RUNNING' : 'PAUSED' }
    case 'REMOVE_NEGATIVE': return { from: 'NEGATED', to: 'REMOVED' }
    case 'UNPROTECT': return { from: 'PROTECTED', to: 'NOT_PROTECTED' }
    default: return { from: 'RUNNING', to: 'NEGATED' }
  }
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record<string, unknown>)[key]]))
  : value))

/** The planHash over the rows, their requests and the facts each tool's preview stands on (pure). */
export function planHashOf(items: readonly WasteItem[], steps: ReadonlyArray<{ request: { tool: string; args: Record<string, unknown> } | null; basis: unknown; refusal: { code: string } | null }>): string {
  const rows = items.map((i) => ({ rowId: i.rowId.trim(), action: i.action, where: i.where ?? null, keepUntil: i.keepUntil ?? null, ...(i.targetRowId ? { targetRowId: i.targetRowId } : {}), ...(i.adGroupId ? { adGroupId: i.adGroupId } : {}), ...(i.protectionId ? { protectionId: i.protectionId } : {}), ...(i.scope ? { scope: i.scope } : {}) }))
  return createHash('sha256').update(canonical({ rows, steps: steps.map((s) => ({ request: s.request, basis: s.basis ?? null, refusal: s.refusal?.code ?? null })) })).digest('hex')
}

/** "pause 2, negative exact 1" (pure). */
export function countsWords(actions: readonly WasteAction[]): string {
  const words: Record<WasteAction, string> = { PAUSE: 'pause', NEGATE_EXACT: 'negative exact', NEGATE_PHRASE: 'negative phrase', NEGATE_ASIN: 'negative product', TURN_ON: 'turn on', REMOVE_NEGATIVE: 'remove negative', RELEASE: 'release', KEEP_UNTIL: 'keep paused until', UNPROTECT: 'remove protection' }
  const n = new Map<WasteAction, number>()
  for (const a of actions) n.set(a, (n.get(a) ?? 0) + 1)
  return [...n].map(([a, c]) => `${words[a]} ${c}`).join(', ')
}

// ── Reads behind a step ─────────────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_REF_SELECT = { id: true, name: true, portfolioId: true, marketplace: true } as const
type CampaignRow = { id: string; name: string; portfolioId: string | null; marketplace: string | null }
type GroupRow = { id: string; name: string; externalAdGroupId: string | null; campaign: CampaignRow }

const campaignRef = (c: CampaignRow): Ref => ({ id: c.id, name: c.name, href: `/marketing/ads/campaigns/${c.id}` })
const groupRef = (g: { id: string; name: string }, campaignId: string, tab: string, focus: string | null): Ref => ({
  id: g.id, name: g.name, href: `/marketing/ads/campaigns/${campaignId}/ad-groups/${g.id}?tab=${tab}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`,
})

async function portfolioRefs(externalIds: string[]): Promise<Map<string, Ref>> {
  const ids = [...new Set(externalIds.filter(Boolean))]
  const rows = ids.length ? await prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: ids } }, select: { externalPortfolioId: true, name: true } }) : []
  const out = new Map<string, Ref>()
  for (const id of ids) {
    const r = rows.find((p) => p.externalPortfolioId === id)
    out.set(id, { id, name: r?.name ?? id, href: `/marketing/ads/portfolios/${id}` })
  }
  return out
}

/** A search-term row's ad group: the one with this external id in this market (a market's code or Amazon's id). */
async function termGroup(ref: Extract<RowRef, { kind: 'term' }>): Promise<GroupRow | null> {
  const groups = await prisma.adGroup.findMany({
    where: { externalAdGroupId: ref.extAdGroupId },
    select: { id: true, name: true, externalAdGroupId: true, campaign: { select: CAMPAIGN_REF_SELECT } },
    take: 5,
  }) as unknown as GroupRow[]
  const inMarket = groups.filter((g) => (normalizeMarketplaceCode(g.campaign.marketplace, '') || g.campaign.marketplace || '').toUpperCase() === ref.market)
  return inMarket[0] ?? (groups.length === 1 ? groups[0] : null)
}

type Resolved = { ref: RowRef; target?: TargetFacts; group?: GroupRow }

const TARGET_SELECT = {
  id: true, expressionValue: true, status: true, isNegative: true, negativeLevel: true, ...HOLD_SELECT,
  adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: CAMPAIGN_REF_SELECT } } },
} as const

/** A keyword, target or negative row as a step reads it, with its ad group (and campaign). */
async function targetOf(id: string): Promise<{ target: TargetFacts; group: GroupRow } | null> {
  const row = await prisma.adTarget.findUnique({ where: { id }, select: TARGET_SELECT })
  if (!row) return null
  const hold: HoldColumns = { keptPausedAt: row.keptPausedAt, keptPausedBy: row.keptPausedBy, keptPausedUntil: row.keptPausedUntil, keptPausedReason: row.keptPausedReason }
  return {
    target: { id: row.id, text: row.expressionValue, status: String(row.status), isNegative: row.isNegative, hold, negativeLevel: row.negativeLevel },
    group: row.adGroup as unknown as GroupRow,
  }
}

async function resolve(ref: RowRef): Promise<Resolved> {
  if (ref.kind === 'term') return { ref, group: (await termGroup(ref)) ?? undefined }
  const found = await targetOf(ref.targetId)
  return found ? { ref, target: found.target, group: found.group } : { ref }
}

/** The products an ad group advertises, with their parents (a product family counts as one product). */
async function productsOf(adGroupId: string): Promise<Set<string>> {
  const ads = await prisma.adProductAd.findMany({ where: { adGroupId, productId: { not: null } }, select: { productId: true, product: { select: { parentId: true } } } })
  const out = new Set<string>()
  for (const a of ads) { if (a.productId) out.add(a.productId); if (a.product?.parentId) out.add(a.product.parentId) }
  return out
}

/**
 * Polish S17 — a named ad group for a negative: one of the same product (an advertised product or its family in common)
 * where the term still runs (a search there in the last 90 days). Not our keyword's own ad group (it would block it).
 * The ad group, or why not.
 */
async function namedPlace(adGroupId: string, own: GroupRow | undefined, text: string, ownIsKeyword: boolean): Promise<{ group: GroupRow } | { refusal: { code: string; label: string } }> {
  const g = await prisma.adGroup.findUnique({ where: { id: adGroupId }, select: { id: true, name: true, externalAdGroupId: true, campaign: { select: CAMPAIGN_REF_SELECT } } }) as unknown as GroupRow | null
  if (!g) return { refusal: { code: 'place_not_found', label: 'That ad group is not in this business.' } }
  if (ownIsKeyword && own && g.id === own.id) return { refusal: { code: 'own_place', label: 'That is this keyword\'s own ad group: a negative there would block the keyword itself. Pause it instead.' } }
  if (own && g.id !== own.id) {
    const [mine, theirs] = await Promise.all([productsOf(own.id), productsOf(g.id)])
    if (!mine.size || ![...mine].some((p) => theirs.has(p))) return { refusal: { code: 'other_product', label: `"${g.name}" advertises another product: a negative there is that product's decision.` } }
  }
  const since = new Date(Date.now() - 90 * 86_400_000)
  const runs = g.externalAdGroupId
    ? await prisma.amazonAdsSearchTerm.count({ where: { adGroupId: g.externalAdGroupId, query: { equals: text, mode: 'insensitive' }, date: { gte: since } } })
    : 0
  if (!runs) return { refusal: { code: 'not_running_there', label: `"${text}" has not run in "${g.name}" in the last 90 days: there is nothing to block there.` } }
  return { group: g }
}

// ── Preview and apply ───────────────────────────────────────────────────────────────────────────────────────────────

const PAGE_WHY = 'Negative Targeting page'

/**
 * One row's step, dry-run as the person: what it would do, where it lands, or why not. `waitFor` (step 4): a stop after
 * its row's UNPROTECT — when its tool refuses it only for the terms being removed, the step waits for the removal.
 */
async function stepOf(item: WasteItem, person: UserPrincipal, why: string, portfolios: Map<string, Ref>, waitFor?: (r: StopRefusal) => Promise<Waits | null>): Promise<StepOut> {
  const ref = parseRowId(item.rowId)
  const empty: Place = { portfolio: null, campaign: null, adGroup: null }
  const final = item.action === 'REMOVE_NEGATIVE'
  const refused = (code: string, label: string, extra: Partial<PreviewStep> = {}) => ({
    step: { rowId: item.rowId, action: item.action, text: null, place: empty, from: null, to: null, lands: null, runsAt: null, refusal: { code, label }, raise: false, level: null, final, needsCode: false, tool: null, summary: null, ...extra } as PreviewStep,
    request: null, basis: null,
  })
  if (!ref) return refused('bad_row', 'This is not a row of the Negative Targeting page.')
  const verb = actionRefusal(ref, item)
  const r = await resolve(ref)
  let g = r.group
  let text = ref.kind === 'term' ? ref.text : r.target?.text ?? null
  const fromto = fromTo(item, r.target)
  if (verb) return refused(verb.code, verb.label, { text, ...fromto })
  if (ref.kind !== 'term' && !r.target) return refused('not_found', 'This keyword or negative is not in this business.', { text })
  if (ref.kind === 'term' && !g) return refused('place_not_found', 'Nexus holds no ad group with this search term\'s id in this market.', { text })

  // Polish M9 — the negative over our keyword (its clash): in the keyword's ad group, or a campaign negative of its campaign.
  let negative: TargetFacts | undefined
  if (item.action === 'REMOVE_NEGATIVE' && ref.kind === 'kw') {
    const n = item.targetRowId ? await targetOf(item.targetRowId.slice(4)) : null
    const over = n && n.target.isNegative && n.target.status !== 'ARCHIVED'
      && (n.group.id === g!.id || (n.target.negativeLevel === 'CAMPAIGN' && n.group.campaign.id === g!.campaign.id))
    if (!n || !over) return refused('not_over_keyword', 'That negative is not over this keyword (or no longer stands).', { text })
    negative = n.target
    g = n.group
    text = n.target.text
  }
  // Polish S17 — a named ad group of the same product where the term still runs.
  if ((item.action === 'NEGATE_EXACT' || item.action === 'NEGATE_PHRASE') && item.adGroupId) {
    const named = await namedPlace(item.adGroupId, g, text ?? '', ref.kind === 'kw')
    if ('refusal' in named) return refused(named.refusal.code, named.refusal.label, { text, ...fromto })
    g = named.group
  }

  // Polish M1 — where a negative lands; a campaign negative's place ends at its campaign.
  const level: PreviewStep['level'] = item.action === 'REMOVE_NEGATIVE'
    ? ((negative ?? r.target)?.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP')
    : item.action.startsWith('NEGATE_') ? (item.where === 'campaign' && !item.adGroupId && item.action !== 'NEGATE_ASIN' ? 'CAMPAIGN' : 'AD_GROUP') : null
  const focus = ref.kind === 'term' || item.adGroupId ? text : (negative ?? r.target)?.id ?? null
  const tab = ref.kind === 'term' || item.adGroupId ? 'search-terms' : negative || r.target?.isNegative ? 'ad-group-negative-keywords' : 'targets'
  const place: Place = g
    ? {
      portfolio: g.campaign.portfolioId ? portfolios.get(g.campaign.portfolioId) ?? { id: g.campaign.portfolioId, name: g.campaign.portfolioId, href: `/marketing/ads/portfolios/${g.campaign.portfolioId}` } : null,
      campaign: campaignRef(g.campaign),
      adGroup: level === 'CAMPAIGN' ? null : groupRef(g, g.campaign.id, tab, focus),
    }
    : empty
  const asked = requestFor(item, ref, { target: r.target, adGroupId: g?.id, campaignId: g?.campaign.id, negative }, why)
  if ('refusal' in asked) return refused(asked.refusal.code, asked.refusal.label, { text, place, level, ...fromto })
  const raise = item.action === 'REMOVE_NEGATIVE' || (item.action === 'TURN_ON' && r.target?.status !== 'ENABLED')
  // Step 4 — refused only for the protected terms being removed before it: the stop waits for the removal.
  const group = g
  const waiting = waitFor && group ? async (error: string): Promise<StepOut | null> => {
    const waits = await waitFor({ error, text: text ?? '', campaign: { id: group.campaign.id, marketplace: group.campaign.marketplace } })
    if (!waits) return null
    if (waits.refusal) return refused(waits.refusal.code, waits.refusal.label, { text, place, level, ...fromto, tool: asked.tool, raise })
    return {
      step: { rowId: item.rowId, action: item.action, text, place, ...fromto, lands: waits.lands, runsAt: null, refusal: null, raise, level, final, needsCode: false, tool: asked.tool, summary: 'Sent once the protection is removed.', after: 'UNPROTECT' },
      request: asked, basis: null,
    }
  } : undefined
  return dryRun(person, asked, { rowId: item.rowId, action: item.action, text, place, ...fromto, raise, level, final }, waiting)
}

type StepBase = Pick<PreviewStep, 'rowId' | 'action' | 'text' | 'place' | 'from' | 'to' | 'raise' | 'level' | 'final'>

/**
 * One step's request, dry-run as the person (callTool: permissions, business, arguments, the tool's own refusals).
 * `onRefused` (step 4): a stop after its row's UNPROTECT may wait for the removal instead of being refused.
 */
async function dryRun(person: UserPrincipal, asked: { tool: string; args: Record<string, unknown> }, base: StepBase, onRefused?: (error: string) => Promise<StepOut | null>): Promise<StepOut> {
  const refused = (code: string, label: string, raise: boolean): StepOut => ({
    step: { ...base, raise, lands: null, runsAt: null, refusal: { code, label }, needsCode: false, tool: asked.tool, summary: null }, request: null, basis: null,
  })
  try {
    const call = await callTool(person, asked.tool, asked.args)
    if (!call.raw.ok) return (await onRefused?.(call.raw.error ?? '')) ?? refused('refused', call.raw.error ?? 'refused', base.raise)
    const raw = (call.raw.preview ?? {}) as { reach?: { reach?: string }; stepUp?: unknown; basis?: unknown; needsCode?: number }
    const shown = (call.visible.preview ?? {}) as { effect?: unknown; summary?: unknown }
    const needsCode = raw.stepUp != null
    const lands = needsCode ? 'approval' : raw.reach?.reach === 'live' ? 'amazon' : 'nexus'
    const summary = typeof shown.effect === 'string' ? shown.effect : typeof shown.summary === 'string' ? shown.summary : null
    return { step: { ...base, lands, runsAt: null, refusal: null, needsCode, tool: asked.tool, summary }, request: asked, basis: raw.basis ?? null }
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    return refused(error.code === 'forbidden' ? 'forbidden' : 'refused', error.message, false)
  }
}

const WORD_LEFT_OUT: Readonly<Record<'BLOCKED' | 'HELD' | 'NOT_WASTING', string>> = { BLOCKED: 'already_blocked', HELD: 'held', NOT_WASTING: 'not_wasting' }

/**
 * Words view — "Block word": one negative phrase per place the word's terms spent in (words.ts wordPlaces, the same build
 * as the row), each dry-run as the person; a place that is blocked, held or does not waste is left out with why.
 */
async function wordStepsOf(item: WasteItem, person: UserPrincipal, why: string): Promise<StepOut[]> {
  const empty: Place = { portfolio: null, campaign: null, adGroup: null }
  const base = { rowId: item.rowId, action: item.action, from: 'RUNNING', to: 'NEGATED', raise: false, final: false } as const
  const leftOut = (code: string, label: string, b: Pick<StepBase, 'text' | 'place' | 'level'>): StepOut => ({
    step: { ...base, ...b, lands: null, runsAt: null, refusal: { code, label }, needsCode: false, tool: null, summary: null }, request: null, basis: null,
  })
  const text = parseWordId(item.rowId)?.word ?? null
  if (item.action !== 'NEGATE_PHRASE' || item.keepUntil != null || item.targetRowId || item.adGroupId) {
    return [leftOut('wrong_verb', 'A word is blocked as a negative phrase (Block word), in its ad groups or its whole campaigns.', { text, place: empty, level: null })]
  }
  const found = await wordPlaces(item.rowId, item.where === 'campaign' ? 'campaign' : 'adGroup', item.scope ?? {})
  if ('error' in found) return [leftOut(found.status === 404 ? 'not_found' : 'bad_row', found.error, { text, place: empty, level: null })]
  if (!found.places.length) return [leftOut('no_place', 'No ad group in the shown places runs a search term with this word.', { text: found.word, place: empty, level: null })]
  const out: StepOut[] = []
  for (const p of found.places) {
    const b = { text: found.word, place: { portfolio: p.portfolio, campaign: p.campaign, adGroup: p.level === 'CAMPAIGN' ? null : p.adGroup }, level: p.level }
    if (p.state !== 'OPEN') {
      out.push(leftOut(WORD_LEFT_OUT[p.state], p.state === 'BLOCKED' ? `Already blocked here: the negative phrase "${p.blockedBy?.text ?? found.word}" stands.` : p.held?.reason ?? 'Held here.', b))
      continue
    }
    const negative = { ...(p.level === 'CAMPAIGN' ? { campaignId: p.campaignId } : { adGroupId: p.adGroupId }), text: found.word, matchType: 'NEGATIVE_PHRASE' }
    out.push(await dryRun(person, { tool: 'add-negative-targets', args: { negatives: [negative], why } }, { ...base, ...b }))
  }
  // The places that get the block first, the ones left out after them (each still its own step of this word's item).
  return [...out.filter((o) => !o.step.refusal), ...out.filter((o) => o.step.refusal)]
}

/**
 * The preview of the page's rows: nothing written. Also returns each row's request, for apply. `reach: false` (apply)
 * leaves the reach check out: it is the review's, and the planHash does not stand on it.
 */
export async function previewWaste(items: readonly WasteItem[], person: UserPrincipal, why?: string | null, opts: { reach?: boolean } = {}): Promise<WastePreview & { requests: Array<{ tool: string; args: Record<string, unknown> } | null>; itemOf: number[] }> {
  const reason = why?.trim() ? `${PAGE_WHY}: ${why.trim()}` : PAGE_WHY
  // The portfolios the rows sit in, read once.
  const refs = items.map((i) => parseRowId(i.rowId))
  const kwIds = refs.flatMap((r) => (r && r.kind !== 'term' ? [r.targetId] : []))
  const ext = refs.flatMap((r) => (r && r.kind === 'term' ? [r.extAdGroupId] : []))
  const [targets, groups] = await Promise.all([
    kwIds.length ? prisma.adTarget.findMany({ where: { id: { in: kwIds } }, select: { adGroup: { select: { campaign: { select: { portfolioId: true } } } } } }) : [],
    ext.length ? prisma.adGroup.findMany({ where: { externalAdGroupId: { in: ext } }, select: { campaign: { select: { portfolioId: true } } } }) : [],
  ])
  const portfolios = await portfolioRefs([...targets.map((t) => t.adGroup?.campaign?.portfolioId ?? ''), ...groups.map((g) => g.campaign?.portfolioId ?? '')])
  const out: StepOut[] = []
  /** Words view — a word item's steps by its item index (one per place). */
  const wordSteps = new Map<number, StepOut[]>()
  const seen = new Set<string>()
  // Step 4 — a review that removes protected terms reads its rows once, and links each stop to its removals.
  const ctx = await protectionContext(items)
  for (const [index, item] of items.entries()) {
    // The same row named twice is one change: the second is refused, so a plan never runs a row twice. Step 4 — a row's
    // UNPROTECT is not its change ("Remove protection and stop" names both), and one protected term is removed once.
    const key = item.action !== 'UNPROTECT' ? item.rowId.trim() : item.protectionId ? `UNPROTECT|${item.protectionId}` : `${item.rowId.trim()}|UNPROTECT|`
    if (seen.has(key)) {
      out.push({ step: { rowId: item.rowId, action: item.action, text: null, place: { portfolio: null, campaign: null, adGroup: null }, from: null, to: null, lands: null, runsAt: null, refusal: { code: 'duplicate_row', label: 'This row is named twice: one change per row.' }, raise: false, level: null, final: item.action === 'REMOVE_NEGATIVE', needsCode: false, tool: null, summary: null }, request: null, basis: null })
      continue
    }
    seen.add(key)
    const stepWhy = `${reason} — ${item.action.toLowerCase().replace('_', ' ')}`
    if (item.action === 'UNPROTECT' && ctx) { out.push(await unprotectStep(item, person, ctx)); continue }
    // Words view — a word's row expands into one step per place (each its own change, its own Undo). They are kept
    // apart until the removals are linked: `out` stays one entry per item (protect.ts reads it by the item's index).
    if (parseWordId(key)) { const ws = await wordStepsOf(item, person, `${reason} — block word`); wordSteps.set(index, ws); out.push(ws[0]); continue }
    const removals = ctx?.links.get(index) ?? []
    out.push(ctx && removals.length
      ? await stopAfterRemovals(item, removals.map((i) => out[i]), ctx, (waitFor) => stepOf(item, person, stepWhy, portfolios, waitFor))
      : await stepOf(item, person, stepWhy, portfolios))
  }
  // Step 4 — a removal left out leaves its stops out; one whose every stop is left out stays as it is.
  if (ctx) linkRemovals(out, ctx.links)
  const all = out.flatMap((o, i) => wordSteps.get(i) ?? [o])
  /** Each step's item (a word's steps share theirs). */
  const itemOf = out.flatMap((o, i) => (wordSteps.get(i) ?? [o]).map(() => i))
  // Step 4 — what each negative would block, once every item is a step (a word's places too).
  const reached = opts.reach === false ? { steps: all.map((o) => o.step), total: null } : await withReach(all.map((o) => o.step))
  const steps = reached.steps
  return {
    steps,
    blocked: steps.filter((s) => s.refusal).length,
    planHash: planHashOf(items, all.map((o) => ({ request: o.request, basis: o.basis, refusal: o.step.refusal }))),
    requests: all.map((o) => o.request),
    itemOf,
    reach: reached.total,
  }
}

export type ApplyAnswer =
  | { http: 200 | 202; body: Record<string, unknown> }
  | { http: 400 | 403 | 409; body: Record<string, unknown> }

/**
 * Apply what the person previewed: the same preview again (409 when its planHash moved), the rows not refused as ONE
 * request (the tool, or one change plan of one step per row), asked as the person and approved by the same person now
 * through the Approvals page's path. A failed approve (a code needed or wrong) leaves the request waiting: status
 * `waiting`, with why.
 */
export async function applyWaste(body: z.infer<typeof APPLY_BODY>, person: UserPrincipal): Promise<ApplyAnswer> {
  const fresh = await previewWaste(body.items, person, body.why, { reach: false })
  if (fresh.planHash !== body.planHash) {
    return { http: 409, body: { error: 'The rows changed since the preview (a status, a hold, a negative or a refusal moved): preview again.', code: 'stale_preview', planHash: fresh.planHash, steps: fresh.steps, blocked: fresh.blocked } }
  }
  // Step 4 — a step that waits for its row's UNPROTECT is not sent now: the server sends it once the removal ran (a follow-up).
  const sending = fresh.steps.flatMap((s, i) => (!s.refusal && !s.after && fresh.requests[i] ? [{ step: s, request: fresh.requests[i]! }] : []))
  const waiting = new Set(fresh.steps.flatMap((s, i) => (!s.refusal && s.after ? [fresh.itemOf[i]] : [])))
  const followUp = async (approvalId: string | undefined) => {
    if (!waiting.size || !approvalId) return null
    const { createFollowUp } = await import('./follow-up.js')
    return createFollowUp({ approvalId, items: followUpItems(body.items, waiting), by: `user:${person.userId}` })
  }
  if (!sending.length) return { http: 400, body: { error: 'Nothing to send: every row was refused (each says why).', steps: fresh.steps, blocked: fresh.blocked } }
  const title = `Negative Targeting: ${countsWords(sending.map((s) => s.step.action))}`.slice(0, 120)
  const asked = sending.length === 1
    ? await requestApproval(sending[0].request.tool, sending[0].request.args, person)
    : await requestApproval(PLAN_TOOL, { title, steps: sending.map((s) => s.request) }, person)
  if (asked.ok && asked.mode === 'executed') {
    return { http: 200, body: { changeSetId: null, status: 'applied', steps: fresh.steps, blocked: fresh.blocked, result: asked.data ?? null } }
  }
  if (!asked.ok || asked.mode !== 'queued' || !asked.approvalId) {
    return { http: 400, body: { error: asked.error ?? 'Not queued: the request was refused.', ...(asked.refusals ? { refusals: asked.refusals } : {}), steps: fresh.steps, blocked: fresh.blocked } }
  }
  const stepUp = (asked.preview as { stepUp?: unknown } | undefined)?.stepUp ?? null
  const out = await decideFleetApproval({ id: asked.approvalId, decision: 'approve', actor: person, code: body.code, reason: body.why ?? title })
  const approve = { ok: out.ok, ...(out.code ? { code: out.code } : {}), ...(out.error ? { error: out.error } : {}) }
  // Step 4 — the negatives that wait for this removal: the server sends them once it ran, as this person.
  const later = await followUp(asked.approvalId)
  return {
    http: 202,
    body: {
      changeSetId: asked.approvalId,
      status: out.ok ? 'queued' : 'waiting',
      ...(out.executeAfter ? { executeAfter: out.executeAfter } : {}),
      expiresAt: asked.expiresAt?.toISOString() ?? null,
      tool: sending.length === 1 ? sending[0].request.tool : PLAN_TOOL,
      needsCode: !!stepUp,
      ...(stepUp ? { stepUp } : {}),
      approve,
      steps: fresh.steps.map((s) => (s.refusal || s.after ? s : { ...s, runsAt: out.executeAfter ?? null })),
      blocked: fresh.blocked,
      undo: 'POST /api/advertising/changes/… or undo-change with this changeSetId (the whole set) or a step\'s change id (one row).',
      ...(later ? { followUp: later } : {}),
    },
  }
}

// ── Waiting requests ────────────────────────────────────────────────────────────────────────────────────────────────

/** A rule's Ask-me card as the page's Waiting rows name it (NREAD: `suggestion:<AdsRuleSuggestion.id>`). */
export const SUGGESTION_PREFIX = 'suggestion:'

/** Is this card one of the page's (a pause_target on a keyword or target, or a search term's negative)? */
export async function isWasteCard(suggestionId: string): Promise<boolean> {
  const card = await prisma.adsRuleSuggestion.findUnique({ where: { id: suggestionId }, select: { entityType: true, proposedAction: true } })
  if (!card) return false
  const type = String(((card.proposedAction ?? {}) as { type?: unknown }).type ?? '')
  return (card.entityType === 'AD_TARGET' && type === 'pause_target') || (card.entityType === 'SEARCH_TERM' && (type === 'add_negative_exact' || type === 'add_negative_phrase'))
}

/**
 * Is this a request the page's Waiting rows may decide (one of its tools, or a change plan holding one)? Step 4 — a
 * protected term's removal (alone, or a plan of removals) is the page's only when the page sent it: it has the page's
 * follow-up (the negatives that wait for it; the page never sends a removal without its stop). Anyone else's
 * set-ad-guardrail removal is never the page's to take back or reject.
 */
export async function isWasteRequest(approvalId: string): Promise<boolean> {
  const ap = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { toolName: true, args: true } })
  if (!ap) return false
  if ((WASTE_TOOLS as readonly string[]).includes(ap.toolName)) return true
  const followed = async () => (await prisma.adsWasteFollowUp.count({ where: { approvalId } })) > 0
  if (isUnprotectArgs(ap.toolName, ap.args)) return followed()
  if (ap.toolName !== PLAN_TOOL) return false
  return (await prisma.agentPlanStep.count({ where: { approvalId, toolName: { in: [...WASTE_TOOLS] } } })) > 0 || followed()
}

/**
 * A rule's Ask-me card decided on the page, through the Suggestions page's own code (ads-suggestion-decide.service.ts):
 * approve = applySuggestion (the halt, the rule still standing behind it, the handler and the write gate; the rule's
 * pause_target keeps the keyword paused), reject = dismissSuggestion. A refused apply stays waiting, with the reason.
 */
async function decideCard(d: z.infer<typeof DECIDE_BODY>['decisions'][number], person: UserPrincipal): Promise<DecideResult> {
  const id = d.approvalId.slice(SUGGESTION_PREFIX.length)
  if (!id || !(await isWasteCard(id))) return { approvalId: d.approvalId, decide: d.decide, ok: false, httpStatus: 404, error: 'No card of the Negative Targeting page waits with this id.' }
  const { applySuggestion, dismissSuggestion } = await import('../ads-suggestion-decide.service.js')
  const by = `user:${person.userId}`
  const r = d.decide === 'approve' ? await applySuggestion(id, {}, by) : await dismissSuggestion(id, by)
  const status = (await prisma.adsRuleSuggestion.findUnique({ where: { id }, select: { status: true } }))?.status ?? 'gone'
  return {
    approvalId: d.approvalId, decide: d.decide, ok: r.ok, status,
    ...(r.error ? { error: r.error } : {}),
    ...(!r.ok ? { httpStatus: r.httpStatus ?? (r.refused ? 400 : 409) } : {}),
  }
}

export interface DecideResult { approvalId: string; decide: 'approve' | 'reject'; ok: boolean; status?: string; executeAfter?: string; code?: string; error?: string; httpStatus?: number }

/** Approve or reject waiting requests, each through the Approvals page's own path (decideFleetApproval). */
export async function decideWaiting(decisions: z.infer<typeof DECIDE_BODY>['decisions'], person: UserPrincipal): Promise<DecideResult[]> {
  const out: DecideResult[] = []
  for (const d of decisions) {
    // A rule's Ask-me card: the Suggestions page's own apply (approve) or dismiss (reject), as this person.
    if (d.approvalId.startsWith(SUGGESTION_PREFIX)) {
      out.push(await decideCard(d, person))
      continue
    }
    if (!(await isWasteRequest(d.approvalId))) {
      out.push({ approvalId: d.approvalId, decide: d.decide, ok: false, httpStatus: 404, error: 'No request of the Negative Targeting page waits with this id.' })
      continue
    }
    const r = await decideFleetApproval({ id: d.approvalId, decision: d.decide, actor: person, code: d.code, reason: d.reason })
    out.push({
      approvalId: d.approvalId, decide: d.decide, ok: r.ok,
      ...(r.status ? { status: r.status } : {}), ...(r.executeAfter ? { executeAfter: r.executeAfter } : {}),
      ...(r.code ? { code: r.code } : {}), ...(r.error ? { error: r.error } : {}),
      ...(!r.ok ? { httpStatus: r.httpStatus ?? (r.code === 'forbidden' ? 403 : r.code ? 400 : 409) } : {}),
    })
  }
  return out
}
