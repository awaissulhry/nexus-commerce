import { seedUuid, type SeedContext } from '../../src/seeding'

/**
 * The golden flow's scenario (B-W1-06a), run after every base seed (seed/*.ts) of the same namespace; the base seed CLI
 * never runs it (it reads only seed/*.ts). It adds what the first real order needs that the base seed lacks AND no route
 * of the API can make today; everything else the flow makes through the routes. Each item is a gap for a later step:
 *
 *   company A    its fiscal identity (VAT number, codice fiscale, regime fiscale RF01, REA) and a full Italian address
 *                (province, CAP): quotes, purchase orders, DDTs and FatturaPA refuse a send or an issue without them,
 *                and no route sets them yet (the admin's companies screen, B-W0-27, brings one). The VAT number is made
 *                up: its office code 000 is no Italian tax office's, so it is nobody's.
 *   DDT date     the base seed's shipment story (shipping.ts) issues its DDTs on 2026-11-24, after the garments its
 *                quality seed releases on 2026-11-20: a DDT dated today would precede them, so the series refuses today's
 *                DDT until then. Company A's DDT series forgets its last issue date (numbers keep counting on); the
 *                base seed's whole November story would have to move back to drop this (see the golden-gaps notes).
 *                The INVOICE series needs nothing: the seeded deposit invoice is dated on the day its quote was accepted.
 *   Sendcloud    company A's carrier account, FAKE (no network): no route makes an integration account yet.
 *   rate limits  the tenant's accounts take a whole flow's calls in a minute (the defaults are 60, burst 10).
 *
 * Written in the tenant's office scope, as the base seeds write. Made up and harmless; a second run changes nothing.
 */

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.company.update({
        where: { id: companyA },
        data: {
          vatNumber: 'IT12345670009',
          fiscalCode: '12345670009',
          regimeFiscale: 'RF01',
          reaOffice: 'MI',
          reaNumber: '0000001',
          address: { line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
        },
        select: { id: true },
      })
      await tx.numberSeries.updateMany({ where: { companyId: companyA, kind: 'DDT' }, data: { lastIssuedDate: null } })
      const sendcloud = { companyId: companyA, provider: 'SENDCLOUD' as const, code: 'sendcloud-a', label: 'Sendcloud company A (fake)', mode: 'FAKE' as const, createdById: actorId }
      await tx.integrationAccount.upsert({ where: { id: id('integration:account:sendcloud') }, create: { id: id('integration:account:sendcloud'), ...sendcloud }, update: {}, select: { id: true } })
      await tx.integrationAccount.updateMany({ data: { rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    }),
  )
}
