import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { eventFor } from '@nexus/factory-domain/events/define'
import { carrierCodeProblem, normalCarrierCode } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { SHIPPING_SETTINGS_MANAGE, SHIPPING_SETTINGS_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { CARRIER_SERVICES, chosenServicesOf, providerContractsOf, SERVICE_WORDS, withChosenServices, type CarrierService } from '@nexus/factory-domain/shipping/services/catalogue'
import { events as contractEvents } from '@nexus/factory-domain/shipping-contracts/events'
import type { Prisma } from '@nexus/factory-db'
import { SENDCLOUD_SERVICE_MAPPING } from '../../../adapters/sendcloud/services'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMay, officeContextOf } from '../access'
import { refusingInWords } from '../carrier-accounts/refusals'

/**
 * The carrier services chosen for live use (B-W2b-400; Owner answer Q20: "a service the plan does not include stays on the fake
 * until you choose, the exact cost first"; design warehouse.shipping "Carrier connection"). Per company Sendcloud connection
 * (IntegrationAccount provider SENDCLOUD of the company), in its settings (not secret): `services` and `contracts`.
 *
 *   GET /shipping/carrier-services?companyId     shipping.settings.view: each connection, every service with whether it is
 *                                                chosen, how Sendcloud's API takes it (mapped, verified), what it does and
 *                                                what it costs in words; the carriers whose own contract Sendcloud knows (its
 *                                                contract id). Nothing is chosen by default: live bookings that need a
 *                                                service are refused until the Owner chooses it
 *   PUT /shipping/carrier-services/:accountId     shipping.settings.manage on the connection's company, at its version: the
 *                                                services chosen and the contract ids. Choosing a service or naming a
 *                                                contract asks a fresh step-up (from then on Sendcloud and the carrier
 *                                                charge for it); taking one off does not. A service Sendcloud's API does
 *                                                not take (the customer's account) cannot be chosen. Event
 *                                                shipping.carrier_services_changed
 *
 * A FAKE connection (local and test) books every service on the fake whatever is chosen; test mode needs no connection.
 */

const servicesChanged = contractEvents.find((event): event is Extract<(typeof contractEvents)[number], { type: 'shipping.carrier_services_changed' }> => event.type === 'shipping.carrier_services_changed')!

const SELECT = { id: true, companyId: true, code: true, label: true, mode: true, status: true, settings: true, version: true } as const satisfies Prisma.IntegrationAccountSelect
type AccountRow = Prisma.IntegrationAccountGetPayload<{ select: typeof SELECT }>

function viewOf(row: AccountRow) {
  const chosen = chosenServicesOf(row.settings)
  return {
    accountId: row.id,
    companyId: row.companyId!,
    code: row.code,
    label: row.label,
    mode: row.mode,
    status: row.status,
    version: row.version,
    services: CARRIER_SERVICES.map((service) => ({
      service,
      chosen: chosen.includes(service),
      mapped: SENDCLOUD_SERVICE_MAPPING[service].mapped,
      verified: SENDCLOUD_SERVICE_MAPPING[service].verified,
      words: SERVICE_WORDS[service].words,
      costWords: SERVICE_WORDS[service].cost,
    })),
    contracts: [...providerContractsOf(row.settings).entries()].map(([carrierCode, providerContractId]) => ({ carrierCode, providerContractId })),
    words:
      row.mode === 'FAKE'
        ? 'A FAKE connection (local and test): every service is booked on the fake, nothing is charged, whatever is chosen.'
        : chosen.length === 0
          ? 'No service is chosen for live use: bookings that need one are refused, the services stay on the fake until chosen.'
          : `Chosen for live use: ${chosen.join(', ')}. Sendcloud and the carriers charge them at their price.`,
  }
}

/** GET /shipping/carrier-services?companyId (each company's own Sendcloud connections the reader reaches). */
export async function listCarrierServices(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const actor = actorOf(officeContextOf(caller))
  const rows = await caller.withClient((client) =>
    client.integrationAccount.findMany({ where: { provider: 'SENDCLOUD', companyId: query.companyId ? query.companyId : { not: null }, status: { not: 'DISABLED' } }, select: SELECT, orderBy: [{ companyId: 'asc' }, { code: 'asc' }] }),
  )
  return { connections: rows.filter((row) => row.companyId !== null && can(actor, SHIPPING_SETTINGS_VIEW, { companyId: row.companyId })).map(viewOf) }
}

export interface CarrierServicesBody {
  readonly version: number
  readonly services: readonly CarrierService[]
  readonly contracts: readonly { readonly carrierCode: string; readonly providerContractId: number }[]
}

/** PUT /shipping/carrier-services/:accountId (see the file's comment). */
export async function setCarrierServices(caller: CommandCaller, accountId: string, body: CarrierServicesBody, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const row = isUuid(accountId) ? await caller.withClient((client) => client.integrationAccount.findFirst({ where: { id: accountId, provider: 'SENDCLOUD', companyId: { not: null } }, select: SELECT })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_MANAGE, row?.companyId ? { companyId: row.companyId } : null, 'Sendcloud connection')
  const unmapped = body.services.filter((service) => !SENDCLOUD_SERVICE_MAPPING[service].mapped)
  if (unmapped.length > 0) throw new ValidationError(`Sendcloud's API does not take ${unmapped.join(', ')} (not mapped): it cannot be chosen for live use.`, [{ path: 'body/services', message: 'Choose only services Sendcloud takes.' }])
  const contracts = new Map<string, number>()
  for (const [index, entry] of body.contracts.entries()) {
    const problem = carrierCodeProblem(entry.carrierCode, `body/contracts/${index}/carrierCode`)
    if (problem) throw new ValidationError(problem.message, [problem])
    const code = normalCarrierCode(entry.carrierCode)
    if (contracts.has(code)) throw new ValidationError(`${code} is named twice.`, [{ path: `body/contracts/${index}/carrierCode`, message: 'One contract id per carrier.' }])
    contracts.set(code, entry.providerContractId)
  }
  const chosenBefore = chosenServicesOf(row!.settings)
  const contractsBefore = providerContractsOf(row!.settings)
  const adds = body.services.some((service) => !chosenBefore.includes(service)) || [...contracts.entries()].some(([code, id]) => contractsBefore.get(code) !== id)
  if (adds) stepUp()
  await refusingInWords(() =>
    command(caller, { name: 'shipping.setCarrierServices', idempotencyKey, input: { accountId, ...body }, record: { type: 'IntegrationAccount', id: accountId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const current = await tx.integrationAccount.findUnique({ where: { id: accountId }, select: SELECT })
      if (!current) throw new NotFoundError('Sendcloud connection not found.')
      const settings = withChosenServices(current.settings, body.services, contracts)
      await tx.integrationAccount.update({ where: { id: accountId }, data: { settings: settings as Prisma.InputJsonValue }, select: { id: true } })
      tools.audit({
        recordType: 'IntegrationAccount',
        recordId: accountId,
        companyId: current.companyId,
        before: { services: chosenServicesOf(current.settings), contracts: Object.fromEntries(providerContractsOf(current.settings)) },
        after: { services: settings.services, contracts: settings.contracts },
      })
      tools.emit(eventFor(servicesChanged, { subject: accountId, companyId: current.companyId, payload: { accountId, services: chosenServicesOf(settings), contractCarriers: [...contracts.keys()].sort() } }))
      return { accountId }
    }),
  )
  const after = await caller.withClient((client) => client.integrationAccount.findUniqueOrThrow({ where: { id: accountId }, select: SELECT }))
  return { connection: viewOf(after) }
}
