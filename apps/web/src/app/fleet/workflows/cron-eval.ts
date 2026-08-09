/**
 * NAF.WF-S5R / S5.b — a VERBATIM MIRROR of
 * `apps/api/src/services/agent-fleet/cron-eval.ts`.
 *
 * Why a mirror and not an import: the server module is the authority on
 * whether a cron is evaluable — `validateDefinition` refuses a schedule
 * exactly when `nextCronFire` returns null — and the editor's checklist is
 * bound to be in EXACT parity with that. Guessing at the rule client-side is
 * what produced the defect this phase fixes: prod rendered `99 99 * * *` as
 * "Nightly at 99:99 UTC" with zero problems and Publish enabled, because the
 * old check asked only whether the minute and hour were integers.
 *
 * Why not `@nexus/shared`: that is the better long-term home and it is
 * already a web dependency. It was not taken here because the move edits
 * `fleet-schedule.service.ts` — a sibling stream's file — and adds an export
 * path to the shared package's build graph, mid-session, in parallel work.
 * Recorded in the WF doc as the follow-up.
 *
 * Everything below the header is byte-identical to the server file, and
 * `cron-eval-mirror.vitest.test.ts` in the API suite fails the moment it
 * stops being.
 */

const SCAN_LIMIT_MINUTES = 8 * 24 * 60

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (rangePart === '*' || rangePart === '') {
      lo = min
      hi = max
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null
      lo = a!
      hi = b!
    } else {
      const n = Number(rangePart)
      if (!Number.isInteger(n)) return null
      lo = n
      hi = n
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function nextCronFire(expr: string, from: Date): Date | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseField(fields[0]!, 0, 59)
  const hour = parseField(fields[1]!, 0, 23)
  const dom = parseField(fields[2]!, 1, 31)
  const month = parseField(fields[3]!, 1, 12)
  const dow = parseField(fields[4]!, 0, 6)
  if (!minute || !hour || !dom || !month || !dow) return null

  // Standard cron dom/dow semantics: when BOTH are restricted, either may
  // match; when one is *, the other decides.
  const domAll = fields[2] === '*'
  const dowAll = fields[4] === '*'

  const t = new Date(from)
  t.setUTCSeconds(0, 0)
  t.setUTCMinutes(t.getUTCMinutes() + 1)
  for (let i = 0; i < SCAN_LIMIT_MINUTES; i++) {
    const dayMatch =
      domAll && dowAll
        ? true
        : domAll
          ? dow.has(t.getUTCDay())
          : dowAll
            ? dom.has(t.getUTCDate())
            : dow.has(t.getUTCDay()) || dom.has(t.getUTCDate())
    if (
      minute.has(t.getUTCMinutes()) &&
      hour.has(t.getUTCHours()) &&
      month.has(t.getUTCMonth() + 1) &&
      dayMatch
    ) {
      return new Date(t)
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1)
  }
  return null
}
