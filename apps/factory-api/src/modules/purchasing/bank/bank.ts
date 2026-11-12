import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId, isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { eventFor } from '@nexus/factory-domain/events/define'
import {
  BANK_REFUSALS,
  callBackCandidates,
  CANDIDATE_HOLD_WORDS,
  checkProblems,
  callBackProblems,
  groupedIban,
  isOpen,
  maskedIban,
  PILL_WORDS,
  planProposal,
  proposalConflict,
  refuseReasonOf,
  retireReasonOf,
  askersOfAccount,
  type BankAccountStatus,
  type OnFile,
  type ProposalInput,
} from '@nexus/factory-domain/purchasing/bank/rules'
import { PURCHASING_BANK_CALL_BACK, PURCHASING_BANK_PROPOSE, PURCHASING_BANK_REVEAL, PURCHASING_BANK_VERIFY, PURCHASING_BANK_VIEW } from '@nexus/factory-domain/purchasing/bank/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { askApproval, withdrawPending } from '../../../platform/approvals/engine'
import { assertMayWrite, mayWrite } from '../../parties/store'
import { officeContextOf, type Reader } from '../store'
import { peopleNames, readSupplier, type SupplierRow } from '../suppliers-depth/store'
import { accountView, activateInCommand, calledBackEvent, factsOf, lockAccount, lockParty, namedIn, onFileOf, proposedEvent, readAccount, readAccounts, refuseInCommand, retiredEvent, type AccountRow } from './store'

/**
 * A supplier's bank details in the office (B-W2b-315; SCM-007; design purchasing.suppliers › Bank details "Change IBAN →
 * StepUpModal, then the change waits for a second person and a call-back record (who called, number from our records,
 * time)", "Reveal full IBAN (finance, StepUpModal)", "noPermission: Hidden for roles without finance permissions"):
 *
 *   GET  /purchasing/suppliers/:partyId/bank                          the accounts (masked), the pill of each, the call-back
 *                                                                     and the check, the numbers on file a waiting change may
 *                                                                     dial (and those left out with why), what may be done
 *   POST /purchasing/suppliers/:partyId/bank                          a new account from the supplier's letter (step-up):
 *                                                                     PROPOSED, replacing the ACTIVE one of its currency
 *   POST …/bank/:accountId/call-back                                  who called (never who proposed or wrote it), on which
 *                                                                     number on file before the proposal, as dialled
 *   POST …/bank/:accountId/verify                                     the second check (step-up; never who proposed or wrote
 *                                                                     it, the Owner included): a switched-on SUPPLIER_BANK_
 *                                                                     CHANGE rule asks a yes first (202: it waits in
 *                                                                     Approvals; the approver's yes activates it), else ACTIVE
 *                                                                     now, the old account RETIRED first
 *   POST …/bank/:accountId/refuse | retire                            REFUSED with why; an ACTIVE account RETIRED with why
 *   POST …/bank/:accountId/reveal                                     the full IBAN (finance, step-up; audited)
 *
 * Reading needs parties.view and purchasing.bank.view over the supplier's company and the supplier; each act its own
 * permission. Nothing goes by mail: no IBAN in any mail, event, audit row or list (the audit keeps the masked one).
 */

export interface ProposeBody extends ProposalInput {}
export interface CallBackBody {
  readonly version: number
  readonly contactId?: string | undefined
  readonly addressId?: string | undefined
  readonly phone: string
}
export interface VersionBody {
  readonly version: number
}
export interface ReasonBody {
  readonly version: number
  readonly reason: string
}

const KIND = 'SUPPLIER_BANK_CHANGE' as const

/** A refusal in words: who-may-not paths are 403, the rest a conflict with the account as it stands. */
function refusalOf(issues: readonly Issue[]): DomainError {
  const first = issues[0]!
  if (first.path.startsWith('refusal/OWN')) return new DomainError('forbidden', first.message, [...issues])
  if (first.path.startsWith('body/')) return new ValidationError(first.message, [...issues])
  return new DomainError('conflict', first.message, [...issues])
}

/** The supplier as the caller may see its bank details: parties.view (else 404) and purchasing.bank.view (else 403). */
async function bankSupplier(caller: CommandCaller, partyId: string): Promise<SupplierRow> {
  const row = await readSupplier(caller, partyId)
  if (!can(actorOf(officeContextOf(caller)), PURCHASING_BANK_VIEW, { companyId: row.companyId, partyId: row.id })) throw new ForbiddenError("A supplier's bank details are finance's: you need purchasing.bank.view.")
  return row
}

async function tasksOf(db: Reader, accountIds: readonly string[]) {
  if (accountIds.length === 0) return new Map<string, { id: string; status: string; requestedAt: Date; approverRoleId: string | null; approverUserId: string | null; dueAt: Date | null }>()
  const rows = await db.approvalTask.findMany({
    where: { kind: KIND, recordType: 'SupplierBankAccount', recordId: { in: [...accountIds] } },
    select: { id: true, recordId: true, status: true, requestedAt: true, approverRoleId: true, approverUserId: true, dueAt: true },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
  })
  const newest = new Map<string, (typeof rows)[number]>()
  for (const row of rows) if (!newest.has(row.recordId)) newest.set(row.recordId, row)
  return newest
}

/** GET /purchasing/suppliers/:partyId/bank (and every write's answer). */
export async function getBank(caller: CommandCaller, partyId: string) {
  const supplier = await bankSupplier(caller, partyId)
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const read = await caller.withClient(async (client) => {
    const accounts = await readAccounts(client, supplier.id)
    const onFile = await onFileOf(client, supplier.id)
    const names = await peopleNames(client, namedIn(accounts))
    const tasks = await tasksOf(client, accounts.map((row) => row.id))
    const files = accounts.length === 0 ? [] : await client.storedFile.findMany({ where: { recordType: 'SupplierBankAccount', recordId: { in: accounts.map((row) => row.id) }, status: { not: 'DELETED' } }, select: { id: true, recordId: true, originalName: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return { accounts, onFile, names, tasks, files }
  })
  const onFileById = new Map(read.onFile.map((row) => [row.id, row]))
  const mays = {
    propose: mayWrite(actor, PURCHASING_BANK_PROPOSE, supplier),
    callBack: mayWrite(actor, PURCHASING_BANK_CALL_BACK, supplier),
    verify: mayWrite(actor, PURCHASING_BANK_VERIFY, supplier),
    reveal: can(actor, PURCHASING_BANK_REVEAL, { companyId: supplier.companyId, partyId: supplier.id }),
  }
  const me = context.actorId
  const candidate = (row: OnFile) => ({ kind: row.kind, id: row.id, label: row.label, phone: row.phone })
  const accounts = read.accounts.map((row) => {
    const status = row.status as BankAccountStatus
    const own = askersOfAccount(factsOf(row)).includes(me)
    const task = read.tasks.get(row.id) ?? null
    const waitingYes = task?.status === 'PENDING'
    const candidates = status === 'PROPOSED' && row.callBackAt === null ? callBackCandidates(read.onFile, row.proposedAt) : null
    const callBackHeld = status !== 'PROPOSED' || row.callBackAt !== null ? BANK_REFUSALS.calledBack : !mays.callBack ? 'You need purchasing.bank.callBack.' : own ? BANK_REFUSALS.ownCallBack : null
    const verifyHeld = !isOpen(status) ? BANK_REFUSALS.notOpen : row.callBackAt === null ? BANK_REFUSALS.notCalledBack : !mays.verify ? 'You need purchasing.bank.verify.' : own ? BANK_REFUSALS.ownCheck : waitingYes ? BANK_REFUSALS.waitingYes : null
    const view = accountView(row, read.names, onFileById)
    return {
      ...view,
      pillWords: PILL_WORDS[view.pill],
      files: read.files.filter((file) => file.recordId === row.id).map((file) => ({ id: file.id, name: file.originalName, status: file.status })),
      approval: task ? { taskId: task.id, status: task.status, requestedAt: task.requestedAt.toISOString(), approverRoleId: task.approverRoleId, approverUserId: task.approverUserId, dueAt: task.dueAt ? task.dueAt.toISOString() : null } : null,
      callBackCandidates: candidates ? { usable: candidates.usable.map(candidate), held: candidates.held.map((entry) => ({ ...candidate(entry), hold: entry.hold, words: CANDIDATE_HOLD_WORDS[entry.hold] })) } : null,
      may: { callBack: callBackHeld === null, verify: verifyHeld === null, refuse: mays.verify && isOpen(status), retire: mays.verify && status === 'ACTIVE', reveal: mays.reveal },
      heldWhy: { callBack: callBackHeld, verify: verifyHeld },
    }
  })
  const payable = read.accounts.filter((row) => row.status === 'ACTIVE').map((row) => ({ currency: row.currency, accountId: row.id }))
  return {
    supplier: { id: supplier.id, code: supplier.code, name: supplier.tradeName ?? supplier.legalName, companyId: supplier.companyId },
    accounts,
    payable,
    emptyWords: payable.length === 0 ? 'No bank account — payments to this supplier are held.' : null,
    may: { propose: mays.propose },
  }
}

/** The account of this supplier, in the command (404 for another party's). */
async function accountIn(tools: CommandTools, partyId: string, accountId: string): Promise<AccountRow> {
  await lockAccount(tools.tx, accountId)
  const row = await readAccount(tools.tx, accountId)
  if (!row || row.partyId !== partyId) throw new NotFoundError('Bank account not found.')
  return row
}

const notFound = (accountId: string): void => {
  if (!isUuid(accountId)) throw new NotFoundError('Bank account not found.')
}

/**
 * The account as the caller read it, before its command: another party's is not found; a final one (refused, retired) is
 * refused in words here — the command's compare-and-set would otherwise meet the database's "frozen" rule.
 */
async function seenAccount(caller: CommandCaller, partyId: string, accountId: string, allowed: readonly BankAccountStatus[]): Promise<AccountRow> {
  notFound(accountId)
  const row = await caller.withClient((client) => readAccount(client, accountId))
  if (!row || row.partyId !== partyId) throw new NotFoundError('Bank account not found.')
  if (!allowed.includes(row.status as BankAccountStatus)) {
    const words = allowed.length === 1 && allowed[0] === 'ACTIVE' ? BANK_REFUSALS.notActive : BANK_REFUSALS.notOpen
    throw new DomainError('conflict', words, [{ path: 'accountId', message: words }])
  }
  return row
}

/**
 * The proposal, inside a command (the party locked): checked against the party's accounts (not the one in use, not one
 * proposed already, one open change per currency), written PROPOSED replacing the ACTIVE account of its currency. Shared
 * with the portal (`source` PORTAL: the partner scope writes no writer column).
 */
export async function proposeInCommand(tools: CommandTools, party: { readonly id: string; readonly companyId: string | null }, input: ProposalInput, by: { readonly userId: string; readonly source: 'OFFICE' | 'PORTAL' }): Promise<string> {
  const plan = planProposal(input)
  if (!plan.ok) throw new ValidationError(plan.issues[0]!.message, plan.issues)
  const { proposal } = plan
  await lockParty(tools.tx, party.id)
  const rows = await tools.tx.supplierBankAccount.findMany({ where: { partyId: party.id, status: { in: ['PROPOSED', 'VERIFIED', 'ACTIVE'] } }, select: { id: true, status: true, iban: true, currency: true } })
  const conflict = proposalConflict(proposal, rows.map((row) => ({ status: row.status as BankAccountStatus, iban: row.iban, currency: row.currency })))
  if (conflict) throw new ConflictError(conflict)
  const replaces = rows.find((row) => row.status === 'ACTIVE' && row.currency === proposal.currency) ?? null
  const id = newId()
  await tools.tx.supplierBankAccount.create({
    data: {
      id,
      partyId: party.id,
      iban: proposal.iban,
      holder: proposal.holder,
      bankName: proposal.bankName,
      bic: proposal.bic,
      currency: proposal.currency,
      replacesId: replaces?.id ?? null,
      proposedById: by.userId,
      proposedAt: tools.now,
      createdAt: tools.now,
      updatedAt: tools.now,
      // The partner scope may not write who wrote it (B-W2b-287: never name it there); the office's writer is the proposer.
      ...(by.source === 'OFFICE' ? { createdById: by.userId } : {}),
    },
    select: { id: true },
  })
  tools.audit({
    action: 'purchasing.bank.propose',
    recordType: 'SupplierBankAccount',
    recordId: id,
    companyId: party.companyId,
    after: { partyId: party.id, status: 'PROPOSED', masked: maskedIban(proposal.iban.slice(0, 2), proposal.iban.slice(-4)), holder: proposal.holder, bankName: proposal.bankName, bic: proposal.bic, currency: proposal.currency, replacesId: replaces?.id ?? null, source: by.source, ...(by.source === 'PORTAL' ? { byPartner: true, personId: by.userId } : {}) },
  })
  tools.emit(eventFor(proposedEvent, { subject: id, companyId: party.companyId, payload: { accountId: id, partyId: party.id, source: by.source, currency: proposal.currency } }))
  return id
}

/** POST /purchasing/suppliers/:partyId/bank (purchasing.bank.propose, step-up). */
export async function proposeBank(caller: CommandCaller, partyId: string, body: ProposeBody, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const supplier = await bankSupplier(caller, partyId)
  assertMayWrite(context, PURCHASING_BANK_PROPOSE, supplier)
  const plan = planProposal(body)
  if (!plan.ok) throw new ValidationError(plan.issues[0]!.message, plan.issues)
  stepUp()
  const { result } = await command(caller, { name: 'purchasing.bank.propose', idempotencyKey, input: { partyId, ...body } }, async (tools) => ({ accountId: await proposeInCommand(tools, supplier, body, { userId: context.actorId, source: 'OFFICE' }) }))
  return { ...(await getBank(caller, partyId)), accountId: result.accountId }
}

/** POST …/bank/:accountId/call-back (purchasing.bank.callBack). */
export async function callBack(caller: CommandCaller, partyId: string, accountId: string, body: CallBackBody, idempotencyKey?: string) {
  notFound(accountId)
  const context = officeContextOf(caller)
  const supplier = await bankSupplier(caller, partyId)
  assertMayWrite(context, PURCHASING_BANK_CALL_BACK, supplier)
  await seenAccount(caller, supplier.id, accountId, ['PROPOSED'])
  if ((body.contactId === undefined) === (body.addressId === undefined)) throw new ValidationError('Name the contact or the address whose number on file was dialled: one of them.', [{ path: 'body/contactId', message: 'Exactly one of contactId and addressId.' }])
  await command(caller, { name: 'purchasing.bank.callBack', idempotencyKey, input: { partyId, accountId, ...body }, record: { type: 'SupplierBankAccount', id: accountId, expectedVersion: body.version } }, async (tools) => {
    const account = await accountIn(tools, supplier.id, accountId)
    const onFile = (await onFileOf(tools.tx, supplier.id)).find((row) => row.id === (body.contactId ?? body.addressId) && row.kind === (body.contactId ? 'CONTACT' : 'ADDRESS')) ?? null
    const problems = callBackProblems({ account: factsOf(account), byId: context.actorId, candidate: onFile, phone: body.phone })
    if (problems.length > 0) throw refusalOf(problems)
    await tools.tx.supplierBankAccount.update({
      where: { id: account.id },
      data: { callBackAt: tools.now, callBackById: context.actorId, callBackContactId: body.contactId ?? null, callBackAddressId: body.addressId ?? null, callBackPhone: body.phone.trim(), updatedAt: tools.now },
      select: { id: true },
    })
    tools.audit({ action: 'purchasing.bank.callBack', recordType: 'SupplierBankAccount', recordId: account.id, companyId: supplier.companyId, after: { kind: onFile!.kind, onFileId: onFile!.id, phone: body.phone.trim() } })
    tools.emit(eventFor(calledBackEvent, { subject: account.id, companyId: supplier.companyId, payload: { accountId: account.id, partyId: supplier.id, approvalTaskId: null } }))
  })
  return getBank(caller, partyId)
}

/**
 * POST …/bank/:accountId/verify (purchasing.bank.verify, step-up): the second check. A request for a yes already waiting
 * holds it (409 in words); a switched-on SUPPLIER_BANK_CHANGE rule that holds asks one now (asked: the account waits; the
 * approver's yes activates it); else ACTIVE now, the old one retired first.
 */
export async function verify(caller: CommandCaller, partyId: string, accountId: string, body: VersionBody, stepUp: () => void, idempotencyKey?: string) {
  notFound(accountId)
  const context = officeContextOf(caller)
  const supplier = await bankSupplier(caller, partyId)
  assertMayWrite(context, PURCHASING_BANK_VERIFY, supplier)
  await seenAccount(caller, supplier.id, accountId, ['PROPOSED', 'VERIFIED'])
  stepUp()
  const { result } = await command(caller, { name: 'purchasing.bank.verify', idempotencyKey, input: { partyId, accountId, ...body }, record: { type: 'SupplierBankAccount', id: accountId, expectedVersion: body.version } }, async (tools) => {
    const account = await accountIn(tools, supplier.id, accountId)
    const problems = checkProblems(factsOf(account), context.actorId)
    if (problems.length > 0) throw refusalOf(problems)
    const pending = await tools.tx.approvalTask.findFirst({ where: { kind: KIND, recordType: 'SupplierBankAccount', recordId: account.id, status: 'PENDING' }, select: { id: true } })
    if (pending) throw new DomainError('conflict', BANK_REFUSALS.waitingYes, [{ path: 'refusal/WAITING_FOR_YES', message: BANK_REFUSALS.waitingYes }])
    const asked = await askApproval(tools, { kind: KIND, recordId: account.id, requester: { userId: context.actorId } })
    if (asked.asked) {
      tools.audit({ action: 'purchasing.bank.askApproval', recordType: 'SupplierBankAccount', recordId: account.id, companyId: supplier.companyId, after: { approvalTaskId: asked.taskId } })
      return { approval: { taskId: asked.taskId, approverRoleId: asked.approverRoleId, approverUserId: asked.approverUserId, dueAt: asked.dueAt } }
    }
    await activateInCommand(tools, account, supplier.companyId, context.actorId, null)
    return { approval: null }
  })
  return { ...(await getBank(caller, partyId)), approval: result.approval }
}

/** POST …/bank/:accountId/refuse (purchasing.bank.verify): REFUSED with why; a request for a yes on it is taken back. */
export async function refuse(caller: CommandCaller, partyId: string, accountId: string, body: ReasonBody, idempotencyKey?: string) {
  notFound(accountId)
  const context = officeContextOf(caller)
  const supplier = await bankSupplier(caller, partyId)
  assertMayWrite(context, PURCHASING_BANK_VERIFY, supplier)
  await seenAccount(caller, supplier.id, accountId, ['PROPOSED', 'VERIFIED'])
  const reason = refuseReasonOf(body.reason)
  if ('issue' in reason) throw new ValidationError(reason.issue.message, [reason.issue])
  await command(caller, { name: 'purchasing.bank.refuse', idempotencyKey, input: { partyId, accountId, ...body }, record: { type: 'SupplierBankAccount', id: accountId, expectedVersion: body.version } }, async (tools) => {
    const account = await accountIn(tools, supplier.id, accountId)
    if (!isOpen(account.status as BankAccountStatus)) throw new DomainError('conflict', BANK_REFUSALS.notOpen, [{ path: 'accountId', message: BANK_REFUSALS.notOpen }])
    await withdrawPending(tools, { kind: KIND, recordId: account.id, byId: context.actorId })
    await refuseInCommand(tools, account, supplier.companyId, context.actorId, reason.reason, null)
  })
  return getBank(caller, partyId)
}

/** POST …/bank/:accountId/retire (purchasing.bank.verify): the ACTIVE account closed; payments in its currency are held. */
export async function retire(caller: CommandCaller, partyId: string, accountId: string, body: ReasonBody, idempotencyKey?: string) {
  notFound(accountId)
  const context = officeContextOf(caller)
  const supplier = await bankSupplier(caller, partyId)
  assertMayWrite(context, PURCHASING_BANK_VERIFY, supplier)
  await seenAccount(caller, supplier.id, accountId, ['ACTIVE'])
  const reason = retireReasonOf(body.reason)
  if ('issue' in reason) throw new ValidationError(reason.issue.message, [reason.issue])
  await command(caller, { name: 'purchasing.bank.retire', idempotencyKey, input: { partyId, accountId, ...body }, record: { type: 'SupplierBankAccount', id: accountId, expectedVersion: body.version } }, async (tools) => {
    const account = await accountIn(tools, supplier.id, accountId)
    if (account.status !== 'ACTIVE') throw new DomainError('conflict', BANK_REFUSALS.notActive, [{ path: 'accountId', message: BANK_REFUSALS.notActive }])
    await tools.tx.supplierBankAccount.update({ where: { id: account.id }, data: { status: 'RETIRED', retiredAt: tools.now, retireReason: reason.reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'purchasing.bank.retire', recordType: 'SupplierBankAccount', recordId: account.id, companyId: supplier.companyId, before: { status: 'ACTIVE' }, after: { status: 'RETIRED', reason: reason.reason } })
    tools.emit(eventFor(retiredEvent, { subject: account.id, companyId: supplier.companyId, payload: { accountId: account.id, partyId: supplier.id } }))
  })
  return getBank(caller, partyId)
}

/**
 * POST …/bank/:accountId/reveal (purchasing.bank.reveal, step-up): the full IBAN of one account, recorded (who saw it,
 * when). The command keeps no IBAN (its receipt and audit row hold the masked one); the IBAN is read after it.
 */
export async function reveal(caller: CommandCaller, partyId: string, accountId: string, stepUp: () => void) {
  notFound(accountId)
  const context = officeContextOf(caller)
  const supplier = await bankSupplier(caller, partyId)
  if (!can(actorOf(context), PURCHASING_BANK_REVEAL, { companyId: supplier.companyId, partyId: supplier.id })) throw new ForbiddenError('Reading a full IBAN needs purchasing.bank.reveal.')
  stepUp()
  await command(caller, { name: 'purchasing.bank.reveal', input: { partyId, accountId } }, async (tools) => {
    const account = await readAccount(tools.tx, accountId)
    if (!account || account.partyId !== supplier.id) throw new NotFoundError('Bank account not found.')
    tools.audit({ action: 'purchasing.bank.reveal', recordType: 'SupplierBankAccount', recordId: account.id, companyId: supplier.companyId, after: { masked: maskedIban(account.ibanCountry, account.ibanLast4) } })
  })
  const row = await caller.withClient((client) => client.supplierBankAccount.findUnique({ where: { id: accountId }, select: { id: true, iban: true } }))
  if (!row) throw new NotFoundError('Bank account not found.')
  return { accountId: row.id, iban: row.iban, grouped: groupedIban(row.iban) }
}
