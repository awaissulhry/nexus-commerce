import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SHORT_REASON_LIST } from '@nexus/factory-domain/production/boards/targets'
import type { CommandTx } from '../../../core/command'
import type { ReportSite } from '../reports/daily'

/**
 * The rows the line boards read (B-W2b-50): lines and their sites, a line's hourly targets (andon.prisma LineTarget), the
 * downtime reasons a short hour is given with, and the line's handover notes (the team leader's words on the TV). Every
 * select names its columns; none names a worker (a target's `shortReasonById` is read by nobody here).
 */

export type Reader = FactoryClient | CommandTx

/** A BusinessDate as a `@db.Date` column, and back. */
export const dayColumn = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
export const isoDay = (date: Date): BusinessDate => date.toISOString().slice(0, 10)

const LINE_SELECT = { id: true, companyId: true, siteId: true, code: true, name: true, status: true } as const satisfies Prisma.LineSelect
export type LineRow = Prisma.LineGetPayload<{ select: typeof LINE_SELECT }>

export async function lineOf(db: Reader, lineId: string): Promise<LineRow | null> {
  return isUuid(lineId) ? db.line.findUnique({ where: { id: lineId }, select: LINE_SELECT }) : null
}

/** The ACTIVE lines of a site, by code. */
export async function activeLinesOf(db: Reader, siteId: string): Promise<LineRow[]> {
  return db.line.findMany({ where: { siteId, status: 'ACTIVE' }, select: LINE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
}

const SITE_SELECT = { id: true, companyId: true, code: true, name: true, timezone: true } as const satisfies Prisma.SiteSelect

export async function siteRow(db: Reader, siteId: string): Promise<ReportSite | null> {
  return isUuid(siteId) ? db.site.findUnique({ where: { id: siteId }, select: SITE_SELECT }) : null
}

export const siteView = (site: ReportSite) => ({ id: site.id, code: site.code, name: site.name, timeZone: site.timezone })

export const TARGET_SELECT = {
  id: true,
  siteId: true,
  lineId: true,
  workDate: true,
  hour: true,
  targetPieces: true,
  shortReasonCode: true,
  shortNote: true,
  shortReasonAt: true,
  version: true,
} as const satisfies Prisma.LineTargetSelect
export type TargetRow = Prisma.LineTargetGetPayload<{ select: typeof TARGET_SELECT }>

/** The targets of these lines on a day, by line then hour. */
export async function targetsOf(db: Reader, lineIds: readonly string[], day: BusinessDate): Promise<TargetRow[]> {
  if (lineIds.length === 0) return []
  return db.lineTarget.findMany({ where: { lineId: { in: [...lineIds] }, workDate: dayColumn(day) }, select: TARGET_SELECT, orderBy: [{ lineId: 'asc' }, { hour: 'asc' }] })
}

export async function targetRow(db: Reader, targetId: string): Promise<TargetRow | null> {
  return isUuid(targetId) ? db.lineTarget.findUnique({ where: { id: targetId }, select: TARGET_SELECT }) : null
}

/** One reason of the downtime list, as the boards show it. */
export interface ReasonRow {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Record<string, string>
  readonly icon: string | null
  readonly colour: string | null
  readonly needsDetail: boolean
  readonly active: boolean
  readonly sortOrder: number
}

const wordsOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

/** The tenant's downtime reasons (active and not: a reason given earlier still shows its words), by code. */
export async function downtimeReasons(db: Reader): Promise<Map<string, ReasonRow>> {
  const rows = await db.reasonCode.findMany({
    where: { list: SHORT_REASON_LIST },
    select: { code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, needsDetail: true, active: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  })
  return new Map(rows.map((row) => [row.code, { ...row, labelI18n: wordsOf(row.labelI18n) }]))
}

/** A reason's words (its code alone when the list no longer has it). */
export function reasonWordsOf(reasons: ReadonlyMap<string, ReasonRow>, code: string) {
  const row = reasons.get(code)
  return { code, labelIt: row?.labelIt ?? code, labelEn: row?.labelEn ?? code, labelI18n: row?.labelI18n ?? {}, icon: row?.icon ?? null, colour: row?.colour ?? null }
}

/** The line's handover notes of a day (who wrote them is not read). */
export async function notesOf(db: Reader, lineId: string, day: BusinessDate) {
  return db.handoverNote.findMany({ where: { lineId, shiftDate: dayColumn(day) }, select: { shiftLabel: true, topics: true, text: true, updatedAt: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })
}
