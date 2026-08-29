/**
 * Re-encrypt every stored credential under the CURRENT key.
 *
 * `lib/crypto.ts` has shipped `reencryptCredentials` since CX.1 with a docblock saying
 * it "exists for the deliberate rotation job" — and nothing ever called it. This is
 * that job.
 *
 * ── Why it matters the moment `NEXUS_KMS_KEY_ID` is set ──────────────────────
 * `writeCredentials` encrypts with whatever key is configured, so an envelope does
 * migrate to KMS on its next refresh — eBay and Ads refresh roughly hourly, so most
 * would move on their own. But "probably within an hour or two" is not a security
 * posture, and it has two holes: a connection that has stopped refreshing (revoked,
 * degraded, needs_reauth) keeps its env-keyed envelope indefinitely, and nobody can
 * answer "are all credentials KMS-wrapped now?" without querying the database.
 *
 * Running this makes the migration immediate, complete and reportable: it returns the
 * count moved and the resulting key ids, so the answer to that question is a line of
 * output rather than an inference.
 *
 * Idempotent — a blob already under the current key is left alone. Safe to run when no
 * KMS key is configured: it simply reports that everything is on the env key, which is
 * the honest reading of that state.
 *
 * Registry-triggered (`cx-credentials-rotate`), never scheduled: rotation is a
 * deliberate act, and a cron that silently rewrites every credential is not one.
 */
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { reencryptCredentials, credentialsKeyIdOf, encryptCredentials, decryptCredentials } from '../lib/crypto.js'
import { recordConnectionEvent, SYSTEM_ACTOR } from '../services/cx/events.service.js'

/**
 * Prove the configured key can BOTH wrap and unwrap, using a throwaway payload.
 *
 * `encryptCredentials` degrades safely when KMS cannot wrap — it falls back to the
 * environment key and alerts. It does NOT check that what it just wrote can be read
 * back, and those are different permissions: an IAM policy granting
 * `kms:GenerateDataKey` but not `kms:Decrypt` is an easy thing to write, and it
 * produces envelopes that store perfectly and can never be opened. Since CX.1 nulled
 * the plaintext columns, an unreadable envelope means re-consenting the channel.
 *
 * Touches no real credential — it wraps and unwraps a marker object.
 */
export async function verifyCurrentKey(): Promise<{ ok: boolean; mode: string; keyId: string; error?: string }> {
  const marker = { preflight: 'nexus-credential-key-check', at: new Date().toISOString() }
  try {
    const { blob, keyId, mode } = await encryptCredentials(marker)
    const back = (await decryptCredentials(blob)) as typeof marker
    const ok = back?.preflight === marker.preflight && back?.at === marker.at
    return ok
      ? { ok: true, mode, keyId }
      : { ok: false, mode, keyId, error: 'the decrypted marker did not match what was encrypted' }
  } catch (err) {
    return { ok: false, mode: 'unknown', keyId: 'unknown', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Report whether the configured credential key can wrap AND unwrap. Changes nothing. */
export async function runCredentialsPreflight(): Promise<string> {
  return recordCronRun('cx-credentials-preflight', async () => {
    const kmsConfigured = !!process.env.NEXUS_KMS_KEY_ID
    const v = await verifyCurrentKey()
    if (!v.ok) {
      logger.error('[cx-preflight] the configured credential key cannot round-trip', { mode: v.mode, error: v.error })
      return `FAILED kmsConfigured=${kmsConfigured} mode=${v.mode} error=${v.error ?? 'unknown'} — do NOT rotate`
    }
    if (kmsConfigured && v.mode !== 'kms') {
      // Configured but silently falling back is the one state that looks fine and is not.
      return `WARNING kmsConfigured=true but encryption used mode=${v.mode} — the key is set and NOT being used; check the key id and kms:GenerateDataKey`
    }
    return `ok mode=${v.mode} keyId=${v.keyId} kmsConfigured=${kmsConfigured}`
  })
}

export async function runCredentialsRotate(): Promise<string> {
  return recordCronRun('cx-credentials-rotate', async () => {
    const rows = await prisma.channelConnection.findMany({
      where: { credentialsEnc: { not: null } },
      select: { id: true, channelType: true, credentialsEnc: true, credentialsKeyId: true },
    })
    if (rows.length === 0) return 'no stored credentials — nothing to rotate'

    // Refuse to touch anything unless the target key can wrap AND unwrap. This job
    // re-encrypts EVERY channel's credential, so a key that wraps but cannot unwrap
    // would take out every connection at once — and the plaintext columns are gone.
    const preflight = await verifyCurrentKey()
    if (!preflight.ok) {
      return `REFUSED — the configured key failed a round-trip (mode=${preflight.mode}): ${preflight.error ?? 'unknown'}. Nothing was changed.`
    }

    const targetIsKms = !!process.env.NEXUS_KMS_KEY_ID
    if (targetIsKms && preflight.mode !== 'kms') {
      return `REFUSED — NEXUS_KMS_KEY_ID is set but encryption fell back to mode=${preflight.mode}. Rotating now would rewrite every credential under the ENV key while appearing to enable KMS. Nothing was changed.`
    }
    let rotated = 0
    let alreadyCurrent = 0
    let failed = 0
    const keyIds = new Set<string>()

    for (const row of rows) {
      try {
        const result = await reencryptCredentials(row.credentialsEnc!)
        keyIds.add(result.keyId)
        // Already under the target key ⇒ nothing gained by writing. Compare the FORM
        // and the key, never the ciphertext: every encryption uses a fresh IV, so a
        // byte comparison would report "changed" on every run forever.
        //   v1 = the environment key · v2 = a KMS-wrapped envelope
        const stored = credentialsKeyIdOf(row.credentialsEnc!)
        const alreadyOnTarget =
          result.mode === 'kms'
            ? stored.version === 'v2' && stored.keyId === result.keyId
            : stored.version === 'v1'
        if (alreadyOnTarget) {
          alreadyCurrent++
          continue
        }
        await prisma.channelConnection.update({
          where: { id: row.id },
          data: { credentialsEnc: result.blob, credentialsKeyId: result.keyId },
        })
        await recordConnectionEvent({
          connectionId: row.id,
          channelKey: 'SYSTEM',
          type: 'secret_rotated',
          actor: SYSTEM_ACTOR,
          detail: { from: row.credentialsKeyId, to: result.keyId, mode: result.mode },
        })
        rotated++
      } catch (err) {
        failed++
        // Never leave a connection without a credential because a rotation failed:
        // the existing envelope is untouched unless the new one was produced.
        logger.error('[cx-rotate] could not re-encrypt a credential; the existing one is unchanged', {
          connectionId: row.id,
          channelType: row.channelType,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const keys = [...keyIds].join(',') || 'none'
    return `connections=${rows.length} rotated=${rotated} alreadyCurrent=${alreadyCurrent} failed=${failed} keyIds=${keys} kmsConfigured=${targetIsKms}`
  })
}

/**
 * Answer "how are our credentials protected right now?" without a database console.
 * Reports the key id per connection — `env` means the v1 environment key, anything
 * else is the KMS key the envelope is wrapped under.
 */
export async function runCredentialsStatus(): Promise<string> {
  return recordCronRun('cx-credentials-status', async () => {
    const rows = await prisma.channelConnection.findMany({
      where: { isActive: true },
      select: { channelType: true, credentialsEnc: true, credentialsKeyId: true, managedBy: true },
    })
    const withEnvelope = rows.filter((r) => r.credentialsEnc)
    const onEnvKey = withEnvelope.filter((r) => r.credentialsKeyId === 'env').length
    const onKms = withEnvelope.length - onEnvKey
    const noEnvelope = rows.length - withEnvelope.length
    return `active=${rows.length} withEnvelope=${withEnvelope.length} onKms=${onKms} onEnvKey=${onEnvKey} noEnvelope=${noEnvelope} kmsConfigured=${!!process.env.NEXUS_KMS_KEY_ID}`
  })
}
