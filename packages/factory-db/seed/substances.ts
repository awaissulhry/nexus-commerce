import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  FileCategory,
  ItemKind,
  LabTest,
  MaterialComplianceState,
  PartnerTaskKind,
  RestrictedSubstanceList,
  SubstanceEvidence,
  SubstanceLimitBound,
  SubstanceRuleCode,
  SubstanceRuleSource,
  SubstanceUnit,
  SupplierDeclarationChannel,
  SupplierDeclarationKind,
  SupplierDeclarationStatus,
  TestFrequency,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPortalFollowups } from './portal-followups'
import { seed as seedProduct } from './product'
import { seed as seedStylesDepth } from './styles-depth'

/**
 * The materials and restricted substances seed (W2b-4, schema wave 31/33, B-W2b-217), per tenant of seed/_core.ts, written
 * in the tenant's office scope as the app does. The CLI runs the seed files in name order; this one runs the product seed
 * (the leather, lining and protector), the styles seed (the nickel-plated zip) and the portal follow-ups seed (P2's REACH
 * declaration uploaded in its portal) first, all idempotent.
 *
 * A STARTER SAMPLE, not the legal list: a few real substances with their public CAS and EC numbers and the REACH Annex XVII
 * entries the plan names, so the check digits and the rules have something true to hold; the Candidate List versions, their
 * entry counts and which version added which SVHC are made up, as are every company, brand, supplier, date and answer.
 * B-W2b-250 loads the starter list and imports the AFIRM RSL.
 *
 *   versions     two Candidate List versions (made-up days and entry counts; the second is longer).
 *   substances   nonylphenol ethoxylates (a family, no CAS: the first row), chromium VI, 4-aminobiphenyl and benzidine
 *                (the azo amines group), benzo[a]pyrene (the PAH group, also an SVHC), dimethylfumarate, nickel, DEHP
 *                (SVHC), PFOA (POPs, SVHC), DMF (SVHC added in the second version; on the brand P1's RSL).
 *   rules        chromium VI in leather (entry 47, the first row), azo (43), nickel release (27), PAHs (50), DMFu (61),
 *                NPE (46a): on; CMR in clothing (72, with the PPE and natural-leather exemptions) and PFAS (79): OFF, each
 *                with the Owner question it waits for (answer 11-09, question 5 A); P1's own DMF limit (a CUSTOMER rule).
 *   test plans   Cr VI on every leather lot (the first row: W1's rule as data), azo on a leather's new colour, nickel on a
 *                trim's first lot, PAHs yearly on the protector, PFAS yearly on membranes for France (OFF).
 *   profiles     the leather (INCOMPLETE: its SVHC answer is of the older list), the lining (INCOMPLETE: no SVHC answer),
 *                the protector (COMPLETE, with DEHP above 0.1 %: the REACH art. 33 duty), the zip (BLOCKED: nickel).
 *   requests     to P2: SEED-SD-0002 (SVHC, first list, by e-mail, ACCEPTED: the leather none, the protector DEHP 0.15 %),
 *                SEED-SD-0001 (SVHC, the longer list, asked again, SENT: the first row, with its two open lines),
 *                SEED-SD-0003 (nickel, in the portal with its task, a reminder, OVERDUE), SEED-SD-0004 (Cr VI statement,
 *                in the portal, ANSWERED with P2's REACH declaration upload); to P1, the brand that sends its own lining:
 *                SEED-SD-0005 (PFAS, by e-mail, REFUSED with the reason).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first substance is the family with no CAS number (one ACTIVE row per CAS), the first request a SENT one asked
 * by e-mail with no task, the first line an open line of it, the first list version, rule and test plan plain ones; a
 * profile's id is its item's id (one per material). The partner (P1) reads SEED-SD-0005 and its line, never P2's.
 *
 * Idempotent: each part is written once and skipped when its first row exists.
 */

/** Fixed instants and days, so the seed never depends on the clock (an OVERDUE request needs today after its due day). */
const T = {
  listed: new Date('2026-10-01T08:00:00.000Z'),
  evaluated: new Date('2026-11-03T09:00:00.000Z'),
  confirmed: new Date('2026-11-03T10:00:00.000Z'),
  askedSvhc: new Date('2026-10-05T08:00:00.000Z'),
  answeredSvhc: new Date('2026-10-12T15:00:00.000Z'),
  acceptedSvhc: new Date('2026-10-13T09:30:00.000Z'),
  askedAgain: new Date('2026-11-04T08:00:00.000Z'),
  askedNickel: new Date('2026-10-22T08:00:00.000Z'),
  remindedNickel: new Date('2026-10-29T08:00:00.000Z'),
  askedCr6: new Date('2026-11-02T08:00:00.000Z'),
  answeredCr6: new Date('2026-11-06T10:05:00.000Z'),
  askedPfas: new Date('2026-10-20T08:00:00.000Z'),
  answeredPfas: new Date('2026-10-27T11:00:00.000Z'),
  refusedPfas: new Date('2026-10-28T09:00:00.000Z'),
} as const
const DAY = {
  v1: new Date('2026-01-15T00:00:00.000Z'),
  v2: new Date('2026-07-01T00:00:00.000Z'),
  dueSvhc: new Date('2026-10-19T00:00:00.000Z'),
  validSvhc: new Date('2027-10-12T00:00:00.000Z'),
  dueAgain: new Date('2026-12-04T00:00:00.000Z'),
  dueNickel: new Date('2026-11-05T00:00:00.000Z'),
  dueCr6: new Date('2026-11-16T00:00:00.000Z'),
  duePfas: new Date('2026-11-03T00:00:00.000Z'),
} as const

export interface SubstancesSeed {
  readonly listVersionIds: { readonly v1: string; readonly v2: string }
  readonly substanceIds: {
    readonly npe: string
    readonly cr6: string
    readonly aminobiphenyl: string
    readonly benzidine: string
    readonly bap: string
    readonly dmfu: string
    readonly nickel: string
    readonly dehp: string
    readonly pfoa: string
    readonly dmf: string
  }
  readonly ruleIds: {
    readonly cr6: string
    readonly azo: string
    readonly nickel: string
    readonly pah: string
    readonly dmfu: string
    readonly npe: string
    readonly cmr: string
    readonly pfas: string
    readonly brandDmf: string
  }
  readonly testPlanIds: { readonly cr6: string; readonly azo: string; readonly nickel: string; readonly pah: string; readonly pfas: string }
  readonly itemIds: { readonly leather: string; readonly lining: string; readonly protector: string; readonly zip: string }
  readonly requestIds: { readonly again: string; readonly accepted: string; readonly overdue: string; readonly answered: string; readonly refused: string }
  readonly lineIds: { readonly againLeather: string; readonly againProtector: string }
  readonly taskId: string
  readonly uploadId: string
  readonly answerFileIds: { readonly accepted: string; readonly refused: string }
}

export async function seed(context: SeedContext): Promise<SubstancesSeed> {
  const { db, namespace } = context
  const product = await seedProduct(context)
  const styles = await seedStylesDepth(context)
  const portal = await seedPortalFollowups(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const memberId = id('user:member')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const P2 = id('party:P2')
  const store = id('files:account:r2')
  const office = { audience: 'office', tenantId, actorId } as const
  const select = { id: true } as const
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })

  const lining = id('product:item:lining')
  const result: SubstancesSeed = {
    listVersionIds: { v1: firstId('substances:svhc:v1'), v2: id('substances:svhc:v2') },
    substanceIds: {
      npe: firstId('substances:substance:NPE'),
      cr6: id('substances:substance:CR6'),
      aminobiphenyl: id('substances:substance:4-ABP'),
      benzidine: id('substances:substance:BENZIDINE'),
      bap: id('substances:substance:BAP'),
      dmfu: id('substances:substance:DMFU'),
      nickel: id('substances:substance:NI'),
      dehp: id('substances:substance:DEHP'),
      pfoa: id('substances:substance:PFOA'),
      dmf: id('substances:substance:DMF'),
    },
    ruleIds: {
      cr6: firstId('substances:rule:CR6'),
      azo: id('substances:rule:AZO'),
      nickel: id('substances:rule:NICKEL'),
      pah: id('substances:rule:PAH'),
      dmfu: id('substances:rule:DMFU'),
      npe: id('substances:rule:NPE'),
      cmr: id('substances:rule:CMR'),
      pfas: id('substances:rule:PFAS'),
      brandDmf: id('substances:rule:P1:DMF'),
    },
    testPlanIds: {
      cr6: firstId('substances:test-plan:CR6'),
      azo: id('substances:test-plan:AZO'),
      nickel: id('substances:test-plan:NICKEL'),
      pah: id('substances:test-plan:PAH'),
      pfas: id('substances:test-plan:PFAS'),
    },
    itemIds: { leather: product.leatherId, lining, protector: product.protectorId, zip: styles.blockedItemId },
    requestIds: {
      again: firstId('substances:request:SD-0001'),
      accepted: id('substances:request:SD-0002'),
      overdue: id('substances:request:SD-0003'),
      answered: id('substances:request:SD-0004'),
      refused: id('substances:request:SD-0005'),
    },
    lineIds: { againLeather: firstId('substances:line:SD-0001:1'), againProtector: id('substances:line:SD-0001:2') },
    taskId: id('substances:task:SD-0003'),
    uploadId: portal.uploads.waiting,
    answerFileIds: { accepted: id('substances:file:SD-0002'), refused: id('substances:file:SD-0005') },
  }
  const { listVersionIds: V, substanceIds: S, ruleIds: R, testPlanIds: TP, itemIds: I, requestIds: RQ } = result

  // --- The list: versions, substances, rules, test plans, profiles ---------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.svhcListVersion.findUnique({ where: { id: V.v1 }, select })))) {
    const SOURCE = 'https://echa.europa.eu/candidate-list-table'
    const versions: Prisma.SvhcListVersionCreateManyInput[] = [
      { id: V.v1, publishedOn: DAY.v1, entryCount: 250, source: 'Seed Candidate List, January update (made-up count)', sourceUrl: SOURCE, ...stamp(T.listed) },
      { id: V.v2, publishedOn: DAY.v2, entryCount: 253, source: 'Seed Candidate List, July update (made-up count)', sourceUrl: SOURCE, note: 'Three entries more than January: SVHC declarations of the January list are asked again.', ...stamp(T.listed) },
    ]
    const XVII = RestrictedSubstanceList.REACH_ANNEX_XVII
    const SVHC = RestrictedSubstanceList.SVHC
    const substance = (rowId: string, name: string, data: Partial<Prisma.RestrictedSubstanceCreateManyInput>): Prisma.RestrictedSubstanceCreateManyInput => ({
      id: rowId,
      name,
      lists: [XVII],
      ...data,
      ...stamp(T.listed),
    })
    const substances: Prisma.RestrictedSubstanceCreateManyInput[] = [
      substance(S.npe, 'Nonylphenol ethoxylates', { groupCode: 'NPE', annexXviiEntries: ['46a'], nameI18n: { it: 'Nonilfenoli etossilati', en: 'Nonylphenol ethoxylates' }, note: 'A family of substances: no single CAS number.' }),
      substance(S.cr6, 'Chromium VI', { casNumber: '18540-29-9', groupCode: 'CR6', annexXviiEntries: ['47'] }),
      substance(S.aminobiphenyl, '4-Aminobiphenyl', { casNumber: '92-67-1', ecNumber: '202-177-1', groupCode: 'AZO_AMINES', annexXviiEntries: ['43'] }),
      substance(S.benzidine, 'Benzidine', { casNumber: '92-87-5', ecNumber: '202-199-1', groupCode: 'AZO_AMINES', annexXviiEntries: ['43'] }),
      substance(S.bap, 'Benzo[a]pyrene', { casNumber: '50-32-8', ecNumber: '200-028-5', groupCode: 'PAH_8', lists: [XVII, SVHC], annexXviiEntries: ['50'], svhcListVersionId: V.v1 }),
      substance(S.dmfu, 'Dimethylfumarate', { casNumber: '624-49-7', ecNumber: '210-849-0', annexXviiEntries: ['61'] }),
      substance(S.nickel, 'Nickel', { casNumber: '7440-02-0', ecNumber: '231-111-4', annexXviiEntries: ['27'] }),
      substance(S.dehp, 'Bis(2-ethylhexyl) phthalate (DEHP)', { casNumber: '117-81-7', ecNumber: '204-211-0', lists: [XVII, SVHC], annexXviiEntries: ['51'], svhcListVersionId: V.v1 }),
      substance(S.pfoa, 'Perfluorooctanoic acid (PFOA)', { casNumber: '335-67-1', ecNumber: '206-397-9', lists: [RestrictedSubstanceList.POPS, SVHC], svhcListVersionId: V.v1 }),
      substance(S.dmf, 'N,N-dimethylformamide (DMF)', { casNumber: '68-12-2', ecNumber: '200-679-5', lists: [SVHC, RestrictedSubstanceList.CUSTOMER_RSL], svhcListVersionId: V.v2, note: 'Added in the made-up July version; on the brand P1\'s RSL.' }),
    ]
    const law = (entry: string) => ({ legalReference: `REACH Annex XVII entry ${entry}`, legalUrl: 'https://eur-lex.europa.eu/eli/reg/2006/1907/oj' })
    const rule = (rowId: string, key: string, code: SubstanceRuleCode, name: string, data: Partial<Prisma.SubstanceRuleCreateManyInput> & { legalReference: string }): Prisma.SubstanceRuleCreateManyInput => ({
      id: rowId,
      key,
      code,
      name,
      evidence: SubstanceEvidence.EITHER,
      ...data,
      ...stamp(T.listed),
    })
    const rules: Prisma.SubstanceRuleCreateManyInput[] = [
      rule(R.cr6, 'REACH-XVII-47', SubstanceRuleCode.CR6, 'Chromium VI in leather in contact with the skin', {
        substanceId: S.cr6,
        materialKinds: [ItemKind.LEATHER],
        scopeNote: 'Leather articles and leather parts of articles coming into contact with the skin.',
        limitValue: '3',
        limitUnit: SubstanceUnit.MG_KG,
        limitBound: SubstanceLimitBound.BELOW,
        testMethod: 'EN ISO 17075-1 or EN ISO 17075-2',
        evidence: SubstanceEvidence.TEST,
        ...law('47'),
      }),
      rule(R.azo, 'REACH-XVII-43', SubstanceRuleCode.AZO, 'Azo colourants releasing the listed aromatic amines', {
        substanceGroup: 'AZO_AMINES',
        materialKinds: [ItemKind.LEATHER, ItemKind.TEXTILE, ItemKind.LINING],
        scopeNote: 'Textile and leather articles which may come into direct and prolonged contact with the skin.',
        limitValue: '30',
        limitUnit: SubstanceUnit.MG_KG,
        limitBound: SubstanceLimitBound.AT_MOST,
        testMethod: 'EN ISO 17234-1 (leather), EN ISO 14362-1 (textiles)',
        ...law('43'),
      }),
      rule(R.nickel, 'REACH-XVII-27', SubstanceRuleCode.NICKEL, 'Nickel release from metal parts in prolonged skin contact', {
        substanceId: S.nickel,
        materialKinds: [ItemKind.TRIM, ItemKind.HARDWARE],
        scopeNote: 'Rivets, buttons, zips and other metal parts of garments in direct and prolonged contact with the skin; per trim model.',
        limitValue: '0.5',
        limitUnit: SubstanceUnit.UG_CM2_WEEK,
        limitBound: SubstanceLimitBound.AT_MOST,
        testMethod: 'EN 1811',
        ...law('27'),
      }),
      rule(R.pah, 'REACH-XVII-50', SubstanceRuleCode.PAH, 'The eight PAHs in rubber and plastic parts', {
        substanceGroup: 'PAH_8',
        materialKinds: [ItemKind.PROTECTOR, ItemKind.TRIM],
        scopeNote: 'Rubber or plastic parts in direct and prolonged or short-term repetitive contact with the skin (grips, protector shells, patches).',
        limitValue: '1',
        limitUnit: SubstanceUnit.MG_KG,
        limitBound: SubstanceLimitBound.AT_MOST,
        testMethod: 'AfPS GS 2019:01 PAK',
        ...law('50'),
      }),
      rule(R.dmfu, 'REACH-XVII-61', SubstanceRuleCode.DMFU, 'Dimethylfumarate in articles', {
        substanceId: S.dmfu,
        limitValue: '0.1',
        limitUnit: SubstanceUnit.MG_KG,
        limitBound: SubstanceLimitBound.AT_MOST,
        testMethod: 'CEN ISO/TS 16186',
        scopeNote: 'Any article or part of it; check leather and shipping packs (anti-mould sachets).',
        ...law('61'),
      }),
      rule(R.npe, 'REACH-XVII-46a', SubstanceRuleCode.NPE, 'Nonylphenol ethoxylates in textiles washed in water', {
        substanceId: S.npe,
        materialKinds: [ItemKind.TEXTILE, ItemKind.LINING],
        scopeNote: 'Textile articles which can reasonably be expected to be washed in water during their normal lifecycle.',
        limitValue: '0.01',
        limitUnit: SubstanceUnit.PERCENT_WW,
        limitBound: SubstanceLimitBound.BELOW,
        testMethod: 'EN ISO 18254-1',
        ...law('46a'),
      }),
      rule(R.cmr, 'REACH-XVII-72', SubstanceRuleCode.CMR, 'CMR substances in clothing and textile articles', {
        substanceGroup: 'CMR_APPENDIX_12',
        materialKinds: [ItemKind.TEXTILE, ItemKind.LINING, ItemKind.LEATHER],
        scopeNote: 'Clothing and textile parts in contact with the skin, at the limits of Appendix 12.',
        evidence: SubstanceEvidence.DECLARATION,
        exemptPpe: true,
        exemptNaturalLeather: true,
        switchedOn: false,
        offReason: 'Applies to clothing that is not PPE: waits for the Owner\'s answer on fashion lines (question Q23).',
        ...law('72'),
      }),
      rule(R.pfas, 'REACH-XVII-79', SubstanceRuleCode.PFAS, 'PFAS screening of water-repellent finishes, membranes and coatings', {
        substanceGroup: 'PFHXA',
        materialKinds: [ItemKind.MEMBRANE, ItemKind.TEXTILE],
        evidence: SubstanceEvidence.DECLARATION,
        switchedOn: false,
        offReason: 'Built switched off until a style or a market needs it (Owner answer 11-09, question 5 A); the entry and the dates are to be verified.',
        legalReference: 'REACH Annex XVII entry 79 (PFHxA), to be verified',
      }),
      rule(R.brandDmf, 'SEED-P1-RSL-DMF', SubstanceRuleCode.OTHER, 'DMF in coated materials, the brand\'s own limit', {
        substanceId: S.dmf,
        limitValue: '10',
        limitUnit: SubstanceUnit.MG_KG,
        limitBound: SubstanceLimitBound.AT_MOST,
        source: SubstanceRuleSource.CUSTOMER,
        customerPartyId: P1,
        legalReference: 'Seed brand RSL 2026, line 14 (made-up)',
      }),
    ]
    const testPlans: Prisma.TestPlanRuleCreateManyInput[] = [
      { id: TP.cr6, itemKind: ItemKind.LEATHER, test: LabTest.CR_VI, frequency: TestFrequency.EVERY_LOT, substanceRuleId: R.cr6, method: 'EN ISO 17075-1', note: 'W1\'s rule as data: every leather lot is held until its chromium VI evidence passes.', ...stamp(T.listed) },
      { id: TP.azo, itemKind: ItemKind.LEATHER, test: LabTest.AZO, frequency: TestFrequency.ON_CHANGE, substanceRuleId: R.azo, method: 'EN ISO 17234-1', note: 'A new colour or a new tannery (made-up plan).', ...stamp(T.listed) },
      { id: TP.nickel, itemKind: ItemKind.TRIM, test: LabTest.NICKEL, frequency: TestFrequency.FIRST_LOT, substanceRuleId: R.nickel, method: 'EN 1811', ...stamp(T.listed) },
      { id: TP.pah, itemId: I.protector, test: LabTest.PAH, frequency: TestFrequency.YEARLY, substanceRuleId: R.pah, method: 'AfPS GS 2019:01 PAK', ...stamp(T.listed) },
      {
        id: TP.pfas,
        itemKind: ItemKind.MEMBRANE,
        test: LabTest.PFAS,
        frequency: TestFrequency.YEARLY,
        marketCode: 'FR',
        substanceRuleId: R.pfas,
        switchedOn: false,
        offReason: 'France\'s PFAS ban for textiles: off until a style is sold there (Owner answer 11-09, question 5 A).',
        ...stamp(T.listed),
      },
    ]
    const evaluated = { evaluatedAt: T.evaluated }
    const confirmed = { compositionConfirmedAt: T.confirmed, compositionConfirmedById: memberId }
    const profiles: Prisma.MaterialComplianceProfileCreateManyInput[] = [
      {
        id: I.leather,
        itemId: I.leather,
        ...confirmed,
        tannageConfirmedAt: T.confirmed,
        tannageConfirmedById: memberId,
        originCountry: 'IT',
        svhcAboveThreshold: false,
        svhcListVersionId: V.v1,
        applicableRuleIds: [R.cr6, R.azo, R.dmfu],
        testsNeeded: [LabTest.CR_VI, LabTest.AZO],
        declarationsNeeded: [SupplierDeclarationKind.REACH_SVHC, SupplierDeclarationKind.CR6],
        ...evaluated,
        stateReason: 'Its SVHC answer is of the January list; SEED-SD-0001 asks again for the July one.',
        ...stamp(T.evaluated),
      },
      {
        id: I.lining,
        itemId: I.lining,
        ...confirmed,
        originCountry: 'IT',
        applicableRuleIds: [R.azo, R.npe],
        testsNeeded: [LabTest.AZO, LabTest.NPE],
        declarationsNeeded: [SupplierDeclarationKind.REACH_SVHC, SupplierDeclarationKind.PFAS],
        ...evaluated,
        stateReason: 'No SVHC answer yet; the brand\'s PFAS declaration was refused.',
        ...stamp(T.evaluated),
      },
      {
        id: I.protector,
        itemId: I.protector,
        originCountry: 'DE',
        svhcAboveThreshold: true,
        svhcListVersionId: V.v1,
        svhcSubstanceIds: [S.dehp],
        applicableRuleIds: [R.pah],
        testsNeeded: [LabTest.PAH],
        declarationsNeeded: [SupplierDeclarationKind.REACH_SVHC],
        ...evaluated,
        state: MaterialComplianceState.COMPLETE,
        note: 'DEHP above 0.1 % w/w in the shell (made-up): REACH art. 33 information goes with each delivery.',
        ...stamp(T.evaluated),
      },
      {
        id: I.zip,
        itemId: I.zip,
        applicableRuleIds: [R.nickel],
        testsNeeded: [LabTest.NICKEL],
        declarationsNeeded: [SupplierDeclarationKind.NICKEL],
        ...evaluated,
        state: MaterialComplianceState.BLOCKED,
        stateReason: 'Nickel release above 0.5 µg/cm²/week in the supplier\'s test (made-up).',
        ...stamp(T.evaluated),
      },
    ]
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.svhcListVersion.createMany({ data: versions })
        await tx.restrictedSubstance.createMany({ data: substances })
        await tx.substanceRule.createMany({ data: rules })
        await tx.testPlanRule.createMany({ data: testPlans })
        await tx.materialComplianceProfile.createMany({ data: profiles })
      }),
    )
  }

  // --- The declarations asked of suppliers ------------------------------------------------------------------------------
  if (!(await db.withScope(office, (client) => client.supplierDeclarationRequest.findUnique({ where: { id: RQ.accepted }, select })))) {
    /** A file of a request: the answer that came by e-mail, kept by the office (rows only: no object in any store). */
    const answerFile = (fileId: string, requestId: string, name: string, at: Date): Prisma.StoredFileCreateManyInput => ({
      id: fileId,
      companyId: companyA,
      recordType: 'SupplierDeclarationRequest',
      recordId: requestId,
      kind: 'CERTIFICATE',
      category: FileCategory.DECLARATION,
      visibility: ['OFFICE'],
      originalName: name,
      contentType: 'application/pdf',
      sizeBytes: 4096,
      sha256: createHash('sha256').update(`seed file ${namespace} substances ${fileId}`).digest('hex'),
      storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`substances:key:${fileId}`)}`,
      status: 'AVAILABLE',
      availableAt: at,
      storeAccountId: store,
      createdAt: at,
      updatedAt: at,
      createdById: actorId,
    })
    const request = (rowId: string, number: string, partyId: string, kind: SupplierDeclarationKind, channel: SupplierDeclarationChannel, sentAt: Date, dueOn: Date, data: Partial<Prisma.SupplierDeclarationRequestCreateManyInput> = {}): Prisma.SupplierDeclarationRequestCreateManyInput => ({
      id: rowId,
      companyId: companyA,
      number,
      partyId,
      kind,
      channel,
      sentAt,
      dueOn,
      ...data,
      ...stamp(sentAt),
    })
    const line = (rowId: string, requestId: string, partyId: string, seq: number, itemId: string, articleLabel: string, at: Date): Prisma.SupplierDeclarationLineCreateManyInput => ({
      id: rowId,
      partyId,
      requestId,
      seq,
      itemId,
      articleLabel,
      ...stamp(at),
    })
    const decided = (at: Date) => ({ decidedAt: at, decidedById: memberId, decidedByName: 'Seed Compliance Lead', updatedAt: at })

    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await tx.storedFile.createMany({
          data: [
            answerFile(result.answerFileIds.accepted, RQ.accepted, 'Seed tannery SVHC declaration January list.pdf', T.answeredSvhc),
            answerFile(result.answerFileIds.refused, RQ.refused, 'Seed brand PFAS statement.pdf', T.answeredPfas),
          ],
          skipDuplicates: true,
        })

        // SEED-SD-0002: the SVHC declaration of the January list, by e-mail, answered and accepted (lines first).
        await tx.supplierDeclarationRequest.create({
          data: request(RQ.accepted, 'SEED-SD-0002', P2, SupplierDeclarationKind.REACH_SVHC, SupplierDeclarationChannel.OFFICE, T.askedSvhc, DAY.dueSvhc, {
            svhcListVersionId: V.v1,
            message: 'Please declare the SVHCs above 0.1 % w/w in the articles you supply us (made-up).',
          }),
          select,
        })
        await tx.supplierDeclarationLine.createMany({
          data: [
            line(id('substances:line:SD-0002:1'), RQ.accepted, P2, 1, I.leather, 'SEED-ART-100 · Seed cowhide 1.2 mm', T.askedSvhc),
            line(id('substances:line:SD-0002:2'), RQ.accepted, P2, 2, I.protector, 'SEED-ART-300 · Seed shoulder protector level 2', T.askedSvhc),
          ],
        })
        await tx.supplierDeclarationRequest.update({
          where: { id: RQ.accepted },
          data: { status: SupplierDeclarationStatus.ANSWERED, answeredAt: T.answeredSvhc, answerFileId: result.answerFileIds.accepted, answeredListVersionId: V.v1, validTo: DAY.validSvhc, version: 2, updatedAt: T.answeredSvhc },
          select,
        })
        await tx.supplierDeclarationLine.update({ where: { id: id('substances:line:SD-0002:1') }, data: { contains: false, version: 2, updatedAt: T.answeredSvhc }, select })
        await tx.supplierDeclarationLine.update({
          where: { id: id('substances:line:SD-0002:2') },
          data: { contains: true, aboveThreshold: true, substanceId: S.dehp, concentration: '0.15', concentrationUnit: SubstanceUnit.PERCENT_WW, note: 'In the moulded shell (made-up).', version: 2, updatedAt: T.answeredSvhc },
          select,
        })
        await tx.supplierDeclarationRequest.update({ where: { id: RQ.accepted }, data: { status: SupplierDeclarationStatus.ACCEPTED, ...decided(T.acceptedSvhc), version: 3 }, select })

        // SEED-SD-0001: asked again for the longer July list (the first row: SENT, by e-mail, no task), its lines open.
        await tx.supplierDeclarationRequest.create({
          data: request(RQ.again, 'SEED-SD-0001', P2, SupplierDeclarationKind.REACH_SVHC, SupplierDeclarationChannel.OFFICE, T.askedAgain, DAY.dueAgain, {
            svhcListVersionId: V.v2,
            supersedesId: RQ.accepted,
            reminderEveryDays: 7,
            message: 'The Candidate List grew: please declare again against the July list (made-up).',
          }),
          select,
        })
        await tx.supplierDeclarationLine.createMany({
          data: [
            line(result.lineIds.againLeather, RQ.again, P2, 1, I.leather, 'SEED-ART-100 · Seed cowhide 1.2 mm', T.askedAgain),
            line(result.lineIds.againProtector, RQ.again, P2, 2, I.protector, 'SEED-ART-300 · Seed shoulder protector level 2', T.askedAgain),
          ],
        })

        // SEED-SD-0003: nickel release of the zip, asked in the portal (its task), reminded once, overdue.
        await tx.supplierDeclarationRequest.create({
          data: request(RQ.overdue, 'SEED-SD-0003', P2, SupplierDeclarationKind.NICKEL, SupplierDeclarationChannel.PORTAL, T.askedNickel, DAY.dueNickel, { reminderEveryDays: 7 }),
          select,
        })
        await tx.supplierDeclarationLine.create({ data: line(id('substances:line:SD-0003:1'), RQ.overdue, P2, 1, I.zip, 'Seed nickel-plated zip #5', T.askedNickel), select })
        await tx.partnerTask.create({
          data: {
            id: result.taskId,
            companyId: companyA,
            partyId: P2,
            kind: PartnerTaskKind.UPLOAD_DOCUMENT,
            recordType: 'SupplierDeclarationRequest',
            recordId: RQ.overdue,
            recordLabel: 'SEED-SD-0003',
            sourceKey: `SupplierDeclarationRequest:${RQ.overdue}`,
            dueAt: new Date('2026-11-05T17:00:00.000Z'),
            askedById: memberId,
            askedByName: 'Seed Compliance Lead',
            createdAt: T.askedNickel,
            updatedAt: T.askedNickel,
          },
          select,
        })
        await tx.supplierDeclarationRequest.update({ where: { id: RQ.overdue }, data: { partnerTaskId: result.taskId, version: 2, updatedAt: T.askedNickel }, select })
        await tx.supplierDeclarationRequest.update({ where: { id: RQ.overdue }, data: { remindersSent: 1, lastRemindedAt: T.remindedNickel, version: 3, updatedAt: T.remindedNickel }, select })
        await tx.supplierDeclarationRequest.update({ where: { id: RQ.overdue }, data: { status: SupplierDeclarationStatus.OVERDUE, version: 4, updatedAt: new Date('2026-11-06T06:00:00.000Z') }, select })

        // SEED-SD-0004: the chromium VI statement of the leather, answered in the portal by P2's REACH declaration upload.
        await tx.supplierDeclarationRequest.create({
          data: request(RQ.answered, 'SEED-SD-0004', P2, SupplierDeclarationKind.CR6, SupplierDeclarationChannel.PORTAL, T.askedCr6, DAY.dueCr6),
          select,
        })
        await tx.supplierDeclarationLine.create({ data: line(id('substances:line:SD-0004:1'), RQ.answered, P2, 1, I.leather, 'SEED-ART-100 · Seed cowhide 1.2 mm', T.askedCr6), select })
        await tx.supplierDeclarationRequest.update({
          where: { id: RQ.answered },
          data: { status: SupplierDeclarationStatus.ANSWERED, answeredAt: T.answeredCr6, uploadId: result.uploadId, version: 2, updatedAt: T.answeredCr6 },
          select,
        })
        await tx.supplierDeclarationLine.update({ where: { id: id('substances:line:SD-0004:1') }, data: { contains: false, note: 'Lots 2231 and 2232: no chromium VI found (made-up).', version: 2, updatedAt: T.answeredCr6 }, select })

        // SEED-SD-0005: the brand P1's own lining, PFAS-free asked by e-mail, answered, refused with the reason.
        await tx.supplierDeclarationRequest.create({
          data: request(RQ.refused, 'SEED-SD-0005', P1, SupplierDeclarationKind.PFAS, SupplierDeclarationChannel.OFFICE, T.askedPfas, DAY.duePfas, {
            message: 'Please confirm the lining you send us has no intentionally added PFAS (made-up).',
            internalNote: 'Ask the brand\'s quality office, not its buyer.',
          }),
          select,
        })
        await tx.supplierDeclarationLine.create({ data: line(id('substances:line:SD-0005:1'), RQ.refused, P1, 1, lining, 'Seed brand mesh lining', T.askedPfas), select })
        await tx.supplierDeclarationRequest.update({
          where: { id: RQ.refused },
          data: { status: SupplierDeclarationStatus.ANSWERED, answeredAt: T.answeredPfas, answerFileId: result.answerFileIds.refused, version: 2, updatedAt: T.answeredPfas },
          select,
        })
        await tx.supplierDeclarationLine.update({ where: { id: id('substances:line:SD-0005:1') }, data: { contains: false, version: 2, updatedAt: T.answeredPfas }, select })
        await tx.supplierDeclarationRequest.update({
          where: { id: RQ.refused },
          data: { status: SupplierDeclarationStatus.REFUSED, ...decided(T.refusedPfas), refuseReason: 'The statement does not name the lining article or its supplier; send one that does.', version: 3 },
          select,
        })
      }),
    )
  }

  return result
}
