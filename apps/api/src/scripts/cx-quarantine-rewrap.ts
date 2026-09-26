import { pathToFileURL } from 'node:url'
import { QuarantineRewrapError, rewrapQuarantine } from '../services/cx/ingress/ebay-quarantine-rewrap.js'
import { parseMaintenanceArguments, runOperatorCommand, withMaintenanceClient } from './cx-quarantine-operator.js'

/** WRITES: replaces stored ciphertext through the audited CAS and uses KMS. It needs
 * separately approved operator, custodian, KMS and production-write access; `--apply`
 * is the explicit acknowledgement. Inventory and verify are the read-only commands. */
export async function quarantineRewrapMain(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const options = parseMaintenanceArguments(args, true)
  return withMaintenanceClient(env, 'nexus-quarantine-rewrap', client => rewrapQuarantine(client, { ...options, signal }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperatorCommand(signal => quarantineRewrapMain(process.argv.slice(2), process.env, signal),
    error => error instanceof QuarantineRewrapError ? error.code : 'rewrap_unavailable')
}
