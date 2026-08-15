'use client'

/**
 * HV.7 — the harvest slice of THE ONE INBOX.
 *
 * §11 C10: Negative Targeting, Keyword Harvest and Bid all queue `AdsRuleSuggestion` rows; they
 * FILTER the one inbox, they do not build their own. This section reads the SAME endpoint the
 * Automations queue reads, narrows to the harvest keys (`promote_to_exact` · `harvest_and_negate`),
 * groups exactly as A6 groups — (proposedKey × entityType), because the unique key
 * (ruleId, entityId, proposedKey) makes repeats refresh one row — and sends every DECISION to
 * Automations → Queue. One dedupe key, one expiry policy, one applied-vs-applied-with-edit
 * distinction, because the graduation model reads that distinction and two implementations would
 * disagree about it.
 *
 * 🔴 Stated, not hidden: an ENGINE on Propose cannot queue a suggestion — `AdsRuleSuggestion`
 * requires a `ruleId` and `ads-auto-harvest` has none, so the disarmed engine's propose-only mode
 * is notify-only. What appears here is what RULES propose. Widening the model (nullable ruleId +
 * actor) is on the arming decision's table, where it belongs — queueability and armability are
 * the same conversation.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, Inbox } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { HvSlotProps } from './slot-contract'

const HARVEST_KEYS = new Set(['promote_to_exact', 'harvest_and_negate'])

interface Suggestion {
  id: string
  ruleId: string | null
  ruleName?: string | null
  entityType: string | null
  entityId: string | null
  proposedKey: string
  proposedAction: { type?: string } & Record<string, unknown>
  createdAt: string
}

const num = (n: number) => n.toLocaleString('en-IE')

export function HvQueue(_props: HvSlotProps) {
  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/suggestions?status=pending&limit=300`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => {
        if (!alive) return
        const all = (j?.items ?? j?.suggestions ?? []) as Suggestion[]
        setItems(all.filter((s) => HARVEST_KEYS.has(s.proposedKey) || HARVEST_KEYS.has(String(s.proposedAction?.type ?? ''))))
        setErr(null)
      })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [])

  const groups = useMemo(() => {
    const m = new Map<string, Suggestion[]>()
    for (const s of items ?? []) {
      const k = `${s.proposedKey}|${s.entityType ?? ''}`
      const list = m.get(k) ?? []
      list.push(s)
      m.set(k, list)
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [items])

  return (
    <section id="hv-queue" className="h10-bd7">
      <h3><Inbox size={14} aria-hidden /> Pending — the harvest slice of the one inbox</h3>
      {err != null ? (
        <p className="h10-bd8-err" role="alert"><AlertTriangle size={13} aria-hidden /> The queue failed to load {err} — a failed read, not an empty inbox.</p>
      ) : items == null ? (
        <p className="h10-bd8-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="h10-bd8-muted">No pending harvest proposal. Rules on Propose queue here when they match; the disarmed engine cannot queue at all (it has no ruleId to sign with) — its propose mode is notify-only, which is a stated limit, not an empty account.</p>
      ) : (
        <>
          <ul className="h10-hv7-groups">
            {groups.map(([k, list]) => {
              const first = list[0]
              return (
                <li key={k}>
                  <b>{num(list.length)}</b> × {first.proposedKey}
                  {first.entityType && <span className="et"> on {first.entityType.toLowerCase().replace(/_/g, ' ')}</span>}
                  {first.ruleName && <span className="rn"> · from “{first.ruleName}”</span>}
                </li>
              )
            })}
          </ul>
          <p className="h10-bd8-foot">
            {num(items.length)} pending across {groups.length} decision{groups.length === 1 ? '' : 's'} — approve, edit or reject on{' '}
            <Link href="/marketing/ads/rules-automation/automations?view=queue">Automations → Queue <ExternalLink size={11} aria-hidden /></Link>.
            {' '}One inbox, one dedupe key, one expiry policy; this section only narrows it.
          </p>
        </>
      )}
    </section>
  )
}
