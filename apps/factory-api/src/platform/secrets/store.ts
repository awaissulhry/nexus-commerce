import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { SECRET_ALGORITHM, SecretError, type SealedSecret, type SecretsService } from './envelope'

/**
 * SecretValue rows (feature PLT-197): a secret is sealed (envelope.ts) and stored as its wrapped data key, nonce,
 * ciphertext and tag; its plain value is never stored, logged, audited or answered again. Office sessions and the
 * system context (worker, scheduler, the inbound route) reach the table; floor and partner sessions never do.
 *
 *   storeSecret(tools, secrets, { purpose, plaintext })   inside a command's work (the admin saving credentials): one
 *                                                         row, one audit row naming the purpose and key, never the value
 *   readSecret(client, secrets, { id, tenantId, purpose }) opens a row in memory (the gateway, the inbound route)
 *   rotateSecret(caller, secrets, id)                      its own command: the value re-sealed under the current key
 *                                                         with a new data key, in place (rotatedAt, version + 1)
 */

/** The purposes of the integration platform's secrets (the encryption context's purpose). */
export const SECRET_PURPOSES = Object.freeze({
  /** An account's credentials, as JSON. */
  credentials: 'integration.credentials',
  /** An account's webhook signing secret. */
  webhook: 'integration.webhook',
})

const SEALED_COLUMNS = { keyId: true, algorithm: true, wrappedKey: true, iv: true, ciphertext: true, authTag: true } as const

/** The tenant a context writes for; floor and partner sessions keep no secrets. */
function tenantOf(context: RequestContext): string {
  if (context.audience === 'office' || context.audience === 'system') return context.tenantId
  throw new ApiError('internal_error', `Secrets are kept by office sessions and the system, not by the ${context.audience} audience.`)
}

const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(value)

/** Seals `plaintext` for the command's tenant and stores it; returns the new row's id. Call inside command()'s work. */
export async function storeSecret(tools: CommandTools, secrets: SecretsService, input: { readonly purpose: string; readonly plaintext: string }): Promise<{ id: string; keyId: string }> {
  const tenantId = tenantOf(tools.context)
  const sealed = await secrets.seal(input.plaintext, { tenantId, purpose: input.purpose })
  const id = newId()
  await tools.tx.secretValue.create({
    data: {
      id,
      purpose: input.purpose,
      keyId: sealed.keyId,
      algorithm: sealed.algorithm,
      wrappedKey: bytes(sealed.wrappedKey),
      iv: bytes(sealed.iv),
      ciphertext: bytes(sealed.ciphertext),
      authTag: bytes(sealed.authTag),
      createdAt: tools.now,
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    },
    select: { id: true },
  })
  tools.audit({ recordType: 'SecretValue', recordId: id, after: { purpose: input.purpose, keyId: sealed.keyId } })
  return { id, keyId: sealed.keyId }
}

/** Opens a stored secret in memory. A missing row, another purpose or a value that does not open is a SecretError. */
export async function readSecret(
  client: Pick<FactoryClient | CommandTx, 'secretValue'>,
  secrets: SecretsService,
  input: { readonly id: string; readonly tenantId: string; readonly purpose: string },
): Promise<string> {
  const row = await client.secretValue.findUnique({ where: { id: input.id }, select: { purpose: true, ...SEALED_COLUMNS } })
  if (!row) throw new SecretError('The secret does not exist (or belongs to another tenant).')
  if (row.purpose !== input.purpose) throw new SecretError(`The secret is for ${row.purpose}, not ${input.purpose}.`)
  return secrets.open(row as SealedSecret, { tenantId: input.tenantId, purpose: input.purpose })
}

/**
 * Re-seals one stored secret under the service's current key with a new data key (the rotation of PLT-197: a key that
 * may be exposed, or a move to another KMS key). Its own command: the row's version moves (edit-conflict guard), the
 * audit row records the old and new key ids.
 */
export async function rotateSecret(caller: CommandCaller, secrets: SecretsService, id: string, idempotencyKey?: string): Promise<{ id: string; keyId: string; version: number }> {
  const { result } = await command(
    caller,
    { name: 'integration.rotateSecret', idempotencyKey, input: { id }, record: { type: 'SecretValue', id } },
    async (tools) => {
      const tenantId = tenantOf(tools.context)
      const row = await tools.tx.secretValue.findUnique({ where: { id }, select: { purpose: true, ...SEALED_COLUMNS } })
      if (!row) throw new NotFoundError('SecretValue not found.')
      if (row.algorithm !== SECRET_ALGORITHM) throw new SecretError(`Unknown secret algorithm ${row.algorithm}.`)
      const sealed = await secrets.rotate(row as SealedSecret, { tenantId, purpose: row.purpose })
      await tools.tx.secretValue.update({
        where: { id },
        data: {
          keyId: sealed.keyId,
          wrappedKey: bytes(sealed.wrappedKey),
          iv: bytes(sealed.iv),
          ciphertext: bytes(sealed.ciphertext),
          authTag: bytes(sealed.authTag),
          rotatedAt: tools.now,
        },
        select: { id: true },
      })
      tools.audit({ recordType: 'SecretValue', recordId: id, before: { keyId: row.keyId }, after: { keyId: sealed.keyId, rotated: true } })
      return { id, keyId: sealed.keyId, version: tools.record!.version }
    },
  )
  return result
}
