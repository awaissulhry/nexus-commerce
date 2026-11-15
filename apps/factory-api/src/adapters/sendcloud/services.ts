import type { CarrierLabelRequest } from '@nexus/factory-domain/ports/carrier'
import type { CarrierService } from '@nexus/factory-domain/shipping/services/catalogue'
import { ProviderError } from '../../platform/gateway/gateway'

/**
 * The booking's services on Sendcloud's API v3 (B-W2b-400; LOG-033, LOG-038, LOG-041, LOG-042; Owner answer Q20: the
 * factory company's own Sendcloud account). sendcloud.ts's announce body is passed through `withServices` for a LIVE or
 * SANDBOX account; the FAKE takes the request as it is (it records the extras: modules/shipping tests read them).
 *
 *   OWN_CONTRACT       ship_with.properties.contract_id = Sendcloud's id of our own contract (registered in Sendcloud's
 *                      panel; the Owner gives it in the carrier services, settings.contracts). The account number itself
 *                      never leaves the factory: it stays sealed
 *   EXPRESS            nothing more: the shipping option code is the express one
 *   DUTIES_PAID / DAP  customs_information.incoterm DDP or DAP                                       UNVERIFIED
 *   PAPERLESS          customs_information.paperless_trade true                                      UNVERIFIED
 *   INSURANCE          parcels[0].additional_insured_price {value, currency}                         UNVERIFIED
 *   CUSTOMER_ACCOUNT   not mapped: Sendcloud's v3 announce is not known to take a receiver's or third party's account, so a
 *                      booking on it is refused here before any call (nothing is bought); it stays on the FAKE until the
 *                      Owner chooses a way (Q20)
 *
 * UNVERIFIED: written from Sendcloud's public v3 reference as known when this was built; check each field against the API
 * with the live account before the Owner chooses the service for live use (SENDCLOUD_SERVICE_MAPPING says which).
 */

/** How each service reaches Sendcloud's v3 announce, and whether the field was checked against a live account. */
export const SENDCLOUD_SERVICE_MAPPING: Readonly<Record<CarrierService, { readonly mapped: boolean; readonly field: string | null; readonly verified: boolean }>> = Object.freeze({
  OWN_CONTRACT: { mapped: true, field: 'ship_with.properties.contract_id', verified: false },
  CUSTOMER_ACCOUNT: { mapped: false, field: null, verified: false },
  EXPRESS: { mapped: true, field: 'ship_with.properties.shipping_option_code', verified: false },
  DUTIES_PAID: { mapped: true, field: 'customs_information.incoterm', verified: false },
  PAPERLESS: { mapped: true, field: 'customs_information.paperless_trade', verified: false },
  INSURANCE: { mapped: true, field: 'parcels[].additional_insured_price', verified: false },
})

type Body = Record<string, unknown>
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The announce body with the request's booking services written in (a request without extras: the body as it is). */
export function withServices<T extends Body>(body: T, request: Pick<CarrierLabelRequest, 'extras'>): T {
  const extras = request.extras
  if (!extras) return body
  if (extras.billing !== null) {
    throw new ProviderError("Sendcloud's API takes no customer's or third party's carrier account on a label: nothing was booked. Book it with the carrier on the customer's account, or let us pay the freight.", { retryable: false })
  }
  const next: Body = { ...body }
  if (extras.contract?.providerContractId) {
    const shipWith = record(next.ship_with)
    next.ship_with = { ...shipWith, properties: { ...record(shipWith.properties), contract_id: extras.contract.providerContractId } }
  }
  if (extras.dutyPayer !== null || extras.paperless) {
    next.customs_information = {
      ...record(next.customs_information),
      ...(extras.dutyPayer !== null ? { incoterm: extras.dutyPayer === 'SENDER' ? 'DDP' : 'DAP' } : {}),
      ...(extras.paperless ? { paperless_trade: true } : {}),
    }
  }
  if (extras.insuredValue !== null && extras.currency !== null && Array.isArray(next.parcels) && next.parcels.length > 0) {
    const [first, ...rest] = next.parcels as unknown[]
    next.parcels = [{ ...record(first), additional_insured_price: { value: extras.insuredValue, currency: extras.currency } }, ...rest]
  }
  return next as T
}
