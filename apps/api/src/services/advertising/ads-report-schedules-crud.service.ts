/**
 * RPT.6 — schedule CRUD + delivery log reads.
 *
 * Kept apart from ads-report-schedules.service (which builds and sends) so the
 * cron path imports only what it needs.
 */
import prisma from '../../db.js'
import { WINDOW_MODES, type WindowMode } from './ads-report-schedules.service.js'

const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
const FORMATS = ['csv', 'xlsx'] as const
const MODES = WINDOW_MODES.map((m) => m.value)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface ScheduleInput {
  savedReportId: string
  recipients: string
  format?: string
  windowMode?: string
  frequency?: string
  hourLocal?: number
  dayOfWeek?: number | null
  dayOfMonth?: number | null
  isActive?: boolean
}

function validate(input: Partial<ScheduleInput>, partial = false) {
  const out: Record<string, unknown> = {}
  if (input.recipients !== undefined) {
    const list = String(input.recipients).split(',').map((s) => s.trim()).filter(Boolean)
    if (!list.length) throw new Error('At least one recipient is required')
    const bad = list.filter((e) => !EMAIL_RE.test(e))
    if (bad.length) throw new Error(`Not a valid email address: ${bad.join(', ')}`)
    out.recipients = list.join(', ')
  } else if (!partial) throw new Error('At least one recipient is required')

  if (input.format !== undefined) {
    if (!FORMATS.includes(input.format as never)) throw new Error(`format must be one of ${FORMATS.join(', ')}`)
    out.format = input.format
  }
  if (input.windowMode !== undefined) {
    if (!MODES.includes(input.windowMode as WindowMode)) throw new Error(`windowMode must be one of ${MODES.join(', ')}`)
    out.windowMode = input.windowMode
  }
  if (input.frequency !== undefined) {
    if (!FREQUENCIES.includes(input.frequency as never)) throw new Error(`frequency must be one of ${FREQUENCIES.join(', ')}`)
    out.frequency = input.frequency
  } else if (!partial) throw new Error('frequency is required')

  if (input.hourLocal !== undefined) {
    const h = Number(input.hourLocal)
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error('hourLocal must be 0-23')
    out.hourLocal = h
  }
  if (input.dayOfWeek !== undefined && input.dayOfWeek !== null) {
    const d = Number(input.dayOfWeek)
    if (!Number.isInteger(d) || d < 1 || d > 7) throw new Error('dayOfWeek must be 1 (Mon) to 7 (Sun)')
    out.dayOfWeek = d
  }
  if (input.dayOfMonth !== undefined && input.dayOfMonth !== null) {
    const d = Number(input.dayOfMonth)
    // Capped at 28 so a monthly schedule can never skip February entirely.
    if (!Number.isInteger(d) || d < 1 || d > 28) throw new Error('dayOfMonth must be 1-28')
    out.dayOfMonth = d
  }
  if (input.isActive !== undefined) out.isActive = !!input.isActive
  return out
}

export async function listSchedules() {
  const rows = await prisma.reportSchedule.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: {
      savedReport: { select: { id: true, name: true, reportId: true } },
      deliveries: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })
  return rows.map((s) => ({
    id: s.id,
    savedReportId: s.savedReportId,
    savedReportName: s.savedReport.name,
    reportId: s.savedReport.reportId,
    recipients: s.recipients,
    format: s.format,
    windowMode: s.windowMode,
    frequency: s.frequency,
    hourLocal: s.hourLocal,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    isActive: s.isActive,
    lastSentAt: s.lastSentAt?.toISOString() ?? null,
    lastStatus: s.lastStatus,
    lastDelivery: s.deliveries[0]
      ? {
          status: s.deliveries[0].status,
          rows: s.deliveries[0].rows,
          staleNote: s.deliveries[0].staleNote,
          error: s.deliveries[0].error,
          createdAt: s.deliveries[0].createdAt.toISOString(),
        }
      : null,
  }))
}

export async function listDeliveries(scheduleId: string) {
  const rows = await prisma.reportDelivery.findMany({
    where: { scheduleId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return rows.map((d) => ({
    id: d.id,
    status: d.status,
    rows: d.rows,
    format: d.format,
    recipients: d.recipients,
    fileName: d.fileName,
    fileBytes: d.fileBytes,
    windowFrom: d.windowFrom,
    windowTo: d.windowTo,
    freshness: d.freshness,
    staleNote: d.staleNote,
    error: d.error,
    durationMs: d.durationMs,
    createdAt: d.createdAt.toISOString(),
  }))
}

export async function createSchedule(input: ScheduleInput) {
  if (!input?.savedReportId) throw new Error('savedReportId is required')
  const saved = await prisma.savedReport.findUnique({ where: { id: input.savedReportId } })
  if (!saved || saved.isArchived) throw new Error('Saved report not found')
  const data = validate(input)
  return prisma.reportSchedule.create({
    data: { savedReportId: input.savedReportId, ...(data as object) } as never,
  })
}

export async function updateSchedule(id: string, input: Partial<ScheduleInput>) {
  const existing = await prisma.reportSchedule.findUnique({ where: { id } })
  if (!existing) throw new Error('Schedule not found')
  return prisma.reportSchedule.update({ where: { id }, data: validate(input, true) as never })
}

export async function deleteSchedule(id: string) {
  await prisma.reportSchedule.delete({ where: { id } })
}
