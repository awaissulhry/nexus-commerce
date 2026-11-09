import type { Prisma } from '../src/generated/prisma/client'
import {
  CertificateStatus,
  ComplianceGate,
  ComplianceRequirementKind,
  EconomicOperatorKind,
  GateOutcome,
  MasterStatus,
  PhraseKind,
  PhraseTranslationStatus,
  PpeCategory,
  ProductType,
  RegulationKind,
  RegulationStatus,
  StandardChangeImpact,
  StandardChangeKind,
  StandardChangeStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCompliance } from './compliance'
import { seed as seedProduction } from './production'

/**
 * The compliance rule library seed (W2b-4, schema wave 30/33, B-W2b-216), per tenant of seed/_core.ts, written in the tenant's
 * office scope, as the app does. The CLI runs the seed files in name order and this one sorts before compliance.ts and
 * production.ts, which it runs first anyway (idempotent: the jacket's certificates and the work orders it names). Every name,
 * code, address and figure is made up; the laws and standards are cited by their public references, their wording here is the
 * seed's own.
 *
 *   register      Reg. (EU) 2016/425, 1007/2011, 2019/1020, 2023/988, REACH Annex XVII entry 47; EN 17092-3:2020 and
 *                 EN 17092-4:2020 and EN 13594:2015 (harmonised), EN 1621-1:2012 (not cited), EN 13595-1:2002 (withdrawn).
 *                 The watch: EN 13595-1's withdrawal (CLOSED, no impact) and a made-up amendment of EN 17092-3 (OPEN, naming
 *                 the jacket's certificate).
 *   markets       IT, DE, FR (a made-up national extra), ES switched on; UK, CH, US switched OFF (Owner question Q23: the first
 *                 orders stay in the EU).
 *   requirements  the certificate covers the garment (W1's QHS-051 and MES-004 as one requirement: locked at label print, final
 *                 release and shipment, the company's choice at work-order release); the DoC and the user information in the
 *                 market's languages (the user information locked at shipment, overridable at release); the label's
 *                 languages; an economic operator; the Cr VI evidence (checklist only); and, switched OFF with their Owner
 *                 question, the 80 % textile rule, the care label and Made in Italy for Italy (B-W2b-208's switches, per
 *                 market here), the UK importer, the GPSR contact (Q37) and the glove levels (Q10).
 *   gate events   WO-0001's label for Germany refused at A1 (a German warning not approved); WO-0002's release refused for the
 *                 German user information and overridden for three days with a step-up; a shipment of B1 refused for the
 *                 French DoC.
 *   operators     company A's and company B's default manufacturer; the brand P1 as the manufacturer of its private-label
 *                 styles (Owner 11-09, question 3); a Swiss distributor of SEED-JKT-01.
 *   phrases       a class warning, a care word, the animal-origin marking, a DoC sentence, a storage line, a claim; their
 *                 translations: approved by a second person, superseded, and drafts.
 *   bodies        the seed notified body "0000" (the number the W1 certificates carry) with an archived earlier entry, and a
 *                 second body "9999".
 *   certificates  the factory's base certificate SEED-CERT-2161 (company A), the brand P1's own-brand certificate SEED-CERT-2162
 *                 resting on it, a DRAFT glove certificate SEED-CERT-2163 with its EN 13594 levels; the protector's coverage
 *                 names its supplier P2 and P2's article code.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first register entry (no edition), market, requirement, gate refusal (at A1, by a requirement that blocks label print),
 * operator, phrase, translation (a DRAFT), standard change and notified body (ARCHIVED: one ACTIVE per number) get ids that
 * start with eight zeros; the override and the three certificates get eight f's (a copy of a certificate naming its body takes
 * a suffixed typed number, which the body's no longer matches). Idempotent: written once, skipped when the certificate
 * requirement exists; the coverage's supplier is named once.
 */

/** Fixed instants and days, so the seed never depends on the clock. */
const T = {
  register: new Date('2026-11-23T08:00:00.000Z'),
  refusedLabel: new Date('2026-11-24T09:15:00.000Z'),
  refusedRelease: new Date('2026-11-24T10:00:00.000Z'),
  stepUp: new Date('2026-11-24T10:08:00.000Z'),
  override: new Date('2026-11-24T10:10:00.000Z'),
  overrideUntil: new Date('2026-11-27T10:10:00.000Z'),
  refusedShipment: new Date('2026-11-25T14:30:00.000Z'),
  approved: new Date('2026-11-23T11:00:00.000Z'),
}
const day = (date: string): Date => new Date(`${date}T00:00:00.000Z`)

export interface ComplianceRulesSeed {
  readonly regulationIds: { readonly ppe: string; readonly en17092_3: string; readonly en13594: string; readonly en13595: string }
  readonly changeIds: { readonly withdrawal: string; readonly amendment: string }
  readonly marketIds: Readonly<Record<'IT' | 'DE' | 'FR' | 'ES' | 'UK' | 'CH' | 'US', string>>
  readonly requirementIds: {
    readonly certificate: string
    readonly docLanguage: string
    readonly userInfoLanguage: string
    readonly labelLanguage: string
    readonly operator: string
    readonly crVi: string
    readonly textileShareIt: string
    readonly careLabelIt: string
    readonly madeInItalyIt: string
    readonly importerUk: string
    readonly gpsrContact: string
    readonly gloveLevels: string
  }
  readonly gateEventIds: { readonly labelRefused: string; readonly releaseRefused: string; readonly releaseOverridden: string; readonly shipmentRefused: string }
  readonly operatorIds: { readonly companyA: string; readonly companyB: string; readonly brand: string; readonly styleCh: string }
  readonly phraseIds: { readonly warning: string; readonly care: string; readonly animalOrigin: string; readonly doc: string; readonly storage: string; readonly claim: string }
  readonly translationIds: {
    readonly warningDe: string
    readonly warningEn: string
    readonly careEn1: string
    readonly careEn2: string
    readonly animalEn: string
    readonly animalDe: string
    readonly animalFr: string
    readonly storageEn: string
  }
  readonly bodyIds: { readonly archived: string; readonly active: string; readonly second: string }
  readonly certificateIds: { readonly base: string; readonly ownBrand: string; readonly glove: string }
  /** The translator of the seeded translations (a made-up person, not the approver). */
  readonly translatorId: string
}

export async function seed(context: SeedContext): Promise<ComplianceRulesSeed> {
  const { db, namespace } = context
  const compliance = await seedCompliance(context)
  const production = await seedProduction(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const company = { A: id('company:A'), B: id('company:B') }
  const site = { A1: id('site:A1'), B1: id('site:B1') }
  const party = { P1: id('party:P1'), P2: id('party:P2'), P3: id('party:P3') }
  const translatorId = id('compliance-rules:user:translator')
  /** The product seed's jacket SEED-JKT-01 (tenant-wide, the brand P1's), which seed/compliance.ts certifies. */
  const jacketStyleId = id('product:style:JKT-01')
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const words = (it: string, en: string) => ({ it, en })

  const result: ComplianceRulesSeed = {
    regulationIds: {
      ppe: firstId('compliance-rules:reg:2016-425'),
      en17092_3: id('compliance-rules:reg:EN-17092-3:2020'),
      en13594: id('compliance-rules:reg:EN-13594:2015'),
      en13595: id('compliance-rules:reg:EN-13595-1:2002'),
    },
    changeIds: { withdrawal: firstId('compliance-rules:change:EN-13595-1'), amendment: id('compliance-rules:change:EN-17092-3') },
    marketIds: {
      IT: firstId('compliance-rules:market:IT'),
      DE: id('compliance-rules:market:DE'),
      FR: id('compliance-rules:market:FR'),
      ES: id('compliance-rules:market:ES'),
      UK: id('compliance-rules:market:UK'),
      CH: id('compliance-rules:market:CH'),
      US: id('compliance-rules:market:US'),
    },
    requirementIds: {
      certificate: id('compliance-rules:req:CERT-COVERAGE'),
      docLanguage: id('compliance-rules:req:DOC-LANGUAGE'),
      userInfoLanguage: id('compliance-rules:req:USER-INFO-LANGUAGE'),
      labelLanguage: firstId('compliance-rules:req:LABEL-LANGUAGE'),
      operator: id('compliance-rules:req:EU-OPERATOR'),
      crVi: id('compliance-rules:req:CRVI-EVIDENCE'),
      textileShareIt: id('compliance-rules:req:TEXTILE-SHARE-IT'),
      careLabelIt: id('compliance-rules:req:CARE-LABEL-IT'),
      madeInItalyIt: id('compliance-rules:req:MADE-IN-ITALY-IT'),
      importerUk: id('compliance-rules:req:IMPORTER-UK'),
      gpsrContact: id('compliance-rules:req:GPSR-CONTACT'),
      gloveLevels: id('compliance-rules:req:GLOVE-LEVELS'),
    },
    gateEventIds: {
      labelRefused: firstId('compliance-rules:gate:WO-0001:label'),
      releaseRefused: id('compliance-rules:gate:WO-0002:release'),
      releaseOverridden: lastId('compliance-rules:gate:WO-0002:release:override'),
      shipmentRefused: id('compliance-rules:gate:B1:shipment'),
    },
    operatorIds: {
      companyA: firstId('compliance-rules:operator:A:MANUFACTURER'),
      companyB: id('compliance-rules:operator:B:MANUFACTURER'),
      brand: id('compliance-rules:operator:P1:MANUFACTURER'),
      styleCh: id('compliance-rules:operator:JKT-01:CH:DISTRIBUTOR'),
    },
    phraseIds: {
      warning: firstId('compliance-rules:phrase:warning.class-a'),
      care: id('compliance-rules:phrase:care.wash-not'),
      animalOrigin: id('compliance-rules:phrase:marking.animal-origin'),
      doc: id('compliance-rules:phrase:doc.sole-responsibility'),
      storage: id('compliance-rules:phrase:userinfo.storage'),
      claim: id('compliance-rules:phrase:claim.made-in-italy'),
    },
    translationIds: {
      warningDe: firstId('compliance-rules:translation:warning.class-a:de:1'),
      warningEn: id('compliance-rules:translation:warning.class-a:en:1'),
      careEn1: id('compliance-rules:translation:care.wash-not:en:1'),
      careEn2: id('compliance-rules:translation:care.wash-not:en:2'),
      animalEn: id('compliance-rules:translation:marking.animal-origin:en:1'),
      animalDe: id('compliance-rules:translation:marking.animal-origin:de:1'),
      animalFr: id('compliance-rules:translation:marking.animal-origin:fr:1'),
      storageEn: id('compliance-rules:translation:userinfo.storage:en:1'),
    },
    bodyIds: { archived: firstId('compliance-rules:body:0000:old'), active: id('compliance-rules:body:0000'), second: id('compliance-rules:body:9999') },
    certificateIds: {
      base: lastId('compliance-rules:certificate:SEED-CERT-2161'),
      ownBrand: lastId('compliance-rules:certificate:SEED-CERT-2162'),
      glove: lastId('compliance-rules:certificate:SEED-CERT-2163'),
    },
    translatorId,
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      // The protector's coverage (seed/compliance.ts) names its supplier once.
      await tx.certificateCoverage.updateMany({
        where: { id: id('compliance:coverage:PRO-300'), supplierPartyId: null },
        data: { supplierPartyId: party.P2, supplierArticleCode: 'P2-SHD-L2' },
      })
      if (await tx.complianceRequirement.findUnique({ where: { id: result.requirementIds.certificate }, select: { id: true } })) return

      // --- The register and the watch -------------------------------------------------------------------------------
      const reg = result.regulationIds
      const regulations: (Prisma.RegulationOrStandardCreateManyInput & { id: string })[] = [
        { id: reg.ppe, code: 'Reg. (EU) 2016/425', title: 'Regulation (EU) 2016/425 on personal protective equipment', titleI18n: words('Regolamento (UE) 2016/425 sui dispositivi di protezione individuale', 'Regulation (EU) 2016/425 on personal protective equipment'), kind: RegulationKind.REGULATION, ojReference: 'OJ L 81, 31.3.2016', ojDate: day('2016-03-31'), link: 'https://eur-lex.europa.eu/eli/reg/2016/425/oj', ...stamp(T.register) },
        { id: reg.en17092_3, code: 'EN 17092-3', edition: '2020', title: 'Protective garments for motorcycle riders - Part 3: Class AA garments', kind: RegulationKind.HARMONISED_STANDARD, ojReference: 'OJ L 77, 5.3.2021', ojDate: day('2021-03-05'), ...stamp(T.register) },
        { id: id('compliance-rules:reg:EN-17092-4:2020'), code: 'EN 17092-4', edition: '2020', title: 'Protective garments for motorcycle riders - Part 4: Class A garments', kind: RegulationKind.HARMONISED_STANDARD, ojReference: 'OJ L 77, 5.3.2021', ojDate: day('2021-03-05'), ...stamp(T.register) },
        { id: reg.en13594, code: 'EN 13594', edition: '2015', title: 'Protective gloves for motorcycle riders', kind: RegulationKind.HARMONISED_STANDARD, ojReference: 'OJ C 113, 2018', ...stamp(T.register) },
        { id: id('compliance-rules:reg:EN-1621-1:2012'), code: 'EN 1621-1', edition: '2012', title: 'Motorcyclists\' protective clothing against mechanical impact - Part 1: Limb joint impact protectors', kind: RegulationKind.STANDARD, note: 'Seed: used by the protector certificates; not on the Commission\'s list of harmonised standards.', ...stamp(T.register) },
        { id: reg.en13595, code: 'EN 13595-1', edition: '2002', title: 'Protective clothing for professional motorcycle riders - Part 1: General requirements', kind: RegulationKind.HARMONISED_STANDARD, status: RegulationStatus.WITHDRAWN, note: 'Seed: lost its legal effect on 5.9.2022.', ...stamp(T.register) },
        { id: id('compliance-rules:reg:1007-2011'), code: 'Reg. (EU) 1007/2011', title: 'Regulation (EU) 1007/2011 on textile fibre names and labelling', kind: RegulationKind.REGULATION, ...stamp(T.register) },
        { id: id('compliance-rules:reg:2019-1020'), code: 'Reg. (EU) 2019/1020', title: 'Regulation (EU) 2019/1020 on market surveillance and compliance of products', kind: RegulationKind.REGULATION, ...stamp(T.register) },
        { id: id('compliance-rules:reg:2023-988'), code: 'Reg. (EU) 2023/988', title: 'Regulation (EU) 2023/988 on general product safety', kind: RegulationKind.REGULATION, ...stamp(T.register) },
        { id: id('compliance-rules:reg:REACH-XVII-47'), code: 'REACH Annex XVII entry 47', title: 'Chromium VI in leather articles coming into contact with the skin', kind: RegulationKind.REGULATION, ...stamp(T.register) },
      ]
      await tx.regulationOrStandard.createMany({ data: regulations })
      await tx.standardChange.createMany({
        data: [
          {
            id: result.changeIds.withdrawal,
            standardId: reg.en13595,
            newStandardId: reg.en17092_3,
            kind: StandardChangeKind.WITHDRAWAL,
            whatChanged: 'Seed: its reference left the Official Journal; EN 17092 takes its place for riders\' garments.',
            noticedAt: T.register,
            noticedById: actorId,
            status: StandardChangeStatus.CLOSED,
            impact: StandardChangeImpact.NONE,
            assessment: 'Seed: no certificate of ours cites it; nothing to review.',
            assessedAt: T.register,
            assessedById: actorId,
            closedAt: T.register,
            closedById: actorId,
            ...stamp(T.register),
          },
          {
            id: result.changeIds.amendment,
            standardId: reg.en17092_3,
            kind: StandardChangeKind.AMENDMENT,
            whatChanged: 'Seed (made up): an amendment to the abrasion test annex is announced.',
            sourceReference: 'Seed announcement',
            noticedAt: T.register,
            noticedById: actorId,
            transitionEndsOn: day('2027-06-30'),
            certificateIds: [compliance.certificateId],
            ...stamp(T.register),
          },
        ],
      })

      // --- Markets ----------------------------------------------------------------------------------------------------
      const offQ23 = 'Owner question Q23: the first orders stay in the EU (euro, documents in Italian and English).'
      const m = result.marketIds
      const markets: (Prisma.MarketProfileCreateManyInput & { id: string })[] = [
        { id: m.IT, code: 'IT', name: 'Italy', nameI18n: words('Italia', 'Italy'), labelLanguages: ['it'], docLanguages: ['it'], userInfoLanguages: ['it'], markings: ['CE'], seq: 1, ...stamp(T.register) },
        { id: m.DE, code: 'DE', name: 'Germany', nameI18n: words('Germania', 'Germany'), labelLanguages: ['de'], docLanguages: ['de'], userInfoLanguages: ['de'], markings: ['CE'], seq: 2, ...stamp(T.register) },
        {
          id: m.FR,
          code: 'FR',
          name: 'France',
          nameI18n: words('Francia', 'France'),
          labelLanguages: ['fr'],
          docLanguages: ['fr'],
          userInfoLanguages: ['fr'],
          markings: ['CE'],
          nationalRules: [{ key: 'fr-seed-extra', words: words('Regola nazionale di esempio (inventata).', 'A made-up national rule.'), law: 'Seed national law' }],
          seq: 3,
          ...stamp(T.register),
        },
        { id: m.ES, code: 'ES', name: 'Spain', nameI18n: words('Spagna', 'Spain'), labelLanguages: ['es'], docLanguages: ['es'], userInfoLanguages: ['es'], markings: ['CE'], seq: 4, ...stamp(T.register) },
        { id: m.UK, code: 'UK', name: 'United Kingdom', nameI18n: words('Regno Unito', 'United Kingdom'), labelLanguages: ['en'], docLanguages: ['en'], userInfoLanguages: ['en'], markings: ['UKCA'], importerNeeded: true, seq: 6, switchedOn: false, offReason: offQ23, switchedAt: T.register, switchedById: actorId, ...stamp(T.register) },
        { id: m.CH, code: 'CH', name: 'Switzerland', nameI18n: words('Svizzera', 'Switzerland'), labelLanguages: ['de', 'fr', 'it'], docLanguages: ['de', 'fr', 'it'], userInfoLanguages: ['de', 'fr', 'it'], markings: ['CE'], importerNeeded: true, seq: 7, switchedOn: false, offReason: offQ23, switchedAt: T.register, switchedById: actorId, ...stamp(T.register) },
        { id: m.US, code: 'US', name: 'United States', nameI18n: words('Stati Uniti', 'United States'), labelLanguages: ['en'], userInfoLanguages: ['en'], importerNeeded: true, seq: 8, switchedOn: false, offReason: offQ23, switchedAt: T.register, switchedById: actorId, ...stamp(T.register) },
      ]
      await tx.marketProfile.createMany({ data: markets })

      // --- Requirements -----------------------------------------------------------------------------------------------
      const r = result.requirementIds
      const certified = [PpeCategory.CATEGORY_II, PpeCategory.CATEGORY_III]
      const off = (offReason: string) => ({ switchedOn: false, offReason, switchedAt: T.register, switchedById: actorId })
      const requirements: (Prisma.ComplianceRequirementCreateManyInput & { id: string })[] = [
        {
          id: r.certificate,
          code: 'CERT-COVERAGE',
          name: 'A valid certificate covers the style, colourway and size',
          nameI18n: words('Un certificato valido copre modello, colore e taglia', 'A valid certificate covers the style, colourway and size'),
          kind: ComplianceRequirementKind.CERTIFICATE,
          checkKey: 'certificate.coverage',
          ppeCategories: certified,
          blocks: [ComplianceGate.WORK_ORDER_RELEASE, ComplianceGate.LABEL_PRINT, ComplianceGate.FINAL_RELEASE, ComplianceGate.SHIPMENT],
          lockedBlocks: [ComplianceGate.LABEL_PRINT, ComplianceGate.FINAL_RELEASE, ComplianceGate.SHIPMENT],
          legalReference: 'Reg. (EU) 2016/425 art. 8(2), Annex V',
          regulationId: reg.ppe,
          explanationI18n: words('Un DPI di categoria II o III si etichetta e si immette sul mercato solo con un certificato UE del tipo valido.', 'A category II or III PPE is labelled and placed on the market only under a valid EU type-examination certificate.'),
          seq: 10,
          note: 'W1\'s two gates, QHS-051 (label, final release) and MES-004 (work-order release), as one requirement.',
          ...stamp(T.register),
        },
        {
          id: r.docLanguage,
          code: 'DOC-LANGUAGE',
          name: 'The Declaration of Conformity is in the market\'s languages',
          kind: ComplianceRequirementKind.DOC_LANGUAGE,
          ppeCategories: certified,
          blocks: [ComplianceGate.SHIPMENT],
          overrideRoleKeys: ['owner'],
          legalReference: 'Reg. (EU) 2016/425 art. 15(2)',
          regulationId: reg.ppe,
          seq: 20,
          ...stamp(T.register),
        },
        {
          id: r.userInfoLanguage,
          code: 'USER-INFO-LANGUAGE',
          name: 'The user information is in the market\'s languages',
          kind: ComplianceRequirementKind.USER_INFO_LANGUAGE,
          ppeCategories: certified,
          blocks: [ComplianceGate.WORK_ORDER_RELEASE, ComplianceGate.SHIPMENT],
          lockedBlocks: [ComplianceGate.SHIPMENT],
          overrideRoleKeys: ['owner', 'quality_inspector'],
          overrideMaxDays: 7,
          legalReference: 'Reg. (EU) 2016/425 art. 8(7), Annex II 1.4',
          regulationId: reg.ppe,
          seq: 30,
          ...stamp(T.register),
        },
        {
          id: r.labelLanguage,
          code: 'LABEL-LANGUAGE',
          name: 'The label prints in the market\'s languages from approved phrases',
          kind: ComplianceRequirementKind.LABEL,
          checkKey: 'label.languages',
          blocks: [ComplianceGate.LABEL_PRINT],
          overrideRoleKeys: ['quality_inspector'],
          overrideMaxDays: 3,
          legalReference: 'Reg. (EU) 2016/425 art. 8(7); Reg. (EU) 1007/2011 art. 16(3)',
          seq: 40,
          ...stamp(T.register),
        },
        {
          id: r.operator,
          code: 'EU-OPERATOR',
          name: 'An economic operator established in the EU is named',
          kind: ComplianceRequirementKind.OPERATOR_ROLE,
          operatorRole: EconomicOperatorKind.MANUFACTURER,
          blocks: [ComplianceGate.SHIPMENT],
          overrideRoleKeys: ['owner'],
          legalReference: 'Reg. (EU) 2019/1020 art. 4',
          seq: 50,
          ...stamp(T.register),
        },
        {
          id: r.crVi,
          code: 'CRVI-EVIDENCE',
          name: 'Cr VI evidence for the leather lots',
          kind: ComplianceRequirementKind.TEST,
          checkKey: 'crvi.evidence',
          legalReference: 'REACH Annex XVII entry 47',
          seq: 60,
          note: 'Checklist only: W1 checks it by a person (Rules & markets › Chromium VI evidence).',
          ...stamp(T.register),
        },
        {
          id: r.textileShareIt,
          code: 'TEXTILE-SHARE-IT',
          name: 'Textile labelling when the garment is 80 % or more textile',
          kind: ComplianceRequirementKind.LABEL,
          checkKey: 'textile.textileShare',
          marketCode: 'IT',
          legalReference: 'Reg. (EU) 1007/2011 art. 2(2)(a)',
          seq: 70,
          ...off('Owner question Q10: garments with 80 % or more textile? Until answered the rule only reports (B-W2b-208).'),
          ...stamp(T.register),
        },
        {
          id: r.careLabelIt,
          code: 'CARE-LABEL-IT',
          name: 'A care label with the ISO 3758 symbols',
          kind: ComplianceRequirementKind.LABEL,
          checkKey: 'textile.careLabel',
          marketCode: 'IT',
          legalReference: 'ISO 3758 (care labelling code)',
          seq: 71,
          ...off('Not yet verified that a care label is required in Italy; switched off until checked (B-W2b-208).'),
          ...stamp(T.register),
        },
        {
          id: r.madeInItalyIt,
          code: 'MADE-IN-ITALY-IT',
          name: 'The "Made in Italy" claim is allowed by where the garment is made',
          kind: ComplianceRequirementKind.CLAIM_EVIDENCE,
          checkKey: 'textile.madeInItaly',
          marketCode: 'IT',
          legalReference: 'Reg. (EU) 952/2013 art. 60(2); L. 350/2003 art. 4(49)',
          seq: 72,
          ...off('Owner questions Q22 and Q23: subcontracted steps and the origin claim are still open (B-W2b-208).'),
          ...stamp(T.register),
        },
        {
          id: r.importerUk,
          code: 'IMPORTER-UK',
          name: 'An importer established in the United Kingdom is named',
          kind: ComplianceRequirementKind.OPERATOR_ROLE,
          operatorRole: EconomicOperatorKind.IMPORTER,
          marketCode: 'UK',
          blocks: [ComplianceGate.SHIPMENT],
          legalReference: 'PPE Regulation 2016/425 as it applies in Great Britain',
          seq: 80,
          ...off(offQ23),
          ...stamp(T.register),
        },
        {
          id: r.gpsrContact,
          code: 'GPSR-CONTACT',
          name: 'The GPSR contact is on the product or its papers',
          kind: ComplianceRequirementKind.DECLARATION,
          checkKey: 'gpsr.contact',
          legalReference: 'Reg. (EU) 2023/988',
          seq: 90,
          ...off('Owner question Q37: the notified body is asked whether the GPSR duties apply to the safety garments.'),
          ...stamp(T.register),
        },
        {
          id: r.gloveLevels,
          code: 'GLOVE-LEVELS',
          name: 'The glove certificate gives its EN 13594 levels',
          kind: ComplianceRequirementKind.CERTIFICATE,
          checkKey: 'certificate.gloveLevels',
          productTypes: [ProductType.GLOVES],
          legalReference: 'EN 13594:2015',
          regulationId: reg.en13594,
          seq: 100,
          ...off('Owner question Q10: do you make gloves?'),
          ...stamp(T.register),
        },
      ]
      await tx.complianceRequirement.createMany({ data: requirements })

      // --- Gate events --------------------------------------------------------------------------------------------------
      const g = result.gateEventIds
      await tx.gateEvent.create({
        data: {
          id: g.labelRefused,
          companyId: company.A,
          siteId: site.A1,
          gate: ComplianceGate.LABEL_PRINT,
          subjectType: 'WorkOrder',
          subjectId: production.workOrderId,
          outcome: GateOutcome.REFUSED,
          requirementId: r.labelLanguage,
          styleId: production.styleId,
          marketCode: 'DE',
          reason: 'The label for Germany cannot print: the warning "warning.class-a" has no approved German words. Who can fix it: compliance. How: approve the German translation in Rules & markets › Phrases.',
          explanation: { code: 'phrase.notApproved', phrase: 'warning.class-a', language: 'de', colourway: 'BLK', size: '52' },
          createdAt: T.refusedLabel,
          createdById: production.operatorId,
        },
      })
      await tx.gateEvent.create({
        data: {
          id: g.releaseRefused,
          companyId: company.A,
          siteId: site.A1,
          gate: ComplianceGate.WORK_ORDER_RELEASE,
          subjectType: 'WorkOrder',
          subjectId: production.draftWorkOrderId,
          outcome: GateOutcome.REFUSED,
          requirementId: r.userInfoLanguage,
          styleId: production.styleId,
          marketCode: 'DE',
          reason: 'The work order cannot be released: the user information has no German issue. Who can fix it: compliance. How: issue the German leaflet, or override for this work order.',
          explanation: { code: 'userInfo.missing', language: 'de' },
          createdAt: T.refusedRelease,
          createdById: actorId,
        },
      })
      await tx.gateEvent.create({
        data: {
          id: g.releaseOverridden,
          companyId: company.A,
          siteId: site.A1,
          gate: ComplianceGate.WORK_ORDER_RELEASE,
          subjectType: 'WorkOrder',
          subjectId: production.draftWorkOrderId,
          outcome: GateOutcome.OVERRIDDEN,
          requirementId: r.userInfoLanguage,
          styleId: production.styleId,
          marketCode: 'DE',
          reason: 'Seed: the German leaflet is with the translator; cutting may start, nothing ships before it is issued.',
          refusedEventId: g.releaseRefused,
          stepUpAt: T.stepUp,
          overrideUntil: T.overrideUntil,
          createdAt: T.override,
          createdById: actorId,
        },
      })
      await tx.gateEvent.create({
        data: {
          id: g.shipmentRefused,
          companyId: company.B,
          siteId: site.B1,
          gate: ComplianceGate.SHIPMENT,
          subjectType: 'Shipment',
          subjectId: id('compliance-rules:subject:B1:shipment'),
          outcome: GateOutcome.REFUSED,
          requirementId: r.docLanguage,
          styleId: jacketStyleId,
          marketCode: 'FR',
          reason: 'The shipment to France cannot leave: the Declaration of Conformity has no French issue. Who can fix it: compliance. How: issue the French DoC.',
          explanation: { code: 'doc.missing', language: 'fr' },
          createdAt: T.refusedShipment,
          createdById: actorId,
        },
      })

      // --- Economic operators -------------------------------------------------------------------------------------------
      const o = result.operatorIds
      await tx.economicOperatorRole.createMany({
        data: [
          { id: o.companyA, companyId: company.A, role: EconomicOperatorKind.MANUFACTURER, printedName: 'Seed Company A S.r.l.', printedAddress: 'Via Seed 1, 00000 Seedtown (XX), Italy', contact: 'compliance.a@example.com', validFrom: day('2026-01-01'), ...stamp(T.register) },
          { id: o.companyB, companyId: company.B, role: EconomicOperatorKind.MANUFACTURER, printedName: 'Seed Company B S.r.l.', printedAddress: 'Via Seed 2, 00000 Seedtown (XX), Italy', validFrom: day('2026-01-01'), ...stamp(T.register) },
          { id: o.brand, brandPartyId: party.P1, partyId: party.P1, role: EconomicOperatorKind.MANUFACTURER, printedName: 'Seed Customer One S.r.l.', printedAddress: 'Via Esempio 10, 00000 Seedville (MI), Italy', contact: 'compliance.p1@example.com', validFrom: day('2026-01-01'), note: 'Owner 11-09, question 3: a private-label style sold under the brand\'s name has the brand as its manufacturer.', ...stamp(T.register) },
          { id: o.styleCh, styleId: jacketStyleId, marketCode: 'CH', role: EconomicOperatorKind.DISTRIBUTOR, partyId: party.P3, printedName: 'Seed Customer Three', printedAddress: 'Seedstrasse 3, 0000 Seedberg, Switzerland', validFrom: day('2026-06-01'), validTo: day('2027-05-31'), ...stamp(T.register) },
        ],
      })

      // --- The phrase library ---------------------------------------------------------------------------------------------
      const p = result.phraseIds
      await tx.phrase.createMany({
        data: [
          { id: p.warning, key: 'warning.class-a', kind: PhraseKind.WARNING, sourceText: 'Indumento di classe A: leggere le istruzioni prima dell\'uso.', ...stamp(T.register) },
          { id: p.care, key: 'care.wash-not', kind: PhraseKind.CARE, sourceText: 'Non lavare in acqua', ...stamp(T.register) },
          { id: p.animalOrigin, key: 'marking.animal-origin', kind: PhraseKind.MARKING, sourceText: 'Contiene parti non tessili di origine animale', ...stamp(T.register) },
          { id: p.doc, key: 'doc.sole-responsibility', kind: PhraseKind.DOC, sourceText: 'La presente dichiarazione di conformità è rilasciata sotto la responsabilità esclusiva del fabbricante.', ...stamp(T.register) },
          { id: p.storage, key: 'userinfo.storage', kind: PhraseKind.USER_INFO, sourceText: 'Conservare in luogo asciutto, lontano dalla luce diretta del sole.', ...stamp(T.register) },
          { id: p.claim, key: 'claim.made-in-italy', kind: PhraseKind.CLAIM, sourceText: 'Made in Italy', ...stamp(T.register) },
        ],
      })
      // Every translation is proposed as a DRAFT by the translator; a second person (the seed's actor) approves.
      const t = result.translationIds
      const draft = (rowId: string, phraseId: string, language: string, revision: number, sourceRevision: number, text: string): Prisma.PhraseTranslationCreateManyInput => ({
        id: rowId,
        phraseId,
        language,
        revision,
        sourceRevision,
        text,
        translatedById: translatorId,
        ...stamp(T.register),
      })
      await tx.phraseTranslation.createMany({
        data: [
          draft(t.warningDe, p.warning, 'de', 1, 1, 'Kleidungsstück der Klasse A: vor Gebrauch die Anleitung lesen.'),
          draft(t.warningEn, p.warning, 'en', 1, 1, 'Class A garment: read the instructions before use.'),
          draft(t.careEn1, p.care, 'en', 1, 1, 'No washing'),
          draft(t.animalEn, p.animalOrigin, 'en', 1, 1, 'Contains non-textile parts of animal origin'),
          draft(t.animalDe, p.animalOrigin, 'de', 1, 1, 'Enthält nichttextile Teile tierischen Ursprungs'),
          draft(t.animalFr, p.animalOrigin, 'fr', 1, 1, "Contient des parties non textiles d'origine animale"),
          draft(t.storageEn, p.storage, 'en', 1, 1, 'Store in a dry place, away from direct sunlight.'),
        ],
      })
      const approve = { status: PhraseTranslationStatus.APPROVED, approvedAt: T.approved, approvedById: actorId, updatedAt: T.approved }
      await tx.phraseTranslation.updateMany({ where: { id: { in: [t.warningEn, t.careEn1, t.animalEn, t.animalDe, t.animalFr] } }, data: approve })
      // The care words' source is corrected (revision 2): the English one is translated again, approved, and supersedes revision 1.
      await tx.phrase.update({ where: { id: p.care }, data: { sourceText: 'Non lavare', revision: 2, note: 'Seed: the source words were corrected once.', updatedAt: T.approved }, select: { id: true } })
      await tx.phraseTranslation.update({ where: { id: t.careEn1 }, data: { status: PhraseTranslationStatus.SUPERSEDED, updatedAt: T.approved }, select: { id: true } })
      await tx.phraseTranslation.create({ data: draft(t.careEn2, p.care, 'en', 2, 2, 'Do not wash'), select: { id: true } })
      await tx.phraseTranslation.update({ where: { id: t.careEn2 }, data: approve, select: { id: true } })

      // --- Notified bodies and the certificates that name them -------------------------------------------------------------
      const b = result.bodyIds
      await tx.notifiedBody.createMany({
        data: [
          { id: b.archived, number: '0000', name: 'Seed Notified Body (earlier entry)', address: 'Via Seed 9, 00000 Seedtown, Italy', country: 'IT', status: MasterStatus.ARCHIVED, note: 'Seed: typed twice; the active entry replaces it.', ...stamp(T.register) },
          {
            id: b.active,
            number: '0000',
            name: 'Seed Notified Body',
            address: 'Via Seed 9, 00000 Seedtown, Italy',
            country: 'IT',
            nandoUrl: 'https://example.org/nando/0000',
            scopes: ['Regulation (EU) 2016/425 - protective clothing (seed)', 'Regulation (EU) 2016/425 - protective gloves (seed)'],
            contactEmail: 'certification@example.org',
            contactPhone: '+39 000 0000009',
            ...stamp(T.register),
          },
          { id: b.second, number: '9999', name: 'Seed Test Laboratory', address: 'Seedweg 1, 00000 Seedheim, Germany', country: 'DE', nandoUrl: 'https://example.org/nando/9999', scopes: ['Regulation (EU) 2016/425 - protective gloves (seed)'], ...stamp(T.register) },
        ],
      })
      const c = result.certificateIds
      const valid = { status: CertificateStatus.VALID, statusChangedAt: T.register, validFrom: day('2026-02-01'), validTo: day('2031-01-31') }
      const body0000 = { notifiedBodyName: 'Seed Notified Body', notifiedBodyNumber: '0000', notifiedBodyId: b.active }
      await tx.certificate.create({
        data: { id: c.base, companyId: company.A, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: 'SEED-CERT-2161', ...body0000, modelReference: 'SEED-JKT-01', ...valid, note: 'Seed: the factory\'s own certificate a brand\'s own-brand certificate rests on.', ...stamp(T.register) },
        select: { id: true },
      })
      await tx.certificate.create({
        data: { id: c.ownBrand, holderPartyId: party.P1, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: 'SEED-CERT-2162', ...body0000, modelReference: 'SEED-JKT-01 (P1 label)', baseCertificateId: c.base, ...valid, ...stamp(T.register) },
        select: { id: true },
      })
      await tx.certificate.create({
        data: {
          id: c.glove,
          companyId: company.A,
          standard: 'EN 13594:2015',
          ppeClass: '2',
          number: 'SEED-CERT-2163',
          notifiedBodyName: 'Seed Test Laboratory',
          notifiedBodyNumber: '9999',
          notifiedBodyId: b.second,
          modelReference: 'SEED-GLV-01',
          performanceLevels: { level: '2', knuckle: 'KP' },
          validFrom: day('2026-03-01'),
          validTo: day('2031-02-28'),
          ...stamp(T.register),
        },
        select: { id: true },
      })
    }),
  )
  return result
}
