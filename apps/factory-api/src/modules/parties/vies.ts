import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { PartyView, ViesCheckBody, ViesCheckView, ViesHistoryQuery, ViesStandingView } from '@nexus/factory-domain/parties/contracts'
import { PARTIES_VIES } from '@nexus/factory-domain/parties/permissions'
import { identityAt } from '@nexus/factory-domain/parties/tax'
import { viesNotApplicableReason, viesRequesterOf, viesStanding, viesTargetOf, type ViesResult } from '@nexus/factory-domain/parties/vies'
import { VIES_CHECK_OPERATION, type ViesRequest } from '@nexus/factory-domain/ports/vies'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import { FakeVies } from '../../adapters/vies/fake'
import { ViesFault, type ViesAdapter } from '../../adapters/vies/port'
import { viesSoapAdapter } from '../../adapters/vies/soap'
import { command, type CommandCaller } from '../../core/command'
import { serverClock } from '../../core/time'
import { loadFactoryEnv } from '../../env'
import { gatewayAccount, GatewayCallFailed, GatewayRefusal, ProviderError, type Gateway } from '../../platform/gateway/gateway'
import { processGateway } from '../../platform/gateway/service'
import { decodeInstantCursor, encodeInstantCursor } from './cursor'
import { viewInTx } from './parties'
import { assertMayWrite, contextOf, dateText, readParty, standingView, TAX_COLUMNS, taxFieldsOf, today, VIES_COLUMNS, viesCheckViewOf, viesFactsOf } from './store'

/**
 * VIES checks (features SAL-006, SCM-003; art. 41 DL 331/1993; the proof rules: factory-domain parties/vies.ts).
 *
 *   1. the party and its identity (the one in force today, or the one named): an EU VAT number outside Italy;
 *   2. the requester: the party's company (a tenant-wide party: the company named, or the tenant's only one), whose
 *      VAT number identifies the request, so VIES gives the consultation number; parties.vies over that company;
 *   3. the tenant's VIES integration account (the company's own before a tenant-wide one; none is a 409 set-up problem);
 *   4. ONE gateway call `vies.check_vat`, outside any transaction (rate limit, circuit, retries of what may pass later,
 *      one IntegrationCall row), through the account's adapter: FAKE → adapters/vies/fake.ts (local and test only),
 *      LIVE and SANDBOX → adapters/vies/soap.ts;
 *   5. ONE command `parties.checkVies`: the ViesCheck row (append-only; the time the request was SENT, the request id,
 *      the answer: VALID or INVALID with VIES's consultation number, name and address, or ERROR with why), its audit
 *      row and the event party.vies_checked.
 * A check that gets no answer (a VIES fault, a timeout, the network, or a gateway refusal: paused, circuit open, rate
 * limited) is recorded as ERROR, never as a pass: the party's standing is HELD until a check answers. A repeated
 * Idempotency-Key answers the first check from its receipt; the outside call of the repeat is in the ledger only.
 */

// ---- the runtime ---------------------------------------------------------------------------------------------------------

export interface ViesOutcome {
  readonly result: ViesResult
  readonly consultationNumber: string | null
  readonly traderName: string | null
  readonly traderAddress: string | null
  readonly errorCode: string | null
  readonly responseSha256: string | null
}

export interface ViesRuntime {
  /** One check through the gateway for the account; VIES's or the gateway's failures are an ERROR outcome, never a throw. */
  check(caller: CommandCaller, accountId: string, request: ViesRequest): Promise<ViesOutcome>
  /** The FAKE adapter of this process (local and test), or null. */
  readonly fake: FakeVies | null
}

export interface ViesRuntimeOptions {
  readonly gateway: Gateway
  readonly fake: FakeVies | null
  /** LIVE and SANDBOX accounts; default the SOAP adapter. */
  readonly remote?: ViesAdapter
}

const error = (errorCode: string, responseSha256: string | null = null): ViesOutcome => ({ result: 'ERROR', consultationNumber: null, traderName: null, traderAddress: null, errorCode, responseSha256 })

export function createViesRuntime(options: ViesRuntimeOptions): ViesRuntime {
  const remote = options.remote ?? viesSoapAdapter()
  function adapterFor(account: AdapterAccount): ViesAdapter {
    if (account.provider !== 'VIES') throw new ProviderError('This account is not a VIES account.', { retryable: false })
    if (account.mode !== 'FAKE') return remote
    if (!options.fake) throw new ProviderError('A FAKE VIES account needs the fake VIES, which this environment does not have.', { retryable: false })
    return options.fake
  }
  return Object.freeze({
    fake: options.fake,
    async check(caller: CommandCaller, accountId: string, request: ViesRequest): Promise<ViesOutcome> {
      let fault: ViesFault | null = null
      try {
        const answer = await options.gateway.call(
          gatewayAccount(caller, accountId),
          { ...VIES_CHECK_OPERATION, request: { countryCode: request.countryCode, identified: request.requester !== null } },
          async (call) => {
            fault = null
            try {
              return await adapterFor(call.account).check(call, request)
            } catch (thrown) {
              if (thrown instanceof ViesFault) fault = thrown
              throw thrown
            }
          },
        )
        return { result: answer.result, consultationNumber: answer.consultationNumber, traderName: answer.traderName, traderAddress: answer.traderAddress, errorCode: null, responseSha256: answer.responseSha256 }
      } catch (thrown) {
        if (thrown instanceof GatewayRefusal) return error(`GATEWAY_${thrown.reason.toUpperCase()}`)
        if (thrown instanceof GatewayCallFailed) {
          const last = fault as ViesFault | null
          if (last) return error(last.code, last.responseSha256)
          return error(thrown.kind === 'timeout' ? 'CALL_TIMEOUT' : thrown.kind === 'network_error' ? 'NETWORK_ERROR' : 'PROVIDER_ERROR')
        }
        throw thrown
      }
    },
  } satisfies ViesRuntime)
}

let configured: ViesRuntime | undefined
let fromEnv: ViesRuntime | undefined

/** Sets the runtime (tests); undefined goes back to the one made from the environment. */
export function useVies(runtime: ViesRuntime | undefined): void {
  configured = runtime
}

export function processVies(): ViesRuntime {
  if (configured) return configured
  if (!fromEnv) {
    const env = loadFactoryEnv()
    const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
    fromEnv = createViesRuntime({ gateway: processGateway(), fake: local ? new FakeVies() : null })
  }
  return fromEnv
}

// ---- the check ---------------------------------------------------------------------------------------------------------

/** The tenant's VIES account for a company: its own before a tenant-wide one; none, or two at one level, is a set-up problem. */
async function viesAccountOf(caller: CommandCaller, companyId: string): Promise<string> {
  const accounts = await caller.withClient((client) =>
    client.integrationAccount.findMany({ where: { provider: 'VIES', status: { not: 'DISABLED' }, OR: [{ companyId: null }, { companyId }] }, select: { id: true, companyId: true }, orderBy: { id: 'asc' } }),
  )
  const own = accounts.filter((account) => account.companyId === companyId)
  const chosen = own.length > 0 ? own : accounts.filter((account) => account.companyId === null)
  if (chosen.length === 0) throw new ConflictError('VIES is not set up: this tenant has no VIES connection (an integration account of provider VIES).')
  if (chosen.length > 1) throw new ConflictError('This tenant has more than one VIES connection for this company; disable the ones not in use.')
  return chosen[0]!.id
}

/** The company that asks: the party's own, else the one named, else the tenant's only active company. */
async function requesterCompanyOf(caller: CommandCaller, partyCompanyId: string | null, named: string | undefined) {
  if (partyCompanyId !== null && named !== undefined && named !== partyCompanyId) {
    throw new ValidationError('The check is asked by the party\'s own company.', [{ path: 'body/companyId', message: "Leave it out, or name the party's company." }])
  }
  const companyId = partyCompanyId ?? named
  const companies = await caller.withClient((client) =>
    client.company.findMany({ where: { status: 'ACTIVE', ...(companyId ? { id: companyId } : {}) }, select: { id: true, code: true, vatNumber: true }, take: 2 }),
  )
  if (companies.length === 0) throw new ValidationError('No such company.', [{ path: 'body/companyId', message: 'Expected an active company of the tenant.' }])
  if (companies.length > 1) throw new ValidationError('Say which company asks.', [{ path: 'body/companyId', message: 'A party for every company is checked for one of them: name it.' }])
  return companies[0]!
}

/**
 * parties.checkVies: checks the party's EU VAT number with VIES and keeps the answer (201 with the check and the
 * standing it leaves). An answer of no answer is recorded too: the result is ERROR and the standing HELD.
 */
export async function checkVies(caller: CommandCaller, partyId: string, body: ViesCheckBody, idempotencyKey?: string): Promise<{ check: ViesCheckView; vies: ViesStandingView; party: PartyView }> {
  const context = contextOf(caller)
  const party = await readParty(caller, partyId)
  if (party.status === 'ARCHIVED') throw new ConflictError('This party is archived: reactivate it before checking it.')
  const identities = await caller.withClient((client) => client.partyTaxIdentity.findMany({ where: { partyId }, select: TAX_COLUMNS }))
  const identity = body.taxIdentityId
    ? (identities.find((row) => row.id === body.taxIdentityId) ?? null)
    : (identityAt(identities.map((row) => ({ row, validFrom: dateText(row.validFrom) })), today())?.row ?? null)
  if (body.taxIdentityId && !identity) throw new NotFoundError('Tax identity not found.')
  const fields = identity ? taxFieldsOf(identity) : null
  const target = viesTargetOf(fields)
  if (!identity || !target) throw new ConflictError(viesNotApplicableReason(fields) ?? 'VIES does not apply to this party.')
  const company = await requesterCompanyOf(caller, party.companyId, body.companyId)
  assertMayWrite(context, PARTIES_VIES, { id: party.id, companyId: company.id })
  const requester = viesRequesterOf(company.vatNumber)
  if (!requester) throw new ConflictError(`Company ${company.code} has no VAT number: VIES gives a consultation number (the proof) only to a check that names our VAT number.`)
  const accountId = await viesAccountOf(caller, company.id)

  const requestedAt = serverClock.now()
  const outcome = await processVies().check(caller, accountId, { countryCode: target.countryCode, vatNumber: target.vatNumber, requester })

  const { result } = await command(caller, { name: 'parties.checkVies', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    const { tx } = tools
    const id = newId()
    const row = await tx.viesCheck.create({
      data: {
        id,
        partyId,
        taxIdentityId: identity.id,
        companyId: company.id,
        countryCode: target.countryCode,
        vatNumber: target.vatNumber,
        requesterVatNumber: `${requester.countryCode}${requester.vatNumber}`,
        requestedAt,
        result: outcome.result,
        consultationNumber: outcome.result === 'ERROR' ? null : outcome.consultationNumber,
        traderName: outcome.traderName,
        traderAddress: outcome.traderAddress,
        errorCode: outcome.result === 'ERROR' ? outcome.errorCode : null,
        responseSha256: outcome.responseSha256,
        requestId: tools.context.requestId,
        createdAt: tools.now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: VIES_COLUMNS,
    })
    tools.audit({
      recordType: 'ViesCheck',
      recordId: id,
      companyId: party.companyId,
      after: { partyId, taxIdentityId: identity.id, countryCode: row.countryCode, vatNumber: row.vatNumber, result: row.result, consultationNumber: row.consultationNumber, errorCode: row.errorCode },
    })
    tools.emit({ type: 'party.vies_checked', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, viesCheckId: id, taxIdentityId: identity.id, result: row.result } })
    const checks = await tx.viesCheck.findMany({ where: { taxIdentityId: identity.id }, select: VIES_COLUMNS })
    const standing = viesStanding(fields, checks.map(viesFactsOf), tools.now)
    return { check: viesCheckViewOf(row), vies: standingView(standing), party: await viewInTx(tx, partyId, tools.now) }
  })
  return result
}

/** Every VIES check of the party (all its identities), newest first, one page at a time: the proof archive. */
export async function viesHistory(caller: CommandCaller, partyId: string, query: ViesHistoryQuery): Promise<{ checks: ViesCheckView[]; nextCursor: string | null }> {
  await readParty(caller, partyId)
  const cursor = decodeInstantCursor(query.cursor)
  const rows = await caller.withClient((client) =>
    client.viesCheck.findMany({
      where: { partyId, ...(cursor ? { OR: [{ requestedAt: { lt: cursor.at } }, { requestedAt: cursor.at, id: { lt: cursor.id } }] } : {}) },
      select: VIES_COLUMNS,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    }),
  )
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return { checks: page.map(viesCheckViewOf), nextCursor: rows.length > query.limit && last ? encodeInstantCursor({ at: last.requestedAt, id: last.id }) : null }
}
