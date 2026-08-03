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
  maxBiasPct: number | null; maxCpcCents: number | null; acosCapPct: number | null; allOut: boolean
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

export function ArmPreview({ campaignIds, windows, baselineKey, targets, showSchedule = true }: {
  campaignIds: string[]
  windows: unknown[]
  baselineKey: string
  targets: RankTargetLite[]
  /** The 24-hour preview needs a SAVED plan to read. On a schedule being created for the first
   *  time the plan lives only in the editor, so only the blast radius is shown. */
  showSchedule?: boolean
}) {
  const [blast, setBlast] = useState<Blast | null>(null)

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
                {t.allOut
                  ? <em>ignores the ACoS cap — holds at any cost up to the CPC ceiling</em>
                  : (
                    <em>
                      up to {t.maxBiasPct ?? 900}% bias
                      {t.acosCapPct != null ? ` · ACoS cap ${t.acosCapPct}%` : ' · no ACoS cap'}
                      {t.maxCpcCents != null ? ` · max CPC €${(t.maxCpcCents / 100).toFixed(2)}` : ''}
                    </em>
                  )}
              </span>
            ))}
          </div>
        )}
      </div>}

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
