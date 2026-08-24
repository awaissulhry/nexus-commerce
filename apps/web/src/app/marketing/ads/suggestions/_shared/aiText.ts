/**
 * SGX (2026-08-24) — split out of `SuggestionsClient.tsx`, which had grown to 2,447 lines holding
 * seven tabs. Moved VERBATIM: a relocation, not a rewrite, so `git log -L` over any symbol here
 * still reaches the SG commit that reasoned about it.
 */

import type { HoverContent } from '../ApproveHoverCard'
import type { AiDecision } from './types'

/** Compact before→after reading for a decision's Json pair — only keys that CHANGED, "—" when
 *  neither side says anything (an unreadable change must not render as an empty confident cell).
 *  Known storage keys read back in operator units (the D2d law: no field paths, no cents). */
export const AI_KEY_READERS: Record<string, { label: string; fmt: (v: unknown) => string }> = {
  bidCents: { label: 'Bid', fmt: (v) => (Number.isFinite(Number(v)) ? `€${(Number(v) / 100).toFixed(2)}` : String(v)) },
  dailyBudgetEur: { label: 'Budget', fmt: (v) => (Number.isFinite(Number(v)) ? `€${Number(v).toFixed(2)}` : String(v)) },
  budgetCents: { label: 'Budget', fmt: (v) => (Number.isFinite(Number(v)) ? `€${(Number(v) / 100).toFixed(2)}` : String(v)) },
}
export function aiChangeText(module: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  const parts = keys
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
    .map((k) => {
      // SG.8 — the conductor's OWN storage key is the bare `{cents}` (ad-autopilot.job.ts
      // wraps beforeCents/afterCents); the module names what the cents are. Without this,
      // every real proposal printed "cents 42 → 51" — storage keys, not operator units (D2d).
      const r = AI_KEY_READERS[k]
        ?? (k === 'cents' ? { label: module === 'budget' ? 'Budget' : 'Bid', fmt: (v: unknown) => (Number.isFinite(Number(v)) ? `€${(Number(v) / 100).toFixed(2)}` : String(v)) } : undefined)
      const read = (v: unknown) => (v == null ? '—' : r ? r.fmt(v) : String(v))
      return `${r?.label ?? k} ${read(before?.[k])} → ${read(after?.[k])}`
    })
  return parts.length ? parts.join(' · ') : '—'
}

/**
 * SG.9 — what hovering ✓ on an A.I. row promises. The bid module needs its own sentence: the
 * approve does NOT write the figure in the Change column — it re-runs the plan's optimizer at
 * apply time, so the bids that land are computed fresh. Saying that here is the difference
 * between a preview and a guess.
 */
export const AI_MODULE_EXPLAINER: Record<string, string> = {
  bid: 'Approving re-runs this plan’s bid optimizer over the campaign’s targets at apply time, inside the plan’s bid band. The bids that land are computed fresh, so they can differ from the figure shown here.',
  budget: 'Approving sets this campaign’s daily budget to the proposed value, through the same write gate an AUTO plan uses.',
  placement: 'Approving nudges this campaign’s Top-of-Search bid modifier toward the proposed value.',
}
export function aiHoverContent(r: AiDecision, onEdit: () => void): HoverContent {
  const applyable = ['bid', 'budget', 'placement'].includes(r.module)
  return {
    title: `Plan: ${r.planName ?? 'A.I. plan'}`,
    sub: applyable
      ? (AI_MODULE_EXPLAINER[r.module] ?? 'Approving executes this change through the write gate.')
      : `The ${r.module} module has no live apply path yet — this row can only be removed or muted.`,
    headers: ['Module', 'Change', 'Campaign', 'Cycle', 'Notes'],
    rows: [{
      badge: null,
      typeLabel: r.module,
      bid: aiChangeText(r.module, r.before, r.after),
      campaign: r.campaignName ?? 'account-wide',
      adProduct: null,
      adGroup: r.cycle,
      note: r.planEnabled ? (applyable ? 'Applicable' : 'Not applyable') : 'Plan disabled — proposals are stale',
    }],
    action: { label: 'Review decision', onClick: onEdit },
  }
}
