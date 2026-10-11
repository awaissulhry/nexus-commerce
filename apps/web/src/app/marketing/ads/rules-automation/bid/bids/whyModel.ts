/**
 * Bid page, Bids view — "why this bid" and "what if" in the side panel, from the bid brain's own read views
 * (`GET /api/advertising/automation/brain/bid-brain/why|what-if?targetId=…`, bid-brain/read.ts). Pure, tested in Node
 * (`whyModel.vitest.test.ts`).
 *
 * Words only, no jargon (audit §2): a decision is Up · Down · Hold · Brake and how long ago ("Down · 3 h ago"); the layer
 * that decided it shows only when it is not the usual goal ("Night floor", "Low stock"). Its numbers: Target bid · Target
 * ACoS · Range · Expected ACoS · Data to. Money keys may be absent (hidden from this person): a dash. Time and money
 * are the page's one helper (`_shared/format.ts`).
 */
import { dayWords, moneyText } from '../_shared/format'

export interface BrainDecision {
  targetId: string
  keyword: string | null
  campaignId: string | null
  market: string | null
  action: string
  layer: string
  currentCents?: number | null
  decidedCents?: number | null
  goalBidCents?: number | null
  aimPct?: number | null
  bandLoPct?: number | null
  bandHiPct?: number | null
  expectedAcosPct?: number | null
  confidence: number | null
  dataDay: string
  decidedAt: string
  lastWriter: string | null
  why?: string | null
  mode: string
  sent?: unknown
}

export interface WhatIfDecision {
  targetId: string
  currentCents?: number | null
  decidedCents?: number | null
  whatIfCents?: number | null
  whatIfAction: string
  whatIfLayer: string
  why?: string | null
}

/** The layer that decided, in a short label (bid-owner.ts brainHeldBy uses the same words). */
const LAYER_WORD: Record<string, string> = {
  goal: 'Goal',
  band: 'In range',
  restore: 'Morning give-back',
  min_bid_hour: 'Night floor',
  no_goal: 'Not enough data',
  money: 'Money brake',
  intraday: 'Spend brake',
  brake: 'Brake',
  stop: 'Stop',
  stock: 'Low stock',
  freeze: 'Undo freeze',
  phase: 'Launch phase',
  limit: 'Limit',
  pin: 'You',
  explore: 'Test',
  revive: 'Test',
  probe: 'Test',
}

export function layerWord(layer: string | null | undefined): string {
  const l = (layer ?? '').trim()
  if (!l) return '—'
  return LAYER_WORD[l] ?? (l.charAt(0).toUpperCase() + l.slice(1)).replace(/_/g, ' ')
}

/** The usual layers (the goal, inside its range) say nothing the action does not: no tag. */
const USUAL_LAYERS = new Set(['goal', 'band'])

/** The layer's tag beside the action, or null when it is the usual goal. */
export function layerTag(layer: string | null | undefined): string | null {
  const l = (layer ?? '').trim()
  return !l || USUAL_LAYERS.has(l) ? null : layerWord(l)
}

export type DecisionTone = 'success' | 'warning' | 'neutral' | 'danger'

/** Up · Down · Hold · Brake, with its tone. */
export function actionWord(d: { action: string; currentCents?: number | null; decidedCents?: number | null }): { label: string; tone: DecisionTone } {
  if (d.action === 'brake') return { label: 'Brake', tone: 'danger' }
  if (d.action === 'write') {
    const cur = d.currentCents, next = d.decidedCents
    if (typeof cur === 'number' && typeof next === 'number') {
      if (next > cur) return { label: 'Up', tone: 'success' }
      if (next < cur) return { label: 'Down', tone: 'warning' }
    }
    return { label: 'Set', tone: 'neutral' }
  }
  return { label: 'Hold', tone: 'neutral' }
}

const pctText = (p: number | null | undefined) => (typeof p === 'number' && Number.isFinite(p) ? `${p} %` : '—')

export interface Fact { label: string; value: string }

/** The decision as label → number pairs, for a KeyValue. Nothing in words but the labels; no confidence score. */
export function decisionFacts(d: BrainDecision, currency: string): Fact[] {
  const range = typeof d.bandLoPct === 'number' || typeof d.bandHiPct === 'number' ? `${pctText(d.bandLoPct)} – ${pctText(d.bandHiPct)}` : '—'
  return [
    { label: 'Target bid', value: moneyText(d.goalBidCents, currency) },
    { label: 'Target ACoS', value: pctText(d.aimPct) },
    { label: 'Range', value: range },
    { label: 'Expected ACoS', value: pctText(d.expectedAcosPct) },
    { label: 'Data to', value: dayWords(d.dataDay) },
  ]
}

/** The decision for one keyword out of a view's answer; null when the brain has none. */
export function decisionFor<T extends { targetId: string }>(answer: unknown, targetId: string): T | null {
  const list = (answer as { decisions?: unknown } | null)?.decisions
  if (!Array.isArray(list)) return null
  return (list as T[]).find((d) => d && d.targetId === targetId) ?? null
}

/** "15 %" or "15.5 %" → 15.5; anything outside 1–500 → null (the what-if read takes 1–500). */
export function parseAcosPct(text: string): number | null {
  const t = text.trim().replace(',', '.').replace(/\s*%$/, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 500 ? n : null
}
