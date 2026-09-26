import { pathToFileURL } from 'node:url'
import { QuarantineVerificationError, verifyQuarantine } from '../services/cx/ingress/ebay-quarantine-verification.js'
import { parseMaintenanceArguments, runOperatorCommand, withMaintenanceClient } from './cx-quarantine-operator.js'

/** Unlike inventory, VERIFY decrypts retained bodies locally and can call KMS.
 * It requires separately approved operator/custodian/KMS access and never writes. */
export async function quarantineVerifyMain(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const options = parseMaintenanceArguments(args, false)
  return withMaintenanceClient(env, 'nexus-quarantine-verify', client => verifyQuarantine(client, { ...options, signal }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperatorCommand(signal => quarantineVerifyMain(process.argv.slice(2), process.env, signal),
    error => error instanceof QuarantineVerificationError ? error.code : 'verification_unavailable')
}
