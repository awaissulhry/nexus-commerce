import type { ApprovalField } from '@nexus/factory-domain/approvals/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { BANK_REFUSALS, maskedIban } from '@nexus/factory-domain/purchasing/bank/rules'
import { PURCHASING_BANK_VIEW } from '@nexus/factory-domain/purchasing/bank/permissions'
import { SUPPLIER_STATUSES } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { activateInCommand, readAccount, refuseInCommand, sourceOf } from '../../../modules/purchasing/bank/store'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * SUPPLIER_BANK_CHANGE (SCM-007; B-W2b-315): a supplier's new bank account (B-W2b-287's SupplierBankAccount) after its
 * call-back, before payments use it. modules/purchasing/bank asks it in the second check's command (`verify`) when a
 * switched-on rule holds; without one the second person checks it directly. Either way the database's own rule holds: the
 * check is never made by who proposed or wrote the account, the Owner included; and the engine's: nobody approves their own
 * request.
 *
 *   facts      the currency, where it was proposed (the office or the supplier's portal), whether it replaces the account
 *              in use, whether the IBAN's country changes from it, the supplier's code and status
 *   snapshot   the account as it would be used (masked IBAN, holder, bank, BIC, currency, what it replaces), who proposed
 *              it and the call-back (who, when, the number on file): any change of it before the yes makes it STALE
 *   yes        ACTIVE, the account it replaces RETIRED first, checked by the approver (supplier_bank_account.activated)
 *   no         REFUSED by the approver with the words of the no
 *   withdrawn / stale   the account stays called back, waiting for its second check
 *
 * A supplier of every company (no company on the party) is asked under the tenant's first company. No money here.
 */

const ACCOUNT_SELECT = {
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
  version: true,
  createdById: true,
  party: { select: { id: true, code: true, legalName: true, tradeName: true, companyId: true, supplierStatus: true } },
  replaces: { select: { ibanCountry: true, ibanLast4: true } },
} as const

async function companyOf(client: Reader, companyId: string | null): Promise<string | null> {
  if (companyId) return companyId
  const first = await client.company.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
  return first?.id ?? null
}

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const row = await client.supplierBankAccount.findUnique({ where: { id: recordId }, select: ACCOUNT_SELECT })
  if (!row) return null
  const companyId = await companyOf(client, row.party.companyId)
  if (!companyId) return null
  const name = row.party.tradeName ?? row.party.legalName
  const masked = maskedIban(row.ibanCountry, row.ibanLast4)
  const held = row.status !== 'PROPOSED' && row.status !== 'VERIFIED' ? BANK_REFUSALS.notOpen : row.callBackAt === null ? BANK_REFUSALS.notCalledBack : null
  return {
    companyId,
    siteId: null,
    label: `Bank details · ${row.party.code} · ${name}`.slice(0, 200),
    summary: `${row.party.code} ${name}: new ${row.currency} account ${masked}${row.replaces ? `, replacing ${maskedIban(row.replaces.ibanCountry, row.replaces.ibanLast4)}` : ''}${row.callBackAt ? `, called back ${toUtcIso(row.callBackAt).slice(0, 10)}` : ''}`.slice(0, 500),
    facts: {
      currency: row.currency,
      source: sourceOf(row),
      replacesActive: row.replacesId !== null,
      countryChanged: row.replaces ? row.replaces.ibanCountry !== row.ibanCountry : false,
      supplierCode: row.party.code,
      supplierStatus: row.party.supplierStatus ?? null,
    },
    snapshot: {
      id: row.id,
      partyId: row.partyId,
      masked,
      holder: row.holder,
      bankName: row.bankName,
      bic: row.bic,
      currency: row.currency,
      replacesId: row.replacesId,
      proposedById: row.proposedById,
      proposedAt: toUtcIso(row.proposedAt),
      callBack: row.callBackAt ? { at: toUtcIso(row.callBackAt), by: row.callBackById, contactId: row.callBackContactId, addressId: row.callBackAddressId, phone: row.callBackPhone } : null,
      status: row.status,
    },
    changes: [{ field: 'status', from: row.status, to: 'ACTIVE' }],
    held,
  }
}

/** The account and its party's company, in the decision's command (null: gone, or no longer waiting for its check). */
async function waiting(tools: CommandTools, task: TaskRef) {
  const account = await readAccount(tools.tx, task.recordId)
  if (!account || (account.status !== 'PROPOSED' && account.status !== 'VERIFIED') || account.callBackAt === null) return null
  const party = await tools.tx.party.findUnique({ where: { id: account.partyId }, select: { companyId: true } })
  return { account, companyId: party?.companyId ?? null }
}

export const SUPPLIER_BANK_CHANGE_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'SUPPLIER_BANK_CHANGE',
  recordType: 'SupplierBankAccount',
  label: { en: 'Supplier bank details', it: 'Coordinate bancarie del fornitore' },
  view: PURCHASING_BANK_VIEW,
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'currency', label: { en: 'currency', it: 'valuta' }, kind: 'text' },
    {
      id: 'source',
      label: { en: 'proposed in', it: 'proposta da' },
      kind: 'choice',
      options: [
        { value: 'OFFICE', label: { en: 'the office (the supplier’s letter)', it: "l'ufficio (lettera del fornitore)" } },
        { value: 'PORTAL', label: { en: 'the supplier’s portal', it: 'il portale del fornitore' } },
      ],
    },
    { id: 'replacesActive', label: { en: 'replaces the account in use', it: 'sostituisce il conto in uso' }, kind: 'yesNo' },
    { id: 'countryChanged', label: { en: 'the IBAN’s country changes', it: "cambia il paese dell'IBAN" }, kind: 'yesNo' },
    { id: 'supplierCode', label: { en: 'supplier code', it: 'codice fornitore' }, kind: 'text' },
    {
      id: 'supplierStatus',
      label: { en: 'supplier status', it: 'stato del fornitore' },
      kind: 'choice',
      options: SUPPLIER_STATUSES.map((status) => ({ value: status, label: { en: status.toLowerCase().replace('_', ' '), it: status.toLowerCase().replace('_', ' ') } })),
    },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT 1 FROM "SupplierBankAccount" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.supplierBankAccount.findMany({
      where: companyId ? { party: { OR: [{ companyId }, { companyId: null }] } } : {},
      orderBy: [{ proposedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true },
    })
    return rows.map((row) => row.id)
  },
  async onApproved(tools: CommandTools, task: TaskRef) {
    const found = await waiting(tools, task)
    if (!found) return
    const decided = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { decidedById: true } })
    const by = decided?.decidedById ?? task.decidedById
    if (!by) return
    await activateInCommand(tools, found.account, found.companyId, by, task.id)
  },
  async onRejected(tools: CommandTools, task: TaskRef) {
    const found = await waiting(tools, task)
    if (!found) return
    const decided = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { rejectReason: true, decidedById: true } })
    const by = decided?.decidedById ?? task.decidedById
    if (!by) return
    const reason = (decided?.rejectReason ?? '').trim().slice(0, 2000) || 'Refused by the approver.'
    await refuseInCommand(tools, found.account, found.companyId, by, reason, task.id)
  },
})
