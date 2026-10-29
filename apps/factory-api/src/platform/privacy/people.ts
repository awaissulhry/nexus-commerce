import type { FastifyRequest } from 'fastify'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ACKNOWLEDGE_MEANS, type NoticeKind } from '@nexus/factory-domain/privacy/notices'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { SYSTEM_ACTOR_ID, type OfficeContext, type RequestContext } from '../../core/context'
import { officeSessionOf } from '../auth/sessions/authenticator'
import { systemContext } from '../outbox/system'
import { floorOf, officeOf } from './access'
import { noticeInForce, noticeTextFor, workerNoticeGate, type InForce } from './read'

/**
 * The notices people read and acknowledge themselves (B-W1-36; A2 SCR-025 floor.notice, shell.signin; GAP-005):
 *
 *   floor    GET  /privacy/floor/notice               the worker notice in force at the device's company, in the worker's
 *                                                     language (else Italian, else English), and the gate (due, scan
 *                                                     tiles held). floor.work over the device's site.
 *            POST /privacy/floor/notice/acknowledge   the worker acknowledges the version in force: its id, the language
 *                                                     shown and its fingerprint, the device's time (Idempotency-Key: the
 *                                                     tablet's queue). An older version → 409 (the new one opens).
 *   office   GET  /privacy/staff-notice               the staff notice in force of the screen's company, once per version
 *            POST /privacy/staff-notice/acknowledge   a soft gate: shown, acknowledged, recorded (any signed-in person).
 *   public   GET  /privacy/public/:companyId          the company's public notice in force, for anyone (link pages, e-mail
 *                                                     footers, the sign-in page): `/privacy/<company id>`.
 * Acknowledging the same version again changes nothing. No answer names another person.
 */

const shown = (notice: InForce, kind: NoticeKind, text: Awaited<ReturnType<typeof noticeTextFor>>) =>
  text.text
    ? {
        id: notice.id,
        kind,
        label: notice.label,
        versionNo: notice.versionNo,
        publishedAt: notice.publishedAt ? toUtcIso(notice.publishedAt) : null,
        locale: text.text.locale,
        body: text.text.body,
        sha256: text.text.sha256,
        languages: text.languages,
        languageReady: text.languageReady,
      }
    : null

// --- the floor ------------------------------------------------------------------------------------------------------------

async function siteCompany(db: Pick<CommandTx, 'site'>, siteId: string): Promise<string> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { companyId: true } })
  if (!site) throw new NotFoundError('Site not found.')
  return site.companyId
}

/** floor.work: the worker notice in force at the device's company, in the worker's language, and the gate. */
export async function floorNotice(caller: CommandCaller, query: { locale?: string | undefined }) {
  const context = floorOf(caller)
  return caller.withClient(async (client) => {
    const companyId = await siteCompany(client, context.siteId)
    const worker = await client.worker.findUnique({ where: { id: context.actorId }, select: { locale: true } })
    const inForce = await noticeInForce(client, companyId, 'WORKER_FLOOR')
    const notice = inForce ? shown(inForce, 'WORKER_FLOOR', await noticeTextFor(client, inForce.id, query.locale ?? worker?.locale)) : null
    return { notice, gate: await workerNoticeGate(client, context.siteId, context.actorId), means: ACKNOWLEDGE_MEANS }
  })
}

export interface AckBody {
  readonly noticeId: string
  readonly locale: string
  readonly sha256: string
  readonly deviceTime?: string | undefined
}

/** The version in force and the fingerprint of the language shown, or a 409 that says what to do. */
async function checkShown(db: Pick<CommandTx, 'privacyNotice' | 'privacyNoticeText'>, companyId: string, kind: NoticeKind, body: AckBody): Promise<InForce> {
  const inForce = await noticeInForce(db, companyId, kind)
  if (!inForce) throw new ConflictError('No notice is in force to acknowledge.')
  if (inForce.id !== body.noticeId) throw new ConflictError(`A newer version (${inForce.label}) is in force: read it first.`)
  const text = await db.privacyNoticeText.findFirst({ where: { noticeId: inForce.id, locale: body.locale }, select: { sha256: true } })
  if (!text || text.sha256 !== body.sha256) throw new ConflictError(`The text shown is not version ${inForce.label} in that language: reload it and read it again.`)
  return inForce
}

/** floor.work: the signed-in worker acknowledges the worker notice in force on this device. */
export async function acknowledgeFloorNotice(caller: CommandCaller, body: AckBody, idempotencyKey?: string) {
  const context = floorOf(caller)
  const deviceTime = body.deviceTime ? new Date(body.deviceTime) : undefined
  const { result } = await command(caller, { name: 'privacy.acknowledgeWorkerNotice', idempotencyKey, input: body, ...(deviceTime ? { deviceTime } : {}) }, async (tools) => {
    const companyId = await siteCompany(tools.tx, context.siteId)
    const inForce = await checkShown(tools.tx, companyId, 'WORKER_FLOOR', body)
    const existing = await tools.tx.workerNoticeAck.findFirst({ where: { workerId: context.actorId, noticeId: inForce.id }, select: { id: true } })
    let changed = false
    if (existing) {
      tools.audit({ recordType: 'WorkerNoticeAck', recordId: existing.id, companyId, after: { unchanged: true } })
    } else {
      const id = newId()
      await tools.tx.workerNoticeAck.create({
        data: {
          id,
          siteId: context.siteId,
          workerId: context.actorId,
          noticeId: inForce.id,
          noticeVersion: inForce.label,
          locale: body.locale,
          noticeSha256: body.sha256,
          channel: 'DEVICE',
          deviceId: context.deviceId,
          deviceTime: deviceTime ?? null,
          serverTime: tools.now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
      tools.audit({ recordType: 'WorkerNoticeAck', recordId: id, companyId, after: { noticeId: inForce.id, label: inForce.label, locale: body.locale, sha256: body.sha256, channel: 'DEVICE' } })
      tools.emit({ type: 'privacy.notice_acknowledged', subject: inForce.id, companyId, payload: { noticeId: inForce.id, kind: 'WORKER_FLOOR', channel: 'DEVICE' } })
      changed = true
    }
    return { acknowledged: true as const, changed, gate: await workerNoticeGate(tools.tx, context.siteId, context.actorId) }
  })
  return result
}

// --- the office ------------------------------------------------------------------------------------------------------------

/** Any signed-in office person: the staff notice in force of the screen's company, in their language, and whether done. */
export async function staffNotice(request: FastifyRequest, query: { locale?: string | undefined }) {
  const context = officeOf(request)
  const companyId = context.companyId ?? null
  if (!companyId) return { companyId: null, notice: null, acknowledged: false, means: ACKNOWLEDGE_MEANS }
  return request.withClient(async (client) => {
    const inForce = await noticeInForce(client, companyId, 'OFFICE_STAFF')
    if (!inForce) return { companyId, notice: null, acknowledged: false, means: ACKNOWLEDGE_MEANS }
    const person = await client.user.findUnique({ where: { id: context.actorId }, select: { locale: true } })
    const notice = shown(inForce, 'OFFICE_STAFF', await noticeTextFor(client, inForce.id, query.locale ?? person?.locale))
    const ack = await client.staffNoticeAck.findFirst({ where: { companyId, noticeId: inForce.id, userId: context.actorId }, select: { id: true } })
    return { companyId, notice, acknowledged: ack !== null, means: ACKNOWLEDGE_MEANS }
  })
}

/** Any signed-in office person acknowledges their company's staff notice in force (once per version). */
export async function acknowledgeStaffNotice(request: FastifyRequest, body: Omit<AckBody, 'deviceTime'>, idempotencyKey?: string) {
  const context: OfficeContext = officeOf(request)
  const companyId = context.companyId
  if (!companyId) throw new ConflictError('Pick the company you work in first.')
  const sessionId = sessionIdOf(request)
  const { result } = await command(request, { name: 'privacy.acknowledgeStaffNotice', idempotencyKey, input: body }, async (tools) => {
    const inForce = await checkShown(tools.tx, companyId, 'OFFICE_STAFF', { ...body })
    const existing = await tools.tx.staffNoticeAck.findFirst({ where: { companyId, noticeId: inForce.id, userId: context.actorId }, select: { id: true } })
    if (existing) {
      tools.audit({ recordType: 'StaffNoticeAck', recordId: existing.id, companyId, after: { unchanged: true } })
      return { acknowledged: true as const, changed: false }
    }
    const id = newId()
    await tools.tx.staffNoticeAck.create({
      data: { id, companyId, noticeId: inForce.id, userId: context.actorId, noticeVersion: inForce.label, locale: body.locale, noticeSha256: body.sha256, sessionId, serverTime: tools.now, createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({ recordType: 'StaffNoticeAck', recordId: id, companyId, after: { noticeId: inForce.id, label: inForce.label, locale: body.locale, sha256: body.sha256 } })
    tools.emit({ type: 'privacy.notice_acknowledged', subject: inForce.id, companyId, payload: { noticeId: inForce.id, kind: 'OFFICE_STAFF', channel: 'OFFICE' } })
    return { acknowledged: true as const, changed: true }
  })
  return result
}

/** The office session's id (a test session has none). */
function sessionIdOf(request: FastifyRequest): string | null {
  try {
    return officeSessionOf(request).id
  } catch {
    return null
  }
}

// --- anyone -----------------------------------------------------------------------------------------------------------------

/** A view of the request in another context (the platform's, a tenant's system). */
function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

/**
 * The public notice in force of an ACTIVE company, for anyone (GDPR arts. 13 and 14; GAP-005). The address names the
 * company only, so the tenant is found as the worker finds it: the platform scope lists the ACTIVE tenants, then each
 * tenant is read in its own system context (row-level security stays forced) until the company is found. One answer
 * for every miss: unknown company, inactive company or tenant, nothing published.
 */
export async function publicNotice(request: FastifyRequest, companyId: string, query: { locale?: string | undefined }) {
  const missing = new NotFoundError('No privacy notice is published at this address.')
  if (!isUuid(companyId)) throw missing
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId: String(request.id) })
  const tenants = await platform.withClient(async (client) => activeTenantsIn(client))
  for (const tenantId of tenants) {
    const system = asContext(request, systemContext(tenantId, String(request.id)))
    const found = await system.withClient(async (client) => {
      const company = await client.company.findFirst({ where: { id: companyId, status: 'ACTIVE' }, select: { id: true, legalName: true, tradeName: true } })
      if (!company) return null
      const inForce = await noticeInForce(client, company.id, 'PRIVACY_PUBLIC')
      const notice = inForce ? shown(inForce, 'PRIVACY_PUBLIC', await noticeTextFor(client, inForce.id, query.locale)) : null
      return { company: { id: company.id, name: company.tradeName ?? company.legalName }, notice }
    })
    if (found) {
      if (!found.notice) throw missing
      return { company: found.company, notice: found.notice }
    }
  }
  throw missing
}

/** The ACTIVE tenants, as the worker lists them (outbox/system.ts activeTenants; platform scope: the Tenant table only). */
async function activeTenantsIn(client: Pick<CommandTx, 'tenant'>): Promise<string[]> {
  const rows = await client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })
  return rows.map((row) => row.id)
}
