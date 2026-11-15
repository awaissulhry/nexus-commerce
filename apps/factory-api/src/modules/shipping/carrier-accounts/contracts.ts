import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { accountNumberProblem, carrierCodeProblem, contractFor, contractWords, liveContractOf, normalCarrierCode, numberEndOf, type ContractRefusalCode } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { SHIPPING_SETTINGS_MANAGE, SHIPPING_SETTINGS_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { events as contractEvents } from '@nexus/factory-domain/shipping-contracts/events'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { SecretsService } from '../../../platform/secrets/envelope'
import { storeSecret } from '../../../platform/secrets/store'
import { assertMay, officeContextOf } from '../access'
import { refusedFor, refusingInWords } from './refusals'

/**
 * Our own carrier contracts per company and site (B-W2b-400; LOG-033 "own carrier contracts; the Owner says which account to
 * use"; design warehouse.shipping "Carrier connection" › "W2b own carrier contracts"; factory-db CarrierAccount, B-W2b-367).
 * Office only: read with shipping.settings.view, kept with shipping.settings.manage on the company (and the site).
 *
 *   GET    /shipping/carrier-contracts?companyId&siteId&carrierCode&includeOff   the live contracts (and the switched-off ones
 *                                     after them with includeOff=true); with siteId: the site's and its company's, `usedForSite` on the
 *                                     one a label of that site and carrier is bought on (the site's, else the company's)
 *   POST   /shipping/carrier-contracts   a new contract: refused first in words when a live one covers the same company, site
 *                                     (or every site) and carrier (409 LIVE_EXISTS), then a fresh step-up (the number is a
 *                                     secret, as the connection's credentials), then ONE command: the number sealed
 *                                     (SecretValue shipping.carrier_account), the row
 *   PATCH  /shipping/carrier-contracts/:id   a new number (fresh step-up; the old SecretValue deleted in the same command)
 *                                     and/or "use only our rates", at the contract's version
 *   POST   /shipping/carrier-contracts/:id/switch-off   switched off for good: no longer used, its number removed (the
 *                                     SecretValue deleted); the row stays (the audit names it). A new contract is a new row
 *
 * The number never comes back: the answer says its last four characters from the request, never kept (not in the audit,
 * the event or the command's receipt). Event shipping.carrier_contract_changed.
 */

const contractChanged = contractEvents.find((event): event is Extract<(typeof contractEvents)[number], { type: 'shipping.carrier_contract_changed' }> => event.type === 'shipping.carrier_contract_changed')!

const CARRIER_ACCOUNT_PURPOSE = 'shipping.carrier_account'

const SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  carrierCode: true,
  accountNumberSecretId: true,
  ownRatesOnly: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  site: { select: { code: true } },
} as const satisfies Prisma.CarrierAccountSelect
type ContractRow = Prisma.CarrierAccountGetPayload<{ select: typeof SELECT }>

const refused = (code: ContractRefusalCode, message: string) => refusedFor(code, message)

function contractViewOf(row: ContractRow, usedForSite: boolean | null = null) {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    siteCode: row.site?.code ?? null,
    carrierCode: row.carrierCode,
    carrierName: carrierNameFor('CARRIER', row.carrierCode) ?? row.carrierCode,
    ownRatesOnly: row.ownRatesOnly,
    active: row.active,
    numberOnFile: row.accountNumberSecretId !== null,
    words: contractWords(row, row.site?.code ?? null),
    usedForSite,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const scopeOf = (row: { companyId: string; siteId: string | null }) => ({ companyId: row.companyId, ...(row.siteId ? { siteId: row.siteId } : {}) })

/** GET /shipping/carrier-contracts (shipping.settings.view on each contract's company and site). */
export async function listContracts(caller: CommandCaller, query: { companyId?: string | undefined; siteId?: string | undefined; carrierCode?: string | undefined; includeOff?: 'true' | 'false' | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const site = query.siteId ? await client.site.findUnique({ where: { id: query.siteId }, select: { id: true, companyId: true } }) : null
    if (query.siteId && (!site || !can(actor, SHIPPING_SETTINGS_VIEW, { companyId: site.companyId, siteId: site.id }))) throw new NotFoundError('Site not found.')
    const where: Prisma.CarrierAccountWhereInput = {
      AND: [
        query.companyId ? { companyId: query.companyId } : {},
        site ? { companyId: site.companyId, OR: [{ siteId: site.id }, { siteId: null }] } : {},
        query.carrierCode ? { carrierCode: normalCarrierCode(query.carrierCode) } : {},
        query.includeOff === 'true' ? {} : { active: true },
      ],
    }
    const rows = (await client.carrierAccount.findMany({ where, select: SELECT, orderBy: [{ companyId: 'asc' }, { carrierCode: 'asc' }, { active: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] })).filter((row) => can(actor, SHIPPING_SETTINGS_VIEW, scopeOf(row)))
    const used = (row: ContractRow) => (site ? contractFor(rows, { companyId: site.companyId, siteId: site.id, carrierCode: row.carrierCode })?.id === row.id : null)
    return { contracts: rows.map((row) => contractViewOf(row, used(row))) }
  })
}

async function readContract(db: CommandTx, contractId: string) {
  return isUuid(contractId) ? db.carrierAccount.findUnique({ where: { id: contractId }, select: SELECT }) : null
}

export interface AddContractBody {
  readonly companyId: string
  readonly siteId?: string | null | undefined
  readonly carrierCode: string
  readonly accountNumber: string
  readonly ownRatesOnly?: boolean | undefined
}

const fieldProblems = (problems: (Issue | null)[]): void => {
  const found = problems.filter((problem): problem is Issue => problem !== null)
  if (found.length > 0) throw new ValidationError(found.length === 1 ? found[0]!.message : 'The contract is not valid.', found)
}

/** The live contract of the same company, site (or every site) and carrier, read in the command under a lock of its rows. */
async function liveInScope(db: CommandTx, scope: { companyId: string; siteId: string | null; carrierCode: string }) {
  const rows = await db.carrierAccount.findMany({ where: { companyId: scope.companyId, carrierCode: scope.carrierCode, active: true }, select: { id: true, companyId: true, siteId: true, carrierCode: true, active: true } })
  return liveContractOf(rows, scope)
}

const liveExists = (carrierCode: string, siteCode: string | null) =>
  refused('LIVE_EXISTS', `A live contract with ${carrierNameFor('CARRIER', carrierCode) ?? carrierCode} ${siteCode ? `for site ${siteCode}` : 'for every site of the company'} exists: replace its number, or switch it off first.`)

/** POST /shipping/carrier-contracts: a new contract (see the file's comment). */
export async function addContract(secrets: SecretsService, caller: CommandCaller, body: AddContractBody, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const carrierCode = normalCarrierCode(body.carrierCode)
  const siteId = body.siteId ?? null
  fieldProblems([carrierCodeProblem(carrierCode), accountNumberProblem(body.accountNumber)])
  const { site } = await caller.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: body.companyId }, select: { id: true } })
    const found = siteId ? await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, code: true } }) : null
    assertMay(context, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_MANAGE, company ? { companyId: company.id, ...(found ? { siteId: found.id } : {}) } : null, 'Company')
    if (siteId && found?.companyId !== body.companyId) throw new ValidationError('The site is not one of this company’s.', [{ path: 'body/siteId', message: 'Name a site of the company, or none (every site).' }])
    if (await liveInScope(client, { companyId: body.companyId, siteId, carrierCode })) throw liveExists(carrierCode, found?.code ?? null)
    return { site: found }
  })
  stepUp()
  const contractId = newId()
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'shipping.addCarrierContract', idempotencyKey, input: { companyId: body.companyId, siteId, carrierCode, ownRatesOnly: body.ownRatesOnly ?? false } }, async (tools) => {
      const { tx, now } = tools
      // The company's contracts with the carrier, in order: a second desk adding the same one waits here, then is refused.
      await tx.$queryRaw`SELECT 1 FROM "CarrierAccount" WHERE "companyId" = ${body.companyId}::uuid AND "carrierCode" = ${carrierCode} AND "active" ORDER BY "id" FOR UPDATE`
      if (await liveInScope(tx, { companyId: body.companyId, siteId, carrierCode })) throw liveExists(carrierCode, site?.code ?? null)
      const sealed = await storeSecret(tools, secrets, { purpose: CARRIER_ACCOUNT_PURPOSE, plaintext: body.accountNumber.trim() })
      await tx.carrierAccount.create({
        data: { id: contractId, companyId: body.companyId, siteId, carrierCode, accountNumberSecretId: sealed.id, ownRatesOnly: body.ownRatesOnly ?? false, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
        select: { id: true },
      })
      tools.audit({ recordType: 'CarrierAccount', recordId: contractId, companyId: body.companyId, siteId, after: { carrierCode, siteId, ownRatesOnly: body.ownRatesOnly ?? false, accountNumber: 'sealed' } })
      tools.emit(eventFor(contractChanged, { subject: contractId, companyId: body.companyId, siteId, payload: { contractId, siteId, carrierCode, change: 'ADDED' } }))
      return { contractId }
    }),
  )
  const row = await caller.withClient((client) => readContract(client, result.contractId))
  return { contract: contractViewOf(row!), endsIn: numberEndOf(body.accountNumber) }
}

/** The contract the caller may see (else 404) and keep (else 403). */
async function keptContract(caller: CommandCaller, contractId: string): Promise<ContractRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readContract(client, contractId))
  assertMay(context, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_MANAGE, row ? scopeOf(row) : null, 'Carrier contract')
  return row!
}

const switchedOff = () => refused('SWITCHED_OFF', 'This contract is switched off: it changes no more. Add a new contract instead.')

/** Inside a command: the contract as it stands (still live), its row guarded by the command's record. */
async function liveRow(tools: CommandTools, contractId: string): Promise<ContractRow> {
  const row = await readContract(tools.tx, contractId)
  if (!row) throw new NotFoundError('Carrier contract not found.')
  if (!row.active) throw switchedOff()
  return row
}

export interface ChangeContractBody {
  readonly version: number
  readonly accountNumber?: string | undefined
  readonly ownRatesOnly?: boolean | undefined
}

/** PATCH /shipping/carrier-contracts/:id: a new number (fresh step-up) and/or "use only our rates". */
export async function changeContract(secrets: SecretsService, caller: CommandCaller, contractId: string, body: ChangeContractBody, stepUp: () => void, idempotencyKey?: string) {
  const seen = await keptContract(caller, contractId)
  if (body.accountNumber === undefined && body.ownRatesOnly === undefined) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send a new account number or "use only our rates".' }])
  if (body.accountNumber !== undefined) fieldProblems([accountNumberProblem(body.accountNumber)])
  if (!seen.active) throw switchedOff()
  if (body.accountNumber !== undefined) stepUp()
  await refusingInWords(() =>
    command(
      caller,
      { name: 'shipping.changeCarrierContract', idempotencyKey, input: { contractId, version: body.version, newNumber: body.accountNumber !== undefined, ownRatesOnly: body.ownRatesOnly ?? null }, record: { type: 'CarrierAccount', id: contractId, expectedVersion: body.version } },
      async (tools) => {
        const { tx } = tools
        const row = await liveRow(tools, contractId)
        const ownRatesOnly = body.ownRatesOnly ?? row.ownRatesOnly
        const sealed = body.accountNumber === undefined ? null : await storeSecret(tools, secrets, { purpose: CARRIER_ACCOUNT_PURPOSE, plaintext: body.accountNumber.trim() })
        await tx.carrierAccount.update({ where: { id: contractId }, data: { ownRatesOnly, ...(sealed ? { accountNumberSecretId: sealed.id } : {}) }, select: { id: true } })
        if (sealed && row.accountNumberSecretId) await tx.secretValue.delete({ where: { id: row.accountNumberSecretId }, select: { id: true } })
        const changes = [...(sealed ? (['NUMBER_REPLACED'] as const) : []), ...(ownRatesOnly !== row.ownRatesOnly ? (['RATES_CHANGED'] as const) : [])]
        tools.audit({
          recordType: 'CarrierAccount',
          recordId: contractId,
          companyId: row.companyId,
          siteId: row.siteId,
          before: { ownRatesOnly: row.ownRatesOnly, accountNumber: row.accountNumberSecretId ? 'sealed' : null },
          after: { ownRatesOnly, accountNumber: sealed ? 'replaced' : row.accountNumberSecretId ? 'sealed' : null },
        })
        for (const change of changes) tools.emit(eventFor(contractChanged, { subject: contractId, companyId: row.companyId, siteId: row.siteId, payload: { contractId, siteId: row.siteId, carrierCode: row.carrierCode, change } }))
        return { changes }
      },
    ),
  )
  const row = await caller.withClient((client) => readContract(client, contractId))
  return { contract: contractViewOf(row!), endsIn: body.accountNumber === undefined ? null : numberEndOf(body.accountNumber) }
}

/** POST /shipping/carrier-contracts/:id/switch-off: no longer used; its number removed; the row stays. */
export async function switchOffContract(caller: CommandCaller, contractId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const seen = await keptContract(caller, contractId)
  if (!seen.active) throw switchedOff()
  await refusingInWords(() =>
    command(caller, { name: 'shipping.switchOffCarrierContract', idempotencyKey, input: { contractId, version: body.version }, record: { type: 'CarrierAccount', id: contractId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const row = await liveRow(tools, contractId)
      await tx.carrierAccount.update({ where: { id: contractId }, data: { active: false, accountNumberSecretId: null }, select: { id: true } })
      if (row.accountNumberSecretId) await tx.secretValue.delete({ where: { id: row.accountNumberSecretId }, select: { id: true } })
      tools.audit({ recordType: 'CarrierAccount', recordId: contractId, companyId: row.companyId, siteId: row.siteId, before: { active: true, accountNumber: row.accountNumberSecretId ? 'sealed' : null }, after: { active: false, accountNumber: null } })
      tools.emit(eventFor(contractChanged, { subject: contractId, companyId: row.companyId, siteId: row.siteId, payload: { contractId, siteId: row.siteId, carrierCode: row.carrierCode, change: 'SWITCHED_OFF' } }))
      return { contractId }
    }),
  )
  const row = await caller.withClient((client) => readContract(client, contractId))
  return { contract: contractViewOf(row!) }
}
