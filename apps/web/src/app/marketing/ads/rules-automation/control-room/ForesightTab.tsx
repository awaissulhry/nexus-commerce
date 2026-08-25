'use client'

/**
 * ACR.1.5 — Foresight: the next 24 hours, before they happen.
 *
 * Today says what is wrong now. This says what is about to happen, which is the other half of
 * being able to stop watching: you can leave automation alone once you can see what it intends.
 *
 * The layout carries the honesty rule from the service. Rank hand-overs are **commitments** —
 * the hour is known and each one is a bid write — so they get the timeline, with counts. Engine
 * ticks are **opportunities** — the tick will happen, what it writes depends on data that does
 * not exist yet — so they get a cadence list and no per-hour claim about outcome. Rendering
 * both as the same kind of thing would make the account look far more determined than it is.
 *
 * Light-only, like the rest of this console.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { AlertTriangle, RefreshCw, Info, Ban, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Hour {
  at: string
  hour: number
  bidChanges: number
  suppressed: number
  unbounded: number
  noCpcCeiling: number
  engineRuns: { key: string; name: string; fires: number }[]
  targets: { key: string; name: string; schedules: number }[]
}

interface Engine {
  key: string
  name: string
  cron: string
  cadence: string
  fires: number
  nextFires: string[]
  canWrite: boolean
  blockedReason: string | null
}

interface Foresight {
  generatedAt: string
  timezone: string
  scheduledBidChanges: number | null
  accountStopped: boolean
  accountStoppedReason: string | null
  schedulesConsidered: { total: number; enabled: number }
  hours: Hour[]
  engines: Engine[]
  notes: string[]
}

const hhmm = (iso: string, tz: string) => {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  } catch {
    return new Date(iso).toISOString().slice(11, 16)
  }
}

/**
 * The cadence label, spoken in the SAME clock as the times beside it.
 *
 * `describeCron` reports UTC, because that is the frame node-cron evaluates in. The next-fire
 * times render in the account timezone. Printed side by side that produced a row reading
 * "daily 06:30 UTC · next 08:30" — one event, two clocks, which is exactly the kind of quiet
 * contradiction this tab exists to prevent. For fixed daily/weekly schedules the clock is taken
 * from the first real fire instead; interval cadences ("every 15 min") carry no clock and are
 * left alone. The raw expression stays in the tooltip either way.
 */
const cadenceIn = (e: Engine, tz: string): string => {
  const m = /^(daily|weekly, )(.*) UTC$/.exec(e.cadence)
  if (!m || e.nextFires.length === 0) return e.cadence
  return m[1] === 'daily' ? `daily ${hhmm(e.nextFires[0], tz)}` : `weekly, ${hhmm(e.nextFires[0], tz)}`
}

/** Chip colours follow what the target DOES, not a palette — suppression must never read as "on". */
const targetTone = (key: string): string =>
  key === 'pause' ? 'sup' : key.includes('allout') ? 'hot' : 'norm'

export function ForesightTab() {
  const [f, setF] = useState<Foresight | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/foresight`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`foresight: ${r.status}`)
      setF((await r.json()) as Foresight)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
      setF(null)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  if (loading && !f) return <div className="acr-empty">Loading…</div>
  if (err) return <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>
  if (!f) return <div className="acr-empty">No forecast returned.</div>

  const maxChanges = Math.max(1, ...f.hours.map((h) => h.bidChanges))

  return (
    <div className="acr-fs">
      <div className="acr-today-top">
        <div className="acr-today-hero">
          <div className="acr-today-hero-k">Scheduled bid changes · next 24 h</div>
          <div className="acr-today-hero-v">
            {f.scheduledBidChanges == null ? '—' : f.scheduledBidChanges.toLocaleString('en-IE')}
            <span className="acr-today-hero-sub">
              across {f.schedulesConsidered.enabled} enabled schedules of {f.schedulesConsidered.total}
            </span>
          </div>
          <p className="acr-today-hero-note">
            {f.accountStopped
              ? 'Automation is stopped, so none of these would land. What follows is a rehearsal, not a forecast.'
              : 'Every hand-over from one rank target to another is a bid write. Times are in ' + f.timezone + '.'}
          </p>
        </div>
        <div className="acr-today-meta">
          <Button size="sm" className="acr-refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} /> {loading ? 'Checking…' : 'Re-check'}
          </Button>
        </div>
      </div>

      {f.notes.map((n) => (
        <div key={n.slice(0, 40)} className="acr-banner warn">
          <Info size={15} /> <span>{n}</span>
        </div>
      ))}

      <div className="acr-sec-head">
        <h2>Timeline</h2>
        <span className="acr-sec-count">
          hour by hour, {f.timezone} · the first row is the hour running now
        </span>
      </div>

      <ul className="acr-fs-hours">
        {f.hours.map((h, i) => (
          <li key={h.at} className={`acr-fs-hour ${i === 0 ? 'now' : ''}`}>
            <span className="acr-fs-h">{String(h.hour).padStart(2, '0')}:00</span>

            {/* The bar is the scan path: where the writes cluster is visible before any number
                is read. Scaled to the busiest hour, not to an arbitrary maximum. */}
            <span className="acr-fs-bar" title={`${h.bidChanges} scheduled bid changes`}>
              <span className="acr-fs-bar-fill" style={{ width: `${(h.bidChanges / maxChanges) * 100}%` }} />
            </span>
            <span className={`acr-fs-n ${h.bidChanges === 0 ? 'zero' : ''}`}>{h.bidChanges}</span>

            <span className="acr-fs-targets">
              {h.targets.length === 0
                ? <span className="acr-fs-none">no schedule governs this hour</span>
                : h.targets.map((t) => (
                  <span key={t.key} className={`acr-fs-chip ${targetTone(t.key)}`}>
                    {t.name}<em>×{t.schedules}</em>
                  </span>
                ))}
            </span>

            <span className="acr-fs-flags">
              {h.noCpcCeiling > 0 && (
                <span
                  className="acr-fs-flag nocap"
                  title={`${h.noCpcCeiling} schedules run a mode with no CPC ceiling this hour`}
                >
                  {h.noCpcCeiling} no cap
                </span>
              )}
              {h.unbounded > 0 && (
                <span className="acr-fs-flag unb" title="All-out with no CPC ceiling — only Amazon's 900% cap applies">
                  {h.unbounded} unbounded
                </span>
              )}
              {h.suppressed > 0 && (
                <span className="acr-fs-flag sup" title="Bids floored to ~2¢. Delivery continues — nothing pauses.">
                  {h.suppressed} at min bid
                </span>
              )}
            </span>

            <span className="acr-fs-ticks" title={h.engineRuns.map((r) => `${r.name} ×${r.fires}`).join('\n')}>
              {h.engineRuns.reduce((a, r) => a + r.fires, 0)} ticks
            </span>
          </li>
        ))}
      </ul>

      <div className="acr-sec-head">
        <h2>Engines</h2>
        <span className="acr-sec-count">
          when each one runs — not what it will decide, which depends on data that does not exist yet
        </span>
      </div>

      <ul className="acr-fs-engines">
        {f.engines.map((e) => (
          <li key={e.key} className={`acr-fs-engine ${e.canWrite ? '' : 'blocked'}`}>
            <div className="acr-fs-engine-main">
              <strong>{e.name}</strong>
              <span className="acr-fs-cadence" title={`${e.cron} (UTC) — shown in ${f.timezone}`}>{cadenceIn(e, f.timezone)}</span>
              {e.canWrite
                ? <span className="acr-fs-can yes"><Check size={11} /> can write</span>
                : <span className="acr-fs-can no"><Ban size={11} /> cannot write</span>}
            </div>
            {e.blockedReason && <p className="acr-why">{e.blockedReason}</p>}
            <div className="acr-fs-engine-facts">
              <span><strong>{e.fires}</strong> {e.fires === 1 ? 'run' : 'runs'} in 24 h</span>
              {e.nextFires.length > 0 && (
                <span className="acr-fs-next">
                  next {e.nextFires.slice(0, 3).map((t) => hhmm(t, f.timezone)).join(' · ')}
                  {e.fires > 3 && ` …+${e.fires - 3}`}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="acr-foot">
        Rank hand-overs come from the same function the engine runs on, so this cannot show one
        thing while the engine does another. Engine rows state cadence only — a tick is an
        opportunity to write, not a commitment to.
      </p>
    </div>
  )
}
