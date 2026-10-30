import { CalendarDayKind, CalendarScope, MasterStatus, ShiftSegmentKind } from '../src/generated/prisma/enums'
import type { Prisma } from '../src/generated/prisma/client'
import { seed as seedParties } from './parties'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The calendars seed (B-W2a-08's tables), per tenant of seed/_core.ts:
 *   - three tenant-wide shift patterns: one shift (08:00-17:00 with a lunch break), two shifts (06:00-14:00 and
 *     14:00-22:00, a short break in each) and a Saturday morning, Monday to Friday unless said;
 *   - each company's calendar: Monday to Friday, one shift, with Italy's national holidays of 2026 and 2027 (list `IT`)
 *     and, as an editable example only, a patron saint's day (a town's own holiday: the company sets its own);
 *   - each plant's calendar: the August shutdown and Christmas closure of 2026 (plant A1), Christmas Eve (plant B1);
 *   - line L1 of plant A1 on two shifts, with an extra Saturday morning;
 *   - the supplier SEED-S1 (parties seed P2): its August closure; and its earlier calendar, archived (the generated
 *     isolation tests copy a tenant's first calendar, which must not clash with its owner's active one).
 * Made-up data, written in the tenant's office scope as the API writes them; idempotent (stable ids, upserts, one
 * transaction: a pattern's breaks must lie inside its shifts at commit). The national holidays are the public list
 * (L. 260/1949 and its amendments, with 4 October again from 2026); check them before relying on them.
 */

const AT = new Date('2026-10-30T08:00:00.000Z')

type Day = { readonly date: string; readonly name: string }

/** Italy's national holidays (giorni festivi), as dated rows: Easter Monday moves (5 April 2026 and 28 March 2027 are Easter Sunday). */
const NATIONAL_HOLIDAYS_IT: readonly Day[] = [2026, 2027].flatMap((year) => [
  { date: `${year}-01-01`, name: 'Capodanno' },
  { date: `${year}-01-06`, name: 'Epifania' },
  { date: year === 2026 ? '2026-04-06' : '2027-03-29', name: "Lunedì dell'Angelo (Pasquetta)" },
  { date: `${year}-04-25`, name: 'Festa della Liberazione' },
  { date: `${year}-05-01`, name: 'Festa del Lavoro' },
  { date: `${year}-06-02`, name: 'Festa della Repubblica' },
  { date: `${year}-08-15`, name: 'Ferragosto (Assunzione)' },
  { date: `${year}-10-04`, name: "San Francesco d'Assisi, patrono d'Italia" },
  { date: `${year}-11-01`, name: 'Ognissanti' },
  { date: `${year}-12-08`, name: 'Immacolata Concezione' },
  { date: `${year}-12-25`, name: 'Natale' },
  { date: `${year}-12-26`, name: 'Santo Stefano' },
])

/** An example of a town's patron saint (24 June: San Giovanni Battista, as in Florence, Genoa and Turin). Edit it. */
const PATRON_SAINT_EXAMPLE: readonly Day[] = [2026, 2027].map((year) => ({ date: `${year}-06-24`, name: 'Santo patrono (esempio: il giorno della vostra città)' }))

const weekdays = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index)
const minutes = (time: string): number => {
  const [hours, mins] = time.split(':').map(Number) as [number, number]
  return hours * 60 + mins
}

interface PatternSpec {
  readonly code: string
  readonly name: string
  readonly description: string
  readonly days: readonly number[]
  readonly shifts: readonly { readonly label: string; readonly from: string; readonly to: string; readonly breaks: readonly { readonly label: string; readonly from: string; readonly to: string }[] }[]
}

const PATTERNS: readonly PatternSpec[] = [
  {
    code: '1T',
    name: 'One shift',
    description: '08:00-17:00 with a lunch break, Monday to Friday',
    days: weekdays(1, 5),
    shifts: [{ label: 'Day', from: '08:00', to: '17:00', breaks: [{ label: 'Lunch', from: '12:00', to: '13:00' }] }],
  },
  {
    code: '2T',
    name: 'Two shifts',
    description: '06:00-14:00 and 14:00-22:00, Monday to Friday',
    days: weekdays(1, 5),
    shifts: [
      { label: 'Morning', from: '06:00', to: '14:00', breaks: [{ label: 'Break', from: '10:00', to: '10:15' }] },
      { label: 'Afternoon', from: '14:00', to: '22:00', breaks: [{ label: 'Break', from: '18:00', to: '18:15' }] },
    ],
  },
  {
    code: 'SAT-AM',
    name: 'Saturday morning',
    description: '08:00-12:00 on Saturday',
    days: [6],
    shifts: [{ label: 'Morning', from: '08:00', to: '12:00', breaks: [] }],
  },
]

/** Weekdays (Monday to Friday) from one date to another, inclusive. */
function workingDates(from: string, to: string): string[] {
  const out: string[] = []
  for (let day = new Date(`${from}T00:00:00.000Z`); day <= new Date(`${to}T00:00:00.000Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) out.push(day.toISOString().slice(0, 10))
  }
  return out
}

export interface CalendarSeed {
  readonly patternIds: Readonly<Record<string, string>>
  readonly calendarIds: Readonly<Record<string, string>>
}

export async function seed(context: SeedContext): Promise<CalendarSeed> {
  const { db, namespace } = context
  // The supplier's calendar names its Party.
  await seedParties(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const company = { A: id('company:A'), B: id('company:B') }
  const site = { A1: id('site:A1'), B1: id('site:B1') }
  const supplier = id('party:P2')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }

  const patternIds = Object.fromEntries(PATTERNS.map((pattern) => [pattern.code, id(`calendar:pattern:${pattern.code}`)])) as Record<string, string>
  const calendarIds = {
    supplierOld: firstId('calendar:supplier:P2:2025'),
    companyA: id('calendar:company:A'),
    companyB: id('calendar:company:B'),
    siteA1: id('calendar:site:A1'),
    siteB1: id('calendar:site:B1'),
    lineA1: id('calendar:line:A1:L1'),
    supplier: id('calendar:supplier:P2'),
  }

  const calendars: (Prisma.WorkCalendarUncheckedCreateInput & { id: string })[] = [
    { id: calendarIds.supplierOld, scope: CalendarScope.SUPPLIER, companyId: company.A, partyId: supplier, name: 'Seed Leather Supplier (2025)', status: MasterStatus.ARCHIVED },
    { id: calendarIds.companyA, scope: CalendarScope.COMPANY, companyId: company.A, name: 'Seed Company A', shiftPatternId: patternIds['1T'] },
    { id: calendarIds.companyB, scope: CalendarScope.COMPANY, companyId: company.B, name: 'Seed Company B', shiftPatternId: patternIds['1T'] },
    { id: calendarIds.siteA1, scope: CalendarScope.SITE, companyId: company.A, siteId: site.A1, name: 'Seed plant A1' },
    { id: calendarIds.siteB1, scope: CalendarScope.SITE, companyId: company.B, siteId: site.B1, name: 'Seed plant B1' },
    { id: calendarIds.lineA1, scope: CalendarScope.LINE, companyId: company.A, siteId: site.A1, lineId: id('site:A1:line:L1'), name: 'Line 1 (A1)', shiftPatternId: patternIds['2T'] },
    { id: calendarIds.supplier, scope: CalendarScope.SUPPLIER, companyId: company.A, partyId: supplier, name: 'Seed Leather Supplier' },
  ]

  type DayRow = Prisma.CalendarDayUncheckedCreateInput & { id: string }
  const day = (calendar: string, date: string, kind: CalendarDayKind, name: string, extra: Partial<DayRow> = {}): DayRow => ({
    id: id(`calendar:day:${calendar}:${date}`),
    calendarId: calendar,
    date: new Date(`${date}T00:00:00.000Z`),
    kind,
    name,
    ...extra,
  })
  const days: DayRow[] = [
    ...[calendarIds.companyA, calendarIds.companyB].flatMap((calendar) => [
      ...NATIONAL_HOLIDAYS_IT.map((holiday) => day(calendar, holiday.date, CalendarDayKind.HOLIDAY, holiday.name, { holidaySet: 'IT' })),
      ...PATRON_SAINT_EXAMPLE.map((holiday) => day(calendar, holiday.date, CalendarDayKind.HOLIDAY, holiday.name, { note: 'An example: set the patron saint of your own town, or remove it.' })),
    ]),
    ...workingDates('2026-08-10', '2026-08-21').map((date) => day(calendarIds.siteA1, date, CalendarDayKind.CLOSURE, 'August shutdown')),
    ...['2026-12-24', ...workingDates('2026-12-28', '2026-12-31')].map((date) => day(calendarIds.siteA1, date, CalendarDayKind.CLOSURE, 'Christmas closure')),
    day(calendarIds.siteB1, '2026-12-24', CalendarDayKind.CLOSURE, 'Christmas Eve'),
    day(calendarIds.lineA1, '2026-11-07', CalendarDayKind.WORKING, 'Extra Saturday', { shiftPatternId: patternIds['SAT-AM'], note: 'Catch up the October orders.' }),
    ...workingDates('2026-08-03', '2026-08-28').map((date) => day(calendarIds.supplier, date, CalendarDayKind.CLOSURE, 'Supplier closed in August')),
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const pattern of PATTERNS) {
        const patternId = patternIds[pattern.code] as string
        const data = { companyId: null, code: pattern.code, name: pattern.name, description: pattern.description }
        await tx.shiftPattern.upsert({ where: { id: patternId }, create: { id: patternId, ...data, ...stamp }, update: data, select: { id: true } })
        for (const weekday of pattern.days) {
          for (const [index, shift] of pattern.shifts.entries()) {
            const segments = [
              { key: `shift:${index}`, kind: ShiftSegmentKind.SHIFT, label: shift.label, from: shift.from, to: shift.to },
              ...shift.breaks.map((pause, at) => ({ key: `break:${index}:${at}`, kind: ShiftSegmentKind.BREAK, label: pause.label, from: pause.from, to: pause.to })),
            ]
            for (const segment of segments) {
              const segmentId = id(`calendar:pattern:${pattern.code}:${weekday}:${segment.key}`)
              const row = { patternId, weekday, kind: segment.kind, label: segment.label, startMinute: minutes(segment.from), endMinute: minutes(segment.to) }
              await tx.shiftSegment.upsert({ where: { id: segmentId }, create: { id: segmentId, ...row, ...stamp }, update: row, select: { id: true } })
            }
          }
        }
      }
      for (const { id: calendarId, ...data } of calendars) {
        await tx.workCalendar.upsert({ where: { id: calendarId }, create: { id: calendarId, ...data, ...stamp }, update: { name: data.name, shiftPatternId: data.shiftPatternId ?? null }, select: { id: true } })
      }
      await tx.calendarDay.createMany({ data: days.map((row) => ({ ...row, ...stamp })), skipDuplicates: true })
    }),
  )
  return { patternIds, calendarIds }
}
