/**
 * ONE BRAIN AB-15 — what holds one lever of one product's brain right now, for the lever's own run to obey before it writes
 * or asks: the Owner's kill switch (brain/kill-switch.ts) and the holds that follow an undo by auto-undo (brain/undo-levers.ts
 * holdsOf: the brain must not redo at once what auto-undo just put back — like UNDO_PIN for a bid).
 *
 *   kill    the whole lever, every campaign and term of it, until the Owner ends it
 *   holds   one campaign's budget (7 days), one campaign's pause or resume (7 days), one portfolio's cap (7 days), one term's
 *           negative (30 days) — read from the judgements auto-undo put back (AdsAutoUndoJudgement, origin `brain`, action
 *           `undone`, younger than the lever's hold): the record of the undo IS the hold, so it ends by itself and every
 *           screen that lists A19's judgements shows why
 *
 * Read only. Two queries at most (the kills are remembered; the undone judgements of the lever, by the action index). With no
 * product enrolled nothing calls it.
 */
import prisma from '../../../db.js'
import { killWords, productKills } from './kill-switch.js'
import type { BrainLever } from './levers.js'
import { blocksHeldTerm, BRAIN_UNDO_RULES, holdsOf, type BrainUndoLever, type LeverUndoHolds, type UndoneChange } from './undo-levers.js'

const DAY_MS = 86_400_000
type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export interface LeverHolds extends LeverUndoHolds {
  /** The kill switch on the lever for this product, in words; null: not stopped. */
  kill: string | null
}

const NONE = (): LeverUndoHolds => ({ campaigns: new Map(), terms: new Map(), portfolios: new Map() })

/** The changes of one lever auto-undo put back for this product whose hold may still run. */
export async function undoneChanges(lever: BrainUndoLever, productId: string, now: Date): Promise<UndoneChange[]> {
  const longest = Math.max(...Object.entries(BRAIN_UNDO_RULES).filter(([k]) => k === lever || k.startsWith(`${lever}:`)).map(([, r]) => r.holdDays))
  const rows = await prisma.adsAutoUndoJudgement.findMany({
    where: { origin: 'brain', lever, action: 'undone', actionAt: { gte: new Date(now.getTime() - longest * DAY_MS) }, evidence: { path: ['productId'], equals: productId } },
    select: { id: true, lever: true, direction: true, entityId: true, actionAt: true, evidence: true },
  })
  return rows.filter((r) => r.actionAt).map((r) => {
    const e = obj(r.evidence)
    return { id: r.id, lever: r.lever, kind: r.direction, entityId: r.entityId, campaignId: str(e.campaignId), term: str(e.term), externalPortfolioId: str(e.externalPortfolioId), actionAt: r.actionAt! }
  })
}

/**
 * What holds `lever` of this product in this market now: the kill switch, and the holds after auto-undo's undos (only for
 * the levers auto-undo judges; the bids keep BB-10's BidHold UNDO_PIN and HELD campaign).
 */
export async function leverHolds(lever: BrainLever, productId: string, market: string, now: Date = new Date()): Promise<LeverHolds> {
  const kill = (await productKills(productId, market))[lever]
  const judged = (['budgets', 'portfolioCap', 'state', 'negatives', 'harvest', 'biddingStrategy'] as const).find((l) => l === lever)
  const holds = judged ? holdsOf(await undoneChanges(judged, productId, now), judged, now) : NONE()
  return { kill: kill ? killWords(kill) : null, ...holds }
}

/** A campaign's hold of the lever in words (the kill first), for an action it would take; null: nothing holds it. */
export function campaignHoldWhy(h: LeverHolds, campaignId: string, action?: 'pause' | 'resume' | string | null): string | null {
  if (h.kill) return h.kill
  const c = h.campaigns.get(campaignId)
  if (!c) return null
  return !c.blocks || !action || c.blocks === action ? c.why : null
}

/**
 * The money writer's holds (budget-live.ts moneyStepsOf): a campaign's budget and a portfolio's cap the kill switch or an
 * undo holds, in words; null: free.
 */
export async function moneyHolds(productId: string, market: string, now: Date = new Date()): Promise<{ budget: (campaignId: string) => string | null; cap: (portfolioId: string) => string | null }> {
  const [b, p] = await Promise.all([leverHolds('budgets', productId, market, now), leverHolds('portfolioCap', productId, market, now)])
  return {
    budget: (campaignId) => campaignHoldWhy(b, campaignId),
    cap: (portfolioId) => p.kill ?? p.portfolios.get(portfolioId)?.why ?? null,
  }
}

/** The negatives run's holds (negatives-run.ts): every item under a kill; an add that would block a held term. Pure. */
export function holdNegatives<P extends { items: Array<{ action: string; text: string; match: string; heldBy: string | null }> }>(plan: P, h: Pick<LeverHolds, 'kill' | 'terms'>): P {
  if (!h.kill && !h.terms.size) return plan
  return {
    ...plan,
    items: plan.items.map((i) => {
      if (i.heldBy) return i
      if (h.kill) return { ...i, heldBy: h.kill }
      if (i.action !== 'ADD') return i
      const term = blocksHeldTerm(i.text, i.match, h.terms)
      return term ? { ...i, heldBy: h.terms.get(term)!.why } : i
    }),
  }
}
