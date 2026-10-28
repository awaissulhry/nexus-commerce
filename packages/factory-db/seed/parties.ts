import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  MasterStatus,
  PartyAddressKind,
  PartyContactRole,
  PartyKind,
  PartyRole,
  PartyStatus,
  PartyTaxMode,
  ViesCheckResult,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The parties' synthetic seed, per tenant of seed/_core.ts: four made-up parties with their addresses, contacts and
 * tax identities, two VIES checks and three measurement profiles, all written in the tenant's office scope, as the app
 * does.
 *
 *   P1  an Italian business customer and brand, tenant-wide: the party the audit, outbox, files, links and threads
 *       seeds already write partner rows for (the same derived id), so their made-up party is now a real one; its rider
 *       has a measurement profile.
 *   P2  an Italian supplier and subcontractor of company A only (the links seed's PO_CONFIRM party).
 *   P3  a German business customer, with a VALID VIES check and an earlier one that got no answer.
 *   P4  an Italian private rider (a person), with two revisions of a jacket profile.
 *
 * Every name, address and number is invented: `example.com` addresses, partite IVA and a German VAT number built from
 * zeros with a correct check digit (as the FatturaPA tests do), the made-up codice fiscale of the tax tests (place code
 * Z999 does not exist), and made-up SDI codes, PEC addresses and VIES consultation numbers. Idempotent: parties,
 * addresses, contacts and tax identities are upserted; VIES checks (append-only) and measurement profiles (never edited
 * in place) are inserted once and skipped when they exist (INSERT … ON CONFLICT DO NOTHING).
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T08:00:00.000Z')
const VALID_FROM = new Date('2026-01-01T00:00:00.000Z')

/** Made-up partite IVA (11 digits, the last a correct check digit); the company's is the VIES requester. */
const FAKE_VAT = { P1: '00000001016', P2: '00000002022', company: '00000003038' } as const
/** A made-up German USt-IdNr (9 digits, the last a correct ISO 7064 MOD 11,10 check digit). */
const FAKE_DE_VAT = '000000003'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface PartiesSeed {
  /** P1: the customer the other seeds' partner rows belong to. */
  readonly customerId: string
  /** P2: the supplier. */
  readonly supplierId: string
}

export async function seed({ db, namespace }: SeedContext): Promise<PartiesSeed> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const party = { P1: id('party:P1'), P2: id('party:P2'), P3: id('party:P3'), P4: id('party:P4') }
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }

  const parties: (Prisma.PartyCreateManyInput & { id: string })[] = [
    {
      id: party.P1,
      companyId: null,
      code: 'SEED-C1',
      kind: PartyKind.ORGANISATION,
      legalName: 'Seed Customer One S.r.l.',
      tradeName: 'Seed Racing',
      roles: [PartyRole.CUSTOMER, PartyRole.BRAND],
      status: PartyStatus.ACTIVE,
      country: 'IT',
      currency: 'EUR',
      language: 'it',
      paymentTerms: 'Deposit 30% at acceptance, balance at delivery',
      internalNote: 'Seed note for the office only.',
      ...stamp,
    },
    {
      id: party.P2,
      companyId: companyA,
      code: 'SEED-S1',
      kind: PartyKind.ORGANISATION,
      legalName: 'Seed Leather Supplier S.p.A.',
      tradeName: null,
      roles: [PartyRole.SUPPLIER, PartyRole.SUBCONTRACTOR],
      status: PartyStatus.ACTIVE,
      country: 'IT',
      currency: 'EUR',
      language: 'it',
      paymentTerms: 'Bank transfer 60 days end of month',
      internalNote: null,
      ...stamp,
    },
    {
      id: party.P3,
      companyId: null,
      code: 'SEED-C2',
      kind: PartyKind.ORGANISATION,
      legalName: 'Seed Customer Three GmbH',
      tradeName: null,
      roles: [PartyRole.CUSTOMER],
      status: PartyStatus.PROSPECT,
      country: 'DE',
      currency: 'EUR',
      language: 'de',
      paymentTerms: null,
      internalNote: 'Seed prospect from a trade fair.',
      ...stamp,
    },
    {
      id: party.P4,
      companyId: null,
      code: 'SEED-R1',
      kind: PartyKind.PERSON,
      legalName: 'Seed Private Rider',
      tradeName: null,
      roles: [PartyRole.CUSTOMER],
      status: PartyStatus.ACTIVE,
      country: 'IT',
      currency: 'EUR',
      language: 'it',
      paymentTerms: null,
      internalNote: null,
      ...stamp,
    },
  ]

  const address = (key: string, partyId: string, data: Omit<Prisma.PartyAddressCreateManyInput, 'id' | 'partyId'>) => ({
    id: id(`party-address:${key}`),
    partyId,
    status: MasterStatus.ACTIVE,
    ...stamp,
    ...data,
  })
  const addresses = [
    address('P1:office', party.P1, {
      kinds: [PartyAddressKind.REGISTERED, PartyAddressKind.BILL_TO],
      line1: 'Via Esempio 10',
      postalCode: '00000',
      city: 'Seedville',
      province: 'MI',
      country: 'IT',
      isDefaultBillTo: true,
    }),
    address('P1:workshop', party.P1, {
      kinds: [PartyAddressKind.SHIP_TO],
      name: 'Seed Racing workshop',
      line1: 'Via Esempio 12',
      postalCode: '00000',
      city: 'Seedville',
      province: 'MI',
      country: 'IT',
      contactName: 'Seed Receiver',
      phone: '+39 000 0000001',
      deliveryNotes: 'Mornings only.',
      isDefaultShipTo: true,
    }),
    address('P2:office', party.P2, {
      kinds: [PartyAddressKind.REGISTERED, PartyAddressKind.BILL_TO],
      line1: 'Via Esempio 20',
      postalCode: '00000',
      city: 'Seedtown',
      province: 'FI',
      country: 'IT',
      isDefaultBillTo: true,
    }),
    address('P2:tannery', party.P2, {
      kinds: [PartyAddressKind.PICKUP],
      name: 'Seed tannery',
      line1: 'Via Esempio 22',
      postalCode: '00000',
      city: 'Seedtown',
      province: 'FI',
      country: 'IT',
    }),
    address('P3:office', party.P3, {
      kinds: [PartyAddressKind.REGISTERED, PartyAddressKind.BILL_TO, PartyAddressKind.SHIP_TO],
      line1: 'Beispielstrasse 1',
      postalCode: '00000',
      city: 'Seedstadt',
      country: 'DE',
      isDefaultBillTo: true,
      isDefaultShipTo: true,
    }),
    address('P4:home', party.P4, {
      kinds: [PartyAddressKind.REGISTERED, PartyAddressKind.BILL_TO, PartyAddressKind.SHIP_TO],
      line1: 'Via Esempio 40',
      postalCode: '00000',
      city: 'Seedville',
      province: 'MI',
      country: 'IT',
      isDefaultBillTo: true,
      isDefaultShipTo: true,
    }),
  ]

  const contact = (key: string, partyId: string, data: Omit<Prisma.PartyContactCreateManyInput, 'id' | 'partyId'>) => ({
    id: id(`party-contact:${key}`),
    partyId,
    status: MasterStatus.ACTIVE,
    ...stamp,
    ...data,
  })
  // P1's buyer has the address the links seed sent P1's quote to.
  const contacts = [
    contact('P1:buyer', party.P1, { name: 'Seed Buyer One', email: 'buyer.p1@example.com', roles: [PartyContactRole.ORDERS], language: 'it' }),
    contact('P1:accounts', party.P1, { name: 'Seed Accounts One', email: 'accounts.p1@example.com', roles: [PartyContactRole.INVOICES] }),
    contact('P1:rider', party.P1, { name: 'Seed Team Rider', roles: [PartyContactRole.RIDER], language: 'en' }),
    contact('P2:orders', party.P2, { name: 'Seed Order Desk', email: 'orders.p2@example.com', phone: '+39 000 0000002', roles: [PartyContactRole.ORDERS, PartyContactRole.QUALITY] }),
    contact('P3:buyer', party.P3, { name: 'Seed Buyer Three', email: 'buyer.p3@example.com', roles: [PartyContactRole.ORDERS, PartyContactRole.INVOICES], language: 'de' }),
    contact('P4:rider', party.P4, { name: 'Seed Private Rider', email: 'rider.p4@example.com', roles: [PartyContactRole.RIDER, PartyContactRole.ORDERS] }),
  ]

  const identity = (key: string, partyId: string, data: Omit<Prisma.PartyTaxIdentityCreateManyInput, 'id' | 'partyId' | 'validFrom'>) => ({
    id: id(`party-tax:${key}`),
    partyId,
    validFrom: VALID_FROM,
    ...stamp,
    ...data,
  })
  const identities = [
    identity('P1', party.P1, { country: 'IT', taxMode: PartyTaxMode.IT_B2B, vatNumber: `IT${FAKE_VAT.P1}`, fiscalCode: FAKE_VAT.P1, sdiRecipientCode: 'SEEDC01' }),
    identity('P2', party.P2, { country: 'IT', taxMode: PartyTaxMode.IT_B2B, vatNumber: `IT${FAKE_VAT.P2}`, fiscalCode: FAKE_VAT.P2, sdiRecipientCode: '0000000', pec: 'p2@pec.example.com' }),
    identity('P3', party.P3, { country: 'DE', taxMode: PartyTaxMode.EU_B2B, vatNumber: `DE${FAKE_DE_VAT}` }),
    identity('P4', party.P4, { country: 'IT', taxMode: PartyTaxMode.IT_B2C, fiscalCode: 'TSTPRV80A41Z999I', sdiRecipientCode: '0000000' }),
  ]

  const viesChecks: Prisma.ViesCheckCreateManyInput[] = [
    {
      id: id('vies:P3:error'),
      partyId: party.P3,
      taxIdentityId: id('party-tax:P3'),
      companyId: companyA,
      countryCode: 'DE',
      vatNumber: FAKE_DE_VAT,
      requesterVatNumber: `IT${FAKE_VAT.company}`,
      requestedAt: new Date('2026-10-27T08:00:00.000Z'),
      result: ViesCheckResult.ERROR,
      errorCode: 'MS_UNAVAILABLE',
      responseSha256: sha256(`seed vies response ${namespace} P3 error`),
      requestId: 'seed-vies-P3-error',
      createdAt: new Date('2026-10-27T08:00:00.000Z'),
      createdById: actorId,
    },
    {
      id: id('vies:P3:valid'),
      partyId: party.P3,
      taxIdentityId: id('party-tax:P3'),
      companyId: companyA,
      countryCode: 'DE',
      vatNumber: FAKE_DE_VAT,
      requesterVatNumber: `IT${FAKE_VAT.company}`,
      requestedAt: AT,
      result: ViesCheckResult.VALID,
      consultationNumber: 'SEEDVIES0000001',
      traderName: 'SEED CUSTOMER THREE GMBH',
      traderAddress: 'BEISPIELSTRASSE 1, 00000 SEEDSTADT',
      responseSha256: sha256(`seed vies response ${namespace} P3 valid`),
      requestId: 'seed-vies-P3-valid',
      createdAt: AT,
      createdById: actorId,
    },
  ]

  const notice = { privacyNoticeRef: 'seed-privacy-notice-v1', privacyNoticeAt: new Date('2026-10-20T09:00:00.000Z') }
  const profile = (key: string, data: Omit<Prisma.MeasurementProfileCreateManyInput, 'id' | 'privacyNoticeRef' | 'privacyNoticeAt' | 'createdById'>) => ({
    id: id(`measurement:${key}`),
    ...notice,
    createdById: actorId,
    ...data,
  })
  const profiles = [
    profile('P1:rider:JACKET:1', {
      partyId: party.P1,
      contactId: id('party-contact:P1:rider'),
      riderName: 'Seed Team Rider',
      garmentType: 'JACKET',
      revision: 1,
      measurements: { chest: { value: '100.0', unit: 'cm' }, waist: { value: '84.0', unit: 'cm' }, sleeve: { value: '64.5', unit: 'cm' } },
      baseSize: '50',
      fitNotes: 'Racing position, slightly longer sleeves.',
      internalNote: 'Seed note for the pattern room only.',
      takenAt: new Date('2026-10-20T10:00:00.000Z'),
      takenBy: 'Seed Fitter',
      createdAt: new Date('2026-10-20T10:30:00.000Z'),
    }),
    profile('P4:rider:JACKET:1', {
      partyId: party.P4,
      contactId: id('party-contact:P4:rider'),
      riderName: 'Seed Private Rider',
      garmentType: 'JACKET',
      revision: 1,
      measurements: { chest: { value: '96.0', unit: 'cm' }, waist: { value: '80.0', unit: 'cm' }, sleeve: { value: '62.0', unit: 'cm' } },
      takenAt: new Date('2026-10-21T10:00:00.000Z'),
      takenBy: 'Seed Private Rider',
      createdAt: new Date('2026-10-21T10:30:00.000Z'),
    }),
    profile('P4:rider:JACKET:2', {
      partyId: party.P4,
      contactId: id('party-contact:P4:rider'),
      riderName: 'Seed Private Rider',
      garmentType: 'JACKET',
      revision: 2,
      supersedesId: id('measurement:P4:rider:JACKET:1'),
      measurements: { chest: { value: '97.5', unit: 'cm' }, waist: { value: '81.0', unit: 'cm' }, sleeve: { value: '62.0', unit: 'cm' } },
      fitNotes: 'Remeasured in the showroom.',
      takenAt: new Date('2026-10-22T10:00:00.000Z'),
      takenBy: 'Seed Fitter',
      createdAt: new Date('2026-10-22T10:30:00.000Z'),
    }),
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: partyId, ...data } of parties) await tx.party.upsert({ where: { id: partyId }, create: { id: partyId, ...data }, update: data })
      for (const { id: rowId, ...data } of addresses) await tx.partyAddress.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of contacts) await tx.partyContact.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of identities) await tx.partyTaxIdentity.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      await tx.viesCheck.createMany({ data: viesChecks, skipDuplicates: true })
      // In revision order: a revision's reference needs the one it supersedes.
      for (const row of profiles) await tx.measurementProfile.createMany({ data: [row], skipDuplicates: true })
    }),
  )
  return { customerId: party.P1, supplierId: party.P2 }
}
