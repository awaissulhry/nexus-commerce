/**
 * Negative Targeting page, step 4 (2026-10-25) — the "Protected" tile: wasting rows that a protected term
 * (AdKeywordProtection, mode WHITELIST) keeps safe, and their two actions.
 *
 *   rows     a PROTECTED row carries `protection` (pure.ts RowProtection): EVERY protected term that holds it (the one
 *            the page names first, as its held verb does), each with its match, scope (a market or every market, a
 *            campaign or every campaign) and why; `then` is the hold its verb keeps once they are all removed (null: it
 *            can stop).
 *   tile     show=protected — the test met, PROTECTED, not skipped (pure.ts isKeptSafe); totals.protected counts the same.
 *   keep     "Keep protected" is the page's Skip for 30 days (skip.ts): the protection stays, the row is out of view.
 *   remove   "Remove protection and stop" is ONE review: first an UNPROTECT step per protected term that holds the row,
 *            through Claude's own guardrail tool (set-ad-guardrail, kind protected-term, op remove →
 *            ads-guardrail-change.service.ts → ads-guardrail.service.ts removeKeywordProtection: its audit row
 *            `remove_keyword_protection`, its approval, its undo that puts the term back), then the row's own verb. A pause
 *            (our keyword) passes its dry run beside the removal: both go as ONE change set. A negative (a shopper's term)
 *            is refused by its tool while the term stands (the negation policy refuses every writer, ads-write-gate.ts):
 *            its step WAITS for the removal (`after: 'UNPROTECT'`, never sent with it) and the page sends it once the
 *            removal ran — two change sets, in order. A stop the review cannot send leaves the protection as it is.
 *   reach    what else a term keeps safe: the other words of the rows it holds over its own scope (`alsoKeeps`).
 *
 * The removal goes through the guardrail tool, never the ads strategy's protected-terms write: the strategy writes only
 * a market's own terms (no campaign term and no every-market term) as part of a strategy version, while the guardrail
 * tool takes any term by its stored key and is the one Claude uses to remove a protected term alone.
 */
import { callTool, ToolAccessError, type UserPrincipal } from '../../agents/call-tool.js'
import { normaliseTerm, protectedTermHit, protectedTermRefusal, protectionMatchType, type ProtectedTerm } from '../ads-negation-policy.js'
import { campaignHref, parseRowId, plainWords, termKeyOf, type RowProtection, type RowProtectionTerm, type WasteRow } from './pure.js'
import type { WasteFacts } from './read.js'
import type { PreviewStep, StepOut, WasteItem } from './write.js'

/** A protected term as the facts hold it: its stored scope (`marketplace` as stored; `market` as the page compares it). */
export interface Protection extends ProtectedTerm {
  id: string
  marketplace: string | null
  market: string | null
  campaignId: string | null
}

/** What else a protected term keeps safe over its scope (the other words of the rows it holds). Counts, no money. */
export interface AlsoKeeps {
  count: number
  terms: Array<{ text: string; kind: WasteRow['kind']; places: number; wasting: boolean }>
}

/** An UNPROTECT step's protected term, with what else it keeps safe (absent when the step is left out before that). */
export type StepProtection = RowProtectionTerm & { alsoKeeps?: AlsoKeeps }

/** At most this many words in `alsoKeeps.terms` (its `count` is all of them). */
export const ALSO_KEEPS_SHOWN = 30

// ── Pure ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The protections of a campaign's scope (its market or every market; it or every campaign). */
export function protectionsInScope<P extends Pick<Protection, 'market' | 'campaignId'>>(list: readonly P[], market: string | null | undefined, campaignId: string): P[] {
  return list.filter((p) => (!p.market || p.market === market) && (!p.campaignId || p.campaignId === campaignId))
}

/**
 * Every protection that holds this text, in the list's order — the first is the one the page names (protectedTermHit's
 * first hit). Our keyword is matched as written; a shopper's term as the negative exact the page would add.
 */
export function protectionsHolding<P extends ProtectedTerm>(list: readonly P[], text: string, asNegative: boolean): P[] {
  const match = asNegative ? 'NEGATIVE_EXACT' : 'EXACT'
  return list.filter((p) => protectedTermHit(text, match, [p]) != null)
}

/** A row's protection as it shows it (the campaign named from the facts). */
export function rowProtectionOf(f: Pick<WasteFacts, 'campaigns'>, holding: readonly Protection[], then: RowProtection['then']): RowProtection {
  return {
    terms: holding.map((p) => {
      const c = p.campaignId ? f.campaigns.get(p.campaignId) : undefined
      return {
        id: p.id, term: p.term, match: protectionMatchType(p), market: p.market,
        campaign: p.campaignId ? { id: p.campaignId, name: c?.name ?? p.campaignId, href: campaignHref(p.campaignId) } : null,
        reason: plainWords(p.reason ?? null),
      }
    }),
    then,
  }
}

/**
 * The other words a protection keeps safe, from rows that run (each held by it): one line per words, those the review
 * stops left out, wasting ones first. Pure.
 */
export function alsoKeepsOf(rows: ReadonlyArray<Pick<WasteRow, 'text' | 'kind' | 'protection' | 'test' | 'askOnly'>>, protectionId: string, except: ReadonlySet<string>): AlsoKeeps {
  const byKey = new Map<string, { text: string; kind: WasteRow['kind']; places: number; wasting: boolean }>()
  for (const r of rows) {
    if (r.askOnly || !r.protection?.terms.some((t) => t.id === protectionId)) continue
    const key = termKeyOf(r.text)
    if (!key || except.has(key)) continue
    const cur = byKey.get(key)
    if (cur) { cur.places++; cur.wasting = cur.wasting || r.test.met; continue }
    byKey.set(key, { text: r.text, kind: r.kind, places: 1, wasting: r.test.met })
  }
  const terms = [...byKey.values()].sort((a, b) => Number(b.wasting) - Number(a.wasting) || b.places - a.places || a.text.localeCompare(b.text))
  return { count: terms.length, terms: terms.slice(0, ALSO_KEEPS_SHOWN) }
}

/**
 * The stop's dry run was refused ONLY by protected terms this same review removes: its tool's refusal is the negation
 * policy's own sentence for one of them (ads-negation-policy.ts protectedTermRefusal, as add-negative-targets words it:
 * "Not queued: …"), and every term that holds the row is being removed. Then the step waits for the removal instead of
 * being left out; anything else in the refusal leaves it out, in the tool's words. Pure.
 */
export function refusedOnlyByRemoved(error: string, text: string, removing: readonly ProtectedTerm[], holdingIds: readonly string[], removingIds: readonly string[]): boolean {
  if (!holdingIds.length || !holdingIds.every((id) => removingIds.includes(id))) return false
  return removing.some((p) => error.trim() === `Not queued: ${protectedTermRefusal(text, { protection: p, via: 'text' })}`)
}

/** The request that removes one protected term: Claude's guardrail tool, keyed as the term is stored. Pure. */
export function unprotectRequest(p: Pick<Protection, 'term' | 'marketplace' | 'campaignId'>): { tool: string; args: Record<string, unknown> } {
  return {
    tool: 'set-ad-guardrail',
    args: { kind: 'protected-term', op: 'remove', term: normaliseTerm(p.term), ...(p.marketplace ? { marketplace: p.marketplace } : {}), ...(p.campaignId ? { campaignId: p.campaignId } : {}) },
  }
}

/** Is this stored request the page's removal of a protected term (so the page may take its approve back and reject it)? */
export function isUnprotectArgs(toolName: string, args: unknown): boolean {
  const a = (args ?? {}) as { kind?: unknown; op?: unknown }
  return toolName === 'set-ad-guardrail' && a.kind === 'protected-term' && a.op === 'remove'
}

/**
 * Each stop's removals: the UNPROTECT items before it of its own row, or of a protected term that holds it — so in a bulk
 * review one protected term holding many rows is ONE removal, linked to every stop it holds back. Pure.
 */
export function linksOf(items: readonly WasteItem[], holdingOf: (rowId: string) => readonly string[]): Map<number, number[]> {
  // The first UNPROTECT of each protected term (a second one is refused as named twice) and of each row (no term named).
  const first = new Map<string, number>()
  items.forEach((it, j) => {
    if (it.action !== 'UNPROTECT') return
    const k = it.protectionId ? `p:${it.protectionId}` : `r:${it.rowId.trim()}`
    if (!first.has(k)) first.set(k, j)
  })
  const links = new Map<number, number[]>()
  items.forEach((item, i) => {
    if (item.action === 'UNPROTECT') return
    const row = item.rowId.trim()
    const keys = [`r:${row}`, ...holdingOf(row).map((id) => `p:${id}`)]
    const before = [...new Set(keys.flatMap((k) => (first.has(k) && first.get(k)! < i ? [first.get(k)!] : [])))].sort((a, b) => a - b)
    if (before.length) links.set(i, before)
  })
  return links
}

const NOT_PROTECTED = 'not_protected'

function refusedOut(item: WasteItem, code: string, label: string, extra: Partial<PreviewStep> = {}): StepOut {
  return {
    step: {
      rowId: item.rowId, action: item.action, text: null, place: { portfolio: null, campaign: null, adGroup: null }, from: null, to: null,
      lands: null, runsAt: null, refusal: { code, label }, raise: false, level: null, final: false, needsCode: false, tool: null, summary: null, ...extra,
    },
    request: null,
    basis: null,
  }
}

/**
 * After every step is read: a stop whose removal is left out (other than one already done) is left out; a removal is left
 * out when every stop that needs it is (the protection stays as it is); a removal no stop needs stays as asked. Mutates
 * `out`. Pure.
 */
export function linkRemovals(out: StepOut[], links: ReadonlyMap<number, readonly number[]>): void {
  for (const [i, before] of links) {
    const stop = out[i]
    const blocking = before.map((j) => out[j]).find((r) => r.step.refusal && r.step.refusal.code !== NOT_PROTECTED)
    if (blocking && !stop.step.refusal) {
      out[i] = { ...stop, step: { ...stop.step, refusal: { code: 'needs_unprotect', label: `The protection stays (its removal is left out: ${blocking.step.refusal!.label.replace(/\.$/, '')}), so it cannot stop.` }, after: undefined }, request: null }
    }
  }
  const needs = new Map<number, number[]>()
  for (const [i, before] of links) for (const j of before) needs.set(j, [...(needs.get(j) ?? []), i])
  for (const [j, stops] of needs) {
    if (out[j].step.refusal || !stops.every((i) => out[i].step.refusal)) continue
    const why = out[stops[0]].step.refusal!.label.replace(/\.$/, '')
    out[j] = { ...out[j], step: { ...out[j].step, refusal: { code: 'stop_left_out', label: `${stops.length > 1 ? 'Every stop it holds back is' : 'The stop is'} left out (${why}), so the protection stays.` } }, request: null }
  }
}

// ── Reads behind the review ─────────────────────────────────────────────────────────────────────────────────────────

/** What a review with removals reads once: its rows as the page shows them, each stop's removals, the stops' words. */
export interface ProtectionContext {
  rows: Map<string, WasteRow>
  links: Map<number, number[]>
  /** The words of the rows this review names: "also keeps" never counts them. */
  except: Set<string>
}

/** The rows as the page shows them now (each market's facts, the memo the page reads), by id. */
async function rowsNow(rowIds: readonly string[], now: Date): Promise<Map<string, WasteRow>> {
  const { buildWasteRows, marketCode, scopedFacts } = await import('./read.js')
  const { default: prisma } = await import('../../../db.js')
  const ids = new Set(rowIds.map((id) => id.trim()))
  const markets = new Set<string>()
  const kwIds: string[] = []
  for (const id of ids) {
    const parsed = parseRowId(id)
    if (parsed?.kind === 'term') { const m = marketCode(parsed.market); if (m) markets.add(m) } else if (parsed?.kind === 'kw') kwIds.push(parsed.targetId)
  }
  if (kwIds.length) {
    for (const t of await prisma.adTarget.findMany({ where: { id: { in: kwIds } }, select: { adGroup: { select: { campaign: { select: { marketplace: true } } } } } })) {
      const m = marketCode(t.adGroup.campaign.marketplace)
      if (m) markets.add(m)
    }
  }
  const out = new Map<string, WasteRow>()
  for (const market of markets) {
    const read = await scopedFacts({ market }, now)
    if ('error' in read) continue
    for (const f of read.facts) for (const r of buildWasteRows(f, { idle: true })) if (ids.has(r.id) && !r.askOnly) out.set(r.id, r)
  }
  return out
}

/** The context of a review that removes protected terms; null when it removes none. */
export async function protectionContext(items: readonly WasteItem[], now: Date = new Date()): Promise<ProtectionContext | null> {
  if (!items.some((i) => i.action === 'UNPROTECT')) return null
  const rows = await rowsNow(items.map((i) => i.rowId), now)
  const links = linksOf(items, (rowId) => rows.get(rowId)?.protection?.terms.map((t) => t.id) ?? [])
  const except = new Set(items.map((i) => rows.get(i.rowId.trim())).filter((r): r is WasteRow => !!r).map((r) => termKeyOf(r.text)))
  return { rows, links, except }
}

/** What else this protected term keeps safe, over its own scope (its market, or every market with Amazon ads; its campaign). */
async function alsoKept(p: RowProtectionTerm, except: ReadonlySet<string>, now: Date = new Date()): Promise<AlsoKeeps> {
  const { buildWasteRows, scopedFacts } = await import('./read.js')
  const out = await scopedFacts({ market: p.market ?? undefined }, now)
  if ('error' in out) return { count: 0, terms: [] }
  const rows = out.facts.flatMap((f) => buildWasteRows(f, p.campaign ? { campaignId: p.campaign.id } : {}))
  return alsoKeepsOf(rows, p.id, except)
}

/** The stored protection (its raw scope, for the tool's key), or null when it is not this business's. */
async function storedProtection(id: string): Promise<(ProtectedTerm & { id: string; marketplace: string | null; campaignId: string | null }) | null> {
  const { default: prisma } = await import('../../../db.js')
  return prisma.adKeywordProtection.findFirst({ where: { id, mode: 'WHITELIST' }, select: { id: true, term: true, matchType: true, isPrefix: true, reason: true, marketplace: true, campaignId: true } })
}

/**
 * One protected term's removal, dry-run as the person through Claude's guardrail tool: what it removes, where (its
 * scope), what else it keeps safe — or why not. `not_protected`: no such term holds the row now (it was removed: the
 * stop after it is then read as any other).
 */
export async function unprotectStep(item: WasteItem, person: UserPrincipal, ctx: ProtectionContext, now: Date = new Date()): Promise<StepOut> {
  const row = ctx.rows.get(item.rowId.trim())
  if (!row) return refusedOut(item, 'not_found', 'This row is not in this business.')
  const holding = row.state === 'PROTECTED' ? row.protection?.terms ?? [] : []
  if (!holding.length) return refusedOut(item, NOT_PROTECTED, 'No protected term keeps it safe now.', { text: row.text, from: 'RUNNING', to: 'NOT_PROTECTED' })
  const term = item.protectionId ? holding.find((t) => t.id === item.protectionId) : holding[0]
  const stored = term ? await storedProtection(term.id) : null
  if (!term || !stored) return refusedOut(item, NOT_PROTECTED, 'That protected term does not keep it safe now.', { text: row.text })
  const base: Partial<PreviewStep> = {
    text: term.term, place: { portfolio: null, campaign: term.campaign, adGroup: null }, from: 'PROTECTED', to: 'NOT_PROTECTED',
    tool: 'set-ad-guardrail', raise: true, protection: term,
  }
  const request = unprotectRequest(stored)
  try {
    const call = await callTool(person, request.tool, request.args)
    if (!call.raw.ok) return refusedOut(item, 'refused', call.raw.error ?? 'refused', base)
    const raw = (call.raw.preview ?? {}) as { stepUp?: unknown }
    const shown = (call.visible.preview ?? {}) as { effect?: unknown }
    const needsCode = raw.stepUp != null
    return {
      step: {
        rowId: item.rowId, action: 'UNPROTECT', text: term.term, place: base.place!, from: 'PROTECTED', to: 'NOT_PROTECTED',
        lands: needsCode ? 'approval' : 'nexus', runsAt: null, refusal: null, raise: true, level: null, final: false, needsCode,
        tool: request.tool, summary: typeof shown.effect === 'string' ? shown.effect : null,
        protection: { ...term, alsoKeeps: await alsoKept(term, ctx.except, now) },
      },
      request,
      basis: { protection: stored.id, term: stored.term, matchType: stored.matchType ?? null, isPrefix: stored.isPrefix ?? null },
    }
  } catch (error) {
    if (!(error instanceof ToolAccessError)) throw error
    return refusedOut(item, error.code === 'forbidden' ? 'forbidden' : 'refused', error.message, base)
  }
}

/** What a stop's dry run hands back when its tool refused it (the stop's words and campaign). */
export interface StopRefusal { error: string; text: string; campaign: { id: string; marketplace: string | null } }
/** A stop that waits for the removal: where it lands then, or why not (the write gate, protection aside). */
export type Waits = { lands: 'amazon' | 'nexus'; refusal: null } | { lands: null; refusal: { code: string; label: string } }

/**
 * The stop after its removals: read as any other when the terms are already gone; left out when a removal is;
 * else its dry run, which waits for the removal when only the terms being removed refuse it (`waitFor`).
 */
export async function stopAfterRemovals(item: WasteItem, removals: readonly StepOut[], ctx: ProtectionContext, run: (waitFor?: (r: StopRefusal) => Promise<Waits | null>) => Promise<StepOut>): Promise<StepOut> {
  // Its row is protected now (until the removal runs): the review's "Now" says so, whichever row carries the removal.
  const held = ctx.rows.get(item.rowId.trim())?.state === 'PROTECTED'
  const now = (o: StepOut): StepOut => (held ? { ...o, step: { ...o.step, from: 'PROTECTED' } } : o)
  if (removals.every((r) => r.step.refusal?.code === NOT_PROTECTED)) return now(await run())
  if (removals.some((r) => r.step.refusal)) return now(await run())
  const holdingIds = ctx.rows.get(item.rowId.trim())?.protection?.terms.map((t) => t.id) ?? []
  const removing = await Promise.all(removals.map((r) => storedProtection(r.step.protection?.id ?? '')))
  const terms = removing.filter((p): p is NonNullable<typeof p> => !!p)
  return now(await run(async (r) => {
    if (!item.action.startsWith('NEGATE_') || !refusedOnlyByRemoved(r.error, r.text, terms, holdingIds, terms.map((p) => p.id))) return null
    const { checkLiveReach } = await import('../../agents/tools/ads-tool-guards.js')
    const reach = await checkLiveReach({ campaignId: r.campaign.id, marketplace: r.campaign.marketplace, changes: [{ field: 'negativeKeyword', valueCents: null }] })
    if (reach.reach === 'refused') return { lands: null, refusal: { code: 'refused', label: reach.reason } }
    return { lands: reach.reach === 'live' ? 'amazon' : 'nexus', refusal: null }
  }))
}
