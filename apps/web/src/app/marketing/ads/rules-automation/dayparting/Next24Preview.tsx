'use client'

/**
 * RDX/E1 — the next 24 hours of a schedule, hour by hour, before it is armed.
 *
 * The forward-looking counterpart to the drawer's two history tabs. Those answer "what did this
 * do"; this answers "what is it about to do", which is the question that matters at the moment
 * someone clicks Automate.
 *
 * What it adds over the painted grid: the grid shows which hours are COVERED. It does not show
 * what each hour's target does to a bid, and it does not show where that bid may climb to. Two
 * schedules that look identical on the grid can differ ninefold in what they permit. So each row
 * carries the governing target, the bias the loop holds, and the ceiling it may reach.
 *
 * Every number comes from GET /rank-schedule-groups/:id/next-24h, which derives them from the same
 * two functions the live loop uses (resolveActiveWindow, biasBand). Nothing is recomputed here —
 * a preview that paraphrased the engine would be free to drift from it.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, TrendingUp, CalendarClock } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Row {
  at: string
  dow: number
  hour: number
  targetKey: string | null
  targetName: string | null
  color: string | null
  source: 'window' | 'baseline' | 'none'
  eventName: string | null
  floorPct: number | null
  ceilingPct: number | null
  canChase: boolean
  /** MB.6 — set when the CPC ceiling, not the target's own Ceiling, is what stops the climb */
  cpcCapPct?: number | null
  maxCpcCents: number | null
  acosCapPct: number | null
  allOut: boolean
  suppressed: boolean
  unbounded: boolean
  missingTarget: boolean
}

interface Payload {
  name: string
  timezone: string
  enabled: boolean
  members: { total: number; enabled: number }
  hours: Row[]
  summary: {
    targets: Array<{ key: string; name: string; color: string | null; hours: number }>
    changes: number
    hoursCovered: number
    hoursUncovered: number
    hoursSuppressed: number
    hoursUnbounded: number
    maxCeilingPct: number | null
    missingTargetKeys: string[]
    events: Array<{ name: string; hours: number }>
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`

export function Next24Preview({ groupId }: { groupId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true); setFailed(false)
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/next-24h`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (!alive) return; if (j?.hours) setData(j as Payload); else setFailed(true) })
      .catch(() => { if (alive) setFailed(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [groupId])

  if (loading) return <div className="h10-hist-msg">Loading the next 24 hours…</div>
  if (failed || !data) return <div className="h10-hist-msg">Could not read the schedule’s next 24 hours.</div>

  const s = data.summary

  return (
    <div className="h10-n24">
      <div className="h10-n24-sum">
        {/* Stated before the table, because these three are the decisions — the rows are evidence. */}
        <p className="hdr">
          <b>{s.hoursCovered}</b> of 24 hours governed · <b>{s.changes}</b> bid change{s.changes === 1 ? '' : 's'} ·{' '}
          {data.members.enabled} of {data.members.total} campaign{data.members.total === 1 ? '' : 's'} live
          <span className="tz"> · {data.timezone}</span>
        </p>

        {/* A disabled schedule resolves targets identically but writes nothing. Without saying so,
            this table reads as a prediction when it is really a rehearsal. */}
        {!data.enabled && (
          <p className="note off">
            <span>This schedule is <b>off</b> — these hours are what it <i>would</i> do. Nothing below will be written to Amazon until it is turned on.</span>
          </p>
        )}

        {/* RDX/G2 — a dated event replaces the weekly plan while it runs. Stated first: every
            row below is being resolved against a different plan than the one on the grid, and
            without saying so the table looks like the weekly schedule misbehaving. */}
        {s.events.map((e) => (
          <p className="note evt" key={e.name}>
            <CalendarClock size={13} />
            <span>
              The event <b>{e.name}</b> governs {e.hours} of the next 24 hours — its plan replaces the
              weekly one for those hours, and the schedule reverts on its own when the event ends.
            </span>
          </p>
        ))}

        {s.hoursUncovered > 0 && (
          <p className="note warn">
            <AlertTriangle size={13} />
            <span><b>{s.hoursUncovered} hour{s.hoursUncovered === 1 ? '' : 's'}</b> have no target — the engine leaves bids exactly as it finds them there. Set a baseline to govern the rest of the week.</span>
          </p>
        )}

        {s.missingTargetKeys.length > 0 && (
          <p className="note bad">
            <AlertTriangle size={13} />
            <span>The plan names {s.missingTargetKeys.length} target{s.missingTargetKeys.length === 1 ? '' : 's'} that no longer exist ({s.missingTargetKeys.join(', ')}). Those hours cannot resolve and will be skipped.</span>
          </p>
        )}

        {/* THE compounding trap, stated as a count rather than left for someone to infer from a
            table: all-out ignores the ACOS ceiling by design, so with no maxCPC the only thing
            bounding the bid is Amazon's own 900% cap. */}
        {s.hoursUnbounded > 0 && (
          <p className="note bad">
            <AlertTriangle size={13} />
            <span>
              <b>{s.hoursUnbounded} all-out hour{s.hoursUnbounded === 1 ? '' : 's'} with no CPC ceiling.</b> All-out ignores the ACOS cap by design,
              so nothing bounds the bid in {s.hoursUnbounded === 1 ? 'that hour' : 'those hours'} but Amazon’s 900% limit. Set a max CPC on the target.
            </span>
          </p>
        )}

        {s.hoursSuppressed > 0 && (
          <p className="note">
            {/* Named suppression, not "paused": the engine floors bids and keeps the campaign
                ENABLED, because a real pause disrupts Amazon's algorithm. */}
            <span><b>{s.hoursSuppressed} hour{s.hoursSuppressed === 1 ? '' : 's'}</b> hold bids at the ~2¢ floor. Delivery is not paused and the prior bids are restored afterwards.</span>
          </p>
        )}

        {s.targets.length > 0 && (
          <div className="h10-n24-legend">
            {s.targets.map((t) => (
              <span key={t.key}>
                <i style={t.color ? { background: t.color } : undefined} />
                {t.name} <em>{t.hours}h</em>
              </span>
            ))}
          </div>
        )}
      </div>

      <table className="h10-n24-t">
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col">Target</th>
            <th scope="col">Bid</th>
            <th scope="col">Guardrails</th>
          </tr>
        </thead>
        <tbody>
          {data.hours.map((h, i) => {
            const changed = i > 0 && h.targetKey !== data.hours[i - 1].targetKey
            return (
              <tr key={h.at} className={changed ? 'chg' : undefined}>
                <td className="hr">
                  {/* Row 0 is the hour running right now, so the preview can be checked against
                      live behaviour instead of having to be trusted. */}
                  {i === 0 ? <b>now</b> : <span>{DAYS[h.dow]} {hh(h.hour)}</span>}
                  {i === 0 && <em>{DAYS[h.dow]} {hh(h.hour)}</em>}
                </td>
                <td className="tg">
                  {h.missingTarget ? (
                    <span className="miss"><AlertTriangle size={12} /> {h.targetKey} — deleted</span>
                  ) : h.targetName ? (
                    <>
                      <i style={h.color ? { background: h.color } : undefined} />
                      <span>{h.targetName}</span>
                      {h.source === 'baseline' && <em title="Not painted — this is the schedule’s baseline for the rest of the week">baseline</em>}
                      {/* Per-row too, not just in the summary: with a hand-over mid-window the
                          only way to see WHERE the plan changes is on the hour it changes. */}
                      {h.eventName && <em className="evt" title={`The dated event “${h.eventName}” governs this hour instead of the weekly plan`}>{h.eventName}</em>}
                    </>
                  ) : (
                    <span className="none">no target</span>
                  )}
                </td>
                <td className="bd">
                  {h.suppressed ? (
                    <span className="sup">bids at ~2¢ floor</span>
                  ) : h.floorPct == null ? (
                    <span className="none">—</span>
                  ) : h.canChase ? (
                    /* "300% → 900%" rather than "300% → up to 900%": the arrow already carries
                       "up to", and the longer phrasing wrapped across three lines in the column,
                       which broke the vertical alignment the whole table depends on. */
                    /* Green reads as "fine", which a climb WITHOUT a ceiling is not — an
                       unbounded row would otherwise show a reassuring colour beside its own red
                       "no ceiling" guardrail. A bounded climb stays green: that one IS fine. */
                    <span className={h.unbounded ? 'chase risk' : 'chase'}><TrendingUp size={12} /> {h.floorPct}% → <b>{h.ceilingPct}%</b></span>
                  ) : (
                    <span className="hold">hold {h.floorPct}%</span>
                  )}
                  {/* MB.6 — on its OWN line. Inside .chase (white-space: nowrap) it widened the
                      cell past its column and overprinted the guardrail beside it. */}
                  {h.cpcCapPct != null && !h.suppressed && (
                    <span className="capd" title={`The €${((h.maxCpcCents ?? 0) / 100).toFixed(2)} CPC ceiling stops this hour at ${h.cpcCapPct}% — the target itself would allow more`}>CPC-capped</span>
                  )}
                </td>
                <td className="gd">
                  {h.allOut && <span className="ao">all-out</span>}
                  {h.maxCpcCents != null && <span>max {eur(h.maxCpcCents)}</span>}
                  {h.acosCapPct != null && <span>ACoS ≤ {h.acosCapPct}%</span>}
                  {h.unbounded && <span className="bad">no ceiling</span>}
                  {!h.allOut && h.maxCpcCents == null && h.acosCapPct == null && !h.suppressed && h.floorPct != null && <span className="none">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
