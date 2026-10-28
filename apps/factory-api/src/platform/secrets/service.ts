import { loadFactoryEnv, type FactoryEnv } from '../../env'
import { awsKmsKeyProvider, createAwsKmsClient } from './aws-kms'
import { createSecretsService, unconfiguredSecrets, type SecretsService } from './envelope'
import { localKeyProvider } from './local'

/**
 * The process's secrets service, from apps/factory-api/.env (env.ts):
 *   local, test           the local master key (FACTORY_SECRETS_MASTER_KEY); without it every seal and open fails
 *                         with the reason, and nothing else is affected;
 *   staging, production   AWS KMS (FACTORY_KMS_KEY_ID with FACTORY_AWS_REGION and the IAM user's keys; env.ts
 *                         requires them there and refuses the local key).
 * Tests set their own with useSecrets() (a generated key, or a fake KMS client), like core/sse.ts useLiveFeed().
 */
export function secretsFromEnv(env: FactoryEnv): SecretsService {
  if (env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test') {
    if (env.FACTORY_SECRETS_MASTER_KEY === undefined) {
      return unconfiguredSecrets(
        'FACTORY_SECRETS_MASTER_KEY is not set in apps/factory-api/.env: secrets cannot be sealed or opened (make one with `openssl rand -base64 32`).',
      )
    }
    return createSecretsService({
      providers: [localKeyProvider({ masterKey: Buffer.from(env.FACTORY_SECRETS_MASTER_KEY, 'base64'), environment: env.FACTORY_ENV })],
    })
  }
  const client = createAwsKmsClient({
    region: env.FACTORY_AWS_REGION,
    accessKeyId: env.FACTORY_AWS_ACCESS_KEY_ID as string,
    secretAccessKey: env.FACTORY_AWS_SECRET_ACCESS_KEY as string,
  })
  return createSecretsService({ providers: [awsKmsKeyProvider({ client, keyId: env.FACTORY_KMS_KEY_ID as string })] })
}

let configured: SecretsService | undefined
let fromEnv: SecretsService | undefined

/** Sets the process's service (tests); undefined goes back to the one made from the env. */
export function useSecrets(service: SecretsService | undefined): void {
  configured = service
}

/** The process's service: the configured one, else one made on first use from apps/factory-api/.env. */
export function processSecrets(): SecretsService {
  if (configured) return configured
  fromEnv ??= secretsFromEnv(loadFactoryEnv())
  return fromEnv
}
