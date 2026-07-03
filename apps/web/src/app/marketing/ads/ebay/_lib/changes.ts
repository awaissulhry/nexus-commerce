/**
 * ER3.4 — the one payload-diff summariser for audit rows, extracted verbatim
 * from the campaign Activity tab so the account-wide Change Log renders
 * changes identically. Pure formatting; no behaviour change to either surface.
 */
import { money } from '../../campaigns/_grid/format'
import type { ActionRow } from './types'

export function actionSummary(a: ActionRow): string {
  const after = a.payloadAfter ?? {}
  const parts: string[] = []
  if (after.rates && typeof after.rates === 'object') parts.push(`${Object.keys(after.rates as object).length} rate(s)`)
  if (Array.isArray(after.results)) { const r = after.results as Array<{ ok: boolean }>; parts.push(`${r.filter((x) => x.ok).length}/${r.length} ok`) }
  if (after.dailyBudgetCents != null) parts.push(`budget → ${money(Number(after.dailyBudgetCents))}`)
  if (after.status != null) parts.push(`status → ${String(after.status)}`)
  if (after.name != null) parts.push(`name → ${String(after.name)}`)
  if (after.endDate !== undefined) parts.push(`end date → ${after.endDate == null ? 'never' : String(after.endDate).slice(0, 10)}`)
  if (after.posture != null) parts.push(`posture → ${String(after.posture)}${after.protected != null ? ` · protected ${String(after.protected)}` : ''}`)
  if (after.field != null) parts.push(`${String(after.field)}${after.value != null ? ` → ${String(after.value)}` : ''}`)
  if (after.counts && typeof after.counts === 'object') parts.push(Object.entries(after.counts as Record<string, number>).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', '))
  return parts.join(' · ')
}

export const SOURCE_LABELS: Record<string, { label: string; cls: string; tip: string }> = {
  automation: { label: 'automation', cls: 'ok', tip: 'Applied by a rule or engine guard (autopilot within guardrails, or an approved suggestion applied by the engine actor)' },
  operator: { label: 'operator', cls: 'arch', tip: 'A human did this in the console' },
  external_accepted: { label: 'external (accepted)', cls: 'warn', tip: 'The change originated on eBay (Seller Hub / easy boost); an operator accepted it as the new baseline via Drift' },
}
