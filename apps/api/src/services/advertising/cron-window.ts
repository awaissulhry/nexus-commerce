/**
 * ACR.1.5 — when will this cron actually fire, inside a given window.
 *
 * Foresight has to say "the bid optimiser runs twice tonight, at 02:20 and 08:20" rather than
 * "every 6 h", and there is no way to get that from node-cron: it schedules, it does not
 * enumerate. The expressions this fleet uses are a narrow, well-behaved subset — `*`, `*​/n`,
 * `a,b,c` lists, ranges and plain numbers across the standard five fields — so this evaluates
 * them directly rather than pulling in a parser for a handful of strings.
 *
 * It walks the window minute by minute and tests each field. 1,440 checks per engine per day is
 * nothing, and an exhaustive walk cannot drift the way "next fire = last + interval" arithmetic
 * does across a DST boundary or a `7,22,37,52` list.
 *
 * The caller passes the SAME expression the job reads (env var, same default), because a preview
 * computed from a hardcoded copy of a schedule is a preview that silently goes stale the first
 * time someone overrides it — the failure `next24.ts` was written to avoid on the rank side.
 *
 * Times are evaluated in UTC, matching node-cron's behaviour in these containers (no `timezone`
 * option is passed at any call site in the fleet).
 */

/** One parsed field: the set of values it matches, or null for `*`. */
type Field = Set<number> | null

function parseField(raw: string, min: number, max: number): Field {
  const spec = raw.trim()
  if (spec === '*') return null
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`)
    let lo = min
    let hi = max
    if (rangePart !== '*') {
      const bounds = rangePart.split('-')
      lo = Number(bounds[0])
      hi = bounds.length > 1 ? Number(bounds[1]) : (stepPart ? max : lo)
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`bad range in "${part}"`)
      if (lo < min || hi > max || lo > hi) throw new Error(`range out of bounds in "${part}"`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  if (out.size === 0) throw new Error(`field "${raw}" matches nothing`)
  return out
}

export interface ParsedCron {
  minute: Field
  hour: Field
  dayOfMonth: Field
  month: Field
  dayOfWeek: Field
}

/** Throws on anything this evaluator cannot honestly answer for — never guesses. */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`expected 5 fields, got ${parts.length}: "${expr}"`)
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    // 7 is Sunday in crontab as well as 0; normalise so `* * * * 7` matches.
    dayOfWeek: (() => {
      const f = parseField(parts[4], 0, 7)
      if (f && f.has(7)) f.add(0)
      return f
    })(),
  }
}

const matches = (f: Field, v: number) => f == null || f.has(v)

/**
 * Whether the expression fires at this exact minute.
 *
 * The day-of-month / day-of-week rule follows crontab: when BOTH are restricted the entry fires
 * if EITHER matches (the union, not the intersection). Getting this backwards would silently
 * drop most fires of any expression that pins both — worth stating because it reads as a bug.
 */
export function firesAt(c: ParsedCron, d: Date): boolean {
  if (!matches(c.minute, d.getUTCMinutes())) return false
  if (!matches(c.hour, d.getUTCHours())) return false
  if (!matches(c.month, d.getUTCMonth() + 1)) return false
  const domRestricted = c.dayOfMonth != null
  const dowRestricted = c.dayOfWeek != null
  const domOk = matches(c.dayOfMonth, d.getUTCDate())
  const dowOk = matches(c.dayOfWeek, d.getUTCDay())
  if (domRestricted && dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

export interface CronFires {
  /** Every firing instant inside the window, ISO, ascending. */
  fires: string[]
  /** The first one, or null when it does not fire in this window at all. */
  next: string | null
  count: number
}

/**
 * Every fire of `expr` in `[from, from + hours)`, capped so a per-minute expression cannot
 * return 1,440 strings to a UI that will render the first three.
 *
 * Returns `count` uncapped, because "96 runs, showing 6" is the honest presentation and a
 * truncated array with no total silently understates what the engine will do.
 */
export function firesIn(expr: string, from: Date, hours = 24, cap = 8): CronFires {
  const c = parseCron(expr)
  // Start at the next whole minute: `from` is usually "now" mid-minute, and reporting a fire
  // that already happened as upcoming is the one error this function must not make.
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000)
  const end = from.getTime() + hours * 3_600_000
  const fires: string[] = []
  let count = 0
  for (let t = start.getTime(); t < end; t += 60_000) {
    const d = new Date(t)
    if (!firesAt(c, d)) continue
    count += 1
    if (fires.length < cap) fires.push(d.toISOString())
  }
  return { fires, next: fires[0] ?? null, count }
}

/** Human cadence from the expression itself, so the label cannot drift from the schedule. */
export function describeCron(expr: string): string {
  try {
    // Parse first, purely to reject. Without this, formatting is pure string surgery and
    // `describeCron('not a cron')` confidently returns "weekly, 0a:not UTC" — a label that
    // looks authoritative and means nothing, which is the failure mode this whole tab exists
    // to avoid. An expression we cannot evaluate is shown verbatim instead.
    parseCron(expr)
    const parts = expr.trim().split(/\s+/)
    const [m, h, , , dow] = parts
    if (m === '*') return 'every minute'
    const everyMin = /^\*\/(\d+)$/.exec(m)
    if (everyMin && h === '*') return `every ${everyMin[1]} min`
    const everyHour = /^\*\/(\d+)$/.exec(h)
    if (everyHour) return `every ${everyHour[1]} h at :${m.padStart(2, '0')}`
    if (m.includes(',') && h === '*') return `${m.split(',').length}× an hour`
    if (h === '*') return `hourly at :${m.padStart(2, '0')}`
    if (dow !== '*') return `weekly, ${h.padStart(2, '0')}:${m.padStart(2, '0')} UTC`
    return `daily ${h.padStart(2, '0')}:${m.padStart(2, '0')} UTC`
  } catch {
    return expr
  }
}
