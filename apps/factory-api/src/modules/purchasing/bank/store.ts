import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { events as qualificationEvents } from '@nexus/factory-domain/supplier-qualification/events'
import { eventFor } from '@nexus/factory-domain/events/define'
import { maskedIban, pillOf, replacedWords, type AccountFacts, type BankAccountStatus, type OnFile } from '@nexus/factory-domain/purchasing/bank/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { Reader } from '../store'

/**
 * Supplier bank accounts (B-W2b-315; SCM-007; B-W2b-287's SupplierBankAccount): the columns each reader takes, the account
 * as the office reads it (masked: the full IBAN only through the step-up reveal), the numbers on file a call-back may dial,
 * and the one activation every path uses (the second check here, and the yes of a SUPPLIER_BANK_CHANGE approval). The
 * …_suppliers_depth_w2b_guards triggers hold the rules for every login.
 */

/** The office's columns WITHOUT the IBAN: lists and answers never carry it (the reveal reads it alone). */
export const ACCOUNT_COLUMNS = {
  id: true,
  partyId: true,
  ibanCountry: true,
  ibanLast4: true,
  bic: true,
  bankName: true,
  holder: true,
  currency: true,
  status: true,
  replacesId: true,
  proposedById: true,
  proposedAt: true,
  callBackAt: true,
  callBackById: true,
  callBackContactId: true,
  callBackAddressId: true,
  callBackPhone: true,
  verifiedAt: true,
  verifiedById: true,
  activatedAt: true,
  refusedAt: true,
  refusedById: true,
  refuseReason: true,
  retiredAt: true,
  retireReason: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SupplierBankAccountSelect
export type AccountRow = Prisma.SupplierBankAccountGetPayload<{ select: typeof ACCOUNT_COLUMNS }>

/**
 * What a supplier's portal reads of its own accounts (the partner grants hide who called and who checked, and the call-back
 * number); the IBAN only masked (B-W2b-287's Decided 1: the partner could read its own full IBAN, we never send it).
 */
export const PARTNER_ACCOUNT_COLUMNS = {
  id: true,
  ibanCountry: true,
  ibanLast4: true,
  bankName: true,
  holder: true,
  currency: true,
  status: true,
  proposedAt: true,
  callBackAt: true,
  activatedAt: true,
  refusedAt: true,
  refuseReason: true,
  retiredAt: true,
  version: true,
} as const satisfies Prisma.SupplierBankAccountSelect
export type PartnerAccountRow = Prisma.SupplierBankAccountGetPayload<{ select: typeof PARTNER_ACCOUNT_COLUMNS }>

const [proposedEvent, calledBackEvent, activatedEvent, refusedEvent, retiredEvent] = qualificationEvents

export { proposedEvent, calledBackEvent, refusedEvent, retiredEvent }

/** A portal proposal is written in the partner scope, where the writer column is not written: the office's has one. */
export const sourceOf = (row: Pick<AccountRow, 'createdById'>): 'OFFICE' | 'PORTAL' => (row.createdById === null ? 'PORTAL' : 'OFFICE')

export const factsOf = (row: AccountRow, iban = ''): AccountFacts => ({
  id: row.id,
  status: row.status as BankAccountStatus,
  iban,
  currency: row.currency,
  proposedById: row.proposedById,
  createdById: row.createdById,
  proposedAt: row.proposedAt,
  callBackAt: row.callBackAt,
})

export const readAccounts = (db: Reader, partyId: string): Promise<AccountRow[]> =>
  db.supplierBankAccount.findMany({ where: { partyId }, select: ACCOUNT_COLUMNS, orderBy: [{ proposedAt: 'desc' }, { id: 'desc' }], take: 200 })

export const readAccount = (db: Reader, accountId: string): Promise<AccountRow | null> => db.supplierBankAccount.findUnique({ where: { id: accountId }, select: ACCOUNT_COLUMNS })

/** The account's row held for this command (its proposal, call-back and check are decided once). */
export async function lockAccount(tx: CommandTx, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "SupplierBankAccount" WHERE id = ${accountId}::uuid FOR UPDATE`
}

/**
 * The party's bank proposals serialised for this command (one open change per currency is decided under it): an advisory
 * lock, which the supplier's portal session may take too (it may not lock the Party row).
 */
export async function lockParty(tx: CommandTx, partyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.supplierBank', ${partyId}::text), 0))`
}

/** The numbers on file a call-back may dial: the party's contacts and addresses with when each was made and last changed. */
export async function onFileOf(db: Reader, partyId: string): Promise<OnFile[]> {
  const contacts = await db.partyContact.findMany({ where: { partyId }, select: { id: true, name: true, phone: true, status: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 })
  const addresses = await db.partyAddress.findMany({ where: { partyId }, select: { id: true, line1: true, city: true, phone: true, status: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 })
  return [
    ...contacts.map((row): OnFile => ({ kind: 'CONTACT', id: row.id, label: row.name, phone: row.phone, createdAt: row.createdAt, updatedAt: row.updatedAt, active: row.status === 'ACTIVE' })),
    ...addresses.map((row): OnFile => ({ kind: 'ADDRESS', id: row.id, label: `${row.line1}, ${row.city}`, phone: row.phone, createdAt: row.createdAt, updatedAt: row.updatedAt, active: row.status === 'ACTIVE' })),
  ]
}

/** The account in a list (masked), its pill and its steps; names from `names`. */
export function accountView(row: AccountRow, names: ReadonlyMap<string, string>, onFile: ReadonlyMap<string, OnFile>) {
  const person = (id: string | null) => (id === null ? null : { id, name: names.get(id) ?? null })
  const dialled = row.callBackContactId ?? row.callBackAddressId
  const where = dialled ? onFile.get(dialled) : undefined
  return {
    id: row.id,
    masked: maskedIban(row.ibanCountry, row.ibanLast4),
    ibanCountry: row.ibanCountry,
    ibanLast4: row.ibanLast4,
    bic: row.bic,
    bankName: row.bankName,
    holder: row.holder,
    currency: row.currency,
    status: row.status as BankAccountStatus,
    pill: pillOf({ status: row.status as BankAccountStatus, callBackAt: row.callBackAt }),
    source: sourceOf(row),
    replacesId: row.replacesId,
    proposedAt: toUtcIso(row.proposedAt),
    proposedBy: person(row.proposedById),
    callBack: row.callBackAt
      ? { at: toUtcIso(row.callBackAt), by: person(row.callBackById), kind: row.callBackContactId ? ('CONTACT' as const) : ('ADDRESS' as const), onFileId: dialled!, label: where?.label ?? null, phone: row.callBackPhone }
      : null,
    verified: row.verifiedAt ? { at: toUtcIso(row.verifiedAt), by: person(row.verifiedById) } : null,
    activatedAt: row.activatedAt ? toUtcIso(row.activatedAt) : null,
    refused: row.refusedAt ? { at: toUtcIso(row.refusedAt), by: person(row.refusedById), reason: row.refuseReason } : null,
    retired: row.retiredAt ? { at: toUtcIso(row.retiredAt), reason: row.retireReason } : null,
    version: row.version,
  }
}

/** The people a list of accounts names. */
export const namedIn = (rows: readonly AccountRow[]): (string | null)[] => rows.flatMap((row) => [row.proposedById, row.callBackById, row.verifiedById, row.refusedById, row.createdById])

/**
 * The second check, inside a command (the account locked): the account payments use in its currency RETIRED first (one
 * ACTIVE per party and currency), then this one checked and ACTIVE in one write, by `byId` (the database refuses who
 * proposed or wrote it, the Owner included). The approval's yes calls it in the approver's command.
 */
export async function activateInCommand(tools: CommandTools, account: AccountRow, companyId: string | null, byId: string, approvalTaskId: string | null): Promise<{ readonly retiredAccountId: string | null }> {
  const { tx, now } = tools
  const active = await tx.supplierBankAccount.findFirst({ where: { partyId: account.partyId, currency: account.currency, status: 'ACTIVE' }, select: { id: true, version: true, ibanLast4: true } })
  if (active && active.id !== account.id) {
    await tx.supplierBankAccount.update({ where: { id: active.id }, data: { status: 'RETIRED', retiredAt: now, retireReason: replacedWords(account.ibanLast4), version: active.version + 1, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'purchasing.bank.retire', recordType: 'SupplierBankAccount', recordId: active.id, companyId, after: { status: 'RETIRED', reason: replacedWords(account.ibanLast4), replacedBy: account.id } })
    tools.emit(eventFor(retiredEvent, { subject: active.id, companyId, payload: { accountId: active.id, partyId: account.partyId } }))
  }
  const current = (await tx.supplierBankAccount.findUnique({ where: { id: account.id }, select: { version: true } }))!
  await tx.supplierBankAccount.update({ where: { id: account.id }, data: { status: 'ACTIVE', verifiedAt: now, verifiedById: byId, activatedAt: now, version: current.version + 1, updatedAt: now }, select: { id: true } })
  tools.audit({
    action: 'purchasing.bank.verify',
    recordType: 'SupplierBankAccount',
    recordId: account.id,
    companyId,
    before: { status: account.status },
    after: { status: 'ACTIVE', masked: maskedIban(account.ibanCountry, account.ibanLast4), currency: account.currency, verifiedById: byId, retiredAccountId: active && active.id !== account.id ? active.id : null, approvalTaskId },
  })
  tools.emit(eventFor(activatedEvent, { subject: account.id, companyId, payload: { accountId: account.id, partyId: account.partyId, currency: account.currency, retiredAccountId: active && active.id !== account.id ? active.id : null, approvalTaskId } }))
  return { retiredAccountId: active && active.id !== account.id ? active.id : null }
}

/** A refusal, inside a command: REFUSED by `byId` with why (the approval's no names its words). */
export async function refuseInCommand(tools: CommandTools, account: AccountRow, companyId: string | null, byId: string, reason: string, approvalTaskId: string | null): Promise<void> {
  const current = (await tools.tx.supplierBankAccount.findUnique({ where: { id: account.id }, select: { version: true } }))!
  await tools.tx.supplierBankAccount.update({ where: { id: account.id }, data: { status: 'REFUSED', refusedAt: tools.now, refusedById: byId, refuseReason: reason, version: current.version + 1, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'purchasing.bank.refuse', recordType: 'SupplierBankAccount', recordId: account.id, companyId, before: { status: account.status }, after: { status: 'REFUSED', refusedById: byId, reason, approvalTaskId } })
  tools.emit(eventFor(refusedEvent, { subject: account.id, companyId, payload: { accountId: account.id, partyId: account.partyId } }))
}

/**
 * For payments (W2b-6): the account payments to a supplier use in a currency — its one ACTIVE account — or null (payments
 * to it are held: "No bank account — payments to this supplier are held"). Never a proposed or checked one.
 */
export async function payableAccountOf(db: Reader, partyId: string, currency: string): Promise<{ readonly id: string; readonly iban: string; readonly bic: string | null; readonly holder: string; readonly currency: string } | null> {
  return db.supplierBankAccount.findFirst({ where: { partyId, currency, status: 'ACTIVE' }, select: { id: true, iban: true, bic: true, holder: true, currency: true } })
}
