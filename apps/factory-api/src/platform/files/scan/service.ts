import { clamdScanner } from '../../../adapters/clamav/clamd'
import { FactoryEnvError, readFactoryVariables } from '../../../env'
import { fakeScanner } from './fake'
import type { VirusScanner } from './port'

/**
 * The process's virus scanner (PLT-245; B-W2a-42), made on first use from apps/factory-api/.env (or the process):
 *
 *   FACTORY_VIRUS_SCAN        off (default) | fake (local and test only) | clamav
 *   FACTORY_CLAMAV_HOST       with clamav: the clamd host (the ClamAV container in the private network)
 *   FACTORY_CLAMAV_PORT       default 3310
 *   FACTORY_CLAMAV_TIMEOUT_MS one file's scan, default 30000 (the connection: 5 s)
 *
 * Off: uploads become AVAILABLE when they match their announcement, unscanned (NOT_SCANNED), as before this step.
 * On: a confirmed upload waits QUARANTINED (`scan_pending`) until the scan says CLEAN. Live scanning (clamav on staging
 * or production) needs the Owner's spend yes (GATE-SPEND: the scanner service). Tests set their own with useScanner().
 */

export const SCAN_MODES = ['off', 'fake', 'clamav'] as const
export type ScanMode = (typeof SCAN_MODES)[number]

export interface ScanConfig {
  readonly mode: ScanMode
  readonly host?: string
  readonly port?: number
  readonly timeoutMs?: number
}

/** The scanner's configuration from the variables; a bad one stops the process (the boot reads it). */
export function scanConfigOf(environment: string, variables: Readonly<Record<string, string | undefined>>): ScanConfig {
  const value = variables.FACTORY_VIRUS_SCAN?.trim() || 'off'
  if (!(SCAN_MODES as readonly string[]).includes(value)) throw new FactoryEnvError(`FACTORY_VIRUS_SCAN must be off, fake or clamav, not ${value}`)
  const mode = value as ScanMode
  const local = environment === 'local' || environment === 'test'
  if (mode === 'fake' && !local) throw new FactoryEnvError(`FACTORY_VIRUS_SCAN=fake is for local and test runs, not FACTORY_ENV=${environment}`)
  if (mode !== 'clamav') return { mode }
  const host = variables.FACTORY_CLAMAV_HOST?.trim()
  if (!host) throw new FactoryEnvError('FACTORY_CLAMAV_HOST must name the clamd host with FACTORY_VIRUS_SCAN=clamav')
  const port = Number(variables.FACTORY_CLAMAV_PORT ?? 3310)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new FactoryEnvError('FACTORY_CLAMAV_PORT must be a port number')
  const timeoutMs = Number(variables.FACTORY_CLAMAV_TIMEOUT_MS ?? 30_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new FactoryEnvError('FACTORY_CLAMAV_TIMEOUT_MS must be 1000 to 600000')
  return { mode, host, port, timeoutMs }
}

export function scannerFor(config: ScanConfig): VirusScanner | null {
  if (config.mode === 'fake') return fakeScanner()
  if (config.mode === 'clamav') return clamdScanner({ host: config.host!, port: config.port!, scanTimeoutMs: config.timeoutMs })
  return null
}

let configured: { scanner: VirusScanner | null } | undefined
let fromEnv: { scanner: VirusScanner | null } | undefined

/** Tests: a scanner (or null: none); undefined goes back to the process's own. */
export function useScanner(scanner: VirusScanner | null | undefined): void {
  configured = scanner === undefined ? undefined : { scanner }
}

/** The scanner uploads go through, or null when scanning is off. */
export function processScanner(): VirusScanner | null {
  if (configured) return configured.scanner
  if (!fromEnv) {
    // The variables only (not the whole env check): a wrong FACTORY_VIRUS_SCAN is refused loudly, never read as off.
    const variables = readFactoryVariables()
    fromEnv = { scanner: scannerFor(scanConfigOf(variables.FACTORY_ENV ?? '', variables)) }
  }
  return fromEnv.scanner
}

/** Whether uploads are scanned here (the security page's "virus scan on uploads"); a broken configuration is not on. */
export function scanningOn(): boolean {
  try {
    return processScanner() !== null
  } catch {
    return false
  }
}
