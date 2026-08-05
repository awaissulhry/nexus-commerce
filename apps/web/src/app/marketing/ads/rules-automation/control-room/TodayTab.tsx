'use client'

/**
 * ACR.1.4 — Today: what needs a human right now, priced and ranked.
 *
 * The board an operator who wants to stop watching actually opens. Levers answers "what is
 * allowed to act"; this answers "what is going wrong, and what is it costing me".
 *
 * Two things it deliberately does NOT do:
 *
 *   · It does not show a € where there isn't one. Rows carry `amountCents: null` with a note
 *     saying what the missing number would have measured, rather than a 0 that ranks a real
 *     problem below a trivial one. Same rule as the profit surfaces (ACR.0.5).
 *   · It does not pad. An empty board renders as an empty board — "nothing needs you" is the
 *     most valuable thing this page can say, and it can only say it credibly if it is capable
 *     of saying it at all.
 *
 * Light-only, like the rest of this console.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, AlertOctagon, Info, ArrowRight, CheckCircle2, RefreshCw, Gauge } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type Severity = 'critical' | 'warning' | 'info'

interface Exception {
  key: string
  severity: Severity
  title: string
  detail: string
  count: number
  amountCents: number | null
  amountNote: string
  action: { label: string; href: string } | null
  since: string | null
}

interface Board {
  generatedAt: string
  headline: { wastedSpend30dCents: number | null; wastedTargets: number; note: string }
  exceptions: Exception[]
  totals: { critical: number; warning: number; info: number }
}

const SEV: Record<Severity, { Icon: typeof AlertTriangle; label: string }> = {
  critical: { Icon: AlertOctagon, label: 'Critical' },
  warning: { Icon: AlertTriangle, label: 'Needs attention' },
  info: { Icon: Info, label: 'Worth knowing' },
}

const eur = (cents: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)

/** "3 days" / "6 weeks" — the age of the oldest instance, not a timestamp nobody reads. */
const waiting = (iso: string | null): string | null => {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return null
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'under an hour'
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  const d = Math.floor(h / 24)
  return d < 21 ? `${d} days` : `${Math.floor(d / 7)} weeks`
}

export function TodayTab() {
  const [board, setBoard] = useState<Board | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/today`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`today: ${r.status}`)
      setBoard((await r.json()) as Board)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
      setBoard(null)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  if (loading && !board) return <div className="acr-empty">Loading…</div>
  if (err) return <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>
  if (!board) return <div className="acr-empty">No board returned.</div>

  const { headline, exceptions, totals } = board
  const open = totals.critical + totals.warning

  return (
    <div className="acr-today">
      <div className="acr-today-top">
        {/* The headline is the wasted-spend figure, because it is the only number here that is
            both measurable and directly recoverable. Everything else is exposure or absence. */}
        <div className="acr-today-hero">
          <div className="acr-today-hero-k">Recoverable waste · 30 days</div>
          <div className="acr-today-hero-v">
            {headline.wastedSpend30dCents == null ? '—' : eur(headline.wastedSpend30dCents)}
            {headline.wastedTargets > 0 && (
              <span className="acr-today-hero-sub">across {headline.wastedTargets} targets</span>
            )}
          </div>
          <p className="acr-today-hero-note">{headline.note}</p>
        </div>

        <div className="acr-today-meta">
          <div className="acr-today-counts">
            {totals.critical > 0 && <span className="acr-pill critical">{totals.critical} critical</span>}
            {totals.warning > 0 && <span className="acr-pill warning">{totals.warning} need attention</span>}
            {totals.info > 0 && <span className="acr-pill info">{totals.info} worth knowing</span>}
            {open === 0 && <span className="acr-pill ok"><CheckCircle2 size={12} /> Nothing needs you</span>}
          </div>
          <div className="acr-today-actions">
            {/*
              ACR.1.6 — Mission Control lost its rail entry with the rest of "AI Control", but the
              canvas itself was never superseded: it is the only view of the account's SHAPE.
              It lives here because it is a map, not a control surface, and the rail is kept short
              on purpose. Nothing else links to it, so without this the canvas is unreachable.
            */}
            <Link href="/marketing/ads/autopilot" className="acr-refresh">
              <Gauge size={13} /> Open the map
            </Link>
            <button type="button" className="acr-refresh" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={13} /> {loading ? 'Checking…' : 'Re-check'}
            </button>
          </div>
        </div>
      </div>

      {exceptions.length === 0 ? (
        <div className="acr-today-clear">
          <CheckCircle2 size={20} />
          <div>
            <strong>Nothing needs you right now.</strong>
            <p>
              No wasted spend above the click floor, no proposals waiting, no engine failing, and
              nothing serving that should not be. This board only fills when something is true.
            </p>
          </div>
        </div>
      ) : (
        <ul className="acr-today-list">
          {exceptions.map((e) => {
            const S = SEV[e.severity]
            const age = waiting(e.since)
            return (
              <li key={e.key} className={`acr-exc ${e.severity}`}>
                <div className="acr-exc-bar" aria-hidden />
                <div className="acr-exc-body">
                  <div className="acr-exc-head">
                    <span className={`acr-exc-sev ${e.severity}`}>
                      <S.Icon size={13} /> {S.label}
                    </span>
                    <h3>{e.title}</h3>
                  </div>
                  <p className="acr-exc-detail">{e.detail}</p>
                  {/*
                    When there is no € the note is a CAVEAT — a sentence explaining what could not
                    be measured. Right-aligning a sentence in a 216px column gives three ragged
                    lines, so prose stays on the left where the measure is, and the right column
                    holds only figures. A dash is not used: six rows each opening with an em-dash
                    read as a bulleted list rather than as "no value".
                  */}
                  {e.amountCents == null && <p className="acr-exc-noprice">{e.amountNote}</p>}
                </div>

                {/* Figures only, fixed width, so the € values form a straight edge down the page
                    and can be compared at a glance — the reason the board is priced at all. */}
                <div className="acr-exc-side">
                  {e.amountCents != null && (
                    <>
                      <span className="acr-exc-amount">{eur(e.amountCents)}</span>
                      <span className="acr-exc-amount-note">{e.amountNote}</span>
                    </>
                  )}
                  {age && <span className="acr-exc-age">oldest: {age}</span>}
                  {e.action && (
                    <Link href={e.action.href} className="acr-exc-go">
                      {e.action.label} <ArrowRight size={13} />
                    </Link>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="acr-foot">
        Checked at {new Date(board.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.
        Every row here is a live condition — fix it and it leaves the board on the next check.
        Nothing is listed from memory.
      </p>
    </div>
  )
}
