import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { abiCabOfIban, CBI_RIBA_RULE, cbiProblems, cbiRibaFile, supportNameOf, type CbiFlow, type CbiReceipt } from '@nexus/factory-domain/receivables/cbi/riba'
import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import type { CancelBody, CreateBatchBody, IssueBody, PickBody } from '@nexus/factory-domain/receivables/riba/contracts'
import { RECEIVABLES_RIBA_MANAGE } from '@nexus/factory-domain/receivables/riba/permissions'
import { RIBA_REFUSALS, windowProblems, type RibaRefusal } from '@nexus/factory-domain/receivables/riba/riba'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { collectionsOf } from '../notices/settings'
import { officeContextOf, peopleOf, receivablesCommand, tenantIdOf, today, type Reader } from '../store'
import {
  BATCH_COLUMNS,
  bankFor,
  candidateFor,
  candidatesOf,
  dateValue,
  day,
  itemsOf,
  knownBanksOf,
  liveAccountsOf,
  lockBatch,
  lockRiba,
  openNowOf,
  readBatch,
  refusedRiba,
  type BatchRow,
  type DebtorBank,
  type ItemRow,
} from './store'

/**
 * Ri.Ba. batches (B-W2b-402; FIN-126; design finance.payments ⋯ "Ri.Ba. batch": "Invoices due in the window; total; CBI
 * file" → "Create file (download)"; the new tab "Ri.Ba. file download"). Every write is ONE command under the company's
 * Ri.Ba. lock, the batch FOR UPDATE at the version the person read:
 *
 *   GET  /receivables/riba/candidates      receivables.view: the open MP12 instalments due in a window, with the customer's
 *                                          bank as known and why one cannot join (in another batch)
 *   POST /receivables/riba/batches         riba.manage: a DRAFT batch of the window (every candidate, or the ones picked)
 *   PUT  …/:batchId/items                  riba.manage: the instalments picked again while DRAFT
 *   POST …/:batchId/issue                  riba.manage: the CBI file made (put in the store outside the transaction), kept on
 *                                          the batch (StoredFile ATTACHMENT text/plain of record RibaBatch, ten years) and the
 *                                          batch ISSUED — only while the company's Ri.Ba. switch is on (the database too).
 *                                          The file goes NOWHERE by itself: a person downloads it (GET /files/:fileId/download)
 *                                          and uploads it to the bank's site
 *   POST …/:batchId/cancel                 riba.manage: a DRAFT abandoned, with why
 * Settling the items (paid, unpaid) is ./settle.ts.
 */

type Office = OfficeContext

const mayOnCompany = (context: RequestContext, permission: typeof RECEIVABLES_VIEW | typeof RECEIVABLES_RIBA_MANAGE, companyId: string): boolean =>
  context.audience === 'system' || (context.audience === 'office' && can(actorOf(context), permission, { companyId }))
const mayOnCustomer = (context: RequestContext, permission: typeof RECEIVABLES_VIEW | typeof RECEIVABLES_RIBA_MANAGE, scope: { companyId: string; partyId: string }): boolean =>
  context.audience === 'system' || (context.audience === 'office' && can(actorOf(context), permission, scope))

/** 404 when the reader may not see the company's receivables, 403 when they may see but not manage its Ri.Ba. */
function assertCompany(context: Office, companyId: string, manage: boolean): void {
  if (!mayOnCompany(context, RECEIVABLES_VIEW, companyId)) throw new NotFoundError('Company not found.')
  if (manage && !mayOnCompany(context, RECEIVABLES_RIBA_MANAGE, companyId)) throw new ForbiddenError()
}

/** riba.manage over every customer the batch collects from (a grant limited to some customers does not move the others). */
function assertCustomers(context: Office, companyId: string, partyIds: Iterable<string>): void {
  for (const partyId of new Set(partyIds)) if (!mayOnCustomer(context, RECEIVABLES_RIBA_MANAGE, { companyId, partyId })) throw new ForbiddenError('This batch collects from a customer you may not act for.')
}

async function batchOf(caller: CommandCaller, batchId: string, manage: boolean): Promise<BatchRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => readBatch(db, batchId))
  if (!row || !mayOnCompany(context, RECEIVABLES_VIEW, row.companyId)) throw new NotFoundError('Ri.Ba. batch not found.')
  if (manage && !mayOnCompany(context, RECEIVABLES_RIBA_MANAGE, row.companyId)) throw new ForbiddenError()
  return row
}

/** The company's Ri.Ba. switch (its row, else the tenant's, else off). */
export const ribaOnFor = async (db: Reader, companyId: string): Promise<boolean> => (await collectionsOf(db, companyId)).ribaOn

const ref = (row: { id: string; code: string; legalName: string } | undefined, id: string) => ({ id, code: row?.code ?? '', name: row?.legalName ?? '' })
const refusalOf = (code: RibaRefusal) => ({ code, words: RIBA_REFUSALS[code] })

// ---- views ---------------------------------------------------------------------------------------------------------------------

async function batchViewIn(db: Reader, context: RequestContext, row: BatchRow) {
  const all = await itemsOf(db, row.id)
  const items = all.filter((item) => mayOnCustomer(context, RECEIVABLES_VIEW, { companyId: row.companyId, partyId: item.partyId }))
  const company = await db.company.findUnique({ where: { id: row.companyId }, select: { id: true, code: true, legalName: true, currency: true } })
  const account = await db.bankAccount.findUnique({ where: { id: row.bankAccountId }, select: { id: true, iban: true, bankName: true, active: true } })
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(items.map((item) => item.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((party) => [party.id, party]))
  const invoices = new Map((await db.invoice.findMany({ where: { id: { in: [...new Set(items.map((item) => item.invoiceId))] } }, select: { id: true, number: true, issueDate: true } })).map((invoice) => [invoice.id, invoice]))
  const open = await openNowOf(db, items.map((item) => item.invoiceId), today())
  const known = await knownBanksOf(db, items.map((item) => item.invoiceId), items.map((item) => item.partyId))
  const payments = new Map(
    (await db.payment.findMany({ where: { companyId: row.companyId, externalRef: { in: items.filter((item) => item.status === 'PAID').map((item) => `RIBA-${item.id.toUpperCase()}`) } }, select: { id: true, externalRef: true } })).map((payment) => [payment.externalRef, payment.id]),
  )
  const file = row.fileId ? await db.storedFile.findUnique({ where: { id: row.fileId }, select: { id: true, originalName: true, sizeBytes: true } }) : null
  const people = await peopleOf(db, [row.issuedById])
  const switchOn = await ribaOnFor(db, row.companyId)
  const office = context.audience === 'office'
  const manage = office && mayOnCompany(context, RECEIVABLES_RIBA_MANAGE, row.companyId) && items.length === all.length
  return {
    id: row.id,
    company: ref(company ?? undefined, row.companyId),
    bankAccount: { id: row.bankAccountId, iban: account?.iban ?? '', bankName: account?.bankName ?? null, active: account?.active ?? false },
    dueFrom: day(row.dueFrom),
    dueTo: day(row.dueTo),
    status: row.status,
    note: row.note,
    items: items.map((item) => ({
      id: item.id,
      invoice: { id: item.invoiceId, number: invoices.get(item.invoiceId)?.number ?? null, issueDate: invoices.get(item.invoiceId)?.issueDate ? day(invoices.get(item.invoiceId)!.issueDate!) : null },
      customer: ref(parties.get(item.partyId), item.partyId),
      instalment: item.instalment,
      dueDate: day(item.dueDate),
      amount: asMoney('price', item.amount),
      status: item.status,
      settledOn: item.settledOn ? day(item.settledOn) : null,
      unpaidFee: asMoney('price', item.unpaidFee),
      paymentId: payments.get(`RIBA-${item.id.toUpperCase()}`) ?? null,
      invoiceOpen: asMoney('price', open.get(item.invoiceId) ?? 0),
      debtorBank: bankFor(known, new Map(), item),
      version: item.version,
    })),
    count: items.length,
    total: asMoney('price', items.reduce((sum, item) => sum + item.amount, 0)),
    currency: company?.currency ?? 'EUR',
    file: file ? { id: file.id, name: file.originalName, sizeBytes: file.sizeBytes } : null,
    issuedAt: row.issuedAt ? toUtcIso(row.issuedAt) : null,
    issuedBy: row.issuedById ? { id: row.issuedById, name: people.get(row.issuedById) ?? null } : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    settled: { paid: items.filter((item) => item.status === 'PAID').length, unpaid: items.filter((item) => item.status === 'UNPAID').length, waiting: row.status === 'ISSUED' ? items.filter((item) => item.status === 'ISSUED').length : 0 },
    switchOn,
    rule: { status: 'UNVERIFIED' as const, words: CBI_RIBA_RULE },
    can: {
      pick: manage && row.status === 'DRAFT',
      issue: manage && row.status === 'DRAFT' && switchOn && items.length > 0,
      cancel: manage && row.status === 'DRAFT',
      settle: manage && row.status === 'ISSUED' && items.some((item) => item.status === 'ISSUED'),
    },
    createdAt: toUtcIso(row.createdAt),
    version: row.version,
  }
}

export async function batchAnswerIn(db: Reader, context: RequestContext, batchId: string) {
  return { batch: await batchViewIn(db, context, (await readBatch(db, batchId))!) }
}

/** GET /receivables/riba/batches/:batchId (receivables.view). */
export async function getBatch(caller: CommandCaller, batchId: string) {
  const context = officeContextOf(caller)
  const row = await batchOf(caller, batchId, false)
  return caller.withClient(async (db) => ({ batch: await batchViewIn(db, context, row) }))
}

/** GET /receivables/riba/batches (receivables.view): newest first. */
export async function listBatches(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly status?: BatchRow['status'] | undefined; readonly limit: number }) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), RECEIVABLES_VIEW, { company: 'companyId' })
  return caller.withClient(async (db) => {
    const rows = await db.ribaBatch.findMany({ where: { AND: [scope as object, query.companyId ? { companyId: query.companyId } : {}, query.status ? { status: query.status } : {}] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit, select: BATCH_COLUMNS })
    const items = rows.length === 0 ? [] : await db.ribaItem.findMany({ where: { batchId: { in: rows.map((row) => row.id) } }, select: { batchId: true, partyId: true, amount: true, status: true } })
    const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, code: true, legalName: true } })).map((company) => [company.id, company]))
    return {
      batches: rows.map((row) => {
        const own = items.filter((item) => item.batchId === row.id && mayOnCustomer(context, RECEIVABLES_VIEW, { companyId: row.companyId, partyId: item.partyId }))
        return {
          id: row.id,
          company: ref(companies.get(row.companyId), row.companyId),
          dueFrom: day(row.dueFrom),
          dueTo: day(row.dueTo),
          status: row.status,
          count: own.length,
          total: asMoney('price', own.reduce((sum, item) => sum + item.amount, 0)),
          fileId: row.fileId,
          issuedAt: row.issuedAt ? toUtcIso(row.issuedAt) : null,
          settled: { paid: own.filter((item) => item.status === 'PAID').length, unpaid: own.filter((item) => item.status === 'UNPAID').length, waiting: row.status === 'ISSUED' ? own.filter((item) => item.status === 'ISSUED').length : 0 },
          createdAt: toUtcIso(row.createdAt),
        }
      }),
    }
  })
}

/** GET /receivables/riba/candidates (receivables.view). */
export async function listCandidates(caller: CommandCaller, query: { readonly companyId: string; readonly dueFrom: BusinessDate; readonly dueTo: BusinessDate; readonly batchId?: string | undefined }) {
  const context = officeContextOf(caller)
  assertCompany(context, query.companyId, false)
  const problems = windowProblems(query.dueFrom, query.dueTo, 'query')
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return caller.withClient(async (db) => {
    const found = (await candidatesOf(db, query.companyId, query, today())).filter((entry) => mayOnCustomer(context, RECEIVABLES_VIEW, { companyId: query.companyId, partyId: entry.invoice.partyId }))
    const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(found.map((entry) => entry.invoice.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((party) => [party.id, party]))
    const known = await knownBanksOf(db, found.map((entry) => entry.invoice.id), found.map((entry) => entry.invoice.partyId))
    const candidates = found.map((entry) => ({
      invoice: { id: entry.invoice.id, number: entry.invoice.number, issueDate: entry.invoice.issueDate },
      customer: ref(parties.get(entry.invoice.partyId), entry.invoice.partyId),
      instalment: entry.term.instalment,
      dueDate: entry.term.dueDate,
      instalmentAmount: asMoney('price', entry.term.amount),
      amount: asMoney('price', entry.amount),
      currency: entry.invoice.currency,
      debtorBank: bankFor(known, new Map(), { invoiceId: entry.invoice.id, partyId: entry.invoice.partyId }),
      held: entry.inBatchId !== null && entry.inBatchId !== query.batchId ? refusalOf('IN_ANOTHER_BATCH') : entry.invoice.currency !== 'EUR' ? refusalOf('CURRENCY') : null,
    }))
    const free = candidates.filter((entry) => entry.held === null)
    return { companyId: query.companyId, dueFrom: query.dueFrom, dueTo: query.dueTo, candidates, total: asMoney('price', free.reduce((sum, entry) => sum + entry.amount, 0)), count: free.length }
  })
}

// ---- writes --------------------------------------------------------------------------------------------------------------------

/** Writes the picked instalments of a DRAFT batch (each checked again inside the command); answers how many. */
async function writeItems(tools: CommandTools, batch: Pick<BatchRow, 'id' | 'companyId'> & { dueFrom: BusinessDate; dueTo: BusinessDate }, picks: readonly { invoiceId: string; instalment: number }[] | null, context: Office): Promise<number> {
  const { tx } = tools
  const asOf = today()
  const problems: Issue[] = []
  const rows: { invoiceId: string; partyId: string; instalment: number; dueDate: BusinessDate; amount: number }[] = []
  if (picks === null) {
    for (const entry of await candidatesOf(tx, batch.companyId, batch, asOf)) {
      if (entry.inBatchId !== null || entry.invoice.currency !== 'EUR') continue
      rows.push({ invoiceId: entry.invoice.id, partyId: entry.invoice.partyId, instalment: entry.term.instalment, dueDate: entry.term.dueDate, amount: entry.amount })
    }
  } else {
    const seen = new Set<string>()
    for (const [index, pick] of picks.entries()) {
      const key = `${pick.invoiceId}|${pick.instalment}`
      if (seen.has(key)) {
        problems.push({ path: `body/items/${index}`, message: 'Each instalment once.' })
        continue
      }
      seen.add(key)
      const found = await candidateFor(tx, batch.companyId, pick, batch, asOf, batch.id)
      if (typeof found === 'string') problems.push({ path: `body/items/${index}/${found}`, message: RIBA_REFUSALS[found] })
      else rows.push({ invoiceId: found.invoice.id, partyId: found.invoice.partyId, instalment: found.term.instalment, dueDate: found.term.dueDate, amount: found.amount })
    }
  }
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Some instalments cannot join the batch.', problems)
  assertCustomers(context, batch.companyId, rows.map((row) => row.partyId))
  await tx.ribaItem.deleteMany({ where: { batchId: batch.id } })
  for (const row of rows) {
    await tx.ribaItem.create({
      data: { id: newId(), companyId: batch.companyId, batchId: batch.id, partyId: row.partyId, invoiceId: row.invoiceId, instalment: row.instalment, dueDate: dateValue(row.dueDate), amount: row.amount, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId },
      select: { id: true },
    })
  }
  return rows.length
}

/** POST /receivables/riba/batches (riba.manage): a DRAFT batch of a window. */
export async function createBatch(caller: CommandCaller, body: CreateBatchBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertCompany(context, body.companyId, true)
  const problems = windowProblems(body.dueFrom, body.dueTo)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result } = await receivablesCommand(caller, { name: 'receivables.ribaCreate', idempotencyKey, input: body }, async (tools) => {
    await lockRiba(tools.tx, tenantIdOf(tools.context), body.companyId)
    const accounts = await liveAccountsOf(tools.tx, body.companyId)
    const account = body.bankAccountId ? accounts.find((entry) => entry.id === body.bankAccountId) : accounts.length === 1 ? accounts[0] : undefined
    if (!account) throw body.bankAccountId ? refusedRiba('ACCOUNT_OFF', 'body/bankAccountId') : refusedRiba('NO_ACCOUNT', 'body/bankAccountId')
    if (!abiCabOfIban(account.iban)) throw refusedRiba('ACCOUNT_NOT_ITALIAN', 'body/bankAccountId')
    const id = newId()
    await tools.tx.ribaBatch.create({ data: { id, companyId: body.companyId, bankAccountId: account.id, dueFrom: dateValue(body.dueFrom), dueTo: dateValue(body.dueTo), note: body.note ?? null, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
    const count = await writeItems(tools, { id, companyId: body.companyId, dueFrom: body.dueFrom, dueTo: body.dueTo }, body.items ?? null, context)
    tools.audit({ action: 'receivables.ribaCreate', recordType: 'RibaBatch', recordId: id, companyId: body.companyId, after: { bankAccountId: account.id, dueFrom: body.dueFrom, dueTo: body.dueTo, items: count, picked: body.items !== undefined } })
    tools.emit({ type: 'riba_batch.changed', subject: id, companyId: body.companyId, payload: { batchId: id, action: 'CREATED', items: count, fileId: null } })
    return batchAnswerIn(tools.tx, tools.context, id)
  })
  return result
}

/** PUT /receivables/riba/batches/:batchId/items (riba.manage): the instalments picked again while DRAFT. */
export async function pickItems(caller: CommandCaller, batchId: string, body: PickBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const peek = await batchOf(caller, batchId, true)
  const { result } = await receivablesCommand(caller, { name: 'receivables.ribaPick', idempotencyKey, input: { batchId, ...body } }, async (tools) => {
    await lockRiba(tools.tx, tenantIdOf(tools.context), peek.companyId)
    const batch = await lockBatch(tools.tx, batchId, body.version)
    if (batch.status !== 'DRAFT') throw refusedRiba('NOT_DRAFT')
    assertCustomers(context, batch.companyId, (await itemsOf(tools.tx, batch.id)).map((item) => item.partyId))
    const count = await writeItems(tools, { id: batch.id, companyId: batch.companyId, dueFrom: day(batch.dueFrom), dueTo: day(batch.dueTo) }, body.items, context)
    await tools.tx.ribaBatch.update({ where: { id: batch.id }, data: { version: batch.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.ribaPick', recordType: 'RibaBatch', recordId: batch.id, companyId: batch.companyId, after: { items: count } })
    tools.emit({ type: 'riba_batch.changed', subject: batch.id, companyId: batch.companyId, payload: { batchId: batch.id, action: 'PICKED', items: count, fileId: null } })
    return batchAnswerIn(tools.tx, tools.context, batch.id)
  })
  return result
}

/** POST /receivables/riba/batches/:batchId/cancel (riba.manage): a DRAFT abandoned. */
export async function cancelBatch(caller: CommandCaller, batchId: string, body: CancelBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const peek = await batchOf(caller, batchId, true)
  const { result } = await receivablesCommand(caller, { name: 'receivables.ribaCancel', idempotencyKey, input: { batchId, ...body } }, async (tools) => {
    await lockRiba(tools.tx, tenantIdOf(tools.context), peek.companyId)
    const batch = await lockBatch(tools.tx, batchId, body.version)
    if (batch.status !== 'DRAFT') throw refusedRiba('NOT_DRAFT')
    const items = await itemsOf(tools.tx, batch.id)
    assertCustomers(context, batch.companyId, items.map((item) => item.partyId))
    await tools.tx.ribaBatch.update({ where: { id: batch.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason, version: batch.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.ribaCancel', recordType: 'RibaBatch', recordId: batch.id, companyId: batch.companyId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, reason: body.reason })
    tools.emit({ type: 'riba_batch.changed', subject: batch.id, companyId: batch.companyId, payload: { batchId: batch.id, action: 'CANCELLED', items: items.length, fileId: null } })
    return batchAnswerIn(tools.tx, tools.context, batch.id)
  })
  return result
}

// ---- issue: the CBI file -----------------------------------------------------------------------------------------------------

interface Built {
  readonly prepared: PreparedGeneratedFile
  /** What the file was made from: each item's id and amount (the command checks the batch still holds exactly these). */
  readonly items: readonly { readonly id: string; readonly amount: number }[]
  readonly receipts: number
}

const streetOf = (address: { street?: unknown; streetNumber?: unknown } | undefined): string => [typeof address?.street === 'string' ? address.street : '', typeof address?.streetNumber === 'string' ? address.streetNumber : ''].join(' ').trim()

/** The receipts and the creditor as the CBI file writes them; the problems in words when something is missing. */
async function flowOf(caller: CommandCaller, batch: BatchRow, items: readonly ItemRow[], given: ReadonlyMap<string, DebtorBank>, siaCode: string, createdOn: BusinessDate): Promise<{ flow: CbiFlow | null; problems: Issue[] }> {
  const problems: Issue[] = []
  const facts = await caller.withClient(async (db) => ({
    account: await db.bankAccount.findUnique({ where: { id: batch.bankAccountId }, select: { iban: true, active: true } }),
    invoices: new Map((await db.invoice.findMany({ where: { id: { in: items.map((item) => item.invoiceId) } }, select: { id: true, number: true, issueDate: true, currency: true, billTo: true, seller: true } })).map((invoice) => [invoice.id, invoice])),
    parties: new Map((await db.party.findMany({ where: { id: { in: [...new Set(items.map((item) => item.partyId))] } }, select: { id: true, code: true } })).map((party) => [party.id, party.code])),
    known: await knownBanksOf(db, items.map((item) => item.invoiceId), items.map((item) => item.partyId)),
  }))
  const account = abiCabOfIban(facts.account?.iban)
  if (!facts.account?.active) problems.push({ path: 'riba/ACCOUNT_OFF', message: RIBA_REFUSALS.ACCOUNT_OFF })
  else if (!account) problems.push({ path: 'riba/ACCOUNT_NOT_ITALIAN', message: RIBA_REFUSALS.ACCOUNT_NOT_ITALIAN })
  const legal = await companyLegalOf(caller, batch.companyId)
  const seller = items.map((item) => facts.invoices.get(item.invoiceId)?.seller as { vatNumber?: string; name?: string; address?: { street?: string; streetNumber?: string; postcode?: string; city?: string; province?: string } } | null | undefined).find((value) => value && typeof value === 'object')
  const creditorVat = (legal.vatNumber ?? seller?.vatNumber ?? legal.fiscalCode ?? '').replace(/^IT/i, '')
  const creditorAddress = legal.address ? { street: [legal.address.line1, legal.address.line2].filter(Boolean).join(' '), postcodeTown: [legal.address.postalCode, legal.address.city, legal.address.province].filter(Boolean).join(' ') } : { street: streetOf(seller?.address), postcodeTown: [seller?.address?.postcode, seller?.address?.city, seller?.address?.province].filter(Boolean).join(' ') }
  const receipts: CbiReceipt[] = []
  items.forEach((item, index) => {
    const invoice = facts.invoices.get(item.invoiceId)
    const at = `items/${index}`
    if (!invoice) {
      problems.push({ path: `${at}/NOT_RIBA`, message: RIBA_REFUSALS.NOT_RIBA })
      return
    }
    const billTo = (invoice.billTo ?? {}) as { kind?: string; vatNumber?: string; fiscalCode?: string; name?: string; firstName?: string; lastName?: string; address?: { street?: string; streetNumber?: string; postcode?: string; city?: string; province?: string; country?: string } }
    if (invoice.currency !== 'EUR') problems.push({ path: `${at}/CURRENCY`, message: RIBA_REFUSALS.CURRENCY })
    if ((billTo.kind !== 'IT_BUSINESS' && billTo.kind !== 'IT_CONSUMER') || billTo.address?.country !== 'IT') {
      problems.push({ path: `${at}/DEBTOR_NOT_ITALIAN`, message: `${RIBA_REFUSALS.DEBTOR_NOT_ITALIAN} (${invoice.number ?? item.invoiceId})` })
      return
    }
    const bank = bankFor(facts.known, given, item)
    if (!bank) problems.push({ path: `${at}/NO_DEBTOR_BANK`, message: `${RIBA_REFUSALS.NO_DEBTOR_BANK} (${invoice.number ?? item.invoiceId})` })
    receipts.push({
      dueDate: day(item.dueDate),
      amount: item.amount,
      debtorBank: bank ? { abi: bank.abi, cab: bank.cab, name: bank.name } : { abi: '', cab: '', name: null },
      debtor: {
        code: facts.parties.get(item.partyId) ?? '',
        name: billTo.name ?? [billTo.firstName, billTo.lastName].filter(Boolean).join(' '),
        taxId: billTo.vatNumber ?? billTo.fiscalCode ?? '',
        street: streetOf(billTo.address),
        postcode: billTo.address?.postcode ?? '',
        town: billTo.address?.city ?? '',
        province: (billTo.address?.province ?? '').toUpperCase(),
      },
      invoice: { number: invoice.number ?? '', issueDate: invoice.issueDate ? day(invoice.issueDate) : createdOn },
    })
  })
  if (problems.length > 0 || !account) return { flow: null, problems }
  const flow: CbiFlow = {
    creditor: { siaCode, abi: account.abi, cab: account.cab, account: account.account, name: legal.legalName, street: creditorAddress.street, postcodeTown: creditorAddress.postcodeTown, vatNumber: creditorVat },
    receipts,
    createdOn,
    supportName: supportNameOf(batch.id, createdOn),
  }
  // The file's own rules, each problem at its item.
  for (const problem of cbiProblems(flow)) problems.push({ path: `riba/FILE_DATA/${problem.path}`, message: problem.message })
  return { flow: problems.length > 0 ? null : flow, problems }
}

/** The file made and put in the store, outside any transaction. */
async function buildFile(caller: CommandCaller, batch: BatchRow, body: IssueBody): Promise<Built> {
  const items = await caller.withClient((db) => itemsOf(db, batch.id))
  if (items.length === 0) throw refusedRiba('NO_ITEMS')
  const given = new Map<string, DebtorBank>((body.banks ?? []).map((bank) => [bank.partyId, { abi: bank.abi, cab: bank.cab, name: bank.name ?? null, source: 'GIVEN' as const }]))
  const createdOn = today()
  const { flow, problems } = await flowOf(caller, batch, items, given, body.siaCode, createdOn)
  if (!flow) throw new ValidationError(problems.length === 1 ? problems[0]!.message : RIBA_REFUSALS.FILE_DATA, problems)
  const file = cbiRibaFile(flow)
  const company = await caller.withClient((db) => db.company.findUnique({ where: { id: batch.companyId }, select: { code: true } }))
  const prepared = await putGeneratedFile(processFiles(), caller, {
    companyId: batch.companyId,
    recordType: 'RibaBatch',
    recordId: batch.id,
    kind: 'ATTACHMENT',
    originalName: `RIBA-${company?.code ?? 'COMPANY'}-${createdOn.replace(/-/g, '')}-${batch.id.slice(0, 8)}.txt`,
    contentType: 'text/plain',
    body: Buffer.from(file.text, 'latin1'),
    // A collection record of the company: kept ten years, as its invoices (c.c. art. 2220).
    retainUntil: new Date(Date.UTC(Number(createdOn.slice(0, 4)) + 10, Number(createdOn.slice(5, 7)) - 1, Number(createdOn.slice(8, 10)) + 1)),
  })
  return { prepared, items: items.map((item) => ({ id: item.id, amount: item.amount })), receipts: file.receipts }
}

/** POST /receivables/riba/batches/:batchId/issue (riba.manage): the CBI file made and the batch ISSUED (switch on). */
export async function issueBatch(caller: CommandCaller, batchId: string, body: IssueBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const peek = await batchOf(caller, batchId, true)
  if (peek.status !== 'DRAFT') throw refusedRiba('NOT_DRAFT')
  // A stale version is refused before the file is made (the command checks it again under the lock).
  if (peek.version !== body.version) throw new DomainError('conflict', `This batch changed since it was read (version ${body.version}); it is now at version ${peek.version}. Reload it and try again.`, [{ path: 'body/version', message: `The current version is ${peek.version}.` }])
  if (!(await caller.withClient((db) => ribaOnFor(db, peek.companyId)))) throw refusedRiba('SWITCHED_OFF')
  assertCustomers(context, peek.companyId, (await caller.withClient((db) => itemsOf(db, peek.id))).map((item) => item.partyId))
  const built = await buildFile(caller, peek, body)
  const { result } = await receivablesCommand(caller, { name: 'receivables.ribaIssue', idempotencyKey, input: { batchId, version: body.version, siaCode: body.siaCode, banks: body.banks ?? [] } }, async (tools) => {
    await lockRiba(tools.tx, tenantIdOf(tools.context), peek.companyId)
    const batch = await lockBatch(tools.tx, batchId, body.version)
    if (batch.status !== 'DRAFT') throw refusedRiba('NOT_DRAFT')
    if (!(await ribaOnFor(tools.tx, batch.companyId))) throw refusedRiba('SWITCHED_OFF')
    const now = (await itemsOf(tools.tx, batch.id)).map((item) => `${item.id}|${item.amount}`).sort()
    if (now.join(',') !== built.items.map((item) => `${item.id}|${item.amount}`).sort().join(',')) throw refusedRiba('NOT_DRAFT', 'riba/CHANGED', 'The batch changed while its file was being made: make the file again.')
    const file = await recordGeneratedFile(tools, built.prepared, { action: 'receivables.ribaFile', details: { layout: 'CBI_RIBA', receipts: built.receipts } })
    await tools.tx.ribaBatch.update({ where: { id: batch.id }, data: { status: 'ISSUED', fileId: file.id, issuedAt: tools.now, issuedById: context.actorId, version: batch.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.ribaIssue', recordType: 'RibaBatch', recordId: batch.id, companyId: batch.companyId, before: { status: 'DRAFT' }, after: { status: 'ISSUED', fileId: file.id, receipts: built.receipts, total: markMoney('price', built.items.reduce((sum, item) => sum + item.amount, 0)), siaCode: body.siaCode, banksGiven: (body.banks ?? []).length } })
    tools.emit({ type: 'riba_batch.changed', subject: batch.id, companyId: batch.companyId, payload: { batchId: batch.id, action: 'ISSUED', items: built.items.length, fileId: file.id } })
    return batchAnswerIn(tools.tx, tools.context, batch.id)
  })
  return result
}
