import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { bankDetailsOf, maskIban, type BankDetailsInput } from '@nexus/factory-domain/sales/deposits/bank'
import { COMPANY_BANK_MANAGE, COMPANY_BANK_VIEW } from '@nexus/factory-domain/sales/deposits/permissions'
import type { BankDetails } from '@nexus/factory-domain/sales/deposits/deposits'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf } from '../quotes/store'

/**
 * A company's bank account (B-W1-24; Q12: deposits are paid by bank transfer; FatturaPA DatiPagamento MP05; A1 §3.10:
 * bank details need a step-up): office only, can() on the company.
 *
 *   GET /companies/:companyId/bank-details    companies.bank.view: the holder, IBAN, BIC and bank, and the row's version
 *   PUT /companies/:companyId/bank-details    companies.bank.manage + a fresh step-up: set, change or remove it (every
 *                                             field empty). ONE command on the Company (its version guards it): the
 *                                             domain's checks (factory-domain sales/deposits/bank: a SEPA country, its
 *                                             length, the check digits), the audit row from → to, and the event
 *                                             company.bank_details_changed (the IBAN masked) that tells the owners and
 *                                             administrators (live: companies.bank.view). The …_company_bank_details_guards
 *                                             trigger holds the shape for every login.
 */

const COLUMNS = { id: true, bankAccountHolder: true, iban: true, bic: true, bankName: true, version: true, updatedAt: true } as const

function assertCompany(context: OfficeContext, companyId: string, permission: typeof COMPANY_BANK_VIEW | typeof COMPANY_BANK_MANAGE): void {
  const actor = actorOf(context)
  if (!isUuid(companyId) || !can(actor, COMPANY_BANK_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  if (!can(actor, permission, { companyId })) throw new ForbiddenError()
}

const viewOf = (row: { id: string; bankAccountHolder: string | null; iban: string | null; bic: string | null; bankName: string | null; version: number; updatedAt: Date }) => ({
  companyId: row.id,
  bank: row.iban !== null && row.bankAccountHolder !== null ? { accountHolder: row.bankAccountHolder, iban: row.iban, bic: row.bic, bankName: row.bankName } : null,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

export async function getBankDetails(caller: CommandCaller, companyId: string) {
  const context = officeContextOf(caller)
  assertCompany(context, companyId, COMPANY_BANK_VIEW)
  const row = await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: COLUMNS }))
  if (!row) throw new NotFoundError('Company not found.')
  return viewOf(row)
}

export interface BankDetailsBody extends BankDetailsInput {
  readonly version: number
}

const plain = (bank: BankDetails | null) => ({ accountHolder: bank?.accountHolder ?? null, iban: bank?.iban ?? null, bic: bank?.bic ?? null, bankName: bank?.bankName ?? null })

/** Sets, changes or removes the account (see the module comment). `stepUp` throws without a fresh one. */
export async function saveBankDetails(caller: CommandCaller, companyId: string, body: BankDetailsBody, idempotencyKey: string | undefined, stepUp: () => void) {
  const context = officeContextOf(caller)
  assertCompany(context, companyId, COMPANY_BANK_MANAGE)
  stepUp()
  const checked = bankDetailsOf(body)
  if ('issues' in checked) throw new ValidationError(checked.issues[0]!.message, checked.issues)
  const after = plain(checked.value)
  const { result } = await command(caller, { name: 'companies.bank.save', idempotencyKey, input: { companyId, ...body }, record: { type: 'Company', id: companyId, expectedVersion: body.version } }, async (tools) => {
    const current = (await tools.tx.company.findUnique({ where: { id: companyId }, select: COLUMNS }))!
    const before = { accountHolder: current.bankAccountHolder, iban: current.iban, bic: current.bic, bankName: current.bankName }
    const fields = (Object.keys(after) as (keyof typeof after)[]).filter((key) => after[key] !== before[key])
    if (fields.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'The bank account is already this.' }])
    const row = await tools.tx.company.update({ where: { id: companyId }, data: { bankAccountHolder: after.accountHolder, iban: after.iban, bic: after.bic, bankName: after.bankName }, select: COLUMNS })
    tools.audit({ action: 'companies.bank.save', recordType: 'Company', recordId: companyId, companyId, before, after: { ...after } })
    tools.emit({ type: 'company.bank_details_changed', subject: companyId, companyId, payload: { companyId, fields, ibanBefore: maskIban(before.iban), ibanAfter: maskIban(after.iban) } })
    return viewOf(row)
  })
  return result
}
