import type { Prisma } from '@nexus/factory-db'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { checkUnit } from '../check'
import { OPEN_ORDER_STATES, type ProfileRow, type Reader } from '../store'

/**
 * The made-to-measure list's filters beyond the review (B-W2b-371, XF2:03; design sales.mtm tiles "Outside the certified range",
 * "Fittings this week" and Rows ▾ "Outside range"): what profiles.ts listProfiles reads for its rows, tiles and filters.
 *
 *   rangesOf     each newest revision's certified range: its open units (made-to-measure lines of open orders and open quotes
 *                made to it) checked as a unit is (./check.ts checkUnit, B-W2b-248's one check: each unit's style, colourway and
 *                base size): outside when one is (the points that fall out), inside when every one is, null when none is known
 *                (no open unit, or made-to-measure off for the unit's style's template: the check knows nothing then)
 *   fittingWeek  the revisions with a FITTING booked or done this business week (Monday to Sunday), whose chains the filter shows
 */

export interface Range {
  readonly inside: boolean | null
  readonly points: readonly string[]
}

const UNKNOWN: Range = Object.freeze({ inside: null, points: Object.freeze([]) as readonly string[] })
const OPEN_QUOTE_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'] as const

/** The certified range of each newest revision (by its id). Units of a style whose template is off are not checked (unknown). */
export async function rangesOf(db: Reader, latest: readonly ProfileRow[], now: Date): Promise<Map<string, Range>> {
  const out = new Map<string, Range>(latest.map((row) => [row.id, UNKNOWN]))
  const ids = latest.map((row) => row.id)
  if (ids.length === 0) return out
  const orderLines = await db.salesOrderLine.findMany({ where: { kind: 'MADE_TO_MEASURE', measurementProfileId: { in: ids }, closedShortAt: null, order: { status: { in: [...OPEN_ORDER_STATES] } } }, select: { seq: true, styleId: true, colourwayId: true, baseSize: true, measurementProfileId: true } })
  const quoteLines = await db.quoteLine.findMany({ where: { kind: 'MADE_TO_MEASURE', measurementProfileId: { in: ids }, quoteVersion: { status: { in: [...OPEN_QUOTE_STATES] } } }, select: { seq: true, styleId: true, colourwayId: true, baseSize: true, measurementProfileId: true } })
  const units = [...orderLines.map((line) => ({ ...line, kind: 'ORDER' as const })), ...quoteLines.map((line) => ({ ...line, kind: 'QUOTE' as const }))].filter((unit) => unit.measurementProfileId !== null)
  if (units.length === 0) return out
  // Only a style whose template has started made-to-measure tells anything (the check answers "not known" otherwise).
  const styles = await db.style.findMany({ where: { id: { in: [...new Set(units.map((unit) => unit.styleId))] } }, select: { id: true, measurementTemplateId: true } })
  const templateIds = [...new Set(styles.flatMap((style) => (style.measurementTemplateId ? [style.measurementTemplateId] : [])))]
  const started = new Set((templateIds.length === 0 ? [] : await db.measurementTemplate.findMany({ where: { id: { in: templateIds }, rulesOn: true }, select: { id: true } })).map((row) => row.id))
  const checked = new Map<string, { inside: boolean | null; points: string[] }>()
  for (const unit of units) {
    const style = styles.find((row) => row.id === unit.styleId)
    if (!style?.measurementTemplateId || !started.has(style.measurementTemplateId)) continue
    const key = JSON.stringify([unit.measurementProfileId, unit.styleId, unit.colourwayId, unit.baseSize])
    if (!checked.has(key)) {
      const answer = await checkUnit(db, { kind: unit.kind, seq: unit.seq, styleId: unit.styleId, colourwayId: unit.colourwayId, profileId: unit.measurementProfileId!, baseSize: unit.baseSize, now })
      const check = answer?.check
      checked.set(key, {
        inside: check ? check.insideCertifiedRange : null,
        points: check ? [...new Set([...check.alterations.filter((row) => row.outcome === 'BEYOND').map((row) => row.code), ...check.blocks.flatMap((row) => (row.kind === 'CERTIFICATE' && row.ref ? [row.ref] : []))])] : [],
      })
    }
    const seen = checked.get(key)!
    if (seen.inside === null) continue
    const before = out.get(unit.measurementProfileId!) ?? UNKNOWN
    if (seen.inside === false) out.set(unit.measurementProfileId!, { inside: false, points: [...new Set([...(before.inside === false ? before.points : []), ...seen.points])] })
    else if (before.inside === null) out.set(unit.measurementProfileId!, { inside: true, points: [] })
  }
  return out
}

/** The business week (Monday to Sunday) of `today`. */
export function weekOf(today: BusinessDate): { from: Date; to: Date } {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
  const monday = addDays(today, -((weekday + 6) % 7))
  return { from: businessDayStart(monday), to: businessDayStart(addDays(monday, 7)) }
}

/** The revisions (of the caller's customers) with a FITTING booked or done this business week. */
export async function fittingWeek(db: Reader, actor: Actor, today: BusinessDate): Promise<Set<string>> {
  const week = weekOf(today)
  const rows = await db.appointment.findMany({
    where: { AND: [scopeWhere(actor, SALES_MEASUREMENTS_VIEW, { party: 'partyId' }) as Prisma.AppointmentWhereInput, { kind: 'FITTING', status: { in: ['BOOKED', 'DONE'] }, measurementProfileId: { not: null }, startsAt: { gte: week.from, lt: week.to } }] },
    select: { measurementProfileId: true },
  })
  return new Set(rows.map((row) => row.measurementProfileId!))
}
