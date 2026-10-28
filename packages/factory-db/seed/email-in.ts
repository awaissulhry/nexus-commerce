import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * Email in's synthetic seed, per tenant of seed/_core.ts: a FAKE SES receiving account of company A (no network;
 * seed/email.ts and seed/integration.ts run after this file, so their accounts cannot be named here) and five received
 * mails, one in each place a person may meet: one waiting to be read (RECEIVED), one no record took ("mail to sort",
 * TRIAGE), one held for a person (HELD: SES's DMARC check failed), one thrown away unread (REJECTED: a virus) and one
 * whose raw mail could not be read (FAILED). A mail that joined a thread is not seeded: it names its thread message, and
 * seed/threads.ts runs later. Made-up addresses on example domains only; written in the tenant's office scope. A second
 * run adds nothing (INSERT … ON CONFLICT DO NOTHING).
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T08:00:00.000Z')
const seconds = (n: number): Date => new Date(AT.getTime() + n * 1_000)

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const account = id('email-in:account:ses')
  const replyDomain = `reply.company-a.${namespace}.example.com`
  const bucket = `factory-inbound-${namespace}`

  const received = (key: string, at: number, from: string) =>
    ({
      id: id(`email-in:${key}`),
      companyId: companyA,
      accountId: account,
      receiptId: id(`email-in:${key}:receipt`),
      sesMessageId: `fake-${namespace}-${key}`,
      s3Bucket: bucket,
      s3Key: `inbound/fake-${namespace}-${key}`,
      receivedAt: seconds(at),
      envelopeFrom: from,
      envelopeTo: [`orders@${replyDomain}`],
      fromAddress: from,
      to: [`orders@${replyDomain}`],
      spfVerdict: 'PASS',
      dkimVerdict: 'PASS',
      dmarcVerdict: 'PASS',
      spamVerdict: 'PASS',
      virusVerdict: 'PASS',
      createdAt: seconds(at),
      updatedAt: seconds(at),
    }) as const satisfies Prisma.InboundEmailCreateManyInput

  const mails: Prisma.InboundEmailCreateManyInput[] = [
    {
      ...received('waiting', 10, `buyer.${namespace}@example.com`),
      subject: 'Richiesta preventivo giacche',
      emailMessageId: `<waiting.${namespace}@mail.example.com>`,
    },
    {
      ...received('triage', 20, `new.buyer.${namespace}@example.net`),
      fromName: 'Nuovo Cliente',
      subject: 'Giacche in pelle su misura',
      emailMessageId: `<triage.${namespace}@mail.example.net>`,
      sizeBytes: 2_048,
      bodyText: 'Buongiorno,\nvorremmo un preventivo per 40 giacche in pelle.\nGrazie',
      bodyHtml: '<p>Buongiorno,<br />vorremmo un preventivo per 40 giacche in pelle.</p><p>Grazie</p>',
      status: 'TRIAGE',
      fetchedAt: seconds(21),
      sortedAt: seconds(22),
      attempts: 1,
      updatedAt: seconds(22),
    },
    {
      ...received('held', 30, `accounts.${namespace}@example.org`),
      fromName: 'Ufficio amministrazione',
      subject: 'Nuove coordinate bancarie',
      emailMessageId: `<held.${namespace}@mail.example.org>`,
      dmarcVerdict: 'FAIL',
      dmarcPolicy: 'reject',
      sizeBytes: 1_024,
      bodyText: 'Da oggi pagate su un nuovo conto.',
      status: 'HELD',
      heldReason: 'DMARC_FAIL',
      fetchedAt: seconds(31),
      sortedAt: seconds(32),
      attempts: 1,
      updatedAt: seconds(32),
    },
    {
      ...received('virus', 40, `unknown.${namespace}@example.com`),
      subject: 'Fattura',
      virusVerdict: 'FAIL',
      status: 'REJECTED',
      rejectReason: 'VIRUS',
      sortedAt: seconds(40),
    },
    {
      ...received('failed', 50, `supplier.${namespace}@example.com`),
      subject: 'Conferma ordine',
      status: 'FAILED',
      attempts: 5,
      lastError: 'the raw mail is no longer in the bucket',
      sortedAt: seconds(55),
      updatedAt: seconds(55),
    },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.integrationAccount.createMany({
        data: [{ id: account, companyId: companyA, provider: 'SES', code: 'ses-inbound', label: 'Email in (fake)', mode: 'FAKE', settings: { inboundBucket: bucket }, createdById: actorId }],
        skipDuplicates: true,
      })
      await tx.inboundEmail.createMany({ data: mails, skipDuplicates: true })
    }),
  )
}
