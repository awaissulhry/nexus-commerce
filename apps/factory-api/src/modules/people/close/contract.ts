import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CLOSE_HOLDS, CLOSE_ITEMS, CLOSE_NOTES, CORRECTION_KINDS, CORRECTION_RULES } from '@nexus/factory-domain/people/close/rules'

/**
 * The month close, the LUL calendar and corrections (B-W2b-48; MES-231; design people.attendance "Month close", "Close October
 * 2026", "Correct a closed day", new tab "LUL calendar (PDF)"). Office only, no money. A list never names a person nor
 * carries one person's minutes (Owner answer W1); one person's corrected day opens one record.
 */

const month = z.string().regex(/^\d{4}-\d{2}$/)
const count = z.number().int().min(0)
const minutes = z.number().int().min(0).max(CORRECTION_RULES.minutesMax)

export const monthQuery = input({ companyId: id(), month: month.optional() })
export type MonthQuery = z.infer<typeof monthQuery>

const panel = output({
  companyId: id(),
  month,
  label: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  /** Null until the month has a close row. */
  closeId: id().nullable(),
  monthOver: z.boolean(),
  /** "LUL due by 30 November" (the end of the following month; D.L. 112/2008 art. 39 c.3). */
  due: output({ by: businessDate(), daysLeft: z.number().int(), words: z.string() }),
  checklist: z.array(output({ item: z.enum(CLOSE_ITEMS), left: count, done: z.boolean(), words: z.string() })),
  /** What the person should know: never a hold. */
  notes: z.array(output({ note: z.enum(CLOSE_NOTES), words: z.string() })),
  holds: z.array(output({ code: z.enum(CLOSE_HOLDS), words: z.string() })),
  days: count,
  sites: z.array(output({ siteId: id(), code: z.string(), name: z.string(), gateOpen: z.boolean() })),
  /** Corrections made after the close (the payroll's correction export reads them). */
  corrections: count,
  /** The DocumentSeal, after the close. */
  seal: output({ closedAt: instant(), closedBy: z.string().nullable(), sealed: z.boolean(), sha256: z.string().nullable(), fileId: id().nullable() }).nullable(),
  confirm: output({ phrases: output({ en: z.string(), it: z.string() }), consequences: z.string() }),
  /** What the labour consultant must confirm of the generic calendar (GATE-PAYROLL). */
  toConfirm: z.array(z.string()),
  actions: output({ close: z.boolean(), seal: z.boolean(), openLul: z.boolean() }),
})

export const monthPanelContract = defineContract({ querystring: monthQuery, response: { 200: panel } })

export const monthsQuery = input({ companyId: id(), limit: z.coerce.number().int().min(1).max(120).optional() })
export type MonthsQuery = z.infer<typeof monthsQuery>

export const monthsContract = defineContract({
  querystring: monthsQuery,
  response: { 200: output({ companyId: id(), months: z.array(output({ closeId: id(), month, label: z.string(), state: z.enum(['OPEN', 'CLOSED']), closedAt: instant().nullable(), sealed: z.boolean() })) }) },
})

const closeBody = input({ companyId: id(), month, phrase: z.string().max(80) })
export type CloseBody = z.infer<typeof closeBody>

export const closeMonthContract = defineContract({ body: closeBody, response: { 200: panel } })

const closeParams = input({ closeId: id() })

export const sealContract = defineContract({ params: closeParams, response: { 200: panel } })

const openLulBody = input({ format: z.enum(['PDF', 'CSV']).optional() })
export type OpenLulBody = z.infer<typeof openLulBody>

export const openLulContract = defineContract({
  params: closeParams,
  body: openLulBody,
  response: {
    200: output({
      closeId: id(),
      format: z.enum(['PDF', 'CSV']),
      fileName: z.string(),
      sha256: z.string(),
      download: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})

const cellsOut = output({
  presentMinutes: count,
  ordinaryMinutes: count,
  nightMinutes: count,
  holidayMinutes: count,
  overtimeDayMinutes: count,
  overtimeNightMinutes: count,
  overtimeHolidayMinutes: count,
  absences: z.array(output({ codeId: id(), code: z.string(), minutes: count })),
})

const dayRecord = output({
  dayId: id(),
  date: businessDate(),
  siteId: id(),
  status: z.string(),
  closeId: id().nullable(),
  person: output({ employeeId: id(), name: z.string(), displayName: z.string().nullable(), employeeCode: z.string().nullable() }),
  /** What the sealed calendar says. */
  closedFigures: cellsOut,
  /** Each figure replaced by its latest correction. */
  figuresNow: cellsOut,
  differs: z.boolean(),
  corrections: z.array(output({ id: id(), kind: z.enum(CORRECTION_KINDS), absenceCode: z.string().nullable(), minutesBefore: count, minutesAfter: count, reason: z.string(), at: instant(), by: z.string().nullable() })),
  actions: output({ correct: z.boolean() }),
  words: z.array(z.string()),
})

const dayParams = input({ dayId: id() })

export const dayCorrectionsContract = defineContract({ params: dayParams, response: { 200: dayRecord } })

const correctBody = input({
  kind: z.enum(CORRECTION_KINDS),
  /** ABSENCE: the code whose minutes change. */
  absenceCodeId: id().nullable().optional(),
  /** The figure the person read: another correction meanwhile is a 409. */
  minutesBefore: minutes,
  minutesAfter: z.number().int(),
  reason: z.string().max(2000),
})
export type CorrectBody = z.infer<typeof correctBody>

export const correctDayContract = defineContract({ params: dayParams, body: correctBody, response: { 201: dayRecord } })

export const monthCorrectionsQuery = input({ cursor: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).optional() })
export type MonthCorrectionsQuery = z.infer<typeof monthCorrectionsQuery>

export const monthCorrectionsContract = defineContract({
  params: closeParams,
  querystring: monthCorrectionsQuery,
  response: {
    200: output({
      closeId: id(),
      month,
      corrections: z.array(output({ id: id(), dayId: id(), date: businessDate(), siteId: id(), kind: z.enum(CORRECTION_KINDS), at: instant() })),
      nextCursor: z.string().nullable(),
      words: z.array(z.string()),
    }),
  },
})
