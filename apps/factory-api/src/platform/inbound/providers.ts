import type { IntegrationProvider } from '@nexus/factory-db'
import type { Clock } from '@nexus/factory-domain/ports/clock'
import type { SignatureVerifier } from '@nexus/factory-domain/ports/signature'
import { snsVerifier } from '../../adapters/ses/sns'
import type { CommandTools } from '../../core/command'
import { serverClock } from '../../core/time'
import { loadFactoryEnv, type FactoryEnv } from '../../env'
import type { SecretsService } from '../secrets/envelope'
import { sesNotificationProcessor } from '../email-out/notifications'
import { emailInProcessor } from '../email-in/receive'
import { processSecrets } from '../secrets/service'

/**
 * What the inbound ledger knows of each provider (plan A1 §4): how its webhooks are verified (LIVE and SANDBOX
 * accounts; a FAKE account always uses the fake verifier, verifiers.ts) and how a stored receipt is processed (every
 * mode). Each provider adapter adds its entry to INBOUND_PROVIDERS in the step that brings it (one line, like the
 * HANDLERS list of background.ts). A provider without an entry has no webhook route that verifies anything: its
 * deliveries are answered 404 and stored nowhere, and a FAKE account's receipt without a processor is marked FAILED
 * (no processor) for a person, never dropped.
 */

/** A stored, verified webhook, as a processor sees it. */
export interface InboundReceipt {
  readonly id: string
  readonly tenantId: string
  readonly companyId: string | null
  readonly accountId: string
  readonly provider: IntegrationProvider
  readonly dedupeKey: string
  readonly externalId: string | null
  readonly eventType: string | null
  readonly contentType: string | null
  /** The raw body (UTF-8), exactly as it was verified. */
  readonly body: string
  readonly receivedAt: Date
  /** Processing attempts before this one. */
  readonly attempts: number
}

/**
 * Applies one receipt, inside the processing command's transaction: its changes go through `tools` (audited, with
 * their events), and the receipt is marked PROCESSED in the same transaction, so it is applied exactly once. It must
 * not call an outside service (the gateway) inside it; a follow-up call is a job of its own.
 */
export interface InboundProcessor {
  process(receipt: InboundReceipt, tools: CommandTools): Promise<void>
}

export interface InboundProvider {
  readonly verifier: SignatureVerifier
  readonly processor: InboundProcessor
}

export type InboundProviders = Readonly<Partial<Record<IntegrationProvider, InboundProvider>>>

/**
 * The providers' entries. SES via SNS: a received mail ("Received", email in, platform/email-in/receive.ts), else a
 * delivery, bounce or complaint notification (email out, platform/email-out/notifications.ts). The W1 adapters (the SDI
 * intermediary, Sendcloud) add theirs here.
 */
export const INBOUND_PROVIDERS: InboundProviders = Object.freeze({
  SES: { verifier: snsVerifier, processor: emailInProcessor(sesNotificationProcessor) },
})

/** What the inbound route and its job need. */
export interface InboundRuntime {
  readonly environment: FactoryEnv['FACTORY_ENV']
  readonly providers: InboundProviders
  readonly secrets: SecretsService
  readonly clock: Clock
}

let configured: Partial<InboundRuntime> | undefined
let environment: FactoryEnv['FACTORY_ENV'] | undefined

/** Sets parts of the runtime (tests); undefined goes back to the defaults. */
export function useInbound(runtime: Partial<InboundRuntime> | undefined): void {
  configured = runtime
}

/** The runtime: what useInbound set, else the env's environment, INBOUND_PROVIDERS, the process's secrets, the server clock. */
export function inboundRuntime(): InboundRuntime {
  return {
    environment: configured?.environment ?? (environment ??= loadFactoryEnv().FACTORY_ENV),
    providers: configured?.providers ?? INBOUND_PROVIDERS,
    secrets: configured?.secrets ?? processSecrets(),
    clock: configured?.clock ?? serverClock,
  }
}
