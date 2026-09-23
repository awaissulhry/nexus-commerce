/**
 * Re-encrypt owned channel credentials and application secrets under the checked key.
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
 * A workspace run covers its owned connection envelopes, including inactive rows,
 * and the application secrets below. Every replacement must retain the preflight
 * key/mode, and any failed or contended item makes the run incomplete. Format counts
 * do not prove decryption, target-key coverage or safe retirement. Quarantine and
 * other encryption consumers require their separate global maintenance inventory.
 *
 * ── What "every stored credential" covers (2026-09-21) ───────────────────────
 * Two tables, not one. `ChannelConnection.credentialsEnc` holds a channel's OAuth
 * grant; `ChannelApp.clientSecretEnc` and `ChannelApp.signingKeyEnc` hold the eBay and
 * Amazon APPLICATION secrets and the eBay Key Management signing key. All three are
 * written by the same `encryptCredentials`, so all three move to KMS together or the
 * migration is not done.
 *
 * This job covered only the connections until 2026-09-21, and `cx-credentials-status`
 * counted only those too — so the reported finished state (`onEnvKey=0`) was true and
 * incomplete at the same time, which is the worst kind of green. The app secrets are
 * the more valuable half: a client secret mints new tokens indefinitely, a refresh
 * token is one grant. They also rotate almost never on their own, so unlike a
 * connection they would have stayed on the environment key for good.
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
import {
  reencryptCredentials,
  credentialsKeyIdOf,
  encryptCredentials,
  decryptCredentials,
  isCredentialsBlob,
} from '../lib/crypto.js'
import { recordConnectionEvent, SYSTEM_ACTOR } from '../services/cx/events.service.js'
import { workspaceIdForQuery } from '../lib/workspace-context.js'

/**
 * The `ChannelApp` columns that hold an encrypted blob. Named once so the rotation and
 * the status count cannot drift apart — the failure mode of two hand-maintained lists
 * is that one of them quietly stops covering a column somebody added.
 */
const APP_SECRET_FIELDS = ['clientSecretEnc', 'signingKeyEnc'] as const
type AppSecretField = (typeof APP_SECRET_FIELDS)[number]

/**
 * Which key protects a stored blob — read from the BLOB, never from a column.
 *
 * `ChannelConnection.credentialsKeyId` is nullable and `ChannelApp` has no such column
 * at all. A `credentialsKeyId === 'env'` test therefore counts a row whose key id was
 * never written as KMS-protected: the one direction a miscount must never go, because
 * it reports the migration finished while an env-keyed envelope is still sitting there.
 *
 * A blob's own prefix cannot be absent or stale — v1 is the environment key, v2 is a
 * KMS envelope — so it is the only honest source. `unreadable` is kept separate from
 * both: something that is not a credentials blob has not been shown to be on either
 * key, and folding it into a count would be inventing a measurement.
 */
function keyStateOf(blob: string): 'kms' | 'env' | 'unreadable' {
  if (!isCredentialsBlob(blob)) return 'unreadable'
  try {
    return credentialsKeyIdOf(blob).version === 'v2' ? 'kms' : 'env'
  } catch {
    return 'unreadable'
  }
}

/**
 * Is the stored blob already protected by the key we would write with?
 *
 * Compare the FORM and the key, never the ciphertext: every encryption uses a fresh IV,
 * so a byte comparison would report "changed" on every run forever.
 *   v1 = the environment key · v2 = a KMS-wrapped envelope
 */
function isOnTargetKey(storedBlob: string, produced: { mode: string; keyId: string }): boolean {
  const stored = credentialsKeyIdOf(storedBlob)
  return produced.mode === 'kms'
    ? stored.version === 'v2' && stored.keyId === produced.keyId
    : stored.version === 'v1'
}

/** Preflight is a snapshot: later fallback/configuration changes must never alter its target. */
function assertMaintenanceTarget(storedBlob: string, produced: { blob: string; mode: string; keyId: string }, target: { mode: string; keyId: string }) {
  const stored = credentialsKeyIdOf(storedBlob), actual = credentialsKeyIdOf(produced.blob)
  if (produced.mode !== target.mode || produced.keyId !== target.keyId
    || (actual.version === 'v2' ? produced.mode !== 'kms' || actual.keyId !== target.keyId : produced.mode !== 'env' || produced.keyId !== 'env')
    || (stored.version === 'v2' && actual.version === 'v1')) {
    throw new Error('The replacement envelope does not match the maintenance target; the original was retained.')
  }
}

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
      throw new Error(`FAILED kmsConfigured=${kmsConfigured} mode=${v.mode} — configured key round-trip failed; do NOT rotate`)
    }
    if (kmsConfigured && v.mode !== 'kms') {
      // Configured but silently falling back is the one state that looks fine and is not.
      throw new Error(`FAILED kmsConfigured=true but encryption used mode=${v.mode} — the key is set and NOT being used; check the key id and kms:GenerateDataKey`)
    }
    return `ok mode=${v.mode} keyId=${v.keyId} kmsConfigured=${kmsConfigured}`
  })
}

export async function runCredentialsRotate(): Promise<string> {
  return recordCronRun('cx-credentials-rotate', async () => {
    const workspaceId = workspaceIdForQuery()
    const rows = await prisma.channelConnection.findMany({
      where: { workspaceId, credentialsEnc: { not: null } },
      select: { id: true, channelType: true, credentialsEnc: true, credentialsKeyId: true },
    })
    const apps = await prisma.channelApp.findMany({
      where: { OR: [{ clientSecretEnc: { not: null } }, { signingKeyEnc: { not: null } }] },
      select: { id: true, channelKey: true, environment: true, clientSecretEnc: true, signingKeyEnc: true },
    })
    if (rows.length === 0 && apps.length === 0) return 'no owned connection credentials or app secrets — quarantine not examined'

    // Refuse to touch anything unless the target key can wrap AND unwrap. This job
    // re-encrypts EVERY channel's credential, so a key that wraps but cannot unwrap
    // would take out every connection at once — and the plaintext columns are gone.
    const preflight = await verifyCurrentKey()
    if (!preflight.ok) {
      throw new Error(`REFUSED — the configured key failed a round-trip (mode=${preflight.mode}). Nothing was changed.`)
    }

    const targetIsKms = !!process.env.NEXUS_KMS_KEY_ID
    if (targetIsKms && preflight.mode !== 'kms') {
      throw new Error(`REFUSED — NEXUS_KMS_KEY_ID is set but encryption fell back to mode=${preflight.mode}. Rotating now would rewrite every credential under the ENV key while appearing to enable KMS. Nothing was changed.`)
    }
    let rotated = 0
    let alreadyCurrent = 0
    let failed = 0
    let contended = 0
    const keyIds = new Set<string>()

    for (const row of rows) {
      try {
        const result = await reencryptCredentials(row.credentialsEnc!)
        assertMaintenanceTarget(row.credentialsEnc!, result, preflight)
        keyIds.add(result.keyId)
        // Already under the target key ⇒ nothing gained by writing.
        if (isOnTargetKey(row.credentialsEnc!, result)) {
          alreadyCurrent++
          continue
        }
        const saved = await prisma.channelConnection.updateMany({
          where: { id: row.id, workspaceId, credentialsEnc: row.credentialsEnc },
          data: { credentialsEnc: result.blob, credentialsKeyId: result.keyId },
        })
        // Reconnect, refresh or disconnect may win while crypto work is running.
        // Keep that writer's material; a deliberate rerun can inspect it afresh.
        if (saved.count !== 1) { contended++; continue }
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

    // ── The application secrets ────────────────────────────────────────────────
    // Counted per FIELD, not per row: one ChannelApp can hold a client secret and a
    // signing key, and "one app rotated" would hide a field that failed beside one
    // that moved. Each field is re-encrypted on its own and the row is written once,
    // so a failure on the signing key never costs the client secret its migration.
    let appSecrets = 0
    let appRotated = 0
    let appAlreadyCurrent = 0
    let appFailed = 0
    let appContended = 0

    for (const app of apps) {
      const data: Partial<Record<AppSecretField, string>> = {}
      for (const field of APP_SECRET_FIELDS) {
        const blob = app[field]
        if (!blob) continue
        appSecrets++
        try {
          const result = await reencryptCredentials(blob)
          assertMaintenanceTarget(blob, result, preflight)
          keyIds.add(result.keyId)
          if (isOnTargetKey(blob, result)) {
            appAlreadyCurrent++
            continue
          }
          data[field] = result.blob
        } catch (err) {
          appFailed++
          logger.error('[cx-rotate] could not re-encrypt an app secret; the existing one is unchanged', {
            channelApp: `${app.channelKey}:${app.environment}`,
            field,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const changed = Object.keys(data) as AppSecretField[]
      if (changed.length === 0) continue
      try {
        const saved = await prisma.channelApp.updateMany({
          where: { id: app.id, ...Object.fromEntries(changed.map(field => [field, app[field]])) }, data,
        })
        if (saved.count !== 1) { appContended += changed.length; continue }
        appRotated += changed.length
        // No connection event here: ChannelApp is not a connection and
        // recordConnectionEvent is keyed by connectionId. Inventing one would put a
        // row in the connection timeline that points at nothing.
        logger.info('[cx-rotate] app secrets re-encrypted under the current key', {
          channelApp: `${app.channelKey}:${app.environment}`,
          fields: changed,
        })
      } catch (err) {
        appFailed += changed.length
        logger.error('[cx-rotate] could not store re-encrypted app secrets; the existing ones are unchanged', {
          channelApp: `${app.channelKey}:${app.environment}`,
          fields: changed,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const keys = [...keyIds].join(',') || 'none'
    const summary = (
      `connections=${rows.length} rotated=${rotated} alreadyCurrent=${alreadyCurrent} failed=${failed} contended=${contended} ` +
      `appSecrets=${appSecrets} appRotated=${appRotated} appAlreadyCurrent=${appAlreadyCurrent} appFailed=${appFailed} appContended=${appContended} ` +
      `keyIds=${keys} kmsConfigured=${targetIsKms} connectionsScope=owned-workspace appSecretsScope=application quarantine=not-examined recovery=not-verified`
    )
    if (failed || contended || appFailed || appContended) throw new Error(`INCOMPLETE ${summary}`)
    return summary
  })
}

/**
 * Answer "how are our credentials protected right now?" without a database console.
 *
 * Every count is derived from the blob itself via `keyStateOf` — see its docblock for
 * why the stored key id column is not trusted. `unreadable` is reported separately and
 * is never zero-by-assumption: it means a stored value this job could not classify, and
 * it should be investigated rather than averaged away.
 */
export async function runCredentialsStatus(): Promise<string> {
  return recordCronRun('cx-credentials-status', async () => {
    const rows = await prisma.channelConnection.findMany({
      where: { workspaceId: workspaceIdForQuery() },
      select: { channelType: true, credentialsEnc: true, credentialsKeyId: true, managedBy: true, isActive: true },
    })
    const withEnvelope = rows.filter((r) => r.credentialsEnc)
    const states = withEnvelope.map((r) => keyStateOf(r.credentialsEnc!))
    const onKms = states.filter((s) => s === 'kms').length
    const onEnvKey = states.filter((s) => s === 'env').length
    const unreadable = states.filter((s) => s === 'unreadable').length
    const noEnvelope = rows.length - withEnvelope.length

    const apps = await prisma.channelApp.findMany({
      select: { clientSecretEnc: true, signingKeyEnc: true },
    })
    const appStates = apps.flatMap((a) =>
      APP_SECRET_FIELDS.map((f) => a[f]).filter((b): b is string => !!b).map(keyStateOf),
    )
    const appOnKms = appStates.filter((s) => s === 'kms').length
    const appOnEnvKey = appStates.filter((s) => s === 'env').length
    const appUnreadable = appStates.filter((s) => s === 'unreadable').length

    return (
      `active=${rows.filter(row => row.isActive).length} retainedConnections=${rows.length} withEnvelope=${withEnvelope.length} onKms=${onKms} onEnvKey=${onEnvKey} ` +
      `unreadable=${unreadable} noEnvelope=${noEnvelope} ` +
      `appSecrets=${appStates.length} appOnKms=${appOnKms} appOnEnvKey=${appOnEnvKey} appUnreadable=${appUnreadable} ` +
      `kmsConfigured=${!!process.env.NEXUS_KMS_KEY_ID} classification=envelope-format connectionsScope=owned-workspace appSecretsScope=application quarantine=not-examined recovery=not-verified`
    )
  })
}
