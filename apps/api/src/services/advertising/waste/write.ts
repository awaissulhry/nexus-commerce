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
 *
 * Every step also says its `level` (AD_GROUP / CAMPAIGN: a campaign negative's place ends at its campaign) and `final`
 * (a removal is archived at Amazon and cannot come back: its Done has no Undo) — polish M1, M2.
 *
 * preview  writes nothing: every row's step, where it lands, its refusal (the tool's own words), whether it raises spend,
 *          and a planHash over the rows, the requests and the facts they stand on.
 * apply    the same preview again; a different planHash is 409 (something moved: preview again). The rows that are not
 *          refused become ONE request — the tool itself for one row, else one change plan (submit-change-plan), one step
 *          per row (so each row has its own change and Undo) — asked as the person and approved by the same person at
 *          once through the Approvals page's path (decideFleetApproval: the undo window; a request that raises needs
 *          settings.security.manage and the authenticator code). The answer: { changeSetId, status, steps, … }.
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
import { HOLD_SELECT, holdActive, holdStateOf, keepUntilOf, type HoldColumns } from './hold.js'

export const WASTE_ACTIONS = ['PAUSE', 'NEGATE_EXACT', 'NEGATE_PHRASE', 'NEGATE_ASIN', 'TURN_ON', 'REMOVE_NEGATIVE', 'RELEASE', 'KEEP_UNTIL'] as const
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
export const WASTE_TOOLS = ['pause-ads', 'enable-ads', 'add-negative-targets', 'retire-negatives', 'create-negative-keyword'] as const

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
}
export interface WastePreview { steps: PreviewStep[]; blocked: number; planHash: string }

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
    default: return { from: 'RUNNING', to: 'NEGATED' }
  }
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record<string, unknown>)[key]]))
  : value))

/** The planHash over the rows, their requests and the facts each tool's preview stands on (pure). */
export function planHashOf(items: readonly WasteItem[], steps: ReadonlyArray<{ request: { tool: string; args: Record<string, unknown> } | null; basis: unknown; refusal: { code: string } | null }>): string {
  const rows = items.map((i) => ({ rowId: i.rowId.trim(), action: i.action, where: i.where ?? null, keepUntil: i.keepUntil ?? null, ...(i.targetRowId ? { targetRowId: i.targetRowId } : {}), ...(i.adGroupId ? { adGroupId: i.adGroupId } : {}) }))
  return createHash('sha256').update(canonical({ rows, steps: steps.map((s) => ({ request: s.request, basis: s.basis ?? null, refusal: s.refusal?.code ?? null })) })).digest('hex')
}

/** "pause 2, negative exact 1" (pure). */
export function countsWords(actions: readonly WasteAction[]): string {
  const words: Record<WasteAction, string> = { PAUSE: 'pause', NEGATE_EXACT: 'negative exact', NEGATE_PHRASE: 'negative phrase', NEGATE_ASIN: 'negative product', TURN_ON: 'turn on', REMOVE_NEGATIVE: 'remove negative', RELEASE: 'release', KEEP_UNTIL: 'keep paused until' }
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

/** One row's step, dry-run as the person: what it would do, where it lands, or why not. */
async function stepOf(item: WasteItem, person: UserPrincipal, why: string, portfolios: Map<string, Ref>): Promise<{ step: PreviewStep; request: { tool: string; args: Record<string, unknown> } | null; basis: unknown }> {
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
  try {
    const call = await callTool(person, asked.tool, asked.args)
    if (!call.raw.ok) return { ...refused('refused', call.raw.error ?? 'refused', { text, place, level, ...fromto, tool: asked.tool, raise }), request: null }
    const raw = (call.raw.preview ?? {}) as { reach?: { reach?: string }; stepUp?: unknown; basis?: unknown; needsCode?: number }
    const shown = (call.visible.preview ?? {}) as { effect?: unknown; summary?: unknown }
    const needsCode = raw.stepUp != null
    const lands = needsCode ? 'approval' : raw.reach?.reach === 'live' ? 'amazon' : 'nexus'
    const summary = typeof shown.effect === 'string' ? shown.effect : typeof shown.summary === 'string' ? shown.summary : null
    return {
      step: { rowId: item.rowId, action: item.action, text, place, ...fromto, lands, runsAt: null, refusal: null, raise, level, final, needsCode, tool: asked.tool, summary },
      request: asked, basis: raw.basis ?? null,
    }
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    return refused(error.code === 'forbidden' ? 'forbidden' : 'refused', error.message, { text, place, level, ...fromto, tool: asked.tool })
  }
}

/** The preview of the page's rows: nothing written. Also returns each row's request, for apply. */
export async function previewWaste(items: readonly WasteItem[], person: UserPrincipal, why?: string | null): Promise<WastePreview & { requests: Array<{ tool: string; args: Record<string, unknown> } | null> }> {
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
  const out: Array<Awaited<ReturnType<typeof stepOf>>> = []
  const seen = new Set<string>()
  for (const item of items) {
    // The same row named twice is one change: the second is refused, so a plan never runs a row twice.
    const key = item.rowId.trim()
    if (seen.has(key)) {
      out.push({ step: { rowId: item.rowId, action: item.action, text: null, place: { portfolio: null, campaign: null, adGroup: null }, from: null, to: null, lands: null, runsAt: null, refusal: { code: 'duplicate_row', label: 'This row is named twice: one change per row.' }, raise: false, level: null, final: item.action === 'REMOVE_NEGATIVE', needsCode: false, tool: null, summary: null }, request: null, basis: null })
      continue
    }
    seen.add(key)
    out.push(await stepOf(item, person, `${reason} — ${item.action.toLowerCase().replace('_', ' ')}`, portfolios))
  }
  const steps = out.map((o) => o.step)
  return {
    steps,
    blocked: steps.filter((s) => s.refusal).length,
    planHash: planHashOf(items, out.map((o) => ({ request: o.request, basis: o.basis, refusal: o.step.refusal }))),
    requests: out.map((o) => o.request),
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
  const fresh = await previewWaste(body.items, person, body.why)
  if (fresh.planHash !== body.planHash) {
    return { http: 409, body: { error: 'The rows changed since the preview (a status, a hold, a negative or a refusal moved): preview again.', code: 'stale_preview', planHash: fresh.planHash, steps: fresh.steps, blocked: fresh.blocked } }
  }
  const sending = fresh.steps.flatMap((s, i) => (!s.refusal && fresh.requests[i] ? [{ step: s, request: fresh.requests[i]! }] : []))
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
      steps: fresh.steps.map((s) => (s.refusal ? s : { ...s, runsAt: out.executeAfter ?? null })),
      blocked: fresh.blocked,
      undo: 'POST /api/advertising/changes/… or undo-change with this changeSetId (the whole set) or a step\'s change id (one row).',
    },
  }
}

// ── Waiting requests ────────────────────────────────────────────────────────────────────────────────────────────────

/** A rule's Ask-me card as the page's Waiting rows name it (NREAD: `suggestion:<AdsRuleSuggestion.id>`). */
export const SUGGESTION_PREFIX = 'suggestion:'
/** The cards the page decides: our keyword paused (and kept paused), a shopper's search term negated. */
export const WASTE_CARD_ACTIONS = ['pause_target', 'add_negative_exact', 'add_negative_phrase'] as const

/** Is this card one of the page's (a pause_target on a keyword or target, or a search term's negative)? */
export async function isWasteCard(suggestionId: string): Promise<boolean> {
  const card = await prisma.adsRuleSuggestion.findUnique({ where: { id: suggestionId }, select: { entityType: true, proposedAction: true } })
  if (!card) return false
  const type = String(((card.proposedAction ?? {}) as { type?: unknown }).type ?? '')
  return (card.entityType === 'AD_TARGET' && type === 'pause_target') || (card.entityType === 'SEARCH_TERM' && (type === 'add_negative_exact' || type === 'add_negative_phrase'))
}

/** Is this a request the page's Waiting rows may decide (one of its tools, or a change plan holding one)? */
export async function isWasteRequest(approvalId: string): Promise<boolean> {
  const ap = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { toolName: true } })
  if (!ap) return false
  if ((WASTE_TOOLS as readonly string[]).includes(ap.toolName)) return true
  if (ap.toolName !== PLAN_TOOL) return false
  return (await prisma.agentPlanStep.count({ where: { approvalId, toolName: { in: [...WASTE_TOOLS] } } })) > 0
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
