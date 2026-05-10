// MC.11.6 — Cron expression helper.
//
// Standard 5-field cron: minute / hour / dayOfMonth / month / dayOfWeek.
// Validation is structural — checks each field is in range and uses
// the right syntax. Doesn't pull in a full cron-parsing dependency
// because the helper just needs "is this expression sane + when's
// the next firing".
//
// Next-firing computation is approximate: handles fixed values, *,
// step (\*\/N), and lists. Doesn't yet handle ranges (5-10) — those
// fall back to "best-effort match". Sufficient for the operator's
// "next 5 firings" preview.

export interface CronValidation {
  ok: boolean
  error: string | null
  /// Pretty description: "every day at 02:00", "every Monday at 09:00", etc.
  description: string | null
}

interface CronField {
  values: number[] | '*'
  raw: string
}

const RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0=Sunday)
]

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']

function parseField(
  raw: string,
  range: { min: number; max: number },
  name: string,
): CronField | string {
  const r = raw.trim()
  if (r === '*') return { values: '*', raw: r }
  // Step: */N or */*N (we accept both)
  const stepMatch = r.match(/^\*\/(\d+)$/)
  if (stepMatch) {
    const step = parseInt(stepMatch[1]!, 10)
    if (!step || step < 1) return `${name}: invalid step "${r}"`
    const values: number[] = []
    for (let v = range.min; v <= range.max; v += step) values.push(v)
    return { values, raw: r }
  }
  // List of values
  if (r.includes(',')) {
    const parts = r.split(',').map((p) => p.trim())
    const values: number[] = []
    for (const p of parts) {
      const n = parseInt(p, 10)
      if (Number.isNaN(n) || n < range.min || n > range.max)
        return `${name}: "${p}" out of range ${range.min}–${range.max}`
      values.push(n)
    }
    return { values, raw: r }
  }
  // Range: a-b
  const rangeMatch = r.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]!, 10)
    const hi = parseInt(rangeMatch[2]!, 10)
    if (lo < range.min || hi > range.max || lo > hi)
      return `${name}: invalid range "${r}"`
    const values: number[] = []
    for (let v = lo; v <= hi; v++) values.push(v)
    return { values, raw: r }
  }
  // Single value
  const n = parseInt(r, 10)
  if (Number.isNaN(n))
    return `${name}: not a number "${r}"`
  if (n < range.min || n > range.max)
    return `${name}: ${n} out of range ${range.min}–${range.max}`
  return { values: [n], raw: r }
}

export function validateCron(expression: string): CronValidation {
  const trimmed = expression.trim()
  if (!trimmed)
    return { ok: false, error: 'Cron expression is required', description: null }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5)
    return {
      ok: false,
      error: `Expected 5 fields, got ${parts.length}. Format: "min hour dom mon dow"`,
      description: null,
    }
  const fields: CronField[] = []
  for (let i = 0; i < 5; i++) {
    const result = parseField(parts[i]!, RANGES[i]!, FIELD_NAMES[i]!)
    if (typeof result === 'string')
      return { ok: false, error: result, description: null }
    fields.push(result)
  }
  return {
    ok: true,
    error: null,
    description: describe(fields, parts as [string, string, string, string, string]),
  }
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function describe(
  fields: CronField[],
  parts: [string, string, string, string, string],
): string {
  const [min, hour, dom, mon, dow] = parts
  // Common shortcut: 0 0 * * * → "every day at midnight"
  if (parts.join(' ') === '0 0 * * *') return 'every day at midnight'
  if (parts.join(' ') === '0 12 * * *') return 'every day at noon'
  if (min === '0' && hour !== '*' && dom === '*' && mon === '*' && dow === '*')
    return `every day at ${hour.padStart(2, '0')}:00`
  if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow === '*')
    return `every day at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (
    min !== '*' &&
    hour !== '*' &&
    dom === '*' &&
    mon === '*' &&
    /^\d+$/.test(dow)
  )
    return `every ${DOW_NAMES[parseInt(dow, 10)] ?? dow} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (
    min !== '*' &&
    hour !== '*' &&
    /^\d+$/.test(dom) &&
    mon === '*' &&
    dow === '*'
  )
    return `on day ${dom} of every month at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'every minute (be careful!)'
  if (parts[0]!.startsWith('*/'))
    return `every ${parts[0]!.slice(2)} minute(s)`
  // Fallback — just enumerate
  const parts2: string[] = []
  if (Array.isArray(fields[0]!.values))
    parts2.push(`min ${fields[0]!.raw}`)
  if (Array.isArray(fields[1]!.values))
    parts2.push(`hour ${fields[1]!.raw}`)
  if (Array.isArray(fields[2]!.values))
    parts2.push(`day ${fields[2]!.raw}`)
  if (Array.isArray(fields[3]!.values))
    parts2.push(`month ${fields[3]!.raw}`)
  if (Array.isArray(fields[4]!.values))
    parts2.push(
      `weekday ${fields[4]!.values
        .map((v) => DOW_NAMES[v] ?? v)
        .join(',')}`,
    )
  return parts2.join(', ') || 'always'
}

// Approximate next N firings. Steps minute-by-minute starting from
// `from` (default = now) up to a 1-year cap. Returns ISO timestamps.
export function nextFirings(
  expression: string,
  count = 5,
  from: Date = new Date(),
): string[] {
  const validation = validateCron(expression)
  if (!validation.ok) return []
  const parts = expression.trim().split(/\s+/)
  const fields: CronField[] = []
  for (let i = 0; i < 5; i++) {
    const result = parseField(parts[i]!, RANGES[i]!, FIELD_NAMES[i]!)
    if (typeof result === 'string') return []
    fields.push(result)
  }
  const matches = (date: Date): boolean => {
    const minute = date.getMinutes()
    const hour = date.getHours()
    const dom = date.getDate()
    const mon = date.getMonth() + 1
    const dow = date.getDay()
    const fieldMatches = (field: CronField, value: number): boolean =>
      field.values === '*' || field.values.includes(value)
    return (
      fieldMatches(fields[0]!, minute) &&
      fieldMatches(fields[1]!, hour) &&
      fieldMatches(fields[2]!, dom) &&
      fieldMatches(fields[3]!, mon) &&
      fieldMatches(fields[4]!, dow)
    )
  }
  const results: string[] = []
  // Round up to next minute boundary.
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000)
  let safety = 0
  while (results.length < count && cursor < limit && safety < 1_000_000) {
    if (matches(cursor)) results.push(cursor.toISOString())
    cursor.setMinutes(cursor.getMinutes() + 1)
    safety++
  }
  return results
}

// Curated cron presets — operator-friendly shortcuts.
export const CRON_PRESETS: Array<{
  label: string
  expression: string
  description: string
}> = [
  {
    label: 'Every hour',
    expression: '0 * * * *',
    description: 'Top of every hour, all day.',
  },
  {
    label: 'Every day at 02:00',
    expression: '0 2 * * *',
    description:
      'Common nightly sweep — runs while the catalogue is quiet.',
  },
  {
    label: 'Every weekday at 09:00',
    expression: '0 9 * * 1-5',
    description: 'Monday–Friday morning.',
  },
  {
    label: 'Every Monday at 08:00',
    expression: '0 8 * * 1',
    description: 'Weekly start-of-week kickoff.',
  },
  {
    label: 'First of every month at 03:00',
    expression: '0 3 1 * *',
    description: 'Monthly maintenance / archival sweep.',
  },
  {
    label: 'Every 15 minutes',
    expression: '*/15 * * * *',
    description: 'High-frequency. Be careful with quotas.',
  },
]
