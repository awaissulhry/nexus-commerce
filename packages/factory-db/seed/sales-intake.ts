import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  ContactLawfulBasis,
  CustomerRequirementKind,
  InquiryDeclineReason,
  InquirySource,
  InquiryStatus,
  MasterStatus,
  PartyContactRole,
  PartyHoldReason,
  PartyKind,
  PartyRole,
  PartyStatus,
  RequirementStage,
  SeasonStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedEmailIn } from './email-in'
import { seed as seedFiles } from './files'
import { seed as seedNumbering } from './numbering'
import { seed as seedPricing } from './pricing'
import { seed as seedProduct } from './product'
import { seed as seedSales } from './sales'

/**
 * The sales intake and customers seed (W2b-5, schema wave 37/44, B-W2b-279), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the app does. The CLI runs the seed files in name order, and this one sorts before sales.ts, so it
 * runs the seeds it builds on first (parties through product, pricing, sales; the mail; the numbering; the office users), all
 * idempotent.
 *
 *   seasons       company A: FW27 (OPEN, the code the seeded styles carry: the first row), SS28 (OPEN, order book closing),
 *                 FW26 (CLOSED); company B: FW27 (OPEN).
 *   inquiries     company A: SEED-INQ-0001 typed in the office from a prospect not yet a party (NEW, the first row, with a line
 *                 for the jacket by size and a line in words: the first line); 0002 by phone from P3, ASSIGNED to the member;
 *                 0003 made from the mail an unknown sender wrote (MAIL, NEED_INFO), the tech pack attached to the mail named;
 *                 0004 P1's request (SEED-RFQ-12) that became SEED-Q-0001 (QUOTED); 0005 DECLINED (price); 0006 LOST, its
 *                 prospect erased.
 *   requirements  P1: packing for company A (the first row), a document rule for every company (its routing guide a file of
 *                 P1), an old care-label rule ended and the rule that superseded it for the jacket; P3: a delivery window.
 *   holds         P3: a credit hold placed and released (the first row); a rider of the team (SEED-R2): data missing, in force.
 *   terms         P3 with company A ended (the first row) and its new terms; P1 with company A (payment terms and price list of
 *                 the library, PO number required, a credit limit) and with company B (a deposit, a credit limit).
 *   contacts      the lawful basis of P1's buyer (contract), P1's accounts (legal duty), P3's buyer (legitimate interest, then an
 *                 objection) and P4's rider (consent, with when and how); P1's former buyer erased.
 *   riders        SEED-R2, a rider (a person) under the team P1.
 *   sales         the season FW27 on Q2's draft version and on SO1.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: an open
 * inquiry with no mail or quote and its line, a requirement in force that supersedes nothing, a released hold, ended terms (the
 * partial unique indexes compare only live rows), an open season. The erased contact and the rider sort last (eight f's).
 *
 * Every name, address, number, date and price is made up (example.com, example.net). Idempotent: written once, skipped when
 * the first season exists.
 */

/** Fixed instants and days, so the seed never depends on the clock (every one before the day the wave was built). */
const T = {
  setup: new Date('2026-11-02T08:00:00.000Z'),
  phoned: new Date('2026-11-03T09:15:00.000Z'),
  typed: new Date('2026-11-03T10:00:00.000Z'),
  assigned: new Date('2026-11-03T10:30:00.000Z'),
  asked: new Date('2026-11-04T08:00:00.000Z'),
  declined: new Date('2026-11-04T09:00:00.000Z'),
  lost: new Date('2026-11-05T08:00:00.000Z'),
  erased: new Date('2026-11-05T09:00:00.000Z'),
  placed: new Date('2026-11-05T10:00:00.000Z'),
  released: new Date('2026-11-06T10:00:00.000Z'),
  consent: new Date('2026-11-01T08:00:00.000Z'),
  objected: new Date('2026-11-06T08:00:00.000Z'),
} as const
const DAY = {
  fw27Start: new Date('2027-09-01T00:00:00.000Z'),
  fw27End: new Date('2028-02-29T00:00:00.000Z'),
  fw27Book: new Date('2027-04-30T00:00:00.000Z'),
  ss28Start: new Date('2028-03-01T00:00:00.000Z'),
  ss28End: new Date('2028-08-31T00:00:00.000Z'),
  ss28Book: new Date('2027-10-31T00:00:00.000Z'),
  fw26Start: new Date('2026-09-01T00:00:00.000Z'),
  fw26End: new Date('2027-02-28T00:00:00.000Z'),
  wanted: new Date('2027-03-15T00:00:00.000Z'),
} as const

export interface SalesIntakeSeed {
  readonly seasonIds: { readonly fw27: string; readonly ss28: string; readonly fw26: string; readonly fw27B: string }
  readonly inquiryIds: { readonly prospect: string; readonly assigned: string; readonly mail: string; readonly quoted: string; readonly declined: string; readonly lost: string }
  readonly inquiryLineIds: readonly [string, string, string]
  readonly requirementIds: { readonly packing: string; readonly documents: string; readonly oldLabel: string; readonly label: string; readonly delivery: string }
  readonly holdIds: { readonly released: string; readonly inForce: string }
  readonly termsIds: { readonly ended: string; readonly p3A: string; readonly p1A: string; readonly p1B: string }
  readonly erasedContactId: string
  readonly riderPartyId: string
  readonly mailId: string
  readonly fileIds: { readonly techPack: string; readonly routingGuide: string }
}

export async function seed(context: SeedContext): Promise<SalesIntakeSeed> {
  const { db, namespace } = context
  const product = await seedProduct(context)
  await seedPricing(context)
  const sales = await seedSales(context)
  await seedEmailIn(context)
  await seedNumbering(context)
  await seedAuth(context)
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const P1 = id('party:P1')
  const P3 = id('party:P3')
  const contacts = { p1Buyer: id('party-contact:P1:buyer'), p1Accounts: id('party-contact:P1:accounts'), p3Buyer: id('party-contact:P3:buyer'), p4Rider: id('party-contact:P4:rider') }
  const office = { audience: 'office', tenantId, actorId } as const
  const select = { id: true } as const
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const [colourBLK] = product.colourwayIds as [string]
  const store = id('files:account:r2')
  /** A made-up PDF kept in the seed's file store (no object behind it). */
  const file = (fileId: string, recordType: string, recordId: string, name: string, at: Date): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT',
    visibility: ['OFFICE'],
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: 4096,
    sha256: createHash('sha256').update(`seed file ${namespace} sales-intake ${fileId}`).digest('hex'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`intake:key:${fileId}`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    storeAccountId: store,
    createdAt: at,
    updatedAt: at,
    createdById: actorId,
  })

  const result: SalesIntakeSeed = {
    seasonIds: { fw27: firstId('intake:season:A:FW27'), ss28: id('intake:season:A:SS28'), fw26: id('intake:season:A:FW26'), fw27B: id('intake:season:B:FW27') },
    inquiryIds: {
      prospect: firstId('intake:inquiry:0001'),
      assigned: id('intake:inquiry:0002'),
      mail: id('intake:inquiry:0003'),
      quoted: id('intake:inquiry:0004'),
      declined: id('intake:inquiry:0005'),
      lost: id('intake:inquiry:0006'),
    },
    inquiryLineIds: [firstId('intake:inquiry:0001:10'), id('intake:inquiry:0001:20'), id('intake:inquiry:0002:10')],
    requirementIds: {
      packing: firstId('intake:requirement:P1:packing'),
      documents: id('intake:requirement:P1:documents'),
      oldLabel: id('intake:requirement:P1:label:old'),
      label: id('intake:requirement:P1:label'),
      delivery: id('intake:requirement:P3:delivery'),
    },
    holdIds: { released: firstId('intake:hold:P3:credit'), inForce: id('intake:hold:R2:data') },
    termsIds: { ended: firstId('intake:terms:P3:A:old'), p3A: id('intake:terms:P3:A'), p1A: id('intake:terms:P1:A'), p1B: id('intake:terms:P1:B') },
    erasedContactId: lateId('intake:contact:P1:former-buyer'),
    riderPartyId: lateId('intake:party:R2'),
    mailId: id('email-in:triage'),
    fileIds: { techPack: id('intake:file:mail:tech-pack'), routingGuide: id('intake:file:P1:routing-guide') },
  }
  const S = result.seasonIds
  const I = result.inquiryIds
  const R = result.requirementIds

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.season.findUnique({ where: { id: S.fw27 }, select })) return
      // What the other seeds made, read by code (their keys are theirs).
      const terms = await tx.paymentTerms.findFirst({ where: { status: MasterStatus.ACTIVE, OR: [{ companyId: companyA }, { companyId: null }] }, orderBy: { code: 'asc' }, select })
      const priceList = await tx.priceList.findFirst({ where: { code: 'SEED-PL-P1' }, select })
      if (!terms || !priceList) throw new Error('sales intake seed: no payment terms or SEED-PL-P1 (seed/pricing.ts)')

      // --- seasons ---------------------------------------------------------------------------------------------------------
      await tx.season.createMany({
        data: [
          { id: S.fw27, companyId: companyA, code: 'FW27', name: 'Fall-Winter 2027', startsOn: DAY.fw27Start, endsOn: DAY.fw27End, orderBookClosesOn: DAY.fw27Book, ...stamp(T.setup) },
          { id: S.ss28, companyId: companyA, code: 'SS28', name: 'Spring-Summer 2028', startsOn: DAY.ss28Start, endsOn: DAY.ss28End, orderBookClosesOn: DAY.ss28Book, ...stamp(T.setup) },
          { id: S.fw26, companyId: companyA, code: 'FW26', name: 'Fall-Winter 2026', startsOn: DAY.fw26Start, endsOn: DAY.fw26End, status: SeasonStatus.CLOSED, closedAt: T.setup, closedById: actorId, note: 'Seed: the season is over.', ...stamp(T.setup) },
          { id: S.fw27B, companyId: companyB, code: 'FW27', name: 'Fall-Winter 2027', startsOn: DAY.fw27Start, endsOn: DAY.fw27End, ...stamp(T.setup) },
        ],
      })
      // The season of Q2's draft version and of SO1 (only when none is set yet).
      await tx.quoteVersion.updateMany({ where: { id: sales.draftVersionId, seasonId: null }, data: { seasonId: S.fw27 } })
      await tx.salesOrder.updateMany({ where: { id: sales.orderId, seasonId: null }, data: { seasonId: S.fw27 } })

      // --- a rider under a team, and the contacts' lawful basis --------------------------------------------------------------
      await tx.party.create({
        data: {
          id: result.riderPartyId,
          companyId: null,
          code: 'SEED-R2',
          kind: PartyKind.PERSON,
          legalName: 'Seed Team Rider Two',
          roles: [PartyRole.CUSTOMER],
          status: PartyStatus.ACTIVE,
          country: 'IT',
          teamPartyId: P1,
          ...stamp(T.setup),
        },
        select,
      })
      const basis = (contactId: string, data: Prisma.PartyContactUpdateManyMutationInput) =>
        tx.partyContact.updateMany({ where: { id: contactId, lawfulBasis: null }, data: { ...data, updatedAt: T.setup } })
      await basis(contacts.p1Buyer, { lawfulBasis: ContactLawfulBasis.CONTRACT })
      await basis(contacts.p1Accounts, { lawfulBasis: ContactLawfulBasis.LEGAL_DUTY })
      await basis(contacts.p3Buyer, { lawfulBasis: ContactLawfulBasis.LEGITIMATE_INTEREST, objectedAt: T.objected })
      await basis(contacts.p4Rider, { lawfulBasis: ContactLawfulBasis.CONSENT, consentAt: T.consent, consentSource: 'Ticked the consent box on the made-to-measure form (seed).' })
      // A former buyer of P1, erased on request: the row stays (a quote may name it), its personal fields blank for good.
      await tx.partyContact.create({
        data: { id: result.erasedContactId, partyId: P1, name: 'Seed Former Buyer', email: 'former.buyer.p1@example.com', phone: '+39 000 0000009', roles: [PartyContactRole.ORDERS], lawfulBasis: ContactLawfulBasis.CONTRACT, ...stamp(T.setup) },
        select,
      })
      await tx.partyContact.update({
        where: { id: result.erasedContactId },
        data: { name: '', email: null, phone: null, status: MasterStatus.ARCHIVED, erasedAt: T.erased, erasedById: actorId, updatedAt: T.erased },
        select,
      })

      // --- inquiries -------------------------------------------------------------------------------------------------------
      const inquiry = (key: keyof typeof I, number: string, data: Omit<Prisma.InquiryCreateManyInput, 'id' | 'companyId' | 'number'>): Prisma.InquiryCreateManyInput => ({
        id: I[key],
        companyId: companyA,
        number,
        ...data,
      })
      await tx.inquiry.createMany({
        data: [
          inquiry('prospect', 'SEED-INQ-0001', {
            source: InquirySource.OFFICE,
            receivedAt: T.typed,
            prospectName: 'Seed Prospect',
            prospectCompany: 'Seed Moto Club',
            prospectEmail: 'prospect.club@example.com',
            prospectPhone: '+39 000 0000011',
            prospectLawfulBasis: ContactLawfulBasis.CONTRACT,
            request: 'Twenty touring jackets for the club, black, with the club logo on the back; gloves to match.',
            wantedDate: DAY.wanted,
            targetUnitPrice: '380.000000',
            ...stamp(T.typed),
          }),
          inquiry('assigned', 'SEED-INQ-0002', {
            source: InquirySource.PHONE,
            receivedAt: T.phoned,
            partyId: P3,
            contactId: contacts.p3Buyer,
            request: 'Phone call: a reorder of last season jacket in two colours, about 60 pieces, delivery before March.',
            status: InquiryStatus.ASSIGNED,
            assigneeId: memberId,
            assignedAt: T.assigned,
            ...stamp(T.phoned),
          }),
          inquiry('mail', 'SEED-INQ-0003', {
            source: InquirySource.MAIL,
            sourceEmailId: result.mailId,
            receivedAt: T.typed,
            prospectName: 'Nuovo Cliente',
            prospectEmail: `new.buyer.${namespace}@example.net`,
            prospectLawfulBasis: ContactLawfulBasis.CONTRACT,
            request: 'Buongiorno,\nvorremmo un preventivo per 40 giacche in pelle.\nGrazie',
            techPackVersion: 'TP 1 (seed)',
            ...stamp(T.typed),
          }),
          inquiry('quoted', 'SEED-INQ-0004', {
            source: InquirySource.OFFICE,
            receivedAt: T.setup,
            partyId: P1,
            contactId: contacts.p1Buyer,
            request: 'RFQ SEED-RFQ-12: the touring jacket in black and red, sizes 50 to 54.',
            ...stamp(T.setup),
          }),
          inquiry('declined', 'SEED-INQ-0005', {
            source: InquirySource.FAIR,
            receivedAt: T.setup,
            partyId: P3,
            request: 'At the fair: 500 summer vests at a very low price.',
            targetUnitPrice: '45.000000',
            ...stamp(T.setup),
          }),
          inquiry('lost', 'SEED-INQ-0006', {
            source: InquirySource.PHONE,
            receivedAt: T.setup,
            prospectName: 'Seed Caller',
            prospectPhone: '+39 000 0000012',
            prospectLawfulBasis: ContactLawfulBasis.CONTRACT,
            request: 'A caller asked about a racing suit for one rider.',
            ...stamp(T.setup),
          }),
        ],
      })
      await tx.inquiryLine.createMany({
        data: [
          { id: result.inquiryLineIds[0], inquiryId: I.prospect, seq: 10, styleId: product.styleId, colourwayId: colourBLK, sizes: { '50': 5, '52': 10, '54': 5 }, quantity: 20, note: 'Club logo on the back.', ...stamp(T.typed) },
          { id: result.inquiryLineIds[1], inquiryId: I.prospect, seq: 20, description: 'Matching gloves', colourText: 'black', quantity: 20, ...stamp(T.typed) },
          { id: result.inquiryLineIds[2], inquiryId: I.assigned, seq: 10, styleId: product.styleId, description: 'Last season jacket, black and red', quantity: 60, ...stamp(T.phoned) },
        ],
      })
      // The tech pack the sender attached: a file of the mail (kept from it), named as the brand's tech pack in force.
      await tx.storedFile.createMany({
        data: [
          file(result.fileIds.techPack, 'InboundEmail', result.mailId, 'Seed tech pack TP1.pdf', T.typed),
          file(result.fileIds.routingGuide, 'Party', P1, 'Seed routing guide.pdf', T.setup),
        ],
        skipDuplicates: true,
      })
      await tx.inquiry.update({ where: { id: I.mail }, data: { techPackFileIds: [result.fileIds.techPack], updatedAt: T.asked }, select })
      // 0003: we asked the sender for the sizes.
      await tx.inquiry.update({ where: { id: I.mail }, data: { status: InquiryStatus.NEED_INFO, updatedAt: T.asked }, select })
      // 0004 became Q1.
      await tx.inquiry.update({ where: { id: I.quoted }, data: { status: InquiryStatus.QUOTED, quoteId: sales.quoteId, closedAt: T.typed, closedById: actorId, updatedAt: T.typed }, select })
      // 0005 declined: the price.
      await tx.inquiry.update({ where: { id: I.declined }, data: { status: InquiryStatus.DECLINED, declineReason: InquiryDeclineReason.PRICE, closeNote: 'Below our cost for a certified vest.', closedAt: T.declined, closedById: memberId, updatedAt: T.declined }, select })
      // 0006 lost, then its caller's data erased on request.
      await tx.inquiry.update({ where: { id: I.lost }, data: { status: InquiryStatus.LOST, closeNote: 'The caller did not answer after the first call.', closedAt: T.lost, closedById: memberId, updatedAt: T.lost }, select })
      await tx.inquiry.update({ where: { id: I.lost }, data: { prospectName: null, prospectPhone: null, prospectErasedAt: T.erased, prospectErasedById: actorId, updatedAt: T.erased }, select })

      // --- customer requirements -------------------------------------------------------------------------------------------
      await tx.customerRequirement.createMany({
        data: [
          { id: R.packing, partyId: P1, companyId: companyA, kind: CustomerRequirementKind.PACKING, words: 'Each jacket folded in tissue paper, the hangtag on the left sleeve.', appliesAt: [RequirementStage.ORDER, RequirementStage.PACKING], ...stamp(T.setup) },
          { id: R.documents, partyId: P1, kind: CustomerRequirementKind.DOCUMENT, words: 'A packing list with every DDT, and the order number on every invoice (see the routing guide).', appliesAt: [RequirementStage.SHIPMENT, RequirementStage.INVOICE], fileId: result.fileIds.routingGuide, ...stamp(T.setup) },
          { id: R.oldLabel, partyId: P1, companyId: companyA, kind: CustomerRequirementKind.LABEL, words: 'Care label in Italian and English.', appliesAt: [RequirementStage.ORDER], ...stamp(T.setup) },
          { id: R.delivery, partyId: P3, kind: CustomerRequirementKind.SHIPPING, words: 'Deliveries Monday to Thursday, 8:00 to 16:00 only.', appliesAt: [RequirementStage.SHIPMENT], ...stamp(T.setup) },
        ],
      })
      // The care-label rule changed: the old one ended, the new one supersedes it, for the jacket only.
      await tx.customerRequirement.update({ where: { id: R.oldLabel }, data: { active: false, endedAt: T.asked, endedById: actorId, endReason: 'German added for the new market.', updatedAt: T.asked }, select })
      await tx.customerRequirement.create({
        data: { id: R.label, partyId: P1, companyId: companyA, kind: CustomerRequirementKind.LABEL, words: 'Care label in Italian, English and German.', appliesAt: [RequirementStage.QUOTE, RequirementStage.ORDER], styleIds: [product.styleId], supersedesId: R.oldLabel, ...stamp(T.asked) },
        select,
      })

      // --- holds -----------------------------------------------------------------------------------------------------------
      await tx.partyHold.createMany({
        data: [
          { id: result.holdIds.released, partyId: P3, companyId: companyA, reason: PartyHoldReason.CREDIT, words: 'Two invoices overdue by more than 60 days.', placedAt: T.placed, placedById: actorId, ...stamp(T.placed) },
          { id: result.holdIds.inForce, partyId: result.riderPartyId, reason: PartyHoldReason.DATA_MISSING, words: 'No codice fiscale yet for the invoices.', placedAt: T.placed, placedById: memberId, ...stamp(T.placed) },
        ],
      })
      await tx.partyHold.update({ where: { id: result.holdIds.released }, data: { releasedAt: T.released, releasedById: actorId, releaseWords: 'Both invoices paid.', updatedAt: T.released }, select })

      // --- terms per company -----------------------------------------------------------------------------------------------
      const T3 = result.termsIds
      await tx.partyCompanyTerms.create({ data: { id: T3.ended, partyId: P3, companyId: companyA, depositPct: '50.0000', updatedById: actorId, ...stamp(T.setup) }, select })
      await tx.partyCompanyTerms.update({ where: { id: T3.ended }, data: { endedAt: T.asked, endedById: actorId, updatedAt: T.asked }, select })
      await tx.partyCompanyTerms.createMany({
        data: [
          { id: T3.p3A, partyId: P3, companyId: companyA, depositPct: '20.0000', updatedById: actorId, ...stamp(T.asked) },
          {
            id: T3.p1A,
            partyId: P1,
            companyId: companyA,
            paymentTerms: 'Deposit 30% at acceptance, balance at 30 days',
            paymentTermsId: terms.id,
            priceListId: priceList.id,
            depositPct: '30.0000',
            poNumberRequired: true,
            creditLimitAmount: 5_000_000,
            creditLimitCurrency: 'EUR',
            updatedById: actorId,
            ...stamp(T.setup),
          },
          { id: T3.p1B, partyId: P1, companyId: companyB, depositPct: '40.0000', creditLimitAmount: 1_500_000, creditLimitCurrency: 'EUR', updatedById: memberId, ...stamp(T.setup) },
        ],
      })
    }),
  )
  return result
}
