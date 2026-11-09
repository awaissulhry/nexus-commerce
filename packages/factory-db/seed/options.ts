import type { Prisma } from '../src/generated/prisma/client'
import {
  BomAlternateUse,
  BomSection,
  ItemKind,
  ItemSourcing,
  ItemTracking,
  MasterStatus,
  OptionEffectKind,
  OptionGroupKind,
  OptionRuleKind,
  OptionRuleSeverity,
  PpeCategory,
  ProductType,
  StyleRevisionStatus,
  StyleStatus,
  Uom,
  WorkCentreKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduct } from './product'

/**
 * The BOM depth and option library seed (W2b-4, schema wave 28/33, B-W2b-211), per tenant of seed/_core.ts, written in the
 * tenant's office scope, as the app does. The CLI runs the seed files in name order and this one sorts before product.ts,
 * which it runs first anyway (idempotent; it runs parties). Every name, code and figure is made up.
 *
 *   materials    an airflow mesh lining and a second shoulder protector (the alternates), the removable thermal liner we
 *                make (a COMPONENT), thermal wadding, a contrast thread and the brand's woven label; the library operation
 *                SEED-PERF (perforate leather panels).
 *   sub-assembly SEED-LNR-01, a removable thermal liner (colourway GRY): revision 1 (the grey lining and wadding, 1 PCS;
 *                one sewing step) RELEASED.
 *   options      tenant-wide groups SEED-OG-LINER (SINGLE: YES), SEED-OG-PERF (SINGLE: FRONT, FULL), SEED-OG-NAME (FREE_TEXT:
 *                NAME, 12 letters at most) and SEED-OG-ARMOUR (SINGLE, one required: STD, NONE). Rules: full perforation
 *                excludes the liner (block); the liner requires the standard armour (warn). Effects: the liner +60.00 EUR;
 *                front perforation +5 % and 6 more cutting minutes; full perforation the airflow lining in place of the
 *                mesh, the perforation operation and +40.00 EUR; the name 5 m of contrast thread (4.5 m in 50, 5.5 m in 54),
 *                4 more sewing minutes and +15.00 EUR; no armour leaves out the shoulder protectors, takes the jacket
 *                outside its certificate and -25.00 EUR.
 *   style        SEED-JKT-05, a configurable touring jacket for the brand P1 (colourway BLK), offering the four groups (armour: one, the
 *                standard by default); revision 1 DRAFT: the leather shell with its contrast thread grouped under it (in
 *                the workshop's kit), the mesh lining (the airflow lining when short), the shoulder protectors (the second
 *                protector with a person's approval and a certificate check), the liner sub-assembly only with the liner
 *                option, the brand's label sent by P1 (made by the branding rule "brand-label"); a routing of cutting,
 *                perforation (front perforation only) and sewing. SEED-JKT-01's archived offer of the name group.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the liner group, its value, the first rule, the certificate effect, the archived offer (one ACTIVE offer per
 * style and group) and the lining's alternate (on a DRAFT revision) get ids that start with eight zeros; the released
 * revision, its lines and SEED-JKT-05's lines and steps get eight f's (a copy of a released revision's row is refused).
 * Idempotent: written once, skipped when the liner group exists.
 */

/** Fixed instants, so the seed never depends on the clock. */
const T = {
  library: new Date('2026-11-22T08:00:00.000Z'),
  released: new Date('2026-11-22T09:00:00.000Z'),
  style: new Date('2026-11-22T10:00:00.000Z'),
}

export interface OptionsSeed {
  readonly linerStyleId: string
  readonly linerRevisionId: string
  readonly jacketStyleId: string
  readonly jacketRevisionId: string
  readonly itemIds: {
    readonly airflowLining: string
    readonly protector2: string
    readonly linerComponent: string
    readonly wadding: string
    readonly thread: string
    readonly label: string
  }
  readonly operationId: string
  readonly groupIds: { readonly liner: string; readonly perforation: string; readonly name: string; readonly armour: string }
  readonly valueIds: {
    readonly linerYes: string
    readonly perfFront: string
    readonly perfFull: string
    readonly name: string
    readonly armourStd: string
    readonly armourNone: string
  }
  readonly bomLineIds: { readonly shell: string; readonly thread: string; readonly lining: string; readonly protector: string; readonly liner: string; readonly label: string }
  readonly alternateIds: { readonly lining: string; readonly protector: string }
  readonly offerIds: { readonly archived: string; readonly liner: string; readonly perforation: string; readonly name: string; readonly armour: string }
}

export async function seed(context: SeedContext): Promise<OptionsSeed> {
  const { db, namespace } = context
  await seedProduct(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const brandId = id('party:P1')
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const words = (it: string, en: string) => ({ it, en })

  const result: OptionsSeed = {
    linerStyleId: id('options:style:LNR-01'),
    linerRevisionId: lastId('options:revision:LNR-01:1'),
    jacketStyleId: id('options:style:JKT-05'),
    jacketRevisionId: id('options:revision:JKT-05:1'),
    itemIds: {
      airflowLining: id('options:item:LIN-210'),
      protector2: id('options:item:PRO-310'),
      linerComponent: id('options:item:CMP-500'),
      wadding: id('options:item:TXT-520'),
      thread: id('options:item:THR-530'),
      label: id('options:item:LBL-540'),
    },
    operationId: id('options:operation:PERF'),
    groupIds: { liner: firstId('options:group:LINER'), perforation: id('options:group:PERF'), name: id('options:group:NAME'), armour: id('options:group:ARMOUR') },
    valueIds: {
      linerYes: firstId('options:value:LINER:YES'),
      perfFront: id('options:value:PERF:FRONT'),
      perfFull: id('options:value:PERF:FULL'),
      name: id('options:value:NAME:NAME'),
      armourStd: id('options:value:ARMOUR:STD'),
      armourNone: id('options:value:ARMOUR:NONE'),
    },
    bomLineIds: {
      shell: lastId('options:bom:JKT-05:1:10'),
      thread: lastId('options:bom:JKT-05:1:15'),
      lining: lastId('options:bom:JKT-05:1:20'),
      protector: lastId('options:bom:JKT-05:1:30'),
      liner: lastId('options:bom:JKT-05:1:40'),
      label: lastId('options:bom:JKT-05:1:50'),
    },
    alternateIds: { lining: firstId('options:alternate:JKT-05:1:20:1'), protector: id('options:alternate:JKT-05:1:30:1') },
    offerIds: {
      archived: firstId('options:offer:JKT-01:NAME'),
      liner: id('options:offer:JKT-05:LINER'),
      perforation: id('options:offer:JKT-05:PERF'),
      name: id('options:offer:JKT-05:NAME'),
      armour: id('options:offer:JKT-05:ARMOUR'),
    },
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.optionGroup.findUnique({ where: { id: result.groupIds.liner }, select: { id: true } })) return

      // What the product seed made, by code.
      const items = await tx.item.findMany({ where: { code: { in: ['SEED-LEA-100', 'SEED-LIN-200', 'SEED-PRO-300'] } }, select: { id: true, code: true } })
      const itemId = (code: string): string => items.find((row) => row.code === code)!.id
      const operations = await tx.operation.findMany({ where: { code: { in: ['SEED-CUT-LEA', 'SEED-SEW-ASM'] } }, select: { id: true, code: true, name: true, workCentreKind: true, standardMinutes: true } })
      const operation = (code: string) => operations.find((row) => row.code === code)!
      const scale = await tx.sizeScale.findFirstOrThrow({ where: { code: 'SEED-EU-JKT' }, select: { id: true } })
      const jkt01 = await tx.style.findFirstOrThrow({ where: { code: 'SEED-JKT-01' }, select: { id: true } })
      const colour = { BLK: id('product:colour:BLK'), GRY: id('product:colour:GRY') }
      const itemColour = { leatherBLK: id('product:item-colour:leather:BLK'), liningGRY: id('product:item-colour:lining:GRY') }
      const sew = operation('SEED-SEW-ASM')

      // --- Materials and the perforation operation -------------------------------------------------------------------
      const { itemIds } = result
      const newItems: (Prisma.ItemCreateManyInput & { id: string })[] = [
        { id: itemIds.airflowLining, code: 'SEED-LIN-210', name: 'Seed airflow mesh lining', kind: ItemKind.LINING, sourcing: ItemSourcing.BUY, tracking: ItemTracking.LOT, baseUom: Uom.M, purchaseUom: Uom.ROLL, purchaseFactor: '50.00000000', consumptionUom: Uom.M, composition: [{ fibre: 'polyester', percent: '100' }], ...stamp(T.library) },
        { id: itemIds.protector2, code: 'SEED-PRO-310', name: 'Seed shoulder protector level 2 (second source)', kind: ItemKind.PROTECTOR, sourcing: ItemSourcing.BUY, tracking: ItemTracking.LOT, baseUom: Uom.PCS, purchaseUom: Uom.PCS, consumptionUom: Uom.PCS, isPpeComponent: true, ...stamp(T.library) },
        { id: itemIds.linerComponent, code: 'SEED-CMP-500', name: 'Seed removable thermal liner (made here)', kind: ItemKind.COMPONENT, sourcing: ItemSourcing.MAKE, tracking: ItemTracking.NONE, baseUom: Uom.PCS, purchaseUom: Uom.PCS, consumptionUom: Uom.PCS, ...stamp(T.library) },
        { id: itemIds.wadding, code: 'SEED-TXT-520', name: 'Seed thermal wadding 100 g', kind: ItemKind.PADDING, sourcing: ItemSourcing.BUY, tracking: ItemTracking.LOT, baseUom: Uom.M2, purchaseUom: Uom.ROLL, purchaseFactor: '30.00000000', consumptionUom: Uom.M2, ...stamp(T.library) },
        { id: itemIds.thread, code: 'SEED-THR-530', name: 'Seed contrast thread 40', kind: ItemKind.THREAD, sourcing: ItemSourcing.BUY, tracking: ItemTracking.LOT, baseUom: Uom.M, purchaseUom: Uom.CONE, purchaseFactor: '5000.00000000', consumptionUom: Uom.M, ...stamp(T.library) },
        { id: itemIds.label, code: 'SEED-LBL-540', name: 'Seed brand woven label (sent by the brand)', kind: ItemKind.LABEL, sourcing: ItemSourcing.BUY, tracking: ItemTracking.NONE, baseUom: Uom.PCS, purchaseUom: Uom.PCS, consumptionUom: Uom.PCS, ...stamp(T.library) },
      ]
      await tx.item.createMany({ data: newItems })
      await tx.operation.create({
        data: { id: result.operationId, code: 'SEED-PERF', name: 'Perforate leather panels', nameI18n: words('Foratura pannelli in pelle', 'Perforate leather panels'), workCentreKind: WorkCentreKind.CUTTING, machineType: 'perforating press', skill: 'cutter', standardMinutes: '6.000', ...stamp(T.library) },
        select: { id: true },
      })

      // --- SEED-LNR-01: the removable thermal liner, a sub-assembly made here, revision 1 released ------------------------
      await tx.style.create({
        data: { id: result.linerStyleId, code: 'SEED-LNR-01', name: 'Seed removable thermal liner', nameI18n: words('Imbottitura termica removibile seed', 'Seed removable thermal liner'), productType: ProductType.OTHER, season: 'FW27', sizeScaleId: scale.id, sizes: ['50', '52', '54'], baseSize: '52', ppeCategory: PpeCategory.NOT_PPE, status: StyleStatus.ACTIVE, ...stamp(T.library) },
        select: { id: true },
      })
      await tx.colourway.create({ data: { id: id('options:colourway:LNR-01:GRY'), styleId: result.linerStyleId, code: 'GRY', name: 'Grey', colourId: colour.GRY, ...stamp(T.library) }, select: { id: true } })
      await tx.styleRevision.create({ data: { id: result.linerRevisionId, styleId: result.linerStyleId, revision: 1, status: StyleRevisionStatus.DRAFT, changeNote: 'First revision.', ...stamp(T.library) }, select: { id: true } })
      await tx.bomLine.createMany({
        data: [
          { id: lastId('options:bom:LNR-01:1:10'), styleId: result.linerStyleId, revisionId: result.linerRevisionId, seq: 10, itemId: itemId('SEED-LIN-200'), placement: 'Liner body', qty: '1.2000', uom: Uom.M, wastagePct: '5.0000', itemColourId: itemColour.liningGRY, section: BomSection.LINING, ...stamp(T.library) },
          { id: lastId('options:bom:LNR-01:1:20'), styleId: result.linerStyleId, revisionId: result.linerRevisionId, seq: 20, itemId: itemIds.wadding, placement: 'Between the layers', qty: '0.8000', uom: Uom.M2, wastagePct: '8.0000', section: BomSection.INSULATION, ...stamp(T.library) },
        ],
      })
      await tx.routingOperation.create({
        data: { id: lastId('options:routing:LNR-01:1:SEED-SEW-ASM'), styleId: result.linerStyleId, revisionId: result.linerRevisionId, seq: 10, operationId: sew.id, code: sew.code, name: 'Sew the liner', workCentreKind: sew.workCentreKind, standardMinutes: '18.000', ...stamp(T.library) },
        select: { id: true },
      })
      await tx.styleRevision.update({ where: { id: result.linerRevisionId }, data: { status: StyleRevisionStatus.RELEASED, releasedAt: T.released, releasedById: actorId, updatedAt: T.released }, select: { id: true } })

      // --- The option library ----------------------------------------------------------------------------------------------
      const { groupIds, valueIds } = result
      await tx.optionGroup.createMany({
        data: [
          { id: groupIds.liner, code: 'SEED-OG-LINER', name: 'Thermal liner', nameI18n: words('Imbottitura termica', 'Thermal liner'), description: 'A removable thermal liner zipped into the jacket.', kind: OptionGroupKind.SINGLE, minPicks: 0, maxPicks: 1, ...stamp(T.library) },
          { id: groupIds.perforation, code: 'SEED-OG-PERF', name: 'Perforation', nameI18n: words('Foratura', 'Perforation'), kind: OptionGroupKind.SINGLE, minPicks: 0, maxPicks: 1, ...stamp(T.library) },
          { id: groupIds.name, code: 'SEED-OG-NAME', name: 'Name embroidery', nameI18n: words('Ricamo del nome', 'Name embroidery'), kind: OptionGroupKind.FREE_TEXT, minPicks: 0, maxPicks: 1, ...stamp(T.library) },
          { id: groupIds.armour, code: 'SEED-OG-ARMOUR', name: 'Shoulder armour', nameI18n: words('Protezioni spalle', 'Shoulder armour'), kind: OptionGroupKind.SINGLE, minPicks: 1, maxPicks: 1, ...stamp(T.library) },
        ],
      })
      await tx.optionValue.createMany({
        data: [
          { id: valueIds.linerYes, groupId: groupIds.liner, code: 'YES', name: 'Removable thermal liner', nameI18n: words('Imbottitura termica removibile', 'Removable thermal liner'), seq: 1, ...stamp(T.library) },
          { id: valueIds.perfFront, groupId: groupIds.perforation, code: 'FRONT', name: 'Front panels perforated', nameI18n: words('Pannelli anteriori forati', 'Front panels perforated'), seq: 1, ...stamp(T.library) },
          { id: valueIds.perfFull, groupId: groupIds.perforation, code: 'FULL', name: 'Full perforation', nameI18n: words('Foratura totale', 'Full perforation'), seq: 2, ...stamp(T.library) },
          { id: valueIds.name, groupId: groupIds.name, code: 'NAME', name: 'Name on the chest', nameI18n: words('Nome sul petto', 'Name on the chest'), seq: 1, freeText: true, freeTextMaxLength: 12, freeTextPattern: "^[A-Za-z .'-]+$", ...stamp(T.library) },
          { id: valueIds.armourStd, groupId: groupIds.armour, code: 'STD', name: 'Standard shoulder protectors', nameI18n: words('Protezioni standard', 'Standard shoulder protectors'), seq: 1, ...stamp(T.library) },
          { id: valueIds.armourNone, groupId: groupIds.armour, code: 'NONE', name: 'Without shoulder protectors', nameI18n: words('Senza protezioni spalle', 'Without shoulder protectors'), seq: 2, ...stamp(T.library) },
        ],
      })
      await tx.optionRule.createMany({
        data: [
          {
            id: firstId('options:rule:PERF-FULL-x-LINER'),
            groupId: groupIds.perforation,
            valueId: valueIds.perfFull,
            kind: OptionRuleKind.EXCLUDES,
            otherValueId: valueIds.linerYes,
            severity: OptionRuleSeverity.BLOCK,
            messageI18n: words("La foratura totale esclude l'imbottitura termica", 'Full perforation excludes the thermal liner'),
            ...stamp(T.library),
          },
          {
            id: id('options:rule:LINER-needs-STD'),
            groupId: groupIds.liner,
            valueId: valueIds.linerYes,
            kind: OptionRuleKind.REQUIRES,
            otherValueId: valueIds.armourStd,
            severity: OptionRuleSeverity.WARN,
            messageI18n: words("L'imbottitura è tagliata per le protezioni standard", 'The liner is cut for the standard shoulder protectors'),
            ...stamp(T.library),
          },
        ],
      })
      const cut = operation('SEED-CUT-LEA')
      const effects: (Prisma.OptionEffectCreateManyInput & { id: string })[] = [
        { id: firstId('options:effect:ARMOUR:NONE:certificate'), valueId: valueIds.armourNone, kind: OptionEffectKind.CERTIFICATE, note: 'Without its shoulder protectors the jacket is not the certified class AA garment.', ...stamp(T.library) },
        { id: id('options:effect:ARMOUR:NONE:remove'), valueId: valueIds.armourNone, kind: OptionEffectKind.BOM_REMOVE, targetItemId: itemId('SEED-PRO-300'), ...stamp(T.library) },
        { id: id('options:effect:ARMOUR:NONE:price'), valueId: valueIds.armourNone, kind: OptionEffectKind.PRICE, priceDelta: '-25.000000', currency: 'EUR', ...stamp(T.library) },
        { id: id('options:effect:LINER:YES:price'), valueId: valueIds.linerYes, kind: OptionEffectKind.PRICE, priceDelta: '60.000000', currency: 'EUR', ...stamp(T.library) },
        { id: id('options:effect:PERF:FRONT:price'), valueId: valueIds.perfFront, kind: OptionEffectKind.PRICE, pricePct: '5.0000', ...stamp(T.library) },
        { id: id('options:effect:PERF:FRONT:minutes'), valueId: valueIds.perfFront, kind: OptionEffectKind.MINUTES, operationId: cut.id, minutes: '6.000', ...stamp(T.library) },
        { id: id('options:effect:PERF:FULL:replace'), valueId: valueIds.perfFull, kind: OptionEffectKind.BOM_REPLACE, targetItemId: itemId('SEED-LIN-200'), itemId: itemIds.airflowLining, ...stamp(T.library) },
        { id: id('options:effect:PERF:FULL:operation'), valueId: valueIds.perfFull, kind: OptionEffectKind.OPERATION_ADD, operationId: result.operationId, ...stamp(T.library) },
        { id: id('options:effect:PERF:FULL:price'), valueId: valueIds.perfFull, kind: OptionEffectKind.PRICE, priceDelta: '40.000000', currency: 'EUR', ...stamp(T.library) },
        { id: id('options:effect:NAME:thread'), valueId: valueIds.name, kind: OptionEffectKind.BOM_ADD, itemId: itemIds.thread, qty: '5.0000', uom: Uom.M, sizeQuantities: { '50': '4.5000', '54': '5.5000' }, section: BomSection.THREAD, ...stamp(T.library) },
        { id: id('options:effect:NAME:minutes'), valueId: valueIds.name, kind: OptionEffectKind.MINUTES, operationId: sew.id, minutes: '4.000', ...stamp(T.library) },
        { id: id('options:effect:NAME:price'), valueId: valueIds.name, kind: OptionEffectKind.PRICE, priceDelta: '15.000000', currency: 'EUR', ...stamp(T.library) },
      ]
      await tx.optionEffect.createMany({ data: effects })

      // --- SEED-JKT-05: a configurable touring jacket, its offers and its draft revision -------------------------------------
      await tx.style.create({
        data: {
          id: result.jacketStyleId,
          code: 'SEED-JKT-05',
          name: 'Seed configurable touring jacket',
          nameI18n: words('Giacca touring configurabile seed', 'Seed configurable touring jacket'),
          productType: ProductType.JACKET,
          season: 'FW27',
          brandPartyId: brandId,
          sizeScaleId: scale.id,
          sizes: ['50', '52', '54'],
          baseSize: '52',
          ppeCategory: PpeCategory.CATEGORY_II,
          ppeStandard: 'EN 17092-3:2020',
          ppeClass: 'AA',
          status: StyleStatus.DRAFT,
          ...stamp(T.style),
        },
        select: { id: true },
      })
      const { offerIds } = result
      await tx.styleOptionGroup.createMany({
        data: [
          { id: offerIds.archived, styleId: jkt01.id, groupId: groupIds.name, seq: 1, status: MasterStatus.ARCHIVED, ...stamp(T.style) },
          { id: offerIds.liner, styleId: result.jacketStyleId, groupId: groupIds.liner, seq: 1, ...stamp(T.style) },
          { id: offerIds.perforation, styleId: result.jacketStyleId, groupId: groupIds.perforation, seq: 2, ...stamp(T.style) },
          { id: offerIds.name, styleId: result.jacketStyleId, groupId: groupIds.name, seq: 3, ...stamp(T.style) },
          { id: offerIds.armour, styleId: result.jacketStyleId, groupId: groupIds.armour, seq: 4, minPicks: 1, maxPicks: 1, defaultValueId: valueIds.armourStd, ...stamp(T.style) },
        ],
      })
      const revisionId = result.jacketRevisionId
      const styleId = result.jacketStyleId
      await tx.colourway.create({ data: { id: id('options:colourway:JKT-05:BLK'), styleId, code: 'BLK', name: 'Black', colourId: colour.BLK, description: 'Black leather, grey lining.', ...stamp(T.style) }, select: { id: true } })
      await tx.styleRevision.create({ data: { id: revisionId, styleId, revision: 1, status: StyleRevisionStatus.DRAFT, changeNote: 'First revision.', plannedHideYieldPct: '75.0000', ...stamp(T.style) }, select: { id: true } })
      const { bomLineIds } = result
      const line = (data: Omit<Prisma.BomLineCreateManyInput, 'styleId' | 'revisionId' | 'createdAt' | 'updatedAt' | 'createdById'>): Prisma.BomLineCreateManyInput => ({ styleId, revisionId, ...data, ...stamp(T.style) })
      // Each line on its own: a grouped line names a line already written.
      for (const data of [
        line({ id: bomLineIds.shell, seq: 10, itemId: itemId('SEED-LEA-100'), placement: 'Outer shell', qty: '46.0000', uom: Uom.FT2, wastagePct: '12.0000', itemColourId: itemColour.leatherBLK, section: BomSection.SHELL }),
        line({ id: bomLineIds.thread, seq: 15, itemId: itemIds.thread, placement: 'Shell seams', qty: '180.0000', uom: Uom.M, section: BomSection.THREAD, parentLineId: bomLineIds.shell, issueToSubcontract: true }),
        line({ id: bomLineIds.lining, seq: 20, itemId: itemId('SEED-LIN-200'), placement: 'Body lining', qty: '1.8000', uom: Uom.M, wastagePct: '5.0000', itemColourId: itemColour.liningGRY, section: BomSection.LINING }),
        line({ id: bomLineIds.protector, seq: 30, itemId: itemId('SEED-PRO-300'), placement: 'Shoulder pockets', qty: '2.0000', uom: Uom.PCS, section: BomSection.PROTECTION }),
        line({ id: bomLineIds.liner, seq: 40, itemId: itemIds.linerComponent, placement: 'Zipped in', qty: '1.0000', uom: Uom.PCS, section: BomSection.INSULATION, subAssemblyStyleId: result.linerStyleId, subAssemblyRevisionId: result.linerRevisionId, optionValueId: valueIds.linerYes }),
        line({ id: bomLineIds.label, seq: 50, itemId: itemIds.label, placement: 'Inside the collar', qty: '1.0000', uom: Uom.PCS, section: BomSection.LABELS, customerSuppliedByPartyId: brandId, sourceKey: 'branding:brand-label' }),
      ]) {
        await tx.bomLine.create({ data, select: { id: true } })
      }
      await tx.bomLineAlternate.createMany({
        data: [
          { id: result.alternateIds.lining, revisionId, bomLineId: bomLineIds.lining, priority: 1, itemId: itemIds.airflowLining, allowedWhen: BomAlternateUse.WHEN_SHORT, note: 'Same width; slightly cooler.', ...stamp(T.style) },
          { id: result.alternateIds.protector, revisionId, bomLineId: bomLineIds.protector, priority: 1, itemId: itemIds.protector2, allowedWhen: BomAlternateUse.WITH_APPROVAL, certificateCheck: true, note: 'Second source of the same level 2 protector; the notified body is asked first.', ...stamp(T.style) },
        ],
      })
      const step = (seq: number, op: { id: string; code: string; name: string; workCentreKind: WorkCentreKind; standardMinutes: { toString(): string } }, appliesToOptionValueIds: string[] = []): Prisma.RoutingOperationCreateManyInput => ({
        id: lastId(`options:routing:JKT-05:1:${op.code}`),
        styleId,
        revisionId,
        seq,
        operationId: op.id,
        code: op.code,
        name: op.name,
        workCentreKind: op.workCentreKind,
        standardMinutes: op.standardMinutes.toString(),
        appliesToOptionValueIds,
        ...stamp(T.style),
      })
      await tx.routingOperation.createMany({
        data: [
          step(10, cut),
          step(20, { id: result.operationId, code: 'SEED-PERF', name: 'Perforate leather panels', workCentreKind: WorkCentreKind.CUTTING, standardMinutes: '6.000' }, [valueIds.perfFront]),
          step(30, sew),
        ],
      })
    }),
  )
  return result
}
