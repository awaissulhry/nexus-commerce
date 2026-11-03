import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_ORGANISATION_MANAGE, SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { filingRefusal, type RlsNoticeStatus } from '@nexus/factory-domain/safety/organisation/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, assertMayAt, assertMayWriteAt, assertVersion, dateOf, dayOf, officeOf, refuse, todayOf } from './access'
import { NOTICE_SELECT, noticeViews, type NoticeRow } from './store'

/**
 * The RLS notice to INAIL (B-W2b-120; QHS-226; D.Lgs. 81/2008 art. 18 c.1 aa; design plant.calendar panel RLS notice to
 * INAIL, pop-up Record RLS notice). The notice is filed by hand on the INAIL portal (no API: the plan's "manual send");
 * Nexus records it. Office only, safety.organisation.manage over the RLS appointment's company and site:
 *
 *   POST /safety/rls-notices/:id/file     filed on a day (today or before, not before the RLS's first day) with INAIL's
 *                                         reference; the receipt is a file of the notice (generic files, record type RlsNotice)
 *   POST /safety/rls-notices/:id/due      the due day the safety consultant confirmed (the plan gives no number of days)
 *   POST /safety/rls-notices/:id/cancel   not needed after all (the RLS was not confirmed), with the reason
 */

const MANAGE_WORDS = 'RLS notices of this company are kept by a role that keeps the safety organisation (safety.organisation.manage).'

async function writable(caller: CommandCaller, noticeId: string): Promise<NoticeRow> {
  const context = officeOf(caller)
  const row = isUuid(noticeId) ? await caller.withClient((client) => client.rlsNotice.findUnique({ where: { id: noticeId }, select: NOTICE_SELECT })) : null
  if (!row) throw new NotFoundError('RLS notice not found.')
  const place = { companyId: row.companyId, siteId: row.appointment.siteId }
  assertMayAt(context, SAFETY_VIEW, place, 'RLS notice')
  assertMayWriteAt(context, SAFETY_ORGANISATION_MANAGE, place, MANAGE_WORDS)
  return row
}

async function locked(tools: CommandTools, noticeId: string, version: number): Promise<NoticeRow> {
  await tools.tx.$queryRaw`SELECT "id" FROM "RlsNotice" WHERE "id" = ${noticeId}::uuid FOR UPDATE`
  const row = (await tools.tx.rlsNotice.findUnique({ where: { id: noticeId }, select: NOTICE_SELECT }))!
  assertVersion('RLS notice', row.version, version)
  return row
}

const pendingOnly = (row: NoticeRow): void => {
  if (row.status !== 'PENDING') refuse('NOTICE_NOT_PENDING', `This notice is ${row.status === 'FILED' ? 'filed' : 'cancelled'} already.`)
}

async function answer(tools: CommandTools, noticeId: string) {
  const row = (await tools.tx.rlsNotice.findUnique({ where: { id: noticeId }, select: NOTICE_SELECT }))!
  return { notice: (await noticeViews(tools.tx, tools.context as OfficeContext, [row]))[0]! }
}

/** POST /safety/rls-notices/:noticeId/file. */
export async function fileNotice(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly filedOn: BusinessDate; readonly reference: string; readonly note?: string | undefined }, idempotencyKey?: string) {
  await writable(caller, noticeId)
  const { result } = await command(caller, { name: 'safety.fileRlsNotice', idempotencyKey, input: { noticeId, ...body } }, async (tools) => {
    const row = await locked(tools, noticeId, body.version)
    const refusal = filingRefusal({ status: row.status as RlsNoticeStatus, filedOn: body.filedOn, appointedFrom: dayOf(row.appointment.fromDate), today: todayOf(tools.now) })
    if (refusal) refuse(refusal.code, refusal.message, refusal.field)
    const reference = body.reference.trim()
    await tools.tx.rlsNotice.update({
      where: { id: noticeId },
      data: { status: 'FILED', filedOn: dateOf(body.filedOn), reference, filedById: actorIdOf(tools.context), ...(body.note?.trim() ? { note: body.note.trim() } : {}), version: { increment: 1 }, updatedAt: tools.now },
      select: { id: true },
    })
    tools.audit({ action: 'safety.fileRlsNotice', recordType: 'RlsNotice', recordId: noticeId, companyId: row.companyId, siteId: row.appointment.siteId, before: { status: row.status }, after: { status: 'FILED', filedOn: body.filedOn, reference } })
    tools.emit({ type: 'rls_notice.changed', subject: noticeId, companyId: row.companyId, siteId: row.appointment.siteId, payload: { noticeId, appointmentId: row.appointmentId, change: 'FILED' } })
    return answer(tools, noticeId)
  })
  return result
}

/** POST /safety/rls-notices/:noticeId/due. */
export async function setNoticeDue(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly dueOn: BusinessDate }, idempotencyKey?: string) {
  await writable(caller, noticeId)
  const { result } = await command(caller, { name: 'safety.setRlsNoticeDue', idempotencyKey, input: { noticeId, ...body } }, async (tools) => {
    const row = await locked(tools, noticeId, body.version)
    pendingOnly(row)
    await tools.tx.rlsNotice.update({ where: { id: noticeId }, data: { dueOn: dateOf(body.dueOn), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.setRlsNoticeDue', recordType: 'RlsNotice', recordId: noticeId, companyId: row.companyId, siteId: row.appointment.siteId, before: { dueOn: dayOf(row.dueOn) }, after: { dueOn: body.dueOn } })
    tools.emit({ type: 'rls_notice.changed', subject: noticeId, companyId: row.companyId, siteId: row.appointment.siteId, payload: { noticeId, appointmentId: row.appointmentId, change: 'DUE_SET' } })
    return answer(tools, noticeId)
  })
  return result
}

/** POST /safety/rls-notices/:noticeId/cancel. */
export async function cancelNotice(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  await writable(caller, noticeId)
  const { result } = await command(caller, { name: 'safety.cancelRlsNotice', idempotencyKey, input: { noticeId, ...body } }, async (tools) => {
    const row = await locked(tools, noticeId, body.version)
    pendingOnly(row)
    await tools.tx.rlsNotice.update({ where: { id: noticeId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason.trim(), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.cancelRlsNotice', recordType: 'RlsNotice', recordId: noticeId, companyId: row.companyId, siteId: row.appointment.siteId, before: { status: row.status }, after: { status: 'CANCELLED' }, reason: body.reason })
    tools.emit({ type: 'rls_notice.changed', subject: noticeId, companyId: row.companyId, siteId: row.appointment.siteId, payload: { noticeId, appointmentId: row.appointmentId, change: 'CANCELLED' } })
    return answer(tools, noticeId)
  })
  return result
}
