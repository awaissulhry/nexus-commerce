import type { Prisma } from '../src/generated/prisma/client'
import {
  CostCategory,
  CostLineSource,
  CostSheetFreezeReason,
  CostSheetState,
  ItemKind,
  MasterStatus,
  OverheadBasis,
  UpliftSource,
  UpliftTarget,
  Uom,
  WorkCentreKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedCosting } from './costing'
import { seed as seedLeather } from './leather'
import { seed as seedOptions } from './options'
import { seed as seedProduct } from './product'
import { seed as seedSalesIntake } from './sales-intake'

/**
 * The cost sheets seed (W2b schema wave 55/57, B-W2b-378), per tenant of seed/_core.ts, written as the API writes these
 * rows: in the tenant's office scope. The CLI runs the seed files in name order and this one sorts before costing, leather,
 * options, product and sales-intake, whose rows it names, so it runs those seeds itself (each writes its rows once). Every
 * figure is made up; nothing here changes what the live cost sheet computes today (B-W1-16 reads none of these tables).
 *
 *   sheets     the seed jacket (revision 1) for company A and its season FW27: version 1 approved, then frozen when version
 *              2 took over; version 2 approved (the one in force: a target price and margin, the size weights it used);
 *              version 3 a DRAFT copied from version 2 with dearer leather. Company B: a DRAFT with no season (the first
 *              row). Each made by the member and approved by the owner (nobody approves their own).
 *   lines      per sheet: leather per size (from the BOM's leather line), lining and protectors, cutting and sewing minutes
 *              (from the routing), overhead as 25 % of labour (company A's rule), freight 3 % on the leather per size (the
 *              leather's uplift), packaging typed. The first row: version 3's lining.
 *   leather    the leather article for every style (ft², 85 % yield, A 60 / B 30 / C 10: the first row), the jacket's own
 *              (82.5 %, A 70 / B 30), company A's earlier basis (archived).
 *   overhead   company A: 25 % of labour from January (open-ended: the first row), 0.05 per sewing minute from November;
 *              every company: 2.50 per garment for the first half of 2026, 2.75 from July.
 *   per minute company A's sewing for October 2026 (direct 41,600.00 over 104,000 minutes + 0.06 + 0.04 = 0.50; the first
 *              row) and its cutting table for October; neither applied (applying writes a labour rate, which would change
 *              the costs the live sheet computes).
 *   uplifts    company A's leather: freight 3 %, duty 0, insurance 0.5 % (the first row); every company's trims: freight
 *              5 %; company A's leather kind from landed cost (July to September); the seed workshop P2: transport 0.80 out
 *              and 0.80 back per piece.
 *   weights    the jacket's mix for FW27 (50: 30, 52: 45, 54: 25) and for company B's FW27 (25, 50, 25).
 *   options    the thermal liner adds 18.40 of material and 6 minutes; full perforation adds 12.5 minutes.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (ids with eight
 * zeros) and insert the copy: so the first sheet is a DRAFT copied from no other version, the first line one of a DRAFT,
 * the first overhead rule has no end, the first calculation is not applied. Fixed instants, so nothing depends on the
 * clock. Idempotent: rows are written once
 * (skipDuplicates), and each later step only moves a row still in the step before (a sheet's lines go in while it is a
 * DRAFT, then it is approved, then frozen).
 */

const AT = new Date('2026-11-12T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)
const day = (text: string): Date => new Date(`${text}T00:00:00.000Z`)

/** quantity × unit cost, rounded once, half up, to 6 places (as the guard checks it), from decimal strings. */
function costOf(quantity: string, unitCost: string): string {
  const scaled = (text: string, places: number): bigint => {
    const [whole, fraction = ''] = text.split('.')
    return BigInt(`${whole}${fraction.padEnd(places, '0')}`)
  }
  // quantity has 4 places and unit cost 6: the product has 10; round half up to 6.
  const product = scaled(quantity, 4) * scaled(unitCost, 6)
  const rounded = (product + 5_000n) / 10_000n
  const text = rounded.toString().padStart(7, '0')
  return `${text.slice(0, -6)}.${text.slice(-6)}`
}

export interface CostSheetsSeed {
  readonly sheetIds: { readonly frozenA: string; readonly approvedA: string; readonly draftA: string; readonly draftB: string }
  readonly lineIds: readonly string[]
  readonly basisIds: readonly string[]
  readonly overheadIds: { readonly labourA: string; readonly sewingA: string; readonly unitH1: string; readonly unitH2: string }
  readonly calcIds: readonly string[]
  readonly upliftIds: { readonly leatherA: string; readonly trims: string; readonly landedA: string; readonly workshop: string }
  readonly weightIds: readonly string[]
}

export async function seed(context: SeedContext): Promise<CostSheetsSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const product = await seedProduct(context)
  const intake = await seedSalesIntake(context)
  const options = await seedOptions(context)
  await seedLeather(context)
  await seedCosting(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const office = { audience: 'office' as const, tenantId, actorId: ownerId }
  const madeBy = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: memberId })
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: ownerId })
  const styleId = product.styleId
  const revisionId = product.revisionId
  const seasonA = intake.seasonIds.fw27
  const seasonB = intake.seasonIds.fw27B
  const keyA = `costsheet:${styleId}:${companyA}:${seasonA}`
  const keyB = `costsheet:${styleId}:${companyB}:none`
  const bom = { leather: id('product:bom:JKT-01:1:10'), lining: id('product:bom:JKT-01:1:20'), protector: id('product:bom:JKT-01:1:30') }
  const items = { leather: product.leatherId, lining: id('product:item:lining'), protector: product.protectorId }
  const routing = { cut: id('product:routing:JKT-01:1:SEED-CUT-LEA'), sew: id('product:routing:JKT-01:1:SEED-SEW-ASM') }

  const lineIds: string[] = []
  const weightIds: string[] = []
  const result: CostSheetsSeed = {
    sheetIds: {
      frozenA: id('cost-sheets:sheet:A:FW27:1'),
      approvedA: id('cost-sheets:sheet:A:FW27:2'),
      draftA: id('cost-sheets:sheet:A:FW27:3'),
      draftB: firstId('cost-sheets:sheet:B:none:1'),
    },
    lineIds,
    basisIds: [firstId('cost-sheets:leather:all'), id('cost-sheets:leather:JKT-01'), id('cost-sheets:leather:A:archived')],
    overheadIds: {
      labourA: firstId('cost-sheets:overhead:A:labour'),
      sewingA: id('cost-sheets:overhead:A:sewing'),
      unitH1: id('cost-sheets:overhead:all:unit:2026-01'),
      unitH2: id('cost-sheets:overhead:all:unit:2026-07'),
    },
    calcIds: [firstId('cost-sheets:cpm:A:SEWING:2026-10'), id('cost-sheets:cpm:A:CUT:2026-10')],
    upliftIds: {
      leatherA: firstId('cost-sheets:uplift:A:leather'),
      trims: id('cost-sheets:uplift:all:trims'),
      landedA: id('cost-sheets:uplift:A:leather-kind:landed'),
      workshop: id('cost-sheets:uplift:A:workshop:P2'),
    },
    weightIds,
  }
  const S = result.sheetIds
  const O = result.overheadIds
  const U = result.upliftIds

  // --- the inputs ------------------------------------------------------------------------------------------------------
  const bases: Prisma.LeatherCostBasisCreateManyInput[] = [
    { id: result.basisIds[0]!, companyId: null, itemId: items.leather, styleId: null, key: `leather:${items.leather}:all:all`, areaUnit: Uom.FT2, expectedYieldPct: '85.0000', gradeMix: { A: '60.0000', B: '30.0000', C: '10.0000' }, validFrom: day('2026-01-01'), note: 'Seed: a made-up cutting test.', ...stamp(minutes(0)) },
    { id: result.basisIds[1]!, companyId: null, itemId: items.leather, styleId, key: `leather:${items.leather}:${styleId}:all`, areaUnit: Uom.FT2, expectedYieldPct: '82.5000', gradeMix: { A: '70.0000', B: '30.0000' }, validFrom: day('2026-09-01'), ...stamp(minutes(1)) },
    { id: result.basisIds[2]!, companyId: companyA, itemId: items.leather, styleId: null, key: `leather:${items.leather}:all:${companyA}`, areaUnit: Uom.FT2, expectedYieldPct: '80.0000', gradeMix: { A: '50.0000', B: '50.0000' }, validFrom: day('2026-06-01'), status: MasterStatus.ARCHIVED, note: 'Seed: replaced by the tenant-wide basis.', ...stamp(minutes(2)) },
  ]
  const overheads: Prisma.OverheadRuleCreateManyInput[] = [
    { id: O.labourA, companyId: companyA, key: `overhead:${companyA}:PERCENT_OF_LABOUR:all`, basis: OverheadBasis.PERCENT_OF_LABOUR, value: '25.000000', periodStart: day('2026-01-01'), note: 'Seed: a made-up absorption rate.', ...stamp(minutes(3)) },
    { id: O.sewingA, companyId: companyA, key: `overhead:${companyA}:PER_MINUTE:SEWING`, basis: OverheadBasis.PER_MINUTE, workCentreKind: WorkCentreKind.SEWING, value: '0.050000', currency: 'EUR', periodStart: day('2026-11-01'), ...stamp(minutes(4)) },
    { id: O.unitH1, companyId: null, key: 'overhead:all:PER_UNIT:all', basis: OverheadBasis.PER_UNIT, value: '2.500000', currency: 'EUR', periodStart: day('2026-01-01'), periodEnd: day('2026-06-30'), ...stamp(minutes(5)) },
    { id: O.unitH2, companyId: null, key: 'overhead:all:PER_UNIT:all', basis: OverheadBasis.PER_UNIT, value: '2.750000', currency: 'EUR', periodStart: day('2026-07-01'), ...stamp(minutes(6)) },
  ]
  const siteA = id('site:A1')
  const calcs: Prisma.CostPerMinuteCalcCreateManyInput[] = [
    { id: result.calcIds[0]!, companyId: companyA, workCentreKind: WorkCentreKind.SEWING, key: `cpm:${companyA}:SEWING:all`, periodStart: day('2026-10-01'), periodEnd: day('2026-10-31'), currency: 'EUR', directLabourCost: '41600.000000', availableMinutes: '104000.0000', indirectPerMinute: '0.060000', overheadPerMinute: '0.040000', costPerMinute: '0.500000', minutesBasis: { calendar: 'A1', workingDays: 22, note: 'made-up attendance' }, ...stamp(minutes(7)) },
    { id: result.calcIds[1]!, companyId: companyA, workCentreKind: WorkCentreKind.CUTTING, siteId: siteA, workCentreId: id('site:A1:work-centre:CUT'), key: `cpm:${companyA}:CUTTING:${id('site:A1:work-centre:CUT')}`, periodStart: day('2026-10-01'), periodEnd: day('2026-10-31'), currency: 'EUR', directLabourCost: '9900.000000', availableMinutes: '22000.0000', indirectPerMinute: '0.030000', overheadPerMinute: '0.020000', costPerMinute: '0.500000', ...stamp(minutes(8)) },
  ]
  const uplifts: Prisma.MaterialCostUpliftCreateManyInput[] = [
    { id: U.leatherA, companyId: companyA, target: UpliftTarget.MATERIAL, itemId: items.leather, key: `uplift:${companyA}:item:${items.leather}`, freightPct: '3.0000', dutyPct: '0.0000', insurancePct: '0.5000', validFrom: day('2026-01-01'), note: 'Seed: a made-up forwarder quote.', ...stamp(minutes(9)) },
    { id: U.trims, companyId: null, target: UpliftTarget.CATEGORY, itemKind: ItemKind.TRIM, key: 'uplift:all:kind:TRIM', freightPct: '5.0000', validFrom: day('2026-01-01'), ...stamp(minutes(10)) },
    { id: U.landedA, companyId: companyA, target: UpliftTarget.CATEGORY, itemKind: ItemKind.LEATHER, key: `uplift:${companyA}:kind:LEATHER`, source: UpliftSource.LANDED_COST, freightPct: '2.8000', dutyPct: '0.0000', insurancePct: '0.4000', landedFrom: day('2026-07-01'), landedTo: day('2026-09-30'), validFrom: day('2026-10-01'), ...stamp(minutes(11)) },
    { id: U.workshop, companyId: companyA, target: UpliftTarget.WORKSHOP, partyId: id('party:P2'), key: `uplift:${companyA}:workshop:${id('party:P2')}`, transportOutPerPiece: '0.800000', transportBackPerPiece: '0.800000', currency: 'EUR', validFrom: day('2026-01-01'), ...stamp(minutes(12)) },
  ]
  const mixes: { readonly seasonId: string; readonly tag: string; readonly weights: Readonly<Record<string, string>> }[] = [
    { seasonId: seasonA, tag: 'A:FW27', weights: { '50': '30.0000', '52': '45.0000', '54': '25.0000' } },
    { seasonId: seasonB, tag: 'B:FW27', weights: { '50': '25.0000', '52': '50.0000', '54': '25.0000' } },
  ]
  const weights: Prisma.SizeWeightCreateManyInput[] = mixes.flatMap((mix, m) =>
    Object.entries(mix.weights).map(([size, weight], n) => {
      const key = `cost-sheets:weight:${mix.tag}:${size}`
      return { id: m === 0 && n === 0 ? firstId(key) : id(key), styleId, seasonId: mix.seasonId, key: `sizeweight:${styleId}:${mix.seasonId}:${size}`, size, weight, ...stamp(minutes(13)) }
    }),
  )
  weightIds.push(...weights.map((row) => row.id as string))

  // --- the sheets and their lines ---------------------------------------------------------------------------------------
  const leatherPerSize: Readonly<Record<string, string>> = { '50': '57.0000', '52': '59.5000', '54': '62.5000' }
  /** The lines of a company A sheet at a leather price per ft². */
  const linesOf = (sheetId: string, tag: string, leatherPrice: string): Prisma.CostSheetLineCreateManyInput[] => {
    const line = (seq: number, row: Omit<Prisma.CostSheetLineCreateManyInput, 'id' | 'costSheetId' | 'seq' | 'cost'>): Prisma.CostSheetLineCreateManyInput => {
      const key = `cost-sheets:line:${tag}:${seq}`
      return { id: tag === 'A:FW27:3' && seq === 20 ? firstId(key) : id(key), costSheetId: sheetId, seq, ...row, cost: costOf(String(row.quantity), String(row.unitCost)), ...madeBy(minutes(20)) }
    }
    const leather = Object.entries(leatherPerSize).map(([size, quantity], n) =>
      line(10 + n, { category: CostCategory.LEATHER, source: CostLineSource.BOM_LINE, sourceRecordType: 'BomLine', sourceRecordId: bom.leather, itemId: items.leather, label: 'SEED-LEA-100 Seed cowhide 1.2 mm', size, quantity, uom: Uom.FT2, unitCost: leatherPrice }),
    )
    const freight = Object.entries(leatherPerSize).map(([size, quantity], n) => {
      const unitCost = costOf(costOf(quantity, leatherPrice).replace(/(\.\d{4})\d+$/, '$1'), '0.030000')
      return line(70 + n, { category: CostCategory.FREIGHT, source: CostLineSource.UPLIFT, sourceRecordType: 'MaterialCostUplift', sourceRecordId: U.leatherA, itemId: items.leather, size, quantity: '1.0000', pct: '3.0000', unitCost })
    })
    return [
      ...leather,
      line(20, { category: CostCategory.MATERIAL, source: CostLineSource.BOM_LINE, sourceRecordType: 'BomLine', sourceRecordId: bom.lining, itemId: items.lining, label: 'Lining', quantity: '1.6000', uom: Uom.M, unitCost: '6.500000' }),
      line(30, { category: CostCategory.MATERIAL, source: CostLineSource.BOM_LINE, sourceRecordType: 'BomLine', sourceRecordId: bom.protector, itemId: items.protector, label: 'Protectors', quantity: '5.0000', uom: Uom.PCS, unitCost: '7.800000' }),
      line(40, { category: CostCategory.LABOUR, source: CostLineSource.ROUTING, sourceRecordType: 'RoutingOperation', sourceRecordId: routing.cut, workCentreKind: WorkCentreKind.CUTTING, label: 'Cut leather panels', quantity: '14.0000', unitCost: '0.500000' }),
      line(50, { category: CostCategory.LABOUR, source: CostLineSource.ROUTING, sourceRecordType: 'RoutingOperation', sourceRecordId: routing.sew, workCentreKind: WorkCentreKind.SEWING, label: 'Sew and assemble the body', quantity: '96.5000', unitCost: '0.500000' }),
      line(60, { category: CostCategory.OVERHEAD, source: CostLineSource.OVERHEAD_RULE, sourceRecordType: 'OverheadRule', sourceRecordId: O.labourA, quantity: '1.0000', pct: '25.0000', unitCost: '13.812500' }),
      ...freight,
      line(80, { category: CostCategory.PACKAGING, source: CostLineSource.TYPED, label: 'Polybag, hanger and a share of the carton', quantity: '1.0000', unitCost: '1.350000' }),
    ]
  }
  const sheetA = (sheetId: string, version: number, basedOnId: string | null, at: Date, extra: Partial<Prisma.CostSheetCreateManyInput> = {}): Prisma.CostSheetCreateManyInput => ({
    id: sheetId,
    companyId: companyA,
    styleId,
    revisionId,
    seasonId: seasonA,
    key: keyA,
    sheetVersion: version,
    basedOnId,
    currency: 'EUR',
    baseSize: '52',
    sizeWeights: mixes[0]!.weights,
    inputs: { leather: { basis: result.basisIds[1], pricePerFt2: version === 1 ? '4.000000' : version === 2 ? '4.200000' : '4.400000' }, overheadRule: O.labourA, uplift: U.leatherA },
    ...extra,
    ...madeBy(at),
  })
  const sheets: Prisma.CostSheetCreateManyInput[] = [
    sheetA(S.frozenA, 1, null, minutes(30), { note: 'Seed: the first costing of the season.' }),
    sheetA(S.approvedA, 2, S.frozenA, minutes(60), { targetPrice: '520.000000', targetMarginPct: '45.0000', note: 'Seed: the leather price of the new tannery contract.' }),
    sheetA(S.draftA, 3, S.approvedA, minutes(120), { note: 'Seed: what if the leather costs 4.40?' }),
    { id: S.draftB, companyId: companyB, styleId, revisionId, seasonId: null, key: keyB, sheetVersion: 1, basedOnId: null, currency: 'EUR', baseSize: '52', ...madeBy(minutes(90)) },
  ]
  const lines: Prisma.CostSheetLineCreateManyInput[] = [
    ...linesOf(S.frozenA, 'A:FW27:1', '4.000000'),
    ...linesOf(S.approvedA, 'A:FW27:2', '4.200000'),
    ...linesOf(S.draftA, 'A:FW27:3', '4.400000'),
    { id: id('cost-sheets:line:B:1:10'), costSheetId: S.draftB, seq: 10, category: CostCategory.LEATHER, source: CostLineSource.BOM_LINE, sourceRecordType: 'BomLine', sourceRecordId: bom.leather, itemId: items.leather, quantity: '59.5000', uom: Uom.FT2, unitCost: '4.300000', cost: costOf('59.5000', '4.300000'), ...madeBy(minutes(91)) },
    { id: id('cost-sheets:line:B:1:20'), costSheetId: S.draftB, seq: 20, category: CostCategory.LABOUR, source: CostLineSource.TYPED, workCentreKind: WorkCentreKind.SEWING, quantity: '96.5000', unitCost: '0.520000', cost: costOf('96.5000', '0.520000'), note: 'Seed: typed while company B has no rate of its own.', ...madeBy(minutes(91)) },
  ]
  lineIds.push(...lines.map((row) => row.id as string))

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.leatherCostBasis.createMany({ data: bases, skipDuplicates: true })
      await tx.overheadRule.createMany({ data: overheads, skipDuplicates: true })
      await tx.costPerMinuteCalc.createMany({ data: calcs, skipDuplicates: true })
      await tx.materialCostUplift.createMany({ data: uplifts, skipDuplicates: true })
      await tx.sizeWeight.createMany({ data: weights, skipDuplicates: true })
      // The sheets as DRAFTs with their lines (a line goes in only while its sheet is a draft) …
      await tx.costSheet.createMany({ data: sheets, skipDuplicates: true })
      const drafts = new Set((await tx.costSheet.findMany({ where: { id: { in: sheets.map((row) => row.id) }, state: CostSheetState.DRAFT }, select: { id: true } })).map((row) => row.id))
      await tx.costSheetLine.createMany({ data: lines.filter((row) => drafts.has(row.costSheetId)), skipDuplicates: true })
      // … then version 1 approved and frozen when version 2 takes over, and version 2 approved (by the owner: the member made them).
      await tx.costSheet.updateMany({ where: { id: S.frozenA, state: CostSheetState.DRAFT }, data: { state: CostSheetState.APPROVED, approvedAt: minutes(45), approvedById: ownerId } })
      await tx.costSheet.updateMany({
        where: { id: S.frozenA, state: CostSheetState.APPROVED },
        data: { state: CostSheetState.FROZEN, frozenAt: minutes(75), frozenById: ownerId, frozenReason: CostSheetFreezeReason.SUPERSEDED },
      })
      await tx.costSheet.updateMany({ where: { id: S.approvedA, state: CostSheetState.DRAFT }, data: { state: CostSheetState.APPROVED, approvedAt: minutes(75), approvedById: ownerId } })
      // The option cost deltas (FIN-018), once.
      await tx.optionValue.updateMany({ where: { id: options.valueIds.linerYes, materialDelta: null }, data: { materialDelta: '18.400000', materialDeltaCurrency: 'EUR', minutesDelta: '6.000' } })
      await tx.optionValue.updateMany({ where: { id: options.valueIds.perfFull, minutesDelta: null }, data: { minutesDelta: '12.500' } })
    }),
  )
  return result
}
