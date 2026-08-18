'use client'

/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the plan's calendar day-grid.
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: travels with PlanEditor.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BSP.1 — the per-day distribution editor.
 *
 * ── Why a boosted-days list and not 31 inputs ──────────────────────────────────────────────────
 *
 * The stored shape is `[{day, pct}]` for every day, but the *intent* is almost always tentpoles:
 * "weight Black Friday". Thirty-one number fields at 354px is 11px each and asks an operator to do
 * arithmetic the machine can do. So the input is a short list — pick a day, give it a percentage —
 * and every unlisted day shares whatever is left.
 *
 * ── 🔴 …but what is SAVED is all 31 days, and that is not cosmetic ─────────────────────────────
 *
 * `ads-budget-manager.service.ts:140` computes
 *   `expectedPct = sum(pct where day <= dayOfMonth) / 100`
 * over whatever the calendar contains. A calendar holding only the boosted days therefore makes the
 * expected line the sum of those few days: measured in `planMath.vitest.test.ts`, a calendar of
 * days 28-30 says we should have spent **0%** by day 12, so the plan reads "over" from the first
 * euro and never recovers.
 *
 * `materialiseCalendar` is what closes that gap, and the bar strip below renders the MATERIALISED
 * result rather than the input — so what the operator sees is what is stored.
 */

import { useMemo, useState } from 'react'
import { Plus, Trash2, AlertTriangle } from 'lucide-react'
import { calendarTotal, materialiseCalendar, type CalendarDay } from './planMath'

const pctFmt = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}%`

export function CalendarEditor({
  boosted, daysInMonth, capCents, disabled, onChange,
}: {
  boosted: CalendarDay[]
  daysInMonth: number
  capCents: number
  disabled?: boolean
  onChange: (next: CalendarDay[]) => void
}) {
  const [day, setDay] = useState('')
  const [pct, setPct] = useState('')

  // What will actually be written. Rendered, not just computed, so the preview cannot drift.
  const materialised = useMemo(() => materialiseCalendar(boosted, daysInMonth), [boosted, daysInMonth])
  const total = useMemo(() => calendarTotal(boosted), [boosted])
  const restDays = daysInMonth - boosted.length
  const restShare = restDays > 0 ? Math.max(0, 100 - total) / restDays : 0
  const over = total > 100
  const peak = Math.max(...materialised.map((m) => m.pct), 0.0001)

  const add = () => {
    const d = Number(day), p = Number(pct)
    if (!Number.isInteger(d) || d < 1 || d > daysInMonth) return
    if (!Number.isFinite(p) || p < 0) return
    onChange([...boosted.filter((b) => b.day !== d), { day: d, pct: p }].sort((a, b) => a.day - b.day))
    setDay(''); setPct('')
  }

  return (
    <div className="h10-bsp-cal">
      {/* The materialised distribution — every day of the month, including the ones nobody typed. */}
      <div className="h10-bsp-calstrip" role="img"
        aria-label={`Planned distribution across ${daysInMonth} days; ${boosted.length} weighted`}>
        {materialised.map((m) => (
          <span
            key={m.day}
            className={`bar${boosted.some((b) => b.day === m.day) ? ' on' : ''}`}
            style={{ height: `${Math.max(2, (m.pct / peak) * 100)}%` }}
            title={`Day ${m.day} · ${pctFmt(m.pct)} · €${((m.pct / 100) * capCents / 100).toFixed(2)}`}
          />
        ))}
      </div>

      <p className="h10-bsp-calnote">
        {boosted.length === 0
          ? <>Every day carries <b>{pctFmt(100 / daysInMonth)}</b> of the cap. Weight a day to change that.</>
          : <>{boosted.length} weighted {boosted.length === 1 ? 'day' : 'days'}; the other {restDays} share <b>{pctFmt(restShare)}</b> each.</>}
      </p>

      {boosted.length > 0 && (
        <ul className="h10-bsp-callist">
          {boosted.map((b) => (
            <li key={b.day}>
              <span className="d">Day {b.day}</span>
              <span className="p">{pctFmt(b.pct)}</span>
              <span className="e">€{((b.pct / 100) * capCents / 100).toFixed(2)}</span>
              <button type="button" aria-label={`Remove the weighting on day ${b.day}`} disabled={disabled}
                onClick={() => onChange(boosted.filter((x) => x.day !== b.day))}>
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="h10-bsp-caladd">
        <input type="number" min={1} max={daysInMonth} value={day} disabled={disabled}
          onChange={(e) => setDay(e.target.value)} placeholder="Day" aria-label="Day of month" />
        <input type="number" min={0} max={100} step="0.5" value={pct} disabled={disabled}
          onChange={(e) => setPct(e.target.value)} placeholder="%" aria-label="Percentage of the monthly cap" />
        <button type="button" className="h10-bsp-btn sm" onClick={add} disabled={disabled || !day || !pct}>
          <Plus size={12} /> Weight
        </button>
      </div>

      {/* 🔴 The over-100 case is shown, never silently rescaled. The server normalises by its own
          sum rather than rejecting, so the operator would otherwise get a distribution they did not
          ask for and no message saying so. */}
      {over && (
        <p className="h10-bsp-note bad">
          <AlertTriangle size={12} />
          <span>
            <b>The weighted days already total {pctFmt(total)}.</b> Every other day gets 0%, and the
            month is planned to spend {pctFmt(total)} of the cap. Nothing here is rescaled for you.
          </span>
        </p>
      )}
    </div>
  )
}
