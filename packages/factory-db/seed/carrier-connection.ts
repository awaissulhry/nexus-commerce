import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedIntegration } from './integration'

/**
 * Company A's carrier connection (B-W2b-F59), per tenant of seed/_core.ts: a Sendcloud account in FAKE mode (no network; the
 * fake carrier answers), written in the tenant's office scope. No route of the API makes an integration account, so without it
 * a local test server had no carrier at all: a site could not switch to live labels and no return label could be made (both
 * need the company's carrier connection). Every site still starts in test mode (LOG-035): plant A1 makes TEST labels until the
 * Owner switches it to live labels; only then does it buy (FAKE) labels and make return labels through it. A return label is
 * never made in test mode (B-W2b-398: a TEST label would reach a customer). The golden flow's scenario names the same account
 * (seed/scenarios/golden-flow.ts), so a second write changes nothing. Made up and harmless; idempotent.
 */

export async function seed(context: SeedContext): Promise<{ readonly accountId: string }> {
  const { db, namespace } = context
  await seedIntegration(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const accountId = id('integration:account:sendcloud')
  const account = { companyId: id('company:A'), provider: 'SENDCLOUD' as const, code: 'sendcloud-a', label: 'Sendcloud company A (fake)', mode: 'FAKE' as const, createdById: actorId }
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.integrationAccount.upsert({ where: { id: accountId }, create: { id: accountId, ...account }, update: {}, select: { id: true } }),
  )
  return { accountId }
}
