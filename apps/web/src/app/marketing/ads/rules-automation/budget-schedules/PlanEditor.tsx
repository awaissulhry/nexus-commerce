'use client'

/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the month-plan editor (?open=plan:).
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: **Budget Manager**.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BSP.1 — the monthly cap editor. This page's first write path.
 *
 * ── What is actually at stake, and why the sentences are long ──────────────────────────────────
 *
 * Saving a cap is local. **Arming Auto Pacing is not.** `ad-budget-enforce` runs every 30 minutes
 * with `NEXUS_BUDGET_ENFORCE_APPLY=1` — its own cron output says `(LIVE)` — and writes real campaign
 * daily budgets to Amazon. `stopOverSpend` floors real bids to €0.02 through
 * `suppressCampaignBids`. An operator typing a number into a box is two clicks from an engine that
 * moves money, so the consequence is stated in a full sentence BEFORE it takes effect. A tooltip is
 * not a sentence.
 *
 * 🔴 Stop Over Spend does NOT pause anything, and must never be allowed to read as if it does.
 * `SUPPRESSION_FLOOR_CENTS = 2` (`ads-bid-suppression.service.ts:23`) — the campaign keeps its
 * place in the account and simply stops winning auctions. This account has a standing no-pause
 * policy; suppression via ~2¢ bids is how that policy is implemented, and a label saying "pause"
 * would describe a different product.
 *
 * ── No optimistic UI ───────────────────────────────────────────────────────────────────────────
 *
 * The input holds what the operator typed. The readout above it holds what the server has
 * confirmed. They are deliberately different things: two engines already disagree about this
 * account's budgets 41% of the time, and a third writer painting an unconfirmed value would make it
 * three. See `usePlanWrites`.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, Trash2 } from 'lucide-react'
import { BurnDownChart } from '@/design-system/components'
import { boostedDays, burnDownSeries, forecastDisclosure, materialiseCalendar, statusBand, type CalendarDay } from './planMath'
import { CalendarEditor } from './CalendarEditor'
import { EnforcementPreview } from './EnforcementPreview'
import type { AdsMode, BudgetManagerResult, BudgetPlanRow, EnforcementResult, WriteOutcome } from './slot-contract'
import { Checkbox, Input } from '@/design-system/primitives'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const eur0 = (c: number) => `€${Math.round(c / 100).toLocaleString('en-IE')}`
const pct1 = (r: number) => `${(r * 100).toFixed(1)}%`

const parseEuros = (s: string): number | null => {
  const t = s.trim().replace(/^€/, '').replace(/\s/g, '').replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

export function PlanEditor({
  marketplace, month, pacing, row, enforcement, enforcementLoading, enforcementError,
  adsMode, outcome, busy, onSavePlan, onDeletePlan, onResetOutcome, onOpenLimits,
}: {
  marketplace: string
  month: string
  pacing: BudgetManagerResult
  /** null when this market has neither plan nor spend in this month. */
  row: BudgetPlanRow | null
  enforcement: EnforcementResult | null
  enforcementLoading: boolean
  enforcementError: string | null
  adsMode: AdsMode | null
  outcome: WriteOutcome
  busy: boolean
  onSavePlan: (patch: { monthlyBudgetCents?: number; autoPacing?: boolean; stopOverSpend?: boolean; calendar?: CalendarDay[] }) => void
  onDeletePlan: (id: string) => void
  onResetOutcome: () => void
  onOpenLimits: () => void
}) {
  const capCents = row?.monthlyBudgetCents ?? 0
  const spendCents = row?.spendCents ?? 0
  const daysInMonth = pacing.daysInMonth
  const dayOfMonth = pacing.dayOfMonth

  // ── draft state. Seeded from the server, re-seeded only when the server value changes, so a
  //    confirmed save updates the field while an in-flight edit is never stamped over.
  const [capDraft, setCapDraft] = useState(() => (capCents ? (capCents / 100).toFixed(2) : ''))
  const [calDraft, setCalDraft] = useState<CalendarDay[]>(() => boostedDays(row?.calendar ?? [], daysInMonth))
  const [showCal, setShowCal] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setCapDraft(capCents ? (capCents / 100).toFixed(2) : '')
    setCalDraft(boostedDays(row?.calendar ?? [], daysInMonth))
  }, [capCents, row?.calendar, daysInMonth, marketplace, month])

  const capParsed = parseEuros(capDraft)
  const capDirty = capParsed != null && capParsed !== capCents
  const calDirty = useMemo(
    () => JSON.stringify(calDraft) !== JSON.stringify(boostedDays(row?.calendar ?? [], daysInMonth)),
    [calDraft, row?.calendar, daysInMonth],
  )
  const dirty = capDirty || calDirty

  const band = statusBand(row?.pct ?? null, row?.expectedPct ?? 0)
  const disclosure = forecastDisclosure({
    spendCents,
    dayOfMonth,
    daysInMonth,
    expectedPct: row?.expectedPct ?? 0,
    hasCalendar: (row?.calendar?.length ?? 0) > 0,
  })

  const series = useMemo(() => burnDownSeries({
    daily: row?.daily ?? [],
    capCents,
    daysInMonth,
    dayOfMonth,
    calendar: row?.calendar ?? [],
    forecastCents: row?.forecastSpendCents ?? null,
  }), [row?.daily, capCents, daysInMonth, dayOfMonth, row?.calendar, row?.forecastSpendCents])

  // The brief's sentence ends "It last ran at 12:00." — there is no deployed endpoint that reports
  // the cron's last tick, and BSP.1 may not add one, so the cadence is stated and the specific time
  // is not invented.
  const armSentence = (what: 'pacing' | 'stop') => what === 'pacing'
    ? `Saving this arms auto-pacing for ${marketplace}. The pacing engine runs every 30 minutes and will change campaign daily budgets on Amazon when the month is projected over its cap.`
    : `At the cap, bids drop to about €0.02. Campaigns keep their place; they stop winning. Nothing is paused.`

  const save = (patch: Parameters<typeof onSavePlan>[0]) => { onResetOutcome(); onSavePlan(patch) }

  const saveEdits = () => save({
    ...(capDirty && capParsed != null ? { monthlyBudgetCents: capParsed } : {}),
    // 🔴 All 31 days, always — a partial calendar makes the server's expectedPct read 0%.
    ...(calDirty ? { calendar: calDraft.length ? materialiseCalendar(calDraft, daysInMonth) : [] } : {}),
  })

  return (
    <div className="h10-bsp-plan">
      {/* ── confirmed state, never a draft ────────────────────────────────────────────────── */}
      <dl className="h10-bsp-railfacts">
        <div><dt>Monthly cap</dt><dd>{capCents > 0 ? eur(capCents) : 'none set'}</dd></div>
        <div><dt>Spent so far</dt><dd>{eur(spendCents)}{row?.pct != null && <i> · {pct1(row.pct)}</i>}</dd></div>
        <div><dt>Planned by today</dt><dd>{pct1(row?.expectedPct ?? 0)}</dd></div>
        <div>
          <dt>Projected finish</dt>
          <dd className={row?.projectedOverspend ? 'bad' : ''}>
            {row?.forecastSpendCents != null ? eur(row.forecastSpendCents) : '—'}
          </dd>
        </div>
      </dl>

      {/* 🔴 The ±10-point dead band, stated. `:145-146` classifies over/under only past ±0.1, so a
          plan can read "on-track" while sitting 8 points — €320 of a €4,000 cap — over pace. */}
      {band && capCents > 0 && (
        <p className="h10-bsp-bandnote">
          <b>{row?.status === 'on-track' ? 'On track' : row?.status === 'over' ? 'Over pace' : 'Under pace'}</b>
          {' — '}
          {band.deltaPct >= 0 ? 'ahead of' : 'behind'} plan by {pct1(Math.abs(band.deltaPct))}.
          {band.insideBand && ' Anything within 10 points either way still counts as on track.'}
        </p>
      )}

      {/* ── the burn-down ─────────────────────────────────────────────────────────────────── */}
      {capCents > 0 && (
        <div className="h10-bsp-burn">
          <BurnDownChart
            data={series}
            capValue={capCents}
            capLabel={`cap ${eur0(capCents)}`}
            todayDay={dayOfMonth}
            format={(v) => eur0(v)}
            height={150}
          />
          {/* 🔴 Disclosure 1 — the forecast's sample size. On day 4 the same formula multiplies a
              four-day sample by 7.75, which is what produced 2,387 budget writes in six days. */}
          <p className="h10-bsp-burnnote">
            Projected from <b>{disclosure.basisDays} {disclosure.basisDays === 1 ? 'day' : 'days'}</b> of
            spend, extended straight to month end.
            {disclosure.basisDays <= 7 && <> That is a thin sample; the number moves a lot early in the month.</>}
          </p>
          {/* 🔴 Disclosure 2 — the two models disagree by construction on a calendar plan. */}
          {disclosure.diverges && (
            <p className="h10-bsp-note">
              <AlertTriangle size={12} />
              <span>
                <b>The projection ignores your calendar.</b> The planned-pace line is
                calendar-weighted, but the projection above is a straight line, so on a weighted month
                they disagree: {eur(disclosure.linearCents as number)} straight-line
                vs {eur(disclosure.calendarCents as number)} following your calendar. Both are shown
                as the server computes them.
              </span>
            </p>
          )}
        </div>
      )}

      {/* ── the cap ───────────────────────────────────────────────────────────────────────── */}
      <label className="h10-bsp-field2">
        <span className="cap">Monthly cap</span>
        <Input
          fieldClassName="h10-bsp-in"
          value={capDraft}
          disabled={busy}
          inputMode="decimal"
          placeholder="0.00"
          aria-label={`Monthly cap for ${marketplace}`}
          onChange={(e) => { setCapDraft(e.target.value); onResetOutcome() }}
        />
      </label>
      {capDraft.trim() !== '' && capParsed == null && (
        <p className="h10-bsp-note bad"><span><b>That is not an amount.</b> Enter a number of euros, e.g. 2220.00.</span></p>
      )}

      {/* ── the calendar ──────────────────────────────────────────────────────────────────── */}
      <button type="button" className="h10-bsp-disc" aria-expanded={showCal} onClick={() => setShowCal((v) => !v)}>
        {showCal ? '▾' : '▸'} Custom distribution
        <i>{calDraft.length ? `${calDraft.length} weighted` : 'even split'}</i>
      </button>
      {showCal && (
        <CalendarEditor
          boosted={calDraft}
          daysInMonth={daysInMonth}
          capCents={capParsed ?? capCents}
          disabled={busy}
          onChange={(next) => { setCalDraft(next); onResetOutcome() }}
        />
      )}

      {dirty && (
        <div className="h10-bsp-saverow">
          <button type="button" className="h10-bsp-btn primary" disabled={busy || (capDraft.trim() !== '' && capParsed == null)} onClick={saveEdits}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="h10-bsp-btn" disabled={busy} onClick={() => {
            setCapDraft(capCents ? (capCents / 100).toFixed(2) : '')
            setCalDraft(boostedDays(row?.calendar ?? [], daysInMonth))
            onResetOutcome()
          }}>Discard</button>
        </div>
      )}

      {/* ── the two live switches ─────────────────────────────────────────────────────────── */}
      <div className="h10-bsp-arm">
        <Checkbox
          className="h10-bsp-tog" label="Auto Pacing"
          checked={!!row?.autoPacing} disabled={busy}
          onChange={(e) => save({ autoPacing: e.target.checked })}
        />
        <p className="h10-bsp-armnote">{armSentence('pacing')}</p>

        <Checkbox
          className="h10-bsp-tog" label="Stop Over Spend"
          checked={!!row?.stopOverSpend} disabled={busy}
          onChange={(e) => save({ stopOverSpend: e.target.checked })}
        />
        {/* 🔴 Never the word "pause". */}
        <p className="h10-bsp-armnote">{armSentence('stop')}</p>

        {adsMode && (
          <p className="h10-bsp-mode">
            Ads write mode <b>{adsMode.mode}</b>
            {adsMode.mode === 'live'
              ? <> — {adsMode.liveWriteCount} campaign{adsMode.liveWriteCount === 1 ? '' : 's'} allow live writes to Amazon.</>
              : <> — changes stay local and never reach Amazon.</>}
          </p>
        )}
      </div>

      {/* ── the outcome. Refused is not broke. ────────────────────────────────────────────── */}
      {outcome.state === 'saved' && <p className="h10-bsp-note ok"><span>Saved.</span></p>}
      {outcome.state === 'refused' && (
        <p className="h10-bsp-note warn">
          <AlertTriangle size={12} />
          <span><b>That was refused, not lost.</b> {outcome.message} Your entry is still here.</span>
        </p>
      )}
      {outcome.state === 'broke' && (
        <p className="h10-bsp-note bad">
          <AlertTriangle size={12} />
          <span><b>The save failed.</b> {outcome.message} Your entry is still here.</span>
        </p>
      )}

      {/* ── what pacing would do ──────────────────────────────────────────────────────────── */}
      <div className="h10-bsp-sub">
        <b>What pacing would do now</b>
        <EnforcementPreview
          data={enforcement}
          loading={enforcementLoading}
          error={enforcementError}
          marketplace={marketplace}
          autoPacing={!!row?.autoPacing}
          stopOverSpend={!!row?.stopOverSpend}
          capCents={capCents}
          forecastCents={row?.forecastSpendCents ?? null}
        />
      </div>

      <button type="button" className="h10-bsp-disc" onClick={onOpenLimits}>
        ▸ Per-campaign limits
        <i>{row?.campaignLimitCount ? `${row.campaignLimitCount} set` : 'none set'}</i>
      </button>

      {/* ── delete. Absent when there is nothing to delete. ───────────────────────────────── */}
      {row?.id && (
        confirmDelete ? (
          <div className="h10-bsp-saverow">
            <button type="button" className="h10-bsp-btn danger" disabled={busy}
              onClick={() => { setConfirmDelete(false); onDeletePlan(row.id as string) }}>
              Delete the {marketplace} plan
            </button>
            <button type="button" className="h10-bsp-btn" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep it</button>
          </div>
        ) : (
          <button type="button" className="h10-bsp-del" disabled={busy} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={12} /> Delete this plan
          </button>
        )
      )}

      {/* Budget Manager keeps the cap editor until BSP.1b retires it; the link stays until then. */}
      <a className="h10-bsp-raillink" href="/marketing/ads/budget-manager">
        Budget Manager <ExternalLink size={12} />
      </a>
    </div>
  )
}
