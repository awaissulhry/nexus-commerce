/**
 * The shape every provider adapter has (plan A1 §4 "Pattern for every adapter"). The port of a capability (MailPort,
 * SdiPort, CarrierPort, …) lives in this folder; its real adapter and its fake live in apps/factory-api/src/adapters/
 * <provider>/, and every call they make to the outside goes through the gateway (apps/factory-api/src/platform/gateway:
 * account state and mode, rate limit, circuit breaker, timeout, retries, one IntegrationCall row per call).
 *
 * Pure types and constants: no I/O.
 */

/** The outside services the factory talks to; the same list as the IntegrationProvider enum of @nexus/factory-db. */
export const INTEGRATION_PROVIDERS = ['SES', 'R2', 'SDI', 'SENDCLOUD', 'VIES', 'STRIPE'] as const
export type IntegrationProviderCode = (typeof INTEGRATION_PROVIDERS)[number]

/**
 * Which system an account's calls reach. LIVE: the provider's production; SANDBOX: its test system; FAKE: the factory's
 * own fake, with no network at all. FAKE is refused in production (the API does not start, the gateway does not call);
 * the UI shows a TEST MODE badge while any account is FAKE or SANDBOX.
 */
export const INTEGRATION_MODES = ['LIVE', 'SANDBOX', 'FAKE'] as const
export type IntegrationMode = (typeof INTEGRATION_MODES)[number]

/** True for a mode that is not the provider's production (the TEST MODE badge). */
export function isTestMode(mode: IntegrationMode): boolean {
  return mode !== 'LIVE'
}

/**
 * One operation an adapter performs, as the gateway records and guards it.
 *   name         `<area>.<action>`: `mail.send`, `sdi.send_invoice`, `carrier.create_parcel` (the ledger's operation)
 *   idempotent   repeating it cannot do it twice (a read, a PUT, a POST with the provider's idempotency key): only then
 *                does the gateway retry after a timeout, a network error, a 429 or a 5xx
 *   timeoutMs    the longest wait for one attempt (default: the account's callTimeoutMs)
 */
export interface OperationDescriptor {
  readonly name: string
  readonly idempotent: boolean
  readonly timeoutMs?: number
}

/** What an adapter sees of the account it works for (never its secrets: those come from the gateway's call). */
export interface AdapterAccount {
  readonly id: string
  readonly tenantId: string
  readonly companyId: string | null
  readonly provider: IntegrationProviderCode
  readonly mode: IntegrationMode
  /** The account's non-secret settings (region, sender, configuration set …), checked by the adapter. */
  readonly settings: unknown
}

/**
 * A provider adapter: the operations it performs and the implementation of its port for an account's mode (the real
 * client for LIVE and SANDBOX, the fake for FAKE). `Port` is the capability's interface (MailPort, SdiPort …).
 */
export interface ProviderAdapter<Port> {
  readonly provider: IntegrationProviderCode
  readonly operations: Readonly<Record<string, OperationDescriptor>>
  /** The port for one account. The implementation calls the outside only inside gateway.call(). */
  create(account: AdapterAccount): Port
}
