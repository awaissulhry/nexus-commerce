'use client'

/**
 * DayStrip — a horizontal day bar (B-W2b-28, design part DayStrip): the shift window, clocked spans, breaks, clock
 * events, overlays (scan minutes, machine status) and anomaly marks; readable as text for a screen reader.
 *
 *   <DayStrip label="Marta Demo · mar 3 nov" from="2026-11-03T05:00:00Z" to="2026-11-03T21:00:00Z"
 *             shift={{ from: '…T07:00:00Z', to: '…T16:00:00Z' }} segments={spans} events={clockEvents}
 *             overlays={canSeeScans ? [{ id: 'scan', name: 'Minuti di scansione', spans }] : []}
 *             anomalies={[{ id: 'a', label: 'Uscita mancante; uscita automatica alle 22:15' }]}
 *             timeZone="Europe/Rome" locale="it" labels={ds.dayStrip} />
 *
 * - The drawing is `aria-hidden`; the same day is an ordered list of sentences (`dayStripModel.ts`), visually hidden
 *   unless `showText` (then under the bar with its heading). Nothing is said only by colour: breaks are hatched, the
 *   shift is an outline, events are marks with their own glyph, anomalies a warning mark — and a key names each kind.
 * - Times in the site's zone (`timeZone`, `locale`), or the app's `formatTime`. Hour ticks every `tickHours` (2); on a
 *   narrow strip (a phone) every other tick keeps its words, so the labels never run into each other.
 * - Overlays are rows under the bar, one per overlay, named; a per-person overlay is the app's to pass only where the
 *   law allows it (the strip shows what it is given).
 */
import { createElement, useId, useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { DAY_STRIP_LABELS, type DayStripLabels } from './DayStripLabels'
import {
  dayMs,
  dayPct,
  daySpan,
  dayStripLines,
  dayTicks,
  type DayAnomaly,
  type DayEvent,
  type DayMoment,
  type DayOverlay,
  type DaySegment,
  type DaySegmentKind,
  type DayWindow,
} from './dayStripModel'
import './dayStrip.css'

export interface DayStripProps {
  /** The strip's name ("Marta Demo · Tue 3 Nov"). */
  label: string
  /** The window drawn. */
  from: DayMoment
  to: DayMoment
  shift?: { from: DayMoment; to: DayMoment; label?: string }
  segments?: readonly DaySegment[]
  events?: readonly DayEvent[]
  overlays?: readonly DayOverlay[]
  anomalies?: readonly DayAnomaly[]
  /** Writes a moment as a time. Default: `locale` and `timeZone`, 24-hour. */
  formatTime?: (ms: number) => string
  locale?: string
  timeZone?: string
  /** Hours between ticks (default 2). */
  tickHours?: number
  /** Show the day in words on screen too (default: screen reader only). */
  showText?: boolean
  labels?: Partial<DayStripLabels>
  id?: string
}

const KIND_ORDER: readonly DaySegmentKind[] = ['work', 'overtime', 'break', 'absence', 'idle']

export function DayStrip({
  label,
  from,
  to,
  shift,
  segments = [],
  events = [],
  overlays = [],
  anomalies = [],
  formatTime,
  locale = 'en-GB',
  timeZone,
  tickHours = 2,
  showText = false,
  labels,
  id,
}: DayStripProps) {
  const lw = mergeLabels(DAY_STRIP_LABELS, labels)
  const kinds = { ...DAY_STRIP_LABELS.kinds, ...labels?.kinds }
  const events_ = { ...DAY_STRIP_LABELS.events, ...labels?.events }
  const words = { ...lw, kinds, events: events_ }
  const auto = useId()
  const w: DayWindow = { from: dayMs(from), to: dayMs(to) }

  const { time, zoneMinute } = useMemo(() => {
    const hm = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
    const minutePart = new Intl.DateTimeFormat('en-GB', { minute: '2-digit', second: '2-digit', timeZone })
    return {
      time: formatTime ?? ((ms: number) => (Number.isFinite(ms) ? hm.format(new Date(ms)) : '—')),
      zoneMinute: (ms: number) => {
        const parts = minutePart.formatToParts(new Date(ms))
        const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
        const s = Number(parts.find((p) => p.type === 'second')?.value ?? 0)
        return m + s / 60
      },
    }
  }, [formatTime, locale, timeZone])

  const ticks = dayTicks(w, tickHours, zoneMinute)
  const lines = dayStripLines({ shift, segments, events, overlays, anomalies }, words, time)
  const shiftBox = shift ? daySpan(w, dayMs(shift.from), dayMs(shift.to)) : null
  const present = KIND_ORDER.filter((k) => segments.some((s) => s.kind === k))
  const box = (s: { left: number; width: number }) => ({ left: `${s.left}%`, width: `${s.width}%` })

  return (
    <figure id={id} className="nds-daystrip" aria-labelledby={`${auto}-cap`}>
      <figcaption id={`${auto}-cap`} className="nds-daystrip-caption">
        {label}
      </figcaption>
      <div className="nds-daystrip-visual" aria-hidden>
        <div className="nds-daystrip-bar">
          {shiftBox ? <span className="nds-daystrip-shift" style={box(shiftBox)} /> : null}
          {segments.map((s) => {
            const b = daySpan(w, dayMs(s.from), dayMs(s.to))
            return b ? (
              <span
                key={s.id}
                className="nds-daystrip-seg"
                data-kind={s.kind}
                style={box(b)}
                title={words.span(kinds[s.kind], time(dayMs(s.from)), time(dayMs(s.to)))}
              />
            ) : null
          })}
          {events.map((e) => {
            const t = dayMs(e.at)
            if (!Number.isFinite(t) || t < w.from || t > w.to) return null
            return <span key={e.id} className="nds-daystrip-event" data-kind={e.kind} data-flagged={e.flagged ? 'true' : undefined} style={{ left: `${dayPct(w, t)}%` }} title={words.at(events_[e.kind], time(t))} />
          })}
          {anomalies.map((a) => {
            const t = a.at === undefined ? NaN : dayMs(a.at)
            return (
              <span key={a.id} className="nds-daystrip-anomaly" data-untimed={Number.isFinite(t) ? undefined : 'true'} style={Number.isFinite(t) ? { left: `${dayPct(w, t)}%` } : undefined} title={a.label}>
                <AlertTriangle />
              </span>
            )
          })}
        </div>
        {overlays.map((o) => (
          <div key={o.id} className="nds-daystrip-overlay">
            <span className="nds-daystrip-overlay-name">{o.name}</span>
            <div className="nds-daystrip-overlay-row">
              {o.spans.map((s) => {
                const b = daySpan(w, dayMs(s.from), dayMs(s.to))
                return b ? <span key={s.id} className="nds-daystrip-ospan" data-tone={s.tone ?? 'neutral'} style={box(b)} title={words.span(s.label, time(dayMs(s.from)), time(dayMs(s.to)))} /> : null
              })}
            </div>
          </div>
        ))}
        <div className="nds-daystrip-axis">
          {ticks.map((t, i) => {
            const pct = dayPct(w, t)
            // A tick at either end keeps its words inside the strip (no sideways scroll).
            return (
              <span key={t} className="nds-daystrip-tick" data-edge={pct < 4 ? 'start' : pct > 96 ? 'end' : undefined} data-odd={i % 2 ? 'true' : undefined} style={{ left: `${pct}%` }}>
                {time(t)}
              </span>
            )
          })}
        </div>
        {present.length || shiftBox || anomalies.length ? (
          <ul className="nds-daystrip-legend">
            {shiftBox ? (
              <li>
                <span className="nds-daystrip-swatch" data-kind="shift" />
                {lw.shiftKey}
              </li>
            ) : null}
            {present.map((k) => (
              <li key={k}>
                <span className="nds-daystrip-swatch" data-kind={k} />
                {kinds[k]}
              </li>
            ))}
            {anomalies.length ? (
              <li>
                {createElement(AlertTriangle, { className: 'nds-daystrip-legend-icon' })}
                {lw.anomalyKey}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      <div className={showText ? 'nds-daystrip-text' : 'nds-vh'}>
        {showText ? <div className="nds-daystrip-text-title">{lw.textTitle}</div> : null}
        <ol>
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      </div>
    </figure>
  )
}
