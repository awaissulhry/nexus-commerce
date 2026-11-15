import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as partyEvents } from '@nexus/factory-domain/parties/events'
import { PARTIES_MANAGE } from '@nexus/factory-domain/parties/permissions'
import { isCustomer, type PartyRole } from '@nexus/factory-domain/parties/rules'
import {
  accountNumberProblem,
  carrierCodeProblem,
  customerAccountProblems,
  FREIGHT_BILLING_WORDS,
  normalCarrierCode,
  numberEndOf,
  serviceCodeProblem,
  type CustomerAccountRefusalCode,
  type FreightBilling,
} from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { SecretsService } from '../../../platform/secrets/envelope'
import { storeSecret } from '../../../platform/secrets/store'
import { assertMayWrite, assertWritable, readParty } from '../../parties/store'
import { officeContextOf } from '../access'
import { refusedFor, refusingInWords } from './refusals'

/**
 * The customer's own carrier account (B-W2b-400; LOG-038 "freight billed to the customer's carrier account": brand orders
 * ship on the customer's account, porto assegnato; design warehouse.shipments "Carrier & label" › "customer's own carrier
 * account", sales.customers "Preferred carrier"; factory-db Party carrierAccountSecretId, defaultCarrierService,
 * freightBilling, B-W2b-367). Office only: read with parties.view, kept with parties.manage on the party (a customer or a
 * brand).
 *
 *   GET /shipping/customer-carrier-accounts/:partyId   its carrier (the preferred carrier), whether a sealed account is on
 *                                                      file (never the number), who the carrier bills, its default service
 *   PUT /shipping/customer-carrier-accounts/:partyId   ONE command at the party's version: a new number sealed
 *                                                      (SecretValue parties.carrier_account; the old one deleted), or the
 *                                                      account removed (the freight back to us unless said), the carrier,
 *                                                      who pays (COLLECT and THIRD_PARTY need the account) and the default
 *                                                      service. W1's party.updated with the fields changed
 *
 * A label of a shipment that goes with the customer's carrier is then billed to that account (services/booking.ts). The
 * partner never reads the account's reference (factory-db: hidden from the partner role).
 */

const partyUpdated = partyEvents.find((event): event is Extract<(typeof partyEvents)[number], { type: 'party.updated' }> => event.type === 'party.updated')!

const PARTY_ACCOUNT_PURPOSE = 'parties.carrier_account'

const SELECT = {
  id: true,
  code: true,
  companyId: true,
  legalName: true,
  tradeName: true,
  roles: true,
  status: true,
  preferredCarrierCode: true,
  carrierAccountSecretId: true,
  defaultCarrierService: true,
  freightBilling: true,
  version: true,
} as const satisfies Prisma.PartySelect
type AccountRow = Prisma.PartyGetPayload<{ select: typeof SELECT }>

const refused = (code: CustomerAccountRefusalCode, message: string) => refusedFor(code, message)

const viewOf = (row: AccountRow) => ({
  partyId: row.id,
  code: row.code,
  name: row.tradeName ?? row.legalName,
  carrierCode: row.preferredCarrierCode,
  carrierName: carrierNameFor('CARRIER', row.preferredCarrierCode),
  accountOnFile: row.carrierAccountSecretId !== null,
  freightBilling: row.freightBilling as FreightBilling,
  freightBillingWords: FREIGHT_BILLING_WORDS[row.freightBilling as FreightBilling],
  defaultCarrierService: row.defaultCarrierService,
  version: row.version,
})

const readAccount = (db: CommandTx, partyId: string) => db.party.findUnique({ where: { id: partyId }, select: SELECT })

/** GET /shipping/customer-carrier-accounts/:partyId (parties.view on the party). */
export async function getCustomerAccount(caller: CommandCaller, partyId: string) {
  officeContextOf(caller)
  await readParty(caller, partyId)
  const row = await caller.withClient((client) => readAccount(client, partyId))
  if (!row) throw new NotFoundError('Party not found.')
  return { account: viewOf(row) }
}

export interface CustomerAccountBody {
  readonly version: number
  readonly carrierCode?: string | null | undefined
  readonly accountNumber?: string | null | undefined
  readonly freightBilling?: FreightBilling | undefined
  readonly defaultCarrierService?: string | null | undefined
}

/** The terms after the change, from the row as it stands (see the file's comment). */
function nextOf(row: AccountRow, body: CustomerAccountBody) {
  const carrierCode = body.carrierCode === undefined ? row.preferredCarrierCode : body.carrierCode === null ? null : normalCarrierCode(body.carrierCode)
  const carrierChanged = carrierCode !== row.preferredCarrierCode
  // Clearing the carrier clears the account and the service with it; another carrier needs its own account.
  const accountOnFile = body.accountNumber === undefined ? row.carrierAccountSecretId !== null && carrierCode !== null : body.accountNumber !== null
  const freightBilling: FreightBilling = body.freightBilling ?? (accountOnFile ? (row.freightBilling as FreightBilling) : 'SENDER')
  const defaultService = body.defaultCarrierService === undefined ? (carrierChanged ? null : row.defaultCarrierService) : body.defaultCarrierService === null ? null : body.defaultCarrierService.trim()
  return { carrierCode, carrierChanged, accountOnFile, freightBilling, defaultService }
}

/** PUT /shipping/customer-carrier-accounts/:partyId (parties.manage on the party). */
export async function setCustomerAccount(secrets: SecretsService, caller: CommandCaller, partyId: string, body: CustomerAccountBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await readParty(caller, partyId)
  assertMayWrite(context, PARTIES_MANAGE, seen)
  assertWritable(seen.status)
  const fields = [
    body.carrierCode === undefined || body.carrierCode === null ? null : carrierCodeProblem(body.carrierCode),
    body.accountNumber === undefined || body.accountNumber === null ? null : accountNumberProblem(body.accountNumber),
    serviceCodeProblem(body.defaultCarrierService),
  ].filter((issue): issue is Issue => issue !== null)
  if (fields.length > 0) throw new ValidationError(fields.length === 1 ? fields[0]!.message : "The customer's carrier terms are not valid.", fields)
  const sent = (['carrierCode', 'accountNumber', 'freightBilling', 'defaultCarrierService'] as const).filter((field) => body[field] !== undefined)
  if (sent.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])

  const check = (row: AccountRow) => {
    if (!isCustomer(row.roles as PartyRole[])) throw refused('NOT_A_CUSTOMER', `${row.code} is not a customer: a carrier account for its freight is a customer's (give it the customer or brand role first).`)
    const next = nextOf(row, body)
    if (next.carrierChanged && row.carrierAccountSecretId !== null && body.accountNumber === undefined && next.carrierCode !== null) {
      throw new ValidationError("The account on file is the customer's account with its present carrier: give its account with the new carrier, or remove the account.", [{ path: 'body/accountNumber', message: 'Give the account with the new carrier, or null to remove it.' }])
    }
    const problems = customerAccountProblems(next)
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : "The customer's carrier terms are not valid.", problems)
    return next
  }
  const first = await caller.withClient((client) => readAccount(client, partyId))
  if (!first) throw new NotFoundError('Party not found.')
  check(first)

  await refusingInWords(() =>
    command(
      caller,
      { name: 'shipping.setCustomerCarrierAccount', idempotencyKey, input: { partyId, version: body.version, carrierCode: body.carrierCode, newNumber: typeof body.accountNumber === 'string', removeNumber: body.accountNumber === null, freightBilling: body.freightBilling, defaultCarrierService: body.defaultCarrierService }, record: { type: 'Party', id: partyId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now } = tools
        const row = await readAccount(tx, partyId)
        if (!row) throw new NotFoundError('Party not found.')
        assertWritable(row.status as never)
        const next = check(row)
        const sealed = typeof body.accountNumber === 'string' ? await storeSecret(tools, secrets, { purpose: PARTY_ACCOUNT_PURPOSE, plaintext: body.accountNumber.trim() }) : null
        const secretId = sealed ? sealed.id : next.accountOnFile ? row.carrierAccountSecretId : null
        await tx.party.update({
          where: { id: partyId },
          data: { preferredCarrierCode: next.carrierCode, carrierAccountSecretId: secretId, freightBilling: next.freightBilling, defaultCarrierService: next.defaultService, updatedAt: now },
          select: { id: true },
        })
        if (row.carrierAccountSecretId && row.carrierAccountSecretId !== secretId) await tx.secretValue.delete({ where: { id: row.carrierAccountSecretId }, select: { id: true } })
        const account = (id: string | null, replaced = false) => (id === null ? null : replaced ? 'replaced' : 'sealed')
        const before = { preferredCarrierCode: row.preferredCarrierCode, carrierAccount: account(row.carrierAccountSecretId), freightBilling: row.freightBilling, defaultCarrierService: row.defaultCarrierService }
        const after = { preferredCarrierCode: next.carrierCode, carrierAccount: account(secretId, sealed !== null && row.carrierAccountSecretId !== null), freightBilling: next.freightBilling, defaultCarrierService: next.defaultService }
        tools.audit({ recordType: 'Party', recordId: partyId, companyId: row.companyId, before, after })
        const changed = (Object.keys(after) as (keyof typeof after)[]).filter((field) => (field === 'carrierAccount' ? sealed !== null || (row.carrierAccountSecretId !== null) !== (secretId !== null) : String(after[field]) !== String(before[field])))
        if (changed.length > 0) tools.emit(eventFor(partyUpdated, { subject: partyId, companyId: row.companyId, payload: { partyId, code: row.code, fields: changed } }))
        return { partyId }
      },
    ),
  )
  const row = await caller.withClient((client) => readAccount(client, partyId))
  return { account: viewOf(row!), endsIn: typeof body.accountNumber === 'string' ? numberEndOf(body.accountNumber) : null }
}
