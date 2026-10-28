'use client'

/**
 * A moment in time: a date (`DateField`) and a time of day (`Listbox`, in steps), in the viewer's own
 * time zone, which the field names beside the controls — "Europe/Rome (CEST)".
 *
 * `value` and `onChange` are an ISO instant (`Date.prototype.toISOString`, UTC) or '' for unset, so the
 * stored moment never depends on who reads it: only its presentation does. Added for "Fixed number
 * until Monday 09:00" (shared stock plan, Sync Control end times): the design system had a date field
 * and no time, and a date alone cannot say when on Monday an override ends.
 *
 * `min` / `max` are instants too: days outside them cannot be picked, and on the first and last day the
 * times outside them are not offered. Choosing a date keeps the chosen time (or starts at `defaultTime`);
 * choosing a time keeps the date (or starts on the first allowed day).
 */
import { useMemo } from 'react'
import { DateField, type DateFormat } from './DateField'
import { Listbox } from './Listbox'

export interface DateTimeFieldProps {
  /** ISO instant, or '' for unset. */
  value: string
  onChange: (value: string) => void
  /** ISO instant: earlier moments are not offered. */
  min?: string
  /** ISO instant: later moments are not offered. */
  max?: string
  /** Minutes between the offered times. Default 15. */
  stepMinutes?: 5 | 10 | 15 | 30 | 60
  /** The time a newly chosen date starts at, `HH:MM`. Default `09:00`. */
  defaultTime?: string
  format?: DateFormat
  /** BCP-47 locale for the month heading and the zone name. Default `en-GB`. */
  locale?: string
  /** id for the DATE trigger, so a `Field` label reaches it. The time list is named by `ariaLabel`. */
  id?: string
  'aria-describedby'?: string
  /** What the moment is, e.g. "Ends". Names the date and the time controls. */
  ariaLabel?: string
  disabled?: boolean
  className?: string
}

const pad = (n: number) => String(n).padStart(2, '0')
/** The viewer's local calendar day of an instant, `yyyy-mm-dd`. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** The viewer's local time of day of an instant, `HH:MM`. */
export const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
/** A local day and time of day as an instant. */
export function combineLocal(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0)
}
const parse = (iso: string | undefined) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The times offered on `day`: every step inside [min, max], plus the chosen time if it sits between steps. */
export function timeOptions(day: string, stepMinutes: number, min: Date | null, max: Date | null, chosen = ''): string[] {
  const out: string[] = []
  for (let minutes = 0; minutes < 24 * 60; minutes += stepMinutes) {
    const t = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
    const at = combineLocal(day, t)
    if (min && at < min) continue
    if (max && at > max) continue
    out.push(t)
  }
  if (chosen && !out.includes(chosen)) out.push(chosen)
  return out.sort()
}

/** The instant for a chosen day and time (or `defaultTime`), kept inside [min, max]; '' without a day. */
export function momentValue(date: string, time: string, defaultTime: string, min: Date | null, max: Date | null): string {
  if (!date) return ''
  let at = combineLocal(date, time || defaultTime)
  if (min && at < min) at = min
  if (max && at > max) at = max
  return at.toISOString()
}

/** "Europe/Rome (CEST)" — the zone the times are shown in. */
export function timeZoneWords(at: Date = new Date(), locale = 'en-GB'): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const short = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value
  return short && short !== zone ? `${zone} (${short})` : zone
}

export function DateTimeField({
  value, onChange, min, max, stepMinutes = 15, defaultTime = '09:00', format, locale = 'en-GB',
  id, 'aria-describedby': describedBy, ariaLabel, disabled, className,
}: DateTimeFieldProps) {
  const current = parse(value)
  const minD = parse(min)
  const maxD = parse(max)
  const date = current ? localDay(current) : ''
  const time = current ? localTime(current) : ''
  const firstDay = minD ? localDay(minD) : localDay(new Date())

  // A stored value between steps stays visible and selected instead of silently changing.
  const times = useMemo(() => timeOptions(date || firstDay, stepMinutes, minD, maxD, time).map((t) => ({ value: t, label: t })),
    [date, firstDay, time, stepMinutes, minD?.getTime(), maxD?.getTime()]) // eslint-disable-line react-hooks/exhaustive-deps

  const emit = (nextDate: string, nextTime: string) => onChange(momentValue(nextDate, nextTime, defaultTime, minD, maxD))
  const zone = timeZoneWords(current ?? new Date(), locale)
  const name = ariaLabel ?? 'Date and time'
  // The controls' names replace their visible text for a screen reader, so they carry the choice too.
  const dayWords = current ? current.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'not chosen'

  return <div className={`nds-datetimefield${className ? ` ${className}` : ''}`}>
    <DateField id={id} aria-describedby={describedBy} value={date} format={format} locale={locale}
      min={minD ? localDay(minD) : undefined} max={maxD ? localDay(maxD) : undefined}
      onChange={(next) => emit(next, time)} ariaLabel={`${name}: date, ${dayWords}`} disabled={disabled} placeholder="Choose a date" />
    <Listbox className="nds-datetimefield-time" value={time} onChange={(next) => emit(date || firstDay, next)}
      options={times} ariaLabel={`${name}: time, ${time || 'not chosen'} (${zone})`} placeholder="Time" disabled={disabled} width={104} />
    <span className="nds-datetimefield-zone">{zone}</span>
  </div>
}
