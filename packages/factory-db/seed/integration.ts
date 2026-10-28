import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The integration module's synthetic seed, per tenant of seed/_core.ts: FAKE accounts (a tenant-wide SES account and
 * an SDI account for company A), one SecretValue, two IntegrationCall rows (a success and a refusal) and two
 * InboundWebhook receipts (one verified and waiting, one rejected). Written in the tenant's office scope.
 *
 * Made up and harmless: every account is FAKE (no network), and the seeded SecretValue is NOT openable (its key id,
 * `seed:not-a-key`, names no key provider): real secrets are sealed by apps/factory-api's secrets service, never here.
 * The ledgers are append-only, so the seed only inserts and skips rows that exist (INSERT … ON CONFLICT DO NOTHING): a
 * second run adds nothing.
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T08:00:00.000Z')
const LATER = new Date('2026-10-28T08:00:00.250Z')

/** Deterministic made-up bytes (never a key). */
const bytes = (label: string, length: number): Uint8Array<ArrayBuffer> => Uint8Array.from(createHash('sha256').update(`seed ${label}`).digest().subarray(0, length))

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const ses = id('integration:account:ses')
  const sdi = id('integration:account:sdi')
  const body = '{"seeded":true,"event":"example"}'

  const secrets: Prisma.SecretValueCreateManyInput[] = [
    {
      id: id('integration:secret:example'),
      purpose: 'integration.credentials',
      keyId: 'seed:not-a-key',
      algorithm: 'AES-256-GCM',
      wrappedKey: bytes(`${namespace} wrapped`, 32),
      iv: bytes(`${namespace} iv`, 12),
      ciphertext: bytes(`${namespace} ciphertext`, 24),
      authTag: bytes(`${namespace} tag`, 16),
      createdAt: AT,
      createdById: actorId,
    },
  ]
  const accounts: Prisma.IntegrationAccountCreateManyInput[] = [
    { id: ses, companyId: null, provider: 'SES', code: 'ses', label: 'Mail (fake)', mode: 'FAKE', createdById: actorId },
    { id: sdi, companyId: companyA, provider: 'SDI', code: 'sdi-a', label: 'SDI company A (fake)', mode: 'FAKE', createdById: actorId },
  ]
  const calls: Prisma.IntegrationCallCreateManyInput[] = [
    {
      id: id('integration:call:ok'),
      companyId: null,
      accountId: ses,
      provider: 'SES',
      mode: 'FAKE',
      operation: 'mail.send',
      requestId: 'seed-call-ok',
      idempotencyKey: 'seed-mail-1',
      startedAt: AT,
      finishedAt: LATER,
      durationMs: 250,
      attempts: 1,
      status: 'SUCCEEDED',
      httpStatus: 200,
      requestSummary: { template: 'example' },
      responseSummary: { messageId: 'fake-message-1' },
    },
    {
      id: id('integration:call:refused'),
      companyId: companyA,
      accountId: sdi,
      provider: 'SDI',
      mode: 'FAKE',
      operation: 'sdi.send_invoice',
      requestId: 'seed-call-refused',
      startedAt: AT,
      finishedAt: AT,
      durationMs: 0,
      attempts: 0,
      status: 'REFUSED',
      reason: 'account_paused',
    },
  ]
  const receipts: Prisma.InboundWebhookCreateManyInput[] = [
    {
      id: id('integration:inbound:received'),
      companyId: companyA,
      accountId: sdi,
      provider: 'SDI',
      verified: true,
      dedupeKey: 'seed-event-1',
      externalId: 'seed-invoice-1',
      eventType: 'example',
      bodySha256: createHash('sha256').update(body).digest('hex'),
      bodyBytes: Buffer.byteLength(body),
      contentType: 'application/json',
      body,
      receivedAt: AT,
      requestId: 'seed-inbound-1',
      status: 'RECEIVED',
    },
    {
      id: id('integration:inbound:rejected'),
      companyId: companyA,
      accountId: sdi,
      provider: 'SDI',
      verified: false,
      bodySha256: createHash('sha256').update('forged').digest('hex'),
      bodyBytes: 6,
      contentType: 'application/json',
      rejectReason: 'signature_mismatch',
      receivedAt: AT,
      requestId: 'seed-inbound-2',
      status: 'REJECTED',
    },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.secretValue.createMany({ data: secrets, skipDuplicates: true })
      await tx.integrationAccount.createMany({ data: accounts, skipDuplicates: true })
      await tx.integrationCall.createMany({ data: calls, skipDuplicates: true })
      await tx.inboundWebhook.createMany({ data: receipts, skipDuplicates: true })
    }),
  )
}
