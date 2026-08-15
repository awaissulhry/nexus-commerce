'use client'

/**
 * BSP.2 · binding — the `campaign:` rail: this campaign's day-by-day, and who moved its budget.
 *
 * ── Where the history comes from, and why not from my own endpoint ─────────────────────────────
 *
 * Substrate spec §4 gives the change ledger to **10 · Automations** for the account-wide view, and
 * every other page gets *the same route, filtered*: `GET /advertising/action-log`. One query shape,
 * eleven filters. So this rail does not run a second ledger query — a second one would drift from
 * the first the moment either is fixed.
 *
 * 🔴 That route advertised a `campaignId` filter it never applied — it destructured the param and
 * left it out of the `where`, so `?campaignId=X` returned every campaign's rows. BSP.2 fixed it in
 * the route rather than filtering client-side, because the next page to use it would have hit the
 * same wall. If this rail ever shows another campaign's writes, that fix has been reverted.
 *
 * ── PENDING is in-flight, not failed ───────────────────────────────────────────────────────────
 *
 * 488 of the 2,387 budget writes are `PENDING` at Amazon. §5.8 of the substrate spec: an in-flight
 * write shows the INTENDED value beside the current one, never instead of it. A row that renders
 * PENDING as an error would describe a working queue as a broken one.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { BindingCampaignRow } from './slot-contract'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`)
const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

/** The audit payload is EUROS — the same trap the service documents. Converted once, here. */
const payloadEur = (p: unknown): number | null => {
  const v = (p as Record<string, unknown> | null)?.dailyBudget
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface LogRow {
  id: string
  createdAt: string
  userId: string | null
  payloadBefore: unknown
  payloadAfter: unknown
  amazonResponseStatus: string | null
}

/** `automation:budget-manager-cron` is the pacer; the two hashes are budget rules. */
const actorLabel = (userId: string | null): string => {
  if (!userId) return 'unattributed'
  if (userId.startsWith('automation:budget-manager-cron')) return 'the pacer'
  if (userId.startsWith('automation:')) return 'a rule'
  if (userId.startsWith('user:')) return userId.slice(5)
  return userId
}

export function CampaignBindingRail({ row, loading }: { row: BindingCampaignRow | null; loading: boolean }) {
  const [log, setLog] = useState<LogRow[] | null>(null)
  const [logErr, setLogErr] = useState<string | null>(null)

  const id = row?.id ?? null
  useEffect(() => {
    if (!id) return
    let alive = true
    setLog(null); setLogErr(null)
    const qs = new URLSearchParams({
      entityType: 'CAMPAIGN', actionType: 'AD_BUDGET_UPDATE', campaignId: id, days: '60', take: '25',
    })
    void fetch(`${getBackendUrl()}/api/advertising/action-log?${qs}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`The change ledger failed (${r.status}).`)
        return r.json()
      })
      .then((d) => { if (alive) setLog((Array.isArray(d?.rows) ? d.rows : []) as LogRow[]) })
      .catch((e) => { if (alive) setLogErr((e as Error).message) })
    return () => { alive = false }
  }, [id])

  if (loading && !row) return <p className="h10-bsp-encalm">Loading this campaign…</p>
  if (!row) {
    return (
      <p className="h10-bsp-encalm">
        <b>This campaign is not in the current view.</b> It either spent nothing in the window, or the
        scope above excludes it. Clear the scope to see it.
      </p>
    )
  }

  return (
    <div className="h10-bsp-plan">
      <dl className="h10-bsp-railfacts">
        <div><dt>Budget now</dt><dd>{eur(row.currentBudgetCents)}</dd></div>
        <div><dt>Spent in window</dt><dd>{eur(row.spendCents)}</dd></div>
        <div><dt>Days binding</dt><dd>{row.daysBinding} of {row.daysWithSpend}</dd></div>
        <div><dt>Highest day</dt><dd className={row.maxRatio >= 1 ? 'bad' : ''}>{pct(row.maxRatio)}</dd></div>
      </dl>

      {row.approximate && (
        <p className="h10-bsp-note warn">
          <AlertTriangle size={12} />
          <span>
            <b>These ratios are approximate.</b> This campaign has no budget write in the audit log,
            so every day is measured against today&rsquo;s budget of {eur(row.currentBudgetCents)}. If
            it changed during the window, these numbers are wrong by however much it changed.
          </span>
        </p>
      )}

      {/* ── the day-by-day: spend · budget in force · ratio ──────────────────────────────────── */}
      <div className="h10-bsp-sub">
        <b>Day by day</b>
        <ul className="h10-bsp-days">
          {row.days.map((d) => (
            <li key={d.date} className={d.ratio != null && d.ratio >= 1 ? 'on' : ''}>
              <span className="d">{dayLabel(d.date)}</span>
              <span className="v">{eur(d.spendCents)}</span>
              <span className="b">of {d.budgetCents != null ? eur(d.budgetCents) : '—'}</span>
              <span className="r">{pct(d.ratio)}</span>
            </li>
          ))}
        </ul>
        {/* Over 100% is normal; saying so here stops the red reading as an error. */}
        {row.maxRatio >= 1 && (
          <p className="h10-bsp-burnnote">
            A day over 100% is normal — Amazon treats the daily budget as a rate it may overshoot and
            settles the average across the month.
          </p>
        )}
      </div>

      {/* ── who moved it ─────────────────────────────────────────────────────────────────────── */}
      <div className="h10-bsp-sub">
        <b>Recent budget writes</b>
        {logErr && <p className="h10-bsp-note bad"><span>{logErr}</span></p>}
        {!logErr && log == null && <p className="h10-bsp-encalm">Reading the change ledger…</p>}
        {!logErr && log?.length === 0 && (
          <p className="h10-bsp-encalm">
            <b>No budget write in 60 days.</b> Nothing has moved this campaign&rsquo;s budget — its
            ratios are measured against a value that has stood the whole window.
          </p>
        )}
        {!!log?.length && (
          <ul className="h10-bsp-writes">
            {log.map((w) => {
              const from = payloadEur(w.payloadBefore)
              const to = payloadEur(w.payloadAfter)
              const pending = w.amazonResponseStatus === 'PENDING'
              return (
                <li key={w.id}>
                  <span className="t">{stamp(w.createdAt)}</span>
                  <span className="a">{actorLabel(w.userId)}</span>
                  <span className="v">
                    {from != null ? `€${from.toFixed(2)}` : '—'} → <b>{to != null ? `€${to.toFixed(2)}` : '—'}</b>
                  </span>
                  {/* In-flight, NOT failed. */}
                  {pending && <span className="p" title="Sent to Amazon and not yet acknowledged. The value above is the intended one.">in flight</span>}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* The only way out of this rail, and it leaves the page: 4 shows the consequence, 6 owns
          the cause (substrate §4 · D9). Nothing here edits a budget. */}
      <a className="h10-bsp-raillink" href="/marketing/ads/rules-automation/budget">
        What may change this budget <ExternalLink size={12} />
      </a>
    </div>
  )
}
