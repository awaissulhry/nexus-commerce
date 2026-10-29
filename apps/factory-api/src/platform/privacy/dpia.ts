import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRIVACY_MANAGE, PRIVACY_VIEW } from '@nexus/factory-domain/privacy/permissions'
import { DEFAULT_DPIA_SCOPE, dpiaScopeProblems, dpiaStoreProblems } from '@nexus/factory-domain/privacy/records'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import type { OfficeContext } from '../../core/context'
import { retainFilesInCommand } from '../files/files'
import { assertMay, companyFor, dateOf, dayOf, lockPrivacy, officeOf, refuse } from './access'

/**
 * A company's DPIA (B-W1-36; GDPR art. 35; GAP-004, MES-282; A2 SCR-086 "DPIA: Draft · Signed · Stored; the floor gate
 * opens when stored"): privacy.view to read, privacy.manage to write, over the company.
 *
 *   draft   one DRAFT at a time, numbered next, with its scope (default: the floor's badge sign-ins and scans, and office
 *           staff data); its signed PDF is uploaded on it (files.ts).
 *   store   a fresh code (step-up), then ONE command: the stored one (if any) is superseded, this one STORED with who
 *           signed it, the day and the review day; its PDF kept ten years. The floor's gate reads it (read.ts
 *           floorPrivacyReady). The …_privacy_guards triggers hold the same for every login.
 */

export const DPIA_FILE_RETENTION_YEARS = 10

export const DPIA_SELECT = {
  id: true,
  companyId: true,
  versionNo: true,
  scope: true,
  status: true,
  fileId: true,
  fileSha256: true,
  signedByName: true,
  signedOn: true,
  reviewDueOn: true,
  storedAt: true,
  supersededAt: true,
  version: true,
} as const satisfies Prisma.PrivacyDpiaSelect

type DpiaRow = Prisma.PrivacyDpiaGetPayload<{ select: typeof DPIA_SELECT }>

export const readDpiaRow = (db: Pick<CommandTx, 'privacyDpia'>, dpiaId: string) => db.privacyDpia.findUnique({ where: { id: dpiaId }, select: DPIA_SELECT })

export const dpiaViewOf = (row: DpiaRow) => ({
  ...row,
  signedOn: dayOf(row.signedOn),
  reviewDueOn: dayOf(row.reviewDueOn),
  storedAt: row.storedAt ? toUtcIso(row.storedAt) : null,
  supersededAt: row.supersededAt ? toUtcIso(row.supersededAt) : null,
})

export async function readDpia(caller: CommandCaller, dpiaId: string, permission: typeof PRIVACY_VIEW | typeof PRIVACY_MANAGE): Promise<{ context: OfficeContext; row: DpiaRow }> {
  const context = officeOf(caller)
  const row = isUuid(dpiaId) ? await caller.withClient((client) => readDpiaRow(client, dpiaId)) : null
  if (!row) throw new NotFoundError('DPIA not found.')
  assertMay(context, permission, row.companyId, 'DPIA not found.')
  return { context, row }
}

/** privacy.view: the company's stored DPIA and every version, newest first. */
export async function listDpia(caller: CommandCaller, query: { companyId: string }) {
  const { company } = await companyFor(caller, query.companyId, PRIVACY_VIEW)
  const rows = await caller.withClient((client) => client.privacyDpia.findMany({ where: { companyId: company.id }, select: DPIA_SELECT, orderBy: { versionNo: 'desc' } }))
  const versions = rows.map(dpiaViewOf)
  return { company, stored: versions.find((row) => row.status === 'STORED') ?? null, versions }
}

/** privacy.manage: a new DRAFT, numbered next (one draft at a time). */
export async function createDpia(caller: CommandCaller, body: { companyId: string; scope?: string | undefined }, idempotencyKey?: string) {
  const { context, company } = await companyFor(caller, body.companyId, PRIVACY_MANAGE)
  const scope = body.scope?.trim() || DEFAULT_DPIA_SCOPE
  refuse(dpiaScopeProblems(scope), 'The scope is not valid.')
  const { result } = await command(caller, { name: 'privacy.createDpia', idempotencyKey, input: { ...body, scope } }, async (tools) => {
    await lockPrivacy(tools, 'dpia', company.id)
    const existing = await tools.tx.privacyDpia.findMany({ where: { companyId: company.id }, select: { versionNo: true, status: true } })
    if (existing.some((row) => row.status === 'DRAFT')) throw new ConflictError('A DPIA draft exists already: finish it or delete it first.')
    const id = newId()
    const versionNo = existing.reduce((max, row) => Math.max(max, row.versionNo), 0) + 1
    await tools.tx.privacyDpia.create({ data: { id, companyId: company.id, versionNo, scope, createdById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: 'PrivacyDpia', recordId: id, companyId: company.id, after: { versionNo, status: 'DRAFT' } })
    return { dpia: dpiaViewOf((await readDpiaRow(tools.tx, id))!) }
  })
  return result
}

export interface StoreDpiaInput {
  readonly signedByName: string
  readonly signedOn: string
  readonly reviewDueOn: string
  readonly version: number
}

/**
 * privacy.manage + a fresh code: the signed DRAFT is stored; the one stored before is superseded. The rules first (400
 * with every problem, no code asked), then the step-up, then ONE command.
 */
export async function storeDpia(caller: CommandCaller, dpiaId: string, body: StoreDpiaInput, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined; readonly now: Date }) {
  const { context, row } = await readDpia(caller, dpiaId, PRIVACY_MANAGE)
  if (row.status !== 'DRAFT') throw new InvalidStateError(`DPIA version ${row.versionNo} is ${row.status.toLowerCase()}: only a draft is stored.`)
  refuse(
    dpiaStoreProblems({ status: row.status, hasPdf: row.fileId !== null, signedByName: body.signedByName, signedOn: body.signedOn, reviewDueOn: body.reviewDueOn, today: businessDate(options.now) }),
    'The DPIA cannot be stored yet.',
  )
  options.stepUp()
  const { result } = await command(
    caller,
    { name: 'privacy.storeDpia', idempotencyKey: options.idempotencyKey, input: { dpiaId, ...body }, record: { type: 'PrivacyDpia', id: dpiaId, expectedVersion: body.version } },
    async (tools) => {
      await lockPrivacy(tools, 'dpia', row.companyId)
      const now = (await readDpiaRow(tools.tx, dpiaId))!
      if (now.status !== 'DRAFT' || now.fileId === null || now.fileSha256 === null) throw new ConflictError('This DPIA changed meanwhile; reload it.')
      const previous = await tools.tx.privacyDpia.findFirst({ where: { companyId: row.companyId, status: 'STORED' }, select: { id: true, versionNo: true } })
      if (previous && previous.versionNo > now.versionNo) throw new ConflictError(`A later DPIA (version ${previous.versionNo}) is stored already.`)
      if (previous) {
        await tools.tx.privacyDpia.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED', supersededAt: tools.now, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: 'privacy.supersedeDpia', recordType: 'PrivacyDpia', recordId: previous.id, companyId: row.companyId, before: { status: 'STORED' }, after: { status: 'SUPERSEDED', supersededBy: dpiaId } })
      }
      await tools.tx.privacyDpia.update({
        where: { id: dpiaId },
        data: { status: 'STORED', signedByName: body.signedByName.trim(), signedOn: dateOf(body.signedOn), reviewDueOn: dateOf(body.reviewDueOn), storedAt: tools.now, storedById: context.actorId },
        select: { id: true },
      })
      const until = new Date(tools.now)
      until.setUTCFullYear(until.getUTCFullYear() + DPIA_FILE_RETENTION_YEARS)
      await retainFilesInCommand(tools, [now.fileId], until, `A stored DPIA is kept ${DPIA_FILE_RETENTION_YEARS} years (GDPR arts. 5(2), 35).`)
      tools.audit({ recordType: 'PrivacyDpia', recordId: dpiaId, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'STORED', fileId: now.fileId, fileSha256: now.fileSha256, signedOn: body.signedOn, reviewDueOn: body.reviewDueOn, superseded: previous?.id ?? null } })
      tools.emit({ type: 'privacy.dpia_stored', subject: dpiaId, companyId: row.companyId, payload: { dpiaId, companyId: row.companyId, versionNo: now.versionNo, supersededId: previous?.id ?? null } })
      return { dpia: dpiaViewOf((await readDpiaRow(tools.tx, dpiaId))!), superseded: previous?.id ?? null }
    },
  )
  return result
}
