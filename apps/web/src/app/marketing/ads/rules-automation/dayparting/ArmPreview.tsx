'use client'

/**
 * E1 + E3 — what happens if you arm this.
 *
 * "Automate" commits to an engine that writes to Amazon every 15 minutes, and until now the only
 * number in front of the operator was how many campaigns they had picked. These two answers sit
 * where that decision is made:
 *
 *   E1  NEXT 24 HOURS — the rank this plan resolves to, hour by hour, starting now. A plan reads as
 *       a grid of windows; what it DOES is a sequence. Seeing "Rest of Search until 18:00, then Own
 *       Top until 23:00" is what catches an off-by-one window before it runs, not after.
 *   E3  BLAST RADIUS — the campaigns, ad groups and targets the writes land on, and how many of
 *       those campaigns are gated shut.
 *
 * The 24-hour resolution is computed from the builder's own `rank-grid-model`, the same pure module
 * that paints the grid — so the preview cannot disagree with the plan it previews. No endpoint, no
 * second implementation of "which target governs this hour".
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { gridFromWindows, type RankWin } from '../_rank/rank-grid-model'
import { getBackendUrl } from '@/lib/backend-url'

export interface RankTargetLite {
  key: string; name: string; color: string | null
  /** The bias the loop HOLDS (Placement %). Without it the ceiling below cannot be stated: for a
   *  non-all-out target with no maxBiasPct the ceiling IS the floor, not 900%. */
  biasPct?: number | null
  maxBiasPct: number | null; maxCpcCents: number | null; acosCapPct: number | null; allOut: boolean
  pause?: boolean
}

/**
 * Mirror of `biasBand` in apps/api/src/services/advertising/rank-controller.ts — the [floor,
 * ceiling] the engine derives before it moves anything. Duplicated deliberately and minimally:
 * this panel must also describe an UNSAVED plan being edited, which no server endpoint can read.
 * Keep the two in step; rank-controller is the source of truth.
 */
function band(t: RankTargetLite): { floor: number; ceiling: number } {
  const floor = Math.max(0, Math.min(900, Math.round(t.biasPct ?? 0)))
  const ceiling = t.allOut ? (t.maxBiasPct ?? 900) : (t.maxBiasPct ?? floor)
  return { floor, ceiling: Math.max(floor, ceiling) }
}
interface Fit {
  hasData: boolean; weeks: number; campaigns: number
  windowHours: number; totalHours: number
  /** RDX/E2 — how much evidence is behind `share`. Absent on an older API build. */
  coverage?: { daysWithData: number; daysInWindow: number; sufficientForShare: boolean }
  inWindow: { hours: number; costCents: number; salesCents: number; orders: number; clicks: number; impressions: number }
  outWindow: { hours: number; costCents: number; salesCents: number; orders: number; clicks: number; impressions: number }
  share: { spend: number; sales: number; orders: number; impressions: number }
  missed: Array<{ dow: number; hour: number; salesCents: number; costCents: number; orders: number }>
}
interface Blast {
  campaigns: number; adGroups: number; targets: number; markets: string[]
  writeOpen: number; writeGated: number; gatedNames: string[]; archived: number
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

/**
 * The next 24 hourly slots as [hour, targetKey] pairs, walking the compiled grid forward from the
 * current local hour and wrapping across midnight into the next weekday.
 */
function nextDay(grid: string[][], baselineKey: string, now: Date): Array<{ hour: number; dow: number; key: string }> {
  const out: Array<{ hour: number; dow: number; key: string }> = []
  let dow = now.getDay()
  let hour = now.getHours()
  for (let i = 0; i < 24; i++) {
    out.push({ hour, dow, key: grid[dow]?.[hour] || baselineKey })
    hour++
    if (hour === 24) { hour = 0; dow = (dow + 1) % 7 }
  }
  return out
}

/** Collapse the 24 slots into runs, because "18:00–23:00 Own Top" is the readable unit. */
function runs(slots: Array<{ hour: number; key: string }>): Array<{ from: number; to: number; key: string; hours: number }> {
  const out: Array<{ from: number; to: number; key: string; hours: number }> = []
  for (const s of slots) {
    const last = out[out.length - 1]
    if (last && last.key === s.key) { last.to = (s.hour + 1) % 24; last.hours++ }
    else out.push({ from: s.hour, to: (s.hour + 1) % 24, key: s.key, hours: 1 })
  }
  return out
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const eur = (c: number) => `€${(c / 100).toFixed(0)}`

export function ArmPreview({ groupId, campaignIds, windows, baselineKey, targets, showSchedule = true }: {
  /** Present only when editing a saved schedule — window fit needs real history to measure against. */
  groupId?: string
  campaignIds: string[]
  windows: unknown[]
  baselineKey: string
  targets: RankTargetLite[]
  /** The 24-hour preview needs a SAVED plan to read. On a schedule being created for the first
   *  time the plan lives only in the editor, so only the blast radius is shown. */
  showSchedule?: boolean
}) {
  const [blast, setBlast] = useState<Blast | null>(null)
  const [fit, setFit] = useState<Fit | null>(null)

  useEffect(() => {
    if (!groupId) { setFit(null); return }
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/window-fit?weeks=8`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setFit(j?.hasData ? j : null) })
      .catch(() => { if (alive) setFit(null) })
    return () => { alive = false }
  }, [groupId])

  // Keyed on the JOINED ids, not the array: the parent rebuilds `campaignIds` on every render, so
  // depending on the array itself would refetch forever.
  const campKey = useMemo(() => [...campaignIds].sort().join(','), [campaignIds])
  useEffect(() => {
    if (!campKey) { setBlast(null); return }
    let alive = true
    const qs = new URLSearchParams({ campaignIds: campKey })
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/blast-radius?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setBlast(typeof j?.campaigns === 'number' ? j : null) })
      .catch(() => { if (alive) setBlast(null) })
    return () => { alive = false }
  }, [campKey])

  const meta = useMemo(() => new Map(targets.map((t) => [t.key, t])), [targets])
  const schedule = useMemo(() => {
    const grid = gridFromWindows(windows as RankWin[])
    return runs(nextDay(grid, baselineKey, new Date()))
  }, [windows, baselineKey])

  // The ceiling each distinct target in the next day can reach. The compounding trap AdLabs warns
  // about is invisible unless the bound is stated next to the plan that reaches for it.
  const ceilings = useMemo(() => {
    const keys = [...new Set(schedule.map((r) => r.key).filter(Boolean))]
    return keys.map((k) => meta.get(k)).filter(Boolean) as RankTargetLite[]
  }, [schedule, meta])

  if (!campKey) return null

  const nameOf = (k: string) => (k ? meta.get(k)?.name ?? k : 'Nothing held')
  const colorOf = (k: string) => (k ? meta.get(k)?.color ?? '#99a1ac' : '#d8dde4')

  return (
    <div className="h10-arm">
      {/* E1 */}
      {showSchedule && <div className="h10-arm-sec">
        <div className="h10-arm-hd">Next 24 hours</div>
        <div className="h10-arm-runs">
          {schedule.map((r, i) => (
            <span className="run" key={i} title={`${hh(r.from)}–${hh(r.to)} · ${nameOf(r.key)}`}>
              <span className="sw" style={{ background: colorOf(r.key) }} />
              <span className="tm">{hh(r.from)}–{hh(r.to)}</span>
              <span className="nm">{nameOf(r.key)}</span>
            </span>
          ))}
        </div>
        {ceilings.length > 0 && (
          <div className="h10-arm-ceil">
            {ceilings.map((t) => (
              <span key={t.key} className="c">
                <b>{t.name}</b>
                {/*
                  Every clause here was wrong before RDX/E2 measured it against the engine:
                   · "up to {maxBiasPct ?? 900}% bias" told the operator EVERY target could reach
                     900%. For a non-all-out target with no maxBiasPct the ceiling is the FLOOR —
                     it holds at its Placement %, it does not climb. Most targets read 900% here.
                   · "holds at any cost up to the CPC ceiling" implied a ceiling exists. On
                     `own-top-allout` maxCpcCents is null, so there is none — the one case where
                     the sentence most needed to warn, it reassured instead.
                   · A Min-bid target was described as "up to 900% bias · no ACoS cap" when it in
                     fact floors bids to ~2¢ and never reaches the placement stage at all.
                */}
                {t.pause ? (
                  <em>holds bids at the ~2¢ floor — delivery continues, prior bids restored after</em>
                ) : t.allOut ? (
                  <em>
                    {band(t).floor}% → up to {band(t).ceiling}% bias · ignores the ACoS cap
                    {t.maxCpcCents != null
                      ? ` · max CPC €${(t.maxCpcCents / 100).toFixed(2)}`
                      : ' · NO CPC ceiling — nothing bounds the bid but Amazon’s 900% cap'}
                  </em>
                ) : (
                  <em>
                    {band(t).ceiling > band(t).floor
                      ? `${band(t).floor}% → up to ${band(t).ceiling}% bias`
                      : `holds ${band(t).floor}% bias`}
                    {t.acosCapPct != null ? ` · ACoS cap ${t.acosCapPct}%` : ' · no ACoS cap'}
                    {t.maxCpcCents != null ? ` · max CPC €${(t.maxCpcCents / 100).toFixed(2)}` : ''}
                  </em>
                )}
              </span>
            ))}
          </div>
        )}
      </div>}

      {/* E2 — measured, not simulated. */}
      {fit && (() => {
        /**
         * RDX/E2 — do not state a share the data cannot support.
         *
         * This rendered "0% of sales happened in the 130 of 168 hours this plan pushes in" for a
         * 10-campaign schedule whose entire 8-week window held TWO impressions on ONE day. Every
         * number was accurate and the sentence was misleading: at the moment of arming it reads as
         * a verdict on the plan, when it is really the absence of evidence. Marketing Stream is
         * per-campaign and never backfilled, so a schedule's own coverage is routinely a small
         * fraction of the account's — the account heatmap looking healthy says nothing about it.
         *
         * Two separate gates, because they fail differently:
         *   · under a week of data → weekday samples are unequal, so the ratio is an artefact
         *   · a full week but zero sales → the denominator is zero; "0%" would be read as "the
         *     wrong hours" rather than "nothing sold at all"
         */
        const cov = fit.coverage
        const enoughDays = cov ? cov.sufficientForShare : true
        const anySales = fit.inWindow.salesCents + fit.outWindow.salesCents > 0
        const canStateShare = enoughDays && anySales
        return (
        <div className="h10-arm-sec">
          <div className="h10-arm-hd">Window fit · last {fit.weeks} weeks</div>
          {canStateShare ? (
            <div className="h10-arm-fit">
              <span className="big">{fit.share.sales}%</span>
              <span className="txt">
                of sales happened in the <b>{fit.windowHours}</b> of 168 hours this plan pushes in
                {' '}({fit.share.spend}% of spend, {fit.share.orders}% of orders).
              </span>
            </div>
          ) : (
            <div className="h10-arm-fit thin">
              <span className="txt">
                {!enoughDays ? (
                  <>
                    <b>Not enough hourly data to judge this plan’s hours yet.</b> These campaigns have{' '}
                    {cov?.daysWithData ?? 0} day{(cov?.daysWithData ?? 0) === 1 ? '' : 's'} of Marketing Stream
                    data in the last {fit.weeks} weeks — under a full week, some weekdays are sampled and others
                    are not, so any share would be an artefact of which days happened to be captured.
                  </>
                ) : (
                  <>
                    <b>No sales recorded for these campaigns in the last {fit.weeks} weeks</b>, so there is no
                    split to report. The plan still pushes in <b>{fit.windowHours}</b> of 168 hours.
                  </>
                )}{' '}
                Marketing Stream fills forward and is never backfilled, so this fills in as the schedule runs.
              </span>
            </div>
          )}
          {/* The actionable half: demand the plan currently leaves on its baseline. Suppressed
              alongside the share — it is drawn from the same sample, so "your best hours" off one
              captured day would be noise presented as a recommendation. */}
          {canStateShare && fit.missed.length > 0 && (
            <div className="h10-arm-missed">
              <span className="lbl">Best hours you are not pushing in</span>
              {fit.missed.map((m) => (
                <span className="m" key={`${m.dow}-${m.hour}`} title={`${m.orders} order${m.orders === 1 ? '' : 's'}, ${eur(m.costCents)} spend`}>
                  {DOW_SHORT[m.dow]} {hh(m.hour)} · <b>{eur(m.salesCents)}</b>
                </span>
              ))}
            </div>
          )}
          {/* The note only earns its confidence when a share was actually stated. */}
          {canStateShare && (
            <div className="h10-arm-note">
              Measured against real Marketing Stream demand — not a prediction. What a different bid
              would have won is unknowable; whether these are the hours that sell is not.
            </div>
          )}
        </div>
        )
      })()}

      {/* E3 */}
      {blast && (
        <div className="h10-arm-sec">
          <div className="h10-arm-hd">What this touches</div>
          <div className="h10-arm-blast">
            <span><b>{blast.campaigns}</b> campaign{blast.campaigns === 1 ? '' : 's'}</span>
            <span><b>{blast.adGroups}</b> ad group{blast.adGroups === 1 ? '' : 's'}</span>
            <span><b>{blast.targets}</b> target{blast.targets === 1 ? '' : 's'}</span>
            {blast.markets.length > 0 && <span><b>{blast.markets.join(', ')}</b></span>}
          </div>
          {/* The one that changes the decision: a gated campaign records the change locally and
              pushes nothing, which looks identical to success everywhere else in the product. */}
          {blast.writeGated > 0 ? (
            <div className="h10-arm-warn" role="note">
              <AlertTriangle size={14} />
              <span>
                <b>{blast.writeGated} of {blast.campaigns} campaigns cannot write to Amazon.</b>{' '}
                Live bid writes are switched off for {blast.gatedNames.slice(0, 3).join(', ')}
                {blast.gatedNames.length > 3 ? ` +${blast.gatedNames.length - 3} more` : ''} — the plan
                will be recorded and held locally, and nothing will reach Amazon for {blast.writeGated === 1 ? 'it' : 'them'}.
              </span>
            </div>
          ) : (
            <div className="h10-arm-ok"><ShieldCheck size={14} /> All {blast.campaigns} campaigns can write to Amazon.</div>
          )}
          {blast.archived > 0 && (
            <div className="h10-arm-warn" role="note">
              <AlertTriangle size={14} />
              <span><b>{blast.archived} archived campaign{blast.archived === 1 ? '' : 's'}</b> in this selection — the engine will skip {blast.archived === 1 ? 'it' : 'them'}.</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
