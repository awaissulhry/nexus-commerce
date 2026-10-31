import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PAYABLES_MANAGE, PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { command, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { officeOf, peopleNames, type Reader } from './store'

/**
 * The SDI inbox (B-W2b-21, Z8:06; factory-db SdiInboxItem of B-W2b-02; B-W2a-62's gap "an undeliverable item stays at the
 * intermediary: the pickup's audit row lists it"): every delivery SDI handed the company that the pickup could not record
 * (sdi.ts upsertInboxItem: why, how often it was tried), until it is recorded (the pickup marks it RECORDED with the
 * invoice or the file of several it became, in the recording command) or a person dismisses it with a reason (not ours, a
 * test delivery, sent again under another IdentificativoSdI …). A dismissed delivery is not tried again; reopened, the next
 * pickup tries it.
 *
 *   GET  /payables/sdi/inbox?companyId&status&cursor&limit   payables.view (over the company): newest first, the counts
 *   POST /payables/sdi/inbox/:itemId/dismiss {version, reason}   payables.manage: OPEN → DISMISSED
 *   POST /payables/sdi/inbox/:itemId/reopen {version}            payables.manage: DISMISSED → OPEN (the dismissal cleared)
 * Each move is ONE command at the item's version (its row FOR UPDATE), audited, with its event.
 */

const COLUMNS = {
  id: true,
  companyId: true,
  accountId: true,
  sdiIdentifier: true,
  fileName: true,
  receivedAt: true,
  problem: true,
  problemText: true,
  attempts: true,
  firstSeenAt: true,
  lastTriedAt: true,
  status: true,
  xmlFileId: true,
  recordedAt: true,
  supplierInvoiceId: true,
  supplierInvoiceFileId: true,
  dismissedAt: true,
  dismissedById: true,
  dismissReason: true,
  version: true,
  company: { select: { code: true, legalName: true } },
} as const satisfies Prisma.SdiInboxItemSelect
type ItemRow = Prisma.SdiInboxItemGetPayload<{ select: typeof COLUMNS }>

function itemView(row: ItemRow, people: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    company: { id: row.companyId, code: row.company.code, name: row.company.legalName },
    accountId: row.accountId,
    sdiIdentifier: row.sdiIdentifier,
    fileName: row.fileName,
    receivedAt: toUtcIso(row.receivedAt),
    problem: row.problem,
    problemText: row.problemText,
    attempts: row.attempts,
    firstSeenAt: toUtcIso(row.firstSeenAt),
    lastTriedAt: toUtcIso(row.lastTriedAt),
    status: row.status,
    xmlFileId: row.xmlFileId,
    recorded: row.recordedAt ? { at: toUtcIso(row.recordedAt), supplierInvoiceId: row.supplierInvoiceId, supplierInvoiceFileId: row.supplierInvoiceFileId } : null,
    dismissed: row.dismissedAt ? { at: toUtcIso(row.dismissedAt), by: row.dismissedById ? { id: row.dismissedById, name: people.get(row.dismissedById) ?? null } : null, reason: row.dismissReason ?? '' } : null,
    version: row.version,
  }
}

async function viewOf(db: Reader, row: ItemRow) {
  return itemView(row, await peopleNames(db, [row.dismissedById]))
}

export interface InboxQuery {
  readonly companyId?: string | undefined
  readonly status?: 'OPEN' | 'RECORDED' | 'DISMISSED' | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** payables.view: the inbox of the companies the caller reaches, newest delivery first. */
export async function listInbox(caller: CommandCaller, query: InboxQuery) {
  const context = officeOf(caller)
  if (query.companyId && !can(actorOf(context), PAYABLES_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  const scope = scopeWhere(actorOf(context), PAYABLES_VIEW, { company: 'companyId' }) as Prisma.SdiInboxItemWhereInput
  const base: Prisma.SdiInboxItemWhereInput = { AND: [scope, query.companyId ? { companyId: query.companyId } : {}] }
  return caller.withClient(async (db) => {
    const rows = await db.sdiInboxItem.findMany({
      where: { AND: [base, query.status ? { status: query.status } : {}, query.cursor ? { id: { lt: query.cursor } } : {}] },
      select: COLUMNS,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const people = await peopleNames(db, page.map((row) => row.dismissedById))
    const open = await db.sdiInboxItem.count({ where: { AND: [base, { status: 'OPEN' }] } })
    const dismissed = await db.sdiInboxItem.count({ where: { AND: [base, { status: 'DISMISSED' }] } })
    return { items: page.map((row) => itemView(row, people)), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null, counts: { open, dismissed } }
  })
}

/** The item the caller may see (else 404) and manage (else 403). */
async function officeItem(caller: CommandCaller, itemId: string): Promise<ItemRow> {
  const context = officeOf(caller)
  const row = isUuid(itemId) ? await caller.withClient((db) => db.sdiInboxItem.findUnique({ where: { id: itemId }, select: COLUMNS })) : null
  if (!row || !can(actorOf(context), PAYABLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('SDI inbox item not found.')
  if (!can(actorOf(context), PAYABLES_MANAGE, { companyId: row.companyId })) throw new ForbiddenError()
  return row
}

const refused = (message: string, code: string) => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

async function move(caller: CommandCaller, itemId: string, to: 'DISMISSED' | 'OPEN', input: { readonly version: number; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const seen = await officeItem(caller, itemId)
  const context = officeOf(caller)
  const { result } = await command(caller, { name: to === 'DISMISSED' ? 'payables.sdiInboxDismiss' : 'payables.sdiInboxReopen', idempotencyKey, input: { itemId, ...input } }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT id FROM "SdiInboxItem" WHERE id = ${seen.id}::uuid FOR UPDATE`
    const row = (await tx.sdiInboxItem.findUnique({ where: { id: seen.id }, select: COLUMNS }))!
    if (row.version !== input.version) throw new DomainError('conflict', `This inbox item changed since it was read (version ${row.version} now): read it again.`, [{ path: 'body/version', message: `The current version is ${row.version}.` }])
    if (to === 'DISMISSED' && row.status !== 'OPEN') throw refused(row.status === 'RECORDED' ? 'This delivery is recorded already: nothing to dismiss.' : 'This delivery is dismissed already.', 'NOT_OPEN')
    if (to === 'OPEN' && row.status !== 'DISMISSED') throw refused(row.status === 'RECORDED' ? 'This delivery is recorded: it never waits again.' : 'This delivery waits already.', 'NOT_DISMISSED')
    const reason = input.reason?.trim() ?? ''
    await tx.sdiInboxItem.update({
      where: { id: row.id },
      data: to === 'DISMISSED' ? { status: 'DISMISSED', dismissedAt: tools.now, dismissedById: context.actorId, dismissReason: reason, version: { increment: 1 }, updatedAt: tools.now } : { status: 'OPEN', dismissedAt: null, dismissedById: null, dismissReason: null, version: { increment: 1 }, updatedAt: tools.now },
      select: { id: true },
    })
    tools.audit({ action: to === 'DISMISSED' ? 'payables.sdiInboxDismiss' : 'payables.sdiInboxReopen', recordType: 'SdiInboxItem', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: to, sdiIdentifier: row.sdiIdentifier }, ...(to === 'DISMISSED' ? { reason } : {}) })
    const payload = { itemId: row.id, companyId: row.companyId, accountId: row.accountId }
    if (to === 'DISMISSED') tools.emit({ type: 'sdi_inbox_item.dismissed', subject: row.id, companyId: row.companyId, payload })
    else tools.emit({ type: 'sdi_inbox_item.reopened', subject: row.id, companyId: row.companyId, payload })
    return { item: await viewOf(tx, (await tx.sdiInboxItem.findUnique({ where: { id: row.id }, select: COLUMNS }))!) }
  })
  return result
}

/** payables.manage: a waiting delivery dismissed with a reason (it is not tried again). */
export const dismissInboxItem = (caller: CommandCaller, itemId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string) => move(caller, itemId, 'DISMISSED', input, idempotencyKey)

/** payables.manage: a dismissed delivery back in the inbox (the next pickup tries it again). */
export const reopenInboxItem = (caller: CommandCaller, itemId: string, input: { readonly version: number }, idempotencyKey?: string) => move(caller, itemId, 'OPEN', input, idempotencyKey)
