import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { CBI_RIBA_RULE } from '@nexus/factory-domain/receivables/cbi/riba'
import type { CollectionsBody } from '@nexus/factory-domain/receivables/notices/contracts'
import { NOTICE_HELD, NOTICE_WORDING_TO_CONFIRM } from '@nexus/factory-domain/receivables/notices/notices'
import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { RECEIVABLES_COLLECTIONS_SWITCH } from '@nexus/factory-domain/receivables/riba/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { rowToChange } from '../settings'
import { mayEveryCompany, officeContextOf, receivablesCommand, type Reader } from '../store'

/**
 * The Owner's collections switches (B-W2b-402; FIN-126, FIN-128; the Owner's rule of 11-13; factory-db receivables.prisma
 * ReceivablesSettings.ribaOn, .paymentNoticeToCustomerOn, both OFF by default), per company (its own row wins) or tenant-wide:
 *
 *   GET /receivables/collections/settings?companyId   receivables.view: both switches as they hold, from which row, in words
 *   PUT /receivables/collections/settings             receivables.collections.switch (turning one ON also asks a fresh
 *                                                     step-up): a company's first change makes its own row from the tenant's
 *                                                     (W2a's rowToChange), at the row's version
 * Ri.Ba. on: a batch's CBI file can be made (GATE-ACCOUNTANT: the bank and the accountant confirm the layout first).
 * The notice on: each bank transfer recorded is e-mailed to the customer (FAKE mail locally; the wording to confirm).
 */

export interface Collections {
  readonly source: 'COMPANY' | 'TENANT' | 'NONE'
  readonly settingsId: string | null
  readonly version: number | null
  readonly ribaOn: boolean
  readonly paymentNoticeToCustomerOn: boolean
}

/** The switches in force for a company (its row, else the tenant's, else both off); companyId null: the tenant's row. */
export async function collectionsOf(db: Reader, companyId: string | null): Promise<Collections> {
  const rows = await db.receivablesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] }, select: { id: true, companyId: true, version: true, ribaOn: true, paymentNoticeToCustomerOn: true } })
  const own = companyId ? rows.find((row) => row.companyId === companyId) : undefined
  const tenant = rows.find((row) => row.companyId === null)
  const row = own ?? tenant
  if (!row) return { source: 'NONE', settingsId: null, version: null, ribaOn: false, paymentNoticeToCustomerOn: false }
  return { source: own ? 'COMPANY' : 'TENANT', settingsId: row.id, version: row.version, ribaOn: row.ribaOn, paymentNoticeToCustomerOn: row.paymentNoticeToCustomerOn }
}

const mayAt = (context: OfficeContext, permission: typeof RECEIVABLES_VIEW | typeof RECEIVABLES_COLLECTIONS_SWITCH, companyId: string | null): boolean =>
  companyId === null ? mayEveryCompany(context, permission) : can(actorOf(context), permission, { companyId })

async function answerFor(db: Reader, context: OfficeContext, companyId: string | null) {
  const holds = await collectionsOf(db, companyId)
  return {
    companyId,
    ...holds,
    words: {
      riba: holds.ribaOn ? 'Ri.Ba. is on: a batch’s CBI file can be made for the bank’s site.' : `Ri.Ba. is off: batches can be prepared, their file is made once the Owner switches it on. ${CBI_RIBA_RULE}`,
      notice: holds.paymentNoticeToCustomerOn ? 'Each bank transfer recorded is e-mailed to the customer’s invoice contacts.' : NOTICE_HELD.SWITCHED_OFF,
      wording: NOTICE_WORDING_TO_CONFIRM,
    },
    mayChange: mayAt(context, RECEIVABLES_COLLECTIONS_SWITCH, companyId),
  }
}

/** GET /receivables/collections/settings (receivables.view). */
export async function getCollections(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null && !can(actorOf(context), RECEIVABLES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    if (companyId !== null && !(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    return answerFor(db, context, companyId)
  })
}

/** PUT /receivables/collections/settings (receivables.collections.switch; turning one ON also a fresh step-up). */
export async function putCollections(caller: CommandCaller, body: CollectionsBody, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (!mayAt(context, RECEIVABLES_COLLECTIONS_SWITCH, body.companyId)) throw new ForbiddenError(body.companyId === null ? 'The switches of every company are changed only by a role over every company.' : undefined)
  const before = await caller.withClient((db) => collectionsOf(db, body.companyId))
  if ((body.ribaOn === true && !before.ribaOn) || (body.paymentNoticeToCustomerOn === true && !before.paymentNoticeToCustomerOn)) stepUp()
  await receivablesCommand(caller, { name: 'receivables.collectionsSwitch', idempotencyKey, input: body }, async (tools) => {
    const holding = await collectionsOf(tools.tx, body.companyId)
    const { row } = await rowToChange(tools, body.companyId, body.version)
    const current = await tools.tx.receivablesSettings.findUniqueOrThrow({ where: { id: row.id }, select: { version: true, ribaOn: true, paymentNoticeToCustomerOn: true } })
    // A row made just now starts from what held before it (the tenant's switches).
    const next = { ribaOn: body.ribaOn ?? holding.ribaOn, paymentNoticeToCustomerOn: body.paymentNoticeToCustomerOn ?? holding.paymentNoticeToCustomerOn }
    if (next.ribaOn === current.ribaOn && next.paymentNoticeToCustomerOn === current.paymentNoticeToCustomerOn) {
      tools.audit({ action: 'receivables.collectionsSwitch', recordType: 'ReceivablesSettings', recordId: row.id, companyId: row.companyId, after: { ...next, unchanged: true } })
      return { id: row.id }
    }
    await tools.tx.receivablesSettings.update({ where: { id: row.id }, data: { ...next, version: current.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.collectionsSwitch', recordType: 'ReceivablesSettings', recordId: row.id, companyId: row.companyId, before: { ribaOn: current.ribaOn, paymentNoticeToCustomerOn: current.paymentNoticeToCustomerOn }, after: next })
    tools.emit({ type: 'collections_settings.changed', subject: row.id, companyId: row.companyId, payload: { settingsId: row.id, companyId: row.companyId, ...next } })
    return { id: row.id }
  })
  return caller.withClient((db) => answerFor(db, context, body.companyId))
}
