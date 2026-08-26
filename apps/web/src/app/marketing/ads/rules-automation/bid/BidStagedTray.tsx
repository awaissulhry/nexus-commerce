'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the docked grace-window tray for staged bid writes.
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: Suggestions — a staged write awaiting its window IS a pending suggestion.
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S4 — the staged tray: the 5-minute grace window, visible and cancellable.
 *
 * The mechanism is the one that already existed (`GRACE_PERIOD_MS` in ads-mutation.service, the
 * outbox hold, `POST /queued-mutations/:id/cancel`) — nothing here re-implements it. The console's
 * `StagedChangesTray` could not be mounted as-is because it is per-campaign and coupled to the
 * cockpit's undo API; this is the account-wide sibling on the SAME endpoints, and the console copy
 * retires with the console.
 *
 * Countdown honesty: the server's `now` rides along in the payload and the remaining time is
 * computed against server-minus-client skew, because this repo has already paid for trusting a
 * client clock against Railway's. A row past its hold renders "syncing…" — cancel may still win
 * the race, so the button stays until the row leaves the queue.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Clock, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const eurFromCents = (v: string | null): string => {
  if (v == null || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? `€${(n / 100).toFixed(2)}` : v
}

interface StagedItem {
  queueId: string
  entityName: string
  campaignName: string | null
  field: string
  oldValue: string | null
  newValue: string | null
  holdUntil: string | null
}

/** S4 broadcasts on this after staging so the tray refreshes without waiting out its poll. */
export const BID_STAGED_EVENT = 'nexus:bid-staged-changed'

export function BidStagedTray() {
  const [items, setItems] = useState<StagedItem[] | null>(null)
  const [skewMs, setSkewMs] = useState(0)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/staged-writes?field=bid`, { cache: 'no-store' })
      if (!r.ok) return
      const j = await r.json() as { now: string; items: StagedItem[] }
      if (!alive.current) return
      setItems(j.items ?? [])
      setSkewMs(new Date(j.now).getTime() - Date.now())
    } catch { /* a failed poll keeps the last state; the next one corrects it */ }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const poll = setInterval(() => void load(), 20_000)
    const onStaged = () => void load()
    window.addEventListener(BID_STAGED_EVENT, onStaged)
    return () => { alive.current = false; clearInterval(poll); window.removeEventListener(BID_STAGED_EVENT, onStaged) }
  }, [load])

  // The 1s countdown only runs while something is staged.
  const count = items?.length ?? 0
  useEffect(() => {
    if (count === 0) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [count])
  void tick

  const discard = async (queueId: string) => {
    setBusy(queueId)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/queued-mutations/${queueId}/cancel`, { method: 'POST' })
    } catch { /* reload below shows the truth either way */ }
    setBusy(null)
    void load()
  }

  if (items == null || items.length === 0) return null

  const serverNow = Date.now() + skewMs
  const remaining = (holdUntil: string | null): string => {
    if (!holdUntil) return 'syncing…'
    const ms = new Date(holdUntil).getTime() - serverNow
    if (ms <= 0) return 'syncing…'
    const s = Math.floor(ms / 1000)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  return (
    <section id="bid-staged" className="h10-bd4-tray" aria-label="Staged bid writes">
      <h4><Clock size={13} aria-hidden /> {items.length.toLocaleString('en-IE')} staged bid write{items.length === 1 ? '' : 's'} — each syncs to Amazon when its 5-minute hold expires</h4>
      <ul>
        {items.slice(0, 8).map((it) => (
          <li key={`${it.queueId}-${it.field}`}>
            <span className="t" title={it.campaignName ?? undefined}>{it.entityName}</span>
            <span className="nw">{eurFromCents(it.oldValue)} → <b>{eurFromCents(it.newValue)}</b></span>
            <span className="nw cd">{remaining(it.holdUntil)}</span>
            <Button variant="danger-outline" size="xs" disabled={busy === it.queueId} title="Discard before it reaches Amazon" onClick={() => void discard(it.queueId)}>
              <Trash2 size={12} aria-hidden /> Discard
            </Button>
          </li>
        ))}
        {items.length > 8 && <li className="more">…and {items.length - 8} more in the hold</li>}
      </ul>
    </section>
  )
}
