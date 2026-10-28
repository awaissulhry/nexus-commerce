import { fakePrintRelay } from '../../adapters/print-relay/fake'
import type { PrintRelayAdapter, PrintRelayKind } from '../../adapters/print-relay/port'
import { loadFactoryEnv } from '../../env'

/**
 * The process's print relays (plan A1 §3.9): the adapter for each relay kind a printer can name, or none. With
 * FACTORY_ENV local or test the FAKE relay (it records, sends nothing); in staging and production no relay exists until
 * the Owner picks one (A1 §9 question 5), so a job for a FAKE printer fails there with a plain reason, and no FAKE
 * printer can be added. Tests set their own with usePrintRelays(printRelays({ FAKE: fakePrintRelay(…) })).
 */

export interface PrintRelays {
  /** The relay of this kind, or null when this environment has none. */
  relayFor(kind: PrintRelayKind): PrintRelayAdapter | null
}

export function printRelays(adapters: Partial<Record<PrintRelayKind, PrintRelayAdapter>>): PrintRelays {
  return Object.freeze({ relayFor: (kind: PrintRelayKind) => adapters[kind] ?? null })
}

let configured: PrintRelays | undefined
let fromEnv: PrintRelays | undefined

export function usePrintRelays(relays: PrintRelays | undefined): void {
  configured = relays
}

export function processPrintRelays(): PrintRelays {
  if (configured) return configured
  if (!fromEnv) {
    const environment = loadFactoryEnv().FACTORY_ENV
    fromEnv = printRelays(environment === 'local' || environment === 'test' ? { FAKE: fakePrintRelay({ environment }) } : {})
  }
  return fromEnv
}
