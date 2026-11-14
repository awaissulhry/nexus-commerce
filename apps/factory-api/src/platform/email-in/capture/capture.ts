import type { Prisma } from '@nexus/factory-db'
import { EMAIL_SEND } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as mailDepthEvents } from '@nexus/factory-domain/mail-depth/events'
import { captureAddressOf } from '@nexus/factory-domain/mail-depth/rules'
import { newReplyToken } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayManage } from '../team-inbox/inboxes'
import { badBody, mailRefusal, officeOf, receivingDomainOf, type Reader } from '../team-inbox/store'
import type { CaptureView } from './contract'

/**
 * A company's capture address (B-W2b-394; COL-021): `c-<token>@<the company's receiving domain>`, one live per company. Staff
 * forward a customer's or supplier's mail to it, or BCC it on their own; the worker matches it (./match.ts). Reading it to copy
 * is email.send over the company; making, replacing and turning it off, and naming the team inbox its unplaced mail lands in,
 * is email.inboxes.manage:
 *
 *   GET  /email/capture?companyId                         the live address (or none), the receiving domain
 *   POST /email/capture                                   a new address (replacing the live one, turned off in the same step)
 *   PUT  /email/capture/:captureAddressId                 its default team inbox (an ACTIVE one of the company, or none)
 *   POST /email/capture/:captureAddressId/turn-off        no mail is taken through it any more (the row is kept, frozen)
 *
 * The token is 26 random lower-case base32 characters, as a thread's reply token (unique everywhere: the database's index).
 */

const [, captureChanged] = mailDepthEvents

const CAPTURE_COLUMNS = { id: true, companyId: true, token: true, defaultTeamInboxId: true, revokedAt: true, createdAt: true, version: true } as const satisfies Prisma.CaptureAddressSelect
type CaptureRow = Prisma.CaptureAddressGetPayload<{ select: typeof CAPTURE_COLUMNS }>

async function captureView(db: Reader, row: CaptureRow): Promise<CaptureView> {
  const domain = await receivingDomainOf(db, row.companyId)
  const inbox = row.defaultTeamInboxId ? await db.teamInbox.findUnique({ where: { id: row.defaultTeamInboxId }, select: { id: true, name: true, active: true } }) : null
  return { id: row.id, companyId: row.companyId, address: domain ? captureAddressOf(row.token, domain) : null, defaultTeamInbox: inbox, createdAt: toUtcIso(row.createdAt), version: row.version }
}

/** An inbox a capture address may name: ACTIVE, of the same company. */
async function defaultInboxProblem(db: Reader | CommandTx, companyId: string, inboxId: string | null): Promise<void> {
  if (inboxId === null) return
  const inbox = await db.teamInbox.findUnique({ where: { id: inboxId }, select: { companyId: true, active: true } })
  if (!inbox || inbox.companyId !== companyId) badBody('defaultTeamInboxId', 'A team inbox of the same company.')
  if (!inbox.active) badBody('defaultTeamInboxId', 'This team inbox is switched off.')
}

/** GET /email/capture */
export async function getCapture(caller: CommandCaller, companyId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const manage = mayManage(actor, companyId)
  if (!manage && !can(actor, EMAIL_SEND, { companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    if (!(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const row = await db.captureAddress.findFirst({ where: { companyId, revokedAt: null }, select: CAPTURE_COLUMNS })
    return { capture: row ? await captureView(db, row) : null, receivingDomain: await receivingDomainOf(db, companyId), mayManage: manage }
  })
}

/** POST /email/capture */
export async function createCapture(caller: CommandCaller, body: { readonly companyId: string; readonly defaultTeamInboxId?: string | null | undefined; readonly replacing?: { readonly id: string; readonly version: number } | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!mayManage(actorOf(context), body.companyId)) throw new NotFoundError('Company not found.')
  await caller.withClient(async (db) => {
    if (!(await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    if ((await receivingDomainOf(db, body.companyId)) === null) throw new ConflictError('This company sends no mail yet: add its mail domain (Admin › Connections) before its capture address.')
    if (body.defaultTeamInboxId !== undefined) await defaultInboxProblem(db, body.companyId, body.defaultTeamInboxId)
  })
  const { result } = await command(caller, { name: 'emailIn.createCapture', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // One live address per company (the partial unique index): the live one is turned off first, in this step.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.capture', ${body.companyId}::uuid::text), 0))`
    const live = await tx.captureAddress.findFirst({ where: { companyId: body.companyId, revokedAt: null }, select: CAPTURE_COLUMNS })
    if (live && (!body.replacing || body.replacing.id !== live.id)) throw new ConflictError('This company has a capture address: replace it (send its id and version), or keep it.')
    if (!live && body.replacing) throw new ConflictError('The address to replace is not live any more: read the capture address again.')
    if (live && body.replacing && live.version !== body.replacing.version) throw new ConflictError('Someone changed this capture address meanwhile: read it again.')
    if (live) {
      await tx.captureAddress.update({ where: { id: live.id }, data: { revokedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'emailIn.turnOffCapture', recordType: 'CaptureAddress', recordId: live.id, companyId: body.companyId, before: { revokedAt: null }, after: { revokedAt: toUtcIso(now), replaced: true } })
    }
    const defaultTeamInboxId = body.defaultTeamInboxId !== undefined ? body.defaultTeamInboxId : (live?.defaultTeamInboxId ?? null)
    if (defaultTeamInboxId !== null) {
      const inbox = await tx.teamInbox.findUnique({ where: { id: defaultTeamInboxId }, select: { active: true } })
      if (!inbox?.active) badBody('defaultTeamInboxId', 'The team inbox it named is switched off: name another, or none.')
    }
    const id = newId()
    const row = await tx.captureAddress.create({ data: { id, companyId: body.companyId, token: newReplyToken(), defaultTeamInboxId, createdAt: now, updatedAt: now, createdById: context.actorId }, select: CAPTURE_COLUMNS })
    // Never the token in the audit log: whoever reads the log is not given the address.
    tools.audit({ recordType: 'CaptureAddress', recordId: id, companyId: body.companyId, after: { defaultTeamInboxId, replaces: live?.id ?? null } })
    tools.emit(eventFor(captureChanged, { subject: id, companyId: body.companyId, payload: { captureAddressId: id, change: live ? 'REPLACED' : 'CREATED' } }))
    return { capture: await captureView(tx, row) }
  }).catch(mailRefusal)
  return result
}

async function liveCapture(caller: CommandCaller, captureAddressId: string): Promise<CaptureRow> {
  const context = officeOf(caller)
  const row = isUuid(captureAddressId) ? await caller.withClient((db) => db.captureAddress.findUnique({ where: { id: captureAddressId }, select: CAPTURE_COLUMNS })) : null
  if (!row || !mayManage(actorOf(context), row.companyId)) throw new NotFoundError('Capture address not found.')
  if (row.revokedAt !== null) throw new ConflictError('This capture address is turned off; it changes no more.')
  return row
}

/** PUT /email/capture/:captureAddressId */
export async function updateCapture(caller: CommandCaller, captureAddressId: string, body: { readonly version: number; readonly defaultTeamInboxId: string | null }, idempotencyKey?: string) {
  const row = await liveCapture(caller, captureAddressId)
  await caller.withClient((db) => defaultInboxProblem(db, row.companyId, body.defaultTeamInboxId))
  if (row.defaultTeamInboxId === body.defaultTeamInboxId) throw new ConflictError('The capture address names that team inbox already.')
  const { result } = await command(caller, { name: 'emailIn.updateCapture', idempotencyKey, input: { captureAddressId, ...body }, record: { type: 'CaptureAddress', id: captureAddressId, expectedVersion: body.version } }, async (tools) => {
    const updated = await tools.tx.captureAddress.update({ where: { id: captureAddressId }, data: { defaultTeamInboxId: body.defaultTeamInboxId, updatedAt: tools.now }, select: CAPTURE_COLUMNS })
    tools.audit({ recordType: 'CaptureAddress', recordId: captureAddressId, companyId: row.companyId, before: { defaultTeamInboxId: row.defaultTeamInboxId }, after: { defaultTeamInboxId: body.defaultTeamInboxId } })
    tools.emit(eventFor(captureChanged, { subject: captureAddressId, companyId: row.companyId, payload: { captureAddressId, change: 'DEFAULT_CHANGED' } }))
    return { capture: await captureView(tools.tx, updated) }
  }).catch(mailRefusal)
  return result
}

/** POST /email/capture/:captureAddressId/turn-off */
export async function turnOffCapture(caller: CommandCaller, captureAddressId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const row = await liveCapture(caller, captureAddressId)
  const { result } = await command(caller, { name: 'emailIn.turnOffCapture', idempotencyKey, input: { captureAddressId, ...body }, record: { type: 'CaptureAddress', id: captureAddressId, expectedVersion: body.version } }, async (tools) => {
    const updated = await tools.tx.captureAddress.update({ where: { id: captureAddressId }, data: { revokedAt: tools.now, updatedAt: tools.now }, select: CAPTURE_COLUMNS })
    tools.audit({ recordType: 'CaptureAddress', recordId: captureAddressId, companyId: row.companyId, before: { revokedAt: null }, after: { revokedAt: toUtcIso(tools.now) } })
    tools.emit(eventFor(captureChanged, { subject: captureAddressId, companyId: row.companyId, payload: { captureAddressId, change: 'TURNED_OFF' } }))
    return { capture: await captureView(tools.tx, updated) }
  }).catch(mailRefusal)
  return result
}
